import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import ExternalAPI from '@server/api/externalapi';
import RadarrAPI from '@server/api/servarr/radarr';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
  RemovalRequestStatus,
} from '@server/constants/media';
import { MediaServerType } from '@server/constants/server';
import { UserType } from '@server/constants/user';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import RemovalRequest from '@server/entity/RemovalRequest';
import { User } from '@server/entity/User';
import WatchedItem from '@server/entity/WatchedItem';
import notificationManager from '@server/lib/notifications';
import { Permission } from '@server/lib/permissions';
import type { RadarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import type { RequestedVersion } from '@server/lib/watchedCleanup';
import {
  CLEANUP_REASON,
  WatchedCleanupDisabledError,
  actOnCleanupSuggestions,
  getCleanupSuggestions,
  pickCleanupSuggestions,
  versionKey,
  watchedKey,
} from '@server/lib/watchedCleanup';
import { EMPTY_COUNTS } from '@server/lib/watchedState';
import { setupTestDb } from '@server/test/db';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-11-20T12:00:00Z');

mock.method(
  ExternalAPI.prototype as unknown as {
    get: (endpoint: string) => Promise<unknown>;
  },
  'get',
  async (endpoint: string) => {
    const tmdbId = Number(endpoint.replace(/^\/(movie|tv)\//, ''));

    if (!tmdbId) {
      throw new Error(`Unstubbed external endpoint: ${endpoint}`);
    }

    return {
      id: tmdbId,
      title: `Movie ${tmdbId}`,
      poster_path: '/poster.jpg',
      external_ids: {},
      videos: { results: [{ type: 'Trailer', key: 'trailer' }] },
    };
  }
);
mock.method(notificationManager, 'sendNotification', () => undefined);
const removeMovie = mock.fn(async () => undefined);
const removeMovieMock = removeMovie.mock;
// removeMovie is an instance property, so it is replaced through the prototype
Object.defineProperty(RadarrAPI.prototype, 'removeMovie', {
  get() {
    return removeMovie;
  },
  set() {},
  configurable: true,
});

const plex = (id: number) => ({
  id,
  displayName: `User ${id}`,
  avatar: '',
  userType: UserType.PLEX,
});

const version = (
  requesters: RequestedVersion['requesters'],
  extra: Partial<RequestedVersion['media']> = {}
): RequestedVersion => ({
  is4k: false,
  media: {
    id: 1,
    mediaType: MediaType.MOVIE,
    tmdbId: 100,
    status: MediaStatus.AVAILABLE,
    status4k: MediaStatus.UNKNOWN,
    ...extra,
  },
  requesters,
});

const watchedAt = (daysAgo: number) => ({
  ...EMPTY_COUNTS,
  viewCount: 1,
  lastViewedAt: new Date(NOW.getTime() - daysAgo * DAY_MS),
});

describe('pickCleanupSuggestions', () => {
  beforeEach(() => {
    getSettings().main.mediaServerType = MediaServerType.PLEX;
  });

  it('suggests a title every requester has watched', () => {
    const suggestions = pickCleanupSuggestions(
      [version([plex(1), plex(2)])],
      new Map([
        [watchedKey(1, MediaType.MOVIE, 100), watchedAt(10)],
        [watchedKey(2, MediaType.MOVIE, 100), watchedAt(5)],
      ]),
      new Set(),
      0,
      NOW
    );

    assert.equal(suggestions.length, 1);
    assert.equal(suggestions[0].requesters.length, 2);
    assert.equal(
      suggestions[0].lastWatchedAt,
      new Date(NOW.getTime() - 5 * DAY_MS).toISOString()
    );
  });

  it('keeps a title while any requester has not finished it', () => {
    const suggestions = pickCleanupSuggestions(
      [
        version([plex(1), plex(2)]),
        // A series part way through is not finished
        version([plex(1)], { id: 2, tmdbId: 200, mediaType: MediaType.TV }),
      ],
      new Map([
        [watchedKey(1, MediaType.MOVIE, 100), watchedAt(10)],
        [
          watchedKey(1, MediaType.TV, 200),
          { ...EMPTY_COUNTS, viewedLeafCount: 3, leafCount: 8 },
        ],
      ]),
      new Set(),
      0,
      NOW
    );

    assert.equal(suggestions.length, 0);
  });

  it('waits the given days after the last requester finished', () => {
    const suggestions = pickCleanupSuggestions(
      [version([plex(1)]), version([plex(1)], { id: 2, tmdbId: 101 })],
      new Map([
        [watchedKey(1, MediaType.MOVIE, 100), watchedAt(40)],
        [watchedKey(1, MediaType.MOVIE, 101), watchedAt(3)],
      ]),
      new Set(),
      30,
      NOW
    );

    assert.deepEqual(
      suggestions.map((s) => s.mediaId),
      [1]
    );
  });

  it('leaves out local requesters, unavailable titles and pending removals', () => {
    const watched = new Map([
      [watchedKey(1, MediaType.MOVIE, 100), watchedAt(10)],
      [watchedKey(1, MediaType.MOVIE, 101), watchedAt(10)],
      [watchedKey(3, MediaType.MOVIE, 102), watchedAt(10)],
    ]);
    const suggestions = pickCleanupSuggestions(
      [
        version([plex(1)]),
        version([plex(1)], {
          id: 2,
          tmdbId: 101,
          status: MediaStatus.PROCESSING,
        }),
        version([{ ...plex(3), userType: UserType.LOCAL }], {
          id: 3,
          tmdbId: 102,
        }),
      ],
      watched,
      new Set([versionKey(1, false)]),
      0,
      NOW
    );

    assert.equal(suggestions.length, 0);
  });
});

describe('watched cleanup', () => {
  setupTestDb();

  beforeEach(() => {
    removeMovieMock.resetCalls();
    getSettings().main.mediaServerType = MediaServerType.PLEX;
    getSettings().main.watchedCleanup = { enabled: true, days: 0 };
    getSettings().radarr = [
      {
        id: 0,
        name: 'Radarr',
        hostname: 'radarr.local',
        port: 7878,
        apiKey: 'key',
        useSsl: false,
        baseUrl: '',
        isDefault: true,
        is4k: false,
      } as RadarrSettings,
    ];
  });

  afterEach(() => {
    getSettings().main.watchedCleanup = { enabled: false, days: 0 };
    getSettings().radarr = [];
  });

  async function seedWatchedTitle(tmdbId: number) {
    const user = await getRepository(User).save(
      new User({
        email: `viewer${tmdbId}@example.com`,
        permissions: Permission.REQUEST,
        avatar: '',
        userType: UserType.PLEX,
      })
    );
    const media = await getRepository(Media).save(
      new Media({
        tmdbId,
        mediaType: MediaType.MOVIE,
        status: MediaStatus.AVAILABLE,
      })
    );
    await getRepository(MediaRequest).save(
      new MediaRequest({
        media,
        requestedBy: user,
        type: MediaType.MOVIE,
        status: MediaRequestStatus.COMPLETED,
        is4k: false,
      })
    );
    await getRepository(WatchedItem).save(
      new WatchedItem({
        user,
        mediaType: MediaType.MOVIE,
        tmdbId,
        viewCount: 1,
        lastViewedAt: new Date(Date.now() - DAY_MS),
      })
    );

    return media;
  }

  const admin = () =>
    getRepository(User).findOneOrFail({ where: { email: 'admin@seerr.dev' } });

  it('lists watched titles with their names', async () => {
    const media = await seedWatchedTitle(701);
    const suggestions = await getCleanupSuggestions();

    assert.equal(suggestions.length, 1);
    assert.equal(suggestions[0].mediaId, media.id);
    assert.equal(suggestions[0].title, 'Movie 701');
  });

  it('is refused while turned off', async () => {
    getSettings().main.watchedCleanup = { enabled: false, days: 0 };

    await assert.rejects(getCleanupSuggestions(), WatchedCleanupDisabledError);
  });

  it('creates removal requests without removing anything', async () => {
    const media = await seedWatchedTitle(702);
    const results = await actOnCleanupSuggestions(
      [{ mediaId: media.id }],
      'request',
      await admin()
    );

    assert.equal(results[0].status, 'requested');
    const removal = await getRepository(RemovalRequest).findOneOrFail({
      where: { media: { id: media.id } },
    });
    assert.equal(removal.status, RemovalRequestStatus.PENDING);
    assert.equal(removal.reason, CLEANUP_REASON);
    assert.equal(removeMovieMock.callCount(), 0);

    // Once requested it leaves the list
    assert.equal((await getCleanupSuggestions()).length, 0);
  });

  it('removes through the removal request when asked to', async () => {
    const media = await seedWatchedTitle(703);
    const results = await actOnCleanupSuggestions(
      [{ mediaId: media.id }],
      'remove',
      await admin()
    );

    assert.equal(results[0].status, 'removed');
    assert.equal(removeMovieMock.callCount(), 1);
    const removal = await getRepository(RemovalRequest).findOneOrFail({
      where: { media: { id: media.id } },
    });
    assert.equal(removal.status, RemovalRequestStatus.APPROVED);
  });

  it('skips titles that are not suggested', async () => {
    const media = await getRepository(Media).save(
      new Media({
        tmdbId: 704,
        mediaType: MediaType.MOVIE,
        status: MediaStatus.AVAILABLE,
      })
    );
    const results = await actOnCleanupSuggestions(
      [{ mediaId: media.id }],
      'remove',
      await admin()
    );

    assert.equal(results[0].status, 'skipped');
    assert.equal(removeMovieMock.callCount(), 0);
  });
});
