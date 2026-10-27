import TautulliAPI from '@server/api/tautulli';
import { MediaStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import Season from '@server/entity/Season';
import { User } from '@server/entity/User';
import type {
  MediaFilesResponse,
  MediaResultsResponse,
  MediaWatchDataResponse,
} from '@server/interfaces/api/mediaInterfaces';
import type {
  MediaSubtitlesResponse,
  SubtitleRequestBody,
} from '@server/interfaces/api/subtitleInterfaces';
import { getMediaFiles } from '@server/lib/mediaFiles';
import type {
  BookFormat,
  MediaLibrarySort,
  MusicAlbumType,
} from '@server/lib/mediaLibrary';
import {
  BOOK_FORMATS,
  MEDIA_LIBRARY_SORTS,
  MUSIC_ALBUM_TYPES,
  getBookFormatWhere,
  getLibraryMetadata,
  getMediaMetadata,
  matchesAlbumType,
  sortLibraryMedia,
} from '@server/lib/mediaLibrary';
import {
  NoRemovalServiceError,
  removeMediaFromService,
} from '@server/lib/mediaRemoval';
import { Permission } from '@server/lib/permissions';
import { getSettings } from '@server/lib/settings';
import {
  getMediaSubtitles,
  isBazarrConfigured,
  searchMediaSubtitles,
} from '@server/lib/subtitles';
import watchedSync, { WatchedError } from '@server/lib/watchedsync';
import logger from '@server/logger';
import { isAuthenticated } from '@server/middleware/auth';
import { Router } from 'express';
import type { FindOneOptions } from 'typeorm';
import { EntityNotFoundError, In, IsNull, Not } from 'typeorm';

const mediaRoutes = Router();

mediaRoutes.get('/', async (req, res, next) => {
  const mediaRepository = getRepository(Media);

  const pageSize = req.query.take ? Number(req.query.take) : 20;
  const skip = req.query.skip ? Number(req.query.skip) : 0;

  let statusFilter = undefined;

  switch (req.query.filter) {
    case 'available':
      statusFilter = MediaStatus.AVAILABLE;
      break;
    case 'partial':
      statusFilter = MediaStatus.PARTIALLY_AVAILABLE;
      break;
    case 'allavailable':
      statusFilter = In([
        MediaStatus.AVAILABLE,
        MediaStatus.PARTIALLY_AVAILABLE,
      ]);
      break;
    case 'processing':
      statusFilter = MediaStatus.PROCESSING;
      break;
    case 'pending':
      statusFilter = MediaStatus.PENDING;
      break;
  }

  let sortFilter: FindOneOptions<Media>['order'] = {
    id: 'DESC',
  };

  switch (req.query.sort) {
    case 'modified':
      sortFilter = {
        updatedAt: 'DESC',
      };
      break;
    case 'mediaAdded':
      sortFilter = {
        mediaAddedAt: 'DESC',
      };
  }

  // Narrows the list to one media type, as on a Discover page showing only
  // movies, series, music or books
  const mediaTypeFilter = Object.values(MediaType).includes(
    req.query.mediaType as MediaType
  )
    ? (req.query.mediaType as MediaType)
    : undefined;

  let whereClause: FindOneOptions<Media>['where'];
  if (statusFilter || mediaTypeFilter || req.query.sort === 'mediaAdded') {
    whereClause = {};
    if (statusFilter) whereClause.status = statusFilter;
    if (mediaTypeFilter) whereClause.mediaType = mediaTypeFilter;
    if (req.query.sort === 'mediaAdded')
      whereClause.mediaAddedAt = Not(IsNull());
  }

  // Books are available once either format is, or in the format picked
  const bookFormat =
    mediaTypeFilter === MediaType.BOOK &&
    BOOK_FORMATS.includes(req.query.format as BookFormat)
      ? (req.query.format as BookFormat)
      : undefined;
  let where: FindOneOptions<Media>['where'] = whereClause;

  if (
    mediaTypeFilter === MediaType.BOOK &&
    (req.query.filter === 'allavailable' || bookFormat) &&
    whereClause &&
    !Array.isArray(whereClause)
  ) {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { status, ...rest } = whereClause;
    where = getBookFormatWhere(bookFormat, rest);
  }

  // The music and books libraries sort and filter on what Lidarr and
  // Chaptarr know about each title, which the media table does not hold
  const isMusicOrBook =
    mediaTypeFilter === MediaType.MUSIC || mediaTypeFilter === MediaType.BOOK;
  const librarySort =
    isMusicOrBook &&
    MEDIA_LIBRARY_SORTS.includes(req.query.sort as MediaLibrarySort)
      ? (req.query.sort as MediaLibrarySort)
      : undefined;
  const albumType =
    mediaTypeFilter === MediaType.MUSIC &&
    MUSIC_ALBUM_TYPES.includes(req.query.albumType as MusicAlbumType)
      ? (req.query.albumType as MusicAlbumType)
      : undefined;
  const sortDirection =
    req.query.sortDirection === 'asc' || req.query.sortDirection === 'desc'
      ? req.query.sortDirection
      : librarySort === 'releaseDate'
        ? 'desc'
        : 'asc';

  try {
    let media: Media[];
    let mediaCount: number;

    if (isMusicOrBook && (librarySort || albumType)) {
      const index = await getLibraryMetadata(
        mediaTypeFilter as MediaType.MUSIC | MediaType.BOOK
      );
      let matching = await mediaRepository.find({
        select: { id: true, mbId: true, olId: true, foreignBookId: true },
        where,
        order: sortFilter,
      });

      if (albumType) {
        matching = matching.filter((item) =>
          matchesAlbumType(getMediaMetadata(item, index), albumType)
        );
      }

      if (librarySort) {
        matching = sortLibraryMedia(
          matching,
          index,
          librarySort,
          sortDirection
        );
      }

      const pageIds = matching
        .slice(skip, skip + pageSize)
        .map((item) => item.id);
      const rows = pageIds.length
        ? await mediaRepository.find({ where: { id: In(pageIds) } })
        : [];
      const rowsById = new Map(rows.map((row) => [row.id, row]));

      media = pageIds
        .map((id) => rowsById.get(id))
        .filter((row): row is Media => !!row);
      mediaCount = matching.length;
    } else {
      [media, mediaCount] = await mediaRepository.findAndCount({
        order: sortFilter,
        where,
        take: pageSize,
        skip,
      });
    }

    return res.status(200).json({
      pageInfo: {
        pages: Math.ceil(mediaCount / pageSize),
        pageSize,
        results: mediaCount,
        page: Math.ceil(skip / pageSize) + 1,
      },
      results: media,
    } as MediaResultsResponse);
  } catch (e) {
    next({ status: 500, message: e.message });
  }
});

mediaRoutes.post<
  {
    id: string;
    status: 'available' | 'partial' | 'processing' | 'pending' | 'unknown';
  },
  Media
>(
  '/:id/:status',
  isAuthenticated(Permission.MANAGE_REQUESTS),
  async (req, res, next) => {
    const mediaRepository = getRepository(Media);
    const seasonRepository = getRepository(Season);

    const media = await mediaRepository.findOne({
      where: { id: Number(req.params.id) },
    });

    if (!media) {
      return next({ status: 404, message: 'Media does not exist.' });
    }

    const is4k = String(req.body.is4k) === 'true';
    // Books keep their audiobook status in statusAudio
    const statusKey =
      media.mediaType === MediaType.BOOK &&
      String(req.body.isAudiobook) === 'true'
        ? 'statusAudio'
        : is4k
          ? 'status4k'
          : 'status';

    switch (req.params.status) {
      case 'available':
        media[statusKey] = MediaStatus.AVAILABLE;

        if (media.mediaType === MediaType.TV) {
          const expectedSeasons = req.body.seasons ?? [];

          for (const expectedSeason of expectedSeasons) {
            let season = media.seasons.find(
              (s) => s.seasonNumber === expectedSeason?.seasonNumber
            );

            if (!season) {
              // Create the season if it doesn't exist
              season = seasonRepository.create({
                seasonNumber: expectedSeason?.seasonNumber,
              });
              media.seasons.push(season);
            }

            season[is4k ? 'status4k' : 'status'] = MediaStatus.AVAILABLE;
          }
        }
        break;
      case 'partial':
        if (media.mediaType !== MediaType.TV) {
          return next({
            status: 400,
            message: 'Only series can be set to be partially available',
          });
        }
        media[is4k ? 'status4k' : 'status'] = MediaStatus.PARTIALLY_AVAILABLE;
        break;
      case 'processing':
        media[statusKey] = MediaStatus.PROCESSING;
        break;
      case 'pending':
        media[statusKey] = MediaStatus.PENDING;
        break;
      case 'unknown':
        media[statusKey] = MediaStatus.UNKNOWN;
    }

    await mediaRepository.save(media);

    return res.status(200).json(media);
  }
);

mediaRoutes.post<{ id: string }, unknown, { watched?: boolean }>(
  '/:id/watched',
  isAuthenticated(),
  async (req, res, next) => {
    try {
      const media = await getRepository(Media).findOne({
        where: { id: Number(req.params.id) },
      });

      if (!media || !req.user) {
        return next({ status: 404, message: 'Media not found' });
      }

      const state = await watchedSync.setWatched(
        req.user,
        media,
        req.body?.watched !== false
      );

      return res.status(200).json(state);
    } catch (e) {
      if (e instanceof WatchedError) {
        return next({ status: e.status, message: e.message });
      }

      logger.error('Something went wrong marking media watched', {
        label: 'Media',
        mediaId: req.params.id,
        errorMessage: e.message,
      });
      next({ status: 500, message: 'Failed to update watched state' });
    }
  }
);

mediaRoutes.delete(
  '/:id',
  isAuthenticated(Permission.MANAGE_REQUESTS),
  async (req, res, next) => {
    try {
      const mediaRepository = getRepository(Media);

      const media = await mediaRepository.findOneOrFail({
        where: { id: Number(req.params.id) },
      });

      if (media.status === MediaStatus.BLOCKLISTED) {
        media.resetServiceData();
        await mediaRepository.save(media);
      } else {
        await mediaRepository.remove(media);
      }

      return res.status(204).send();
    } catch (e) {
      if (e instanceof EntityNotFoundError) {
        return res.status(204).send();
      }
      logger.error('Something went wrong deleting media', {
        label: 'Media',
        mediaId: req.params.id,
        message: e.message,
      });
      next({ status: 500, message: 'Failed to delete media' });
    }
  }
);

mediaRoutes.delete(
  '/:id/file',
  isAuthenticated(Permission.MANAGE_REQUESTS),
  async (req, res, next) => {
    try {
      const mediaRepository = getRepository(Media);
      const media = await mediaRepository.findOneOrFail({
        where: { id: Number(req.params.id) },
      });

      const is4k = String(req.query.is4k) === 'true';

      try {
        await removeMediaFromService(media, is4k);
      } catch (e) {
        if (e instanceof NoRemovalServiceError) {
          return next({ status: 409, message: e.message });
        }
        throw e;
      }

      return res.status(204).send();
    } catch (e) {
      if (e instanceof EntityNotFoundError) {
        return next({ status: 404, message: 'Media not found' });
      }
      logger.error('Something went wrong deleting media file', {
        label: 'Media',
        mediaId: req.params.id,
        message: e.message,
      });
      next({ status: 500, message: 'Failed to delete media file' });
    }
  }
);

mediaRoutes.get<{ id: string }, MediaWatchDataResponse>(
  '/:id/watch_data',
  isAuthenticated(Permission.ADMIN),
  async (req, res, next) => {
    const settings = getSettings().tautulli;

    if (!settings.hostname || !settings.port || !settings.apiKey) {
      return next({
        status: 404,
        message: 'Tautulli API not configured.',
      });
    }

    const media = await getRepository(Media).findOne({
      where: { id: Number(req.params.id) },
    });

    if (!media) {
      return next({ status: 404, message: 'Media does not exist.' });
    }

    try {
      const tautulli = new TautulliAPI(settings);
      const userRepository = getRepository(User);

      const response: MediaWatchDataResponse = {};

      if (media.ratingKey) {
        const watchStats = await tautulli.getMediaWatchStats(media.ratingKey);
        const watchUsers = await tautulli.getMediaWatchUsers(media.ratingKey);
        const plexIds = watchUsers.map((u) => u.user_id);
        if (!plexIds.length) plexIds.push(-1);

        const users = await userRepository
          .createQueryBuilder('user')
          .where('user.plexId IN (:...plexIds)', { plexIds })
          .getMany();

        const playCount =
          watchStats.find((i) => i.query_days == 0)?.total_plays ?? 0;

        const playCount7Days =
          watchStats.find((i) => i.query_days == 7)?.total_plays ?? 0;

        const playCount30Days =
          watchStats.find((i) => i.query_days == 30)?.total_plays ?? 0;

        response.data = {
          users: users,
          playCount,
          playCount7Days,
          playCount30Days,
        };
      }

      if (media.ratingKey4k) {
        const watchStats4k = await tautulli.getMediaWatchStats(
          media.ratingKey4k
        );
        const watchUsers4k = await tautulli.getMediaWatchUsers(
          media.ratingKey4k
        );
        const plexIds4k = watchUsers4k.map((u) => u.user_id);
        if (!plexIds4k.length) plexIds4k.push(-1);

        const users = await userRepository
          .createQueryBuilder('user')
          .where('user.plexId IN (:...plexIds)', { plexIds: plexIds4k })
          .getMany();

        const playCount =
          watchStats4k.find((i) => i.query_days == 0)?.total_plays ?? 0;

        const playCount7Days =
          watchStats4k.find((i) => i.query_days == 7)?.total_plays ?? 0;

        const playCount30Days =
          watchStats4k.find((i) => i.query_days == 30)?.total_plays ?? 0;

        response.data4k = {
          users,
          playCount,
          playCount7Days,
          playCount30Days,
        };
      }

      return res.status(200).json(response);
    } catch (e) {
      logger.error('Something went wrong fetching media watch data', {
        label: 'API',
        errorMessage: e.message,
        mediaId: req.params.id,
      });
      next({ status: 500, message: 'Failed to fetch watch data.' });
    }
  }
);

mediaRoutes.get<{ id: string }, MediaFilesResponse>(
  '/:id/files',
  isAuthenticated(),
  async (req, res, next) => {
    const media = await getRepository(Media).findOne({
      where: { id: Number(req.params.id) },
    });

    if (!media) {
      return next({ status: 404, message: 'Media does not exist.' });
    }

    // Full paths reveal the server's folder layout, so only managers see them
    const includePath = !!req.user?.hasPermission(Permission.MANAGE_REQUESTS);

    try {
      const [files, files4k] = await Promise.all([
        getMediaFiles(media, false, includePath),
        getMediaFiles(media, true, includePath),
      ]);

      return res.status(200).json({ files, files4k });
    } catch (e) {
      logger.error('Something went wrong fetching media files', {
        label: 'API',
        errorMessage: e.message,
        mediaId: req.params.id,
      });
      next({ status: 500, message: 'Failed to fetch media files.' });
    }
  }
);

mediaRoutes.get<{ id: string }, MediaSubtitlesResponse>(
  '/:id/subtitles',
  isAuthenticated(),
  async (req, res, next) => {
    if (!isBazarrConfigured()) {
      return next({ status: 404, message: 'Bazarr API not configured.' });
    }

    const media = await getRepository(Media).findOne({
      where: { id: Number(req.params.id) },
    });

    if (!media) {
      return next({ status: 404, message: 'Media does not exist.' });
    }

    try {
      const subtitles = await getMediaSubtitles(media);

      if (!subtitles) {
        return next({
          status: 404,
          message: 'Media is not tracked by Bazarr.',
        });
      }

      return res.status(200).json(subtitles);
    } catch (e) {
      logger.error('Something went wrong fetching media subtitles', {
        label: 'API',
        errorMessage: e.message,
        mediaId: req.params.id,
      });
      next({ status: 500, message: 'Failed to fetch subtitles.' });
    }
  }
);

mediaRoutes.post<{ id: string }, Record<string, never>, SubtitleRequestBody>(
  '/:id/subtitles',
  isAuthenticated(Permission.REQUEST),
  async (req, res, next) => {
    if (!isBazarrConfigured()) {
      return next({ status: 404, message: 'Bazarr API not configured.' });
    }

    const media = await getRepository(Media).findOne({
      where: { id: Number(req.params.id) },
    });

    if (!media) {
      return next({ status: 404, message: 'Media does not exist.' });
    }

    const { language, forced, hi, seasonNumber, episodeNumber } = req.body;

    if (
      media.mediaType === MediaType.TV &&
      (seasonNumber === undefined || episodeNumber === undefined)
    ) {
      return next({
        status: 400,
        message: 'Season and episode numbers are required for series.',
      });
    }

    try {
      await searchMediaSubtitles(media, {
        language,
        forced,
        hi,
        seasonNumber,
        episodeNumber,
      });

      logger.info('Subtitle search requested', {
        label: 'Media',
        mediaId: media.id,
        language,
        userId: req.user?.id,
      });

      return res.status(204).send();
    } catch (e) {
      logger.error('Something went wrong requesting subtitles', {
        label: 'API',
        errorMessage: e.message,
        mediaId: req.params.id,
        language,
      });
      next({ status: 500, message: 'Failed to request subtitles.' });
    }
  }
);

export default mediaRoutes;
