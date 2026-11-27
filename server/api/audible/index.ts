import ExternalAPI from '@server/api/externalapi';
import { getRepository } from '@server/datasource';
import MetadataBookAudio from '@server/entity/MetadataBookAudio';
import cacheManager from '@server/lib/cache';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import type { AudibleProduct, AudibleProductsResponse } from './interfaces';
import { findAudiobookMatch } from './match';

// Catalog searches and the answer per book are kept for a week
const CACHE_TTL = 86400 * 7;
// Failed lookups are not saved, but are not retried right away either
const UNKNOWN_TTL = 600;
const MAX_RPS = 5;
const NUM_RESULTS = 10;
// Narrator listings are asked a page of the most the catalog gives at a
// time, and kept a day as new recordings come out
const NARRATOR_PAGE_SIZE = 50;
const NARRATOR_CACHE_TTL = 86400;
// Saved answers are asked again after this long. Books without an
// audiobook are checked more often, as editions keep being recorded.
const FOUND_STALE_AFTER = 90 * 24 * 60 * 60 * 1000;
const MISSING_STALE_AFTER = 14 * 24 * 60 * 60 * 1000;

// Audible marketplace by ISO 3166 country code, the US store is the default
const MARKETPLACES: Record<string, { region: string; host: string }> = {
  US: { region: 'us', host: 'api.audible.com' },
  GB: { region: 'uk', host: 'api.audible.co.uk' },
  DE: { region: 'de', host: 'api.audible.de' },
  CA: { region: 'ca', host: 'api.audible.ca' },
  AU: { region: 'au', host: 'api.audible.com.au' },
  FR: { region: 'fr', host: 'api.audible.fr' },
  IT: { region: 'it', host: 'api.audible.it' },
  IN: { region: 'in', host: 'api.audible.in' },
  JP: { region: 'jp', host: 'api.audible.co.jp' },
  ES: { region: 'es', host: 'api.audible.es' },
};

// Size of the cover asked for, in pixels
const COVER_SIZE = '500';

export interface AudiobookAvailability {
  // null when Audible could not be asked
  exists: boolean | null;
  asin?: string;
  narrators?: string[];
  runtimeMinutes?: number;
  coverUrl?: string;
}

/**
 * The facts kept about a matched audiobook edition
 */
export const mapAudiobookEdition = (
  product: AudibleProduct
): Omit<AudiobookAvailability, 'exists'> => ({
  asin: product.asin,
  narrators: [
    ...new Set(
      (product.narrators ?? [])
        .map((narrator) => narrator.name?.trim())
        .filter((name): name is string => !!name)
    ),
  ],
  runtimeMinutes:
    product.runtime_length_min && product.runtime_length_min > 0
      ? Math.round(product.runtime_length_min)
      : undefined,
  coverUrl: product.product_images?.[COVER_SIZE] || undefined,
});

/**
 * A saved answer as returned to the client, without empty fields
 */
export const mapSavedAudiobook = (
  row: MetadataBookAudio
): AudiobookAvailability =>
  row.hasAudiobook
    ? {
        exists: true,
        asin: row.asin ?? undefined,
        narrators: row.narrators ?? undefined,
        runtimeMinutes: row.runtimeMinutes ?? undefined,
        coverUrl: row.coverUrl ?? undefined,
      }
    : { exists: false };

export const getAudibleMarketplace = (countryCode?: string) =>
  MARKETPLACES[(countryCode ?? '').toUpperCase()] ?? MARKETPLACES.US;

const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : 'Unknown error';

// Editions found before narrators were saved are looked up once more
const isStale = (row: MetadataBookAudio, region: string): boolean =>
  row.region !== region ||
  (row.hasAudiobook && !row.narrators) ||
  Date.now() - new Date(row.checkedAt).getTime() >
    (row.hasAudiobook ? FOUND_STALE_AFTER : MISSING_STALE_AFTER);

class Audible extends ExternalAPI {
  public readonly region: string;
  private inFlight = new Map<string, Promise<AudiobookAvailability>>();

  constructor(countryCode?: string) {
    const marketplace = getAudibleMarketplace(countryCode);

    super(
      `https://${marketplace.host}/1.0`,
      {},
      {
        nodeCache: cacheManager.getCache('audible').data,
        publicCatalog: true,
        timeout: 10000,
        rateLimit: { maxRequests: MAX_RPS, maxRPS: MAX_RPS },
      }
    );

    this.region = marketplace.region;
  }

  private async searchProducts(
    params: Record<string, string>
  ): Promise<AudibleProduct[]> {
    const data = await this.get<AudibleProductsResponse>(
      '/catalog/products',
      {
        params: {
          ...params,
          num_results: String(NUM_RESULTS),
          response_groups: 'product_desc,contributors,product_attrs,media',
          image_sizes: COVER_SIZE,
        },
      },
      CACHE_TTL
    );

    return data.products ?? [];
  }

