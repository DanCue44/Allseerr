import { MediaType } from '@server/constants/media';

/** What the signed-in person has seen of a title on the media server. */
export interface UserWatchedState {
  /** Everything seen: a movie played, or every episode the server has. */
  watched: boolean;
  /** Started but not finished: a movie part way, or some episodes seen. */
  inProgress: boolean;
  viewCount: number;
  viewedLeafCount: number;
  leafCount: number;
  lastViewedAt: string | null;
}

/** The counts the media server keeps per person and title. */
export interface WatchedCounts {
  viewCount: number;
  viewedLeafCount: number;
  leafCount: number;
  /** How far into a movie, in milliseconds, when left part way. */
  viewOffset: number | null;
  lastViewedAt: Date | null;
}

export const EMPTY_COUNTS: WatchedCounts = {
  viewCount: 0,
  viewedLeafCount: 0,
  leafCount: 0,
  viewOffset: null,
  lastViewedAt: null,
};

/** Whether the counts say anything at all (an untouched title stores nothing). */
export const hasViewState = (counts: WatchedCounts): boolean =>
  counts.viewCount > 0 ||
  counts.viewedLeafCount > 0 ||
  (counts.viewOffset ?? 0) > 0;

export const sameCounts = (a: WatchedCounts, b: WatchedCounts): boolean =>
  a.viewCount === b.viewCount &&
  a.viewedLeafCount === b.viewedLeafCount &&
  a.leafCount === b.leafCount &&
  (a.viewOffset ?? 0) === (b.viewOffset ?? 0) &&
  (a.lastViewedAt?.getTime() ?? 0) === (b.lastViewedAt?.getTime() ?? 0);

/**
 * One title held in two libraries (say HD and 4K) keeps the fuller of the
 * two records
 */
export const mergeCounts = (
  a: WatchedCounts | undefined,
  b: WatchedCounts
): WatchedCounts => {
  if (!a) {
    return b;
  }

  const later =
    (b.lastViewedAt?.getTime() ?? 0) > (a.lastViewedAt?.getTime() ?? 0) ? b : a;

  return {
    viewCount: Math.max(a.viewCount, b.viewCount),
    viewedLeafCount: Math.max(a.viewedLeafCount, b.viewedLeafCount),
    leafCount: Math.max(a.leafCount, b.leafCount),
    viewOffset: later.viewOffset,
    lastViewedAt: later.lastViewedAt,
  };
};

export const watchedState = (
  counts: WatchedCounts | undefined,
  mediaType: MediaType | string
): UserWatchedState => {
  const c = counts ?? EMPTY_COUNTS;
  const watched =
    mediaType === MediaType.TV
      ? c.leafCount > 0 && c.viewedLeafCount >= c.leafCount
      : c.viewCount > 0;
  const inProgress =
    !watched &&
    (mediaType === MediaType.TV
      ? c.viewedLeafCount > 0
      : (c.viewOffset ?? 0) > 0);

  return {
    watched,
    inProgress,
    viewCount: c.viewCount,
    viewedLeafCount: c.viewedLeafCount,
    leafCount: c.leafCount,
    lastViewedAt: c.lastViewedAt ? c.lastViewedAt.toISOString() : null,
  };
};

/** A Plex library item's view fields, as the person's own token sees them. */
export interface PlexViewFields {
  viewCount?: number;
  viewedLeafCount?: number;
  leafCount?: number;
  viewOffset?: number;
  /** Unix seconds */
  lastViewedAt?: number;
}

export const plexCounts = (item: PlexViewFields): WatchedCounts => ({
  viewCount: item.viewCount ?? 0,
  viewedLeafCount: item.viewedLeafCount ?? 0,
  leafCount: item.leafCount ?? 0,
  viewOffset: item.viewOffset ?? null,
  lastViewedAt: item.lastViewedAt ? new Date(item.lastViewedAt * 1000) : null,
});

/** A Jellyfin or Emby item's per-user fields. */
export interface JellyfinUserFields {
  Type?: string;
  RecursiveItemCount?: number;
  UserData?: {
    Played?: boolean;
    PlayCount?: number;
    UnplayedItemCount?: number;
    /** 100 ns ticks */
    PlaybackPositionTicks?: number;
    LastPlayedDate?: string;
  };
}

export const jellyfinCounts = (item: JellyfinUserFields): WatchedCounts => {
  const data = item.UserData ?? {};
  const lastViewedAt = data.LastPlayedDate
    ? new Date(data.LastPlayedDate)
    : null;

  if (item.Type === 'Series') {
    const leafCount = item.RecursiveItemCount ?? 0;
    const unplayed = data.UnplayedItemCount ?? (data.Played ? 0 : leafCount);

    return {
      viewCount: 0,
      viewedLeafCount: data.Played
        ? leafCount
        : Math.max(0, leafCount - unplayed),
      leafCount,
      viewOffset: null,
      lastViewedAt: Number.isNaN(lastViewedAt?.getTime()) ? null : lastViewedAt,
    };
  }

  return {
    viewCount: data.PlayCount ?? (data.Played ? 1 : 0),
    viewedLeafCount: 0,
    leafCount: 0,
    viewOffset: data.PlaybackPositionTicks
      ? Math.floor(data.PlaybackPositionTicks / 10000)
      : null,
    lastViewedAt: Number.isNaN(lastViewedAt?.getTime()) ? null : lastViewedAt,
  };
};
