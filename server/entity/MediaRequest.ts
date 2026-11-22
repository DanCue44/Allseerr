import MusicBrainz from '@server/api/musicbrainz';
import type { MbReleaseGroup } from '@server/api/musicbrainz/interfaces';
import OpenLibrary, { getOlId } from '@server/api/openlibrary';
import TheMovieDb from '@server/api/themoviedb';
import type {
  TmdbMovieDetails,
  TmdbTvDetails,
} from '@server/api/themoviedb/interfaces';
import type { AudiobookVersion } from '@server/constants/audiobookVersion';
import {
  getAudiobookVersionsMode,
  isAudiobookVersion,
} from '@server/constants/audiobookVersion';
import {
  getBookLanguageName,
  isBookLanguage,
  resolveRequestBookLanguage,
} from '@server/constants/bookLanguages';
import type { BookRecordingKind } from '@server/constants/bookRecording';
import {
  MAX_RECORDING_NARRATOR_LENGTH,
  describeBookRecording,
  isBookRecordingKind,
} from '@server/constants/bookRecording';
import { isTalearrService } from '@server/constants/bookService';
import {
  MediaRequestMonitorMode,
  MediaRequestStatus,
  MediaStatus,
  MediaType,
  isComicKind,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import type { MediaRequestBody } from '@server/interfaces/api/requestInterfaces';
import {
  getBookFormatName,
  getBookNotificationDetails,
} from '@server/lib/bookNotifications';
import { getRequestStatusKey } from '@server/lib/bookRequests';
import {
  formatRequestedVolumes,
  getRequestedComicVolumes,
  holdsComicVolumes,
  parseComicVolumes,
} from '@server/lib/comicVolumes';
import {
  findLibrarySeries,
  getComicNotificationDetails,
  getComicVolumeList,
  getComicsServer,
  getLibrarySeries,
  hasEveryVolume,
  isComicId,
  isVolumeInLibrary,
} from '@server/lib/comics';
import {
  MOVIE_RATINGS,
  TV_RATINGS,
  exceedsRatingLimit,
  getMovieCertification,
  getTvContentRating,
} from '@server/lib/contentRatingLimit';
import type { RequestedSeason } from '@server/lib/episodeRequests';
import {
  buildRequestedSeasons,
  filterRequestableSeasons,
  formatRequestedSeasons,
  getCurrentSeasonNumber,
  getFutureSeasonNumbers,
  getTmdbSeasonInfo,
} from '@server/lib/episodeRequests';
import type { GenreBlockType } from '@server/lib/genreBlock';
import {
  findBlockedGenres,
  getEffectiveBlockedGenres,
  parseGenreList,
} from '@server/lib/genreBlock';
import { getMusicNotificationDetails } from '@server/lib/musicNotifications';
import notificationManager, { Notification } from '@server/lib/notifications';
import overrideRules, {
  matchesAutoApproveRule,
} from '@server/lib/overrideRules';
import { Permission } from '@server/lib/permissions';
import { getAvailableSeasonNumbers } from '@server/lib/seasonRollover';
import { getSettings } from '@server/lib/settings';
import {
  getRecordingTarget,
  isActiveRecordingRequest,
  isSameRecording,
} from '@server/lib/talearrRecordings';
import type { AgeLimit } from '@server/lib/userAccess/ageLimits';
import {
  canRequestComic,
  canRequestWork,
  isRestricted,
} from '@server/lib/userAccess/ageLimits';
import { getBlockingProviders } from '@server/lib/watchProviderBlock';
import logger from '@server/logger';
import { DbAwareColumn, resolveDbType } from '@server/utils/DbColumnHelper';
import requestLock, {
  mediaKey,
  mediaLock,
  userKey,
} from '@server/utils/requestLock';
import { truncate } from 'lodash';
import {
  AfterInsert,
  AfterLoad,
  AfterUpdate,
  Column,
  Entity,
  Index,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  RelationCount,
  UpdateDateColumn,
} from 'typeorm';
import Media from './Media';
import MetadataComic from './MetadataComic';
import { episodeNumbersTransformer } from './Season';
import SeasonRequest from './SeasonRequest';
import { User } from './User';
import { UserAccessProfile } from './UserAccessProfile';

export class RequestPermissionError extends Error {}
export class QuotaRestrictedError extends Error {}
export class DuplicateMediaRequestError extends Error {}
export class NoSeasonsAvailableError extends Error {}
export class BlocklistedMediaError extends Error {}
export class WatchProviderBlockedError extends Error {}
export class ContentRatingRestrictedError extends Error {}
export class GenreBlockedError extends Error {}
export class InvalidBookLanguageError extends Error {}
export class InvalidRecordingRequestError extends Error {}
export class InvalidAudiobookVersionError extends Error {}
export class InvalidComicRequestError extends Error {}

type MediaRequestOptions = {
  isAutoRequest?: boolean;
  // A bulk request sends one summary notification for all of its requests
  // instead of one per request
  skipNotification?: boolean;
  // The caller already found the release group or work, as a bulk request
  // does in the artist's discography or the author's works, so it is not
  // looked up again one at a time
  skipMetadataLookup?: boolean;
};

@Entity()
export class MediaRequest {
  public static async request(
    requestBody: MediaRequestBody,
    user: User,
    options: MediaRequestOptions = {}
  ): Promise<MediaRequest> {
    // is4k is optional, and an undefined one binds as null in the duplicate query
    const body = {
      ...requestBody,
      is4k: !!requestBody.is4k,
      isAudiobook: !!requestBody.isAudiobook,
    };

    // Only a caller allowed to set the request user may queue on their lock
    const lockUserId =
      body.userId &&
      user.hasPermission([Permission.MANAGE_USERS, Permission.MANAGE_REQUESTS])
        ? body.userId
        : user.id;

    // No is4k in the key: one media row holds both statuses, so a 4k and a
    // non-4k request for the same title race to create it
    return requestLock.dispatch(userKey(lockUserId), () =>
      mediaLock.dispatch(mediaKey(body.mediaType, body.mediaId), () =>
        MediaRequest.createRequest(body, user, options)
      )
    );
  }

  private static async createRequest(
    requestBody: MediaRequestBody,
    user: User,
    options: MediaRequestOptions
  ): Promise<MediaRequest> {
    const tmdb = new TheMovieDb();
    const mediaRepository = getRepository(Media);
    const requestRepository = getRepository(MediaRequest);
    const userRepository = getRepository(User);
    const settings = getSettings();

    let requestUser = user;

    if (
      requestBody.userId &&
      !requestUser.hasPermission([
        Permission.MANAGE_USERS,
        Permission.MANAGE_REQUESTS,
      ])
    ) {
      throw new RequestPermissionError(
        'You do not have permission to modify the request user.'
      );
    } else if (requestBody.userId) {
      requestUser = await userRepository.findOneOrFail({
        where: { id: requestBody.userId },
      });
    }

    if (!requestUser) {
      throw new Error('User missing from request context.');
    }

    if (requestBody.mediaType === MediaType.MUSIC) {
      return MediaRequest.createMusicRequest(
        requestBody,
        user,
        requestUser,
        options
      );
    }

    if (
      requestBody.mediaType === MediaType.BOOK &&
      requestBody.recording !== undefined &&
      requestBody.recording !== null
    ) {
      return MediaRequest.createRecordingRequest(
        requestBody,
        user,
        requestUser,
        options
      );
    }

    if (requestBody.mediaType === MediaType.COMIC) {
      return MediaRequest.createComicRequest(
        requestBody,
        user,
        requestUser,
        options
      );
    }

    if (requestBody.mediaType === MediaType.BOOK) {
      return MediaRequest.createBookRequest(
        requestBody,
        user,
        requestUser,
        options
      );
    }

    // Movies and series are keyed on their TMDB id
    requestBody = { ...requestBody, mediaId: Number(requestBody.mediaId) };
    const tmdbId = requestBody.mediaId as number;

    if (
      requestBody.mediaType === MediaType.MOVIE &&
      !requestUser.hasPermission(
        requestBody.is4k
          ? [Permission.REQUEST_4K, Permission.REQUEST_4K_MOVIE]
          : [Permission.REQUEST, Permission.REQUEST_MOVIE],
        {
          type: 'or',
        }
      )
    ) {
      throw new RequestPermissionError(
        `You do not have permission to make ${
          requestBody.is4k ? '4K ' : ''
        }movie requests.`
      );
    } else if (
      requestBody.mediaType === MediaType.TV &&
      !requestUser.hasPermission(
        requestBody.is4k
          ? [Permission.REQUEST_4K, Permission.REQUEST_4K_TV]
          : [Permission.REQUEST, Permission.REQUEST_TV],
        {
          type: 'or',
        }
      )
    ) {
      throw new RequestPermissionError(
        `You do not have permission to make ${
          requestBody.is4k ? '4K ' : ''
        }series requests.`
      );
    }

    const quotas = await requestUser.getQuota();

    const canBypassQuota = user.hasPermission(Permission.MANAGE_REQUESTS);
    const ignoreQuota =
      requestBody.ignoreQuota === true &&
      canBypassQuota &&
      ((requestBody.mediaType === MediaType.MOVIE
        ? quotas.movie.limit
        : quotas.tv.limit) ?? 0) > 0;

    if (!ignoreQuota) {
      if (requestBody.ignoreQuota && !canBypassQuota) {
        throw new RequestPermissionError(
          'You do not have permission to bypass user quota limits.'
        );
      } else if (
        requestBody.mediaType === MediaType.MOVIE &&
        quotas.movie.restricted
      ) {
        throw new QuotaRestrictedError('Movie Quota exceeded.');
      } else if (
        requestBody.mediaType === MediaType.TV &&
        quotas.tv.restricted
      ) {
        throw new QuotaRestrictedError('Series Quota exceeded.');
      }
    }

    const tmdbMedia =
      requestBody.mediaType === MediaType.MOVIE
        ? await tmdb.getMovie({ movieId: tmdbId })
        : await tmdb.getTvShow({ tvId: tmdbId });

    // Managers may request blocked titles by hand, but never through an
    // auto-request such as watchlist sync
    const canBypassWatchProviderBlock =
      !options.isAutoRequest && user.hasPermission(Permission.MANAGE_REQUESTS);
    const blockingProviders = canBypassWatchProviderBlock
      ? []
      : getBlockingProviders(tmdbMedia['watch/providers']?.results);

    if (blockingProviders.length > 0) {
      logger.warn('Request for media blocked due to a streaming provider', {
        tmdbId: tmdbMedia.id,
        mediaType: requestBody.mediaType,
        providers: blockingProviders.map((provider) => provider.name),
        label: 'Media Request',
      });

      throw new WatchProviderBlockedError(
        `This title is streaming on ${blockingProviders
          .map((provider) => provider.name)
          .join(', ')} and cannot be requested.`
      );
    }

    // Managers may request titles above the rating limit by hand, but never
    // through an auto-request such as watchlist sync. Titles without a US
    // rating are allowed.
    const canBypassRatingLimit =
      !options.isAutoRequest && user.hasPermission(Permission.MANAGE_REQUESTS);
    const rating =
      requestBody.mediaType === MediaType.MOVIE
        ? getMovieCertification((tmdbMedia as TmdbMovieDetails).release_dates)
        : getTvContentRating((tmdbMedia as TmdbTvDetails).content_ratings);
    const ratingLimit =
      requestBody.mediaType === MediaType.MOVIE
        ? requestUser.movieRatingLimit
        : requestUser.tvRatingLimit;

    if (
      !canBypassRatingLimit &&
      exceedsRatingLimit(
        requestBody.mediaType === MediaType.MOVIE ? MOVIE_RATINGS : TV_RATINGS,
        rating,
        ratingLimit
      )
    ) {
      logger.warn('Request for media blocked due to the content rating limit', {
        tmdbId: tmdbMedia.id,
        mediaType: requestBody.mediaType,
        rating,
        ratingLimit,
        userId: requestUser.id,
        label: 'Media Request',
      });

      throw new ContentRatingRestrictedError(
        `This title is rated ${rating} and exceeds the content rating limit of ${ratingLimit}.`
      );
    }

    MediaRequest.checkBlockedGenres(
      requestBody.mediaType === MediaType.MOVIE ? 'movie' : 'tv',
      tmdbMedia.genres,
      user,
      requestUser,
      options,
      { tmdbId: tmdbMedia.id }
    );

    let media = await mediaRepository.findOne({
      where: {
        tmdbId,
        mediaType: requestBody.mediaType,
      },
      relations: ['requests'],
    });

    if (!media) {
      media = new Media({
        tmdbId: tmdbMedia.id,
        tvdbId: requestBody.tvdbId ?? tmdbMedia.external_ids.tvdb_id,
        status: !requestBody.is4k ? MediaStatus.PENDING : MediaStatus.UNKNOWN,
        status4k: requestBody.is4k ? MediaStatus.PENDING : MediaStatus.UNKNOWN,
        mediaType: requestBody.mediaType,
      });
    } else {
      if (media.status === MediaStatus.BLOCKLISTED) {
        logger.warn('Request for media blocked due to being blocklisted', {
          tmdbId: tmdbMedia.id,
          mediaType: requestBody.mediaType,
          label: 'Media Request',
        });

        throw new BlocklistedMediaError('This media is blocklisted.');
      }

      if (
        (media.status === MediaStatus.UNKNOWN ||
          media.status === MediaStatus.DELETED) &&
        !requestBody.is4k
      ) {
        media.status = MediaStatus.PENDING;
      }

      if (
        (media.status4k === MediaStatus.UNKNOWN ||
          media.status4k === MediaStatus.DELETED) &&
        requestBody.is4k
      ) {
        media.status4k = MediaStatus.PENDING;
      }
    }

    const existing = await requestRepository
      .createQueryBuilder('request')
      .leftJoinAndSelect('request.media', 'media')
      .leftJoinAndSelect('request.requestedBy', 'user')
      .where('request.is4k = :is4k', { is4k: requestBody.is4k })
      .andWhere('media.tmdbId = :tmdbId', { tmdbId: tmdbMedia.id })
      .andWhere('media.mediaType = :mediaType', {
        mediaType: requestBody.mediaType,
      })
      .getMany();

    if (existing && existing.length > 0) {
      // If there is an existing movie request that isn't declined, don't allow a new one.
      if (
        requestBody.mediaType === MediaType.MOVIE &&
        existing[0].status !== MediaRequestStatus.DECLINED &&
        existing[0].status !== MediaRequestStatus.COMPLETED
      ) {
        logger.warn('Duplicate request for media blocked', {
          tmdbId: tmdbMedia.id,
          mediaType: requestBody.mediaType,
          is4k: requestBody.is4k,
          label: 'Media Request',
        });

        throw new DuplicateMediaRequestError(
          'Request for this media already exists.'
        );
      }

      // If an existing auto-request for this media exists from the same user,
      // don't allow a new one.
      const statusKey = requestBody.is4k ? 'status4k' : 'status';
      if (
        existing.find(
          (r) =>
            r.requestedBy.id === requestUser.id &&
            r.isAutoRequest &&
            r.media?.[statusKey] !== MediaStatus.DELETED
        )
      ) {
        throw new DuplicateMediaRequestError(
          'Auto-request for this media and user already exists.'
        );
      }
    }

    const isAdvanced = user.hasPermission(
      [Permission.MANAGE_REQUESTS, Permission.REQUEST_ADVANCED],
      { type: 'or' }
    );

    const requestsServer =
      isAdvanced && requestBody.serverId != null && requestBody.serverId >= 0;

    // An unknown serverId, or one for the other 4K type, falls back to the default server
    const requestedServiceId =
      requestsServer &&
      (requestBody.mediaType === MediaType.MOVIE
        ? settings.radarr
        : settings.sonarr
      ).some(
        (server) =>
          server.id === requestBody.serverId && server.is4k === requestBody.is4k
      )
        ? requestBody.serverId
        : undefined;

    const useRequestedOptions =
      isAdvanced && (!requestsServer || requestedServiceId !== undefined);

    let rootFolder = useRequestedOptions ? requestBody.rootFolder : undefined;
    let profileId = useRequestedOptions ? requestBody.profileId : undefined;
    let tags = useRequestedOptions ? requestBody.tags : undefined;
    const languageProfileId = useRequestedOptions
      ? requestBody.languageProfileId
      : undefined;

    const ruleResult = await overrideRules({
      mediaType: requestBody.mediaType,
      is4k: requestBody.is4k || false,
      serviceId: requestedServiceId,
      tmdbMedia,
      requestUser,
      tags,
    });
    // Advanced users pick these in the modal, so we don't want to override them if they are set
    const overrideRulesResult = isAdvanced
      ? {
          rootFolder: rootFolder ? null : ruleResult.rootFolder,
          profileId: profileId ? null : ruleResult.profileId,
          tags: tags ? null : ruleResult.tags,
        }
      : ruleResult;
    if (overrideRulesResult.rootFolder) {
      rootFolder = overrideRulesResult.rootFolder;
    }
    if (overrideRulesResult.profileId) {
      profileId = overrideRulesResult.profileId;
    }
    if (overrideRulesResult.tags) {
      tags = overrideRulesResult.tags;
    }
    if (
      overrideRulesResult.rootFolder ||
      overrideRulesResult.profileId ||
      overrideRulesResult.tags
    ) {
      logger.debug('Override rule applied.', {
        label: 'Override Rules',
        overrides: overrideRulesResult,
      });
    }

    if (requestBody.mediaType === MediaType.MOVIE) {
      // If the user is an admin or has the "auto approve" permission, or an
      // auto-approve rule matches, automatically approve the request
      const hasAutoApprovePermission = user.hasPermission(
        [
          requestBody.is4k
            ? Permission.AUTO_APPROVE_4K
            : Permission.AUTO_APPROVE,
          requestBody.is4k
            ? Permission.AUTO_APPROVE_4K_MOVIE
            : Permission.AUTO_APPROVE_MOVIE,
          Permission.MANAGE_REQUESTS,
        ],
        { type: 'or' }
      );
      const isAutoApproved =
        hasAutoApprovePermission ||
        (await MediaRequest.isAutoApprovedByRule(
          requestBody,
          tmdbMedia,
          requestUser
        ));

      await mediaRepository.save(media);

      const request = new MediaRequest({
        type: MediaType.MOVIE,
        media,
        requestedBy: requestUser,
        status: isAutoApproved
          ? MediaRequestStatus.APPROVED
          : MediaRequestStatus.PENDING,
        modifiedBy: hasAutoApprovePermission ? user : undefined,
        is4k: requestBody.is4k,
        serverId: requestedServiceId,
        profileId: profileId,
        rootFolder: rootFolder,
        tags: tags,
        isAutoRequest: options.isAutoRequest ?? false,
        ignoreQuota,
      });

      await requestRepository.save(request);
      return request;
    } else {
      const tmdbMediaShow = tmdbMedia as Awaited<
        ReturnType<typeof tmdb.getTvShow>
      >;
      const isFutureOnly =
        requestBody.monitorMode === MediaRequestMonitorMode.FUTURE;
      const isCurrentOnly =
        requestBody.monitorMode === MediaRequestMonitorMode.CURRENT;

      if (
        !settings.main.partialRequestsEnabled &&
        (isFutureOnly || (requestBody.episodes ?? []).length > 0)
      ) {
        throw new RequestPermissionError(
          'Partial series requests are disabled.'
        );
      }

      // Managers can always request only the current season, the setting
      // decides whether everyone else can
      if (
        isCurrentOnly &&
        !settings.main.allowCurrentSeasonRequests &&
        !user.hasPermission(Permission.MANAGE_REQUESTS)
      ) {
        throw new RequestPermissionError(
          'Current season requests are disabled.'
        );
      }

      let requestedSeasons: RequestedSeason[];

      if (isFutureOnly) {
        // Sonarr decides which episodes are still to come, we only track the
        // seasons that are airing or announced so availability can follow them
        requestedSeasons = getFutureSeasonNumbers(
          getTmdbSeasonInfo(tmdbMediaShow)
        ).map((seasonNumber) => ({ seasonNumber, episodes: null }));
      } else if (isCurrentOnly) {
        // The Sonarr scan moves the request to each new season as it starts
        const currentSeason = getCurrentSeasonNumber(
          getTmdbSeasonInfo(tmdbMediaShow)
        );

        requestedSeasons =
          currentSeason !== null
            ? [{ seasonNumber: currentSeason, episodes: null }]
            : [];
      } else {
        requestedSeasons = buildRequestedSeasons(
          requestBody.seasons === 'all'
            ? tmdbMediaShow.seasons
                .filter(
                  (season) =>
                    season.season_number !== 0 && season.episode_count > 0
                )
                .map((season) => season.season_number)
            : ((requestBody.seasons as number[] | undefined) ?? []),
          requestBody.episodes
        );
      }
      if (!settings.main.enableSpecialEpisodes) {
        requestedSeasons = requestedSeasons.filter(
          (season) => season.seasonNumber > 0
        );
      }

      // We need to check existing requests on this title to make sure we don't double up on seasons that were
      // already requested, along with seasons that are available/partially available but don't have existing
      // requests. In the case they were, we just throw out any duplicates but still approve the request.
      // (Unless there are no seasons, in which case we abort)
      const finalSeasons = filterRequestableSeasons({
        requested: requestedSeasons,
        requests: media.requests ?? [],
        seasons: media.seasons ?? [],
        is4k: !!requestBody.is4k,
      });

      // An episode request counts as one season against quotas and rules
      if (finalSeasons.length === 0) {
        throw new NoSeasonsAvailableError('No seasons available to request');
      } else if (
        !ignoreQuota &&
        quotas.tv.limit &&
        finalSeasons.length > (quotas.tv.remaining ?? 0)
      ) {
        throw new QuotaRestrictedError('Series Quota exceeded.');
      }

      // If the user is an admin or has the "auto approve" permission, or an
      // auto-approve rule matches, automatically approve the request
      const hasAutoApprovePermission = user.hasPermission(
        [
          requestBody.is4k
            ? Permission.AUTO_APPROVE_4K
            : Permission.AUTO_APPROVE,
          requestBody.is4k
            ? Permission.AUTO_APPROVE_4K_TV
            : Permission.AUTO_APPROVE_TV,
          Permission.MANAGE_REQUESTS,
        ],
        { type: 'or' }
      );
      const isAutoApproved =
        hasAutoApprovePermission ||
        (await MediaRequest.isAutoApprovedByRule(
          requestBody,
          tmdbMedia,
          requestUser,
          finalSeasons.length
        ));

      await mediaRepository.save(media);

      const request = new MediaRequest({
        type: MediaType.TV,
        media,
        requestedBy: requestUser,
        status: isAutoApproved
          ? MediaRequestStatus.APPROVED
          : MediaRequestStatus.PENDING,
        modifiedBy: hasAutoApprovePermission ? user : undefined,
        is4k: requestBody.is4k,
        serverId: requestedServiceId,
        profileId: profileId,
        rootFolder: rootFolder,
        languageProfileId: languageProfileId,
        tags: tags,
        seasons: finalSeasons.map(
          (season) =>
            new SeasonRequest({
              seasonNumber: season.seasonNumber,
              episodes: season.episodes,
              status: isAutoApproved
                ? MediaRequestStatus.APPROVED
                : MediaRequestStatus.PENDING,
            })
        ),
        monitorMode: isFutureOnly
          ? MediaRequestMonitorMode.FUTURE
          : isCurrentOnly
            ? MediaRequestMonitorMode.CURRENT
            : null,
        preexistingSeasons: isCurrentOnly
          ? getAvailableSeasonNumbers(media.seasons ?? [], !!requestBody.is4k)
          : null,
        isAutoRequest: options.isAutoRequest ?? false,
        ignoreQuota,
      });

      await requestRepository.save(request);
      return request;
    }
  }

  /**
   * Applies the music or book quota of the request user the way movie quotas
   * are applied, and returns whether the request is exempt from the quota.
   */
  private static async checkQuota(
    requestBody: MediaRequestBody,
    user: User,
    requestUser: User,
    type: MediaType.MUSIC | MediaType.BOOK
  ): Promise<boolean> {
    const quotas = await requestUser.getQuota();
    const quota = type === MediaType.MUSIC ? quotas.music : quotas.book;

    const canBypassQuota = user.hasPermission(Permission.MANAGE_REQUESTS);
    const ignoreQuota =
      requestBody.ignoreQuota === true &&
      canBypassQuota &&
      (quota.limit ?? 0) > 0;

    if (!ignoreQuota) {
      if (requestBody.ignoreQuota && !canBypassQuota) {
        throw new RequestPermissionError(
          'You do not have permission to bypass user quota limits.'
        );
      } else if (quota.restricted) {
        throw new QuotaRestrictedError(
          type === MediaType.MUSIC
            ? 'Music Quota exceeded.'
            : 'Book Quota exceeded.'
        );
      }
    }

    return ignoreQuota;
  }

  /**
   * Albums are requested one at a time and keyed on their MusicBrainz release
   * group id. There is no 4K or content rating for music.
   */
  private static async createMusicRequest(
    requestBody: MediaRequestBody,
    user: User,
    requestUser: User,
    options: MediaRequestOptions
  ): Promise<MediaRequest> {
    const mediaRepository = getRepository(Media);
    const requestRepository = getRepository(MediaRequest);
    const mbId = String(requestBody.mediaId);

    if (
      !requestUser.hasPermission(
        [Permission.REQUEST, Permission.REQUEST_MUSIC],
        {
          type: 'or',
        }
      )
    ) {
      throw new RequestPermissionError(
        'You do not have permission to make music requests.'
      );
    }

    if (requestBody.is4k) {
      throw new RequestPermissionError('Music cannot be requested in 4K.');
    }

    const ignoreQuota = await MediaRequest.checkQuota(
      requestBody,
      user,
      requestUser,
      MediaType.MUSIC
    );

    // Makes sure the release group exists before anything is saved. A bulk
    // request looks it up only when its genres have to be checked.
    const releaseGroup: Pick<MbReleaseGroup, 'id' | 'genres' | 'tags'> =
      options.skipMetadataLookup &&
      !MediaRequest.hasBlockedGenres('music', user, requestUser, options)
        ? { id: mbId }
        : await new MusicBrainz().getAlbum({ releaseGroupId: mbId });

    MediaRequest.checkBlockedGenres(
      'music',
      [...(releaseGroup.genres ?? []), ...(releaseGroup.tags ?? [])].map(
        (genre) => genre.name
      ),
      user,
      requestUser,
      options,
      { mbId }
    );

    let media = await mediaRepository.findOne({
      where: { mbId: releaseGroup.id, mediaType: MediaType.MUSIC },
      relations: ['requests'],
    });

    if (!media) {
      media = new Media({
        mbId: releaseGroup.id,
        status: MediaStatus.PENDING,
        mediaType: MediaType.MUSIC,
      });
    } else {
      if (media.status === MediaStatus.BLOCKLISTED) {
        logger.warn('Request for media blocked due to being blocklisted', {
          mbId: releaseGroup.id,
          mediaType: requestBody.mediaType,
          label: 'Media Request',
        });

        throw new BlocklistedMediaError('This media is blocklisted.');
      }

      if (
        media.status === MediaStatus.UNKNOWN ||
        media.status === MediaStatus.DELETED
      ) {
        media.status = MediaStatus.PENDING;
      }
    }

    // An album is requested as a whole, like a movie
    const existing = (media.requests ?? []).find(
      (request) =>
        request.status !== MediaRequestStatus.DECLINED &&
        request.status !== MediaRequestStatus.COMPLETED
    );

    if (existing) {
      logger.warn('Duplicate request for media blocked', {
        mbId: releaseGroup.id,
        mediaType: requestBody.mediaType,
        label: 'Media Request',
      });

      throw new DuplicateMediaRequestError(
        'Request for this media already exists.'
      );
    }

    let rootFolder = requestBody.rootFolder;
    let profileId = requestBody.profileId;
    let tags = requestBody.tags;

    const ruleResult = await overrideRules({
      mediaType: MediaType.MUSIC,
      is4k: false,
      requestUser,
      tags,
      serviceId: requestBody.serverId ?? undefined,
    });
    const isAdvanced = user.hasPermission(
      [Permission.MANAGE_REQUESTS, Permission.REQUEST_ADVANCED],
      { type: 'or' }
    );
    // Advanced users pick these in the modal, so we don't want to override them if they are set
    if (ruleResult.rootFolder && (!isAdvanced || !rootFolder)) {
      rootFolder = ruleResult.rootFolder;
    }
    if (ruleResult.profileId && (!isAdvanced || !profileId)) {
      profileId = ruleResult.profileId;
    }
    if (ruleResult.tags && (!isAdvanced || !tags)) {
      tags = ruleResult.tags;
    }

    // If the user is an admin or has the "auto approve" permission, or an
    // auto-approve rule matches, automatically approve the request
    const hasAutoApprovePermission = user.hasPermission(
      [Permission.AUTO_APPROVE, Permission.MANAGE_REQUESTS],
      { type: 'or' }
    );
    const isAutoApproved =
      hasAutoApprovePermission ||
      (await matchesAutoApproveRule({
        mediaType: MediaType.MUSIC,
        is4k: false,
        requestUser,
        serviceId: requestBody.serverId ?? undefined,
      }));

    await mediaRepository.save(media);

    const request = new MediaRequest({
      type: MediaType.MUSIC,
      media,
      requestedBy: requestUser,
      status: isAutoApproved
        ? MediaRequestStatus.APPROVED
        : MediaRequestStatus.PENDING,
      modifiedBy: hasAutoApprovePermission ? user : undefined,
      is4k: false,
      serverId: requestBody.serverId,
      profileId,
      rootFolder,
      tags,
      isAutoRequest: options.isAutoRequest ?? false,
      ignoreQuota,
      skipNotification: options.skipNotification,
    });

    await requestRepository.save(request);
    return request;
  }

  /**
   * Whether a genre block can refuse this request: the person it is for has
   * blocked genres of this type, and it is not a manager requesting by hand.
   */
  private static hasBlockedGenres(
    type: GenreBlockType,
    user: User,
    requestUser: User,
    options: MediaRequestOptions
  ): boolean {
    if (
      !options.isAutoRequest &&
      user.hasPermission(Permission.MANAGE_REQUESTS)
    ) {
      return false;
    }

    return (
      parseGenreList(
        getEffectiveBlockedGenres(
          requestUser.blockedGenres,
          getSettings().main.blockedGenres
        )[type]
      ).length > 0
    );
  }

  /**
   * Refuses a title in a genre blocked for the person a request is for.
   * Managers may request it by hand, but never through an auto-request
   * such as watchlist sync.
   */
  private static checkBlockedGenres(
    type: GenreBlockType,
    genres: { id?: number; name: string }[] | string[] | undefined,
    user: User,
    requestUser: User,
    options: MediaRequestOptions,
    logDetails: Record<string, unknown>
  ): void {
    if (!MediaRequest.hasBlockedGenres(type, user, requestUser, options)) {
      return;
    }

    const blocked = findBlockedGenres(
      type,
      genres,
      getEffectiveBlockedGenres(
        requestUser.blockedGenres,
        getSettings().main.blockedGenres
      )
    );

    if (blocked.length > 0) {
      logger.warn('Request for media blocked due to its genre', {
        ...logDetails,
        mediaType: type,
        genres: blocked,
        userId: requestUser.id,
        label: 'Media Request',
      });

      throw new GenreBlockedError(
        `This title is in a blocked genre (${blocked.join(', ')}) and cannot be requested.`
      );
    }
  }

  /**
   * Books are requested per format: an ebook and an audiobook are two
   * requests on the same media, the way 4K and non-4K requests are. Books are
   * keyed on their OpenLibrary work id and have no content rating, and
   * LazyLibrarian takes no request options. Each format counts as one request
   * against the book quota. Request Books grants book requests on its own,
   * the way Request Music does for albums.
   */
  /**
   * The age limit of the person a request is for, null without one. Admins
   * are never limited.
   */
  public static async getRequestAgeLimit(
    requestUser: User
  ): Promise<AgeLimit | null> {
    if (requestUser.hasPermission(Permission.ADMIN)) {
      return null;
    }

    const profile = await getRepository(UserAccessProfile).findOne({
      where: { user: { id: requestUser.id } },
    });

    return isRestricted(profile?.ageLimit) ? profile.ageLimit : null;
  }

  private static async createBookRequest(
    requestBody: MediaRequestBody,
    user: User,
    requestUser: User,
    options: MediaRequestOptions
  ): Promise<MediaRequest> {
    const mediaRepository = getRepository(Media);
    const requestRepository = getRepository(MediaRequest);
    const isAudiobook = !!requestBody.isAudiobook;
    const statusKey = getRequestStatusKey({ isAudiobook });

    if (
      !requestUser.hasPermission(
        [Permission.REQUEST, Permission.REQUEST_BOOK],
        {
          type: 'or',
        }
      )
    ) {
      throw new RequestPermissionError(
        'You do not have permission to make book requests.'
      );
    }

    if (requestBody.is4k) {
      throw new RequestPermissionError('Books cannot be requested in 4K.');
    }

    if (
      requestBody.language !== undefined &&
      requestBody.language !== null &&
      !isBookLanguage(requestBody.language)
    ) {
      throw new InvalidBookLanguageError('Unknown book language.');
    }

    if (
      requestBody.audiobookVersion !== undefined &&
      requestBody.audiobookVersion !== null &&
      !isAudiobookVersion(requestBody.audiobookVersion)
    ) {
      throw new InvalidAudiobookVersionError('Unknown audiobook version.');
    }

    // The version is kept only where the requester may pick one: an
    // audiobook on Talearr with the setting at `requester`. Anywhere else
    // it is ignored, so clients may always send it.
    const audiobookVersion =
      isAudiobook &&
      isAudiobookVersion(requestBody.audiobookVersion) &&
      getAudiobookVersionsMode(
        getSettings().bookService,
        getSettings().main.audiobookVersions
      ) === 'requester'
        ? requestBody.audiobookVersion
        : null;

    // Only managers choose the language, everyone else requests in their
    // own. A language from anyone else is ignored rather than refused, so
    // older clients that send one keep working.
    const canChooseLanguage = user.hasPermission(Permission.MANAGE_REQUESTS);
    const language = resolveRequestBookLanguage({
      requested: requestBody.language,
      canManage: canChooseLanguage,
      userLanguage: requestUser.settings?.bookLanguage,
      serverLanguage: getSettings().main.bookLanguage,
    });

    if (
      requestBody.language &&
      !canChooseLanguage &&
      requestBody.language !== language
    ) {
      logger.debug('Ignored the language of a book request', {
        label: 'Media Request',
        userId: user.id,
        requested: requestBody.language,
        language,
      });
    }

    const ignoreQuota = await MediaRequest.checkQuota(
      requestBody,
      user,
      requestUser,
      MediaType.BOOK
    );

    // Makes sure the work exists before anything is saved. A merged work is
    // requested as the work it was merged into.
    // A bulk request looks it up only when its genres have to be checked.
    const work =
      options.skipMetadataLookup &&
      !MediaRequest.hasBlockedGenres('book', user, requestUser, options)
        ? null
        : await new OpenLibrary().getWork(String(requestBody.mediaId));
    const olId = work ? getOlId(work.key) : String(requestBody.mediaId);

    MediaRequest.checkBlockedGenres(
      'book',
      work?.subjects,
      user,
      requestUser,
      options,
      { olId }
    );

    // A person with an age limit cannot request a book written for adults,
    // and their requests wait for someone who manages requests
    const ageLimit = await MediaRequest.getRequestAgeLimit(requestUser);

    if (!canRequestWork(ageLimit, work?.subjects)) {
      throw new RequestPermissionError(
        'This book is written for adults, and your account has an age limit.'
      );
    }

    const needsApproval =
      !!ageLimit && !user.hasPermission(Permission.MANAGE_REQUESTS);

    let media = await mediaRepository.findOne({
      where: { olId, mediaType: MediaType.BOOK },
      relations: ['requests'],
    });

    if (!media) {
      media = new Media({
        olId,
        mediaType: MediaType.BOOK,
        status: isAudiobook ? MediaStatus.UNKNOWN : MediaStatus.PENDING,
        statusAudio: isAudiobook ? MediaStatus.PENDING : MediaStatus.UNKNOWN,
      });
    } else {
      if (media.status === MediaStatus.BLOCKLISTED) {
        logger.warn('Request for media blocked due to being blocklisted', {
          olId,
          mediaType: requestBody.mediaType,
          label: 'Media Request',
        });

        throw new BlocklistedMediaError('This media is blocklisted.');
      }

      if (
        media[statusKey] === MediaStatus.UNKNOWN ||
        media[statusKey] === MediaStatus.DELETED
      ) {
        media[statusKey] = MediaStatus.PENDING;
      }
    }

    // Each format is requested as a whole, like a movie. Requests for
    // another recording of the audiobook are apart.
    const existing = (media.requests ?? []).find(
      (request) =>
        request.isAudiobook === isAudiobook &&
        !request.recording &&
        request.status !== MediaRequestStatus.DECLINED &&
        request.status !== MediaRequestStatus.COMPLETED
    );

    if (existing) {
      logger.warn('Duplicate request for media blocked', {
        olId,
        mediaType: requestBody.mediaType,
        isAudiobook,
        label: 'Media Request',
      });

      throw new DuplicateMediaRequestError(
        'Request for this media already exists.'
      );
    }

    // If the user is an admin or has the "auto approve" permission,
    // automatically approve the request
    const hasAutoApprovePermission =
      !needsApproval &&
      user.hasPermission(
        [Permission.AUTO_APPROVE, Permission.MANAGE_REQUESTS],
        {
          type: 'or',
        }
      );

    await mediaRepository.save(media);

    const request = new MediaRequest({
      type: MediaType.BOOK,
      media,
      requestedBy: requestUser,
      status: hasAutoApprovePermission
        ? MediaRequestStatus.APPROVED
        : MediaRequestStatus.PENDING,
      modifiedBy: hasAutoApprovePermission ? user : undefined,
      is4k: false,
      isAudiobook,
      language,
      audiobookVersion,
      isAutoRequest: options.isAutoRequest ?? false,
      ignoreQuota,
      skipNotification: options.skipNotification,
    });

    await requestRepository.save(request);
    return request;
  }

  /**
   * A comic or manga series, keyed on its comic id and sent to Talearr's
   * comics library. Comics are books to Allseerr's permissions, quotas and
   * approvals: they need the book request permission, count against the
   * book quota and wait for approval from a person with an age limit.
   * A request asks for the whole series or for some of its volumes. More
   * volumes of a series are asked for in a request of their own, so no
   * volume is asked for twice.
   */
  private static async createComicRequest(
    requestBody: MediaRequestBody,
    user: User,
    requestUser: User,
    options: MediaRequestOptions
  ): Promise<MediaRequest> {
    const mediaRepository = getRepository(Media);
    const requestRepository = getRepository(MediaRequest);
    const comicId = String(requestBody.mediaId);

    if (
      !requestUser.hasPermission(
        [Permission.REQUEST, Permission.REQUEST_BOOK],
        { type: 'or' }
      )
    ) {
      throw new RequestPermissionError(
        'You do not have permission to make comic requests.'
      );
    }

    if (requestBody.is4k || requestBody.isAudiobook) {
      throw new InvalidComicRequestError(
        'Comics are requested as a series, without formats.'
      );
    }

    if (
      requestBody.comicKind !== undefined &&
      requestBody.comicKind !== null &&
      !isComicKind(requestBody.comicKind)
    ) {
      throw new InvalidComicRequestError('Unknown comic kind.');
    }

    const volumes = parseComicVolumes(requestBody.volumes);

    if (volumes === undefined) {
      throw new InvalidComicRequestError(
        'Volumes are asked for as a list of volume numbers.'
      );
    }

    if (!getComicsServer()) {
      throw new InvalidComicRequestError(
        'Comics can only be requested from Talearr.'
      );
    }

    // The series must have been found by a search, which saved its facts
    const metadata = isComicId(comicId)
      ? await getRepository(MetadataComic).findOne({ where: { comicId } })
      : null;

    if (!metadata) {
      throw new InvalidComicRequestError('Unknown comic series.');
    }

    // A series Talearr has every volume of needs no request. One with
    // volumes missing is requested for them.
    const inLibrary = findLibrarySeries(
      await getLibrarySeries(),
      comicId,
      metadata
    );

    if (inLibrary && hasEveryVolume(inLibrary)) {
      throw new DuplicateMediaRequestError(
        'Every volume of this series is in the library already.'
      );
    }

    // Volumes must be ones the series has, once its volumes are listed, and
    // not ones Talearr has or is fetching
    if (volumes) {
      const volumeList = await getComicVolumeList(comicId, metadata);

      if (volumeList.length > 0) {
        const listed = new Map(
          volumeList.map((volume) => [volume.number, volume])
        );
        const unknown = volumes.filter((number) => !listed.has(number));

        if (unknown.length > 0) {
          throw new InvalidComicRequestError(
            `This series has no ${formatRequestedVolumes(unknown)}.`
          );
        }

        const held = volumes.filter((number) => {
          const volume = listed.get(number);
          return !!volume && isVolumeInLibrary(volume);
        });

        if (held.length > 0) {
          throw new DuplicateMediaRequestError(
            `${formatRequestedVolumes(held)} of this series is in the library already.`
          );
        }
      }
    }

    const ageLimit = await MediaRequest.getRequestAgeLimit(requestUser);

    if (!canRequestComic(ageLimit, metadata)) {
      throw new RequestPermissionError(
        'This series is rated above the age limit of your account.'
      );
    }

    const ignoreQuota = await MediaRequest.checkQuota(
      requestBody,
      user,
      requestUser,
      MediaType.BOOK
    );

    const needsApproval =
      !!ageLimit && !user.hasPermission(Permission.MANAGE_REQUESTS);

    let media = await mediaRepository.findOne({
      where: { comicId, mediaType: MediaType.COMIC },
      relations: ['requests'],
    });

    // A series AniList knows is manga. Any other may be filed either way,
    // and keeps the kind it was first requested as.
    const comicKind =
      metadata.aniListId || media?.comicKind
        ? (media?.comicKind ?? metadata.kind)
        : (requestBody.comicKind ?? metadata.kind);

    if (!media) {
      media = new Media({
        comicId,
        comicKind,
        mediaType: MediaType.COMIC,
        status: MediaStatus.PENDING,
      });
    } else {
      if (media.status === MediaStatus.BLOCKLISTED) {
        throw new BlocklistedMediaError('This media is blocklisted.');
      }

      if (
        media.status === MediaStatus.UNKNOWN ||
        media.status === MediaStatus.DELETED
      ) {
        media.status = MediaStatus.PENDING;
      }

      media.comicKind = comicKind;
    }

    // A request of the whole series stands in the way of any other. One of
    // some volumes only in the way of those volumes.
    const requested = getRequestedComicVolumes(media.requests ?? []);
    const requestedAgain = volumes
      ? volumes.filter((number) => requested.volumes.includes(number))
      : [];
    const hasStanding = (media.requests ?? []).some((request) =>
      holdsComicVolumes(request.status)
    );

    if (
      requested.wholeSeries ||
      (!volumes && hasStanding) ||
      requestedAgain.length > 0
    ) {
      logger.warn('Duplicate request for media blocked', {
        comicId,
        mediaType: requestBody.mediaType,
        volumes,
        label: 'Media Request',
      });

      throw new DuplicateMediaRequestError(
        requestedAgain.length > 0 && !requested.wholeSeries
          ? `${formatRequestedVolumes(requestedAgain)} of this series was requested already.`
          : 'Request for this media already exists.'
      );
    }

    const hasAutoApprovePermission =
      !needsApproval &&
      user.hasPermission(
        [Permission.AUTO_APPROVE, Permission.MANAGE_REQUESTS],
        { type: 'or' }
      );

    await mediaRepository.save(media);

    const request = new MediaRequest({
      type: MediaType.COMIC,
      media,
      requestedBy: requestUser,
      status: hasAutoApprovePermission
        ? MediaRequestStatus.APPROVED
        : MediaRequestStatus.PENDING,
      modifiedBy: hasAutoApprovePermission ? user : undefined,
      is4k: false,
      comicVolumes: volumes,
      isAutoRequest: options.isAutoRequest ?? false,
      ignoreQuota,
      skipNotification: options.skipNotification,
    });

    await requestRepository.save(request);
    return request;
  }

  /**
   * Another recording of an audiobook that is already available, such as
   * the unabridged reading of a book the library has abridged. Only Talearr
   * keeps more than one recording of a book. The request needs approval
   * the way a book request does, counts against the book quota and leaves
   * the book's own audiobook status alone.
   */
  private static async createRecordingRequest(
    requestBody: MediaRequestBody,
    user: User,
    requestUser: User,
    options: MediaRequestOptions
  ): Promise<MediaRequest> {
    const mediaRepository = getRepository(Media);
    const requestRepository = getRepository(MediaRequest);
    const recording = requestBody.recording;

    if (
      !requestUser.hasPermission(
        [Permission.REQUEST, Permission.REQUEST_BOOK],
        { type: 'or' }
      )
    ) {
      throw new RequestPermissionError(
        'You do not have permission to make book requests.'
      );
    }

    if (!isTalearrService(getSettings().bookService)) {
      throw new InvalidRecordingRequestError(
        'Other recordings can only be requested from Talearr.'
      );
    }

    if (!isBookRecordingKind(recording)) {
      throw new InvalidRecordingRequestError('Unknown recording.');
    }

    if (requestBody.is4k || requestBody.isAudiobook === false) {
      throw new InvalidRecordingRequestError(
        'Recordings can only be requested for audiobooks.'
      );
    }

    const narrator =
      typeof requestBody.recordingNarrator === 'string'
        ? requestBody.recordingNarrator
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, MAX_RECORDING_NARRATOR_LENGTH) || null
        : null;
    const editionId =
      typeof requestBody.recordingEditionId === 'number' &&
      Number.isInteger(requestBody.recordingEditionId) &&
      requestBody.recordingEditionId > 0
        ? requestBody.recordingEditionId
        : null;

    if (recording === 'narrator' && !narrator) {
      throw new InvalidRecordingRequestError(
        'A narrator recording needs a narrator.'
      );
    }

    if (recording === 'edition' && !editionId) {
      throw new InvalidRecordingRequestError(
        'An edition recording needs an edition.'
      );
    }

    const olId = String(requestBody.mediaId);
    const media = await mediaRepository.findOne({
      where: { olId, mediaType: MediaType.BOOK },
      relations: ['requests'],
    });

    if (media?.status === MediaStatus.BLOCKLISTED) {
      throw new BlocklistedMediaError('This media is blocklisted.');
    }

    const target = getRecordingTarget(media);

    if (!media || !target) {
      throw new InvalidRecordingRequestError(
        'The audiobook has to be available in Talearr before another recording can be requested.'
      );
    }

    const ignoreQuota = await MediaRequest.checkQuota(
      requestBody,
      user,
      requestUser,
      MediaType.BOOK
    );

    const wanted = {
      recording,
      recordingNarrator: narrator,
      recordingEditionId: editionId,
    };
    const existing = (media.requests ?? []).find(
      (request) =>
        isActiveRecordingRequest(request) && isSameRecording(request, wanted)
    );

    if (existing) {
      logger.warn('Duplicate recording request blocked', {
        olId,
        recording,
        label: 'Media Request',
      });

      throw new DuplicateMediaRequestError(
        'This recording has been requested already.'
      );
    }

    // Approved the way book requests are
    const hasAutoApprovePermission = user.hasPermission(
      [Permission.AUTO_APPROVE, Permission.MANAGE_REQUESTS],
      { type: 'or' }
    );

    const request = new MediaRequest({
      type: MediaType.BOOK,
      media,
      requestedBy: requestUser,
      status: hasAutoApprovePermission
        ? MediaRequestStatus.APPROVED
        : MediaRequestStatus.PENDING,
      modifiedBy: hasAutoApprovePermission ? user : undefined,
      is4k: false,
      isAudiobook: true,
      serverId: target.server.id,
      recording,
      recordingNarrator: narrator,
      recordingEditionId: recording === 'edition' ? editionId : null,
      isAutoRequest: options.isAutoRequest ?? false,
      ignoreQuota,
      skipNotification: options.skipNotification,
    });

    await requestRepository.save(request);
    return request;
  }

  private static async isAutoApprovedByRule(
    requestBody: MediaRequestBody,
    tmdbMedia: TmdbMovieDetails | TmdbTvDetails,
    requestUser: User,
    seasonCount?: number
  ): Promise<boolean> {
    const isAutoApproved = await matchesAutoApproveRule({
      mediaType: requestBody.mediaType,
      is4k: requestBody.is4k || false,
      tmdbMedia,
      requestUser,
      serviceId: requestBody.serverId ?? undefined,
      seasonCount,
    });

    if (isAutoApproved) {
      logger.debug('Auto-approve rule applied.', {
        label: 'Override Rules',
        tmdbId: tmdbMedia.id,
        mediaType: requestBody.mediaType,
        is4k: requestBody.is4k,
        userId: requestUser.id,
      });
    }

    return isAutoApproved;
  }

  @PrimaryGeneratedColumn()
  public id: number;

  @Column({ type: 'integer' })
  @Index()
  public status: MediaRequestStatus;

  @ManyToOne(() => Media, (media) => media.requests, {
    eager: true,
    onDelete: 'CASCADE',
  })
  @Index()
  public media: Media;

  @ManyToOne(() => User, (user) => user.requests, {
    eager: true,
    onDelete: 'CASCADE',
  })
  @Index()
  public requestedBy: User;

  @ManyToOne(() => User, {
    nullable: true,
    eager: true,
    onDelete: 'SET NULL',
  })
  @Index()
  public modifiedBy?: User;

  @DbAwareColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  public createdAt: Date;

  @UpdateDateColumn({
    type: resolveDbType('datetime'),
    default: () => 'CURRENT_TIMESTAMP',
  })
  public updatedAt: Date;

  @Column({ type: 'varchar' })
  public type: MediaType;

  @RelationCount((request: MediaRequest) => request.seasons)
  public seasonCount: number;

  @OneToMany(() => SeasonRequest, (season) => season.request, {
    eager: true,
    cascade: true,
  })
  public seasons: SeasonRequest[];

  @Column({ default: false })
  public is4k: boolean;

  // Book requests are made per format, like 4K and non-4K requests: an
  // audiobook request follows the media's statusAudio, an ebook its status
  @Column({ default: false })
  public isAudiobook: boolean;

  // Books only, the language the book is requested in (an ISO 639-1 code
  // or 'any'). Null for requests made before languages could be chosen,
  // which use the requester's language.
  @Column({ type: 'varchar', nullable: true })
  public language?: string | null;

  @Column({ nullable: true })
  public serverId: number;

  @Column({ nullable: true })
  public profileId: number;

  @Column({ nullable: true })
  public rootFolder: string;

  @Column({ nullable: true })
  public languageProfileId: number;

  @Column({
    type: 'text',
    nullable: true,
    transformer: {
      from: (value: string | null): number[] | null => {
        if (value) {
          if (value === 'none') {
            return [];
          }
          return value.split(',').map((v) => Number(v));
        }
        return null;
      },
      to: (value: number[] | null): string | null => {
        if (value) {
          const finalValue = value.join(',');

          // We want to keep the actual state of an "empty array" so we use
          // the keyword "none" to track this.
          if (!finalValue) {
            return 'none';
          }

          return finalValue;
        }
        return null;
      },
    },
  })
  public tags?: number[];

  @Column({ default: false })
  public isAutoRequest: boolean;

  // Future only requests monitor the episodes that have not aired yet, without
  // searching for the ones that have. Current season requests keep only the
  // airing season and delete older ones when a new season starts.
  @Column({ type: 'varchar', nullable: true })
  public monitorMode?: MediaRequestMonitorMode | null;

  // Seasons of a current season request that were already available when it
  // was made. They are kept when a new season starts unless an admin approves
  // deleting them. Null for requests made before this was recorded, which
  // keeps every older season.
  @Column({
    type: 'text',
    nullable: true,
    transformer: episodeNumbersTransformer,
  })
  public preexistingSeasons?: number[] | null;

  @Column({ default: false })
  public ignoreQuota: boolean;

  @Column({ type: 'text', nullable: true })
  public declineReason?: string | null;

  // Audiobooks on Talearr only: the request is for another recording of an
  // audiobook that is already available, such as the unabridged reading.
  // Null for every other request. A recording request is sent to Talearr's
  // recordings route instead of the usual book request and is completed by
  // the files of its own recording, not by the book's audiobook status.
  @Column({ type: 'varchar', nullable: true })
  public recording?: BookRecordingKind | null;

  // The narrator asked for, or the narrator of the recording Talearr picked
  @Column({ type: 'varchar', nullable: true })
  public recordingNarrator?: string | null;

  // Talearr's id of the edition picked for an edition request
  @Column({ type: 'integer', nullable: true })
  public recordingEditionId?: number | null;

  // Talearr's book id of the recording once Talearr has added it
  @Column({ type: 'integer', nullable: true })
  public recordingBookId?: number | null;

  // Audiobooks on Talearr only: the version the requester picked when the
  // Audiobook Versions setting lets them, unabridged, abridged or both.
  // Null for every other request, which follows the setting.
  @Column({ type: 'varchar', nullable: true })
  public audiobookVersion?: AudiobookVersion | null;

  // Comics only: the volume numbers asked for, sorted. Null for a request of
  // the whole series, which Talearr monitors every volume of.
  @Column({
    type: 'text',
    nullable: true,
    transformer: episodeNumbersTransformer,
  })
  public comicVolumes?: number[] | null;

  // Not stored. Set on a request made as part of a bulk request, which
  // sends one summary notification instead of one per request.
  public skipNotification?: boolean;

  constructor(init?: Partial<MediaRequest>) {
    Object.assign(this, init);
  }

  @AfterInsert()
  public async notifyNewRequest(): Promise<void> {
    if (this.skipNotification) {
      return;
    }

    if (this.status === MediaRequestStatus.PENDING) {
      const mediaRepository = getRepository(Media);
      const media = await mediaRepository.findOne({
        where: { id: this.media.id },
      });
      if (!media) {
        logger.error('Media data not found', {
          label: 'Media Request',
          requestId: this.id,
          mediaId: this.media.id,
        });
        return;
      }

      MediaRequest.sendNotification(this, media, Notification.MEDIA_PENDING);

      if (this.isAutoRequest) {
        MediaRequest.sendNotification(
          this,
          media,
          Notification.MEDIA_AUTO_REQUESTED
        );
      }
    }
  }

  /**
   * Notification for approval
   *
   * We only check on AfterUpdate as to not trigger this for
   * auto approved content
   */
  @AfterUpdate()
  public async notifyApprovedOrDeclined(autoApproved = false): Promise<void> {
    if (
      this.status === MediaRequestStatus.APPROVED ||
      this.status === MediaRequestStatus.DECLINED
    ) {
      const mediaRepository = getRepository(Media);
      const media = await mediaRepository.findOne({
        where: { id: this.media.id },
      });
      if (!media) {
        logger.error('Media data not found', {
          label: 'Media Request',
          requestId: this.id,
          mediaId: this.media.id,
        });
        return;
      }

      // A recording request is made for an audiobook that is available
      // already, its own recording is what it waits for
      if (
        this.status === MediaRequestStatus.APPROVED &&
        !this.recording &&
        media[getRequestStatusKey(this)] === MediaStatus.AVAILABLE
      ) {
        logger.info(
          'Media is already available. Sending availability notification instead of approval.',
          { label: 'Media Request', requestId: this.id, mediaId: this.media.id }
        );
        MediaRequest.sendNotification(
          this,
          media,
          Notification.MEDIA_AVAILABLE
        );
        return;
      }

      MediaRequest.sendNotification(
        this,
        media,
        this.status === MediaRequestStatus.APPROVED
          ? autoApproved
            ? Notification.MEDIA_AUTO_APPROVED
            : Notification.MEDIA_APPROVED
          : Notification.MEDIA_DECLINED
      );

      if (
        this.status === MediaRequestStatus.APPROVED &&
        autoApproved &&
        this.isAutoRequest
      ) {
        MediaRequest.sendNotification(
          this,
          media,
          Notification.MEDIA_AUTO_REQUESTED
        );
      }
    }
  }

  @AfterInsert()
  public async autoapprovalNotification(): Promise<void> {
    if (this.status === MediaRequestStatus.APPROVED && !this.skipNotification) {
      this.notifyApprovedOrDeclined(true);
    }
  }

  @AfterLoad()
  private sortSeasons() {
    if (Array.isArray(this.seasons)) {
      this.seasons.sort((a, b) => a.id - b.id);
    }
  }

  static async sendNotification(
    entity: MediaRequest,
    media: Media,
    type: Notification
  ) {
    const tmdb = new TheMovieDb();

    try {
      const mediaType =
        entity.type === MediaType.MOVIE
          ? 'Movie'
          : entity.type === MediaType.MUSIC
            ? 'Album'
            : entity.type === MediaType.BOOK
              ? getBookFormatName(entity.isAudiobook, entity.recording)
              : entity.type === MediaType.COMIC
                ? media.comicKind === 'manga'
                  ? 'Manga'
                  : 'Comic'
                : 'Series';
      let event: string | undefined;
      let notifyAdmin = true;
      let notifySystem = true;

      switch (type) {
        case Notification.MEDIA_AVAILABLE:
          event = `${entity.is4k ? '4K ' : ''}${mediaType} Now Available`;
          notifyAdmin = false;
          break;
        case Notification.MEDIA_APPROVED:
          event = `${entity.is4k ? '4K ' : ''}${mediaType} Request Approved`;
          notifyAdmin = false;
          break;
        case Notification.MEDIA_DECLINED:
          event = `${entity.is4k ? '4K ' : ''}${mediaType} Request Declined`;
          notifyAdmin = false;
          break;
        case Notification.MEDIA_PENDING:
          event = `New ${entity.is4k ? '4K ' : ''}${mediaType} Request`;
          break;
        case Notification.MEDIA_AUTO_REQUESTED:
          event = `${
            entity.is4k ? '4K ' : ''
          }${mediaType} Request Automatically Submitted`;
          notifyAdmin = false;
          notifySystem = false;
          break;
        case Notification.MEDIA_AUTO_APPROVED:
          event = `${
            entity.is4k ? '4K ' : ''
          }${mediaType} Request Automatically Approved`;
          break;
        case Notification.MEDIA_FAILED:
          event = `${entity.is4k ? '4K ' : ''}${mediaType} Request Failed`;
          break;
      }

      const declineReasonExtra =
        type === Notification.MEDIA_DECLINED && entity.declineReason
          ? [{ name: 'Reason', value: entity.declineReason }]
          : undefined;

      if (entity.type === MediaType.MOVIE) {
        const movie = await tmdb.getMovie({ movieId: media.tmdbId });
        notificationManager.sendNotification(type, {
          media,
          request: entity,
          notifyAdmin,
          notifySystem,
          notifyUser: notifyAdmin ? undefined : entity.requestedBy,
          event,
          subject: `${movie.title}${
            movie.release_date ? ` (${movie.release_date.slice(0, 4)})` : ''
          }`,
          message: truncate(movie.overview, {
            length: 500,
            separator: /\s/,
            omission: '…',
          }),
          image: `https://image.tmdb.org/t/p/w600_and_h900_bestv2${movie.poster_path}`,
          extra: declineReasonExtra,
        });
      } else if (entity.type === MediaType.TV) {
        const tv = await tmdb.getTvShow({ tvId: media.tmdbId });
        notificationManager.sendNotification(type, {
          media,
          request: entity,
          notifyAdmin,
          notifySystem,
          notifyUser: notifyAdmin ? undefined : entity.requestedBy,
          event,
          subject: `${tv.name}${
            tv.first_air_date ? ` (${tv.first_air_date.slice(0, 4)})` : ''
          }`,
          message: truncate(tv.overview, {
            length: 500,
            separator: /\s/,
            omission: '…',
          }),
          image: `https://image.tmdb.org/t/p/w600_and_h900_bestv2${tv.poster_path}`,
          extra: [
            {
              name: 'Requested Seasons',
              value: formatRequestedSeasons(entity.seasons),
            },
            ...(entity.monitorMode === MediaRequestMonitorMode.FUTURE
              ? [{ name: 'Monitoring', value: 'Future episodes only' }]
              : entity.monitorMode === MediaRequestMonitorMode.CURRENT
                ? [{ name: 'Monitoring', value: 'Current season only' }]
                : []),
            ...(declineReasonExtra ?? []),
          ],
        });
      } else if (entity.type === MediaType.MUSIC && media.mbId) {
        const album = await getMusicNotificationDetails(media.mbId);
        notificationManager.sendNotification(type, {
          media,
          request: entity,
          notifyAdmin,
          notifySystem,
          notifyUser: notifyAdmin ? undefined : entity.requestedBy,
          event,
          subject: album.subject,
          message: album.message,
          image: album.image,
          extra: declineReasonExtra,
        });
      } else if (entity.type === MediaType.BOOK && media.olId) {
        const book = await getBookNotificationDetails(media.olId);
        notificationManager.sendNotification(type, {
          media,
          request: entity,
          notifyAdmin,
          notifySystem,
          notifyUser: notifyAdmin ? undefined : entity.requestedBy,
          event,
          subject: book.subject,
          message: book.message,
          image: book.image,
          extra: [
            { name: 'Format', value: getBookFormatName(entity.isAudiobook) },
            ...(entity.recording
              ? [
                  {
                    name: 'Recording',
                    value: describeBookRecording(entity) as string,
                  },
                ]
              : []),
            ...(isBookLanguage(entity.language)
              ? [
                  {
                    name: 'Language',
                    value: getBookLanguageName(entity.language),
                  },
                ]
              : []),
            ...(declineReasonExtra ?? []),
          ],
        });
      } else if (entity.type === MediaType.COMIC && media.comicId) {
        const comic = await getComicNotificationDetails(media.comicId);
        notificationManager.sendNotification(type, {
          media,
          request: entity,
          notifyAdmin,
          notifySystem,
          notifyUser: notifyAdmin ? undefined : entity.requestedBy,
          event,
          subject: comic.subject,
          message: comic.message,
          image: comic.image,
          extra: [
            ...(entity.comicVolumes?.length
              ? [
                  {
                    name: 'Requested Volumes',
                    value: formatRequestedVolumes(entity.comicVolumes),
                  },
                ]
              : []),
            ...(comic.ageRating
              ? [{ name: 'Age Rating', value: comic.ageRating }]
              : []),
            ...(declineReasonExtra ?? []),
          ],
        });
      }
    } catch (e) {
      logger.error('Something went wrong sending media notification(s)', {
        label: 'Notifications',
        errorMessage: e.message,
        requestId: entity.id,
        mediaId: entity.media.id,
      });
    }
  }
}

export default MediaRequest;
