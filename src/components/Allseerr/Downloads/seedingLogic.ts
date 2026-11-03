import type {
  SeedingTorrent,
  TrackerAccount,
} from '@server/interfaces/api/downloadInterfaces';

export type DownloadsView = 'queue' | 'seeding';

export const DOWNLOADS_VIEWS: DownloadsView[] = ['queue', 'seeding'];

export type SeedingTone = 'bad' | 'warn' | 'ok' | 'info' | 'neutral';

export interface SeedProgress {
  // 0 to 1, null when there is no minimum or goal to measure against
  fraction: number | null;
  // Seconds still to seed before the minimum is met
  remainingSeconds: number;
  // The minimum the bar measures against, or the client goal without one
  targetSeconds: number | null;
  met: boolean;
}

/**
 * How far a torrent is towards the tracker's minimum seeding time, or the
 * client's goal when the tracker sets none
 */
export const getSeedProgress = (torrent: SeedingTorrent): SeedProgress => {
  const target = torrent.requiredSeedingSeconds ?? torrent.seedGoalSeconds;
  const seeded = Math.max(0, torrent.seedingSeconds);

  if (!target || target <= 0) {
    return {
      fraction: null,
      remainingSeconds: 0,
      targetSeconds: null,
      met: torrent.requirementMet,
    };
  }

  const met =
    torrent.requirementMet ||
    (torrent.requiredSeedingSeconds !== null &&
      seeded >= torrent.requiredSeedingSeconds);

  return {
    fraction: met ? 1 : Math.min(1, seeded / target),
    remainingSeconds: met ? 0 : Math.max(0, target - seeded),
    targetSeconds: target,
    met,
  };
};

// Torrents that still owe a private tracker seeding time come right after
// the ones at risk
const owesSeeding = (torrent: SeedingTorrent): boolean =>
  torrent.isPrivateTracker && !torrent.requirementMet;

const nameOf = (torrent: SeedingTorrent): string =>
  torrent.bookTitle ?? torrent.title;

/**
 * At risk first, then the ones still owing a private tracker seeding time
 * with the least left first, then the rest by name
 */
export const sortSeeding = (torrents: SeedingTorrent[]): SeedingTorrent[] =>
  [...torrents].sort((a, b) => {
    if (a.atRisk !== b.atRisk) {
      return a.atRisk ? -1 : 1;
    }

    if (owesSeeding(a) !== owesSeeding(b)) {
      return owesSeeding(a) ? -1 : 1;
    }

    if (owesSeeding(a) && owesSeeding(b)) {
      const left =
        getSeedProgress(a).remainingSeconds -
        getSeedProgress(b).remainingSeconds;

      if (left !== 0) {
        return left;
      }
    }

    return nameOf(a).localeCompare(nameOf(b));
  });

/**
 * The colour of a torrent's state pill and bar
 */
export const getSeedingTone = (torrent: SeedingTorrent): SeedingTone => {
  if (torrent.atRisk || torrent.state === 'error') {
    return 'bad';
  }

  if (torrent.state === 'stalled') {
    return 'warn';
  }

  if (getSeedProgress(torrent).met) {
    return 'ok';
  }

  return torrent.state === 'seeding' || torrent.state === 'downloading'
    ? 'info'
    : 'neutral';
};

/**
 * Whether the tracker account is close to its limit of unsatisfied
 * torrents, past which it cannot download more
 */
export const isNearUnsatisfiedLimit = (account: TrackerAccount): boolean =>
  account.unsatisfied !== null &&
  !!account.unsatisfiedLimit &&
  account.unsatisfied >= account.unsatisfiedLimit * 0.8;

/**
 * Ratio with two decimals, the way trackers show it
 */
export const formatRatio = (ratio: number): string =>
  (Math.floor(Math.max(0, ratio) * 100) / 100).toFixed(2);
