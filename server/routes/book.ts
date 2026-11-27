import type { AudiobookAvailability } from '@server/api/audible';
import { getAudible, mapSavedAudiobook } from '@server/api/audible';
import type { EbookAvailability } from '@server/api/googlebooks';
import { getGoogleBooks } from '@server/api/googlebooks';
import OpenLibrary, { WORK_ID_REGEX, getOlId } from '@server/api/openlibrary';
import type { OlSearchDoc } from '@server/api/openlibrary/interfaces';
import { MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import MetadataBookAudio from '@server/entity/MetadataBookAudio';
import { getAudiobookshelfLinks } from '@server/lib/audiobookshelfItem';
import { getGrimmoryLinks, grimmoryServes } from '@server/lib/grimmoryItem';
import { getSettings } from '@server/lib/settings';
import { getBookRecordings } from '@server/lib/talearrRecordings';
import { isOnUserWatchlist } from '@server/lib/watchlistStatus';
import logger from '@server/logger';
import type { AudiobookEdition } from '@server/models/Book';
import { mapBookDetails } from '@server/models/Book';
import { Router } from 'express';

const bookRoutes = Router();

// Anthologies can list dozens of authors, the page names the first few
const MAX_AUTHOR_LOOKUPS = 5;
// Books asked about in one availability call, a page of cards
const MAX_AVAILABILITY_BATCH = 50;

const splitAuthors = (author?: unknown): string[] =>
  typeof author === 'string'
    ? author
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean)
    : [];

interface AvailabilityBook {
  olId: string;
  title: string;
  // Author names, comma separated
  author?: unknown;
}

type AvailabilityBody = {
  books?: { olId?: unknown; title?: unknown; author?: unknown }[];
};

/**
 * The books of an availability call with a valid work id and a title, or
 * undefined when the list is missing or too long
 */
const getAvailabilityBooks = (
  books: AvailabilityBody['books']
): AvailabilityBook[] | undefined => {
  if (!Array.isArray(books) || books.length > MAX_AVAILABILITY_BATCH) {
    return undefined;
  }

  return books.filter(
    (book): book is AvailabilityBook =>
      typeof book?.olId === 'string' &&
      WORK_ID_REGEX.test(book.olId) &&
      typeof book.title === 'string' &&
      !!book.title.trim()
  );
};

/**
 * Title and authors of a work, for availability lookups by id alone
 */
const getWorkTitleAndAuthors = async (
  olId: string
): Promise<{ title: string; authors: string[] }> => {
  const openLibrary = new OpenLibrary();
  const summary = await openLibrary
    .getWorkSummary(olId)
    .catch((): OlSearchDoc | undefined => undefined);
  const title = summary?.title ?? (await openLibrary.getWork(olId)).title;

  return { title, authors: summary?.author_name ?? [] };
};

const availabilityBatchError = {
  status: 400,
  message: `Between 0 and ${MAX_AVAILABILITY_BATCH} books may be asked about.`,
};

/**
 * Whether Audible lists audiobook editions of several books, keyed by
 * OpenLibrary work id. Books Audible could not be asked about report null.
 */
bookRoutes.post<never, Record<string, AudiobookAvailability>, AvailabilityBody>(
  '/audiobook-availability',
  async (req, res, next) => {
    const books = getAvailabilityBooks(req.body.books);

    if (!books) {
      return next(availabilityBatchError);
    }

    const audible = getAudible();
    const results: Record<string, AudiobookAvailability> = {};

    await Promise.all(
      books.map(async (book) => {
        results[book.olId] = await audible
          .getAvailability(book.olId, book.title, splitAuthors(book.author))
          .catch(() => ({ exists: null }));
      })
    );

    return res.status(200).json(results);
  }
);

/**
 * Whether Google Books lists ebook editions of several books, keyed by
 * OpenLibrary work id. Every book reports null while no Google Books API
 * key is set, and books Google could not be asked about report null.
 */
bookRoutes.post<never, Record<string, EbookAvailability>, AvailabilityBody>(
  '/ebook-availability',
  async (req, res, next) => {
    const books = getAvailabilityBooks(req.body.books);

    if (!books) {
      return next(availabilityBatchError);
    }

    const googleBooks = getGoogleBooks();
    const results: Record<string, EbookAvailability> = {};

    await Promise.all(
      books.map(async (book) => {
        results[book.olId] = googleBooks
          ? await googleBooks
              .getAvailability(book.olId, book.title, splitAuthors(book.author))
              .catch(() => ({ exists: null }))
          : { exists: null };
      })
    );

    return res.status(200).json(results);
  }
);

/**
 * Whether Audible lists an audiobook edition of a book
 */
bookRoutes.get<{ id: string }>('/:id/audiobook', async (req, res, next) => {
  if (!WORK_ID_REGEX.test(req.params.id)) {
    return next({ status: 404, message: 'Book not found.' });
  }

  try {
    const { title, authors } = await getWorkTitleAndAuthors(req.params.id);
    const result = await getAudible()
      .getAvailability(req.params.id, title, authors)
      .catch(() => ({ exists: null }));

    return res.status(200).json(result);
  } catch (e) {
    logger.debug('Something went wrong retrieving audiobook availability', {
      label: 'API',
      errorMessage: e.message,
      olId: req.params.id,
    });
    return next({ status: 404, message: 'Book not found.' });
  }
});

