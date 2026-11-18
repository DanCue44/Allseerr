import MusicBrainz from '@server/api/musicbrainz';
import TheAudioDb from '@server/api/theaudiodb';
import TheMovieDb from '@server/api/themoviedb';
import type { TmdbSearchMultiResponse } from '@server/api/themoviedb/interfaces';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import MetadataAlbum from '@server/entity/MetadataAlbum';
import { searchBooks } from '@server/lib/bookSearch';
import {
  getComicsStatus,
  mapComicResults,
  searchComics,
} from '@server/lib/comics';
import {
  getHiddenMediaTypes,
  isResultShown,
} from '@server/lib/hiddenMediaTypes';
import { rankMusicResult } from '@server/lib/musicSearchRank';
import { findSearchProvider } from '@server/lib/search';
import { rankCombinedResults } from '@server/lib/searchRank';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { mapAlbumResult, mapArtistResult } from '@server/models/Music';
import type {
  AlbumResult,
  ArtistResult,
  AuthorResult,
  BookResult,
  ComicResult,
} from '@server/models/Search';
import { mapSearchResults } from '@server/models/Search';
import { Router } from 'express';
import { In } from 'typeorm';

const searchRoutes = Router();

const MUSIC_PAGE_SIZE = 20;

/**
 * Searches MusicBrainz for albums and artists, best matches first
 */
export const searchMusic = async ({
  query,
  page = 1,
}: {
  query: string;
  page?: number;
}): Promise<{
  results: (AlbumResult | ArtistResult)[];
  totalResults: number;
}> => {
  const musicbrainz = new MusicBrainz();
  const theAudioDb = new TheAudioDb();
  const offset = (page - 1) * MUSIC_PAGE_SIZE;

  const [albums, artists] = await Promise.all([
    musicbrainz
      .searchAlbum({ query, limit: MUSIC_PAGE_SIZE, offset })
      .catch(() => []),
    musicbrainz
      .searchArtist({ query, limit: MUSIC_PAGE_SIZE, offset })
      .catch(() => []),
  ]);

  const albumIds = albums.map((album) => album.id);

  const [media, albumMetadata, artistImages] = await Promise.all([
    Media.getRelatedMusic(albumIds),
    albumIds.length > 0
      ? getRepository(MetadataAlbum).find({
          where: { mbAlbumId: In(albumIds) },
          select: ['mbAlbumId', 'caaUrl'],
        })
      : [],
    theAudioDb
      .batchGetArtistImages(artists.map((artist) => artist.id))
      .catch(
        () => ({}) as Awaited<ReturnType<TheAudioDb['batchGetArtistImages']>>
      ),
  ]);

  const mediaMap = new Map(media.map((m) => [m.mbId, m]));
  const coverMap = new Map(
    albumMetadata.map((metadata) => [metadata.mbAlbumId, metadata.caaUrl])
  );

  const results = [
    ...albums.map((album) =>
      mapAlbumResult(album, mediaMap.get(album.id), coverMap.get(album.id))
    ),
    ...artists.map((artist) =>
      mapArtistResult(artist, artistImages[artist.id])
    ),
  ].sort((a, b) => rankMusicResult(query, b) - rankMusicResult(query, a));

  return {
    results,
    totalResults: results.length,
  };
};

// How long the combined search waits for each of music, books and comics. A
// source slower than this is left out of that answer rather than holding the
// page up; its lookup carries on and is cached, so the next search has it.
const ALL_SEARCH_SOURCE_BUDGET_MS = 5_000;
// Comics shown in the combined search, best matches first
const ALL_SEARCH_COMICS_LIMIT = 10;

const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });

/**
 * Comic and manga series for a search, empty while comics are off
 */
export const searchComicResults = async (
  query: string,
  { limit }: { limit?: number } = {}
): Promise<ComicResult[]> => {
  if (!(await getComicsStatus()).enabled) {
    return [];
  }

  const { results } = await searchComics({ query });

  return mapComicResults(limit ? results.slice(0, limit) : results);
};

type ExtraResult = AlbumResult | ArtistResult | BookResult | AuthorResult;

/**
 * Music, books and comics for the first page of the combined search, each
 * asked at once and each within ALL_SEARCH_SOURCE_BUDGET_MS. Music joins when
 * Lidarr can fulfil music requests, books when a book service can fulfil book
 * requests and comics while Talearr's comics library is on.
 */
const searchExtras = async (
  query: string,
  shown: (mediaType: string) => boolean
): Promise<{
  results: (ExtraResult | ComicResult)[];
  totalResults: number;
}> => {
  const settings = getSettings();
  const budget = <T>(promise: Promise<T>): Promise<T | undefined> =>
    withTimeout(promise, ALL_SEARCH_SOURCE_BUDGET_MS).catch(() => undefined);

  const [musicResults, bookResults, comicResults] = await Promise.all([
    shown('music') && settings.lidarr.length > 0
      ? budget(searchMusic({ query }))
      : undefined,
    shown('book') && settings.bookService
      ? budget(searchBooks({ query, bookLimit: 10, authorLimit: 3 }))
      : undefined,
    shown('comic')
      ? budget(searchComicResults(query, { limit: ALL_SEARCH_COMICS_LIMIT }))
      : undefined,
  ]);

  return {
    results: [
      ...(musicResults?.results ?? []),
      ...(bookResults?.results ?? []),
      ...(comicResults ?? []),
    ],
    totalResults:
      (musicResults?.totalResults ?? 0) +
      (bookResults?.results.length ?? 0) +
      (comicResults?.length ?? 0),
  };
};

