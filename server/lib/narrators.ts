import type Audible from '@server/api/audible';
import { getAudible, NARRATOR_PAGE_SIZE } from '@server/api/audible';
import type { AudibleProduct } from '@server/api/audible/interfaces';
import { isEditionMatch, normalizeTitle } from '@server/api/audible/match';
import OpenLibrary, { getOlId } from '@server/api/openlibrary';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import MetadataBookAudio from '@server/entity/MetadataBookAudio';
import cacheManager from '@server/lib/cache';
import { searchTokens } from '@server/lib/searchRank';
import logger from '@server/logger';
import type { NarratorResult } from '@server/models/Search';
import { runInBackground } from '@server/utils/backgroundTasks';
import { In } from 'typeorm';

// Pages of fifty asked for a narrator, so the busiest narrators show their
// latest two hundred recordings
const MAX_NARRATOR_PAGES = 4;
// How long a narrator page waits for books to be matched to OpenLibrary.
// Matching carries on afterwards and the page asks again for the rest.
export const NARRATOR_MATCH_BUDGET_MS = 4000;
// Matches change rarely, misses are asked again after a few days. The cache
// keeps an entry at most 24 days.
const MATCH_TTL = 20 * 24 * 60 * 60;
const MISS_TTL = 3 * 24 * 60 * 60;
// Books matched to OpenLibrary at the same time, OpenLibrary itself allows
// three requests a second
const MATCH_CONCURRENCY = 3;
// Narrators offered in the search results for one query
const MAX_SEARCH_NARRATORS = 2;

/**
 * An audiobook a narrator read, as the narrator page lists it
 */
export interface NarratorBook {
  asin: string;
  title: string;
  subtitle?: string;
  authors: string[];
  series?: { name: string; position?: string };
  releaseDate?: string;
  runtimeMinutes?: number;
  coverUrl: string | null;
  // The OpenLibrary work, undefined while it is still being looked for and
  // null when OpenLibrary has none
  olId?: string | null;
  mediaInfo?: Media;
}

export interface NarratorSeriesGroup {
  name: string;
  books: NarratorBook[];
}

export interface NarratorAuthorGroup {
  name: string;
  series: NarratorSeriesGroup[];
  standalone: NarratorBook[];
}

export interface NarratorDetails {
  name: string;
  // Books listed, after editions of the same book are folded together
  totalBooks: number;
  // Whether the narrator has more recordings than the page lists
  truncated: boolean;
  // Books still being matched to OpenLibrary
  pending: number;
  authors: NarratorAuthorGroup[];
}

/**
 * A name without case, accents, punctuation or spaces, so "R.C. Bray" and
 * "RC Bray" compare the same
 */
export const compactName = (name: string): string =>
  searchTokens(name).join('');

/**
 * Whether a narrator name is the one asked for: the same name, or for
 * names of two words or more, every word of it
 */
export const isNarratorNameMatch = (query: string, name: string): boolean => {
  const compactQuery = compactName(query);

  if (!compactQuery) {
    return false;
  }

  if (compactQuery === compactName(name)) {
    return true;
  }

  const queryTokens = searchTokens(query);
  const nameTokens = searchTokens(name);

  return (
    queryTokens.length >= 2 &&
    queryTokens.every((token) => nameTokens.includes(token))
  );
};

const narratorNames = (product: AudibleProduct): string[] =>
  (product.narrators ?? [])
    .map((narrator) => narrator.name?.trim())
    .filter((name): name is string => !!name);

/**
 * The narrators in a catalog answer that match a query, spelled as Audible
 * spells them, the exact name first and then the one with most books
 */
export const findNarratorNames = (
  query: string,
  products: AudibleProduct[]
): { name: string; count: number; exact: boolean }[] => {
  const counts = new Map<string, { name: string; count: number }>();

  for (const product of products) {
    for (const name of new Set(narratorNames(product))) {
      if (!isNarratorNameMatch(query, name)) {
        continue;
      }

      const key = compactName(name);
      const entry = counts.get(key) ?? { name, count: 0 };
      entry.count++;
      counts.set(key, entry);
    }
  }

  const compactQuery = compactName(query);

  return [...counts.entries()]
    .map(([key, entry]) => ({ ...entry, exact: key === compactQuery }))
    .sort(
      (a, b) =>
        Number(b.exact) - Number(a.exact) ||
        b.count - a.count ||
        a.name.localeCompare(b.name)
    );
};

/**
 * The book a catalog product is, for the narrator page
 */
export const mapNarratorBook = (product: AudibleProduct): NarratorBook => {
  const series = product.series?.find((entry) => entry.title?.trim());

  return {
    asin: product.asin,
    title: product.title?.trim() || product.asin,
    subtitle: product.subtitle?.trim() || undefined,
    authors: [
      ...new Set(
        (product.authors ?? [])
          .map((author) => author.name?.trim())
          .filter((name): name is string => !!name)
      ),
    ],
    series: series?.title
      ? {
          name: series.title.trim(),
          position: series.sequence?.trim() || undefined,
        }
      : undefined,
    releaseDate: product.release_date || undefined,
    runtimeMinutes:
      product.runtime_length_min && product.runtime_length_min > 0
        ? Math.round(product.runtime_length_min)
        : undefined,
    coverUrl: product.product_images?.['500'] || null,
  };
};

