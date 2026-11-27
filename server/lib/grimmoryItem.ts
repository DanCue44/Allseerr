import type { AudiobookshelfBookItem } from '@server/api/audiobookshelf';
import type { GrimmoryBook, GrimmoryFormat } from '@server/api/grimmory';
import GrimmoryAPI from '@server/api/grimmory';
import { MediaStatus } from '@server/constants/media';
import type Media from '@server/entity/Media';
import type { AudiobookshelfBook } from '@server/lib/audiobookshelfItem';
import {
  LOOKUP_BUDGET,
  findAudiobookshelfItem,
  getSearchQueries,
} from '@server/lib/audiobookshelfItem';
import cacheManager from '@server/lib/cache';
import type { GrimmorySettings } from '@server/lib/settings';
import logger from '@server/logger';

// Matches change rarely, misses are asked again sooner as Grimmory may
// still be scanning a new book, and failures are not retried right away
const MATCH_TTL = 12 * 60 * 60;
const MISS_TTL = 30 * 60;
const UNKNOWN_TTL = 2 * 60;
const REQUEST_TIMEOUT = 1500;
const SEARCH_LIMIT = 10;

export const isGrimmoryConfigured = (settings: GrimmorySettings): boolean =>
  !!settings.url?.trim() && !!settings.username && !!settings.password;

/**
 * Whether Grimmory serves a format in place of Audiobookshelf
 */
export const grimmoryServes = (
  settings: GrimmorySettings,
  format: GrimmoryFormat
): boolean =>
  isGrimmoryConfigured(settings) &&
  (format === 'ebook' ? !!settings.ebooks : !!settings.audiobooks);

export const getGrimmoryLibraryId = (
  settings: GrimmorySettings,
  format: GrimmoryFormat
): string | undefined =>
  (format === 'ebook'
    ? settings.ebookLibraryId
    : settings.audiobookLibraryId) || undefined;

/**
 * Whether a Grimmory book can stand for a format: in the format's library
 * when one is set, and holding the format when Grimmory says what it holds
 */
export const holdsGrimmoryFormat = (
  settings: GrimmorySettings,
  book: GrimmoryBook,
  format: GrimmoryFormat
): boolean => {
  const libraryId = getGrimmoryLibraryId(settings, format);

  if (libraryId && book.libraryId && book.libraryId !== libraryId) {
    return false;
  }

  return !book.formats.length || book.formats.includes(format);
};

/**
 * A Grimmory book in the shape the Audiobookshelf matching takes, so both
 * libraries match books the same way
 */
export const toMatchItem = (book: GrimmoryBook): AudiobookshelfBookItem => ({
  id: book.id,
  title: book.title,
  subtitle: book.subtitle,
  authors: book.authors,
  series: book.series,
  isbn: book.isbn,
  asin: book.asin,
});

/**
 * The Grimmory book that is the book, if any
 */
export const findGrimmoryBook = (
  book: AudiobookshelfBook,
  items: GrimmoryBook[],
  isbns: string[] = []
): GrimmoryBook | undefined => {
  const match = findAudiobookshelfItem(book, items.map(toMatchItem), isbns);

  return match ? items.find((item) => item.id === match.id) : undefined;
};

const publicBaseUrl = (settings: GrimmorySettings): string | undefined =>
  (settings.publicUrl || settings.url)?.replace(/\/+$/, '') || undefined;

export const getGrimmoryBookUrl = (
  settings: GrimmorySettings,
  bookId: string
): string | undefined => {
  const base = publicBaseUrl(settings);

  return base ? `${base}/book/${encodeURIComponent(bookId)}` : undefined;
};

// Raised when the settings change, so lookups made before are not used
let generation = 0;

export const clearGrimmoryLookups = (): void => {
  generation++;
};

interface CachedBook {
  // undefined while unknown, null when Grimmory has no such book
  bookId?: string | null;
}

const inFlight = new Map<string, Promise<CachedBook>>();

const searchGrimmory = async (
  settings: GrimmorySettings,
  format: GrimmoryFormat,
  book: AudiobookshelfBook
): Promise<CachedBook> => {
  const api = new GrimmoryAPI({
    url: settings.url ?? '',
    username: settings.username,
    password: settings.password,
    timeout: REQUEST_TIMEOUT,
  });

  for (const query of getSearchQueries(book)) {
    const items = (await api.searchBooks(query, SEARCH_LIMIT)).filter((item) =>
      holdsGrimmoryFormat(settings, item, format)
    );
    const match = findGrimmoryBook(book, items);

    if (match) {
      return { bookId: match.id };
    }
  }

  return { bookId: null };
};

/**
 * The Grimmory book of a format of a book, from memory when it was looked
 * up recently. Resolves undefined when Grimmory could not be asked.
 */
export const lookupGrimmoryBook = (
  settings: GrimmorySettings,
  format: GrimmoryFormat,
  book: AudiobookshelfBook
): Promise<string | null | undefined> => {
  const cache = cacheManager.getCache('audiobookshelf').data;
  const cacheKey = `grimmory:${generation}:${format}:${book.olId}`;
  const cached = cache.get<CachedBook>(cacheKey);

  if (cached) {
    return Promise.resolve(cached.bookId);
  }

  let pending = inFlight.get(cacheKey);

  if (!pending) {
    pending = searchGrimmory(settings, format, book)
      .catch((e): CachedBook => {
        logger.debug('Failed to look a book up in Grimmory', {
          label: 'Grimmory',
          olId: book.olId,
          errorMessage: e.message,
        });
        return {};
      })
      .then((result) => {
        cache.set(
          cacheKey,
          result,
          result.bookId === undefined
            ? UNKNOWN_TTL
            : result.bookId
              ? MATCH_TTL
              : MISS_TTL
        );
        return result;
      })
      .finally(() => inFlight.delete(cacheKey));
    inFlight.set(cacheKey, pending);
  }

  return pending.then((result) => result.bookId);
};

export interface GrimmoryLinks {
  grimmoryEbookUrl: string | null;
  grimmoryAudiobookUrl: string | null;
}

/**
 * Where the available formats Grimmory serves open: the book itself once
 * it is found, otherwise Grimmory's home page. Waits LOOKUP_BUDGET at most.
 */
export const getGrimmoryLinks = async (
  settings: GrimmorySettings,
  book: AudiobookshelfBook,
  media?: Media,
  budget = LOOKUP_BUDGET
): Promise<GrimmoryLinks> => {
  const linkFor = async (
    format: GrimmoryFormat,
    available: boolean
  ): Promise<string | null> => {
    const base = publicBaseUrl(settings);

    if (!available || !base || !grimmoryServes(settings, format)) {
      return null;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const bookId = await Promise.race([
      lookupGrimmoryBook(
        settings,
        format,
        // The Audible ASIN only belongs to the audiobook
        format === 'ebook' ? { ...book, asin: undefined } : book
      ),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), budget);
      }),
    ]).finally(() => clearTimeout(timer));

    return bookId ? (getGrimmoryBookUrl(settings, bookId) ?? base) : base;
  };

  const [grimmoryEbookUrl, grimmoryAudiobookUrl] = await Promise.all([
    linkFor('ebook', media?.status === MediaStatus.AVAILABLE),
    linkFor('audiobook', media?.statusAudio === MediaStatus.AVAILABLE),
  ]);

  return { grimmoryEbookUrl, grimmoryAudiobookUrl };
};
