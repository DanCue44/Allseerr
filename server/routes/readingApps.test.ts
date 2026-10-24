import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it, mock } from 'node:test';

import {
  ReadingAppState,
  UserAppAccountGrant,
  UserAppAccountStatus,
  defaultReadingAppChoices,
} from '@server/constants/userAccess';
import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import { UserAppAccount } from '@server/entity/UserAppAccount';
import notificationManager, {
  Notification,
  getAdminPermission,
} from '@server/lib/notifications';
import { Permission } from '@server/lib/permissions';
import { defaultPlexDefaultAccess, getSettings } from '@server/lib/settings';
import enableAccessRequestAlerts from '@server/lib/settings/migrations/0014_enable_access_request_alerts';
import enableAccessGrantedAlerts from '@server/lib/settings/migrations/0015_enable_access_granted_alerts';
import enableAppUsernameAlerts from '@server/lib/settings/migrations/0016_enable_app_username_alerts';
import { updatePerson } from '@server/lib/userAccess';
import {
  applyPlexDefaults,
  setPlexMemberSource,
} from '@server/lib/userAccess/plexDefaults';
import {
  NOBOOKENDS_KEY_NAME,
  getReadingAppChoices,
  isTooManyAttempts,
  readingAppStateOf,
  resetReadingAppAttempts,
} from '@server/lib/userAccess/readingApps';
import { generateUserApiKey, hashUserApiKey } from '@server/lib/userApiKey';
import { checkUser, isAuthenticated } from '@server/middleware/auth';
import authRoutes from '@server/routes/auth';
import nobookendsRoutes from '@server/routes/nobookends';
import userAccessSettingsRoutes from '@server/routes/settings/userAccess';
import userRoutes from '@server/routes/user';
import { setupTestDb } from '@server/test/db';
import {
  startFakeAudiobookshelf,
  startFakeKavita,
  startFakeKomga,
} from '@server/test/fakeApps';
import { openSecret, sealSecret } from '@server/utils/secretBox';
import type { Express } from 'express';
import express from 'express';
import session from 'express-session';
import request from 'supertest';

let app: Express;
let abs: Awaited<ReturnType<typeof startFakeAudiobookshelf>>;
let kavita: Awaited<ReturnType<typeof startFakeKavita>>;
let komga: Awaited<ReturnType<typeof startFakeKomga>>;

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
  app.use('/auth', authRoutes);
  app.use('/user', isAuthenticated(), userRoutes);
  app.use('/nobookends', isAuthenticated(), nobookendsRoutes);
  app.use(
    '/settings/user-access',
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
  abs = await startFakeAudiobookshelf('abs-key');
  kavita = await startFakeKavita('kavita-key');
  komga = await startFakeKomga('komga-key');
});

after(async () => {
  await abs.close();
  await kavita.close();
  await komga.close();
});

setupTestDb();

beforeEach(() => {
  abs.users.splice(1);
  abs.apiKeys.splice(0);
  abs.server.version = '2.37.1';
  kavita.members.splice(1);
  Object.assign(kavita.members[0], {
    username: 'admin',
    email: 'admin@example.com',
    password: undefined,
    authKeys: undefined,
  });
  komga.users.splice(1);
  notifications.mock.resetCalls();
  resetReadingAppAttempts();

  const settings = getSettings();
  settings.notifications.agents.email.enabled = false;
  settings.audiobookshelf = { url: '' };
  settings.main.applicationUrl = 'https://requests.example.com';
  settings.userAccess = {
    audiobookshelf: {
      url: abs.url,
      apiKey: 'abs-key',
      publicUrl: 'https://abs.example.com',
    },
    kavita: {
      url: kavita.url,
      apiKey: 'kavita-key',
      publicUrl: 'https://kavita.example.com',
    },
    komga: {},
    emailPasswords: true,
    oidc: { enabled: false, clients: [] },
    plexDefault: defaultPlexDefaultAccess(),
    readingApps: defaultReadingAppChoices(),
  };
});

async function loginAs(email: string, password = 'test1234') {
  const agent = request.agent(app);
  const res = await agent.post('/auth/local').send({ email, password });

  assert.strictEqual(res.status, 200);
  return { agent, userId: res.body.id as number };
}

const demo = async () =>
  getRepository(User).findOneOrFail({ where: { email: 'demo@seerr.dev' } });

const accountOf = async (userId: number, app: string) =>
  getRepository(UserAppAccount).findOne({
    where: { user: { id: userId }, app: app as UserAppAccount['app'] },
  });

