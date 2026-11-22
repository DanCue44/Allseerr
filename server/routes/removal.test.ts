import assert from 'node:assert/strict';
import { before, describe, it, mock } from 'node:test';

import CoverArtArchive from '@server/api/coverartarchive';
import type { LazyLibrarianBookType } from '@server/api/lazylibrarian';
import LazyLibrarianAPI from '@server/api/lazylibrarian';
import MusicBrainz from '@server/api/musicbrainz';
import type { MbReleaseGroup } from '@server/api/musicbrainz/interfaces';
import OpenLibrary from '@server/api/openlibrary';
import type { OlSearchDoc, OlWork } from '@server/api/openlibrary/interfaces';
import ChaptarrAPI from '@server/api/servarr/chaptarr';
import LidarrAPI from '@server/api/servarr/lidarr';
import TheMovieDb from '@server/api/themoviedb';
import type { TmdbMovieDetails } from '@server/api/themoviedb/interfaces';
import {
  MediaStatus,
  MediaType,
  RemovalRequestStatus,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import RemovalRequest from '@server/entity/RemovalRequest';
import notificationManager, { Notification } from '@server/lib/notifications';
import type { NotificationPayload } from '@server/lib/notifications/agents/agent';
import { getMediaPath } from '@server/lib/notifications/agents/agent';
import type { ChaptarrSettings, LidarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { checkUser, isAuthenticated } from '@server/middleware/auth';
import { settleTestBackgroundTasks, setupTestDb } from '@server/test/db';
import type { Express } from 'express';
import express from 'express';
import session from 'express-session';
import request from 'supertest';
import authRoutes from './auth';
import removalRoutes from './removal';

// getMovie is an instance property, so it is replaced through the prototype
Object.defineProperty(TheMovieDb.prototype, 'getMovie', {
  get() {
    return async ({ movieId }: { movieId: number }) =>
      ({
        id: movieId,
        title: 'Test Movie',
        release_date: '2026-01-01',
        overview: 'Overview',
        poster_path: '/poster.jpg',
      }) as unknown as TmdbMovieDetails;
  },
  set() {},
  configurable: true,
});

const ALBUM_MBID = '1dc4c347-a1db-32aa-b14f-bc9cc507b843';
const WORK_ID = 'OL45804W';

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
mock.method(
  MusicBrainz.prototype,
  'getArtistWikipediaExtract',
  async () => null
);
mock.method(
  CoverArtArchive.prototype,
  'getFrontCoverUrl',
  async (mbId: string) => `https://coverartarchive.org/release-group/${mbId}`
);
mock.method(
  OpenLibrary.prototype,
  'getWork',
  async (): Promise<OlWork> => ({
    key: `/works/${WORK_ID}`,
    title: 'Fantastic Mr Fox',
    type: { key: '/type/work' },
    covers: [8739161],
    authors: [{ author: { key: '/authors/OL34184A' } }],
  })
);
mock.method(
  OpenLibrary.prototype,
  'getWorkSummary',
  async (): Promise<OlSearchDoc> => ({
    key: `/works/${WORK_ID}`,
    title: 'Fantastic Mr Fox',
    author_name: ['Roald Dahl'],
    author_key: ['OL34184A'],
    first_publish_year: 1970,
  })
);

const removeAlbumFilesMock = mock.method(
  LidarrAPI.prototype,
  'removeAlbumFiles',
  async () => ({ removed: true, artistRemoved: false })
).mock;

let unqueueCalls: [string, LazyLibrarianBookType][] = [];
mock.method(LazyLibrarianAPI.prototype, 'getBook', async (bookId: string) => ({
  bookId,
  title: 'Fantastic Mr Fox',
  status: 'Open',
  audioStatus: 'Open',
}));
mock.method(
  LazyLibrarianAPI.prototype,
  'unqueueBook',
  async (bookId: string, type: LazyLibrarianBookType) => {
    unqueueCalls.push([bookId, type]);
  }
);

// Chaptarr holds the ebook as book 31 and the audiobook as book 32
let chaptarrDeletedFiles: number[][] = [];
let chaptarrMonitorCalls: [number[], boolean][] = [];
mock.method(ChaptarrAPI.prototype, 'getBook', async (bookId: number) => ({
  id: bookId,
  title: 'Fantastic Mr Fox',
  foreignBookId: 'gr:6693',
  mediaType: bookId === 31 ? 'ebook' : 'audiobook',
  monitored: true,
  authorId: 4,
}));
mock.method(ChaptarrAPI.prototype, 'getBookFiles', async (bookId: number) => [
  { id: bookId * 10, bookId },
]);
mock.method(
  ChaptarrAPI.prototype,
  'deleteBookFiles',
  async (bookFileIds: number[]) => {
    chaptarrDeletedFiles.push(bookFileIds);
  }
);
mock.method(
  ChaptarrAPI.prototype,
  'setBooksMonitored',
  async (bookIds: number[], monitored: boolean) => {
    chaptarrMonitorCalls.push([bookIds, monitored]);
  }
);
mock.method(ChaptarrAPI.prototype, 'getBooksByAuthor', async () => [
  { id: 31, mediaType: 'ebook', monitored: true },
  { id: 32, mediaType: 'audiobook', monitored: true },
]);
const removeAuthorMock = mock.method(
  ChaptarrAPI.prototype,
  'removeAuthor',
  async () => undefined
).mock;

const sendNotificationMock = mock.method(
  notificationManager,
  'sendNotification',
  () => undefined
).mock;

let app: Express;

before(() => {
  app = express();
  app.use(express.json());
  app.use(
    session({ secret: 'test-secret', resave: false, saveUninitialized: false })
  );
  app.use(checkUser);
  app.use('/auth', authRoutes);
  app.use('/removal', isAuthenticated(), removalRoutes);
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
});

setupTestDb();

async function loginAs(email: string) {
  getSettings().main.localLogin = true;
  const agent = request.agent(app);
  const res = await agent
    .post('/auth/local')
    .send({ email, password: 'test1234' });
  assert.strictEqual(res.status, 200);
  return agent;
}

async function seedMedia(status = MediaStatus.AVAILABLE) {
  return getRepository(Media).save(
    new Media({
      mediaType: MediaType.MOVIE,
      tmdbId: 4242,
      status,
      status4k: MediaStatus.UNKNOWN,
    })
  );
}

async function seedAlbum() {
  return getRepository(Media).save(
    new Media({
      mediaType: MediaType.MUSIC,
      mbId: ALBUM_MBID,
      status: MediaStatus.AVAILABLE,
      serviceId: 0,
    })
  );
}

async function seedBook(
  status = MediaStatus.AVAILABLE,
  statusAudio = MediaStatus.AVAILABLE
) {
  return getRepository(Media).save(
    new Media({
      mediaType: MediaType.BOOK,
      olId: WORK_ID,
      status,
      statusAudio,
      externalServiceSlug: WORK_ID,
    })
  );
}

function setLidarr() {
  getSettings().lidarr = [
    {
      id: 0,
      name: 'Lidarr',
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
      isDefault: true,
      syncEnabled: true,
      preventSearch: false,
      tagRequests: false,
    } as unknown as LidarrSettings,
  ];
}

function setLazyLibrarian() {
  getSettings().lazylibrarian = {
    ...getSettings().lazylibrarian,
    hostname: 'localhost',
    port: 5299,
    apiKey: 'a'.repeat(32),
  };
}

const lastPayload = (type: Notification): NotificationPayload | undefined =>
  sendNotificationMock.calls
    .filter((call) => call.arguments[0] === type)
    .map((call) => call.arguments[1] as NotificationPayload)
    .pop();

// Notifications are sent detached from the request
const flushNotifications = () => settleTestBackgroundTasks();

describe('POST /removal', () => {
  it('creates a pending removal request for available media', async () => {
    const media = await seedMedia();
    const agent = await loginAs('demo@seerr.dev');

    const res = await agent
      .post('/removal')
      .send({ mediaId: media.id, reason: '  Finished it  ' });

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.status, RemovalRequestStatus.PENDING);
    assert.strictEqual(res.body.reason, 'Finished it');
  });

  it('refuses media that is not available', async () => {
    const media = await seedMedia(MediaStatus.PROCESSING);
    const agent = await loginAs('demo@seerr.dev');

    const res = await agent.post('/removal').send({ mediaId: media.id });

    assert.strictEqual(res.status, 400);
  });

  it('refuses a second removal request for the same media', async () => {
    const media = await seedMedia();
    const agent = await loginAs('demo@seerr.dev');

    await agent.post('/removal').send({ mediaId: media.id });
    const res = await agent.post('/removal').send({ mediaId: media.id });

    assert.strictEqual(res.status, 409);
  });
});

describe('GET /removal', () => {
  it("shows users only their own removal requests and managers everyone's", async () => {
    const media = await seedMedia();
    const admin = await loginAs('admin@seerr.dev');
    await admin.post('/removal').send({ mediaId: media.id });

    const demo = await loginAs('demo@seerr.dev');
    const own = await demo.get('/removal');
    assert.strictEqual(own.body.results.length, 0);

    const all = await admin.get('/removal?filter=pending');
    assert.strictEqual(all.body.results.length, 1);
  });
});

describe('POST /removal/:id/:status', () => {
  it('declines with a reason and notifies the requester', async () => {
    const media = await seedMedia();
    const demo = await loginAs('demo@seerr.dev');
    const created = await demo.post('/removal').send({ mediaId: media.id });

    sendNotificationMock.resetCalls();
    const admin = await loginAs('admin@seerr.dev');
    const res = await admin
      .post(`/removal/${created.body.id}/decline`)
      .send({ reason: 'Others still watching' });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.status, RemovalRequestStatus.DECLINED);
    assert.strictEqual(res.body.declineReason, 'Others still watching');

    // Notifications are sent without waiting on TMDB
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(sendNotificationMock.callCount() >= 1);
  });

  it('marks the request failed when no service can remove it', async () => {
    getSettings().radarr = [];
    const media = await seedMedia();
    const demo = await loginAs('demo@seerr.dev');
    const created = await demo.post('/removal').send({ mediaId: media.id });

    const admin = await loginAs('admin@seerr.dev');
    const res = await admin.post(`/removal/${created.body.id}/approve`);

    assert.strictEqual(res.status, 409);
    const stored = await getRepository(RemovalRequest).findOneOrFail({
      where: { id: created.body.id },
    });
    assert.strictEqual(stored.status, RemovalRequestStatus.FAILED);
  });

  it('does not let a regular user approve', async () => {
    const media = await seedMedia();
    const demo = await loginAs('demo@seerr.dev');
    const created = await demo.post('/removal').send({ mediaId: media.id });

    const res = await demo.post(`/removal/${created.body.id}/approve`);

    assert.strictEqual(res.status, 403);
  });
});

