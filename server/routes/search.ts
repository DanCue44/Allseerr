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

// How long the combined search waits for Talearr's comics lookup
const ALL_SEARCH_COMICS_BUDGET_MS = 8_000;
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

searchRoutes.get('/', async (req, res, next) => {
  const queryString = req.query.query as string;
  const page = Number(req.query.page) || 1;
  const searchType = (req.query.type as string | undefined) ?? 'all';
  const searchProvider = findSearchProvider(queryString.toLowerCase());
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

    // Comics join the first page when Talearr's comics library is on. The
    // lookup asks AniList and Hardcover, so a slow one is left out rather
    // than holding the page up.
    const comicSearch =
      !searchProvider && page === 1 && shown('comic')
        ? withTimeout(
            searchComicResults(queryString, {
              limit: ALL_SEARCH_COMICS_LIMIT,
            }),
            ALL_SEARCH_COMICS_BUDGET_MS
          ).catch(() => undefined)
        : Promise.resolve(undefined);

    // Music joins the first page when Lidarr can fulfil music requests, and
    // books when a book service can fulfil book requests. All three sources
    // are asked at once.
    const [musicResults, bookResults, comicResults] = await Promise.all([
      !searchProvider &&
      page === 1 &&
      shown('music') &&
      getSettings().lidarr.length > 0
        ? searchMusic({ query: queryString }).catch(() => undefined)
        : undefined,
      !searchProvider &&
      page === 1 &&
      shown('book') &&
      getSettings().bookService
        ? searchBooks({
            query: queryString,
            bookLimit: 10,
            authorLimit: 3,
          }).catch(() => undefined)
        : undefined,
      comicSearch,
    ]);

    return res.status(200).json({
      page: results.page,
      totalPages: results.total_pages,
      totalResults:
        results.total_results +
        (musicResults?.totalResults ?? 0) +
        (bookResults?.results.length ?? 0) +
        (comicResults?.length ?? 0),
      // Close title matches first across kinds, see rankCombinedResults
      results: rankCombinedResults(queryString, [
        ...mapSearchResults(results.results, media).filter((result) =>
          shown(result.mediaType)
        ),
        ...(musicResults?.results ?? []),
        ...(bookResults?.results ?? []),
        ...(comicResults ?? []),
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
