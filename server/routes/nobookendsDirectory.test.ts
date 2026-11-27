import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it, mock } from 'node:test';

import PlexTvAPI from '@server/api/plextv';
import { MediaServerType } from '@server/constants/server';
import { getRepository } from '@server/datasource';
import { NoBookEndsDevice } from '@server/entity/NoBookEndsDevice';
import { User } from '@server/entity/User';
import { runDirectoryJob } from '@server/lib/nobookendsDirectory';
import notificationManager, { Notification } from '@server/lib/notifications';
import { Permission } from '@server/lib/permissions';
import { defaultPlexDefaultAccess, getSettings } from '@server/lib/settings';
import { sendUsernameChanged } from '@server/lib/userAccess/rename';
import { checkUser, isAuthenticated } from '@server/middleware/auth';
import authRoutes from '@server/routes/auth';
import { nobookendsDirectoryCheck } from '@server/routes/nobookends';
import userAccessSettingsRoutes from '@server/routes/settings/userAccess';
import { setupTestDb } from '@server/test/db';
import { startFakeDirectory } from '@server/test/fakeApps';
import type { Express } from 'express';
import express from 'express';
import session from 'express-session';
import request from 'supertest';

let app: Express;
let server: Server;
let allseerrUrl: string;
let directory: Awaited<ReturnType<typeof startFakeDirectory>>;

// The Plex account the token signs in as, changed per test
let plexAccount = {
  id: 5150,
  email: 'demo@seerr.dev',
  username: 'demo',
  thumb: 'https://plex.tv/users/demo/avatar',
  authToken: 'plex-token-demo',
};

const getPlexUser = mock.method(
  PlexTvAPI.prototype,
  'getUser',
  async () => plexAccount
);
const checkAccess = mock.method(
  PlexTvAPI.prototype,
  'checkUserAccess',
  async () => true
);
const notifications = mock.method(
  notificationManager,
  'sendNotification',
  () => undefined
);

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(
    session({ secret: 'test-secret', resave: false, saveUninitialized: false })
  );
  app.use(checkUser);
  app.get('/api/v1/nobookends/directory', nobookendsDirectoryCheck);
  app.use('/api/v1/auth', authRoutes);
  app.use(
    '/api/v1/settings/user-access',
    isAuthenticated(Permission.ADMIN),
    userAccessSettingsRoutes
  );
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
  // The directory calls this Allseerr back, so it listens for real
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  allseerrUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // The seeded admin's Plex token
  directory = await startFakeDirectory('1234');
  process.env.NOBOOKENDS_DIRECTORY_URL = directory.url;
});

