import type { TracearrHistoryRecord } from '@server/api/tracearr';
import TracearrAPI, {
  normalizeExternalId,
  tracearrMediaRef,
} from '@server/api/tracearr';
import { MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { User } from '@server/entity/User';
import type { MediaWatchDataResponse } from '@server/interfaces/api/mediaInterfaces';
import type { UserWatchDataResponse } from '@server/interfaces/api/userInterfaces';
import type { TracearrSettings } from '@server/lib/settings';
import { In, IsNull, Not } from 'typeorm';

/** How many recent plays are read for a profile's Recently Watched row */
const HISTORY_PAGE = 100;
/** Watchers resolved to Allseerr users for one title */
const MAX_WATCHERS = 50;

export class TracearrUserNotFoundError extends Error {}

/** The media server accounts a user is known by, for matching in Tracearr */
const externalIdsOf = (
  user: Pick<User, 'plexId' | 'jellyfinUserId'>
): (string | number)[] =>
  [user.plexId, user.jellyfinUserId].filter(
    (id): id is string | number => id != null && id !== ''
  );

/**
 * Matches plays to the library: movies by TMDB id, episodes by the series'
 * key on the media server (Plex rating key, or Jellyfin / Emby item id).
 * Keeps the order of the history, newest first, one entry per title.
 */
export const matchRecentlyWatched = (
  history: TracearrHistoryRecord[],
  media: Media[]
): Media[] => {
  const seen = new Set<number>();
  const matched: Media[] = [];

  for (const record of history) {
    const found =
      record.media_type === 'movie'
        ? media.find(
            (m) =>
              m.mediaType === MediaType.MOVIE &&
              ((record.tmdb_id != null && m.tmdbId === record.tmdb_id) ||
                (!!record.rating_key &&
                  [
                    m.ratingKey,
                    m.ratingKey4k,
                    m.jellyfinMediaId,
                    m.jellyfinMediaId4k,
                  ].includes(record.rating_key)))
          )
        : record.media_type === 'episode' && record.grandparent_rating_key
          ? media.find(
              (m) =>
                m.mediaType === MediaType.TV &&
                [
                  m.ratingKey,
                  m.ratingKey4k,
                  m.jellyfinMediaId,
                  m.jellyfinMediaId4k,
                ].includes(record.grandparent_rating_key as string)
            )
          : undefined;

    if (found && !seen.has(found.id)) {
      seen.add(found.id);
      matched.push(found);
    }
  }

  return matched;
};

/** A profile's play count and recently watched titles, from Tracearr */
export const getTracearrUserWatchData = async (
  settings: TracearrSettings,
  user: Pick<User, 'plexId' | 'jellyfinUserId'>
): Promise<UserWatchDataResponse> => {
  const tracearr = new TracearrAPI(settings);
  const identity = await tracearr.findIdentity(externalIdsOf(user));

  if (!identity) {
    throw new TracearrUserNotFoundError('User not found in Tracearr.');
  }

  const [stats, history] = await Promise.all([
    tracearr.getUserStats(identity.id),
    tracearr.getUserHistory(identity.id, HISTORY_PAGE),
  ]);

  const tmdbIds = history
    .filter((r) => r.media_type === 'movie' && r.tmdb_id != null)
    .map((r) => r.tmdb_id as number);
  const keys = [
    ...new Set(
      history
        .flatMap((r) =>
          r.media_type === 'movie' ? [r.rating_key] : [r.grandparent_rating_key]
        )
        .filter((key): key is string => !!key)
    ),
  ];

  const where = [
    ...(tmdbIds.length
      ? [{ mediaType: MediaType.MOVIE, tmdbId: In(tmdbIds) }]
      : []),
    ...(keys.length
      ? [
          { ratingKey: In(keys) },
          { ratingKey4k: In(keys) },
          { jellyfinMediaId: In(keys) },
          { jellyfinMediaId4k: In(keys) },
        ]
      : []),
  ];
  const media = where.length ? await getRepository(Media).find({ where }) : [];

  return {
    recentlyWatched: matchRecentlyWatched(history, media),
    playCount: stats.windows.all_time.plays,
  };
};

/** Play counts and the Allseerr users who watched a title, from Tracearr */
export const getTracearrMediaWatchData = async (
  settings: TracearrSettings,
  media: Pick<Media, 'mediaType' | 'tmdbId'>
): Promise<MediaWatchDataResponse> => {
  if (
    (media.mediaType !== MediaType.MOVIE && media.mediaType !== MediaType.TV) ||
    media.tmdbId == null
  ) {
    return {};
  }

  const tracearr = new TracearrAPI(settings);
  const ref = tracearrMediaRef(media.mediaType, media.tmdbId);
  const stats = await tracearr.getMediaStats(ref);

  if (!stats) {
    return {};
  }

  const watchers = (await tracearr.getMediaWatchers(ref)).slice(
    0,
    MAX_WATCHERS
  );
  const identityIds = [...new Set(watchers.map((w) => w.user.user_id))];
  const identities = await Promise.all(
    identityIds.map((id) => tracearr.getIdentity(id).catch(() => undefined))
  );
  const accountIds = new Set(
    identities.flatMap(
      (identity) =>
        identity?.accounts.map((a) =>
          normalizeExternalId(a.external_user_id)
        ) ?? []
    )
  );

  const plexIds = [...accountIds].filter((id) => /^\d+$/.test(id)).map(Number);
  const users = accountIds.size
    ? (
        await getRepository(User).find({
          where: [
            ...(plexIds.length ? [{ plexId: In(plexIds) }] : []),
            // Stored with or without dashes, so compared below
            { jellyfinUserId: Not(IsNull()) },
          ],
        })
      ).filter(
        (u) =>
          (u.plexId != null && accountIds.has(String(u.plexId))) ||
          (!!u.jellyfinUserId &&
            accountIds.has(normalizeExternalId(u.jellyfinUserId)))
      )
    : [];

  // Tracearr counts every copy of a title together, so it all goes under
  // the standard version
  return {
    data: {
      users,
      playCount: stats.windows.all_time.combined.plays,
      playCount7Days: stats.windows.last_7.combined.plays,
      playCount30Days: stats.windows.last_30.combined.plays,
    },
  };
};
