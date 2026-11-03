import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type {
  ServarrHistoryRecord,
  ServarrRelease,
} from '@server/api/servarr/base';
import type { ArrRelease } from '@server/interfaces/api/arrActionInterfaces';
import {
  compareReleases,
  explainGrabError,
  markGrabbedReleases,
  normalizeRelease,
  pickGrabs,
} from '@server/lib/arrActions';

// Trimmed from real /release answers of each arr
const radarrRelease: ServarrRelease = {
  guid: 'https://indexer-a.example.com/details/4f1e2d3c4b5a69788796a5b4c3d2e1f0',
  quality: {
    quality: { id: 22, name: 'BR-DISK', source: 'bluray', resolution: 1080 },
    revision: { version: 1, real: 0, isRepack: false },
  },
  customFormats: [],
  customFormatScore: 0,
  qualityWeight: 2401,
  age: 894,
  ageHours: 21459.8264516535,
  size: 49425320958,
  indexerId: 3,
  indexer: 'Indexer A (Prowlarr)',
  releaseGroup: 'BUTTLERZ',
  title: 'Avengers.Infinity.War.2018.iNTERNAL.COMPLETE.BLURAY-BUTTLERZ',
  languages: [{ id: 1, name: 'English' }],
  mappedMovieId: 1,
  approved: false,
  temporarilyRejected: false,
  rejected: true,
  rejections: [
    'BR-DISK is not wanted in profile',
    'Existing file meets cutoff: Remux-2160p []',
  ],
  publishDate: '2024-04-28T20:02:21Z',
  infoUrl:
    'https://indexer-a.example.com/details/4f1e2d3c4b5a69788796a5b4c3d2e1f0',
  downloadAllowed: true,
  protocol: 'usenet',
};

const sonarrRelease: ServarrRelease = {
  guid: 'https://indexer-a.example.com/details/0a9b8c7d6e5f40312213a4b5c6d7e8f9',
  quality: {
    quality: { id: 15, name: 'WEBRip-1080p' },
  },
  qualityWeight: 1102,
  ageHours: 56518.63238436322,
  size: 4830312257,
  indexerId: 5,
  indexer: 'Indexer A (Prowlarr)',
  releaseGroup: 'TrollHD',
  title: 'Almost.Human.S01E01.PROPER.1080p.WEBRip.DD5.1.x264-TrollHD-xpost',
  fullSeason: false,
  seasonNumber: 1,
  languages: [{ id: 1, name: 'English' }],
  mappedSeriesId: 3,
  mappedEpisodeInfo: [{ id: 320, seasonNumber: 1, episodeNumber: 1 }],
  approved: true,
  rejections: [],
  customFormatScore: 0,
  protocol: 'usenet',
};

const sonarrTorrent: ServarrRelease = {
  guid: 'magnet-1',
  indexerId: 7,
  title: 'Almost.Human.S01.1080p.BluRay.x264-ROVERS',
  size: 30_000_000_000,
  ageHours: 12,
  indexer: 'Torrent Indexer',
  protocol: 'torrent',
  seeders: 41,
  leechers: 3,
  quality: { quality: { name: 'Bluray-1080p' } },
  qualityWeight: 1400,
  languages: [{ id: 1, name: 'English' }],
  approved: false,
  // Some arr versions send rejections as objects
  rejections: [{ reason: 'Not enough seeders', type: 'permanent' }],
};

const lidarrRelease: ServarrRelease = {
  guid: '3_https://indexer-a.example.com/details/7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a29',
  quality: { quality: { id: 6, name: 'FLAC' } },
  qualityWeight: 601,
  ageHours: 4507.7554307405,
  size: 211014626,
  indexerId: 3,
  indexer: 'Indexer A (Prowlarr)',
  title: 'Michael Jackson - Music and Me  1973 - Soul   Flac 16-44-xpost',
  discography: false,
  artistName: 'Michael Jackson',
  albumTitle: 'Music and Me',
  approved: false,
  rejected: true,
  rejections: [
    'Existing files on disk is of equal or higher preference: FLAC v1',
  ],
  customFormatScore: 0,
  protocol: 'usenet',
};

