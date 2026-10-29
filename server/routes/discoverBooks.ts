import type { OlTrendingPeriod } from '@server/api/openlibrary';
import OpenLibrary, { getOlId } from '@server/api/openlibrary';
import type { OlSubjectSearchDoc } from '@server/api/openlibrary/interfaces';
import Media from '@server/entity/Media';
import type {
  BookSubjectSearchResponse,
  BookSubjectSuggestion,
} from '@server/interfaces/api/discoverInterfaces';
import { getOwnedCoverPath } from '@server/lib/audiobookshelfCover';
import { getUpcomingBooks } from '@server/lib/bookReleases';
import {
  getBookSubjectLabel,
  isBookSubjectSlug,
} from '@server/lib/bookSubjects';
import { getBookHeroes } from '@server/lib/heroBackdrops';
import logger from '@server/logger';
import { mapBookResult, mapSubjectWorkResult } from '@server/models/Book';
import type { BookResult } from '@server/models/Search';
import type { RequestHandler } from 'express';
import { Router } from 'express';

const discoverBooksRoutes = Router();

const PAGE_SIZE = 20;
// Trending lists do not report their length, so they stop after a few pages
const MAX_TRENDING_PAGES = 10;

const MAX_SUBJECT_SUGGESTIONS = 10;
// Room for the people, places and times the subject search also returns
const SUBJECT_SEARCH_LIMIT = 25;

/**
 * The search query of the subject suggestions. Like the other searches it
 * arrives URL encoded, so that the API spec accepts spaces and symbols.
 */
const decodeSubjectQuery = (query: unknown): string => {
  if (typeof query !== 'string') {
    return '';
  }

  try {
    return decodeURIComponent(query).trim();
  } catch {
    return query.trim();
  }
};

/**
 * The plain subjects of an OpenLibrary subject search, one per key. People,
 * places and times have keys of their own (person:...) that the subject
 * pages do not serve.
 */
export const toSubjectSuggestions = (
  docs: OlSubjectSearchDoc[]
): BookSubjectSuggestion[] => {
  const seen = new Set<string>();
  const suggestions: BookSubjectSuggestion[] = [];

  for (const doc of docs) {
    const subject = getOlId(doc.key ?? '');

    if (
      (doc.subject_type && doc.subject_type !== 'subject') ||
      !isBookSubjectSlug(subject) ||
      seen.has(subject)
    ) {
      continue;
    }

    seen.add(subject);
    suggestions.push({
      subject,
      name: doc.name?.trim() || getBookSubjectLabel(subject),
      workCount: doc.work_count ?? 0,
    });
  }

  return suggestions.slice(0, MAX_SUBJECT_SUGGESTIONS);
};

const withMediaInfo = async (books: BookResult[]): Promise<BookResult[]> => {
  const media = await Media.getRelatedBooks(books.map((book) => book.id));
  const mediaMap = new Map(media.map((m) => [m.olId, m]));

  return books.map((book) => {
    const mediaInfo = mediaMap.get(book.id);

    return {
      ...book,
      posterPath: getOwnedCoverPath(mediaInfo) ?? book.posterPath,
      mediaInfo,
    };
  });
};

const trendingHandler =
  (period: OlTrendingPeriod, description: string): RequestHandler =>
  async (req, res, next) => {
    const openLibrary = new OpenLibrary();
    const page = Math.min(Number(req.query.page) || 1, MAX_TRENDING_PAGES);

    try {
      const data = await openLibrary.getTrending({
        period,
        page,
        limit: PAGE_SIZE,
      });
      const books = data.works
        .filter((work) => work.key?.startsWith('/works/'))
        .map((work) => mapBookResult(work));
      const isLastPage =
        data.works.length < PAGE_SIZE || page >= MAX_TRENDING_PAGES;

      return res.status(200).json({
        page,
        totalPages: isLastPage ? page : page + 1,
        totalResults: (page - 1) * PAGE_SIZE + books.length,
        results: await withMediaInfo(books),
      });
    } catch (e) {
      logger.debug(`Something went wrong retrieving ${description}`, {
        label: 'API',
        errorMessage: e.message,
      });
      return next({
        status: 500,
        message: `Unable to retrieve ${description}.`,
      });
    }
  };