/**
 * Whether Google Books lists an ebook edition of a book. Reports null
 * without asking anything while no Google Books API key is set.
 */
bookRoutes.get<{ id: string }>('/:id/ebook', async (req, res, next) => {
  if (!WORK_ID_REGEX.test(req.params.id)) {
    return next({ status: 404, message: 'Book not found.' });
  }

  const googleBooks = getGoogleBooks();

  if (!googleBooks) {
    return res.status(200).json({ exists: null });
  }

  try {
    const { title, authors } = await getWorkTitleAndAuthors(req.params.id);
    const result = await googleBooks
      .getAvailability(req.params.id, title, authors)
      .catch(() => ({ exists: null }));

    return res.status(200).json(result);
  } catch (e) {
    logger.debug('Something went wrong retrieving ebook availability', {
      label: 'API',
      errorMessage: e.message,
      olId: req.params.id,
    });
    return next({ status: 404, message: 'Book not found.' });
  }
});

/**
 * The recordings Talearr keeps of the book's audiobook, the editions that
 * could become one and the recording requests made for it. Answers with
 * supported false, and why, when the book service is not Talearr or the
 * audiobook is not available there.
 */
bookRoutes.get<{ id: string }>('/:id/recordings', async (req, res, next) => {
  if (!req.user) {
    return next({ status: 403, message: 'Not signed in.' });
  }

  if (!WORK_ID_REGEX.test(req.params.id)) {
    return next({ status: 404, message: 'Book not found.' });
  }

  try {
    const media = await getRepository(Media).findOne({
      where: { olId: req.params.id, mediaType: MediaType.BOOK },
    });

    return res.status(200).json(await getBookRecordings(media, req.user));
  } catch (e) {
    logger.debug('Something went wrong retrieving book recordings', {
      label: 'API',
      errorMessage: e.message,
      olId: req.params.id,
    });
    return next({ status: 500, message: 'Unable to retrieve recordings.' });
  }
});

/**
 * The audiobook edition saved by an earlier Audible lookup. Only reads the
 * database, the book page never waits for Audible.
 */
const getSavedAudiobookEdition = async (
  olId: string
): Promise<AudiobookEdition | null> => {
  const row = await getRepository(MetadataBookAudio)
    .findOne({ where: { olId } })
    .catch(() => null);

  if (!row?.hasAudiobook) {
    return null;
  }

  const { asin, narrators, runtimeMinutes, coverUrl } = mapSavedAudiobook(row);

  return { asin, narrators: narrators ?? [], runtimeMinutes, coverUrl };
};

/**
 * Book details, by OpenLibrary work id
 */
bookRoutes.get<{ id: string }>('/:id', async (req, res, next) => {
  if (!WORK_ID_REGEX.test(req.params.id)) {
    return next({ status: 404, message: 'Book not found.' });
  }

  const openLibrary = new OpenLibrary();

  try {
    const work = await openLibrary.getWork(req.params.id);
    const workId = getOlId(work.key);

    // The summary only adds facts, the book renders without it
    const [summary, media, audiobookEdition] = await Promise.all([
      openLibrary
        .getWorkSummary(workId)
        .catch((): OlSearchDoc | undefined => undefined),
      Media.getMedia(workId, MediaType.BOOK),
      getSavedAudiobookEdition(workId),
    ]);

    // The search summary names the authors, the work record only links them
    const authors = summary?.author_key?.length
      ? undefined
      : await Promise.all(
          (work.authors ?? [])
            .slice(0, MAX_AUTHOR_LOOKUPS)
            .map(async ({ author }) => {
              const id = getOlId(author.key);
              const record = await openLibrary
                .getAuthor(id)
                .catch(() => undefined);

              return { id, name: record?.name ?? '' };
            })
        );

    const book = mapBookDetails(work, {
      summary,
      authors,
      media: media?.filter(req.user),
    });

    // Links wait a moment at most for Audiobookshelf and Grimmory, see
    // LOOKUP_BUDGET. Formats Grimmory serves link there instead.
    const settings = getSettings();
    const linkBook = {
      olId: workId,
      title: book.title,
      authors: book.authors.map((author) => author.name).filter(Boolean),
      asin: audiobookEdition?.asin,
    };
    const [onUserWatchlist, audiobookshelfLinks, grimmoryLinks] =
      await Promise.all([
        isOnUserWatchlist(req.user, MediaType.BOOK, workId),
        getAudiobookshelfLinks(
          settings.audiobookshelf,
          linkBook,
          media,
          (['ebook', 'audiobook'] as const).filter((format) =>
            grimmoryServes(settings.grimmory, format)
          )
        ),
        getGrimmoryLinks(settings.grimmory, linkBook, media),
      ]);

    return res.status(200).json({
      ...book,
      // Audible's cover only stands in when OpenLibrary has none
      posterPath: book.posterPath ?? audiobookEdition?.coverUrl ?? null,
      onUserWatchlist,
      ...audiobookshelfLinks,
      ...grimmoryLinks,
      audiobookEdition,
    });
  } catch (e) {
    logger.debug('Something went wrong retrieving book', {
      label: 'API',
      errorMessage: e.message,
      olId: req.params.id,
    });
    return next({
      status: 500,
      message: 'Unable to retrieve book.',
    });
  }
});

export default bookRoutes;