const chaptarrRelease: ServarrRelease = {
  guid: 'https://indexer-a.example.com/details/e1d2c3b4a5968778695a4b3c2d1e0f12',
  quality: { quality: { id: 3, name: 'EPUB' } },
  qualityWeight: 301,
  ageHours: 27657.323616294332,
  size: 4489827,
  indexerId: 1,
  indexer: 'Indexer A (Prowlarr)',
  title: 'Steve.Jobs.by.Walter.Isaacson.EPUB-xpost',
  approved: true,
  rejections: [],
  rejectionDetails: [],
  customFormatScore: 0,
  protocol: 'usenet',
  authorId: 3,
  bookId: 2749,
  formatType: 'ebook',
};

describe('normalizeRelease', () => {
  it('normalizes a Radarr release', () => {
    assert.deepStrictEqual(normalizeRelease(radarrRelease), {
      guid: radarrRelease.guid,
      indexerId: 3,
      title: 'Avengers.Infinity.War.2018.iNTERNAL.COMPLETE.BLURAY-BUTTLERZ',
      size: 49425320958,
      ageHours: 21459.8264516535,
      indexer: 'Indexer A (Prowlarr)',
      protocol: 'usenet',
      quality: 'BR-DISK',
      qualityWeight: 2401,
      languages: ['English'],
      approved: false,
      rejections: [
        'BR-DISK is not wanted in profile',
        'Existing file meets cutoff: Remux-2160p []',
      ],
      customFormatScore: 0,
      releaseGroup: 'BUTTLERZ',
      infoUrl: radarrRelease.infoUrl,
    });
  });

  it('normalizes a Sonarr release', () => {
    const release = normalizeRelease(sonarrRelease);

    assert.strictEqual(release.quality, 'WEBRip-1080p');
    assert.strictEqual(release.approved, true);
    assert.deepStrictEqual(release.rejections, []);
    assert.deepStrictEqual(release.languages, ['English']);
    assert.strictEqual(release.seeders, undefined);
  });

  it('keeps seeders of torrents and reads rejection objects', () => {
    const release = normalizeRelease(sonarrTorrent);

    assert.strictEqual(release.protocol, 'torrent');
    assert.strictEqual(release.seeders, 41);
    assert.strictEqual(release.leechers, 3);
    assert.deepStrictEqual(release.rejections, ['Not enough seeders']);
  });

  it('normalizes a Lidarr release, which has no languages', () => {
    const release = normalizeRelease(lidarrRelease);

    assert.strictEqual(release.quality, 'FLAC');
    assert.deepStrictEqual(release.languages, []);
    assert.strictEqual(release.approved, false);
    assert.strictEqual(release.rejections.length, 1);
  });

  it('normalizes a Chaptarr release and never approves a hidden one', () => {
    assert.strictEqual(normalizeRelease(chaptarrRelease).approved, true);

    const hidden = normalizeRelease(chaptarrRelease, { hidden: true });
    assert.strictEqual(hidden.approved, false);
    assert.deepStrictEqual(hidden.rejections, [
      'Hidden by a release filter in Chaptarr',
    ]);
  });

  it('adds the Talearr rejection labels only when asked to', () => {
    const rejected: ServarrRelease = {
      ...chaptarrRelease,
      approved: false,
      rejections: [
        'Wanted language is English, found German',
        'Release is a pack of 12 books',
        'Wanted language is English, found French',
      ],
      rejectionDetails: [
        {
          reason: 'Wanted language is English, found German',
          label: 'Language',
          source: 'LanguageSpecification',
        },
        { reason: 'Release is a pack of 12 books', label: 'Pack' },
        {
          reason: 'Wanted language is English, found French',
          label: ' Language ',
        },
        // Stock Chaptarr sends details without labels
        { reason: 'Size', category: 'Size' },
      ],
    };

    assert.deepStrictEqual(
      normalizeRelease(rejected, { rejectionLabels: true }).rejectionLabels,
      ['Language', 'Pack']
    );
    assert.strictEqual(normalizeRelease(rejected).rejectionLabels, undefined);
    assert.strictEqual(
      normalizeRelease(chaptarrRelease, { rejectionLabels: true })
        .rejectionLabels,
      undefined
    );
  });

  it('names the book service that hid a release', () => {
    assert.deepStrictEqual(
      normalizeRelease(chaptarrRelease, {
        hidden: true,
        serviceName: 'Talearr',
      }).rejections,
      ['Hidden by a release filter in Talearr']
    );
  });

  it('works out the age from the publish date when ageHours is missing', () => {
    const release = normalizeRelease({
      guid: 'g',
      indexerId: 1,
      publishDate: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    });

    assert.ok(Math.abs(release.ageHours - 2) < 0.01);
    assert.strictEqual(release.quality, 'Unknown');
    assert.strictEqual(release.protocol, 'unknown');
  });
});