describe('DELETE /removal/:id', () => {
  it('lets the requester cancel a pending removal request', async () => {
    const media = await seedMedia();
    const demo = await loginAs('demo@seerr.dev');
    const created = await demo.post('/removal').send({ mediaId: media.id });

    const res = await demo.delete(`/removal/${created.body.id}`);

    assert.strictEqual(res.status, 204);
  });

  it("does not let a user cancel someone else's removal request", async () => {
    const media = await seedMedia();
    const admin = await loginAs('admin@seerr.dev');
    const created = await admin.post('/removal').send({ mediaId: media.id });

    const demo = await loginAs('demo@seerr.dev');
    const res = await demo.delete(`/removal/${created.body.id}`);

    assert.strictEqual(res.status, 403);
  });
});

describe('removal requests for music and books', () => {
  it('removes an approved album from Lidarr and marks it deleted', async () => {
    setLidarr();
    removeAlbumFilesMock.resetCalls();
    const media = await seedAlbum();
    const demo = await loginAs('demo@seerr.dev');
    const created = await demo.post('/removal').send({ mediaId: media.id });
    assert.strictEqual(created.status, 201);
    assert.strictEqual(created.body.bookFormat, null);

    sendNotificationMock.resetCalls();
    const admin = await loginAs('admin@seerr.dev');
    const res = await admin.post(`/removal/${created.body.id}/approve`);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.status, RemovalRequestStatus.APPROVED);
    assert.strictEqual(removeAlbumFilesMock.callCount(), 1);
    assert.deepStrictEqual(removeAlbumFilesMock.calls[0].arguments, [
      ALBUM_MBID,
    ]);

    const stored = await getRepository(Media).findOneOrFail({
      where: { id: media.id },
    });
    assert.strictEqual(stored.status, MediaStatus.DELETED);

    await flushNotifications();
    const payload = lastPayload(Notification.REMOVAL_APPROVED);
    assert.ok(payload);
    assert.strictEqual(payload.event, 'Album Removal Approved');
    assert.strictEqual(payload.subject, 'OK Computer by Radiohead (1997)');
    assert.strictEqual(
      payload.image,
      `https://coverartarchive.org/release-group/${ALBUM_MBID}`
    );
    assert.ok(payload.media);
    assert.strictEqual(getMediaPath(payload.media), `/music/${ALBUM_MBID}`);
  });

  it('removes only the requested format of a book', async () => {
    setLazyLibrarian();
    unqueueCalls = [];
    const media = await seedBook();
    const demo = await loginAs('demo@seerr.dev');
    const created = await demo
      .post('/removal')
      .send({ mediaId: media.id, bookFormat: 'audiobook' });
    assert.strictEqual(created.status, 201);
    assert.strictEqual(created.body.bookFormat, 'audiobook');

    sendNotificationMock.resetCalls();
    const admin = await loginAs('admin@seerr.dev');
    const res = await admin.post(`/removal/${created.body.id}/approve`);

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(unqueueCalls, [[WORK_ID, 'AudioBook']]);

    const stored = await getRepository(Media).findOneOrFail({
      where: { id: media.id },
    });
    assert.strictEqual(stored.status, MediaStatus.AVAILABLE);
    assert.strictEqual(stored.statusAudio, MediaStatus.DELETED);

    await flushNotifications();
    const payload = lastPayload(Notification.REMOVAL_APPROVED);
    assert.ok(payload);
    assert.strictEqual(payload.event, 'Audiobook Removal Approved');
    assert.strictEqual(
      payload.subject,
      'Fantastic Mr Fox by Roald Dahl (1970)'
    );
    assert.ok(payload.media);
    assert.strictEqual(getMediaPath(payload.media), `/book/${WORK_ID}`);
  });

  it('removes both formats of a book by default', async () => {
    setLazyLibrarian();
    unqueueCalls = [];
    const media = await seedBook();
    const demo = await loginAs('demo@seerr.dev');
    const created = await demo.post('/removal').send({ mediaId: media.id });
    assert.strictEqual(created.body.bookFormat, 'both');

    const admin = await loginAs('admin@seerr.dev');
    await admin.post(`/removal/${created.body.id}/approve`);

    assert.deepStrictEqual(unqueueCalls, [
      [WORK_ID, 'eBook'],
      [WORK_ID, 'AudioBook'],
    ]);
    const stored = await getRepository(Media).findOneOrFail({
      where: { id: media.id },
    });
    assert.strictEqual(stored.status, MediaStatus.DELETED);
    assert.strictEqual(stored.statusAudio, MediaStatus.DELETED);
  });

  it('narrows a book removal to the available format', async () => {
    const media = await seedBook(MediaStatus.AVAILABLE, MediaStatus.UNKNOWN);
    const demo = await loginAs('demo@seerr.dev');

    const res = await demo
      .post('/removal')
      .send({ mediaId: media.id, bookFormat: 'both' });

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.bookFormat, 'ebook');
  });

  it('refuses a book format that is not available', async () => {
    const media = await seedBook(MediaStatus.AVAILABLE, MediaStatus.UNKNOWN);
    const demo = await loginAs('demo@seerr.dev');

    const res = await demo
      .post('/removal')
      .send({ mediaId: media.id, bookFormat: 'audiobook' });

    assert.strictEqual(res.status, 400);
  });

  it('deletes the files of the requested format in Chaptarr and unmonitors it', async () => {
    setLazyLibrarian();
    getSettings().chaptarr = [
      {
        id: 0,
        name: 'Chaptarr',
        hostname: 'localhost',
        port: 8789,
        apiKey: 'test-key',
        useSsl: false,
        activeProfileId: 1,
        activeDirectory: '/ebooks',
        activeMetadataProfileId: 2,
        isDefault: true,
      } as ChaptarrSettings,
    ];
    chaptarrDeletedFiles = [];
    chaptarrMonitorCalls = [];
    unqueueCalls = [];
    removeAuthorMock.resetCalls();

    try {
      const media = await getRepository(Media).save(
        new Media({
          mediaType: MediaType.BOOK,
          olId: WORK_ID,
          status: MediaStatus.AVAILABLE,
          statusAudio: MediaStatus.AVAILABLE,
          serviceId: 0,
          externalServiceId: 31,
          externalServiceIdAudio: 32,
          foreignBookId: 'gr:6693',
        })
      );
      const demo = await loginAs('demo@seerr.dev');
      const created = await demo
        .post('/removal')
        .send({ mediaId: media.id, bookFormat: 'ebook' });

      const admin = await loginAs('admin@seerr.dev');
      const res = await admin.post(`/removal/${created.body.id}/approve`);

      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual(chaptarrDeletedFiles, [[310]]);
      assert.deepStrictEqual(chaptarrMonitorCalls, [[[31], false]]);
      // The audiobook is still monitored, so its author stays
      assert.strictEqual(removeAuthorMock.callCount(), 0);
      // Chaptarr is used in place of LazyLibrarian
      assert.deepStrictEqual(unqueueCalls, []);

      const stored = await getRepository(Media).findOneOrFail({
        where: { id: media.id },
      });
      assert.strictEqual(stored.status, MediaStatus.DELETED);
      assert.strictEqual(stored.statusAudio, MediaStatus.AVAILABLE);
      assert.strictEqual(stored.externalServiceId, 31);
    } finally {
      getSettings().chaptarr = [];
    }
  });

  it('marks a book removal failed when LazyLibrarian is not configured', async () => {
    getSettings().lazylibrarian = {
      ...getSettings().lazylibrarian,
      hostname: '',
      apiKey: '',
    };
    const media = await seedBook();
    const demo = await loginAs('demo@seerr.dev');
    const created = await demo.post('/removal').send({ mediaId: media.id });

    const admin = await loginAs('admin@seerr.dev');
    const res = await admin.post(`/removal/${created.body.id}/approve`);

    assert.strictEqual(res.status, 409);
    const stored = await getRepository(RemovalRequest).findOneOrFail({
      where: { id: created.body.id },
    });
    assert.strictEqual(stored.status, RemovalRequestStatus.FAILED);
  });
});