// Access as the default for Plex users gives it: allowed, no account yet
const grant = async (user: User, app: UserAppAccount['app']) =>
  getRepository(UserAppAccount).save(
    new UserAppAccount({
      user,
      app,
      enabled: true,
      libraryIds: null,
      status: UserAppAccountStatus.NONE,
      grantedBy: UserAppAccountGrant.PLEX,
    })
  );

const noBookEndsKey = async (user: User): Promise<string> => {
  const apiKey = generateUserApiKey();
  await getRepository(User).update(user.id, {
    nobookendsKeyHash: hashUserApiKey(apiKey),
    nobookendsKeyCreatedAt: new Date(),
  });
  return apiKey;
};

describe('reading app states', () => {
  it('reads a state from access and account', () => {
    assert.equal(readingAppStateOf(null), ReadingAppState.NOT_GRANTED);
    assert.equal(
      readingAppStateOf(
        new UserAppAccount({ enabled: false, accessRequestedAt: new Date() })
      ),
      ReadingAppState.REQUESTED
    );
    assert.equal(
      readingAppStateOf(
        new UserAppAccount({ enabled: true, status: UserAppAccountStatus.NONE })
      ),
      ReadingAppState.AVAILABLE
    );
    assert.equal(
      readingAppStateOf(
        new UserAppAccount({
          enabled: true,
          status: UserAppAccountStatus.ACTIVE,
          remoteUserId: 'abs-1',
        })
      ),
      ReadingAppState.READY
    );
    assert.equal(
      readingAppStateOf(
        new UserAppAccount({
          enabled: true,
          status: UserAppAccountStatus.ERROR,
        })
      ),
      ReadingAppState.ERROR
    );
  });

  it('limits how often one person tries the same thing', () => {
    for (let i = 0; i < 10; i++) {
      assert.equal(isTooManyAttempts('setup:9:kavita', 1000), false);
    }
    assert.equal(isTooManyAttempts('setup:9:kavita', 1000), true);
    assert.equal(isTooManyAttempts('setup:9:audiobookshelf', 1000), false);
    // A while later there is room again
    assert.equal(
      isTooManyAttempts('setup:9:kavita', 1000 + 16 * 60 * 1000),
      false
    );
  });

  it('puts an app that cannot serve a kind back to its default', () => {
    getSettings().userAccess = {
      ...getSettings().userAccess,
      readingApps: { audiobook: 'kavita', ebook: 'kavita', comic: 'komga' },
    };

    assert.deepEqual(getReadingAppChoices(), {
      audiobook: 'audiobookshelf',
      ebook: 'kavita',
      comic: 'komga',
    });
  });
});

