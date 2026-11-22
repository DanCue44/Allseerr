import LidarrAPI from '@server/api/servarr/lidarr';
import RadarrAPI from '@server/api/servarr/radarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import TheMovieDb from '@server/api/themoviedb';
import { isBookLanguage } from '@server/constants/bookLanguages';
import {
  MediaRequestMonitorMode,
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import {
  BlocklistedMediaError,
  ContentRatingRestrictedError,
  DuplicateMediaRequestError,
  InvalidAudiobookVersionError,
  InvalidBookLanguageError,
  InvalidComicRequestError,
  InvalidRecordingRequestError,
  MediaRequest,
  NoSeasonsAvailableError,
  QuotaRestrictedError,
  RequestPermissionError,
  WatchProviderBlockedError,
} from '@server/entity/MediaRequest';
import SeasonRequest from '@server/entity/SeasonRequest';
import { User } from '@server/entity/User';
import type {
  AuthorCatalogRequestBody,
  BulkRequestResponse,
  DiscographyRequestBody,
  MediaRequestBody,
  RequestInterestResponse,
  RequestResultsResponse,
} from '@server/interfaces/api/requestInterfaces';
import {
  BulkRequestError,
  requestAuthorCatalog,
  requestDiscography,
} from '@server/lib/bulkRequests';
import type { RequestedSeason } from '@server/lib/episodeRequests';
import {
  buildRequestedSeasons,
  filterRequestableSeasons,
  getCurrentSeasonNumber,
  getFutureSeasonNumbers,
  getTmdbSeasonInfo,
} from '@server/lib/episodeRequests';
import { Permission } from '@server/lib/permissions';
import {
  INTEREST_STATUSES,
  InterestError,
  addInterest,
  getInterestSummaries,
  isInterested,
  removeInterest,
} from '@server/lib/requestInterest';
import { getAvailableSeasonNumbers } from '@server/lib/seasonRollover';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { isAuthenticated } from '@server/middleware/auth';
import requestLock, {
  mediaKey,
  mediaLock,
  requestKey,
  userKey,
} from '@server/utils/requestLock';
import { Router } from 'express';
import { In } from 'typeorm';

// Requests the user asked to be told about ("Notify me too"), for :id
const INTERESTED_REQUESTS_SQL =
  'request.id IN (SELECT "requestId" FROM "media_request_interest" WHERE "userId" = :id)';

const requestRoutes = Router();

requestRoutes.get<Record<string, unknown>, RequestResultsResponse>(
  '/',
  async (req, res, next) => {
    try {
      const pageSize = req.query.take ? Number(req.query.take) : 10;
      const skip = req.query.skip ? Number(req.query.skip) : 0;
      const requestedBy = req.query.requestedBy
        ? Number(req.query.requestedBy)
        : null;
      const mediaType = (req.query.mediaType as MediaType | 'all') || 'all';

      let statusFilter: MediaRequestStatus[];

      switch (req.query.filter) {
        case 'approved':
        case 'processing':
          statusFilter = [MediaRequestStatus.APPROVED];
          break;
        case 'pending':
          statusFilter = [MediaRequestStatus.PENDING];
          break;
        case 'unavailable':
          statusFilter = [
            MediaRequestStatus.PENDING,
            MediaRequestStatus.APPROVED,
          ];
          break;
        case 'failed':
          statusFilter = [MediaRequestStatus.FAILED];
          break;
        case 'completed':
        case 'available':
        case 'deleted':
          statusFilter = [MediaRequestStatus.COMPLETED];
          break;
        default:
          statusFilter = [
            MediaRequestStatus.PENDING,
            MediaRequestStatus.APPROVED,
            MediaRequestStatus.DECLINED,
            MediaRequestStatus.FAILED,
            MediaRequestStatus.COMPLETED,
          ];
      }

      let mediaStatusFilter: MediaStatus[];

      switch (req.query.filter) {
        case 'available':
          mediaStatusFilter = [MediaStatus.AVAILABLE];
          break;
        case 'processing':
        case 'unavailable':
          mediaStatusFilter = [
            MediaStatus.UNKNOWN,
            MediaStatus.PENDING,
            MediaStatus.PROCESSING,
            MediaStatus.PARTIALLY_AVAILABLE,
          ];
          break;
        case 'deleted':
          mediaStatusFilter = [MediaStatus.DELETED];
          break;
        default:
          mediaStatusFilter = [
            MediaStatus.UNKNOWN,
            MediaStatus.PENDING,
            MediaStatus.PROCESSING,
            MediaStatus.PARTIALLY_AVAILABLE,
            MediaStatus.AVAILABLE,
            MediaStatus.DELETED,
          ];
      }

      let sortFilter: string;
      let sortDirection: 'ASC' | 'DESC';

      switch (req.query.sort) {
        case 'modified':
          sortFilter = 'request.updatedAt';
          break;
        case 'added':
          sortFilter = 'request.createdAt';
          break;
        default:
          sortFilter = 'request.id';
      }

      switch (req.query.sortDirection) {
        case 'asc':
          sortDirection = 'ASC';
          break;
        default:
          sortDirection = 'DESC';
      }

      let query = getRepository(MediaRequest)
        .createQueryBuilder('request')
        .leftJoinAndSelect('request.media', 'media')
        .leftJoinAndSelect('request.seasons', 'seasons')
        .leftJoinAndSelect('request.modifiedBy', 'modifiedBy')
        .leftJoinAndSelect('request.requestedBy', 'requestedBy')
        .where('request.status IN (:...requestStatus)', {
          requestStatus: statusFilter,
        })
        .andWhere(
          '((request.is4k = false AND media.status IN (:...mediaStatus)) OR (request.is4k = true AND media.status4k IN (:...mediaStatus)))',
          {
            mediaStatus: mediaStatusFilter,
          }
        );

      if (
        !req.user?.hasPermission(
          [Permission.MANAGE_REQUESTS, Permission.REQUEST_VIEW],
          { type: 'or' }
        )
      ) {
        if (requestedBy && requestedBy !== req.user?.id) {
          return next({
            status: 403,
            message: "You do not have permission to view this user's requests.",
          });
        }

        // Their own requests, and the ones they asked to be told about
        query = query.andWhere(
          `(requestedBy.id = :id OR ${INTERESTED_REQUESTS_SQL})`,
          { id: req.user?.id }
        );
      } else if (requestedBy && requestedBy === req.user?.id) {
        query = query.andWhere(
          `(requestedBy.id = :id OR ${INTERESTED_REQUESTS_SQL})`,
          { id: requestedBy }
        );
      } else if (requestedBy) {
        query = query.andWhere('requestedBy.id = :id', {
          id: requestedBy,
        });
      }

      switch (mediaType) {
        case 'all':
          break;
        case 'movie':
          query = query.andWhere('request.type = :type', {
            type: MediaType.MOVIE,
          });
          break;
        case 'tv':
          query = query.andWhere('request.type = :type', {
            type: MediaType.TV,
          });
          break;
        case 'music':
          query = query.andWhere('request.type = :type', {
            type: MediaType.MUSIC,
          });
          break;
        case 'book':
          query = query.andWhere('request.type = :type', {
            type: MediaType.BOOK,
          });
          break;
        case 'comic':
          query = query.andWhere('request.type = :type', {
            type: MediaType.COMIC,
          });
          break;
      }

      const [requests, requestCount] = await query
        .orderBy(sortFilter, sortDirection)
        .addOrderBy('request.id', sortDirection)
        .take(pageSize)
        .skip(skip)
        .getManyAndCount();

      const settings = getSettings();

      // get all quality profiles for every configured sonarr server
      const sonarrServers = await Promise.all(
        settings.sonarr.map(async (sonarrSetting) => {
          const sonarr = new SonarrAPI({
            apiKey: sonarrSetting.apiKey,
            url: SonarrAPI.buildUrl(sonarrSetting, '/api/v3'),
          });

          return {
            id: sonarrSetting.id,
            profiles: await sonarr.getProfiles().catch(() => undefined),
          };
        })
      );

      // get all quality profiles for every configured radarr server
      const radarrServers = await Promise.all(
        settings.radarr.map(async (radarrSetting) => {
          const radarr = new RadarrAPI({
            apiKey: radarrSetting.apiKey,
            url: RadarrAPI.buildUrl(radarrSetting, '/api/v3'),
          });

          return {
            id: radarrSetting.id,
            profiles: await radarr.getProfiles().catch(() => undefined),
          };
        })
      );

      // get all quality profiles for every configured lidarr server
      const lidarrServers = await Promise.all(
        settings.lidarr.map(async (lidarrSetting) => {
          const lidarr = new LidarrAPI({
            apiKey: lidarrSetting.apiKey,
            url: LidarrAPI.buildUrl(lidarrSetting, '/api/v1'),
          });

          return {
            id: lidarrSetting.id,
            profiles: await lidarr.getProfiles().catch(() => undefined),
          };
        })
      );

      // add profile names to the media requests, with undefined if not found
      let mappedRequests = requests.map((r) => {
        switch (r.type) {
          case MediaType.MOVIE: {
            const profileName = radarrServers
              .find((serverr) => serverr.id === r.serverId)
              ?.profiles?.find((profile) => profile.id === r.profileId)?.name;

            return {
              ...r,
              profileName,
            };
          }
          case MediaType.TV: {
            return {
              ...r,
              profileName: sonarrServers
                .find((serverr) => serverr.id === r.serverId)
                ?.profiles?.find((profile) => profile.id === r.profileId)?.name,
            };
          }
          case MediaType.MUSIC: {
            return {
              ...r,
              profileName: lidarrServers
                .find((serverr) => serverr.id === r.serverId)
                ?.profiles?.find((profile) => profile.id === r.profileId)?.name,
            };
          }
          case MediaType.BOOK:
          case MediaType.COMIC: {
            // LazyLibrarian has no quality profiles, and comics are filed
            // by Talearr's own comics settings
            return { ...r, profileName: undefined };
          }
        }
      });

      // add canRemove prop if user has permission
      if (req.user?.hasPermission(Permission.MANAGE_REQUESTS)) {
        mappedRequests = mappedRequests.map((r) => {
          switch (r.type) {
            case MediaType.MOVIE: {
              return {
                ...r,
                // check if the radarr server for this request is configured
                canRemove: radarrServers.some(
                  (server) =>
                    server.id ===
                    (r.is4k ? r.media.serviceId4k : r.media.serviceId)
                ),
              };
            }
            case MediaType.TV: {
              return {
                ...r,
                // check if the sonarr server for this request is configured
                canRemove: sonarrServers.some(
                  (server) =>
                    server.id ===
                    (r.is4k ? r.media.serviceId4k : r.media.serviceId)
                ),
              };
            }
            case MediaType.MUSIC: {
              return {
                ...r,
                // check if the lidarr server for this request is configured
                canRemove: lidarrServers.some(
                  (server) => server.id === r.media.serviceId
                ),
              };
            }
            case MediaType.BOOK:
            case MediaType.COMIC: {
              // Books are not removed from LazyLibrarian, nor comics from
              // Talearr
              return { ...r, canRemove: false };
            }
          }
        });
      }

      const interests = await getInterestSummaries(
        mappedRequests.map((r) => r.id),
        req.user
      );
      mappedRequests = mappedRequests.map((r) => {
        const summary = interests.get(r.id);

        return summary
          ? {
              ...r,
              interest: {
                count: summary.count,
                interested: summary.interested,
              },
            }
          : r;
      });

      return res.status(200).json({
        pageInfo: {
          pages: Math.ceil(requestCount / pageSize),
          pageSize,
          results: requestCount,
          page: Math.ceil(skip / pageSize) + 1,
        },
        results: mappedRequests,
        serviceErrors: {
          radarr: radarrServers
            .filter((s) => !s.profiles)
            .map((s) => ({
              id: s.id,
              name:
                settings.radarr.find((r) => r.id === s.id)?.name ||
                `Radarr ${s.id}`,
            })),
          sonarr: sonarrServers
            .filter((s) => !s.profiles)
            .map((s) => ({
              id: s.id,
              name:
                settings.sonarr.find((r) => r.id === s.id)?.name ||
                `Sonarr ${s.id}`,
            })),
          lidarr: lidarrServers
            .filter((s) => !s.profiles)
            .map((s) => ({
              id: s.id,
              name:
                settings.lidarr.find((r) => r.id === s.id)?.name ||
                `Lidarr ${s.id}`,
            })),
        },
      });
    } catch (e) {
      next({ status: 500, message: e.message });
    }
  }
);

requestRoutes.post<never, MediaRequest, MediaRequestBody>(
  '/',
  async (req, res, next) => {
    try {
      if (!req.user) {
        return next({
          status: 401,
          message: 'You must be logged in to request media.',
        });
      }
      const request = await MediaRequest.request(req.body, req.user);

      return res.status(201).json(request);
    } catch (error) {
      if (!(error instanceof Error)) {
        return;
      }

      switch (error.constructor) {
        case RequestPermissionError:
        case QuotaRestrictedError:
          return next({ status: 403, message: error.message });
        case DuplicateMediaRequestError:
          return next({ status: 409, message: error.message });
        case InvalidAudiobookVersionError:
        case InvalidBookLanguageError:
        case InvalidComicRequestError:
        case InvalidRecordingRequestError:
          return next({ status: 400, message: error.message });
        case NoSeasonsAvailableError:
          return next({ status: 202, message: error.message });
        case BlocklistedMediaError:
        case WatchProviderBlockedError:
        case ContentRatingRestrictedError:
          return next({ status: 403, message: error.message });
        default:
          return next({ status: 500, message: error.message });
      }
    }
  }
);

const handleBulkRequestError = (
  error: unknown,
  next: (err: { status: number; message: string }) => void
) => {
  if (error instanceof BulkRequestError) {
    return next({ status: error.status, message: error.message });
  }

  if (
    error instanceof RequestPermissionError ||
    error instanceof QuotaRestrictedError
  ) {
    return next({ status: 403, message: error.message });
  }

  return next({
    status: 500,
    message: error instanceof Error ? error.message : String(error),
  });
};

/**
 * Requests albums of an artist's discography, one request per album
 */
requestRoutes.post<never, BulkRequestResponse, DiscographyRequestBody>(
  '/discography',
  async (req, res, next) => {
    if (!req.user) {
      return next({
        status: 401,
        message: 'You must be logged in to request media.',
      });
    }

    try {
      const result = await requestDiscography(req.user, req.body);

      return res.status(result.created.length > 0 ? 201 : 200).json(result);
    } catch (error) {
      return handleBulkRequestError(error, next);
    }
  }
);

/**
 * Requests works of an author, one request per work and format
 */
requestRoutes.post<never, BulkRequestResponse, AuthorCatalogRequestBody>(
  '/author-catalog',
  async (req, res, next) => {
    if (!req.user) {
      return next({
        status: 401,
        message: 'You must be logged in to request media.',
      });
    }

    try {
      const result = await requestAuthorCatalog(req.user, req.body);

      return res.status(result.created.length > 0 ? 201 : 200).json(result);
    } catch (error) {
      return handleBulkRequestError(error, next);
    }
  }
);

requestRoutes.get('/count', async (_req, res, next) => {
  const requestRepository = getRepository(MediaRequest);

  try {
    const query = requestRepository
      .createQueryBuilder('request')
      .innerJoinAndSelect('request.media', 'media');

    const totalCount = await query.getCount();

    const movieCount = await query
      .where('request.type = :requestType', {
        requestType: MediaType.MOVIE,
      })
      .getCount();

    const tvCount = await query
      .where('request.type = :requestType', {
        requestType: MediaType.TV,
      })
      .getCount();

    const musicCount = await query
      .where('request.type = :requestType', {
        requestType: MediaType.MUSIC,
      })
      .getCount();

    const bookCount = await query
      .where('request.type = :requestType', {
        requestType: MediaType.BOOK,
      })
      .getCount();

    const pendingCount = await query
      .where('request.status = :requestStatus', {
        requestStatus: MediaRequestStatus.PENDING,
      })
      .getCount();

    const approvedCount = await query
      .where('request.status = :requestStatus', {
        requestStatus: MediaRequestStatus.APPROVED,
      })
      .getCount();

    const declinedCount = await query
      .where('request.status = :requestStatus', {
        requestStatus: MediaRequestStatus.DECLINED,
      })
      .getCount();

    const processingCount = await query
      .where('request.status = :requestStatus', {
        requestStatus: MediaRequestStatus.APPROVED,
      })
      .andWhere(
        '((request.is4k = false AND request.isAudiobook = false AND media.status != :availableStatus) OR (request.is4k = true AND media.status4k != :availableStatus) OR (request.isAudiobook = true AND media.statusAudio != :availableStatus))',
        {
          availableStatus: MediaStatus.AVAILABLE,
        }
      )
      .getCount();

    const availableCount = await query
      .where('request.status = :requestStatus', {
        requestStatus: MediaRequestStatus.APPROVED,
      })
      .andWhere(
        '((request.is4k = false AND request.isAudiobook = false AND media.status = :availableStatus) OR (request.is4k = true AND media.status4k = :availableStatus) OR (request.isAudiobook = true AND media.statusAudio = :availableStatus))',
        {
          availableStatus: MediaStatus.AVAILABLE,
        }
      )
      .getCount();

    const completedCount = await query
      .where('request.status = :requestStatus', {
        requestStatus: MediaRequestStatus.COMPLETED,
      })
      .getCount();

    return res.status(200).json({
      total: totalCount,
      movie: movieCount,
      tv: tvCount,
      music: musicCount,
      book: bookCount,
      pending: pendingCount,
      approved: approvedCount,
      declined: declinedCount,
      processing: processingCount,
      available: availableCount,
      completed: completedCount,
    });
  } catch (e) {
    logger.error('Something went wrong retrieving request counts', {
      label: 'API',
      errorMessage: e.message,
    });
    next({ status: 500, message: 'Unable to retrieve request counts.' });
  }
});

/**
 * "Notify me too": the requests of a title still on their way, with how
 * many users asked to be told about each and whether the user asking did
 */
requestRoutes.get<never, RequestInterestResponse>(
  '/interest',
  async (req, res, next) => {
    const mediaId = Number(req.query.mediaId);

    if (!Number.isInteger(mediaId) || mediaId <= 0) {
      return next({ status: 400, message: 'A media id is required.' });
    }

    try {
      const requests = await getRepository(MediaRequest).find({
        where: { media: { id: mediaId }, status: In(INTEREST_STATUSES) },
      });
      const summaries = await getInterestSummaries(
        requests.map((request) => request.id),
        req.user
      );

      return res.status(200).json({ results: [...summaries.values()] });
    } catch (e) {
      logger.error('Something went wrong retrieving request interest', {
        label: 'API',
        errorMessage: e.message,
        mediaId,
      });
      next({ status: 500, message: 'Unable to retrieve request interest.' });
    }
  }
);

requestRoutes.post<{ requestId: string }>(
  '/:requestId/interest',
  async (req, res, next) => {
    if (!req.user) {
      return next({ status: 401, message: 'You must be logged in.' });
    }

    try {
      await addInterest(Number(req.params.requestId), req.user);
      const summary = (
        await getInterestSummaries([Number(req.params.requestId)], req.user)
      ).get(Number(req.params.requestId));

      return res.status(200).json(summary);
    } catch (e) {
      if (e instanceof InterestError) {
        return next({ status: e.status, message: e.message });
      }

      logger.error('Something went wrong adding request interest', {
        label: 'API',
        errorMessage: e.message,
        requestId: req.params.requestId,
      });
      next({ status: 500, message: 'Unable to add your interest.' });
    }
  }
);

requestRoutes.delete<{ requestId: string }>(
  '/:requestId/interest',
  async (req, res, next) => {
    if (!req.user) {
      return next({ status: 401, message: 'You must be logged in.' });
    }

    try {
      await removeInterest(Number(req.params.requestId), req.user);

      return res.status(204).send();
    } catch (e) {
      logger.error('Something went wrong removing request interest', {
        label: 'API',
        errorMessage: e.message,
        requestId: req.params.requestId,
      });
      next({ status: 500, message: 'Unable to remove your interest.' });
    }
  }
);

requestRoutes.get('/:requestId', async (req, res, next) => {
  const requestRepository = getRepository(MediaRequest);

  try {
    const request = await requestRepository.findOneOrFail({
      where: { id: Number(req.params.requestId) },
      relations: { requestedBy: true, modifiedBy: true },
    });

    if (
      request.requestedBy.id !== req.user?.id &&
      !req.user?.hasPermission(
        [Permission.MANAGE_REQUESTS, Permission.REQUEST_VIEW],
        { type: 'or' }
      ) &&
      // A user who asked to be told about it sees it in their list too
      !(await isInterested(request.id, req.user))
    ) {
      return next({
        status: 403,
        message: 'You do not have permission to view this request.',
      });
    }

    return res.status(200).json(request);
  } catch (e) {
    logger.debug('Failed to retrieve request.', {
      label: 'API',
      errorMessage: e.message,
    });
    next({ status: 404, message: 'Request not found.' });
  }
});

requestRoutes.put<{ requestId: string }>(
  '/:requestId',
  async (req, res, next) => {
    const requestRepository = getRepository(MediaRequest);
    const userRepository = getRepository(User);
    const requestId = Number(req.params.requestId);
    try {
      // Ordering is request then owner here, user then media on create, so no cycle
      return await requestLock.dispatch(requestKey(requestId), async () => {
        const request = await requestRepository.findOne({
          where: {
            id: requestId,
          },
        });

        if (!request) {
          return next({ status: 404, message: 'Request not found.' });
        }

        if (
          (request.requestedBy.id !== req.user?.id ||
            (request.type !== MediaType.TV &&
              !req.user?.hasPermission(Permission.REQUEST_ADVANCED))) &&
          !req.user?.hasPermission(Permission.MANAGE_REQUESTS)
        ) {
          return next({
            status: 403,
            message: 'You do not have permission to modify this request.',
          });
        }

        if (request.status !== MediaRequestStatus.PENDING) {
          return next({
            status: 409,
            message: 'Only pending requests can be modified.',
          });
        }

        const previousOwnerId = request.requestedBy.id;
        let requestUser = request.requestedBy;

        if (
          req.body.userId &&
          req.body.userId !== request.requestedBy.id &&
          !req.user?.hasPermission([
            Permission.MANAGE_USERS,
            Permission.MANAGE_REQUESTS,
          ])
        ) {
          return next({
            status: 403,
            message: 'You do not have permission to modify the request user.',
          });
        } else if (req.body.userId) {
          requestUser = await userRepository.findOneOrFail({
            where: { id: req.body.userId },
          });
        }

        // Reassignment moves every season on the request onto the new owner's
        // quota, so it is charged in full rather than as a delta
        const ownerChanging = requestUser.id !== previousOwnerId;

        return requestLock.dispatch(userKey(requestUser.id), async () => {
          if (request.type === MediaType.MOVIE) {
            if (ownerChanging && !request.ignoreQuota) {
              const quotas = await requestUser.getQuota();

              if (quotas.movie.restricted) {
                return next({
                  status: 403,
                  message: 'Movie Quota exceeded.',
                });
              }
            }

            request.serverId = req.body.serverId;
            request.profileId = req.body.profileId;
            request.rootFolder = req.body.rootFolder;
            request.tags = req.body.tags;
            request.requestedBy = requestUser as User;

            await requestRepository.save(request);
          } else if (request.type === MediaType.MUSIC) {
            if (ownerChanging && !request.ignoreQuota) {
              const quotas = await requestUser.getQuota();

              if (quotas.music.restricted) {
                return next({
                  status: 403,
                  message: 'Music Quota exceeded.',
                });
              }
            }

            request.serverId = req.body.serverId;
            request.profileId = req.body.profileId;
            request.rootFolder = req.body.rootFolder;
            request.tags = req.body.tags;
            request.requestedBy = requestUser as User;

            await requestRepository.save(request);
          } else if (request.type === MediaType.BOOK) {
            if (ownerChanging && !request.ignoreQuota) {
              const quotas = await requestUser.getQuota();

              if (quotas.book.restricted) {
                return next({
                  status: 403,
                  message: 'Book Quota exceeded.',
                });
              }
            }

            // Only managers choose the language of a book. LazyLibrarian
            // takes no other request options.
            if (
              req.body.language !== undefined &&
              req.user?.hasPermission(Permission.MANAGE_REQUESTS)
            ) {
              if (!isBookLanguage(req.body.language)) {
                return next({
                  status: 400,
                  message: 'Unknown book language.',
                });
              }

              request.language = req.body.language;
            }

            request.requestedBy = requestUser as User;

            await requestRepository.save(request);
          } else if (request.type === MediaType.COMIC) {
            // Comics count against the book quota and take no options
            if (ownerChanging && !request.ignoreQuota) {
              const quotas = await requestUser.getQuota();

              if (quotas.book.restricted) {
                return next({
                  status: 403,
                  message: 'Book Quota exceeded.',
                });
              }
            }

            request.requestedBy = requestUser as User;

            await requestRepository.save(request);
          } else if (request.type === MediaType.TV) {
            const mediaRepository = getRepository(Media);
            if (
              req.user?.hasPermission(
                [Permission.MANAGE_REQUESTS, Permission.REQUEST_ADVANCED],
                { type: 'or' }
              )
            ) {
              request.serverId = req.body.serverId;
              request.profileId = req.body.profileId;
              request.rootFolder = req.body.rootFolder;
              request.languageProfileId = req.body.languageProfileId;
              request.tags = req.body.tags;
            }
            request.requestedBy = requestUser as User;

            const body = req.body as MediaRequestBody;
            const monitorMode =
              body.monitorMode ?? request.monitorMode ?? undefined;
            const isFutureOnly = monitorMode === MediaRequestMonitorMode.FUTURE;
            const isCurrentOnly =
              monitorMode === MediaRequestMonitorMode.CURRENT;

            if (
              !getSettings().main.partialRequestsEnabled &&
              ((body.monitorMode === MediaRequestMonitorMode.FUTURE &&
                request.monitorMode !== MediaRequestMonitorMode.FUTURE) ||
                (body.episodes ?? []).length > 0)
            ) {
              return next({
                status: 403,
                message: 'Partial series requests are disabled.',
              });
            }

            // Managers can always request only the current season
            if (
              !getSettings().main.allowCurrentSeasonRequests &&
              !req.user?.hasPermission(Permission.MANAGE_REQUESTS) &&
              body.monitorMode === MediaRequestMonitorMode.CURRENT &&
              request.monitorMode !== MediaRequestMonitorMode.CURRENT
            ) {
              return next({
                status: 403,
                message: 'Current season requests are disabled.',
              });
            }

            let requestedSeasons: RequestedSeason[] = [];

            if (isFutureOnly || isCurrentOnly) {
              const tmdbShow = await new TheMovieDb().getTvShow({
                tvId: request.media.tmdbId,
              });
              const seasonInfo = getTmdbSeasonInfo(tmdbShow);
              const seasonNumbers = isFutureOnly
                ? getFutureSeasonNumbers(seasonInfo)
                : [getCurrentSeasonNumber(seasonInfo)].filter(
                    (seasonNumber): seasonNumber is number =>
                      seasonNumber !== null
                  );
              requestedSeasons = seasonNumbers.map((seasonNumber) => ({
                seasonNumber,
                episodes: null,
              }));
            } else if (
              (Array.isArray(body.seasons) && body.seasons.length > 0) ||
              (body.episodes ?? []).length > 0
            ) {
              requestedSeasons = buildRequestedSeasons(
                Array.isArray(body.seasons) ? body.seasons : [],
                body.episodes
              );
            } else {
              return next({
                status: 400,
                message:
                  'Missing seasons. If you want to cancel a series request, use the DELETE method.',
              });
            }

            const wasCurrentOnly =
              request.monitorMode === MediaRequestMonitorMode.CURRENT;

            request.monitorMode = isFutureOnly
              ? MediaRequestMonitorMode.FUTURE
              : isCurrentOnly
                ? MediaRequestMonitorMode.CURRENT
                : null;

            // Same key as create, so an edit cannot claim a season that a new
            // request is taking at the same moment
            return mediaLock.dispatch(
              mediaKey(MediaType.TV, request.media.tmdbId),
              async () => {
                // Get existing media so we can work with all the requests
                const media = await mediaRepository.findOneOrFail({
                  where: {
                    tmdbId: request.media.tmdbId,
                    mediaType: MediaType.TV,
                  },
                  relations: { requests: true },
                });

                // A request that becomes current season only remembers what
                // was already there, as those seasons are kept on a roll off
                if (!isCurrentOnly) {
                  request.preexistingSeasons = null;
                } else if (!wasCurrentOnly) {
                  request.preexistingSeasons = getAvailableSeasonNumbers(
                    media.seasons ?? [],
                    request.is4k
                  );
                }

                const currentSeasons = request.seasons.map(
                  (s) => s.seasonNumber
                );

                // Seasons held by other requests, or already covered by the media,
                // cannot be requested again, while the ones this request holds stay on it
                const filteredSeasons = filterRequestableSeasons({
                  requested: requestedSeasons,
                  requests: media.requests.filter((r) => r.id !== request.id),
                  seasons: media.seasons ?? [],
                  is4k: request.is4k,
                  keptSeasons: currentSeasons,
                });

                const keptSeasons = filteredSeasons.filter((season) =>
                  currentSeasons.includes(season.seasonNumber)
                );

                const newSeasons = filteredSeasons.filter(
                  (season) => !currentSeasons.includes(season.seasonNumber)
                );

                // An episode request counts as one season against the quota
                const resultingSeasonCount =
                  keptSeasons.length + newSeasons.length;

                if (resultingSeasonCount === 0) {
                  return next({
                    status: 202,
                    message: 'No seasons available to request',
                  });
                }

                if (!request.ignoreQuota) {
                  const quotas = await requestUser.getQuota();

                  // Only the seasons getQuota already counted for this owner are
                  // paid for, so the edit is charged for everything it left out
                  const quotaWindowStart = new Date();
                  if (quotas.tv.days) {
                    quotaWindowStart.setDate(
                      quotaWindowStart.getDate() - quotas.tv.days
                    );
                  }

                  const countedAlready =
                    !ownerChanging &&
                    (!quotas.tv.days || request.createdAt > quotaWindowStart);

                  const priorSeasonCount = countedAlready
                    ? request.seasons.length
                    : 0;
                  const requiredSeasons =
                    resultingSeasonCount - priorSeasonCount;

                  if (
                    quotas.tv.limit &&
                    requiredSeasons > (quotas.tv.remaining ?? 0)
                  ) {
                    return next({
                      status: 403,
                      message: 'Series Quota exceeded.',
                    });
                  }
                }

                request.seasons = request.seasons.filter((rs) => {
                  const kept = keptSeasons.find(
                    (season) => season.seasonNumber === rs.seasonNumber
                  );

                  if (kept) {
                    rs.episodes = kept.episodes;
                  }

                  return !!kept;
                });

                if (newSeasons.length > 0) {
                  logger.debug('Adding new seasons to request', {
                    label: 'Media Request',
                    newSeasons,
                  });
                  request.seasons.push(
                    ...newSeasons.map(
                      (ns) =>
                        new SeasonRequest({
                          seasonNumber: ns.seasonNumber,
                          episodes: ns.episodes,
                          status: MediaRequestStatus.PENDING,
                        })
                    )
                  );
                }

                await requestRepository.save(request);

                return res.status(200).json(request);
              }
            );
          }

          return res.status(200).json(request);
        });
      });
    } catch (e) {
      next({ status: 500, message: e.message });
    }
  }
);

requestRoutes.delete('/:requestId', async (req, res, next) => {
  const requestRepository = getRepository(MediaRequest);
  const requestId = Number(req.params.requestId);

  try {
    return await requestLock.dispatch(requestKey(requestId), async () => {
      const request = await requestRepository.findOneOrFail({
        where: { id: requestId },
        relations: { requestedBy: true, modifiedBy: true },
      });

      if (
        !req.user?.hasPermission(Permission.MANAGE_REQUESTS) &&
        (request.requestedBy.id !== req.user?.id ||
          request.status !== MediaRequestStatus.PENDING)
      ) {
        return next({
          status: 401,
          message: 'You do not have permission to delete this request.',
        });
      }

      await requestRepository.remove(request);

      return res.status(204).send();
    });
  } catch (e) {
    logger.error('Something went wrong deleting a request.', {
      label: 'API',
      errorMessage: e.message,
    });
    next({ status: 404, message: 'Request not found.' });
  }
});

requestRoutes.post<{
  requestId: string;
}>(
  '/:requestId/retry',
  isAuthenticated(Permission.MANAGE_REQUESTS),
  async (req, res, next) => {
    const requestRepository = getRepository(MediaRequest);
    const requestId = Number(req.params.requestId);

    try {
      return await requestLock.dispatch(requestKey(requestId), async () => {
        const request = await requestRepository.findOneOrFail({
          where: { id: requestId },
          relations: { requestedBy: true, modifiedBy: true },
        });

        if (request.status !== MediaRequestStatus.FAILED) {
          return next({
            status: 409,
            message: 'Only failed requests can be retried.',
          });
        }

        // this also triggers updating the parent media's status & sending to *arr
        request.status = MediaRequestStatus.APPROVED;
        request.modifiedBy = req.user;
        await requestRepository.save(request);

        return res.status(200).json(request);
      });
    } catch (e) {
      logger.error('Error processing request retry', {
        label: 'Media Request',
        message: e.message,
      });
      next({ status: 404, message: 'Request not found.' });
    }
  }
);

requestRoutes.post<
  {
    requestId: string;
    status: 'approve' | 'decline';
  },
  MediaRequest,
  { reason?: string }
>(
  '/:requestId/:status',
  isAuthenticated(Permission.MANAGE_REQUESTS),
  async (req, res, next) => {
    const requestRepository = getRepository(MediaRequest);
    const requestId = Number(req.params.requestId);

    try {
      return await requestLock.dispatch(requestKey(requestId), async () => {
        const request = await requestRepository.findOneOrFail({
          where: { id: requestId },
          relations: { requestedBy: true, modifiedBy: true },
        });

        let newStatus: MediaRequestStatus;

        switch (req.params.status) {
          case 'approve':
            newStatus = MediaRequestStatus.APPROVED;
            break;
          case 'decline':
            newStatus = MediaRequestStatus.DECLINED;
            break;
          default:
            return next({
              status: 400,
              message: 'Status must be approve or decline.',
            });
        }

        if (request.status !== MediaRequestStatus.PENDING) {
          return next({
            status: 409,
            message: 'Only pending requests can be approved or declined.',
          });
        }

        request.status = newStatus;
        request.modifiedBy = req.user;
        if (newStatus === MediaRequestStatus.DECLINED) {
          request.declineReason =
            req.body?.reason?.trim().slice(0, 500) || null;
        }
        await requestRepository.save(request);

        return res.status(200).json(request);
      });
    } catch (e) {
      logger.error('Error processing request update', {
        label: 'Media Request',
        message: e.message,
      });
      next({ status: 404, message: 'Request not found.' });
    }
  }
);

export default requestRoutes;
