import assert from 'node:assert/strict';
import { afterEach, before, beforeEach, describe, it, mock } from 'node:test';

import CoverArtArchive from '@server/api/coverartarchive';
import MusicBrainz from '@server/api/musicbrainz';
import type { MbReleaseGroup } from '@server/api/musicbrainz/interfaces';
import type {
  LidarrAlbum,
  LidarrAlbumOptions,
} from '@server/api/servarr/lidarr';
import LidarrAPI from '@server/api/servarr/lidarr';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import OverrideRule from '@server/entity/OverrideRule';
import { User } from '@server/entity/User';
import { Notification } from '@server/lib/notifications';
import { Permission } from '@server/lib/permissions';
import type { LidarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { checkUser } from '@server/middleware/auth';
import authRoutes from '@server/routes/auth';
import requestRoutes from '@server/routes/request';
import { settleTestBackgroundTasks, setupTestDb } from '@server/test/db';
import type { Express } from 'express';
import express from 'express';
import session from 'express-session';
import request from 'supertest';

const ALBUM_MBID = '1dc4c347-a1db-32aa-b14f-bc9cc507b843';
const OTHER_ALBUM_MBID = 'b1392450-e666-3926-a536-22c65f834433';

const sendNotificationMock = mock.method(
  MediaRequest,
  'sendNotification',
  async () => undefined
).mock;

mock.method(
  MusicBrainz.prototype,
  'getAlbum',
  async ({ releaseGroupId }: { releaseGroupId: string }) =>
    ({
      id: releaseGroupId,
      title: 'OK Computer',
      'primary-type': 'Album',
      'first-release-date': '1997-05-21',
      'artist-credit': [
        {
          name: 'Radiohead',
          artist: {
            id: 'a74b1b7f-71a5-4011-9441-d0b5e4122711',
            name: 'Radiohead',
            'sort-name': 'Radiohead',
          },
        },
      ],
    }) as MbReleaseGroup
);

// The availability notification looks up the artist and the cover
mock.method(
  MusicBrainz.prototype,
  'getArtistWikipediaExtract',
  async () => null
);
mock.method(CoverArtArchive.prototype, 'getFrontCoverUrl', async () => null);

// Kept for the LidarrAPI tests, the request tests mock it below
const realAddAlbum = LidarrAPI.prototype.addAlbum;

let addAlbumCalls: LidarrAlbumOptions[] = [];
let addAlbumImpl: (options: LidarrAlbumOptions) => Promise<LidarrAlbum>;
let createdTags: string[] = [];

mock.method(LidarrAPI.prototype, 'addAlbum', (options: LidarrAlbumOptions) => {
  addAlbumCalls.push(options);
  return addAlbumImpl(options);
});
// getTags and createTag are instance arrow functions, so they are replaced
// through the prototype the way the Radarr scanner tests do it
Object.defineProperty(LidarrAPI.prototype, 'getTags', {
  set() {},
  get() {
    return async () => [{ id: 3, label: 'existing' }];
  },
  configurable: true,
});
Object.defineProperty(LidarrAPI.prototype, 'createTag', {
  set() {},
  get() {
    return async ({ label }: { label: string }) => {
      createdTags.push(label);
      return { id: 9, label };
    };
  },
  configurable: true,
});

function fakeLidarrAlbum(overrides: Partial<LidarrAlbum> = {}): LidarrAlbum {
  return {
    id: 42,
    mbId: ALBUM_MBID,
    title: 'OK Computer',
    monitored: true,
    artistId: 7,
    foreignAlbumId: ALBUM_MBID,
    titleSlug: 'ok-computer',
    profileId: 1,
    duration: 0,
    albumType: 'Album',
    ...overrides,
  };
}

function configureLidarr(overrides: Partial<LidarrSettings>[]): void {
  getSettings().lidarr = overrides.map((o, i) => ({
    id: i,
    name: `Lidarr ${i}`,
    hostname: 'localhost',
    port: 8686,
    apiKey: 'test-key',
    useSsl: false,
    baseUrl: '',
    activeProfileId: 1,
    activeProfileName: 'Lossless',
    activeDirectory: '/music',
    activeMetadataProfileId: 2,
    activeMetadataProfileName: 'Standard',
    tags: [],
    is4k: false,
    isDefault: i === 0,
    syncEnabled: true,
    preventSearch: false,
    tagRequests: false,
    overrideRule: [],
    ...o,
  })) as LidarrSettings[];
}

let app: Express;

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(
    session({ secret: 'test-secret', resave: false, saveUninitialized: false })
  );
  app.use(checkUser);
  app.use('/auth', authRoutes);
  app.use('/request', requestRoutes);
  app.use(
    (
      err: { status?: number; message?: string },
      _req: express.Request,
      res: express.Response,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _next: express.NextFunction
    ) => {
      res
        .status(err.status ?? 500)
        .json({ status: err.status ?? 500, message: err.message });
    }
  );
  return app;
}