describe('reading apps settings', () => {
  it('lists only connected apps with what they are for', async () => {
    const { agent, userId } = await loginAs('demo@seerr.dev');
    const res = await agent.get(`/user/${userId}/settings/apps`);

    assert.equal(res.status, 200);
    assert.deepEqual(
      res.body.apps.map(
        (a: { app: string; purpose: string; state: string }) => [
          a.app,
          a.purpose,
          a.state,
        ]
      ),
      [
        ['audiobookshelf', 'Audiobooks and ebooks', 'notGranted'],
        ['kavita', 'Comics and manga', 'notGranted'],
      ]
    );
    assert.equal(res.body.readingApps.comic, 'kavita');
  });

  it('is shown to people who cannot request', async () => {
    const user = await demo();
    user.permissions = 0;
    await getRepository(User).save(user);
    await grant(user, 'kavita');

    const { agent } = await loginAs('demo@seerr.dev');
    const res = await agent.get(`/user/${user.id}/settings/apps`);

    assert.equal(res.status, 200);
    assert.equal(res.body.apps[1].state, 'available');
  });

  it("never shows or changes someone else's apps", async () => {
    const { agent } = await loginAs('demo@seerr.dev');

    await agent.get('/user/1/settings/apps').expect(403);
    await agent.post('/user/1/settings/apps/kavita/setup').expect(403);
    await agent.post('/user/1/settings/apps/kavita/password').expect(403);
    await agent.post('/user/1/settings/apps/kavita/request-access').expect(403);
  });

  it('lets an admin who manages users see a person', async () => {
    const user = await demo();
    await grant(user, 'kavita');
    const { agent } = await loginAs('admin@seerr.dev');
    const res = await agent.get(`/user/${user.id}/settings/apps`);

    assert.equal(res.status, 200);
    assert.equal(res.body.apps[1].state, 'available');
  });

  it('sets up an account in one tap and shows the password once', async () => {
    const user = await demo();
    await grant(user, 'kavita');
    const { agent } = await loginAs('demo@seerr.dev');

    const res = await agent.post(`/user/${user.id}/settings/apps/kavita/setup`);

    assert.equal(res.status, 200);
    assert.equal(res.body.app.state, 'ready');
    assert.equal(res.body.app.username, 'demo');
    assert.equal(res.body.app.publicUrl, 'https://kavita.example.com');
    assert.match(res.body.password.password, /^[a-z2-9]{4}(-[a-z2-9]{4}){3}$/);
    assert.equal(kavita.members.length, 2);
    assert.equal(kavita.members[1].password, res.body.password.password);

    // A second tap finds it ready and makes no new password
    const again = await agent.post(
      `/user/${user.id}/settings/apps/kavita/setup`
    );
    assert.equal(again.body.app.state, 'ready');
    assert.equal(again.body.password, undefined);
    assert.equal(kavita.members.length, 2);
  });

  it('never gives access to someone who was not given the app', async () => {
    const user = await demo();
    const { agent } = await loginAs('demo@seerr.dev');

    const res = await agent.post(`/user/${user.id}/settings/apps/kavita/setup`);

    assert.equal(res.status, 403);
    assert.equal(kavita.members.length, 1);
    assert.equal(await accountOf(user.id, 'kavita'), null);

    const password = await agent.post(
      `/user/${user.id}/settings/apps/kavita/password`
    );
    assert.equal(password.status, 403);
  });

  it('gives a ready account a new password', async () => {
    const user = await demo();
    await grant(user, 'audiobookshelf');
    const { agent } = await loginAs('demo@seerr.dev');
    await agent
      .post(`/user/${user.id}/settings/apps/audiobookshelf/setup`)
      .expect(200);

    const res = await agent.post(
      `/user/${user.id}/settings/apps/audiobookshelf/password`
    );

    assert.equal(res.status, 200);
    assert.equal(abs.users[1].password, res.body.password);
  });

  it('shows an error that can be tried again', async () => {
    const user = await demo();
    await grant(user, 'kavita');
    const settings = getSettings();
    settings.userAccess = {
      ...settings.userAccess,
      kavita: { ...settings.userAccess.kavita, apiKey: 'wrong-key' },
    };
    const { agent } = await loginAs('demo@seerr.dev');

    const failed = await agent.post(
      `/user/${user.id}/settings/apps/kavita/setup`
    );
    assert.equal(failed.status, 200);
    assert.equal(failed.body.app.state, 'error');

    settings.userAccess = {
      ...settings.userAccess,
      kavita: { ...settings.userAccess.kavita, apiKey: 'kavita-key' },
    };
    const retried = await agent.post(
      `/user/${user.id}/settings/apps/kavita/setup`
    );
    assert.equal(retried.body.app.state, 'ready');
  });

  it('stops too many setups in a row', async () => {
    const user = await demo();
    await grant(user, 'kavita');
    const { agent } = await loginAs('demo@seerr.dev');

    for (let i = 0; i < 10; i++) {
      await agent
        .post(`/user/${user.id}/settings/apps/kavita/setup`)
        .expect(200);
    }
    await agent.post(`/user/${user.id}/settings/apps/kavita/setup`).expect(429);
  });

  it('asks the admins once and shows it was asked', async () => {
    const user = await demo();
    const { agent } = await loginAs('demo@seerr.dev');

    const res = await agent.post(
      `/user/${user.id}/settings/apps/kavita/request-access`
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.app.state, 'requested');

    await agent
      .post(`/user/${user.id}/settings/apps/kavita/request-access`)
      .expect(200);

    assert.equal(notifications.mock.callCount(), 1);
    const [type, payload] = notifications.mock.calls[0].arguments;
    assert.equal(type, Notification.ACCESS_REQUESTED);
    assert.equal(payload?.notifyAdmin, true);
    assert.match(payload?.subject ?? '', /asked for Kavita/);

    // Asking gives nothing
    const account = await accountOf(user.id, 'kavita');
    assert.equal(account?.enabled, false);
    assert.equal(kavita.members.length, 1);

    const list = await agent.get(`/user/${user.id}/settings/apps`);
    assert.equal(list.body.apps[1].state, 'requested');
  });

  it('clears the ask when an admin turns the app on', async () => {
    const user = await demo();
    const { agent } = await loginAs('demo@seerr.dev');
    await agent
      .post(`/user/${user.id}/settings/apps/kavita/request-access`)
      .expect(200);

    await updatePerson(user.id, { apps: { kavita: { enabled: true } } });

    const account = await accountOf(user.id, 'kavita');
    assert.equal(account?.accessRequestedAt, null);
    // Allowed only: the person sets the account up themselves
    const list = await agent.get(`/user/${user.id}/settings/apps`);
    assert.equal(list.body.apps[1].state, 'available');
    assert.equal(kavita.members.length, 1);
  });

  it('leaves an ask to the default for Plex users', async () => {
    const user = await demo();
    user.plexId = 7001;
    user.userType = 1;
    await getRepository(User).save(user);
    const { agent } = await loginAs('demo@seerr.dev');
    await agent
      .post(`/user/${user.id}/settings/apps/kavita/request-access`)
      .expect(200);

    setPlexMemberSource(async () => new Set([7001]));
    const settings = getSettings();
    settings.userAccess = {
      ...settings.userAccess,
      plexDefault: { ...defaultPlexDefaultAccess(), enabled: true },
    };

    try {
      await applyPlexDefaults({ userIds: [user.id] });
    } finally {
      setPlexMemberSource(null);
    }

    const account = await accountOf(user.id, 'kavita');
    assert.equal(account?.enabled, true);
    assert.equal(account?.accessRequestedAt, null);
  });

  it('offers Sign in with Allseerr where the app is registered', async () => {
    const user = await demo();
    await grant(user, 'kavita');
    const settings = getSettings();
    settings.userAccess = {
      ...settings.userAccess,
      oidc: {
        enabled: true,
        clients: [
          {
            app: 'kavita',
            clientId: 'allseerr-kavita',
            clientSecret: 'secret',
            redirectUris: ['https://kavita.example.com/signin-oidc'],
            enabled: true,
          },
        ],
      },
    };
    const { agent } = await loginAs('demo@seerr.dev');
    const res = await agent.get(`/user/${user.id}/settings/apps`);

    assert.equal(res.body.apps[0].signInWithAllseerr, false);
    assert.equal(res.body.apps[1].signInWithAllseerr, true);
  });
});