/**
 * The books a narrator read, one per book: the newest edition stands for
 * the others, such as a re-release or a dramatized edition with the same
 * title and author
 */
export const narratorBooksFrom = (
  name: string,
  products: AudibleProduct[]
): NarratorBook[] => {
  const key = compactName(name);
  const seen = new Set<string>();
  const books: NarratorBook[] = [];

  for (const product of products) {
    if (
      !product.asin ||
      !narratorNames(product).some((narrator) => compactName(narrator) === key)
    ) {
      continue;
    }

    const book = mapNarratorBook(product);
    const bookKey = `${normalizeTitle(book.title)}|${compactName(
      book.authors[0] ?? ''
    )}`;

    if (seen.has(bookKey)) {
      continue;
    }

    seen.add(bookKey);
    books.push(book);
  }

  return books;
};

// A series place as a number, places such as "1-3" sort by their start and
// books without one go last
const seriesPlace = (book: NarratorBook): number => {
  const value = Number.parseFloat(book.series?.position ?? '');

  return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
};

const byReleaseDate = (a: NarratorBook, b: NarratorBook): number =>
  (a.releaseDate ?? '9999').localeCompare(b.releaseDate ?? '9999');

/**
 * The books grouped by their first author, then by series in series order,
 * then the books outside a series. Authors with the most books come first,
 * series and books outside a series in the order they came out.
 */
export const groupNarratorBooks = (
  books: NarratorBook[]
): NarratorAuthorGroup[] => {
  const authors = new Map<
    string,
    { name: string; count: number; series: Map<string, NarratorSeriesGroup> }
  >();
  const standalone = new Map<string, NarratorBook[]>();

  for (const book of books) {
    const authorName = book.authors[0] ?? '';
    const authorKey = compactName(authorName);
    let author = authors.get(authorKey);

    if (!author) {
      author = { name: authorName, count: 0, series: new Map() };
      authors.set(authorKey, author);
      standalone.set(authorKey, []);
    }

    author.count++;

    if (book.series) {
      const seriesKey = compactName(book.series.name);
      const group = author.series.get(seriesKey) ?? {
        name: book.series.name,
        books: [],
      };
      group.books.push(book);
      author.series.set(seriesKey, group);
    } else {
      standalone.get(authorKey)?.push(book);
    }
  }

  return [...authors.entries()]
    .sort(
      ([, a], [, b]) =>
        b.count - a.count ||
        // Books without an author go last
        Number(!a.name) - Number(!b.name) ||
        a.name.localeCompare(b.name)
    )
    .map(([key, author]) => ({
      name: author.name,
      series: [...author.series.values()]
        .map((group) => ({
          name: group.name,
          books: [...group.books].sort(
            (a, b) => seriesPlace(a) - seriesPlace(b) || byReleaseDate(a, b)
          ),
        }))
        .sort((a, b) => byReleaseDate(a.books[0], b.books[0])),
      standalone: [...(standalone.get(key) ?? [])].sort(byReleaseDate),
    }));
};

const matchCacheKey = (asin: string) => `narrator-work:${asin}`;

const getCachedWork = (asin: string): string | null | undefined =>
  cacheManager
    .getCache('audible')
    .data.get<{ olId: string | null }>(matchCacheKey(asin))?.olId;

const setCachedWork = (asin: string, olId: string | null) =>
  cacheManager
    .getCache('audible')
    .data.set(matchCacheKey(asin), { olId }, olId ? MATCH_TTL : MISS_TTL);

/**
 * The OpenLibrary work of an audiobook: by its title and first author,
 * checked the same way audiobooks are matched to works. Throws when
 * OpenLibrary could not be asked.
 */
export const findOpenLibraryWork = async (
  openLibrary: OpenLibrary,
  book: Pick<NarratorBook, 'title' | 'subtitle' | 'authors'>
): Promise<string | null> => {
  const mainTitle = book.title
    .split(':')[0]
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const author = book.authors[0];

  if (!mainTitle || !author) {
    return null;
  }

  const { docs } = await openLibrary.searchBooks({
    query: `${mainTitle} ${author}`,
    limit: 5,
  });
  const match = (docs ?? []).find((doc) =>
    isEditionMatch(book.title, book.authors, {
      title: doc.title,
      subtitle: doc.subtitle,
      authors: doc.author_name ?? [],
    })
  );

  return match ? getOlId(match.key) : null;
};

const inFlight = new Map<string, Promise<void>>();

/**
 * Looks for the OpenLibrary works of the books not matched yet, a few at a
 * time, remembering each answer. Books matched to an Audible edition before
 * are found in metadata_book_audio without asking OpenLibrary.
 */
