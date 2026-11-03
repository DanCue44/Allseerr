import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { SeedingTorrent } from '@server/interfaces/api/downloadInterfaces';
import {
  formatRatio,
  getSeedProgress,
  getSeedingTone,
  isNearUnsatisfiedLimit,
  sortSeeding,
} from './seedingLogic';

const HOUR = 3600;

const torrent = (overrides: Partial<SeedingTorrent>): SeedingTorrent => ({
  downloadId: 'abc',
  title: 'Release.m4b',
  bookId: 1,
  bookTitle: 'Book',
  authorName: 'Author',
  mediaType: 'audiobook',
  indexer: 'Example Tracker',
  isPrivateTracker: true,
  isFiller: false,
  downloadClient: 'qBittorrent',
  state: 'seeding',
  size: 100,
  uploaded: 10,
  ratio: 0.1,
  seedingSeconds: HOUR,
  requiredSeedingSeconds: 72 * HOUR,
  seedGoalSeconds: 30 * 24 * HOUR,
  requirementMet: false,
  atRisk: false,
  riskReason: null,
  addedAt: null,
  completedAt: null,
  ...overrides,
});

describe('getSeedProgress', () => {
  it('measures the seeded time against the tracker minimum', () => {
    const progress = getSeedProgress(torrent({ seedingSeconds: 18 * HOUR }));

    assert.strictEqual(progress.fraction, 0.25);
    assert.strictEqual(progress.remainingSeconds, 54 * HOUR);
    assert.strictEqual(progress.targetSeconds, 72 * HOUR);
    assert.strictEqual(progress.met, false);
  });

  it('is full once the minimum is met', () => {
    const progress = getSeedProgress(
      torrent({ seedingSeconds: 80 * HOUR, requirementMet: true })
    );

    assert.strictEqual(progress.fraction, 1);
    assert.strictEqual(progress.remainingSeconds, 0);
    assert.strictEqual(progress.met, true);
  });

  it('uses the client goal for public trackers', () => {
    const progress = getSeedProgress(
      torrent({
        isPrivateTracker: false,
        isFiller: false,
        requiredSeedingSeconds: null,
        seedGoalSeconds: 10 * HOUR,
        seedingSeconds: 5 * HOUR,
      })
    );

    assert.strictEqual(progress.fraction, 0.5);
    assert.strictEqual(progress.targetSeconds, 10 * HOUR);
  });

  it('has no bar without a minimum or a goal', () => {
    const progress = getSeedProgress(
      torrent({ requiredSeedingSeconds: null, seedGoalSeconds: null })
    );

    assert.strictEqual(progress.fraction, null);
    assert.strictEqual(progress.targetSeconds, null);
  });
});

describe('sortSeeding', () => {
  it('puts at risk torrents first, then the least seeding time left', () => {
    const sorted = sortSeeding([
      torrent({ downloadId: 'done', bookTitle: 'A', requirementMet: true }),
      torrent({
        downloadId: 'public',
        bookTitle: 'B',
        isPrivateTracker: false,
        isFiller: false,
      }),
      torrent({ downloadId: 'far', seedingSeconds: HOUR }),
      torrent({ downloadId: 'close', seedingSeconds: 70 * HOUR }),
      torrent({
        downloadId: 'risk',
        state: 'paused',
        atRisk: true,
        riskReason: 'Paused before 72 h of seeding',
      }),
    ]);

    assert.deepStrictEqual(
      sorted.map((item) => item.downloadId),
      ['risk', 'close', 'far', 'done', 'public']
    );
  });

  it('leaves the list it was given alone', () => {
    const list = [
      torrent({ downloadId: 'b', bookTitle: 'B' }),
      torrent({ downloadId: 'a', bookTitle: 'A', atRisk: true }),
    ];

    sortSeeding(list);
    assert.strictEqual(list[0].downloadId, 'b');
  });
});

describe('getSeedingTone', () => {
  it('words the state of a torrent', () => {
    assert.strictEqual(getSeedingTone(torrent({ atRisk: true })), 'bad');
    assert.strictEqual(getSeedingTone(torrent({ state: 'error' })), 'bad');
    assert.strictEqual(getSeedingTone(torrent({ state: 'stalled' })), 'warn');
    assert.strictEqual(getSeedingTone(torrent({ requirementMet: true })), 'ok');
    assert.strictEqual(getSeedingTone(torrent({})), 'info');
    assert.strictEqual(getSeedingTone(torrent({ state: 'queued' })), 'neutral');
  });
});

describe('isNearUnsatisfiedLimit', () => {
  const account = {
    userClass: 'User',
    isVip: false,
    unsatisfied: 10,
    unsatisfiedLimit: 20,
    wedges: 0,
    bonusPoints: 0,
    checkedAt: null,
  };

  it('warns from 80 percent of the limit', () => {
    assert.strictEqual(isNearUnsatisfiedLimit(account), false);
    assert.strictEqual(
      isNearUnsatisfiedLimit({ ...account, unsatisfied: 16 }),
      true
    );
    assert.strictEqual(
      isNearUnsatisfiedLimit({ ...account, unsatisfiedLimit: null }),
      false
    );
  });
});

describe('formatRatio', () => {
  it('keeps two decimals without rounding up', () => {
    assert.strictEqual(formatRatio(0.149), '0.14');
    assert.strictEqual(formatRatio(1), '1.00');
    assert.strictEqual(formatRatio(-1), '0.00');
  });
});