describe('apps picked for no kind', () => {
  const connectKomga = () => {
    const settings = getSettings();
    settings.userAccess = {
      ...settings.userAccess,
      komga: { url: komga.url, apiKey: 'komga-key' },
    };
  };

  it('are hidden from people who were not given them', async () => {
    connectKomga();
    const user = await demo();
    const { agent } = await loginAs('demo@seerr.dev');
    const res = await agent.get(`/user/${user.id}/settings/apps`);

    assert.deepEqual(
      res.body.apps.map((a: { app: string }) => a.app),
      ['audiobookshelf', 'kavita']
    );

    const key = await noBookEndsKey(user);
    const nbe = await request(app)
      .get('/nobookends/reading-apps')
      .set('X-API-Key', key);
    assert.deepEqual(
      nbe.body.apps.map((a: { app: string }) => a.app),
      ['audiobookshelf', 'kavita']
    );
  });

  it('are shown to people who were given them', async () => {
    connectKomga();
    const user = await demo();
    await grant(user, 'komga');
    const { agent } = await loginAs('demo@seerr.dev');
    const res = await agent.get(`/user/${user.id}/settings/apps`);

    assert.deepEqual(
      res.body.apps.map((a: { app: string; state: string }) => [
        a.app,
        a.state,
      ]),
      [
        ['audiobookshelf', 'notGranted'],
        ['kavita', 'notGranted'],
        ['komga', 'available'],
      ]
    );
  });

  it('follow the admin choices', async () => {
    connectKomga();
    const settings = getSettings();
    settings.userAccess = {
      ...settings.userAccess,
      readingApps: {
        audiobook: 'audiobookshelf',
        ebook: 'audiobookshelf',
        comic: 'komga',
      },
    };
    const user = await demo();
    const { agent } = await loginAs('demo@seerr.dev');
    const res = await agent.get(`/user/${user.id}/settings/apps`);

    assert.deepEqual(
      res.body.apps.map((a: { app: string }) => a.app),
      ['audiobookshelf', 'komga']
    );
  });
});

describe('reading app choices', () => {
  it('saves the app for each kind and refuses one that cannot serve it', async () => {
    const { agent } = await loginAs('admin@seerr.dev');

    const saved = await agent
      .post('/settings/user-access/reading-apps')
      .send({ ebook: 'kavita', comic: 'komga' });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body, {
      audiobook: 'audiobookshelf',
      ebook: 'kavita',
      comic: 'komga',
    });

    await agent
      .post('/settings/user-access/reading-apps')
      .send({ audiobook: 'kavita' })
      .expect(400);
  });

  it('is for admins only', async () => {
    const { agent } = await loginAs('demo@seerr.dev');
    await agent.get('/settings/user-access/reading-apps').expect(403);
  });
});

