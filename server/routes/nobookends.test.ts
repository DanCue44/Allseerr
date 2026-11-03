import assert from 'node:assert/strict';
import { before, beforeEach, describe, it, mock } from 'node:test';

import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import MediaRequest from '@server/entity/MediaRequest';
import { NoBookEndsDevice } from '@server/entity/NoBookEndsDevice';
import { User } from '@server/entity/User';
import { isPrivateHost } from '@server/lib/nobookends';
import { MAX_NOBOOKENDS_DEVICES } from '@server/lib/nobookendsDevices';
import { Permission } from '@server/lib/permissions';
import type { ChaptarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { generateUserApiKey, hashUserApiKey } from '@server/lib/userApiKey';
import { checkUser, isAuthenticated } from '@server/middleware/auth';
import authRoutes from '@server/routes/auth';
import nobookendsRoutes from '@server/routes/nobookends';
import userRoutes from '@server/routes/user';
import { setupTestDb } from '@server/test/db';
import type { Express } from 'express';
import express from 'express';
import session from 'express-session';
import request from 'supertest';

let app: Express;

mock.method(MediaRequest, 'sendNotification', async () => undefined);

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(
    session({
      secret: 'test-secret',
      resave: false,
      saveUninitialized: false,
    })
  );
  app.use(checkUser);
  app.use('/auth', authRoutes);
  app.use('/user', isAuthenticated(), userRoutes);
  app.use('/nobookends', isAuthenticated(), nobookendsRoutes);
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

before(async () => {
  app = createApp();
});

setupTestDb();

const enableBooks = () => {
  const settings = getSettings();
  settings.main.bookService = 'lazylibrarian';
  settings.main.applicationUrl = 'https://allseerr.example.com';
  settings.lazylibrarian = {
    ...settings.lazylibrarian,
    hostname: 'lazylibrarian',
    apiKey: 'key',
  };
  settings.audiobookshelf = {
    url: 'https://books.example.com',
    libraryId: 'library',
    apiKey: 'abs-key',
    showNoBookEnds: true,
  };
};

beforeEach(() => {
  const settings = getSettings();
  settings.main.localLogin = true;
  settings.main.applicationUrl = '';
  settings.main.bookService = undefined;
  settings.chaptarr = [];
  // The settings setters merge, so values are emptied rather than left out
  settings.lazylibrarian = { hostname: '', apiKey: '' };
  settings.audiobookshelf = { url: '', apiKey: '', showNoBookEnds: true };
  settings.nobookendsSync = {
    enabled: false,
    url: '',
    internalUrl: '',
    adminToken: '',
  };
});

async function loginAs(email: string, password = 'test1234') {
  const agent = request.agent(app);
  const res = await agent.post('/auth/local').send({ email, password });

  assert.strictEqual(res.status, 200);
  return { agent, userId: res.body.id as number };
}

describe('NoBookEnds connect link', () => {
  it('creates a key and a link that sets the app up', async () => {
    enableBooks();
    const { agent, userId } = await loginAs('demo@seerr.dev');

    const created = await agent.post(`/user/${userId}/settings/nobookends`);
    assert.strictEqual(created.status, 201);
    assert.match(created.body.apiKey, /^asu_/);

    // Everything is in the fragment, which never reaches the site's server
    const link = new URL(created.body.connectUrl);
    assert.strictEqual(link.origin, 'https://nobookends.com');
    assert.strictEqual(link.pathname, '/open/connect');
    assert.strictEqual(link.search, '');
    assert.doesNotMatch(link.href.split('#')[0], /asu_/);

    const params = new URLSearchParams(link.hash.slice(1));
    assert.strictEqual(params.get('abs'), 'https://books.example.com');
    assert.strictEqual(params.get('allseerr'), 'https://allseerr.example.com');
    assert.strictEqual(params.get('key'), created.body.apiKey);

    const status = await agent.get(`/user/${userId}/settings/nobookends`);
    assert.strictEqual(status.status, 200);
    assert.strictEqual(status.body.available, true);
    assert.strictEqual(status.body.connected, true);
    assert.strictEqual(status.body.apiKey, undefined);

    const me = await request(app)
      .get(`/user/${userId}`)
      .set('X-API-Key', created.body.apiKey);
    assert.strictEqual(me.status, 200);
    assert.strictEqual(me.body.id, userId);
  });

  it('falls back to a public address Allseerr was opened at', async () => {
    enableBooks();
    getSettings().main.applicationUrl = '';
    const { agent, userId } = await loginAs('demo@seerr.dev');

    const status = await agent
      .get(`/user/${userId}/settings/nobookends`)
      .set('Host', 'requests.example.org');
    assert.strictEqual(status.body.applicationUrlMissing, false);

    const created = await agent
      .post(`/user/${userId}/settings/nobookends`)
      .set('Host', 'requests.example.org');

    assert.strictEqual(created.status, 201);
    assert.strictEqual(
      new URLSearchParams(new URL(created.body.connectUrl).hash.slice(1)).get(
        'allseerr'
      ),
      'http://requests.example.org'
    );
  });

  it('asks for the Application URL when opened at a home address', async () => {
    enableBooks();
    getSettings().main.applicationUrl = '';
    const { agent, userId } = await loginAs('demo@seerr.dev');

    for (const host of ['allseerr.lan:5055', '192.168.1.20:5055', 'unraid']) {
      const status = await agent
        .get(`/user/${userId}/settings/nobookends`)
        .set('Host', host);
      assert.strictEqual(status.body.applicationUrlMissing, true, host);

      const created = await agent
        .post(`/user/${userId}/settings/nobookends`)
        .set('Host', host);
      assert.strictEqual(created.status, 400, host);
      assert.match(created.body.message, /Application URL/);
    }

    assert.strictEqual(await getRepository(NoBookEndsDevice).count(), 0);
  });

  it('keeps the other devices connected when one more connects', async () => {
    enableBooks();
    const { agent, userId } = await loginAs('demo@seerr.dev');
    const first = await agent.post(`/user/${userId}/settings/nobookends`);
    const second = await agent
      .post(`/user/${userId}/settings/nobookends`)
      .send({ device: 'Galaxy S24' });

    assert.notStrictEqual(first.body.apiKey, second.body.apiKey);

    for (const key of [first.body.apiKey, second.body.apiKey]) {
      const res = await request(app)
        .get(`/user/${userId}`)
        .set('X-API-Key', key);
      assert.strictEqual(res.status, 200);
    }

    const status = await agent.get(`/user/${userId}/settings/nobookends`);
    assert.strictEqual(status.body.connected, true);
    assert.deepStrictEqual(
      status.body.devices.map((d: { label: string | null }) => d.label),
      ['Galaxy S24', null]
    );
    assert.doesNotMatch(JSON.stringify(status.body), /keyHash|asu_/);
  });

  it('hands the key back to the app in the fragment of its own URL', async () => {
    enableBooks();
    const { agent, userId } = await loginAs('demo@seerr.dev');
    const created = await agent
      .post(`/user/${userId}/settings/nobookends`)
      .send({ device: ' iPhone\u0000 16 <script> ' });

    assert.strictEqual(created.status, 201);
    assert.strictEqual(created.body.device.label, 'iPhone 16 script');

    const appUrl: string = created.body.appUrl;
    assert.ok(appUrl.startsWith('nobookends://connect#'));
    assert.doesNotMatch(appUrl.split('#')[0], /asu_/);
    assert.strictEqual(
      appUrl.split('#')[1],
      new URL(created.body.connectUrl).hash.slice(1)
    );
  });

  it('removes the oldest devices past the limit', async () => {
    enableBooks();
    const { agent, userId } = await loginAs('demo@seerr.dev');
    const keys: string[] = [];

    for (let i = 0; i < MAX_NOBOOKENDS_DEVICES + 2; i++) {
      const created = await agent
        .post(`/user/${userId}/settings/nobookends`)
        .send({ device: `Phone ${i}` });
      keys.push(created.body.apiKey);
    }

    const status = await agent.get(`/user/${userId}/settings/nobookends`);
    assert.strictEqual(status.body.devices.length, MAX_NOBOOKENDS_DEVICES);
    const newestLabel: string = `Phone ${MAX_NOBOOKENDS_DEVICES + 1}`;
    assert.strictEqual(status.body.devices[0].label, newestLabel);

    const oldest = await request(app)
      .get(`/user/${userId}`)
      .set('X-API-Key', keys[0]);
    assert.strictEqual(oldest.status, 403);

    const newest = await request(app)
      .get(`/user/${userId}`)
      .set('X-API-Key', keys[keys.length - 1]);
    assert.strictEqual(newest.status, 200);
  });

  it('notes when a device was last used', async () => {
    enableBooks();
    const { agent, userId } = await loginAs('demo@seerr.dev');
    const created = await agent.post(`/user/${userId}/settings/nobookends`);
    assert.strictEqual(created.body.device.lastUsedAt, null);

    await request(app)
      .get('/nobookends/status')
      .set('X-API-Key', created.body.apiKey);

    const status = await agent.get(`/user/${userId}/settings/nobookends`);
    assert.ok(status.body.devices[0].lastUsedAt);
  });

  it('removes one device and keeps the others', async () => {
    enableBooks();
    const { agent, userId } = await loginAs('demo@seerr.dev');
    const first = await agent.post(`/user/${userId}/settings/nobookends`);
    const second = await agent.post(`/user/${userId}/settings/nobookends`);

    const removed = await agent.delete(
      `/user/${userId}/settings/nobookends/devices/${first.body.device.id}`
    );
    assert.strictEqual(removed.status, 204);

    const gone = await request(app)
      .get('/nobookends/status')
      .set('X-API-Key', first.body.apiKey);
    assert.strictEqual(gone.status, 403);

    const kept = await request(app)
      .get('/nobookends/status')
      .set('X-API-Key', second.body.apiKey);
    assert.strictEqual(kept.status, 200);

    const again = await agent.delete(
      `/user/${userId}/settings/nobookends/devices/${first.body.device.id}`
    );
    assert.strictEqual(again.status, 404);
  });

  it("does not remove another user's device", async () => {
    enableBooks();
    const { agent, userId } = await loginAs('demo@seerr.dev');
    const created = await agent.post(`/user/${userId}/settings/nobookends`);
    const { agent: admin, userId: adminId } = await loginAs('admin@seerr.dev');

    // The device does not belong to the user in the path
    const wrongUser = await admin.delete(
      `/user/${adminId}/settings/nobookends/devices/${created.body.device.id}`
    );
    assert.strictEqual(wrongUser.status, 404);

    // Only an admin removes the devices of others
    const adminDevice = await admin.post(
      `/user/${adminId}/settings/nobookends`
    );
    const notAdmin = await agent.delete(
      `/user/${adminId}/settings/nobookends/devices/${adminDevice.body.device.id}`
    );
    assert.strictEqual(notAdmin.status, 403);

    const byAdmin = await admin.delete(
      `/user/${userId}/settings/nobookends/devices/${created.body.device.id}`
    );
    assert.strictEqual(byAdmin.status, 204);
  });

  it('still accepts the single key from before devices', async () => {
    enableBooks();
    const { agent, userId } = await loginAs('demo@seerr.dev');
    const apiKey = generateUserApiKey();
    await getRepository(User).update(userId, {
      nobookendsKeyHash: hashUserApiKey(apiKey),
      nobookendsKeyCreatedAt: new Date(),
    });

    const res = await request(app)
      .get('/nobookends/status')
      .set('X-API-Key', apiKey);
    assert.strictEqual(res.status, 200);

    const status = await agent.get(`/user/${userId}/settings/nobookends`);
    assert.strictEqual(status.body.connected, true);

    await agent.delete(`/user/${userId}/settings/nobookends`);
    const revoked = await request(app)
      .get('/nobookends/status')
      .set('X-API-Key', apiKey);
    assert.strictEqual(revoked.status, 403);
  });

  it('keeps the personal API key the user made', async () => {
    enableBooks();
    const { agent, userId } = await loginAs('demo@seerr.dev');
    const personal = await agent.post(`/user/${userId}/settings/api-key`);
    await agent.post(`/user/${userId}/settings/nobookends`);

    const stored = await getRepository(User).findOneOrFail({
      where: { id: userId },
      select: ['id', 'apiKeyHash'],
    });
    assert.ok(stored.apiKeyHash);

    const res = await request(app)
      .get(`/user/${userId}`)
      .set('X-API-Key', personal.body.apiKey);
    assert.strictEqual(res.status, 200);
  });

  it('signs the app out when disconnected', async () => {
    enableBooks();
    const { agent, userId } = await loginAs('demo@seerr.dev');
    const created = await agent.post(`/user/${userId}/settings/nobookends`);

    const revoke = await agent.delete(`/user/${userId}/settings/nobookends`);
    assert.strictEqual(revoke.status, 204);

    const revoked = await request(app)
      .get('/nobookends/status')
      .set('X-API-Key', created.body.apiKey);
    assert.strictEqual(revoked.status, 403);

    const status = await agent.get(`/user/${userId}/settings/nobookends`);
    assert.strictEqual(status.body.connected, false);
  });

  it('refuses a link while books or Audiobookshelf are not set up', async () => {
    const { agent, userId } = await loginAs('demo@seerr.dev');

    const status = await agent.get(`/user/${userId}/settings/nobookends`);
    assert.strictEqual(status.body.available, false);

    const res = await agent.post(`/user/${userId}/settings/nobookends`);
    assert.strictEqual(res.status, 400);
  });

  it("does not let an admin make another user's link", async () => {
    enableBooks();
    const { userId } = await loginAs('demo@seerr.dev');
    const { agent: admin } = await loginAs('admin@seerr.dev');

    const res = await admin.post(`/user/${userId}/settings/nobookends`);
    assert.strictEqual(res.status, 403);

    const revoke = await admin.delete(`/user/${userId}/settings/nobookends`);
    assert.strictEqual(revoke.status, 204);
  });
});

describe('isPrivateHost', () => {
  it('knows home addresses from public ones', () => {
    for (const host of [
      'localhost',
      '127.0.0.1',
      '10.0.0.5',
      '172.20.1.1',
      '192.168.1.20',
      '100.101.102.103',
      '169.254.1.1',
      '::1',
      '[fd00::1]',
      'fe80::1',
      '::ffff:192.168.1.2',
      'unraid',
      'allseerr.lan',
      'nas.local',
      'tower.home.arpa',
    ]) {
      assert.strictEqual(isPrivateHost(host), true, host);
    }

    for (const host of [
      'requests.example.org',
      '203.0.113.10',
      '172.32.0.1',
      '8.8.8.8',
      '2606:4700::1111',
    ]) {
      assert.strictEqual(isPrivateHost(host), false, host);
    }
  });
});

describe('GET /nobookends/status', () => {
  it('tells the app what the user may do', async () => {
    enableBooks();
    const { agent, userId } = await loginAs('demo@seerr.dev');
    const created = await agent.post(`/user/${userId}/settings/nobookends`);

    const res = await request(app)
      .get('/nobookends/status')
      .set('X-API-Key', created.body.apiKey);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(typeof res.body.version, 'string');
    assert.strictEqual(res.body.user.id, userId);
    assert.deepStrictEqual(res.body.books, {
      enabled: true,
      service: 'lazylibrarian',
      // The demo user has the REQUEST permission only
      canRequest: true,
      autoApprove: false,
      defaultFormat: 'both',
      quota: null,
      // Only Talearr keeps other recordings of an audiobook
      recordings: false,
    });
    assert.deepStrictEqual(res.body.issues, { canCreate: false });
    assert.deepStrictEqual(res.body.requests, { canManage: false });
    assert.deepStrictEqual(res.body.downloads, { canManage: false });
    assert.deepStrictEqual(res.body.audiobookshelf, {
      configured: true,
      url: 'https://books.example.com',
      itemLinks: true,
    });
    assert.strictEqual(res.body.openInNoBookEnds, true);
  });

  it('tells the app the audiobook versions with Talearr', async () => {
    enableBooks();
    const settings = getSettings();
    settings.chaptarr = [
      {
        id: 0,
        name: 'Talearr',
        hostname: 'talearr',
        port: 8789,
        apiKey: 'key',
        useSsl: false,
        activeProfileId: 1,
        activeProfileName: 'E-Book',
        activeDirectory: '/ebooks',
        activeMetadataProfileId: 2,
        activeMetadataProfileName: 'Ebook',
        tags: [],
        is4k: false,
        isDefault: true,
        syncEnabled: true,
        preventSearch: false,
        tagRequests: false,
        overrideRule: [],
      },
    ];
    settings.main.bookService = 'talearr';
    const priorVersions = settings.main.audiobookVersions;
    const { agent } = await loginAs('demo@seerr.dev');

    try {
      // Settings saved before the setting existed ask for both
      settings.main.audiobookVersions = undefined;
      const unset = await agent.get('/nobookends/status');
      assert.strictEqual(unset.body.books.recordings, true);
      assert.strictEqual(unset.body.books.audiobookVersions, 'both');
      assert.strictEqual(unset.body.books.defaultAudiobookVersion, 'both');

      settings.main.audiobookVersions = 'requester';
      const requester = await agent.get('/nobookends/status');
      assert.strictEqual(requester.body.books.audiobookVersions, 'requester');

      // Only Talearr has versions
      settings.main.bookService = 'chaptarr';
      const chaptarr = await agent.get('/nobookends/status');
      assert.strictEqual(chaptarr.body.books.audiobookVersions, undefined);
      assert.strictEqual(
        chaptarr.body.books.defaultAudiobookVersion,
        undefined
      );
    } finally {
      settings.main.audiobookVersions = priorVersions;
    }
  });

  it('turns features off that are not set up or hidden', async () => {
    const { agent } = await loginAs('admin@seerr.dev');

    const bare = await agent.get('/nobookends/status');
    assert.strictEqual(bare.status, 200);
    assert.strictEqual(bare.body.books.enabled, false);
    assert.strictEqual(bare.body.books.canRequest, false);
    assert.strictEqual(bare.body.audiobookshelf.configured, false);
    assert.strictEqual(bare.body.audiobookshelf.url, null);
    assert.strictEqual(bare.body.openInNoBookEnds, false);
    // Admins may manage requests without the permission itself
    assert.deepStrictEqual(bare.body.requests, { canManage: true });

    enableBooks();
    getSettings().audiobookshelf = { showNoBookEnds: false };

    const hidden = await agent.get('/nobookends/status');
    assert.strictEqual(hidden.body.books.autoApprove, true);
    assert.strictEqual(hidden.body.audiobookshelf.itemLinks, true);
    assert.strictEqual(hidden.body.openInNoBookEnds, false);
  });

  it('lets the app know who may manage requests', async () => {
    const manager = new User({
      email: 'manager@example.com',
      username: 'manager',
      avatar: '',
      permissions: Permission.REQUEST | Permission.MANAGE_REQUESTS,
    });
    await manager.setPassword('test1234');
    await getRepository(User).save(manager);

    const { agent } = await loginAs('manager@example.com');
    const res = await agent.get('/nobookends/status');

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.requests, { canManage: true });
    // Stuck downloads are only read from Chaptarr
    assert.deepStrictEqual(res.body.downloads, { canManage: false });

    getSettings().main.bookService = 'chaptarr';
    getSettings().chaptarr = [
      {
        id: 0,
        name: 'Chaptarr',
        hostname: 'chaptarr',
        port: 8789,
        apiKey: 'test-key',
        useSsl: false,
        isDefault: true,
      } as ChaptarrSettings,
    ];
    const chaptarr = await agent.get('/nobookends/status');
    assert.deepStrictEqual(chaptarr.body.downloads, { canManage: true });
  });

  it('needs a signed in user', async () => {
    const res = await request(app).get('/nobookends/status');
    assert.strictEqual(res.status, 403);
  });

  it('hands the app the NoBookEnds Sync address only while enabled', async () => {
    enableBooks();
    const { agent } = await loginAs('demo@seerr.dev');

    const off = await agent.get('/nobookends/status');
    assert.strictEqual(off.status, 200);
    assert.strictEqual('nobookendsSync' in off.body, false);

    getSettings().nobookendsSync = {
      enabled: true,
      url: 'https://sync.example.com/',
      internalUrl: 'http://192.168.1.20:8000',
      adminToken: 'admin-token',
    };
    const on = await agent.get('/nobookends/status');
    // The public address without the trailing slash, never the internal
    // one or the token
    assert.deepStrictEqual(on.body.nobookendsSync, {
      url: 'https://sync.example.com',
    });
    assert.doesNotMatch(JSON.stringify(on.body), /admin-token|192\.168/);

    getSettings().nobookendsSync = { enabled: false };
    const disabled = await agent.get('/nobookends/status');
    assert.strictEqual('nobookendsSync' in disabled.body, false);

    getSettings().nobookendsSync = { enabled: true, url: '' };
    const noUrl = await agent.get('/nobookends/status');
    assert.strictEqual('nobookendsSync' in noUrl.body, false);

    // Served through Allseerr: the proxied address and its path, and only
    // the path without an application URL
    getSettings().nobookendsSync = { enabled: true, proxy: true };
    const proxied = await agent.get('/nobookends/status');
    assert.deepStrictEqual(proxied.body.nobookendsSync, {
      url: 'https://allseerr.example.com/api/v1/nbe-sync',
      proxyPath: '/api/v1/nbe-sync',
    });
    assert.doesNotMatch(JSON.stringify(proxied.body), /admin-token|192\.168/);

    getSettings().main.applicationUrl = '';
    const noAppUrl = await agent.get('/nobookends/status');
    assert.deepStrictEqual(noAppUrl.body.nobookendsSync, {
      proxyPath: '/api/v1/nbe-sync',
    });
  });
});

