import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import type { SeedingTorrent } from '@server/interfaces/api/downloadInterfaces';
import cacheManager from '@server/lib/cache';
import { addLookupCovers } from '@server/lib/seedingCovers';

const torrent = (overrides: Partial<SeedingTorrent>): SeedingTorrent => ({
  downloadId: 'hash',
  title: 'Ghostface Killer - M Never.m4b',
  bookId: null,
  bookTitle: 'Ghostface Killer',
  authorName: 'M Never',
  mediaType: 'audiobook',
  indexer: 'Private Tracker',
  isPrivateTracker: true,
  isFiller: true,
  downloadClient: 'qBittorrent',
  state: 'seeding',
  size: 1,
  uploaded: 0,
  ratio: 0,
  seedingSeconds: 0,
  requiredSeedingSeconds: null,
  seedGoalSeconds: null,
  requirementMet: false,
  atRisk: false,
  riskReason: null,
  addedAt: null,
  completedAt: null,
  ...overrides,
});

const talearrWith = (remoteUrl: string | null, terms: string[] = []) => ({
  lookupBooks: async (term: string) => {
    terms.push(term);
    return (
      remoteUrl
        ? [{ title: 'x', images: [{ coverType: 'Cover', remoteUrl }] }]
        : []
    ) as never;
  },
});

describe('addLookupCovers', () => {
  beforeEach(() => {
    cacheManager.getCache('chaptarr').flush();
  });

  it('uses the cover Talearr looks up from the title and author', async () => {
    const terms: string[] = [];
    const torrents = [torrent({})];

    await addLookupCovers(
      { talearr: talearrWith('https://covers.test/a.jpg', terms) },
      torrents
    );

    assert.deepStrictEqual(terms, ['Ghostface Killer M Never']);
    assert.strictEqual(torrents[0].posterUrl, 'https://covers.test/a.jpg');
  });

  it('falls back to Google Books when Talearr has no cover', async () => {
    const torrents = [torrent({})];

    await addLookupCovers(
      {
        talearr: talearrWith(null),
        googleBooks: { findCover: async () => 'https://books.test/b.jpg' },
      },
      torrents
    );

    assert.strictEqual(torrents[0].posterUrl, 'https://books.test/b.jpg');
  });

  it('remembers covers so the next load asks nobody', async () => {
    const terms: string[] = [];

    await addLookupCovers(
      { talearr: talearrWith('https://covers.test/a.jpg', terms) },
      [torrent({})]
    );
    const again = [torrent({})];
    await addLookupCovers(
      { talearr: talearrWith('https://covers.test/other.jpg', terms) },
      again
    );

    assert.strictEqual(terms.length, 1);
    assert.strictEqual(again[0].posterUrl, 'https://covers.test/a.jpg');
  });

  it('leaves library books and torrents with a cover alone', async () => {
    const terms: string[] = [];
    const torrents = [
      torrent({ downloadId: 'book', bookId: 7, isFiller: false }),
      torrent({ downloadId: 'covered', posterUrl: 'https://x.test/c.jpg' }),
    ];

    await addLookupCovers(
      { talearr: talearrWith('https://covers.test/a.jpg', terms) },
      torrents
    );

    assert.deepStrictEqual(terms, []);
    assert.strictEqual(torrents[0].posterUrl, undefined);
    assert.strictEqual(torrents[1].posterUrl, 'https://x.test/c.jpg');
  });
});