describe('compareReleases', () => {
  it('lists approved releases first, then by quality, size and age', () => {
    const releases = [
      normalizeRelease(radarrRelease),
      normalizeRelease({ ...sonarrRelease, guid: 'small', size: 1 }),
      normalizeRelease(sonarrRelease),
      normalizeRelease(sonarrTorrent),
    ].sort(compareReleases);

    assert.deepStrictEqual(
      releases.map((release) => release.guid),
      [sonarrRelease.guid, 'small', radarrRelease.guid, 'magnet-1']
    );
  });
});

const record = (
  id: number,
  eventType: string,
  downloadId: string,
  date: string,
  extra: Partial<ServarrHistoryRecord> = {}
): ServarrHistoryRecord => ({
  id,
  eventType,
  downloadId,
  date,
  sourceTitle: `release-${downloadId}`,
  ...extra,
});

describe('pickGrabs', () => {
  it('picks the grab of the download that was imported last', () => {
    const grabs = pickGrabs([
      record(11, 'grabbed', 'A', '2026-01-01T00:00:00Z'),
      record(12, 'downloadFolderImported', 'A', '2026-01-01T01:00:00Z'),
      // A newer grab that failed and was never imported
      record(13, 'grabbed', 'B', '2026-02-01T00:00:00Z'),
      record(14, 'downloadFailed', 'B', '2026-02-01T01:00:00Z'),
    ]);

    assert.deepStrictEqual(
      grabs.map((grab) => grab.id),
      [11]
    );
  });

  it('falls back to the newest grab without an import', () => {
    const grabs = pickGrabs([
      record(1, 'grabbed', 'A', '2026-01-01T00:00:00Z'),
      record(2, 'grabbed', 'B', '2026-03-01T00:00:00Z'),
    ]);

    assert.deepStrictEqual(
      grabs.map((grab) => grab.id),
      [2]
    );
  });

  it('ignores an incomplete import', () => {
    const grabs = pickGrabs([
      record(4, 'grabbed', 'C', '2026-01-01T00:00:00Z'),
      record(5, 'bookImportIncomplete', 'C', '2026-01-01T00:01:00Z'),
      record(11, 'grabbed', 'F', '2026-01-02T00:00:00Z'),
      record(12, 'bookFileImported', 'F', '2026-01-02T00:01:00Z'),
    ]);

    assert.deepStrictEqual(
      grabs.map((grab) => grab.id),
      [11]
    );
  });

  it('lists a season pack once for all its episodes', () => {
    const history = [320, 321, 322].flatMap((episodeId, i) => [
      record(100 + i, 'grabbed', 'PACK', '2026-01-01T00:00:00Z', {
        episodeId,
      }),
      record(
        200 + i,
        'downloadFolderImported',
        'PACK',
        '2026-01-01T01:00:00Z',
        {
          episodeId,
        }
      ),
    ]);
    history.push(
      record(300, 'grabbed', 'SINGLE', '2026-02-01T00:00:00Z', {
        episodeId: 323,
      })
    );

    const grabs = pickGrabs(history, (r) => r.episodeId ?? 0);

    assert.deepStrictEqual(grabs.map((grab) => grab.downloadId).sort(), [
      'PACK',
      'SINGLE',
    ]);
  });
});

