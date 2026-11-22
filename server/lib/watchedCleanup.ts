import TheMovieDb from '@server/api/themoviedb';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
  RemovalRequestStatus,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import type Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import RemovalRequest from '@server/entity/RemovalRequest';
import type { User } from '@server/entity/User';
import WatchedItem from '@server/entity/WatchedItem';
import {
  approveRemovalRequest,
  createRemovalRequest,
} from '@server/lib/removalRequests';
import { getSettings } from '@server/lib/settings';
import { hasWatchData } from '@server/lib/unwatchedQuota';
import type { WatchedCounts } from '@server/lib/watchedState';
import { watchedState } from '@server/lib/watchedState';
import logger from '@server/logger';
import { In, Not } from 'typeorm';

const DAY_MS = 24 * 60 * 60 * 1000;
/** The longest list shown at once; the oldest watched come first */
export const MAX_SUGGESTIONS = 200;
export const CLEANUP_REASON = 'Watched by everyone who requested it';

export class WatchedCleanupDisabledError extends Error {}

export interface WatchedCleanupSettings {
  enabled: boolean;
  /** Only titles every requester finished at least this many days ago */
  days: number;
}

export const getWatchedCleanupSettings = (): WatchedCleanupSettings => ({
  enabled: !!getSettings().main.watchedCleanup?.enabled,
  days: Math.max(0, Number(getSettings().main.watchedCleanup?.days) || 0),
});

export interface CleanupRequester {
  id: number;
  displayName: string;
  avatar: string;
  lastWatchedAt: string | null;
}

export interface CleanupSuggestion {
  mediaId: number;
  mediaType: MediaType.MOVIE | MediaType.TV;
  tmdbId: number;
  is4k: boolean;
  title?: string;
  posterPath?: string | null;
  /** When the last requester finished it */
  lastWatchedAt: string | null;
  requesters: CleanupRequester[];
}

interface Requester {
  id: number;
  displayName: string;
  avatar: string;
  userType: User['userType'];
}

export interface RequestedVersion {
  is4k: boolean;
  media: Pick<Media, 'id' | 'mediaType' | 'tmdbId' | 'status' | 'status4k'>;
  requesters: Requester[];
}

export const watchedKey = (
  userId: number,
  mediaType: MediaType,
  tmdbId: number
): string => `${userId}:${mediaType}:${tmdbId}`;

export const versionKey = (mediaId: number, is4k: boolean): string =>
  `${mediaId}:${is4k ? '4k' : 'hd'}`;

const availableStatuses = [
  MediaStatus.AVAILABLE,
  MediaStatus.PARTIALLY_AVAILABLE,
];

/**
 * Available movies and series that every person who asked for them has
 * watched in full, at least `days` ago. A requester whose watch history
 * Allseerr cannot read keeps the title off the list.
 */
export const pickCleanupSuggestions = (
  versions: RequestedVersion[],
  watched: Map<string, WatchedCounts>,
  pendingRemovals: Set<string>,
  days: number,
  now: Date = new Date()
): CleanupSuggestion[] => {
  const cutoff = now.getTime() - days * DAY_MS;
  const suggestions: CleanupSuggestion[] = [];

  for (const { is4k, media, requesters } of versions) {
    if (
      (media.mediaType !== MediaType.MOVIE &&
        media.mediaType !== MediaType.TV) ||
      !availableStatuses.includes(is4k ? media.status4k : media.status) ||
      pendingRemovals.has(versionKey(media.id, is4k)) ||
      requesters.length === 0
    ) {
      continue;
    }

    const finished: CleanupRequester[] = [];

    for (const requester of requesters) {
      if (!hasWatchData(requester)) {
        break;
      }

      const counts = watched.get(
        watchedKey(requester.id, media.mediaType, media.tmdbId)
      );
      const state = watchedState(counts, media.mediaType);
      const at = counts?.lastViewedAt ?? null;

      if (!state.watched || (days > 0 && (!at || at.getTime() > cutoff))) {
        break;
      }

      finished.push({
        id: requester.id,
        displayName: requester.displayName,
        avatar: requester.avatar,
        lastWatchedAt: at ? at.toISOString() : null,
      });
    }

    if (finished.length !== requesters.length) {
      continue;
    }

    const lastWatchedAt =
      finished
        .map((r) => r.lastWatchedAt)
        .filter((at): at is string => !!at)
        .sort()
        .pop() ?? null;

    suggestions.push({
      mediaId: media.id,
      mediaType: media.mediaType,
      tmdbId: media.tmdbId,
      is4k,
      lastWatchedAt,
      requesters: finished,
    });
  }

  return suggestions.sort((a, b) =>
    (a.lastWatchedAt ?? '').localeCompare(b.lastWatchedAt ?? '')
  );
};

