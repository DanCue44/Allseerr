import TheMovieDb from '@server/api/themoviedb';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { MediaServerType } from '@server/constants/server';
import { UserType } from '@server/constants/user';
import { getRepository } from '@server/datasource';
import type Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import type { User } from '@server/entity/User';
import WatchedItem from '@server/entity/WatchedItem';
import { getSettings } from '@server/lib/settings';
import type { WatchedCounts } from '@server/lib/watchedState';
import { hasViewState } from '@server/lib/watchedState';
import logger from '@server/logger';
import { In, Not } from 'typeorm';

const DAY_MS = 24 * 60 * 60 * 1000;
/** How many titles the request window and the refusal name */
export const LISTED_TITLES = 10;

/** A requested title that is in the library and nobody has started */
export interface UnwatchedTitle {
  mediaId: number;
  mediaType: MediaType.MOVIE | MediaType.TV;
  tmdbId: number;
  title?: string;
  /** When it reached the library, when known */
  availableSince: string | null;
}

export interface UnwatchedQuotaStatus {
  /** More than this many unwatched titles holds new requests; 0 or unset is off */
  limit?: number;
  /** A title counts once it has been available this many days */
  days?: number;
  used: number;
  restricted: boolean;
  titles: UnwatchedTitle[];
}

const availableStatuses = [
  MediaStatus.AVAILABLE,
  MediaStatus.PARTIALLY_AVAILABLE,
];

/**
 * Watched state only exists for people signed in through Plex, Jellyfin or
 * Emby, so the limit only ever applies to them
 */
export const hasWatchData = (user: Pick<User, 'userType'>): boolean => {
  const mediaServer = getSettings().main.mediaServerType;

  return (
    user.userType !== UserType.LOCAL &&
    (mediaServer === MediaServerType.PLEX ||
      mediaServer === MediaServerType.JELLYFIN ||
      mediaServer === MediaServerType.EMBY)
  );
};

interface RequestedVersion {
  is4k: boolean;
  media: Pick<
    Media,
    | 'id'
    | 'mediaType'
    | 'tmdbId'
    | 'status'
    | 'status4k'
    | 'mediaAddedAt'
    | 'createdAt'
  >;
}

/**
 * The requested movies and series that are available, have been for at
 * least `days` days, and that the person has not started. A series with
 * any episode seen counts as being watched.
 */
export const pickUnwatched = (
  requests: RequestedVersion[],
  watched: Map<string, WatchedCounts>,
  days: number | undefined,
  now: Date = new Date()
): UnwatchedTitle[] => {
  const cutoff = now.getTime() - (days ?? 0) * DAY_MS;
  const seen = new Set<number>();
  const titles: UnwatchedTitle[] = [];

  for (const { is4k, media } of requests) {
    if (
      seen.has(media.id) ||
      (media.mediaType !== MediaType.MOVIE &&
        media.mediaType !== MediaType.TV) ||
      !availableStatuses.includes(is4k ? media.status4k : media.status)
    ) {
      continue;
    }

    const since = media.mediaAddedAt ?? media.createdAt ?? null;
    if (days && (!since || since.getTime() > cutoff)) {
      continue;
    }

    const counts = watched.get(`${media.mediaType}:${media.tmdbId}`);
    if (counts && hasViewState(counts)) {
      continue;
    }

    seen.add(media.id);
    titles.push({
      mediaId: media.id,
      mediaType: media.mediaType,
      tmdbId: media.tmdbId,
      availableSince: since ? since.toISOString() : null,
    });
  }

  // Oldest first: the ones waiting longest are the ones to watch
  return titles.sort((a, b) =>
    (a.availableSince ?? '').localeCompare(b.availableSince ?? '')
  );
};

/**
 * How many of the person's requested titles sit available and unwatched,
 * against their limit (or the global one)
 */
export const getUnwatchedQuota = async (
  user: User,
  limit: number | undefined,
  days: number | undefined
): Promise<UnwatchedQuotaStatus> => {
  const status: UnwatchedQuotaStatus = {
    limit: limit || undefined,
    days: days || undefined,
    used: 0,
    restricted: false,
    titles: [],
  };

  if (!limit || !hasWatchData(user)) {
    return status;
  }

  try {
    const requests = await getRepository(MediaRequest).find({
      where: {
        requestedBy: { id: user.id },
        type: In([MediaType.MOVIE, MediaType.TV]),
        status: Not(MediaRequestStatus.DECLINED),
      },
      relations: { media: true },
      order: { createdAt: 'ASC' },
    });

    const tmdbIds = [
      ...new Set(
        requests
          .filter((r) => r.media?.tmdbId != null)
          .map((r) => r.media.tmdbId)
      ),
    ];
    const rows = tmdbIds.length
      ? await getRepository(WatchedItem).find({
          where: { user: { id: user.id }, tmdbId: In(tmdbIds) },
        })
      : [];
    const watched = new Map<string, WatchedCounts>(
      rows.map((row) => [`${row.mediaType}:${row.tmdbId}`, row])
    );

    const titles = pickUnwatched(
      requests.filter((r) => !!r.media),
      watched,
      days
    );

    status.used = titles.length;
    status.restricted = titles.length > limit;
    status.titles = titles;
  } catch (e) {
    // A broken count must never block requests
    logger.warn('Could not count unwatched requests', {
      label: 'Request Limits',
      userId: user.id,
      errorMessage: e.message,
    });
  }

  return status;
};

/** Fills in the names of the first few titles, for the request window */
export const nameUnwatchedTitles = async (
  titles: UnwatchedTitle[],
  count = LISTED_TITLES
): Promise<UnwatchedTitle[]> => {
  const tmdb = new TheMovieDb();

  return Promise.all(
    titles.slice(0, count).map(async (title) => {
      try {
        const name =
          title.mediaType === MediaType.MOVIE
            ? (await tmdb.getMovie({ movieId: title.tmdbId })).title
            : (await tmdb.getTvShow({ tvId: title.tmdbId })).name;

        return { ...title, title: name };
      } catch {
        return title;
      }
    })
  );
};

/** The reason given when a request is refused for unwatched titles */
export const unwatchedRefusal = async (
  quota: UnwatchedQuotaStatus
): Promise<string> => {
  const named = (await nameUnwatchedTitles(quota.titles, 5))
    .map((t) => t.title)
    .filter(Boolean);
  const more = quota.used - named.length;

  return (
    `You have ${quota.used} requested titles available and unwatched` +
    `${quota.days ? ` for more than ${quota.days} days` : ''}, over the limit of ${quota.limit}. ` +
    `Watch some of them before requesting more` +
    (named.length
      ? `: ${named.join(', ')}${more > 0 ? ` and ${more} more` : ''}.`
      : '.')
  );
};