after(async () => {
  delete process.env.NOBOOKENDS_DIRECTORY_URL;
  await directory.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

setupTestDb();

const enableBooks = () => {
  const settings = getSettings();
  settings.main.bookService = 'lazylibrarian';
  settings.lazylibrarian = {
    ...settings.lazylibrarian,
    hostname: 'lazylibrarian',
    apiKey: 'key',
  };
  settings.audiobookshelf = {
    url: 'https://books.example.com',
    apiKey: 'abs-key',
    showNoBookEnds: true,
  };
};

beforeEach(() => {
  plexAccount = {
    id: 5150,
    email: 'demo@seerr.dev',
    username: 'demo',
    thumb: 'https://plex.tv/users/demo/avatar',
    authToken: 'plex-token-demo',
  };
  checkAccess.mock.resetCalls();
  checkAccess.mock.mockImplementation(async () => true);
  notifications.mock.resetCalls();
  directory.calls.splice(0);
  directory.checks.splice(0);
  directory.servers.clear();
  directory.refuseWith(null);

  const settings = getSettings();
  settings.main.localLogin = true;
  settings.main.mediaServerType = MediaServerType.PLEX;
  settings.main.mediaServerLogin = true;
  settings.main.newPlexLogin = false;
  settings.main.applicationUrl = 'https://request.example.com';
  settings.main.applicationTitle = 'Allseerr';
  // The settings setters merge, so values are emptied rather than left out
  settings.main.bookService = undefined;
  settings.chaptarr = [];
  settings.lazylibrarian = { hostname: '', apiKey: '' };
  settings.audiobookshelf = { url: '', apiKey: '', showNoBookEnds: true };
  settings.nobookendsSync = { enabled: false };
  settings.notifications.agents.email.enabled = false;
  settings.userAccess = {
    audiobookshelf: {},
    kavita: {},
    komga: {},
    grimmory: {},
    emailPasswords: true,
    oidc: { enabled: false, clients: [] },
    plexDefault: defaultPlexDefaultAccess(),
    nobookendsDirectory: false,
    nobookendsDirectoryResult: null,
  };
});

async function loginAs(email: string, password = 'test1234') {
  const agent = request.agent(app);
  await agent.post('/api/v1/auth/local').send({ email, password }).expect(200);
  return agent;
}

describe('POST /auth/nobookends/plex', () => {
  it('connects NoBookEnds for an existing user without a session', async () => {
    enableBooks();
    await getRepository(User).update(
      { email: 'demo@seerr.dev' },
      { plexToken: 'stored-token' }
    );

    const res = await request(app)
      .post('/api/v1/auth/nobookends/plex')
      .send({ authToken: 'plex-token-demo', device: 'iPhone 16' })
      .expect(200);

    assert.deepEqual(Object.keys(res.body), ['appUrl']);
    assert.match(res.body.appUrl, /^nobookends:\/\/connect#/);
    const fragment = new URLSearchParams(res.body.appUrl.split('#')[1]);
    assert.equal(fragment.get('allseerr'), 'https://request.example.com');
    assert.equal(fragment.get('abs'), 'https://books.example.com');
    assert.match(fragment.get('key') ?? '', /^asu_/);
    assert.equal(res.headers['set-cookie'], undefined);

    const demo = await getRepository(User).findOneOrFail({
      where: { email: 'demo@seerr.dev' },
    });
    assert.equal(demo.plexId, 5150);
    // The token Allseerr already had stays, not the app's
    const stored = await getRepository(User).findOneOrFail({
      where: { id: demo.id },
      select: { id: true, plexToken: true },
    });
    assert.equal(stored.plexToken, 'stored-token');
    const devices = await getRepository(NoBookEndsDevice).find({
      where: { user: { id: demo.id } },
    });
    assert.equal(devices.length, 1);
    assert.equal(devices[0].label, 'iPhone 16');
  });

  it('asks for a new Plex sign in when Plex turns the token down', async () => {
    enableBooks();
    getPlexUser.mock.mockImplementationOnce(async () => {
      throw new Error('Invalid auth token', {
        cause: { response: { status: 401 } },
      });
    });

    const res = await request(app)
      .post('/api/v1/auth/nobookends/plex')
      .send({ authToken: 'expired-token' })
      .expect(401);

    assert.match(res.body.message, /Sign in with Plex again/);
  });

  it('refuses a Plex account without access to the server', async () => {
    enableBooks();
    plexAccount = { ...plexAccount, id: 4242, email: 'stranger@example.com' };
    checkAccess.mock.mockImplementation(async () => false);

    const res = await request(app)
      .post('/api/v1/auth/nobookends/plex')
      .send({ authToken: 'plex-token-stranger' })
      .expect(403);

    assert.match(res.body.message, /cannot sign in to Allseerr/);
    assert.equal(
      await getRepository(User).count({
        where: { email: 'stranger@example.com' },
      }),
      0
    );
    assert.equal(await getRepository(NoBookEndsDevice).count(), 0);
  });

  it('refuses an unknown Plex user while new Plex users may not sign in', async () => {
    enableBooks();
    plexAccount = { ...plexAccount, id: 4243, email: 'friend@example.com' };

    await request(app)
      .post('/api/v1/auth/nobookends/plex')
      .send({ authToken: 'plex-token-friend' })
      .expect(403);
    assert.equal(
      await getRepository(User).count({
        where: { email: 'friend@example.com' },
      }),
      0
    );
  });

  it('makes an unknown Plex user with access when new Plex users may sign in', async () => {
    enableBooks();
    getSettings().main.newPlexLogin = true;
    plexAccount = { ...plexAccount, id: 4244, email: 'friend@example.com' };

    await request(app)
      .post('/api/v1/auth/nobookends/plex')
      .send({ authToken: 'plex-token-friend' })
      .expect(200);
    const friend = await getRepository(User).findOneOrFail({
      where: { email: 'friend@example.com' },
    });
    assert.equal(friend.plexId, 4244);
  });

  it('answers 409 unavailable before books and Audiobookshelf are set up', async () => {
    const res = await request(app)
      .post('/api/v1/auth/nobookends/plex')
      .send({ authToken: 'plex-token-demo' })
      .expect(409);

    assert.equal(res.body.error, 'unavailable');
    assert.ok(res.body.message);
    assert.equal(await getRepository(NoBookEndsDevice).count(), 0);
  });

  it('answers 409 no_app_url without an address that works away from home', async () => {
    enableBooks();
    getSettings().main.applicationUrl = '';

    const res = await request(app)
      .post('/api/v1/auth/nobookends/plex')
      .send({ authToken: 'plex-token-demo' })
      .expect(409);

    assert.equal(res.body.error, 'no_app_url');
  });

  it('refuses when the server does not sign in with Plex', async () => {
    enableBooks();
    getSettings().main.mediaServerLogin = false;

    await request(app)
      .post('/api/v1/auth/nobookends/plex')
      .send({ authToken: 'plex-token-demo' })
      .expect(403);
  });

  it('needs a Plex token', async () => {
    await request(app)
      .post('/api/v1/auth/nobookends/plex')
      .send({})
      .expect(400);
  });
});

describe('GET /nobookends/directory', () => {
  it('answers 404 for a code it did not make', async () => {
    await request(app)
      .get('/api/v1/nobookends/directory?nonce=abc123')
      .expect(404);
    await request(app).get('/api/v1/nobookends/directory').expect(404);
  });
});

describe('NoBookEnds directory listing', () => {
  it('registers when turned on, and the directory checks the address', async () => {
    getSettings().main.applicationUrl = allseerrUrl;
    getSettings().main.applicationTitle = 'Book Club';
    const admin = await loginAs('admin@seerr.dev');

    const before = await admin
      .get('/api/v1/settings/user-access/nobookends-directory')
      .expect(200);
    assert.deepEqual(before.body, {
      enabled: false,
      applicationUrlMissing: false,
      plexMissing: false,
      lastResult: null,
    });

    const res = await admin
      .post('/api/v1/settings/user-access/nobookends-directory')
      .send({ enabled: true })
      .expect(200);

    assert.equal(res.body.enabled, true);
    assert.equal(res.body.lastResult.registered, 1);
    assert.equal(res.body.lastResult.error, null);
    assert.ok(res.body.lastResult.date);

    const post = directory.calls.find((c) => c.method === 'POST');
    const body = post?.body as {
      plexToken: string;
      url: string;
      nonce: string;
    };
    assert.equal(body.plexToken, '1234');
    assert.equal(body.url, allseerrUrl);
    assert.ok(body.nonce.length >= 32);
    assert.deepEqual(directory.checks, [
      { status: 200, body: { nonce: body.nonce, title: 'Book Club' } },
    ]);
    assert.deepEqual(directory.servers.get('plex-server-hash'), {
      url: allseerrUrl,
      title: 'Book Club',
    });

    // The code only answers while the registration waits for it
    await request(app)
      .get(`/api/v1/nobookends/directory?nonce=${body.nonce}`)
      .expect(404);
  });

  it('removes the listing when turned off', async () => {
    getSettings().main.applicationUrl = allseerrUrl;
    const admin = await loginAs('admin@seerr.dev');
    await admin
      .post('/api/v1/settings/user-access/nobookends-directory')
      .send({ enabled: true })
      .expect(200);
    assert.equal(directory.servers.size, 1);

    const res = await admin
      .post('/api/v1/settings/user-access/nobookends-directory')
      .send({ enabled: false })
      .expect(200);

    assert.equal(res.body.enabled, false);
    assert.equal(res.body.lastResult, null);
    const remove = directory.calls.find((c) => c.method === 'DELETE');
    assert.deepEqual(remove?.body, { plexToken: '1234' });
    assert.equal(directory.servers.size, 0);
    assert.equal(getSettings().userAccess.nobookendsDirectory, false);
  });

  it('keeps it on and shows why the directory refused', async () => {
    getSettings().main.applicationUrl = allseerrUrl;
    directory.refuseWith('This Plex account owns no Plex Media Server.');
    const admin = await loginAs('admin@seerr.dev');

    const res = await admin
      .post('/api/v1/settings/user-access/nobookends-directory')
      .send({ enabled: true })
      .expect(200);

    assert.equal(res.body.enabled, true);
    assert.equal(
      res.body.lastResult.error,
      'This Plex account owns no Plex Media Server.'
    );
    assert.equal(res.body.lastResult.registered, null);
  });

  it('cannot be turned on without the Application URL or Plex', async () => {
    const admin = await loginAs('admin@seerr.dev');
    getSettings().main.applicationUrl = '';

    const res = await admin
      .post('/api/v1/settings/user-access/nobookends-directory')
      .send({ enabled: true })
      .expect(400);
    assert.match(res.body.message, /Application URL/);

    getSettings().main.applicationUrl = allseerrUrl;
    getSettings().main.mediaServerType = MediaServerType.JELLYFIN;
    const status = await admin
      .get('/api/v1/settings/user-access/nobookends-directory')
      .expect(200);
    assert.equal(status.body.plexMissing, true);
    await admin
      .post('/api/v1/settings/user-access/nobookends-directory')
      .send({ enabled: true })
      .expect(400);
    assert.equal(directory.calls.length, 0);
  });

  it('registers again in the daily job only while on', async () => {
    getSettings().main.applicationUrl = allseerrUrl;

    await runDirectoryJob();
    assert.equal(directory.calls.length, 0);

    const settings = getSettings();
    settings.userAccess = { ...settings.userAccess, nobookendsDirectory: true };
    await runDirectoryJob();
    assert.equal(directory.calls.length, 1);
    assert.equal(directory.servers.size, 1);
    assert.equal(settings.userAccess.nobookendsDirectoryResult?.registered, 1);
  });
});

describe('Open NoBookEnds link', () => {
  const payloadOf = () =>
    notifications.mock.calls.find(
      (call) => call.arguments[0] === Notification.APP_USERNAME_CHANGED
    )?.arguments[1] as {
      actionPath?: string;
      externalLink?: { url: string; title: string };
    };

  it('opens NoBookEnds with this server filled in when Sync is on', async () => {
    getSettings().nobookendsSync = { enabled: true };
    const demo = await getRepository(User).findOneOrFail({
      where: { email: 'demo@seerr.dev' },
    });

    sendUsernameChanged(demo, 'demo');

    assert.deepEqual(payloadOf().externalLink, {
      url: 'https://nobookends.com/open/signin?allseerr=https%3A%2F%2Frequest.example.com',
      title: 'Open NoBookEnds',
    });
  });

  it('keeps the Reading apps link without NoBookEnds Sync', async () => {
    const demo = await getRepository(User).findOneOrFail({
      where: { email: 'demo@seerr.dev' },
    });

    sendUsernameChanged(demo, 'demo');

    assert.equal(payloadOf().externalLink, undefined);
    assert.equal(payloadOf().actionPath, '/profile/settings/apps');
  });
});