describe('/removal/suggestions', () => {
  it('is for admins only', async () => {
    getSettings().main.watchedCleanup = { enabled: true, days: 0 };
    const demo = await loginAs('demo@seerr.dev');

    assert.strictEqual((await demo.get('/removal/suggestions')).status, 403);
    assert.strictEqual(
      (
        await demo
          .post('/removal/suggestions')
          .send({ action: 'remove', items: [{ mediaId: 1 }] })
      ).status,
      403
    );
    getSettings().main.watchedCleanup = { enabled: false, days: 0 };
  });

  it('answers 403 while turned off and lists when on', async () => {
    const admin = await loginAs('admin@seerr.dev');

    getSettings().main.watchedCleanup = { enabled: false, days: 0 };
    assert.strictEqual((await admin.get('/removal/suggestions')).status, 403);

    getSettings().main.watchedCleanup = { enabled: true, days: 0 };
    const res = await admin.get('/removal/suggestions');
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.results, []);
    getSettings().main.watchedCleanup = { enabled: false, days: 0 };
  });

  it('checks the action', async () => {
    getSettings().main.watchedCleanup = { enabled: true, days: 0 };
    const admin = await loginAs('admin@seerr.dev');

    const res = await admin
      .post('/removal/suggestions')
      .send({ action: 'delete', items: [{ mediaId: 1 }] });
    assert.strictEqual(res.status, 400);
    getSettings().main.watchedCleanup = { enabled: false, days: 0 };
  });
});