const loadSuggestions = async (days: number): Promise<CleanupSuggestion[]> => {
  const requests = await getRepository(MediaRequest).find({
    where: {
      type: In([MediaType.MOVIE, MediaType.TV]),
      status: Not(MediaRequestStatus.DECLINED),
    },
    relations: { media: true, requestedBy: true },
  });

  const versions = new Map<string, RequestedVersion>();
  for (const request of requests) {
    if (!request.media || !request.requestedBy) {
      continue;
    }

    const key = versionKey(request.media.id, request.is4k);
    const version = versions.get(key) ?? {
      is4k: request.is4k,
      media: request.media,
      requesters: [],
    };

    if (!version.requesters.some((r) => r.id === request.requestedBy.id)) {
      version.requesters.push(request.requestedBy);
    }
    versions.set(key, version);
  }

  const userIds = [
    ...new Set(
      [...versions.values()].flatMap((v) => v.requesters.map((r) => r.id))
    ),
  ];
  const tmdbIds = [
    ...new Set([...versions.values()].map((v) => v.media.tmdbId)),
  ];
  const rows =
    userIds.length && tmdbIds.length
      ? await getRepository(WatchedItem)
          .createQueryBuilder('watched')
          .leftJoinAndSelect('watched.user', 'user')
          .where('user.id IN (:...userIds)', { userIds })
          .andWhere('watched.tmdbId IN (:...tmdbIds)', { tmdbIds })
          .getMany()
      : [];
  const watched = new Map<string, WatchedCounts>(
    rows.map((row) => [watchedKey(row.user.id, row.mediaType, row.tmdbId), row])
  );

  const pending = await getRepository(RemovalRequest).find({
    where: {
      status: In([RemovalRequestStatus.PENDING, RemovalRequestStatus.FAILED]),
    },
  });
  const pendingRemovals = new Set(
    pending.map((removal) => versionKey(removal.media.id, removal.is4k))
  );

  return pickCleanupSuggestions(
    [...versions.values()],
    watched,
    pendingRemovals,
    days
  );
};

/** The current suggestions, with names and posters for the list */
export const getCleanupSuggestions = async (): Promise<CleanupSuggestion[]> => {
  const { enabled, days } = getWatchedCleanupSettings();

  if (!enabled) {
    throw new WatchedCleanupDisabledError(
      'Watched cleanup suggestions are turned off.'
    );
  }

  const tmdb = new TheMovieDb();
  const suggestions = (await loadSuggestions(days)).slice(0, MAX_SUGGESTIONS);

  return Promise.all(
    suggestions.map(async (suggestion) => {
      try {
        const details =
          suggestion.mediaType === MediaType.MOVIE
            ? await tmdb.getMovie({ movieId: suggestion.tmdbId })
            : await tmdb.getTvShow({ tvId: suggestion.tmdbId });

        return {
          ...suggestion,
          title: 'title' in details ? details.title : details.name,
          posterPath: details.poster_path ?? null,
        };
      } catch {
        return suggestion;
      }
    })
  );
};

export interface CleanupActionResult {
  mediaId: number;
  is4k: boolean;
  status: 'requested' | 'removed' | 'skipped' | 'failed';
  message?: string;
}

/**
 * Creates a removal request for each chosen title, and approves it at once
 * when the admin chose to remove. Only titles still on the list are acted
 * on; nothing here runs without an admin asking.
 */
export const actOnCleanupSuggestions = async (
  items: { mediaId: number; is4k?: boolean }[],
  action: 'request' | 'remove',
  admin: User
): Promise<CleanupActionResult[]> => {
  const { enabled, days } = getWatchedCleanupSettings();

  if (!enabled) {
    throw new WatchedCleanupDisabledError(
      'Watched cleanup suggestions are turned off.'
    );
  }

  const current = new Set(
    (await loadSuggestions(days)).map((s) => versionKey(s.mediaId, s.is4k))
  );
  const results: CleanupActionResult[] = [];

  for (const item of items) {
    const is4k = !!item.is4k;
    const mediaId = Number(item.mediaId);

    if (!current.has(versionKey(mediaId, is4k))) {
      results.push({
        mediaId,
        is4k,
        status: 'skipped',
        message: 'No longer suggested.',
      });
      continue;
    }

    try {
      const removal = await createRemovalRequest(
        { mediaId, is4k, reason: CLEANUP_REASON },
        admin
      );

      if (action === 'remove') {
        await approveRemovalRequest(removal.id, admin);
      }

      results.push({
        mediaId,
        is4k,
        status: action === 'remove' ? 'removed' : 'requested',
      });
    } catch (e) {
      logger.warn('Could not act on a watched cleanup suggestion', {
        label: 'Watched Cleanup',
        mediaId,
        is4k,
        action,
        errorMessage: e.message,
      });
      results.push({ mediaId, is4k, status: 'failed', message: e.message });
    }
  }

  return results;
};
