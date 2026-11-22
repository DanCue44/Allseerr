import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import ExternalAPI from '@server/api/externalapi';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { MediaServerType } from '@server/constants/server';
import { UserType } from '@server/constants/user';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import {
  MediaRequest,
  QuotaRestrictedError,
} from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import WatchedItem from '@server/entity/WatchedItem';
import { Permission } from '@server/lib/permissions';
import { getSettings } from '@server/lib/settings';
import { pickUnwatched } from '@server/lib/unwatchedQuota';
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
      name: `Series ${tmdbId}`,
      external_ids: {},
      seasons: [1].map((season_number) => ({ season_number })),
      videos: { results: [{ type: 'Trailer', key: 'trailer' }] },
    };
  }
);

mock.method(MediaRequest, 'sendNotification', async () => undefined);

const media = (
  id: number,
  extra: Partial<Media> = {}
): Pick<
  Media,
  | 'id'
  | 'mediaType'
  | 'tmdbId'
  | 'status'
  | 'status4k'
  | 'mediaAddedAt'
  | 'createdAt'
> => ({
  id,
  mediaType: MediaType.MOVIE,
  tmdbId: 1000 + id,
  status: MediaStatus.AVAILABLE,
  status4k: MediaStatus.UNKNOWN,
  mediaAddedAt: new Date(NOW.getTime() - 30 * DAY_MS),
  createdAt: new Date(NOW.getTime() - 40 * DAY_MS),
  ...extra,
});

describe('pickUnwatched', () => {
  it('counts available titles nobody has started', () => {
    const titles = pickUnwatched(
      [
        { is4k: false, media: media(1) },
        { is4k: false, media: media(2, { mediaType: MediaType.TV }) },
      ],
      new Map(),
      undefined,
      NOW
    );

    assert.deepEqual(
      titles.map((t) => t.mediaId),
      [1, 2]
    );
  });

  it('leaves out watched, started and unavailable titles', () => {
    const titles = pickUnwatched(
      [
        { is4k: false, media: media(1) },
        { is4k: false, media: media(2, { mediaType: MediaType.TV }) },
        { is4k: false, media: media(3, { status: MediaStatus.PROCESSING }) },
        // A 4K request counts only when the 4K version is in
        { is4k: true, media: media(4) },
        { is4k: false, media: media(5) },
      ],
      new Map([
        [`movie:1001`, { ...EMPTY_COUNTS, viewCount: 1 }],
        [`tv:1002`, { ...EMPTY_COUNTS, viewedLeafCount: 2, leafCount: 10 }],
      ]),
      undefined,
      NOW
    );

    assert.deepEqual(
      titles.map((t) => t.mediaId),
      [5]
    );
  });

  it('waits the given days after a title became available', () => {
    const titles = pickUnwatched(
      [
        { is4k: false, media: media(1) },
        {
          is4k: false,
          media: media(2, {
            mediaAddedAt: new Date(NOW.getTime() - 3 * DAY_MS),
          }),
        },
      ],
      new Map(),
      14,
      NOW
    );

    assert.deepEqual(
      titles.map((t) => t.mediaId),
      [1]
    );
  });

  it('counts a title requested twice (HD and 4K) once', () => {
    const both = media(1, { status4k: MediaStatus.AVAILABLE });
    const titles = pickUnwatched(
      [
        { is4k: false, media: both },
        { is4k: true, media: both },
      ],
      new Map(),
      undefined,
      NOW
    );

    assert.equal(titles.length, 1);
  });
});

describe('unwatched request limit', () => {
  setupTestDb();

  beforeEach(() => {
    getSettings().main.mediaServerType = MediaServerType.PLEX;
    getSettings().main.defaultQuotas.unwatched = { quotaLimit: 1 };
  });

  afterEach(() => {
    getSettings().main.defaultQuotas.unwatched = {};
  });

  async function plexUser(
    email: string,
    permissions = Permission.REQUEST,
    userType = UserType.PLEX
  ): Promise<User> {
    return getRepository(User).save(
      new User({ email, permissions, avatar: '', userType })
    );
  }

  async function availableRequest(user: User, tmdbId: number) {
    const item = await getRepository(Media).save(
      new Media({
        tmdbId,
        mediaType: MediaType.MOVIE,
        status: MediaStatus.AVAILABLE,
        mediaAddedAt: new Date(Date.now() - 30 * DAY_MS),
      })
    );

    await getRepository(MediaRequest).save(
      new MediaRequest({
        media: item,
        requestedBy: user,
        type: MediaType.MOVIE,
        status: MediaRequestStatus.COMPLETED,
        is4k: false,
      })
    );

    return item;
  }

  it('holds new requests once more than the limit are unwatched', async () => {
    const user = await plexUser('unwatched@example.com');
    await availableRequest(user, 501);
    await availableRequest(user, 502);

    const quota = await user.getQuota();
    assert.equal(quota.unwatched?.used, 2);
    assert.equal(quota.unwatched?.restricted, true);

    await assert.rejects(
      MediaRequest.request(
        { mediaId: 503, mediaType: MediaType.MOVIE, is4k: false },
        user
      ),
      (e: Error) =>
        e instanceof QuotaRestrictedError &&
        /2 requested titles available and unwatched/.test(e.message) &&
        /Movie 501, Movie 502/.test(e.message)
    );
  });

  it('opens again once a title is watched', async () => {
    const user = await plexUser('watcher@example.com');
    await availableRequest(user, 511);
    await availableRequest(user, 512);
    await getRepository(WatchedItem).save(
      new WatchedItem({
        user,
        mediaType: MediaType.MOVIE,
        tmdbId: 511,
        viewCount: 1,
      })
    );

    const quota = await user.getQuota();
    assert.equal(quota.unwatched?.used, 1);
    assert.equal(quota.unwatched?.restricted, false);
  });

  it('follows the per-user override', async () => {
    const user = await plexUser('override@example.com');
    user.unwatchedQuotaLimit = 5;
    await getRepository(User).save(user);
    await availableRequest(user, 521);
    await availableRequest(user, 522);

    const quota = await user.getQuota();
    assert.equal(quota.unwatched?.limit, 5);
    assert.equal(quota.unwatched?.restricted, false);
  });

  it('never applies to local users or user managers', async () => {
    const local = await plexUser(
      'local@example.com',
      Permission.REQUEST,
      UserType.LOCAL
    );
    await availableRequest(local, 531);
    await availableRequest(local, 532);
    const manager = await plexUser(
      'manager@example.com',
      Permission.MANAGE_USERS
    );
    await availableRequest(manager, 533);
    await availableRequest(manager, 534);

    assert.equal((await local.getQuota()).unwatched?.restricted, false);
    assert.equal((await manager.getQuota()).unwatched?.restricted, false);
  });

  it('is off without a limit', async () => {
    getSettings().main.defaultQuotas.unwatched = {};
    const user = await plexUser('nolimit@example.com');
    await availableRequest(user, 541);
    await availableRequest(user, 542);

    const quota = await user.getQuota();
    assert.equal(quota.unwatched?.restricted, false);
    assert.equal(quota.unwatched?.used, 0);
  });
});