const matchWorks = async (books: NarratorBook[]): Promise<void> => {
  const unknown = books.filter(
    (book) => getCachedWork(book.asin) === undefined
  );

  if (!unknown.length) {
    return;
  }

  const saved = await getRepository(MetadataBookAudio)
    .find({
      where: { asin: In(unknown.map((book) => book.asin)) },
      select: ['olId', 'asin'],
    })
    .catch((): MetadataBookAudio[] => []);

  for (const row of saved) {
    if (row.asin) {
      setCachedWork(row.asin, row.olId);
    }
  }

  const queue = unknown.filter(
    (book) => getCachedWork(book.asin) === undefined
  );
  const openLibrary = new OpenLibrary();

  const worker = async () => {
    for (let book = queue.shift(); book; book = queue.shift()) {
      try {
        setCachedWork(book.asin, await findOpenLibraryWork(openLibrary, book));
      } catch (e) {
        // Asked again on the next page load
        logger.debug('Failed to match a narrated book to OpenLibrary', {
          label: 'Narrator',
          asin: book.asin,
          errorMessage: (e as Error).message,
        });
      }
    }
  };

  await Promise.all(Array.from({ length: MATCH_CONCURRENCY }, worker));
};

/**
 * Matches books to their works, waiting at most the budget. Matching that
 * runs over carries on in the background.
 */
const matchWorksWithin = async (
  key: string,
  books: NarratorBook[],
  budget: number
): Promise<void> => {
  let pending = inFlight.get(key);

  if (!pending) {
    pending = matchWorks(books).finally(() => inFlight.delete(key));
    inFlight.set(key, pending);
    runInBackground(pending);
  }

  let timer: ReturnType<typeof setTimeout> | undefined;

  await Promise.race([
    pending,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, budget);
    }),
  ]);
  clearTimeout(timer);
};

/**
 * The recordings of a narrator, all pages up to MAX_NARRATOR_PAGES
 */
const fetchNarratorProducts = async (
  audible: Audible,
  name: string
): Promise<{ products: AudibleProduct[]; total: number }> => {
  const first = await audible.searchNarrator(name, 0);
  const pages = Math.min(
    MAX_NARRATOR_PAGES,
    Math.ceil(first.total / NARRATOR_PAGE_SIZE)
  );
  const rest = await Promise.all(
    Array.from({ length: Math.max(0, pages - 1) }, (_, index) =>
      audible
        .searchNarrator(name, index + 1)
        .then((page) => page.products)
        .catch((): AudibleProduct[] => [])
    )
  );

  return {
    products: [...first.products, ...rest.flat()],
    total: first.total,
  };
};

/**
 * A narrator's audiobooks grouped by author and series, with the request
 * status of each book matched to an OpenLibrary work. Null when Audible
 * lists no narrator by that name.
 */
export const getNarratorDetails = async (
  name: string,
  { budget = NARRATOR_MATCH_BUDGET_MS }: { budget?: number } = {}
): Promise<NarratorDetails | null> => {
  const audible = getAudible();
  const { products, total } = await fetchNarratorProducts(audible, name);
  // The name as Audible spells it, when the one asked for differs
  const [found] = findNarratorNames(name, products);

  if (!found) {
    return null;
  }

  const books = narratorBooksFrom(found.name, products);

  await matchWorksWithin(
    `${audible.region}:${compactName(found.name)}`,
    books,
    budget
  );

  for (const book of books) {
    book.olId = getCachedWork(book.asin);
  }

  const media = await Media.getRelatedBooks(
    books.map((book) => book.olId).filter((olId): olId is string => !!olId)
  );
  const mediaMap = new Map(media.map((m) => [m.olId, m]));

  for (const book of books) {
    book.mediaInfo = book.olId ? mediaMap.get(book.olId) : undefined;
  }

  return {
    name: found.name,
    totalBooks: books.length,
    truncated: total > MAX_NARRATOR_PAGES * NARRATOR_PAGE_SIZE,
    pending: books.filter((book) => book.olId === undefined).length,
    authors: groupNarratorBooks(books),
  };
};

/**
 * Narrators whose name matches a search, from the first page of Audible's
 * narrator search. Queries of a single word are skipped, they are nearly
 * always titles.
 */
export const searchNarrators = async (
  query: string
): Promise<NarratorResult[]> => {
  if (searchTokens(query).length < 2) {
    return [];
  }

  const { products, total } = await getAudible().searchNarrator(query, 0);

  return findNarratorNames(query, products)
    .slice(0, MAX_SEARCH_NARRATORS)
    .map((narrator) => {
      const latest = products.find((product) =>
        narratorNames(product).some(
          (name) => compactName(name) === compactName(narrator.name)
        )
      );

      return {
        id: narrator.name,
        mediaType: 'narrator' as const,
        name: narrator.name,
        // The catalog total counts every recording of the exact name
        bookCount:
          narrator.exact && products.length >= NARRATOR_PAGE_SIZE
            ? total
            : narrator.count,
        topWork: latest?.title,
        profilePath: null,
      };
    });
};