describe('NoBookEnds reading apps', () => {
  it('lists the states with only the agreed fields', async () => {
    const user = await demo();
    user.permissions = 0;
    await getRepository(User).save(user);
    await grant(user, 'audiobookshelf');
    const key = await noBookEndsKey(user);

    const res = await request(app)
      .get('/nobookends/reading-apps')
      .set('X-API-Key', key);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body.apps[0], {
      app: 'audiobookshelf',
      name: 'Audiobookshelf',
      purpose: 'Audiobooks and ebooks',
      state: 'available',
      publicUrl: 'https://abs.example.com',
      message:
        'You have access to Audiobookshelf. Set up your account to start.',
    });
    assert.equal(res.body.apps[1].state, 'notGranted');
  });

  it('signs in to Audiobookshelf with an API key made for the person', async () => {
    const user = await demo();
    user.permissions = 0;
    await getRepository(User).save(user);
    await grant(user, 'audiobookshelf');
    const key = await noBookEndsKey(user);

    const res = await request(app)
      .post('/nobookends/reading-apps/audiobookshelf/connect')
      .set('X-API-Key', key);

    assert.equal(res.status, 200);
    assert.equal(res.body.app, 'audiobookshelf');
    assert.equal(res.body.serverUrl, 'https://abs.example.com');
    assert.equal(res.body.username, 'demo');
    assert.equal(res.body.token, abs.apiKeys[0].key);
    assert.equal(abs.apiKeys[0].name, NOBOOKENDS_KEY_NAME);
    assert.equal(abs.apiKeys[0].userId, abs.users[1].id);
    // The account was just made, so its password is shown once
    assert.equal(res.body.password, abs.users[1].password);

    // Another device gets the same key, and no new password
    const again = await request(app)
      .post('/nobookends/reading-apps/audiobookshelf/connect')
      .set('X-API-Key', key);
    assert.equal(again.body.token, res.body.token);
    assert.equal(again.body.password, undefined);
    assert.equal(abs.apiKeys.length, 1);

    // The key is never shown on the settings pages
    const { agent } = await loginAs('demo@seerr.dev');
    const list = await agent.get(`/user/${user.id}/settings/apps`);
    assert.equal(JSON.stringify(list.body).includes(res.body.token), false);
  });

  it('replaces an Audiobookshelf key that stopped working', async () => {
    const user = await demo();
    await grant(user, 'audiobookshelf');
    const key = await noBookEndsKey(user);
    const first = await request(app)
      .post('/nobookends/reading-apps/audiobookshelf/connect')
      .set('X-API-Key', key);

    abs.apiKeys.splice(0);

    const second = await request(app)
      .post('/nobookends/reading-apps/audiobookshelf/connect')
      .set('X-API-Key', key);
    assert.equal(second.status, 200);
    assert.notEqual(second.body.token, first.body.token);
    assert.equal(abs.apiKeys.length, 1);
  });

  it('falls back to a password on Audiobookshelf without API keys', async () => {
    abs.server.version = '2.25.0';
    const user = await demo();
    await grant(user, 'audiobookshelf');
    const key = await noBookEndsKey(user);

    const res = await request(app)
      .post('/nobookends/reading-apps/audiobookshelf/connect')
      .set('X-API-Key', key);

    assert.equal(res.status, 200);
    assert.equal(res.body.token, undefined);
    assert.equal(res.body.password, abs.users[1].password);
    assert.equal(abs.apiKeys.length, 0);
  });

  it('signs in to Kavita with an auth key it makes as the person', async () => {
    const user = await demo();
    await grant(user, 'kavita');
    const key = await noBookEndsKey(user);

    const res = await request(app)
      .post('/nobookends/reading-apps/kavita/connect')
      .set('X-API-Key', key);

    assert.equal(res.status, 200);
    assert.equal(res.body.serverUrl, 'https://kavita.example.com');
    assert.equal(res.body.username, 'demo');
    const member = kavita.members[1];
    assert.equal(member.authKeys?.[0].name, NOBOOKENDS_KEY_NAME);
    assert.equal(res.body.apiKey, member.authKeys?.[0].key);
    assert.equal(res.body.password, member.password);

    const again = await request(app)
      .post('/nobookends/reading-apps/kavita/connect')
      .set('X-API-Key', key);
    assert.equal(again.body.apiKey, res.body.apiKey);
    assert.equal(again.body.password, undefined);
    assert.equal(member.authKeys?.length, 1);
  });

  const ownKavitaAccount = () =>
    kavita.members.push({
      id: 50,
      username: 'demo',
      email: 'demo@seerr.dev',
      isPending: false,
      roles: ['Login', 'Pleb'],
      libraries: [],
      ageRestriction: { ageRating: -1, includeUnknowns: true },
      identityProvider: 0,
      password: 'their-own-password',
    });

  it("never changes the password of the person's own Kavita account", async () => {
    const user = await demo();
    await grant(user, 'kavita');
    ownKavitaAccount();
    const key = await noBookEndsKey(user);

    const res = await request(app)
      .post('/nobookends/reading-apps/kavita/connect')
      .set('X-API-Key', key);

    assert.equal(res.status, 409);
    assert.equal(
      res.body.message,
      'You already have a Kavita account. Sign in to Kavita in NoBookEnds with your own password.'
    );
    // NoBookEnds fills in its sign in with these
    assert.deepEqual(res.body.signIn, {
      serverUrl: 'https://kavita.example.com',
      username: 'demo',
    });
    assert.equal(kavita.members[1].password, 'their-own-password');
    assert.equal(kavita.members[1].authKeys, undefined);

    // The page shows it linked and ready, without a new password
    const { agent } = await loginAs('demo@seerr.dev');
    const list = await agent.get(`/user/${user.id}/settings/apps`);
    assert.equal(list.body.apps[1].state, 'ready');
    assert.equal(list.body.apps[1].ownAccount, true);
    assert.equal(list.body.apps[1].canResetPassword, false);
    await agent
      .post(`/user/${user.id}/settings/apps/kavita/password`)
      .expect(409);
    assert.equal(kavita.members[1].password, 'their-own-password');
  });

  it("makes a key for the API key's own Kavita account without a password", async () => {
    const user = await demo();
    await grant(user, 'kavita');
    // The admin reads with their own account, the one Allseerr signs in as
    Object.assign(kavita.members[0], {
      username: 'demo',
      email: 'demo@seerr.dev',
      password: 'their-own-password',
    });
    const key = await noBookEndsKey(user);

    const res = await request(app)
      .post('/nobookends/reading-apps/kavita/connect')
      .set('X-API-Key', key);

    assert.equal(res.status, 200);
    assert.equal(res.body.username, 'demo');
    const admin = kavita.members[0];
    assert.equal(admin.authKeys?.[0].name, NOBOOKENDS_KEY_NAME);
    assert.equal(res.body.apiKey, admin.authKeys?.[0].key);
    assert.equal(res.body.password, undefined);
    assert.equal(admin.password, 'their-own-password');

    const again = await request(app)
      .post('/nobookends/reading-apps/kavita/connect')
      .set('X-API-Key', key);
    assert.equal(again.body.apiKey, res.body.apiKey);
    assert.equal(admin.authKeys?.length, 1);
  });

  it('changes the password of a Kavita account Allseerr made to make a key', async () => {
    const user = await demo();
    await grant(user, 'kavita');
    const { agent } = await loginAs('demo@seerr.dev');
    const setup = await agent
      .post(`/user/${user.id}/settings/apps/kavita/setup`)
      .expect(200);
    assert.equal(setup.body.app.canResetPassword, true);
    const key = await noBookEndsKey(user);

    const res = await request(app)
      .post('/nobookends/reading-apps/kavita/connect')
      .set('X-API-Key', key);

    assert.equal(res.status, 200);
    assert.equal(res.body.apiKey, kavita.members[1].authKeys?.[0].key);
    assert.equal(res.body.password, kavita.members[1].password);
    assert.notEqual(res.body.password, setup.body.password.password);
  });

  it("signs in to the person's own Audiobookshelf account with a key only", async () => {
    const user = await demo();
    await grant(user, 'audiobookshelf');
    abs.users.push({
      id: 'own',
      username: 'demo',
      email: null,
      type: 'user',
      isActive: true,
      password: 'their-own-password',
      permissions: {},
    });
    const key = await noBookEndsKey(user);

    const res = await request(app)
      .post('/nobookends/reading-apps/audiobookshelf/connect')
      .set('X-API-Key', key);

    assert.equal(res.status, 200);
    assert.equal(res.body.token, abs.apiKeys[0].key);
    assert.equal(res.body.password, undefined);
    assert.equal(abs.users[1].password, 'their-own-password');

    // Without API keys there is no way in that keeps their password
    abs.server.version = '2.20.0';
    await getRepository(UserAppAccount).update(
      { user: { id: user.id }, app: 'audiobookshelf' },
      { nobookendsToken: null, nobookendsTokenId: null }
    );
    const old = await request(app)
      .post('/nobookends/reading-apps/audiobookshelf/connect')
      .set('X-API-Key', key);
    assert.equal(old.status, 409);
    assert.equal(abs.users[1].password, 'their-own-password');
  });

  it("never changes the password of the person's own Komga account", async () => {
    const settings = getSettings();
    settings.userAccess = {
      ...settings.userAccess,
      komga: { url: komga.url, apiKey: 'komga-key' },
    };
    const user = await demo();
    await grant(user, 'komga');
    komga.users.push({
      id: 'own',
      email: 'demo@seerr.dev',
      roles: ['PAGE_STREAMING'],
      sharedAllLibraries: true,
      sharedLibrariesIds: [],
      password: 'their-own-password',
    });
    const key = await noBookEndsKey(user);

    const res = await request(app)
      .post('/nobookends/reading-apps/komga/connect')
      .set('X-API-Key', key);

    assert.equal(res.status, 409);
    assert.match(res.body.message, /You already have a Komga account/);
    assert.equal(komga.users[1].password, 'their-own-password');
  });

  it('keeps the NoBookEnds key sealed and seals keys saved before', async () => {
    const user = await demo();
    await grant(user, 'audiobookshelf');
    const key = await noBookEndsKey(user);
    const first = await request(app)
      .post('/nobookends/reading-apps/audiobookshelf/connect')
      .set('X-API-Key', key);

    const stored = async () =>
      (
        await getRepository(UserAppAccount)
          .createQueryBuilder('account')
          .addSelect('account.nobookendsToken')
          .where('account.app = :app', { app: 'audiobookshelf' })
          .getOneOrFail()
      ).nobookendsToken ?? '';

    assert.match(await stored(), /^enc:v1:/);
    assert.equal((await stored()).includes(first.body.token), false);

    // A key saved in plain before sealing is used and sealed
    await getRepository(UserAppAccount).update(
      { user: { id: user.id }, app: 'audiobookshelf' },
      { nobookendsToken: first.body.token }
    );
    const again = await request(app)
      .post('/nobookends/reading-apps/audiobookshelf/connect')
      .set('X-API-Key', key);
    assert.equal(again.body.token, first.body.token);
    assert.match(await stored(), /^enc:v1:/);
    assert.equal(abs.apiKeys.length, 1);

    // One sealed under another secret is replaced
    await getRepository(UserAppAccount).update(
      { user: { id: user.id }, app: 'audiobookshelf' },
      { nobookendsToken: sealSecret(first.body.token, 'another-secret') }
    );
    const replaced = await request(app)
      .post('/nobookends/reading-apps/audiobookshelf/connect')
      .set('X-API-Key', key);
    assert.equal(replaced.status, 200);
    assert.notEqual(replaced.body.token, first.body.token);
  });

  it("never changes an app admin's password", async () => {
    const user = await demo();
    await grant(user, 'kavita');
    kavita.members.push({
      id: 51,
      username: 'demo',
      email: 'demo@seerr.dev',
      isPending: false,
      roles: ['Admin', 'Login', 'Pleb'],
      libraries: [],
      ageRestriction: { ageRating: -1, includeUnknowns: true },
      identityProvider: 0,
      password: 'admin-password',
    });
    const key = await noBookEndsKey(user);

    const res = await request(app)
      .post('/nobookends/reading-apps/kavita/connect')
      .set('X-API-Key', key);

    assert.equal(res.status, 409);
    assert.equal(kavita.members[1].password, 'admin-password');
  });

  it('refuses an app the person was not given', async () => {
    const user = await demo();
    const key = await noBookEndsKey(user);

    const res = await request(app)
      .post('/nobookends/reading-apps/kavita/connect')
      .set('X-API-Key', key);

    assert.equal(res.status, 403);
    assert.ok(res.body.message);
    assert.equal(kavita.members.length, 1);
    assert.equal(await accountOf(user.id, 'kavita'), null);
  });

  it('answers 409 when the app cannot be reached', async () => {
    const user = await demo();
    await grant(user, 'kavita');
    const settings = getSettings();
    settings.userAccess = {
      ...settings.userAccess,
      kavita: { ...settings.userAccess.kavita, url: 'http://127.0.0.1:1' },
    };
    const key = await noBookEndsKey(user);

    const res = await request(app)
      .post('/nobookends/reading-apps/kavita/connect')
      .set('X-API-Key', key);

    assert.equal(res.status, 409);
    assert.ok(res.body.message);
  });

  it('asks for access', async () => {
    const user = await demo();
    const key = await noBookEndsKey(user);

    const res = await request(app)
      .post('/nobookends/reading-apps/kavita/request-access')
      .set('X-API-Key', key);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { state: 'requested' });
    assert.equal(notifications.mock.callCount(), 1);
  });

  it('needs a signed in user', async () => {
    await request(app).get('/nobookends/reading-apps').expect(403);
    await request(app)
      .post('/nobookends/reading-apps/kavita/connect')
      .expect(403);
  });
});