describe('markGrabbedReleases', () => {
  const release = (guid: string, infoHash?: string): ArrRelease => ({
    guid,
    indexerId: 1,
    title: guid,
    size: 1,
    ageHours: 1,
    indexer: 'Indexer',
    protocol: 'torrent',
    quality: 'EPUB',
    qualityWeight: 1,
    languages: [],
    approved: true,
    rejections: [],
    ...(infoHash && { infoHash }),
  });
  const grab = (
    id: number,
    downloadId: string,
    guid: string,
    date = '2026-10-31T15:45:02Z'
  ): ServarrHistoryRecord => ({
    id,
    eventType: 'grabbed',
    date,
    downloadId,
    data: { guid, downloadClientName: 'qBittorrent (VPN)' },
  });

  it('marks the grabbed release still in the client and lists it first', () => {
    const marked = markGrabbedReleases(
      [release('OTHER-1'), release('TRK-1165528')],
      [grab(1, 'DFBAEACB', 'TRK-1165528')],
      [{ downloadId: 'dfbaeacb', trackedDownloadState: 'importBlocked' }]
    );

    assert.strictEqual(marked[0].guid, 'TRK-1165528');
    assert.deepStrictEqual(marked[0].grabbed, {
      date: '2026-10-31T15:45:02Z',
      state: 'importBlocked',
      downloadClient: 'qBittorrent (VPN)',
    });
    assert.strictEqual(marked[1].grabbed, undefined);
  });

  it('matches by info hash when the guid differs', () => {
    const [marked] = markGrabbedReleases(
      [release('other-guid', 'ABC123')],
      [grab(1, 'abc123', 'old-guid')],
      [{ downloadId: 'ABC123', trackedDownloadState: 'downloading' }]
    );

    assert.strictEqual(marked.grabbed?.state, 'downloading');
  });

  it('tells an imported grab from one long gone', () => {
    const marked = markGrabbedReleases(
      [release('A'), release('B')],
      [
        grab(1, 'h-a', 'A'),
        grab(2, 'h-b', 'B'),
        {
          id: 3,
          eventType: 'bookFileImported',
          date: '2026-10-31T16:00:00Z',
          downloadId: 'h-a',
        },
      ]
    );

    assert.strictEqual(
      marked.find((r) => r.guid === 'A')?.grabbed?.state,
      'imported'
    );
    assert.strictEqual(
      marked.find((r) => r.guid === 'B')?.grabbed?.state,
      'earlier'
    );
  });

  it('leaves the list alone without grabs', () => {
    const releases = [release('A')];
    assert.strictEqual(markGrabbedReleases(releases, []), releases);
  });
});

describe('explainGrabError', () => {
  it('says plainly that the client already has the download', () => {
    const error = explainGrabError(
      new Error(
        '[Chaptarr] Failed to grab the release: Download client rejected release: qBittorrent rejected the torrent file due to a conflict: qBittorrent API request failed (HTTP 409 Conflict). Conflict'
      )
    );

    assert.match(error.message, /already in qBittorrent/);
    assert.match(error.message, /retry its import/);
  });

  it('keeps other errors as the arr sent them', () => {
    const error = explainGrabError(new Error('Indexer is down'));
    assert.strictEqual(error.message, 'Indexer is down');
  });
});
