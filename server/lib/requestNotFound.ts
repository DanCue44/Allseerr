import ChaptarrAPI from '@server/api/servarr/chaptarr';
import LidarrAPI from '@server/api/servarr/lidarr';
import RadarrAPI from '@server/api/servarr/radarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import { usesChaptarr } from '@server/constants/bookService';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import type Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import {
  getRequestDownloadKey,
  getRequestStatusKey,
} from '@server/lib/bookRequests';
import { getMediaServiceSettings } from '@server/lib/mediaFiles';
import { Notification } from '@server/lib/notifications';
import type {
  RequestNotFoundMediaType,
  RequestNotFoundSettings,
} from '@server/lib/settings';
import {
  DEFAULT_REQUEST_NOT_FOUND,
  getDefaultChaptarr,
  getSettings,
  resolveBookService,
} from '@server/lib/settings';
import logger from '@server/logger';
import { IsNull } from 'typeorm';

/**
 * Request Not Found: an approved request that has found nothing for the
 * number of days set in Settings is marked not found, and the requester is
 * told why. The request stays approved, so it still completes when the
 * file turns up later, unless the admin also chose to stop the search.
 *
 * Anything in the arr's download queue counts as found. A download that is
 * stuck there is left to the Download Needs Attention alert, so the two
 * never fire for the same title.
 */

const LOG_LABEL = 'Request Not Found';
const DAY_MS = 24 * 60 * 60 * 1000;

const FOUND_STATUSES = [MediaStatus.AVAILABLE, MediaStatus.PARTIALLY_AVAILABLE];

/**
 * The settings, with the defaults filled in for anything missing
 */
export const getRequestNotFoundSettings = (): RequestNotFoundSettings => {
  const saved = getSettings().main.requestNotFound;

  return {
    ...DEFAULT_REQUEST_NOT_FOUND,
    ...saved,
    days: { ...DEFAULT_REQUEST_NOT_FOUND.days, ...saved?.days },
  };
};

/**
 * Days a request of the media type may find nothing, or 0 when the media
 * type is left out
 */
export const getNotFoundDays = (
  config: RequestNotFoundSettings,
  type: MediaType
): number => {
  const days = Number(config.days[type as RequestNotFoundMediaType]);

  return Number.isFinite(days) && days > 0 ? Math.floor(days) : 0;
};

/**
 * Whether anything turned up for the request: its version of the title is
 * there (in part), something is downloading for it, or for a series one of
 * the requested seasons is in
 */
export const hasFoundSomething = (
  request: MediaRequest,
  media: Media
): boolean => {
  if (FOUND_STATUSES.includes(media[getRequestStatusKey(request)])) {
    return true;
  }

  // Stuck downloads are in the queue too, and have their own alert
  if ((media[getRequestDownloadKey(request)] ?? []).length > 0) {
    return true;
  }

  if (request.type === MediaType.TV) {
    const requested = (request.seasons ?? []).map(
      (season) => season.seasonNumber
    );
    const statusKey = request.is4k ? 'status4k' : 'status';

    return (media.seasons ?? []).some(
      (season) =>
        requested.includes(season.seasonNumber) &&
        FOUND_STATUSES.includes(season[statusKey])
    );
  }

  return false;
};

/**
 * Whether the request has waited the given days since it was approved or
 * last changed
 */
export const hasWaited = (
  request: Pick<MediaRequest, 'createdAt' | 'updatedAt'>,
  days: number,
  now: number
): boolean => {
  const since = new Date(request.updatedAt ?? request.createdAt).getTime();

  return days > 0 && Number.isFinite(since) && now - since >= days * DAY_MS;
};

export const buildNotFoundReason = (days: number, stopped: boolean): string =>
  stopped
    ? `Nothing was found in ${days} ${days === 1 ? 'day' : 'days'}, so the search was stopped.`
    : `Nothing was found in ${days} ${days === 1 ? 'day' : 'days'}. It is still being looked for.`;

/**
 * The approved requests that have found nothing for too long
 */
export const findNotFoundRequests = async (
  config: RequestNotFoundSettings,
  now = Date.now()
): Promise<MediaRequest[]> => {
  const requests = await getRepository(MediaRequest).find({
    where: { status: MediaRequestStatus.APPROVED, notFoundAt: IsNull() },
    relations: {
      media: { seasons: true },
      requestedBy: true,
      seasons: true,
    },
  });

  return requests.filter((request) => {
    const days = getNotFoundDays(config, request.type);

    return (
      days > 0 &&
      !!request.media &&
      hasWaited(request, days, now) &&
      !hasFoundSomething(request, request.media)
    );
  });
};