  /**
   * One page of the audiobooks a narrator read, newest first. The catalog
   * matches the name loosely, so callers check the narrators themselves.
   */
  public async searchNarrator(
    name: string,
    page = 0
  ): Promise<{ products: AudibleProduct[]; total: number }> {
    const data = await this.get<AudibleProductsResponse>(
      '/catalog/products',
      {
        params: {
          narrator: name,
          num_results: String(NARRATOR_PAGE_SIZE),
          page: String(page),
          products_sort_by: '-ReleaseDate',
          response_groups: 'contributors,product_attrs,media,series',
          image_sizes: COVER_SIZE,
        },
      },
      NARRATOR_CACHE_TTL
    );

    return {
      products: data.products ?? [],
      total: data.total_results ?? data.products?.length ?? 0,
    };
  }

  /**
   * Asks the catalog for an audiobook edition of a book. Tries a title and
   * author search first, then a keyword search, and reports unknown when
   * either search fails without a match.
   */
  public async findAudiobook(
    title: string,
    authors: string[]
  ): Promise<AudiobookAvailability> {
    const mainTitle = title.split(':')[0].trim() || title;
    const author = authors[0];

    if (!mainTitle || !author) {
      return { exists: null };
    }

    const searches: Record<string, string>[] = [
      { title: mainTitle, author },
      { keywords: `${mainTitle} ${author}` },
    ];

    for (const params of searches) {
      try {
        const match = findAudiobookMatch(
          title,
          authors,
          await this.searchProducts(params)
        );

        if (match) {
          return { exists: true, ...mapAudiobookEdition(match) };
        }
      } catch (e) {
        logger.debug('Failed to search the Audible catalog', {
          label: 'Audible',
          title,
          errorMessage: getErrorMessage(e),
        });
        return { exists: null };
      }
    }

    return { exists: false };
  }

  /**
   * Whether an OpenLibrary work has an audiobook edition, from memory or
   * metadata_book_audio when it was looked up before
   */
  public async getAvailability(
    olId: string,
    title: string,
    authors: string[]
  ): Promise<AudiobookAvailability> {
    const cache = cacheManager.getCache('audible').data;
    const cacheKey = `availability:${this.region}:${olId}`;
    const cached = cache.get<AudiobookAvailability>(cacheKey);

    if (cached) {
      return cached;
    }

    const pending = this.inFlight.get(cacheKey);

    if (pending) {
      return pending;
    }

    const lookup = this.lookupAvailability(olId, title, authors)
      .then((result) => {
        cache.set(
          cacheKey,
          result,
          result.exists === null ? UNKNOWN_TTL : CACHE_TTL
        );
        return result;
      })
      .finally(() => this.inFlight.delete(cacheKey));

    this.inFlight.set(cacheKey, lookup);

    return lookup;
  }

  private async lookupAvailability(
    olId: string,
    title: string,
    authors: string[]
  ): Promise<AudiobookAvailability> {
    const repository = getRepository(MetadataBookAudio);
    const row = await repository.findOne({ where: { olId } }).catch(() => null);

    if (row && !isStale(row, this.region)) {
      return mapSavedAudiobook(row);
    }

    const result = await this.findAudiobook(title, authors);

    if (result.exists !== null) {
      await repository
        .upsert(
          {
            olId,
            region: this.region,
            hasAudiobook: result.exists,
            asin: result.asin ?? null,
            narrators: result.exists ? (result.narrators ?? []) : null,
            runtimeMinutes: result.runtimeMinutes ?? null,
            coverUrl: result.coverUrl ?? null,
            checkedAt: new Date(),
          },
          { conflictPaths: ['olId'] }
        )
        .catch((e) => {
          logger.error('Failed to save audiobook availability', {
            label: 'Audible',
            olId,
            errorMessage: getErrorMessage(e),
          });
        });
    } else if (row) {
      // An older answer beats none while Audible cannot be asked
      return mapSavedAudiobook(row);
    }

    return result;
  }
}

const instances = new Map<string, Audible>();

/**
 * Client for the marketplace of the discover region. Shared, so every
 * lookup goes through the same rate limit.
 */
export const getAudible = (): Audible => {
  const countryCode = getSettings().main.discoverRegion;
  const { region } = getAudibleMarketplace(countryCode);
  let instance = instances.get(region);

  if (!instance) {
    instance = new Audible(countryCode);
    instances.set(region, instance);
  }

  return instance;
};

export { NARRATOR_PAGE_SIZE };
export default Audible;
