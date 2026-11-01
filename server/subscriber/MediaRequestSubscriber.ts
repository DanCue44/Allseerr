import LazyLibrarianAPI, {
  isLazyLibrarianConfigured,
} from '@server/api/lazylibrarian';
import ChaptarrAPI from '@server/api/servarr/chaptarr';
import type { LidarrAlbumOptions } from '@server/api/servarr/lidarr';
import LidarrAPI from '@server/api/servarr/lidarr';
import type { RadarrMovieOptions } from '@server/api/servarr/radarr';
import RadarrAPI from '@server/api/servarr/radarr';
import type {
  AddSeriesOptions,
  SonarrSeries,
} from '@server/api/servarr/sonarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import TheMovieDb from '@server/api/themoviedb';
import { ANIME_KEYWORD_ID } from '@server/api/themoviedb/constants';
import {
  getEffectiveBookLanguage,
  isBookLanguage,
} from '@server/constants/bookLanguages';
import { describeBookRecording } from '@server/constants/bookRecording';
import { usesChaptarr } from '@server/constants/bookService';
import {
  MediaRequestMonitorMode,
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import Season from '@server/entity/Season';
import SeasonRequest from '@server/entity/SeasonRequest';
import { UserAccessProfile } from '@server/entity/UserAccessProfile';
import {
  getBookFormatName,
  getBookNotificationDetails,
} from '@server/lib/bookNotifications';
import { getRequestStatusKey } from '@server/lib/bookRequests';
import { getChaptarrLanguageTags } from '@server/lib/chaptarrLanguages';
import {
  getChaptarrFormatSettings,
  sendBookToChaptarr,
} from '@server/lib/chaptarrRequests';
import {
  getComicNotificationDetails,
  getComicsServer,
  sendComicToTalearr,
} from '@server/lib/comics';
import {
  formatRequestedSeasons,
  isPartialSeriesRequest,
} from '@server/lib/episodeRequests';
import { addBookToLazyLibrarian } from '@server/lib/lazyLibrarianRequests';
import { getMusicNotificationDetails } from '@server/lib/musicNotifications';
import notificationManager, { Notification } from '@server/lib/notifications';
import { getDefaultChaptarr, getSettings } from '@server/lib/settings';
import {
  applyBookGrabPolicy,
  getRequestAudiobookVersion,
} from '@server/lib/talearrAudiobookVersions';
import {
  requestAbridgedRecording,
  sendRecordingToTalearr,
} from '@server/lib/talearrRecordings';
import { isRestricted } from '@server/lib/userAccess/ageLimits';
import { notifyWatchlistUsers } from '@server/lib/watchlistNotifications';
import logger from '@server/logger';
import { runInBackground } from '@server/utils/backgroundTasks';
import { withNestedTransaction } from '@server/utils/nestedTransaction';
import serviceQueue, {
  LAZYLIBRARIAN_KEY,
  chaptarrKey,
  lidarrKey,
} from '@server/utils/serviceQueue';
import {
  releaseTransactionWaiters,
  transactionSettled,
} from '@server/utils/transactionSettled';
import { isEqual, pick, truncate } from 'lodash';
import type {
  EntityManager,
  EntitySubscriberInterface,
  InsertEvent,
  RemoveEvent,
  TransactionCommitEvent,
  TransactionRollbackEvent,
  UpdateEvent,
} from 'typeorm';
import { EventSubscriber, Not } from 'typeorm';

// A request sent off in the background writes back only the service ids it
// set. Saving the whole media would also write back the status it read, even
// when the request has moved the media on since, such as to processing.
const saveServiceColumns = async (
  media: Media,
  columns: (keyof Media)[]
): Promise<void> => {
  await getRepository(Media).update(media.id, pick(media, columns));
};

const sanitizeDisplayName = (displayName: string): string => {
  return displayName
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/gi, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
};

@EventSubscriber()
export class MediaRequestSubscriber implements EntitySubscriberInterface<MediaRequest> {
  private async notifyAvailableMovie(
    entity: MediaRequest,
    event?: UpdateEvent<MediaRequest>
  ) {
    // Get fresh media state using event manager
    let latestMedia: Media | null = null;
    if (event?.manager) {
      latestMedia = await event.manager.findOne(Media, {
        where: { id: entity.media.id },
      });
    }
    if (!latestMedia) {
      const mediaRepository = getRepository(Media);
      latestMedia = await mediaRepository.findOne({
        where: { id: entity.media.id },
      });
    }

    // Check availability using fresh media state
    if (
      !latestMedia ||
      latestMedia[entity.is4k ? 'status4k' : 'status'] !== MediaStatus.AVAILABLE
    ) {
      return;
    }

    const tmdb = new TheMovieDb();

    try {
      const movie = await tmdb.getMovie({
        movieId: entity.media.tmdbId,
      });

      notificationManager.sendNotification(Notification.MEDIA_AVAILABLE, {
        event: `${entity.is4k ? '4K ' : ''}Movie Request Now Available`,
        notifyAdmin: false,
        notifySystem: true,
        notifyUser: entity.requestedBy,
        subject: `${movie.title}${
          movie.release_date ? ` (${movie.release_date.slice(0, 4)})` : ''
        }`,
        message: truncate(movie.overview, {
          length: 500,
          separator: /\s/,
          omission: '…',
        }),
        media: latestMedia,
        image: `https://image.tmdb.org/t/p/w600_and_h900_bestv2${movie.poster_path}`,
        request: entity,
      });

      if (!entity.is4k) {
        await notifyWatchlistUsers(latestMedia, MediaType.MOVIE, {
          event: 'Movie Now Available',
          subject: `${movie.title}${
            movie.release_date ? ` (${movie.release_date.slice(0, 4)})` : ''
          }`,
          message: truncate(movie.overview, {
            length: 500,
            separator: /\s/,
            omission: '…',
          }),
          media: latestMedia,
          image: `https://image.tmdb.org/t/p/w600_and_h900_bestv2${movie.poster_path}`,
        });
      }
    } catch (e) {
      logger.error('Something went wrong sending media notification(s)', {
        label: 'Notifications',
        errorMessage: e.message,
        mediaId: entity.id,
      });
    }
  }

  private async notifyAvailableSeries(
    entity: MediaRequest,
    event?: UpdateEvent<MediaRequest>
  ) {
    // Get fresh media state with seasons using event manager
    let latestMedia: Media | null = null;
    if (event?.manager) {
      latestMedia = await event.manager.findOne(Media, {
        where: { id: entity.media.id },
        relations: { seasons: true },
      });
    }
    if (!latestMedia) {
      const mediaRepository = getRepository(Media);
      latestMedia = await mediaRepository.findOne({
        where: { id: entity.media.id },
        relations: { seasons: true },
      });
    }

    if (!latestMedia) {
      return;
    }

    // Check availability using fresh media state
    const requestedSeasons =
      entity.seasons?.map((entitySeason) => entitySeason.seasonNumber) ?? [];
    const availableSeasons = latestMedia.seasons.filter(
      (season) =>
        season[entity.is4k ? 'status4k' : 'status'] === MediaStatus.AVAILABLE &&
        requestedSeasons.includes(season.seasonNumber)
    );
    // Episode and future only requests rarely fill a whole season, so the
    // Sonarr scan completes their seasons once the episodes are in
    const isMediaAvailable = isPartialSeriesRequest(entity)
      ? (entity.seasons ?? []).length > 0 &&
        entity.seasons.every(
          (season) => season.status === MediaRequestStatus.COMPLETED
        )
      : availableSeasons.length > 0 &&
        availableSeasons.length === requestedSeasons.length;

    if (!isMediaAvailable) {
      return;
    }

    const tmdb = new TheMovieDb();

    try {
      const tv = await tmdb.getTvShow({ tvId: entity.media.tmdbId });

      notificationManager.sendNotification(Notification.MEDIA_AVAILABLE, {
        event: `${entity.is4k ? '4K ' : ''}Series Request Now Available`,
        subject: `${tv.name}${
          tv.first_air_date ? ` (${tv.first_air_date.slice(0, 4)})` : ''
        }`,
        message: truncate(tv.overview, {
          length: 500,
          separator: /\s/,
          omission: '…',
        }),
        notifyAdmin: false,
        notifySystem: true,
        notifyUser: entity.requestedBy,
        image: `https://image.tmdb.org/t/p/w600_and_h900_bestv2${tv.poster_path}`,
        media: latestMedia,
        extra: [
          {
            name: 'Requested Seasons',
            value: formatRequestedSeasons(entity.seasons),
          },
        ],
        request: entity,
      });

      // Watchlist users only hear about the series once whole seasons are in
      if (!entity.is4k && !isPartialSeriesRequest(entity)) {
        await notifyWatchlistUsers(latestMedia, MediaType.TV, {
          event: 'Series Now Available',
          subject: `${tv.name}${
            tv.first_air_date ? ` (${tv.first_air_date.slice(0, 4)})` : ''
          }`,
          message: truncate(tv.overview, {
            length: 500,
            separator: /\s/,
            omission: '…',
          }),
          image: `https://image.tmdb.org/t/p/w600_and_h900_bestv2${tv.poster_path}`,
          media: latestMedia,
          extra: [
            {
              name: 'Available Seasons',
              value: entity.seasons
                .map((season) => season.seasonNumber)
                .join(', '),
            },
          ],
        });
      }
    } catch (e) {
      logger.error('Something went wrong sending media notification(s)', {
        label: 'Notifications',
        errorMessage: e.message,
        mediaId: entity.id,
      });
    }
  }

  private async notifyAvailableMusic(
    entity: MediaRequest,
    event?: UpdateEvent<MediaRequest>
  ) {
    // Get fresh media state using event manager
    let latestMedia: Media | null = null;
    if (event?.manager) {
      latestMedia = await event.manager.findOne(Media, {
        where: { id: entity.media.id },
      });
    }
    if (!latestMedia) {
      const mediaRepository = getRepository(Media);
      latestMedia = await mediaRepository.findOne({
        where: { id: entity.media.id },
      });
    }

    if (!latestMedia?.mbId || latestMedia.status !== MediaStatus.AVAILABLE) {
      return;
    }

    try {
      const album = await getMusicNotificationDetails(latestMedia.mbId);

      notificationManager.sendNotification(Notification.MEDIA_AVAILABLE, {
        event: 'Album Request Now Available',
        notifyAdmin: false,
        notifySystem: true,
        notifyUser: entity.requestedBy,
        subject: album.subject,
        message: album.message,
        media: latestMedia,
        image: album.image,
        request: entity,
      });

      await notifyWatchlistUsers(latestMedia, MediaType.MUSIC, {
        event: 'Album Now Available',
        subject: album.subject,
        message: album.message,
        media: latestMedia,
        image: album.image,
      });
    } catch (e) {
      logger.error('Something went wrong sending media notification(s)', {
        label: 'Notifications',
        errorMessage: e.message,
        mediaId: entity.id,
      });
    }
  }

  private async notifyAvailableBook(
    entity: MediaRequest,
    event?: UpdateEvent<MediaRequest>
  ) {
    // Get fresh media state using event manager
    let latestMedia: Media | null = null;
    if (event?.manager) {
      latestMedia = await event.manager.findOne(Media, {
        where: { id: entity.media.id },
      });
    }
    if (!latestMedia) {
      const mediaRepository = getRepository(Media);
      latestMedia = await mediaRepository.findOne({
        where: { id: entity.media.id },
      });
    }

    if (
      !latestMedia?.olId ||
      latestMedia[getRequestStatusKey(entity)] !== MediaStatus.AVAILABLE
    ) {
      return;
    }

    if (entity.recording) {
      return this.notifyAvailableRecording(entity, latestMedia);
    }

    try {
      const book = await getBookNotificationDetails(latestMedia.olId);

      notificationManager.sendNotification(Notification.MEDIA_AVAILABLE, {
        event: `${getBookFormatName(entity.isAudiobook)} Request Now Available`,
        notifyAdmin: false,
        notifySystem: true,
        notifyUser: entity.requestedBy,
        subject: book.subject,
        message: book.message,
        media: latestMedia,
        image: book.image,
        request: entity,
        extra: [
          { name: 'Format', value: getBookFormatName(entity.isAudiobook) },
        ],
      });

      // Watchlist users hear about the book once, in whichever format lands
      // first
      await notifyWatchlistUsers(latestMedia, MediaType.BOOK, {
        event: `${getBookFormatName(entity.isAudiobook)} Now Available`,
        subject: book.subject,
        message: book.message,
        media: latestMedia,
        image: book.image,
        extra: [
          { name: 'Format', value: getBookFormatName(entity.isAudiobook) },
        ],
      });
    } catch (e) {
      logger.error('Something went wrong sending media notification(s)', {
        label: 'Notifications',
        errorMessage: e.message,
        mediaId: entity.id,
      });
    }
  }

  private async notifyAvailableComic(
    entity: MediaRequest,
    event?: UpdateEvent<MediaRequest>
  ) {
    const latestMedia =
      (await event?.manager.findOne(Media, {
        where: { id: entity.media.id },
      })) ??
      (await getRepository(Media).findOne({
        where: { id: entity.media.id },
      }));

    if (!latestMedia?.comicId || latestMedia.status !== MediaStatus.AVAILABLE) {
      return;
    }

    try {
      const comic = await getComicNotificationDetails(latestMedia.comicId);
      const kindName = latestMedia.comicKind === 'manga' ? 'Manga' : 'Comic';

      notificationManager.sendNotification(Notification.MEDIA_AVAILABLE, {
        event: `${kindName} Request Now Available`,
        notifyAdmin: false,
        notifySystem: true,
        notifyUser: entity.requestedBy,
        subject: comic.subject,
        message: comic.message,
        media: latestMedia,
        image: comic.image,
        request: entity,
      });
    } catch (e) {
      logger.error('Something went wrong sending media notification(s)', {
        label: 'Notifications',
        errorMessage: e.message,
        mediaId: entity.id,
      });
    }
  }

  /**
   * Tells the requester another recording of an audiobook has arrived.
   * Watchlist users heard about the audiobook when it first arrived.
   */
  private async notifyAvailableRecording(entity: MediaRequest, media: Media) {
    try {
      const book = await getBookNotificationDetails(media.olId as string);

      notificationManager.sendNotification(Notification.MEDIA_AVAILABLE, {
        event: `${getBookFormatName(true, entity.recording)} Request Now Available`,
        notifyAdmin: false,
        notifySystem: true,
        notifyUser: entity.requestedBy,
        subject: book.subject,
        message: book.message,
        media,
        image: book.image,
        request: entity,
        extra: [
          { name: 'Format', value: getBookFormatName(true) },
          {
            name: 'Recording',
            value: describeBookRecording(entity) as string,
          },
        ],
      });
    } catch (e) {
      logger.error('Something went wrong sending media notification(s)', {
        label: 'Notifications',
        errorMessage: e.message,
        mediaId: entity.id,
      });
    }
  }

  public async sendToRadarr(
    entity: MediaRequest,
    manager: EntityManager
  ): Promise<void> {
    if (
      entity.status === MediaRequestStatus.APPROVED &&
      entity.type === MediaType.MOVIE
    ) {
      try {
        const mediaRepository = manager.getRepository(Media);
        const settings = getSettings();
        if (settings.radarr.length === 0 && !settings.radarr[0]) {
          logger.info(
            'No Radarr server configured, skipping request processing',
            {
              label: 'Media Request',
              requestId: entity.id,
              mediaId: entity.media.id,
            }
          );
          return;
        }

        let radarrSettings = settings.radarr.find(
          (radarr) => radarr.isDefault && radarr.is4k === entity.is4k
        );

        if (
          entity.serverId !== null &&
          entity.serverId >= 0 &&
          radarrSettings?.id !== entity.serverId
        ) {
          radarrSettings = settings.radarr.find(
            (radarr) => radarr.id === entity.serverId
          );
          logger.info(
            `Request has an override server: ${radarrSettings?.name}`,
            {
              label: 'Media Request',
              requestId: entity.id,
              mediaId: entity.media.id,
            }
          );
        }

        if (!radarrSettings) {
          logger.warn(
            `There is no default ${
              entity.is4k ? '4K ' : ''
            }Radarr server configured. Did you set any of your ${
              entity.is4k ? '4K ' : ''
            }Radarr servers as default?`,
            {
              label: 'Media Request',
              requestId: entity.id,
              mediaId: entity.media.id,
            }
          );
          return;
        }

        let rootFolder = radarrSettings.activeDirectory;
        let qualityProfile = radarrSettings.activeProfileId;
        let tags = radarrSettings.tags ? [...radarrSettings.tags] : [];

        if (
          entity.rootFolder &&
          entity.rootFolder !== '' &&
          entity.rootFolder !== radarrSettings.activeDirectory
        ) {
          rootFolder = entity.rootFolder;
          logger.info(`Request has an override root folder: ${rootFolder}`, {
            label: 'Media Request',
            requestId: entity.id,
            mediaId: entity.media.id,
          });
        }

        if (
          entity.profileId &&
          entity.profileId !== radarrSettings.activeProfileId
        ) {
          qualityProfile = entity.profileId;
          logger.info(
            `Request has an override quality profile ID: ${qualityProfile}`,
            {
              label: 'Media Request',
              requestId: entity.id,
              mediaId: entity.media.id,
            }
          );
        }

        if (entity.tags && !isEqual(entity.tags, radarrSettings.tags)) {
          tags = entity.tags;
          logger.info(`Request has override tags`, {
            label: 'Media Request',
            requestId: entity.id,
            mediaId: entity.media.id,
            tagIds: tags,
          });
        }

        const media = await mediaRepository.findOne({
          where: { id: entity.media.id },
        });

        if (!media) {
          logger.error('Media data not found', {
            label: 'Media Request',
            requestId: entity.id,
            mediaId: entity.media.id,
          });
          return;
        }

        if (
          media[entity.is4k ? 'status4k' : 'status'] === MediaStatus.AVAILABLE
        ) {
          logger.warn('Media already exists, marking request as COMPLETED', {
            label: 'Media Request',
            requestId: entity.id,
            mediaId: entity.media.id,
          });

          const requestRepository = manager.getRepository(MediaRequest);
          entity.status = MediaRequestStatus.COMPLETED;
          await requestRepository.save(entity);
          return;
        }

        const tmdb = new TheMovieDb();
        const radarr = new RadarrAPI({
          apiKey: radarrSettings.apiKey,
          url: RadarrAPI.buildUrl(radarrSettings, '/api/v3'),
        });
        const movie = await tmdb.getMovie({ movieId: entity.media.tmdbId });

        if (radarrSettings.tagRequests) {
          const radarrTags = await radarr.getTags();
          // old tags had space around the hyphen
          let userTag = radarrTags.find((v) =>
            v.label.startsWith(entity.requestedBy.id + ' - ')
          );
          // new tags do not have spaces around the hyphen, since spaces are not allowed anymore
          if (!userTag) {
            userTag = radarrTags.find((v) =>
              v.label.startsWith(entity.requestedBy.id + '-')
            );
          }
          if (!userTag) {
            logger.info(`Requester has no active tag. Creating new`, {
              label: 'Media Request',
              requestId: entity.id,
              mediaId: entity.media.id,
              userId: entity.requestedBy.id,
              newTag:
                entity.requestedBy.id +
                '-' +
                sanitizeDisplayName(entity.requestedBy.displayName),
            });
            userTag = await radarr.createTag({
              label:
                entity.requestedBy.id +
                '-' +
                sanitizeDisplayName(entity.requestedBy.displayName),
            });
          }
          if (userTag.id) {
            if (!tags?.find((v) => v === userTag?.id)) {
              tags?.push(userTag.id);
            }
          } else {
            logger.warn(`Requester has no tag and failed to add one`, {
              label: 'Media Request',
              requestId: entity.id,
              mediaId: entity.media.id,
              userId: entity.requestedBy.id,
              radarrServer: radarrSettings.hostname + ':' + radarrSettings.port,
            });
          }
        }

        const radarrMovieOptions: RadarrMovieOptions = {
          profileId: qualityProfile,
          qualityProfileId: qualityProfile,
          rootFolderPath: rootFolder,
          minimumAvailability: radarrSettings.minimumAvailability,
          title: movie.title,
          tmdbId: movie.id,
          year: Number(movie.release_date.slice(0, 4)),
          monitored: true,
          tags,
          searchNow: !radarrSettings.preventSearch,
        };

        // Run entity asynchronously so we don't wait for it on the UI side
        const sent = radarr
          .addMovie(radarrMovieOptions)
          // Writes back only once the request's transaction has ended
          .finally(() => transactionSettled(manager))
          .then(async (radarrMovie) => {
            // Needs its own repository as this runs detached from the request transaction
            const mediaRepository = getRepository(Media);
            // We grab media again here to make sure we have the latest version of it
            const media = await mediaRepository.findOne({
              where: { id: entity.media.id },
            });

            if (!media) {
              throw new Error('Media data not found');
            }

            media[entity.is4k ? 'externalServiceId4k' : 'externalServiceId'] =
              radarrMovie.id;
            media[
              entity.is4k ? 'externalServiceSlug4k' : 'externalServiceSlug'
            ] = radarrMovie.titleSlug;
            media[entity.is4k ? 'serviceId4k' : 'serviceId'] =
              radarrSettings?.id;
            await saveServiceColumns(
              media,
              entity.is4k
                ? [
                    'externalServiceId4k',
                    'externalServiceSlug4k',
                    'serviceId4k',
                  ]
                : ['externalServiceId', 'externalServiceSlug', 'serviceId']
            );
          })
          .catch(async () => {
            try {
              const requestRepository = getRepository(MediaRequest);

              if (entity.status !== MediaRequestStatus.FAILED) {
                entity.status = MediaRequestStatus.FAILED;
                await requestRepository.save(entity);
              }
            } catch (saveError) {
              logger.error('Failed to mark request as FAILED', {
                label: 'Media Request',
                requestId: entity.id,
                errorMessage:
                  saveError instanceof Error
                    ? saveError.message
                    : String(saveError),
              });
            }

            logger.warn(
              'Something went wrong sending movie request to Radarr, marking status as FAILED',
              {
                label: 'Media Request',
                requestId: entity.id,
                mediaId: entity.media.id,
                radarrMovieOptions,
              }
            );

            MediaRequest.sendNotification(
              entity,
              media,
              Notification.MEDIA_FAILED
            );
          })
          .finally(() => {
            radarr.clearCache({
              tmdbId: movie.id,
              externalId: entity.is4k
                ? media.externalServiceId4k
                : media.externalServiceId,
            });
          });
        runInBackground(sent);
        logger.info('Sent request to Radarr', {
          label: 'Media Request',
          requestId: entity.id,
          mediaId: entity.media.id,
        });
      } catch (e) {
        const requestRepository = manager.getRepository(MediaRequest);
        const mediaRepository = manager.getRepository(Media);
        const media = await mediaRepository.findOne({
          where: { id: entity.media.id },
        });

        if (media) {
          entity.status = MediaRequestStatus.FAILED;
          await requestRepository.save(entity);

          logger.warn(
            'Failed to send movie request to Radarr due to connection or configuration error, marking status as FAILED',
            {
              label: 'Media Request',
              requestId: entity.id,
              mediaId: entity.media.id,
              errorMessage: e.message,
            }
          );

          MediaRequest.sendNotification(
            entity,
            media,
            Notification.MEDIA_FAILED
          );
        }
      }
    }
  }

  public async sendToSonarr(
    entity: MediaRequest,
    manager: EntityManager
  ): Promise<void> {
    if (
      entity.status === MediaRequestStatus.APPROVED &&
      entity.type === MediaType.TV
    ) {
      try {
        const mediaRepository = manager.getRepository(Media);
        const settings = getSettings();
        if (settings.sonarr.length === 0 && !settings.sonarr[0]) {
          logger.warn(
            'No Sonarr server configured, skipping request processing',
            {
              label: 'Media Request',
              requestId: entity.id,
              mediaId: entity.media.id,
            }
          );
          return;
        }

        let sonarrSettings = settings.sonarr.find(
          (sonarr) => sonarr.isDefault && sonarr.is4k === entity.is4k
        );

        if (
          entity.serverId !== null &&
          entity.serverId >= 0 &&
          sonarrSettings?.id !== entity.serverId
        ) {
          sonarrSettings = settings.sonarr.find(
            (sonarr) => sonarr.id === entity.serverId
          );
          logger.info(
            `Request has an override server: ${sonarrSettings?.name}`,
            {
              label: 'Media Request',
              requestId: entity.id,
              mediaId: entity.media.id,
            }
          );
        }

        if (!sonarrSettings) {
          logger.warn(
            `There is no default ${
              entity.is4k ? '4K ' : ''
            }Sonarr server configured. Did you set any of your ${
              entity.is4k ? '4K ' : ''
            }Sonarr servers as default?`,
            {
              label: 'Media Request',
              requestId: entity.id,
              mediaId: entity.media.id,
            }
          );
          return;
        }

        const media = await mediaRepository.findOne({
          where: { id: entity.media.id },
        });

        if (!media) {
          throw new Error('Media data not found');
        }

        if (
          media[entity.is4k ? 'status4k' : 'status'] === MediaStatus.AVAILABLE
        ) {
          logger.warn('Media already exists, marking request as COMPLETED', {
            label: 'Media Request',
            requestId: entity.id,
            mediaId: entity.media.id,
          });

          const requestRepository = manager.getRepository(MediaRequest);
          entity.status = MediaRequestStatus.COMPLETED;
          entity.seasons.forEach((season) => {
            season.status = MediaRequestStatus.COMPLETED;
          });
          await requestRepository.save(entity);
          return;
        }

        const tmdb = new TheMovieDb();
        const sonarr = new SonarrAPI({
          apiKey: sonarrSettings.apiKey,
          url: SonarrAPI.buildUrl(sonarrSettings, '/api/v3'),
        });
        const series = await tmdb.getTvShow({ tvId: media.tmdbId });
        const tvdbId = series.external_ids.tvdb_id ?? media.tvdbId;

        if (!tvdbId) {
          const requestRepository = manager.getRepository(MediaRequest);
          await mediaRepository.remove(media);
          await requestRepository.remove(entity);
          throw new Error('TVDB ID not found');
        }

        const isAnime = series.keywords.results.some(
          (keyword) => keyword.id === ANIME_KEYWORD_ID
        );

        // seriesType only controls how Sonarr parses/numbers episodes
        // it is sent in the addSeries payload and must not gate anime routing
        let seriesType: SonarrSeries['seriesType'] =
          sonarrSettings.seriesType ?? 'standard';

        if (isAnime) {
          seriesType = sonarrSettings.animeSeriesType ?? 'anime';
        }

        let rootFolder =
          isAnime && sonarrSettings.activeAnimeDirectory
            ? sonarrSettings.activeAnimeDirectory
            : sonarrSettings.activeDirectory;
        let qualityProfile =
          isAnime && sonarrSettings.activeAnimeProfileId
            ? sonarrSettings.activeAnimeProfileId
            : sonarrSettings.activeProfileId;
        let languageProfile =
          isAnime && sonarrSettings.activeAnimeLanguageProfileId
            ? sonarrSettings.activeAnimeLanguageProfileId
            : sonarrSettings.activeLanguageProfileId;
        let tags = isAnime
          ? sonarrSettings.animeTags
            ? [...sonarrSettings.animeTags]
            : []
          : sonarrSettings.tags
            ? [...sonarrSettings.tags]
            : [];

        if (
          entity.rootFolder &&
          entity.rootFolder !== '' &&
          entity.rootFolder !== rootFolder
        ) {
          rootFolder = entity.rootFolder;
          logger.info(`Request has an override root folder: ${rootFolder}`, {
            label: 'Media Request',
            requestId: entity.id,
            mediaId: entity.media.id,
          });
        }

        if (entity.profileId && entity.profileId !== qualityProfile) {
          qualityProfile = entity.profileId;
          logger.info(
            `Request has an override quality profile ID: ${qualityProfile}`,
            {
              label: 'Media Request',
              requestId: entity.id,
              mediaId: entity.media.id,
            }
          );
        }

        if (
          entity.languageProfileId &&
          entity.languageProfileId !== languageProfile
        ) {
          languageProfile = entity.languageProfileId;
          logger.info(
            `Request has an override language profile ID: ${languageProfile}`,
            {
              label: 'Media Request',
              requestId: entity.id,
              mediaId: entity.media.id,
            }
          );
        }

        if (entity.tags && !isEqual(entity.tags, tags)) {
          tags = entity.tags;
          logger.info(`Request has override tags`, {
            label: 'Media Request',
            requestId: entity.id,
            mediaId: entity.media.id,
            tagIds: tags,
          });
        }

        if (sonarrSettings.tagRequests) {
          const sonarrTags = await sonarr.getTags();
          // old tags had space around the hyphen
          let userTag = sonarrTags.find((v) =>
            v.label.startsWith(entity.requestedBy.id + ' - ')
          );
          // new tags do not have spaces around the hyphen, since spaces are not allowed anymore
          if (!userTag) {
            userTag = sonarrTags.find((v) =>
              v.label.startsWith(entity.requestedBy.id + '-')
            );
          }
          if (!userTag) {
            logger.info(`Requester has no active tag. Creating new`, {
              label: 'Media Request',
              requestId: entity.id,
              mediaId: entity.media.id,
              userId: entity.requestedBy.id,
              newTag:
                entity.requestedBy.id +
                '-' +
                sanitizeDisplayName(entity.requestedBy.displayName),
            });
            userTag = await sonarr.createTag({
              label:
                entity.requestedBy.id +
                '-' +
                sanitizeDisplayName(entity.requestedBy.displayName),
            });
          }
          if (userTag.id) {
            if (!tags?.find((v) => v === userTag?.id)) {
              tags?.push(userTag.id);
            }
          } else {
            logger.warn(`Requester has no tag and failed to add one`, {
              label: 'Media Request',
              requestId: entity.id,
              mediaId: entity.media.id,
              userId: entity.requestedBy.id,
              sonarrServer: sonarrSettings.hostname + ':' + sonarrSettings.port,
            });
          }
        }

        const isFutureOnly =
          entity.monitorMode === MediaRequestMonitorMode.FUTURE;
        const episodeSeasons = entity.seasons.filter(
          (season) => !!season.episodes?.length
        );

        const sonarrSeriesOptions: AddSeriesOptions = {
          profileId: qualityProfile,
          languageProfileId: languageProfile,
          rootFolderPath: rootFolder,
          title: series.name,
          tvdbid: tvdbId,
          // Seasons with requested episodes only monitor those episodes
          seasons: entity.seasons
            .filter((season) => !season.episodes?.length)
            .map((season) => season.seasonNumber),
          episodes: episodeSeasons.length
            ? episodeSeasons.map((season) => ({
                seasonNumber: season.seasonNumber,
                episodeNumbers: season.episodes ?? [],
              }))
            : undefined,
          monitor: isFutureOnly ? 'future' : undefined,
          // A current season request follows each new season as it starts,
          // the Sonarr scan then rolls off the older ones
          monitorNewSeasons:
            entity.monitorMode === MediaRequestMonitorMode.CURRENT,
          seasonFolder: sonarrSettings.enableSeasonFolders,
          seriesType,
          tags,
          monitored: true,
          monitorNewItems: sonarrSettings.monitorNewItems,
          searchNow: !sonarrSettings.preventSearch && !isFutureOnly,
        };

        // Run entity asynchronously so we don't wait for it on the UI side
        const sent = sonarr
          .addSeries(sonarrSeriesOptions)
          // Writes back only once the request's transaction has ended
          .finally(() => transactionSettled(manager))
          .then(async (sonarrSeries) => {
            // Needs its own repository as this runs detached from the request transaction
            const mediaRepository = getRepository(Media);
            // We grab media again here to make sure we have the latest version of it
            const media = await mediaRepository.findOne({
              where: { id: entity.media.id },
            });

            if (!media) {
              throw new Error('Media data not found');
            }

            media[entity.is4k ? 'externalServiceId4k' : 'externalServiceId'] =
              sonarrSeries.id;
            media[
              entity.is4k ? 'externalServiceSlug4k' : 'externalServiceSlug'
            ] = sonarrSeries.titleSlug;
            media[entity.is4k ? 'serviceId4k' : 'serviceId'] =
              sonarrSettings?.id;
            await saveServiceColumns(
              media,
              entity.is4k
                ? [
                    'externalServiceId4k',
                    'externalServiceSlug4k',
                    'serviceId4k',
                  ]
                : ['externalServiceId', 'externalServiceSlug', 'serviceId']
            );
          })
          .catch(async () => {
            try {
              const requestRepository = getRepository(MediaRequest);

              if (entity.status !== MediaRequestStatus.FAILED) {
                entity.status = MediaRequestStatus.FAILED;
                await requestRepository.save(entity);
              }
            } catch (saveError) {
              logger.error('Failed to mark request as FAILED', {
                label: 'Media Request',
                requestId: entity.id,
                errorMessage:
                  saveError instanceof Error
                    ? saveError.message
                    : String(saveError),
              });
            }

            logger.warn(
              'Something went wrong sending series request to Sonarr, marking status as FAILED',
              {
                label: 'Media Request',
                requestId: entity.id,
                mediaId: entity.media.id,
                sonarrSeriesOptions,
              }
            );

            MediaRequest.sendNotification(
              entity,
              media,
              Notification.MEDIA_FAILED
            );
          })
          .finally(() => {
            sonarr.clearCache({
              tvdbId,
              externalId: entity.is4k
                ? media.externalServiceId4k
                : media.externalServiceId,
              title: series.name,
            });
          });
        runInBackground(sent);
        logger.info('Sent request to Sonarr', {
          label: 'Media Request',
          requestId: entity.id,
          mediaId: entity.media.id,
        });
      } catch (e) {
        const requestRepository = manager.getRepository(MediaRequest);
        const mediaRepository = manager.getRepository(Media);
        const media = await mediaRepository.findOne({
          where: { id: entity.media.id },
        });

        if (media) {
          entity.status = MediaRequestStatus.FAILED;
          await requestRepository.save(entity);

          logger.warn(
            'Failed to send series request to Sonarr due to connection or configuration error, marking status as FAILED',
            {
              label: 'Media Request',
              requestId: entity.id,
              mediaId: entity.media.id,
              errorMessage: e.message,
            }
          );

          MediaRequest.sendNotification(
            entity,
            media,
            Notification.MEDIA_FAILED
          );
        }
      }
    }
  }

  public async sendToLidarr(
    entity: MediaRequest,
    manager: EntityManager
  ): Promise<void> {
    if (
      entity.status !== MediaRequestStatus.APPROVED ||
      entity.type !== MediaType.MUSIC
    ) {
      return;
    }

    try {
      const mediaRepository = manager.getRepository(Media);
      const settings = getSettings();
      if (settings.lidarr.length === 0) {
        logger.info(
          'No Lidarr server configured, skipping request processing',
          {
            label: 'Media Request',
            requestId: entity.id,
            mediaId: entity.media.id,
          }
        );
        return;
      }

      let lidarrSettings = settings.lidarr.find((lidarr) => lidarr.isDefault);

      if (
        entity.serverId !== null &&
        entity.serverId >= 0 &&
        lidarrSettings?.id !== entity.serverId
      ) {
        lidarrSettings = settings.lidarr.find(
          (lidarr) => lidarr.id === entity.serverId
        );
        logger.info(`Request has an override server: ${lidarrSettings?.name}`, {
          label: 'Media Request',
          requestId: entity.id,
          mediaId: entity.media.id,
        });
      }

      if (!lidarrSettings) {
        logger.warn(
          'There is no default Lidarr server configured. Did you set any of your Lidarr servers as default?',
          {
            label: 'Media Request',
            requestId: entity.id,
            mediaId: entity.media.id,
          }
        );
        return;
      }

      let rootFolder = lidarrSettings.activeDirectory;
      let qualityProfile = lidarrSettings.activeProfileId;
      let tags = lidarrSettings.tags ? [...lidarrSettings.tags] : [];

      if (
        entity.rootFolder &&
        entity.rootFolder !== '' &&
        entity.rootFolder !== lidarrSettings.activeDirectory
      ) {
        rootFolder = entity.rootFolder;
        logger.info(`Request has an override root folder: ${rootFolder}`, {
          label: 'Media Request',
          requestId: entity.id,
          mediaId: entity.media.id,
        });
      }

      if (
        entity.profileId &&
        entity.profileId !== lidarrSettings.activeProfileId
      ) {
        qualityProfile = entity.profileId;
        logger.info(
          `Request has an override quality profile ID: ${qualityProfile}`,
          {
            label: 'Media Request',
            requestId: entity.id,
            mediaId: entity.media.id,
          }
        );
      }

      if (entity.tags && !isEqual(entity.tags, lidarrSettings.tags)) {
        tags = entity.tags;
        logger.info(`Request has override tags`, {
          label: 'Media Request',
          requestId: entity.id,
          mediaId: entity.media.id,
          tagIds: tags,
        });
      }

      const media = await mediaRepository.findOne({
        where: { id: entity.media.id },
      });

      if (!media?.mbId) {
        logger.error('Media data not found', {
          label: 'Media Request',
          requestId: entity.id,
          mediaId: entity.media.id,
        });
        return;
      }

      if (media.status === MediaStatus.AVAILABLE) {
        logger.warn('Media already exists, marking request as COMPLETED', {
          label: 'Media Request',
          requestId: entity.id,
          mediaId: entity.media.id,
        });

        const requestRepository = manager.getRepository(MediaRequest);
        entity.status = MediaRequestStatus.COMPLETED;
        await requestRepository.save(entity);
        return;
      }

      const lidarr = new LidarrAPI({
        apiKey: lidarrSettings.apiKey,
        url: LidarrAPI.buildUrl(lidarrSettings, '/api/v1'),
      });

      if (lidarrSettings.tagRequests) {
        const lidarrTags = await lidarr.getTags();
        let userTag = lidarrTags.find(
          (v) =>
            v.label.startsWith(entity.requestedBy.id + ' - ') ||
            v.label.startsWith(entity.requestedBy.id + '-')
        );
        if (!userTag) {
          logger.info(`Requester has no active tag. Creating new`, {
            label: 'Media Request',
            requestId: entity.id,
            mediaId: entity.media.id,
            userId: entity.requestedBy.id,
            newTag:
              entity.requestedBy.id +
              '-' +
              sanitizeDisplayName(entity.requestedBy.displayName),
          });
          userTag = await lidarr.createTag({
            label:
              entity.requestedBy.id +
              '-' +
              sanitizeDisplayName(entity.requestedBy.displayName),
          });
        }
        if (userTag.id) {
          if (!tags.find((v) => v === userTag?.id)) {
            tags.push(userTag.id);
          }
        } else {
          logger.warn(`Requester has no tag and failed to add one`, {
            label: 'Media Request',
            requestId: entity.id,
            mediaId: entity.media.id,
            userId: entity.requestedBy.id,
            lidarrServer: lidarrSettings.hostname + ':' + lidarrSettings.port,
          });
        }
      }

      // Lidarr monitors the artist for the requested album only, new and
      // older releases are left for further requests
      const lidarrAlbumOptions: LidarrAlbumOptions = {
        foreignAlbumId: media.mbId,
        monitored: true,
        anyReleaseOk: true,
        profileId: qualityProfile,
        artist: {
          qualityProfileId: qualityProfile,
          metadataProfileId: lidarrSettings.activeMetadataProfileId,
          rootFolderPath: rootFolder,
          monitored: true,
          monitorNewItems: 'none',
          tags,
          addOptions: {
            // "unknown" monitors only albumsToMonitor. "none" would also
            // unmonitor the new artist once Lidarr refreshes it, and Lidarr
            // leaves an unmonitored artist's albums out of Wanted/Missing
            monitor: 'unknown',
            albumsToMonitor: [media.mbId],
            searchForMissingAlbums: false,
          },
        },
        addOptions: {
          searchForNewAlbum: !lidarrSettings.preventSearch,
        },
      };

      // Run entity asynchronously so we don't wait for it on the UI side.
      // Adds to a server are queued so the albums of a bulk request reach
      // Lidarr one after another and its artist is only added once.
      const lidarrServerId = lidarrSettings.id;
      const sent = serviceQueue
        .dispatch(lidarrKey(lidarrServerId), () =>
          lidarr.addAlbum(lidarrAlbumOptions)
        )
        // Writes back only once the request's transaction has ended
        .finally(() => transactionSettled(manager))
        .then(async (lidarrAlbum) => {
          // Needs its own repository as this runs detached from the request transaction
          const mediaRepository = getRepository(Media);
          // We grab media again here to make sure we have the latest version of it
          const media = await mediaRepository.findOne({
            where: { id: entity.media.id },
          });

          if (!media) {
            throw new Error('Media data not found');
          }

          media.externalServiceId = lidarrAlbum.id;
          // Lidarr album pages are addressed by the MusicBrainz id
          media.externalServiceSlug = lidarrAlbum.foreignAlbumId;
          media.serviceId = lidarrServerId;
          await saveServiceColumns(media, [
            'externalServiceId',
            'externalServiceSlug',
            'serviceId',
          ]);
        })
        .catch(async () => {
          try {
            const requestRepository = getRepository(MediaRequest);

            if (entity.status !== MediaRequestStatus.FAILED) {
              entity.status = MediaRequestStatus.FAILED;
              await requestRepository.save(entity);
            }
          } catch (saveError) {
            logger.error('Failed to mark request as FAILED', {
              label: 'Media Request',
              requestId: entity.id,
              errorMessage:
                saveError instanceof Error
                  ? saveError.message
                  : String(saveError),
            });
          }

          logger.warn(
            'Something went wrong sending album request to Lidarr, marking status as FAILED',
            {
              label: 'Media Request',
              requestId: entity.id,
              mediaId: entity.media.id,
              lidarrAlbumOptions,
            }
          );

          MediaRequest.sendNotification(
            entity,
            media,
            Notification.MEDIA_FAILED
          );
        });
      runInBackground(sent);
      logger.info('Sent request to Lidarr', {
        label: 'Media Request',
        requestId: entity.id,
        mediaId: entity.media.id,
      });
    } catch (e) {
      const requestRepository = manager.getRepository(MediaRequest);
      const mediaRepository = manager.getRepository(Media);
      const media = await mediaRepository.findOne({
        where: { id: entity.media.id },
      });

      if (media) {
        entity.status = MediaRequestStatus.FAILED;
        await requestRepository.save(entity);

        logger.warn(
          'Failed to send album request to Lidarr due to connection or configuration error, marking status as FAILED',
          {
            label: 'Media Request',
            requestId: entity.id,
            mediaId: entity.media.id,
            errorMessage: e.message,
          }
        );

        MediaRequest.sendNotification(entity, media, Notification.MEDIA_FAILED);
      }
    }
  }

  /**
   * Adds the book to LazyLibrarian if it does not have it yet, then marks
   * the requested format as Wanted and starts a search for it. The ebook and
   * the audiobook of a book are requested on their own.
   */
  public async sendToLazyLibrarian(
    entity: MediaRequest,
    manager: EntityManager
  ): Promise<void> {
    if (
      entity.status !== MediaRequestStatus.APPROVED ||
      entity.type !== MediaType.BOOK ||
      // Only Talearr keeps other recordings of a book
      entity.recording
    ) {
      return;
    }

    try {
      const settings = getSettings();
      if (
        settings.bookService !== 'lazylibrarian' ||
        !isLazyLibrarianConfigured(settings.lazylibrarian)
      ) {
        logger.debug(
          'Books are not requested from LazyLibrarian, skipping request processing',
          {
            label: 'Media Request',
            requestId: entity.id,
            mediaId: entity.media.id,
          }
        );
        return;
      }

      const mediaRepository = manager.getRepository(Media);
      const media = await mediaRepository.findOne({
        where: { id: entity.media.id },
      });

      if (!media?.olId) {
        logger.error('Media data not found', {
          label: 'Media Request',
          requestId: entity.id,
          mediaId: entity.media.id,
        });
        return;
      }

      if (media[getRequestStatusKey(entity)] === MediaStatus.AVAILABLE) {
        logger.warn('Media already exists, marking request as COMPLETED', {
          label: 'Media Request',
          requestId: entity.id,
          mediaId: entity.media.id,
        });

        const requestRepository = manager.getRepository(MediaRequest);
        entity.status = MediaRequestStatus.COMPLETED;
        await requestRepository.save(entity);
        return;
      }

      const lazyLibrarian = new LazyLibrarianAPI(settings.lazylibrarian);
      const bookType = entity.isAudiobook ? 'AudioBook' : 'eBook';
      const olId = media.olId;

      // Run entity asynchronously so we don't wait for it on the UI side.
      // Books are sent one at a time so a bulk request does not flood
      // LazyLibrarian.
      const sent = serviceQueue
        .dispatch(LAZYLIBRARIAN_KEY, async () => {
          const bookId = await addBookToLazyLibrarian(lazyLibrarian, {
            olId,
            // Books keep their LazyLibrarian book id in externalServiceSlug
            bookId: media.externalServiceSlug,
          });
          await lazyLibrarian.queueBook(bookId, bookType);
          await lazyLibrarian.searchBook(bookId, bookType);

          return bookId;
        })
        // Writes back only once the request's transaction has ended
        .finally(() => transactionSettled(manager))
        .then(async (bookId) => {
          // Needs its own repository as this runs detached from the request transaction
          const mediaRepository = getRepository(Media);
          // We grab media again here to make sure we have the latest version of it
          const media = await mediaRepository.findOne({
            where: { id: entity.media.id },
          });

          if (!media) {
            throw new Error('Media data not found');
          }

          if (media.externalServiceSlug !== bookId) {
            media.externalServiceSlug = bookId;
            await saveServiceColumns(media, ['externalServiceSlug']);
          }
        })
        .catch(async (e) => {
          try {
            const requestRepository = getRepository(MediaRequest);

            if (entity.status !== MediaRequestStatus.FAILED) {
              entity.status = MediaRequestStatus.FAILED;
              await requestRepository.save(entity);
            }
          } catch (saveError) {
            logger.error('Failed to mark request as FAILED', {
              label: 'Media Request',
              requestId: entity.id,
              errorMessage:
                saveError instanceof Error
                  ? saveError.message
                  : String(saveError),
            });
          }

          logger.warn(
            'Something went wrong sending book request to LazyLibrarian, marking status as FAILED',
            {
              label: 'Media Request',
              requestId: entity.id,
              mediaId: entity.media.id,
              olId,
              bookType,
              errorMessage: e instanceof Error ? e.message : String(e),
            }
          );

          MediaRequest.sendNotification(
            entity,
            media,
            Notification.MEDIA_FAILED
          );
        });
      runInBackground(sent);
      logger.info('Sent request to LazyLibrarian', {
        label: 'Media Request',
        requestId: entity.id,
        mediaId: entity.media.id,
        bookType,
      });
    } catch (e) {
      const requestRepository = manager.getRepository(MediaRequest);
      const mediaRepository = manager.getRepository(Media);
      const media = await mediaRepository.findOne({
        where: { id: entity.media.id },
      });

      if (media) {
        entity.status = MediaRequestStatus.FAILED;
        await requestRepository.save(entity);

        logger.warn(
          'Failed to send book request to LazyLibrarian due to connection or configuration error, marking status as FAILED',
          {
            label: 'Media Request',
            requestId: entity.id,
            mediaId: entity.media.id,
            errorMessage: e.message,
          }
        );

        MediaRequest.sendNotification(entity, media, Notification.MEDIA_FAILED);
      }
    }
  }

  /**
   * Sends the requested format of a book to Chaptarr: the book is added or
   * monitored there and searched for, and its Chaptarr ids are kept on the
   * media for the scan and for removals. The ebook and the audiobook of a
   * book are requested on their own.
   */
  public async sendToChaptarr(
    entity: MediaRequest,
    manager: EntityManager
  ): Promise<void> {
    if (
      entity.status !== MediaRequestStatus.APPROVED ||
      entity.type !== MediaType.BOOK
    ) {
      return;
    }

    // Another recording of an audiobook goes to Talearr's recordings route
    if (entity.recording) {
      return sendRecordingToTalearr(entity, manager);
    }

    try {
      const settings = getSettings();
      if (!usesChaptarr(settings.bookService)) {
        return;
      }

      const chaptarrSettings =
        (entity.serverId !== null && entity.serverId >= 0
          ? settings.chaptarr.find(
              (chaptarr) => chaptarr.id === entity.serverId
            )
          : undefined) ?? getDefaultChaptarr(settings.chaptarr);

      if (!chaptarrSettings) {
        logger.warn(
          'There is no default Chaptarr server configured. Did you set any of your Chaptarr servers as default?',
          {
            label: 'Media Request',
            requestId: entity.id,
            mediaId: entity.media.id,
          }
        );
        return;
      }

      const mediaRepository = manager.getRepository(Media);
      const media = await mediaRepository.findOne({
        where: { id: entity.media.id },
      });

      if (!media?.olId) {
        logger.error('Media data not found', {
          label: 'Media Request',
          requestId: entity.id,
          mediaId: entity.media.id,
        });
        return;
      }

      if (media[getRequestStatusKey(entity)] === MediaStatus.AVAILABLE) {
        logger.warn('Media already exists, marking request as COMPLETED', {
          label: 'Media Request',
          requestId: entity.id,
          mediaId: entity.media.id,
        });

        const requestRepository = manager.getRepository(MediaRequest);
        entity.status = MediaRequestStatus.COMPLETED;
        await requestRepository.save(entity);
        return;
      }

      const mediaType = entity.isAudiobook ? 'audiobook' : 'ebook';
      const bookIdKey = entity.isAudiobook
        ? 'externalServiceIdAudio'
        : 'externalServiceId';
      const formatSettings = getChaptarrFormatSettings(
        chaptarrSettings,
        mediaType
      );
      const chaptarr = new ChaptarrAPI({
        apiKey: chaptarrSettings.apiKey,
        url: ChaptarrAPI.buildUrl(chaptarrSettings, '/api/v1'),
      });
      const tags = [...(chaptarrSettings.tags ?? [])];

      if (chaptarrSettings.tagRequests) {
        const chaptarrTags = await chaptarr.getTags();
        const label = `${entity.requestedBy.id}-${sanitizeDisplayName(
          entity.requestedBy.displayName
        )}`;
        const userTag =
          chaptarrTags.find(
            (tag) =>
              tag.label.startsWith(entity.requestedBy.id + ' - ') ||
              tag.label.startsWith(entity.requestedBy.id + '-')
          ) ?? (await chaptarr.createTag({ label }));

        if (userTag.id && !tags.includes(userTag.id)) {
          tags.push(userTag.id);
        }
      }

      // A book from another server has other ids there
      const sameServer = media.serviceId === chaptarrSettings.id;
      const olId = media.olId;
      // Requests made before languages could be chosen use the requester's
      const language = isBookLanguage(entity.language)
        ? entity.language
        : getEffectiveBookLanguage(
            entity.requestedBy.settings?.bookLanguage,
            settings.main.bookLanguage
          );

      // Talearr only: the readings of the audiobook asked for. The grab
      // policy of the book is set before it is searched for, and the
      // abridged recording asked for once the book is in Talearr.
      const audiobookVersion = getRequestAudiobookVersion(entity);
      let abridgedRecording = false;
      const prepareSearch = audiobookVersion
        ? async (bookId: number) => {
            ({ abridgedRecording } = await applyBookGrabPolicy(
              chaptarr,
              chaptarrSettings,
              bookId,
              audiobookVersion,
              entity.id
            ));
          }
        : undefined;

      // Run entity asynchronously so we don't wait for it on the UI side.
      // Books are sent to a server one at a time, so the books of an author
      // reach Chaptarr one after another and its author is only added once.
      const sent = serviceQueue
        .dispatch(chaptarrKey(chaptarrSettings.id), async () =>
          sendBookToChaptarr(chaptarr, {
            olId,
            mediaType,
            bookId: sameServer ? media[bookIdKey] : undefined,
            foreignBookId: sameServer ? media.foreignBookId : undefined,
            add: {
              ...formatSettings,
              tags,
              searchForNewBook: !chaptarrSettings.preventSearch,
            },
            language: {
              code: language,
              tags: await getChaptarrLanguageTags(chaptarr, language, {
                requestId: entity.id,
              }),
            },
            prepareSearch,
          })
        )
        // Writes back only once the request's transaction has ended
        .finally(() => transactionSettled(manager))
        .then(async (result) => {
          // Needs its own repository as this runs detached from the request transaction
          const mediaRepository = getRepository(Media);
          // We grab media again here to make sure we have the latest version of it
          const media = await mediaRepository.findOne({
            where: { id: entity.media.id },
          });

          if (!media) {
            throw new Error('Media data not found');
          }

          if (media.serviceId !== chaptarrSettings.id) {
            media.externalServiceId = null;
            media.externalServiceIdAudio = null;
          }
          media.serviceId = chaptarrSettings.id;
          media.foreignBookId = result.foreignBookId;
          if (result.bookId) {
            media[bookIdKey] = result.bookId;
          }
          await saveServiceColumns(media, [
            'serviceId',
            'foreignBookId',
            'externalServiceId',
            'externalServiceIdAudio',
          ]);

          if (audiobookVersion && audiobookVersion !== 'unabridged') {
            if (abridgedRecording && result.bookId) {
              await requestAbridgedRecording(entity, {
                server: chaptarrSettings,
                bookId: result.bookId,
              }).catch((e) => {
                logger.warn(
                  'Could not ask Talearr for the abridged recording',
                  {
                    label: 'Media Request',
                    requestId: entity.id,
                    errorMessage: e instanceof Error ? e.message : String(e),
                  }
                );
              });
            } else if (!result.bookId) {
              logger.info(
                'Talearr is still importing the author, the book follows the global grab policy',
                {
                  label: 'Media Request',
                  requestId: entity.id,
                  audiobookVersion,
                }
              );
            }
          }
        })
        .catch(async (e) => {
          try {
            const requestRepository = getRepository(MediaRequest);

            if (entity.status !== MediaRequestStatus.FAILED) {
              entity.status = MediaRequestStatus.FAILED;
              await requestRepository.save(entity);
            }
          } catch (saveError) {
            logger.error('Failed to mark request as FAILED', {
              label: 'Media Request',
              requestId: entity.id,
              errorMessage:
                saveError instanceof Error
                  ? saveError.message
                  : String(saveError),
            });
          }

          logger.warn(
            'Something went wrong sending book request to Chaptarr, marking status as FAILED',
            {
              label: 'Media Request',
              requestId: entity.id,
              mediaId: entity.media.id,
              olId,
              mediaType,
              errorMessage: e instanceof Error ? e.message : String(e),
            }
          );

          MediaRequest.sendNotification(
            entity,
            media,
            Notification.MEDIA_FAILED
          );
        });
      runInBackground(sent);
      logger.info('Sent request to Chaptarr', {
        label: 'Media Request',
        requestId: entity.id,
        mediaId: entity.media.id,
        mediaType,
      });
    } catch (e) {
      const requestRepository = manager.getRepository(MediaRequest);
      const mediaRepository = manager.getRepository(Media);
      const media = await mediaRepository.findOne({
        where: { id: entity.media.id },
      });

      if (media) {
        entity.status = MediaRequestStatus.FAILED;
        await requestRepository.save(entity);

        logger.warn(
          'Failed to send book request to Chaptarr due to connection or configuration error, marking status as FAILED',
          {
            label: 'Media Request',
            requestId: entity.id,
            mediaId: entity.media.id,
            errorMessage: e.message,
          }
        );

        MediaRequest.sendNotification(entity, media, Notification.MEDIA_FAILED);
      }
    }
  }

  /**
   * Sends an approved comic or manga series to Talearr's comics library: it
   * is added with every volume monitored and searched for, and Talearr's id
   * of it is kept on the media
   */
  public async sendToTalearrComics(
    entity: MediaRequest,
    manager: EntityManager
  ): Promise<void> {
    if (
      entity.status !== MediaRequestStatus.APPROVED ||
      entity.type !== MediaType.COMIC
    ) {
      return;
    }

    try {
      const server = getComicsServer();

      if (!server) {
        logger.warn(
          'Comics need book requests to go to Talearr. Is a default Talearr server set?',
          {
            label: 'Media Request',
            requestId: entity.id,
            mediaId: entity.media.id,
          }
        );
        return;
      }

      const media = await manager.getRepository(Media).findOne({
        where: { id: entity.media.id },
      });

      if (!media?.comicId) {
        logger.error('Media data not found', {
          label: 'Media Request',
          requestId: entity.id,
          mediaId: entity.media.id,
        });
        return;
      }

      if (media.status === MediaStatus.AVAILABLE) {
        logger.warn('Media already exists, marking request as COMPLETED', {
          label: 'Media Request',
          requestId: entity.id,
          mediaId: entity.media.id,
        });

        entity.status = MediaRequestStatus.COMPLETED;
        await manager.getRepository(MediaRequest).save(entity);
        return;
      }

      // A person with an age limit gets the kids library when there is one
      const profile = await manager.getRepository(UserAccessProfile).findOne({
        where: { user: { id: entity.requestedBy.id } },
      });
      const comicId = media.comicId;
      const kind = media.comicKind ?? 'manga';

      const sent = serviceQueue
        .dispatch(chaptarrKey(server.id), () =>
          sendComicToTalearr(server, {
            comicId,
            kind,
            preferKids: isRestricted(profile?.ageLimit),
            volumes: entity.comicVolumes,
          })
        )
        // Writes back only once the request's transaction has ended
        .finally(() => transactionSettled(manager))
        .then(async (result) => {
          const latest = await getRepository(Media).findOne({
            where: { id: entity.media.id },
          });

          if (!latest) {
            throw new Error('Media data not found');
          }

          latest.serviceId = server.id;
          latest.externalServiceId = result.seriesId;
          await saveServiceColumns(latest, ['serviceId', 'externalServiceId']);
        })
        .catch(async (e) => {
          try {
            if (entity.status !== MediaRequestStatus.FAILED) {
              entity.status = MediaRequestStatus.FAILED;
              await getRepository(MediaRequest).save(entity);
            }
          } catch (saveError) {
            logger.error('Failed to mark request as FAILED', {
              label: 'Media Request',
              requestId: entity.id,
              errorMessage:
                saveError instanceof Error
                  ? saveError.message
                  : String(saveError),
            });
          }

          logger.warn(
            'Something went wrong sending comic request to Talearr, marking status as FAILED',
            {
              label: 'Media Request',
              requestId: entity.id,
              mediaId: entity.media.id,
              comicId,
              errorMessage: e instanceof Error ? e.message : String(e),
            }
          );

          MediaRequest.sendNotification(
            entity,
            media,
            Notification.MEDIA_FAILED
          );
        });
      runInBackground(sent);
      logger.info('Sent request to Talearr comics', {
        label: 'Media Request',
        requestId: entity.id,
        mediaId: entity.media.id,
        comicId,
      });
    } catch (e) {
      const media = await manager.getRepository(Media).findOne({
        where: { id: entity.media.id },
      });

      if (media) {
        entity.status = MediaRequestStatus.FAILED;
        await manager.getRepository(MediaRequest).save(entity);

        logger.warn(
          'Failed to send comic request to Talearr due to connection or configuration error, marking status as FAILED',
          {
            label: 'Media Request',
            requestId: entity.id,
            mediaId: entity.media.id,
            errorMessage: e instanceof Error ? e.message : String(e),
          }
        );

        MediaRequest.sendNotification(entity, media, Notification.MEDIA_FAILED);
      }
    }
  }

  public async updateParentStatus(
    manager: EntityManager,
    entity: MediaRequest
  ): Promise<void> {
    // A recording request is for an audiobook that is available already,
    // approving or declining it leaves the book's status alone
    if (entity.recording) {
      return;
    }

    const mediaRepository = manager.getRepository(Media);
    const media = await mediaRepository.findOne({
      where: { id: entity.media.id },
    });
    if (!media) {
      logger.error('Media data not found', {
        label: 'Media Request',
        requestId: entity.id,
        mediaId: entity.media.id,
      });
      return;
    }

    const statusKey = entity.is4k ? 'status4k' : 'status';
    // Audiobook requests follow the book's statusAudio
    const mediaStatusKey = getRequestStatusKey(entity);
    const seasonRequestRepository = manager.getRepository(SeasonRequest);
    const requestRepository = manager.getRepository(MediaRequest);

    if (
      entity.status === MediaRequestStatus.APPROVED &&
      // Do not update the status if the item is already partially available or available
      media[mediaStatusKey] !== MediaStatus.AVAILABLE &&
      media[mediaStatusKey] !== MediaStatus.PARTIALLY_AVAILABLE &&
      media[mediaStatusKey] !== MediaStatus.PROCESSING
    ) {
      media[mediaStatusKey] = MediaStatus.PROCESSING;
      await mediaRepository.save(media);
    }

    if (
      (media.mediaType === MediaType.MOVIE ||
        media.mediaType === MediaType.MUSIC ||
        media.mediaType === MediaType.BOOK ||
        media.mediaType === MediaType.COMIC) &&
      entity.status === MediaRequestStatus.DECLINED &&
      media[mediaStatusKey] !== MediaStatus.DELETED
    ) {
      media[mediaStatusKey] = MediaStatus.UNKNOWN;
      await mediaRepository.save(media);
    }

    /**
     * If the media type is TV, and we are declining a request,
     * we must check if its the only pending request and that
     * there the current media status is just pending (meaning no
     * other requests have yet to be approved)
     */
    if (
      media.mediaType === MediaType.TV &&
      entity.status === MediaRequestStatus.DECLINED &&
      media[statusKey] === MediaStatus.PENDING
    ) {
      const pendingCount = await requestRepository.count({
        where: {
          media: { id: media.id },
          status: MediaRequestStatus.PENDING,
          is4k: entity.is4k,
          id: Not(entity.id),
        },
      });

      if (pendingCount === 0) {
        // Re-fetch media without requests to avoid cascade issues
        const freshMedia = await mediaRepository.findOne({
          where: { id: media.id },
        });
        if (freshMedia) {
          freshMedia[statusKey] = MediaStatus.UNKNOWN;
          await mediaRepository.save(freshMedia);
        }
      }
    }

    // Reset season statuses when a TV request is declined
    if (
      media.mediaType === MediaType.TV &&
      entity.status === MediaRequestStatus.DECLINED
    ) {
      const seasonRepository = manager.getRepository(Season);
      const actualSeasons = await seasonRepository.find({
        where: { media: { id: media.id } },
      });

      for (const seasonRequest of entity.seasons) {
        seasonRequest.status = MediaRequestStatus.DECLINED;
        await seasonRequestRepository.save(seasonRequest);

        const season = actualSeasons.find(
          (s) => s.seasonNumber === seasonRequest.seasonNumber
        );

        if (season && season[statusKey] === MediaStatus.PENDING) {
          const otherActiveRequests = await requestRepository
            .createQueryBuilder('request')
            .leftJoinAndSelect('request.seasons', 'season')
            .where('request.mediaId = :mediaId', { mediaId: media.id })
            .andWhere('request.id != :requestId', { requestId: entity.id })
            .andWhere('request.is4k = :is4k', { is4k: entity.is4k })
            .andWhere('request.status NOT IN (:...statuses)', {
              statuses: [
                MediaRequestStatus.DECLINED,
                MediaRequestStatus.COMPLETED,
              ],
            })
            .andWhere('season.seasonNumber = :seasonNumber', {
              seasonNumber: season.seasonNumber,
            })
            .getCount();

          if (otherActiveRequests === 0) {
            season[statusKey] = MediaStatus.UNKNOWN;
            await seasonRepository.save(season);
          }
        }
      }
    }

    // Approve child seasons if parent is approved
    if (
      media.mediaType === MediaType.TV &&
      entity.status === MediaRequestStatus.APPROVED
    ) {
      for (const season of entity.seasons) {
        season.status = MediaRequestStatus.APPROVED;
        await seasonRequestRepository.save(season);
      }
    }
  }

  /**
   * Book counterpart of handleRemoveParentUpdate, resetting the status of
   * the removed request's format once no other request is after it
   */
  private async handleRemoveBookParentUpdate(
    manager: EntityManager,
    entity: MediaRequest
  ): Promise<void> {
    const fullMedia = await manager.findOneOrFail(Media, {
      where: { id: entity.media.id },
      relations: { requests: true },
    });
    const statusKey = getRequestStatusKey(entity);
    const formatRequests = fullMedia.requests.filter(
      (request) => request.isAudiobook === entity.isAudiobook
    );

    const hasActive = formatRequests.some(
      (request) =>
        request.status !== MediaRequestStatus.COMPLETED &&
        request.status !== MediaRequestStatus.DECLINED
    );

    if (
      !hasActive &&
      fullMedia[statusKey] !== MediaStatus.AVAILABLE &&
      fullMedia[statusKey] !== MediaStatus.PARTIALLY_AVAILABLE
    ) {
      // Re-fetch WITHOUT requests to avoid cascade issues on save
      const cleanMedia = await manager.findOneOrFail(Media, {
        where: { id: entity.media.id },
      });
      const hadCompleted = formatRequests.some(
        (request) => request.status === MediaRequestStatus.COMPLETED
      );

      cleanMedia[statusKey] = hadCompleted
        ? MediaStatus.DELETED
        : MediaStatus.UNKNOWN;
      await manager.save(cleanMedia);
    }
  }

  public async handleRemoveParentUpdate(
    manager: EntityManager,
    entity: MediaRequest
  ): Promise<void> {
    if (entity.recording) {
      return;
    }

    if (entity.type === MediaType.BOOK) {
      return this.handleRemoveBookParentUpdate(manager, entity);
    }

    const fullMedia = await manager.findOneOrFail(Media, {
      where: { id: entity.media.id },
      relations: { requests: { seasons: true }, seasons: true },
    });

    const hasActive = fullMedia.requests.some(
      (request) =>
        !request.is4k &&
        request.status !== MediaRequestStatus.COMPLETED &&
        request.status !== MediaRequestStatus.DECLINED
    );
    const hasActive4k = fullMedia.requests.some(
      (request) =>
        request.is4k &&
        request.status !== MediaRequestStatus.COMPLETED &&
        request.status !== MediaRequestStatus.DECLINED
    );

    const needsStatusUpdate =
      !hasActive &&
      fullMedia.status !== MediaStatus.AVAILABLE &&
      fullMedia.status !== MediaStatus.PARTIALLY_AVAILABLE;

    const needs4kStatusUpdate =
      !hasActive4k &&
      fullMedia.status4k !== MediaStatus.AVAILABLE &&
      fullMedia.status4k !== MediaStatus.PARTIALLY_AVAILABLE;

    if (needsStatusUpdate || needs4kStatusUpdate) {
      // Re-fetch WITHOUT requests to avoid cascade issues on save
      const cleanMedia = await manager.findOneOrFail(Media, {
        where: { id: entity.media.id },
      });

      if (needsStatusUpdate) {
        const hadCompleted = fullMedia.requests.some(
          (r) => !r.is4k && r.status === MediaRequestStatus.COMPLETED
        );
        cleanMedia.status = hadCompleted
          ? MediaStatus.DELETED
          : MediaStatus.UNKNOWN;
      }

      if (needs4kStatusUpdate) {
        const hadCompleted4k = fullMedia.requests.some(
          (r) => r.is4k && r.status === MediaRequestStatus.COMPLETED
        );
        cleanMedia.status4k = hadCompleted4k
          ? MediaStatus.DELETED
          : MediaStatus.UNKNOWN;
      }

      await manager.save(cleanMedia);
    }

    // Reset stale seasons or re-requests fail ("No seasons available to request")
    if (fullMedia.mediaType === MediaType.TV) {
      const statusKey = entity.is4k ? 'status4k' : 'status';
      const removedSeasonNumbers = new Set(
        entity.seasons.map((s) => s.seasonNumber)
      );
      const activeSeasonNumbers = new Set(
        fullMedia.requests
          .filter(
            (request) =>
              request.is4k === entity.is4k &&
              request.status !== MediaRequestStatus.COMPLETED &&
              request.status !== MediaRequestStatus.DECLINED
          )
          .flatMap((request) => request.seasons.map((s) => s.seasonNumber))
      );

      const changedSeasons: Season[] = [];
      for (const season of fullMedia.seasons) {
        if (
          (season[statusKey] === MediaStatus.PENDING ||
            season[statusKey] === MediaStatus.PROCESSING) &&
          removedSeasonNumbers.has(season.seasonNumber) &&
          !activeSeasonNumbers.has(season.seasonNumber)
        ) {
          season[statusKey] = MediaStatus.UNKNOWN;
          changedSeasons.push(season);
        }
      }
      if (changedSeasons.length) {
        await manager.save(changedSeasons);
      }
    }
  }

  public async afterUpdate(event: UpdateEvent<MediaRequest>): Promise<void> {
    if (!event.entity) {
      return;
    }

    try {
      await this.sendToRadarr(event.entity as MediaRequest, event.manager);
      await this.sendToSonarr(event.entity as MediaRequest, event.manager);
      await this.sendToLidarr(event.entity as MediaRequest, event.manager);
      await this.sendToLazyLibrarian(
        event.entity as MediaRequest,
        event.manager
      );
      await this.sendToChaptarr(event.entity as MediaRequest, event.manager);
      await this.sendToTalearrComics(
        event.entity as MediaRequest,
        event.manager
      );
    } catch (e) {
      logger.error('Error while sending to *arr in afterUpdate subscriber', {
        label: 'Media Request',
        requestId: (event.entity as MediaRequest).id,
        errorMessage: e instanceof Error ? e.message : String(e),
      });
    }

    try {
      await withNestedTransaction(event.manager, async (manager) => {
        await this.updateParentStatus(manager, event.entity as MediaRequest);
      });

      if (event.entity.status === MediaRequestStatus.COMPLETED) {
        if (event.entity.media.mediaType === MediaType.MOVIE) {
          await this.notifyAvailableMovie(event.entity as MediaRequest, event);
        }
        if (event.entity.media.mediaType === MediaType.TV) {
          await this.notifyAvailableSeries(event.entity as MediaRequest, event);
        }
        if (event.entity.media.mediaType === MediaType.MUSIC) {
          await this.notifyAvailableMusic(event.entity as MediaRequest, event);
        }
        if (event.entity.media.mediaType === MediaType.BOOK) {
          await this.notifyAvailableBook(event.entity as MediaRequest, event);
        }
        if (event.entity.media.mediaType === MediaType.COMIC) {
          await this.notifyAvailableComic(event.entity as MediaRequest, event);
        }
      }
    } catch (e) {
      logger.error(
        'Error while updating parent status in afterUpdate subscriber',
        {
          label: 'Media Request',
          requestId: (event.entity as MediaRequest).id,
          errorMessage: e instanceof Error ? e.message : String(e),
        }
      );
    }
  }

  public async afterInsert(event: InsertEvent<MediaRequest>): Promise<void> {
    if (!event.entity) {
      return;
    }

    try {
      await this.sendToRadarr(event.entity as MediaRequest, event.manager);
      await this.sendToSonarr(event.entity as MediaRequest, event.manager);
      await this.sendToLidarr(event.entity as MediaRequest, event.manager);
      await this.sendToLazyLibrarian(
        event.entity as MediaRequest,
        event.manager
      );
      await this.sendToChaptarr(event.entity as MediaRequest, event.manager);
      await this.sendToTalearrComics(
        event.entity as MediaRequest,
        event.manager
      );
    } catch (e) {
      logger.error('Error while sending to *arr in afterInsert subscriber', {
        label: 'Media Request',
        requestId: (event.entity as MediaRequest).id,
        errorMessage: e instanceof Error ? e.message : String(e),
      });
    }

    try {
      await withNestedTransaction(event.manager, async (manager) => {
        await this.updateParentStatus(manager, event.entity as MediaRequest);
      });
    } catch (e) {
      logger.error(
        'Error while updating parent status in afterInsert subscriber',
        {
          label: 'Media Request',
          requestId: (event.entity as MediaRequest).id,
          errorMessage: e instanceof Error ? e.message : String(e),
        }
      );
    }
  }

  public async afterRemove(event: RemoveEvent<MediaRequest>): Promise<void> {
    if (!event.entity) {
      return;
    }

    await this.handleRemoveParentUpdate(
      event.manager as EntityManager,
      event.entity as MediaRequest
    );
  }

  public afterTransactionCommit(event: TransactionCommitEvent): void {
    releaseTransactionWaiters(event.queryRunner);
  }

  public afterTransactionRollback(event: TransactionRollbackEvent): void {
    releaseTransactionWaiters(event.queryRunner);
  }

  public listenTo(): typeof MediaRequest {
    return MediaRequest;
  }
}