describe('access request notifications', () => {
  it('go to admins who manage users', () => {
    assert.equal(
      getAdminPermission(Notification.ACCESS_REQUESTED),
      Permission.MANAGE_USERS
    );
  });

  it('are turned on once for agents that send pending requests', () => {
    const migrated = enableAccessRequestAlerts({
      notifications: {
        agents: {
          email: { enabled: true, types: Notification.MEDIA_PENDING },
          slack: { enabled: true, types: Notification.MEDIA_AVAILABLE },
        },
      },
      migrations: [],
    });
    const agents = migrated.notifications.agents as unknown as Record<
      string,
      { types?: number }
    >;

    assert.equal(
      agents.email.types,
      Notification.MEDIA_PENDING | Notification.ACCESS_REQUESTED
    );
    assert.equal(agents.slack.types, Notification.MEDIA_AVAILABLE);
    assert.deepEqual(migrated.migrations, [
      '0014_enable_access_request_alerts',
    ]);

    agents.email.types = Notification.MEDIA_PENDING;
    const again = enableAccessRequestAlerts(structuredClone(migrated));
    assert.equal(
      (
        again.notifications.agents as unknown as Record<
          string,
          { types: number }
        >
      ).email.types,
      Notification.MEDIA_PENDING
    );
  });
});