/**
 * Books trending on OpenLibrary today
 */
discoverBooksRoutes.get('/', trendingHandler('daily', 'trending books'));

/**
 * The few books trending today shown in the featured hero banner, with the
 * colours of their covers, and the covers of other trending books to lay
 * behind them
 */
discoverBooksRoutes.get('/hero', async (_req, res, next) => {
  try {
    const data = await new OpenLibrary().getTrending({
      period: 'daily',
      page: 1,
      limit: PAGE_SIZE,
    });
    const { results, collage } = await getBookHeroes(
      data.works
        .filter((work) => work.key?.startsWith('/works/'))
        .map((work) => mapBookResult(work))
    );

    return res.status(200).json({
      results: await withMediaInfo(results),
      collage,
    });
  } catch (e) {
    logger.debug('Something went wrong retrieving the books hero', {
      label: 'API',
      errorMessage: e.message,
    });
    return next({
      status: 500,
      message: 'Unable to retrieve trending books.',
    });
  }
});

/**
 * Books coming out soon and new books from the authors the user follows
 */
discoverBooksRoutes.get('/upcoming', async (req, res, next) => {
  if (!req.user) {
    return next({ status: 401, message: 'You must be logged in.' });
  }

  try {
    return res.status(200).json(await getUpcomingBooks(req.user));
  } catch (e) {
    logger.debug('Something went wrong retrieving upcoming books', {
      label: 'API',
      errorMessage: e.message,
    });
    return next({
      status: 500,
      message: 'Unable to retrieve upcoming books.',
    });
  }
});

/**
 * Books trending on OpenLibrary over the past year
 */
discoverBooksRoutes.get('/popular', trendingHandler('yearly', 'popular books'));

/**
 * OpenLibrary subjects matching a query, suggested while setting up a book
 * subject slider
 */
discoverBooksRoutes.get<never, BookSubjectSearchResponse>(
  '/subjects',
  async (req, res, next) => {
    const query = decodeSubjectQuery(req.query.query);

    if (!query) {
      return res.status(200).json({ results: [] });
    }

    try {
      const data = await new OpenLibrary().searchSubjects({
        query,
        limit: SUBJECT_SEARCH_LIMIT,
      });

      return res
        .status(200)
        .json({ results: toSubjectSuggestions(data.docs ?? []) });
    } catch (e) {
      logger.debug('Something went wrong searching book subjects', {
        label: 'API',
        errorMessage: e.message,
        query,
      });
      return next({
        status: 500,
        message: 'Unable to search book subjects.',
      });
    }
  }
);

/**
 * Books on an OpenLibrary subject such as fantasy or science_fiction, most
 * published first
 */
discoverBooksRoutes.get<{ subject: string }>(
  '/subject/:subject',
  async (req, res, next) => {
    if (!isBookSubjectSlug(req.params.subject)) {
      return next({ status: 404, message: 'Subject not found.' });
    }

    const openLibrary = new OpenLibrary();
    const page = Number(req.query.page) || 1;

    try {
      const data = await openLibrary.getSubject({
        subject: req.params.subject,
        page,
        limit: PAGE_SIZE,
      });
      const books = data.works.map((work) => mapSubjectWorkResult(work));

      return res.status(200).json({
        page,
        totalPages: Math.ceil(data.work_count / PAGE_SIZE),
        totalResults: data.work_count,
        results: await withMediaInfo(books),
      });
    } catch (e) {
      logger.debug('Something went wrong retrieving subject books', {
        label: 'API',
        errorMessage: e.message,
        subject: req.params.subject,
      });
      return next({
        status: 500,
        message: 'Unable to retrieve books for this subject.',
      });
    }
  }
);

export default discoverBooksRoutes;
