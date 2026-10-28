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
  /** How far into a movie, in milliseconds, when left part way. */
  viewOffset: number | null;
  /** A movie's length in milliseconds, when the server said. */
  duration: number | null;
  lastViewedAt: string | null;
}

/** The counts the media server keeps per person and title. */
export interface WatchedCounts {
  viewCount: number;
  viewedLeafCount: number;
  leafCount: number;
  /** How far into a movie, in milliseconds, when left part way. */
  viewOffset: number | null;
  duration: number | null;
  lastViewedAt: Date | null;
}

export const EMPTY_COUNTS: WatchedCounts = {
  viewCount: 0,
  viewedLeafCount: 0,
  leafCount: 0,
  viewOffset: null,
  duration: null,
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
  (a.duration ?? 0) === (b.duration ?? 0) &&
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
    duration: later.duration ?? a.duration ?? b.duration,
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
    viewOffset: c.viewOffset,
    duration: c.duration,
    lastViewedAt: c.lastViewedAt ? c.lastViewedAt.toISOString() : null,
  };
};

/** What the person has seen of one episode. */
export interface UserEpisodeState {
  watched: boolean;
  inProgress: boolean;
  /** How far in, in milliseconds, when left part way. */
  viewOffset: number | null;
  duration: number | null;
  lastViewedAt: string | null;
}

/** The counts the media server keeps per person and episode. */
export interface EpisodeCounts {
  viewCount: number;
  viewOffset: number | null;
  duration: number | null;
  lastViewedAt: Date | null;
}

export const hasEpisodeState = (counts: EpisodeCounts): boolean =>
  counts.viewCount > 0 || (counts.viewOffset ?? 0) > 0;

export const sameEpisodeCounts = (
  a: EpisodeCounts,
  b: EpisodeCounts
): boolean =>
  a.viewCount === b.viewCount &&
  (a.viewOffset ?? 0) === (b.viewOffset ?? 0) &&
  (a.duration ?? 0) === (b.duration ?? 0) &&
  (a.lastViewedAt?.getTime() ?? 0) === (b.lastViewedAt?.getTime() ?? 0);

/** An episode in two libraries keeps the record viewed last */
export const mergeEpisodeCounts = (
  a: EpisodeCounts | undefined,
  b: EpisodeCounts
): EpisodeCounts => {
  if (!a) {
    return b;
  }

  const later =
    (b.lastViewedAt?.getTime() ?? 0) > (a.lastViewedAt?.getTime() ?? 0) ? b : a;

  return {
    viewCount: Math.max(a.viewCount, b.viewCount),
    viewOffset: later.viewOffset,
    duration: later.duration ?? a.duration ?? b.duration,
    lastViewedAt: later.lastViewedAt,
  };
};

export const episodeState = (counts?: EpisodeCounts): UserEpisodeState => {
  const watched = (counts?.viewCount ?? 0) > 0;

  return {
    watched,
    inProgress: !watched && (counts?.viewOffset ?? 0) > 0,
    viewOffset: counts?.viewOffset ?? null,
    duration: counts?.duration ?? null,
    lastViewedAt: counts?.lastViewedAt
      ? counts.lastViewedAt.toISOString()
      : null,
  };
};

/** How far through, 0 to 100, for a title or episode left part way */
export const progressPercent = (
  viewOffset: number | null | undefined,
  duration: number | null | undefined
): number | null =>
  viewOffset && duration && duration > 0
    ? Math.min(100, Math.max(0, Math.round((viewOffset / duration) * 100)))
    : null;

/** A Plex library item's view fields, as the person's own token sees them. */
export interface PlexViewFields {
  viewCount?: number;
  viewedLeafCount?: number;
  leafCount?: number;
  viewOffset?: number;
  /** Milliseconds */
  duration?: number;
  /** Unix seconds */
  lastViewedAt?: number;
}

const plexDate = (seconds?: number): Date | null =>
  seconds ? new Date(seconds * 1000) : null;

export const plexCounts = (item: PlexViewFields): WatchedCounts => ({
  viewCount: item.viewCount ?? 0,
  viewedLeafCount: item.viewedLeafCount ?? 0,
  leafCount: item.leafCount ?? 0,
  viewOffset: item.viewOffset ?? null,
  duration: item.duration ?? null,
  lastViewedAt: plexDate(item.lastViewedAt),
});

export const plexEpisodeCounts = (item: PlexViewFields): EpisodeCounts => ({
  viewCount: item.viewCount ?? 0,
  viewOffset: item.viewOffset ?? null,
  duration: item.duration ?? null,
  lastViewedAt: plexDate(item.lastViewedAt),
});

/** A Jellyfin or Emby item's per-user fields. */
export interface JellyfinUserFields {
  Type?: string;
  RecursiveItemCount?: number;
  /** 100 ns ticks */
  RunTimeTicks?: number;
  UserData?: {
    Played?: boolean;
    PlayCount?: number;
    UnplayedItemCount?: number;
    /** 100 ns ticks */
    PlaybackPositionTicks?: number;
    LastPlayedDate?: string;
  };
}

const ticksToMs = (ticks?: number): number | null =>
  ticks ? Math.floor(ticks / 10000) : null;

const jellyfinDate = (value?: string): Date | null => {
  const date = value ? new Date(value) : null;

  return date && !Number.isNaN(date.getTime()) ? date : null;
};

export const jellyfinCounts = (item: JellyfinUserFields): WatchedCounts => {
  const data = item.UserData ?? {};
  const lastViewedAt = jellyfinDate(data.LastPlayedDate);

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
      duration: null,
      lastViewedAt,
    };
  }

  return {
    viewCount: data.PlayCount ?? (data.Played ? 1 : 0),
    viewedLeafCount: 0,
    leafCount: 0,
    viewOffset: ticksToMs(data.PlaybackPositionTicks),
    duration: ticksToMs(item.RunTimeTicks),
    lastViewedAt,
  };
};

export const jellyfinEpisodeCounts = (
  item: JellyfinUserFields
): EpisodeCounts => {
  const data = item.UserData ?? {};

  return {
    viewCount: data.PlayCount ?? (data.Played ? 1 : 0),
    viewOffset: ticksToMs(data.PlaybackPositionTicks),
    duration: ticksToMs(item.RunTimeTicks),
    lastViewedAt: jellyfinDate(data.LastPlayedDate),
  };
};