describe('sealed secrets', () => {
  it('open with the secret they were sealed with', () => {
    const sealed = sealSecret('a-key', 'secret-one');

    assert.match(sealed, /^enc:v1:/);
    assert.notEqual(sealSecret('a-key', 'secret-one'), sealed);
    assert.deepEqual(openSecret(sealed, 'secret-one'), {
      plain: 'a-key',
      legacy: false,
    });
    assert.equal(openSecret(sealed, 'secret-two'), null);
    assert.equal(openSecret(`${sealed.slice(0, -4)}AAAA`, 'secret-one'), null);
    assert.deepEqual(openSecret('plain-key', 'secret-one'), {
      plain: 'plain-key',
      legacy: true,
    });
  });
});

describe('access granted notifications', () => {
  it('are turned on once for agents that send approved requests', () => {
    const migrated = enableAccessGrantedAlerts({
      notifications: {
        agents: {
          email: { enabled: true, types: Notification.MEDIA_APPROVED },
          slack: { enabled: true, types: Notification.MEDIA_PENDING },
        },
      },
      migrations: [],
    });
    const agents = migrated.notifications.agents as unknown as Record<
      string,
      { types?: number }
    >;

    assert.equal(
      agents.email.types,
      Notification.MEDIA_APPROVED | Notification.ACCESS_GRANTED
    );
    assert.equal(agents.slack.types, Notification.MEDIA_PENDING);
    assert.deepEqual(migrated.migrations, [
      '0015_enable_access_granted_alerts',
    ]);
  });
});

describe('app username changed notifications', () => {
  it('are turned on once for agents that tell people about access', () => {
    const migrated = enableAppUsernameAlerts({
      notifications: {
        agents: {
          email: { enabled: true, types: Notification.ACCESS_GRANTED },
          slack: { enabled: true, types: Notification.MEDIA_PENDING },
        },
      },
      migrations: ['0015_enable_access_granted_alerts'],
    });
    const agents = migrated.notifications.agents as unknown as Record<
      string,
      { types?: number }
    >;

    assert.equal(
      agents.email.types,
      Notification.ACCESS_GRANTED | Notification.APP_USERNAME_CHANGED
    );
    assert.equal(agents.slack.types, Notification.MEDIA_PENDING);
    assert.equal(
      enableAppUsernameAlerts(migrated).migrations?.filter(
        (name) => name === '0016_enable_app_username_alerts'
      ).length,
      1
    );
  });
});