searchRoutes.get('/', async (req, res, next) => {
  const queryString = req.query.query as string;
  const page = Number(req.query.page) || 1;
  const searchType = (req.query.type as string | undefined) ?? 'all';
  const searchProvider = findSearchProvider(queryString.toLowerCase());
  // The combined search can be asked in two parts so a page can show movies,
  // series and people at once and add music, books and comics when they
  // arrive: "media" is TMDB alone and "extras" the other sources alone.
  // Without it both come in one answer.
  const sources = req.query.sources as string | undefined;
  let results: TmdbSearchMultiResponse;
  // Media types the user cannot request, while the admin hides them
  const hidden = getHiddenMediaTypes(
    req.user?.permissions ?? 0,
    getSettings().main.hideUnrequestable ?? false
  );
  const shown = (mediaType: string) => isResultShown(mediaType, hidden);

  try {
    if (
      (searchType === 'music' && !shown('music')) ||
      ((searchType === 'book' || searchType === 'comic') && !shown('book'))
    ) {
      return res
        .status(200)
        .json({ page: 1, totalPages: 1, totalResults: 0, results: [] });
    }

    if (searchType === 'music') {
      const musicResults = await searchMusic({ query: queryString });

      // MusicBrainz scores fall off quickly past the best matches, so music
      // is a single page
      return res.status(200).json({
        page: 1,
        totalPages: 1,
        totalResults: musicResults.totalResults,
        results: musicResults.results,
      });
    }

    if (searchType === 'book') {
      const bookResults = await searchBooks({ query: queryString, page });

      return res.status(200).json({
        page,
        totalPages: bookResults.totalPages,
        totalResults: bookResults.totalResults,
        results: bookResults.results,
      });
    }

    if (searchType === 'comic') {
      const comicResults = await searchComicResults(queryString);

      // Talearr's lookup answers the best matches at once, so comics are a
      // single page
      return res.status(200).json({
        page: 1,
        totalPages: 1,
        totalResults: comicResults.length,
        results: comicResults,
      });
    }

    const wantsExtras = !searchProvider && page === 1 && sources !== 'media';

    if (sources === 'extras') {
      const extras = wantsExtras
        ? await searchExtras(queryString, shown)
        : { results: [], totalResults: 0 };

      return res.status(200).json({
        page: 1,
        totalPages: 1,
        totalResults: extras.totalResults,
        results: rankCombinedResults(queryString, extras.results),
      });
    }

    // Started before TMDB is asked, so the slower sources run alongside it
    const noExtras = { results: [], totalResults: 0 };
    const extrasSearch = wantsExtras
      ? searchExtras(queryString, shown).catch(() => noExtras)
      : Promise.resolve(noExtras);

    if (!shown('movie') && !shown('tv')) {
      // Neither movies nor series, so TMDB has nothing to offer
      results = { page: 1, total_pages: 1, total_results: 0, results: [] };
    } else if (searchProvider) {
      const [id] = queryString
        .toLowerCase()
        .match(searchProvider.pattern) as RegExpMatchArray;
      results = await searchProvider.search({
        id,
        language: (req.query.language as string) ?? req.locale,
        query: queryString,
      });
    } else {
      const tmdb = new TheMovieDb();

      results = await tmdb.searchMulti({
        query: queryString,
        page: Number(req.query.page),
        language: (req.query.language as string) ?? req.locale,
      });
    }

    const media = await Media.getRelatedMedia(
      req.user,
      results.results.map((result) => ({
        tmdbId: result.id,
        mediaType: result.media_type,
      }))
    );

    const extras = await extrasSearch;

    return res.status(200).json({
      page: results.page,
      totalPages: results.total_pages,
      totalResults: results.total_results + extras.totalResults,
      // Close title matches first across kinds, see rankCombinedResults
      results: rankCombinedResults(queryString, [
        ...mapSearchResults(results.results, media).filter((result) =>
          shown(result.mediaType)
        ),
        ...extras.results,
      ]),
    });
  } catch (e) {
    logger.debug('Something went wrong retrieving search results', {
      label: 'API',
      errorMessage: e.message,
      query: req.query.query,
    });
    return next({
      status: 500,
      message: 'Unable to retrieve search results.',
    });
  }
});

searchRoutes.get('/keyword', async (req, res, next) => {
  const tmdb = new TheMovieDb();

  try {
    const results = await tmdb.searchKeyword({
      query: req.query.query as string,
      page: Number(req.query.page),
    });

    return res.status(200).json(results);
  } catch (e) {
    logger.debug('Something went wrong retrieving keyword search results', {
      label: 'API',
      errorMessage: e.message,
      query: req.query.query,
    });
    return next({
      status: 500,
      message: 'Unable to retrieve keyword search results.',
    });
  }
});

searchRoutes.get('/company', async (req, res, next) => {
  const tmdb = new TheMovieDb();

  try {
    const results = await tmdb.searchCompany({
      query: req.query.query as string,
      page: Number(req.query.page),
    });

    return res.status(200).json(results);
  } catch (e) {
    logger.debug('Something went wrong retrieving company search results', {
      label: 'API',
      errorMessage: e.message,
      query: req.query.query,
    });
    return next({
      status: 500,
      message: 'Unable to retrieve company search results.',
    });
  }
});

export default searchRoutes;