async function loginAs(email: string) {
  const settings = getSettings();
  const priorLocalLogin = settings.main.localLogin;
  settings.main.localLogin = true;

  try {
    const agent = request.agent(app);
    const res = await agent
      .post('/auth/local')
      .send({ email, password: 'test1234' });
    assert.strictEqual(res.status, 200);
    return agent;
  } finally {
    settings.main.localLogin = priorLocalLogin;
  }
}

// The Lidarr add runs detached from the request, like the Radarr one
async function waitFor(check: () => Promise<boolean>) {
  // The detached work usually settles the check, polling covers the rest
  await settleTestBackgroundTasks();
  for (let i = 0; i < 50; i++) {
    if (await check()) {
      await settleTestBackgroundTasks();
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail('Condition was not met in time');
}

before(() => {
  app = createApp();
});

setupTestDb();

beforeEach(() => {
  addAlbumCalls = [];
  createdTags = [];
  addAlbumImpl = async () => fakeLidarrAlbum();
  sendNotificationMock.resetCalls();
  configureLidarr([{}]);
});

afterEach(() => {
  getSettings().lidarr = [];
});

describe('POST /request (music)', () => {
  it('sends an auto-approved album to Lidarr with the server defaults', async () => {
    const agent = await loginAs('admin@seerr.dev');
    const res = await agent
      .post('/request')
      .send({ mediaType: MediaType.MUSIC, mediaId: ALBUM_MBID });

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.status, MediaRequestStatus.APPROVED);
    assert.strictEqual(res.body.type, MediaType.MUSIC);
    assert.strictEqual(addAlbumCalls.length, 1);

    const options = addAlbumCalls[0];
    assert.strictEqual(options.foreignAlbumId, ALBUM_MBID);
    assert.strictEqual(options.profileId, 1);
    assert.strictEqual(options.artist.qualityProfileId, 1);
    assert.strictEqual(options.artist.metadataProfileId, 2);
    assert.strictEqual(options.artist.rootFolderPath, '/music');
    assert.strictEqual(options.artist.monitorNewItems, 'none');
    // "none" would leave the new artist unmonitored after Lidarr's refresh
    assert.strictEqual(options.artist.addOptions.monitor, 'unknown');
    // A new artist would otherwise leave the requested album unmonitored
    assert.deepStrictEqual(options.artist.addOptions.albumsToMonitor, [
      ALBUM_MBID,
    ]);
    assert.strictEqual(options.addOptions.searchForNewAlbum, true);

    await waitFor(async () => {
      const media = await getRepository(Media).findOneOrFail({
        where: { mbId: ALBUM_MBID },
      });
      return media.externalServiceId === 42;
    });

    const media = await getRepository(Media).findOneOrFail({
      where: { mbId: ALBUM_MBID, mediaType: MediaType.MUSIC },
    });
    assert.strictEqual(media.tmdbId, null);
    assert.strictEqual(media.status, MediaStatus.PROCESSING);
    assert.strictEqual(media.serviceId, 0);
    assert.strictEqual(media.externalServiceSlug, ALBUM_MBID);
  });

  it('keeps a request pending for a user without auto-approve', async () => {
    const agent = await loginAs('demo@seerr.dev');
    const res = await agent
      .post('/request')
      .send({ mediaType: MediaType.MUSIC, mediaId: ALBUM_MBID });

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.status, MediaRequestStatus.PENDING);
    assert.strictEqual(addAlbumCalls.length, 0);

    const media = await getRepository(Media).findOneOrFail({
      where: { mbId: ALBUM_MBID },
    });
    assert.strictEqual(media.status, MediaStatus.PENDING);
  });

  it('uses the request overrides and tags the requester', async () => {
    configureLidarr([{ tagRequests: true, tags: [3], preventSearch: true }]);

    const agent = await loginAs('admin@seerr.dev');
    const res = await agent.post('/request').send({
      mediaType: MediaType.MUSIC,
      mediaId: ALBUM_MBID,
      profileId: 5,
      rootFolder: '/music/lossless',
    });

    assert.strictEqual(res.status, 201);
    assert.strictEqual(addAlbumCalls.length, 1);

    const options = addAlbumCalls[0];
    assert.strictEqual(options.profileId, 5);
    assert.strictEqual(options.artist.rootFolderPath, '/music/lossless');
    assert.deepStrictEqual(options.artist.tags, [3, 9]);
    assert.strictEqual(options.addOptions.searchForNewAlbum, false);
    assert.strictEqual(createdTags.length, 1);
    assert.match(createdTags[0], /^1-/);
  });

  it('applies an override rule on the Lidarr server for the requester', async () => {
    const demo = await getRepository(User).findOneOrFail({
      where: { email: 'demo@seerr.dev' },
    });
    await getRepository(OverrideRule).save(
      new OverrideRule({
        lidarrServiceId: 0,
        users: String(demo.id),
        rootFolder: '/music/kids',
        autoApprove: true,
      })
    );

    const agent = await loginAs('demo@seerr.dev');
    const res = await agent
      .post('/request')
      .send({ mediaType: MediaType.MUSIC, mediaId: ALBUM_MBID });

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.rootFolder, '/music/kids');
    assert.strictEqual(res.body.status, MediaRequestStatus.APPROVED);
    assert.strictEqual(addAlbumCalls[0].artist.rootFolderPath, '/music/kids');
  });

  it('ignores override rules with TMDB conditions', async () => {
    await getRepository(OverrideRule).save(
      new OverrideRule({
        lidarrServiceId: 0,
        genre: '16',
        rootFolder: '/music/animation',
      })
    );

    const agent = await loginAs('demo@seerr.dev');
    const res = await agent
      .post('/request')
      .send({ mediaType: MediaType.MUSIC, mediaId: ALBUM_MBID });

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.rootFolder, null);
  });

  it('blocks a second request for the same album', async () => {
    const agent = await loginAs('demo@seerr.dev');
    await agent
      .post('/request')
      .send({ mediaType: MediaType.MUSIC, mediaId: ALBUM_MBID });
    const res = await agent
      .post('/request')
      .send({ mediaType: MediaType.MUSIC, mediaId: ALBUM_MBID });

    assert.strictEqual(res.status, 409);
  });

  it('requires a music request permission', async () => {
    const demo = await getRepository(User).findOneOrFail({
      where: { email: 'demo@seerr.dev' },
    });
    demo.permissions = Permission.REQUEST_MOVIE;
    await getRepository(User).save(demo);

    const agent = await loginAs('demo@seerr.dev');
    const denied = await agent
      .post('/request')
      .send({ mediaType: MediaType.MUSIC, mediaId: ALBUM_MBID });
    assert.strictEqual(denied.status, 403);

    demo.permissions = Permission.REQUEST_MUSIC;
    await getRepository(User).save(demo);

    const allowed = await agent
      .post('/request')
      .send({ mediaType: MediaType.MUSIC, mediaId: OTHER_ALBUM_MBID });
    assert.strictEqual(allowed.status, 201);
  });

  it('marks the request failed when Lidarr refuses the album', async () => {
    addAlbumImpl = async () => {
      throw new Error('Lidarr is down');
    };

    const agent = await loginAs('admin@seerr.dev');
    const res = await agent
      .post('/request')
      .send({ mediaType: MediaType.MUSIC, mediaId: ALBUM_MBID });

    assert.strictEqual(res.status, 201);

    await waitFor(async () =>
      sendNotificationMock.calls.some(
        (call) => call.arguments[2] === Notification.MEDIA_FAILED
      )
    );

    const saved = await getRepository(MediaRequest).findOneOrFail({
      where: { id: res.body.id },
    });
    assert.strictEqual(saved.status, MediaRequestStatus.FAILED);
  });

  it('sends a pending album to Lidarr once it is approved', async () => {
    const demo = await loginAs('demo@seerr.dev');
    const created = await demo
      .post('/request')
      .send({ mediaType: MediaType.MUSIC, mediaId: ALBUM_MBID });

    const admin = await loginAs('admin@seerr.dev');
    const res = await admin.post(`/request/${created.body.id}/approve`);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(addAlbumCalls.length, 1);
    assert.strictEqual(addAlbumCalls[0].foreignAlbumId, ALBUM_MBID);
  });

  it('resets the album when its request is declined', async () => {
    const demo = await loginAs('demo@seerr.dev');
    const created = await demo
      .post('/request')
      .send({ mediaType: MediaType.MUSIC, mediaId: ALBUM_MBID });

    const admin = await loginAs('admin@seerr.dev');
    const res = await admin.post(`/request/${created.body.id}/decline`);

    assert.strictEqual(res.status, 200);

    const media = await getRepository(Media).findOneOrFail({
      where: { mbId: ALBUM_MBID },
    });
    assert.strictEqual(media.status, MediaStatus.UNKNOWN);
    assert.strictEqual(addAlbumCalls.length, 0);
  });

  it('completes the request when the album becomes available', async () => {
    const agent = await loginAs('admin@seerr.dev');
    const created = await agent
      .post('/request')
      .send({ mediaType: MediaType.MUSIC, mediaId: ALBUM_MBID });

    await waitFor(async () => {
      const media = await getRepository(Media).findOneOrFail({
        where: { mbId: ALBUM_MBID },
      });
      return media.externalServiceId === 42;
    });

    const media = await getRepository(Media).findOneOrFail({
      where: { mbId: ALBUM_MBID },
    });
    media.status = MediaStatus.AVAILABLE;
    await getRepository(Media).save(media);

    const saved = await getRepository(MediaRequest).findOneOrFail({
      where: { id: created.body.id },
    });
    assert.strictEqual(saved.status, MediaRequestStatus.COMPLETED);
  });

  it('lists music requests on their own filter', async () => {
    const agent = await loginAs('admin@seerr.dev');
    await agent
      .post('/request')
      .send({ mediaType: MediaType.MUSIC, mediaId: ALBUM_MBID });

    const res = await agent.get('/request?filter=all&mediaType=music');

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.results.length, 1);
    assert.strictEqual(res.body.results[0].media.mbId, ALBUM_MBID);
  });
});