/**
 * Tells the arr (or Talearr) to stop searching for the request. Returns
 * whether it did. Only items the app already knows the arr id of are
 * changed; comics and LazyLibrarian books are left as they are.
 */
export const stopSearching = async (
  request: MediaRequest
): Promise<boolean> => {
  const media = request.media;
  const settings = getSettings();

  try {
    switch (request.type) {
      case MediaType.MOVIE: {
        const server = getMediaServiceSettings(media, request.is4k);
        const movieId = request.is4k
          ? media.externalServiceId4k
          : media.externalServiceId;

        if (!server || !movieId) {
          return false;
        }

        await new RadarrAPI({
          apiKey: server.apiKey,
          url: RadarrAPI.buildUrl(server, '/api/v3'),
        }).setMoviesMonitored([movieId], false);
        return true;
      }
      case MediaType.TV: {
        const server = getMediaServiceSettings(media, request.is4k);
        const seriesId = request.is4k
          ? media.externalServiceId4k
          : media.externalServiceId;
        const seasons = (request.seasons ?? []).map(
          (season) => season.seasonNumber
        );

        if (!server || !seriesId || seasons.length === 0) {
          return false;
        }

        await new SonarrAPI({
          apiKey: server.apiKey,
          url: SonarrAPI.buildUrl(server, '/api/v3'),
        }).updateSeasonMonitoring(seriesId, { unmonitor: seasons });
        return true;
      }
      case MediaType.MUSIC: {
        const server =
          settings.lidarr.find((lidarr) => lidarr.id === media.serviceId) ??
          settings.lidarr.find((lidarr) => lidarr.isDefault);

        if (!server || !media.externalServiceId) {
          return false;
        }

        await new LidarrAPI({
          apiKey: server.apiKey,
          url: LidarrAPI.buildUrl(server, '/api/v1'),
        }).setAlbumsMonitored([media.externalServiceId], false);
        return true;
      }
      case MediaType.BOOK: {
        if (!usesChaptarr(resolveBookService(settings))) {
          return false;
        }

        const server =
          settings.chaptarr.find(
            (chaptarr) => chaptarr.id === media.serviceId
          ) ?? getDefaultChaptarr(settings.chaptarr);
        const bookId = request.isAudiobook
          ? media.externalServiceIdAudio
          : media.externalServiceId;

        if (!server || !bookId) {
          return false;
        }

        await new ChaptarrAPI({
          apiKey: server.apiKey,
          url: ChaptarrAPI.buildUrl(server, '/api/v1'),
        }).setBooksMonitored([bookId], false);
        return true;
      }
      default:
        return false;
    }
  } catch (e) {
    logger.warn('Could not stop the search for a request not found', {
      label: LOG_LABEL,
      requestId: request.id,
      errorMessage: e.message,
    });
    return false;
  }
};

/**
 * Marks the request not found, stops the search when asked to, and tells
 * the requester why
 */
export const markRequestNotFound = async (
  request: MediaRequest,
  config: RequestNotFoundSettings,
  now = Date.now()
): Promise<void> => {
  const days = getNotFoundDays(config, request.type);
  const stopped = config.unmonitor ? await stopSearching(request) : false;
  const reason = buildNotFoundReason(days, stopped);

  // Without listeners: saving the request would send it to the arr again
  await getRepository(MediaRequest)
    .createQueryBuilder()
    .update(MediaRequest)
    .set({ notFoundAt: new Date(now), notFoundReason: reason })
    .where('id = :id', { id: request.id })
    .callListeners(false)
    .execute();

  request.notFoundAt = new Date(now);
  request.notFoundReason = reason;

  logger.info('Marked a request not found', {
    label: LOG_LABEL,
    requestId: request.id,
    mediaId: request.media.id,
    days,
    stopped,
  });

  await MediaRequest.sendNotification(
    request,
    request.media,
    Notification.MEDIA_NOT_FOUND
  );
};

class RequestNotFoundJob {
  public running = false;

  public async run(now = Date.now()): Promise<number> {
    const config = getRequestNotFoundSettings();

    if (!config.enabled || this.running) {
      return 0;
    }

    this.running = true;
    let marked = 0;

    try {
      const requests = await findNotFoundRequests(config, now);

      for (const request of requests) {
        try {
          await markRequestNotFound(request, config, now);
          marked += 1;
        } catch (e) {
          logger.error('Could not mark a request not found', {
            label: LOG_LABEL,
            requestId: request.id,
            errorMessage: e.message,
          });
        }
      }

      if (marked > 0) {
        logger.info(`Marked ${marked} request(s) not found`, {
          label: LOG_LABEL,
        });
      }
    } finally {
      this.running = false;
    }

    return marked;
  }
}

export const requestNotFoundJob = new RequestNotFoundJob();

export default requestNotFoundJob;