describe('GET /nobookends/status book quota', () => {
  const createReader = async (bookQuotaLimit?: number, bookQuotaDays = 7) => {
    const reader = new User({
      email: 'reader@example.com',
      username: 'reader',
      avatar: '',
      permissions: Permission.REQUEST,
      bookQuotaLimit,
      bookQuotaDays,
    });
    await reader.setPassword('test1234');
    return getRepository(User).save(reader);
  };

  const addBookRequests = async (user: User, formats: boolean[]) => {
    for (const [index, isAudiobook] of formats.entries()) {
      const media = await getRepository(Media).save(
        new Media({
          mediaType: MediaType.BOOK,
          olId: `OL90000${index}W`,
          status: MediaStatus.PENDING,
        })
      );
      await getRepository(MediaRequest).save(
        new MediaRequest({
          type: MediaType.BOOK,
          status: MediaRequestStatus.PENDING,
          media,
          requestedBy: user,
          isAudiobook,
        })
      );
    }
  };

  it('is null for a user without a limit', async () => {
    enableBooks();
    await createReader();
    const { agent } = await loginAs('reader@example.com');

    const res = await agent.get('/nobookends/status');

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.books.quota, null);
  });

  it('counts both formats against one limit', async () => {
    enableBooks();
    const reader = await createReader(5, 7);
    await addBookRequests(reader, [false, true]);
    const { agent } = await loginAs('reader@example.com');

    const res = await agent.get('/nobookends/status');

    assert.deepStrictEqual(res.body.books.quota, {
      limit: 5,
      days: 7,
      used: 2,
      remaining: 3,
      restricted: false,
    });
  });

  it('says when the quota is used up', async () => {
    enableBooks();
    const reader = await createReader(2, 0);
    await addBookRequests(reader, [true, true, false]);
    const { agent } = await loginAs('reader@example.com');

    const res = await agent.get('/nobookends/status');

    assert.deepStrictEqual(res.body.books.quota, {
      limit: 2,
      days: null,
      used: 3,
      remaining: 0,
      restricted: true,
    });
  });
});