describe('LidarrAPI.addAlbum', () => {
  const options: LidarrAlbumOptions = {
    foreignAlbumId: ALBUM_MBID,
    monitored: true,
    anyReleaseOk: true,
    profileId: 1,
    artist: {
      qualityProfileId: 1,
      metadataProfileId: 2,
      rootFolderPath: '/music',
      monitored: true,
      monitorNewItems: 'none',
      tags: [],
      addOptions: { monitor: 'none', searchForMissingAlbums: false },
    },
    addOptions: { searchForNewAlbum: true },
  };

  const createApi = () => {
    const lidarr = new LidarrAPI({
      url: 'http://localhost:8686/api/v1',
      apiKey: 'test-key',
    });
    const calls: { method: string; url: string; data?: unknown }[] = [];
    const http = (lidarr as unknown as { axios: Record<string, unknown> })
      .axios;
    http.put = async (url: string, data: unknown) => {
      calls.push({ method: 'put', url, data });
      return { data: {} };
    };
    http.post = async (url: string, data: unknown) => {
      calls.push({ method: 'post', url, data });
      return { data: url === '/album' ? fakeLidarrAlbum({ id: 77 }) : {} };
    };
    return { lidarr, calls };
  };

  it('adds a new album along with its artist', async () => {
    const { lidarr, calls } = createApi();
    mock.method(lidarr, 'getAlbumByForeignAlbumId', async () =>
      fakeLidarrAlbum({
        id: 0,
        artist: {
          id: 0,
          artistName: 'Radiohead',
          foreignArtistId: 'a74b1b7f-71a5-4011-9441-d0b5e4122711',
          monitored: false,
        },
      })
    );

    const album = await realAddAlbum.call(lidarr, options);

    assert.strictEqual(album.id, 77);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].url, '/album');
    const body = calls[0].data as LidarrAlbumOptions & {
      artist: { artistName: string };
    };
    assert.strictEqual(body.artist.artistName, 'Radiohead');
    assert.strictEqual(body.artist.rootFolderPath, '/music');
    assert.strictEqual(body.monitored, true);
  });

  it('monitors and searches an album already in Lidarr', async () => {
    const { lidarr, calls } = createApi();
    mock.method(lidarr, 'getAlbumByForeignAlbumId', async () =>
      fakeLidarrAlbum({
        id: 42,
        monitored: false,
        artist: {
          id: 7,
          artistName: 'Radiohead',
          foreignArtistId: 'a74b1b7f-71a5-4011-9441-d0b5e4122711',
          monitored: false,
        },
      })
    );

    const album = await realAddAlbum.call(lidarr, options);

    assert.strictEqual(album.id, 42);
    assert.strictEqual(album.monitored, true);
    assert.deepStrictEqual(
      calls.map((call) => `${call.method} ${call.url}`),
      ['put /album/monitor', 'put /artist/7', 'post /command']
    );
    assert.deepStrictEqual(calls[0].data, { albumIds: [42], monitored: true });
    assert.deepStrictEqual(calls[2].data, {
      name: 'AlbumSearch',
      albumIds: [42],
    });
  });
});
