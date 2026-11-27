import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it, mock } from 'node:test';

import { MediaServerType } from '@server/constants/server';
import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import { UserAppAccount } from '@server/entity/UserAppAccount';
import notificationManager, { Notification } from '@server/lib/notifications';
import { Permission } from '@server/lib/permissions';
import { defaultPlexDefaultAccess, getSettings } from '@server/lib/settings';
import {
  accountMatchScore,
  appUsernameFor,
  generateAppPassword,
  syncEveryone,
} from '@server/lib/userAccess';
import { checkUser, isAuthenticated } from '@server/middleware/auth';
import authRoutes from '@server/routes/auth';
import userAccessSettingsRoutes from '@server/routes/settings/userAccess';
import userAccessRoutes from '@server/routes/userAccess';
import { setupTestDb } from '@server/test/db';
import {
  startFakeAudiobookshelf,
  startFakeKavita,
  startFakeKomga,
} from '@server/test/fakeApps';
import type { Express } from 'express';
import express from 'express';
import session from 'express-session';
import request from 'supertest';

let app: Express;

const notifications = mock.method(
  notificationManager,
  'sendNotification',
  () => undefined
);
let abs: Awaited<ReturnType<typeof startFakeAudiobookshelf>>;
let kavita: Awaited<ReturnType<typeof startFakeKavita>>;
let komga: Awaited<ReturnType<typeof startFakeKomga>>;

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(
    session({ secret: 'test-secret', resave: false, saveUninitialized: false })
  );
  app.use(checkUser);
  app.use('/auth', authRoutes);
  app.use(
    '/settings/user-access',
    isAuthenticated(Permission.ADMIN),
    userAccessSettingsRoutes
  );
  app.use(
    '/user-access',
    isAuthenticated(Permission.MANAGE_USERS),
    userAccessRoutes
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
  // Each app starts with only its admin
  abs.users.splice(1);
  kavita.members.splice(1);
  komga.users.splice(1);

  const settings = getSettings();
  settings.notifications.agents.email.enabled = false;
  settings.audiobookshelf = { url: '' };
  settings.userAccess = {
    audiobookshelf: { url: abs.url, apiKey: 'abs-key' },
    kavita: { url: kavita.url, apiKey: 'kavita-key' },
    komga: { url: komga.url, apiKey: 'komga-key' },
    grimmory: {},
    emailPasswords: true,
    oidc: { enabled: false, clients: [] },
    plexDefault: defaultPlexDefaultAccess(),
    matchPlexUsernames: true,
    serviceAccounts: { audiobookshelf: [], kavita: [], komga: [] },
    personAccounts: { audiobookshelf: [], kavita: [], komga: [] },
    renames: [],
  };
});

async function loginAs(email: string, password = 'test1234') {
  const agent = request.agent(app);
  const res = await agent.post('/auth/local').send({ email, password });

  assert.strictEqual(res.status, 200);
  return agent;
}

describe('app passwords and usernames', () => {
  it('makes readable passwords that differ each time', () => {
    const password = generateAppPassword();
    assert.match(password, /^[a-z2-9]{4}(-[a-z2-9]{4}){3}$/);
    assert.notEqual(password, generateAppPassword());
  });

  it('names people in the apps after their username', () => {
    assert.equal(
      appUsernameFor(new User({ id: 3, username: 'Sam Smith', email: '' })),
      'SamSmith'
    );
    assert.equal(
      appUsernameFor(
        new User({ id: 4, plexUsername: 'plexkid', email: 'x@example.com' })
      ),
      'plexkid'
    );
    assert.equal(
      appUsernameFor(new User({ id: 5, email: 'reader@example.com' })),
      'reader'
    );
  });
});

describe('user access settings', () => {
  it('never sends the secrets back', async () => {
    const agent = await loginAs('admin@seerr.dev');
    const res = await agent.get('/settings/user-access');

    assert.equal(res.status, 200);
    assert.equal(res.body.kavita.apiKeySet, true);
    assert.equal(res.body.kavita.apiKey, undefined);
    assert.equal(JSON.stringify(res.body).includes('kavita-key'), false);
  });

  it('keeps a saved key when none is sent and removes an empty one', async () => {
    const agent = await loginAs('admin@seerr.dev');

    await agent
      .post('/settings/user-access')
      .send({ kavita: { url: `${kavita.url}/` } })
      .expect(200);
    assert.equal(getSettings().userAccess.kavita.apiKey, 'kavita-key');
    assert.equal(getSettings().userAccess.kavita.url, kavita.url);

    await agent
      .post('/settings/user-access')
      .send({ komga: { apiKey: '' } })
      .expect(200);
    assert.equal(getSettings().userAccess.komga.apiKey, '');
  });

  it('rejects addresses that are not web addresses', async () => {
    const agent = await loginAs('admin@seerr.dev');
    const res = await agent
      .post('/settings/user-access')
      .send({ komga: { url: 'ftp://komga' } });

    assert.equal(res.status, 400);
  });

  it('tests a connection with the saved key and lists libraries', async () => {
    const agent = await loginAs('admin@seerr.dev');
    const res = await agent.post('/settings/user-access/komga/test').send({});

    assert.equal(res.status, 200);
    assert.equal(res.body.version, '1.29.1');
    assert.deepEqual(
      res.body.libraries.map((l: { name: string }) => l.name),
      ['Comics', 'Manga']
    );
  });

  it('is for admins only', async () => {
    const agent = await loginAs('demo@seerr.dev');
    await agent.get('/settings/user-access').expect(403);
    await agent.get('/user-access/people').expect(403);
  });
});

describe('user access people', () => {
  const demoId = async () =>
    (
      await getRepository(User).findOneOrFail({
        where: { email: 'demo@seerr.dev' },
      })
    ).id;

  it('lists everyone with the apps they may use', async () => {
    const agent = await loginAs('admin@seerr.dev');
    const res = await agent.get('/user-access/people');

    assert.equal(res.status, 200);
    const demo = res.body.find(
      (p: { email: string }) => p.email === 'demo@seerr.dev'
    );
    assert.equal(demo.apps.kavita.enabled, false);
    assert.equal(demo.apps.kavita.status, 'none');
    assert.equal(demo.ageLimit, null);
  });

  it('lists the apps and their libraries', async () => {
    const agent = await loginAs('admin@seerr.dev');
    const res = await agent.get('/user-access/apps').expect(200);

    assert.deepEqual(
      res.body.map((a: { app: string; connected: boolean }) => [
        a.app,
        a.connected,
      ]),
      [
        ['audiobookshelf', true],
        ['kavita', true],
        ['komga', true],
        ['grimmory', false],
      ]
    );
  });

  it('only allows apps when an admin turns them on, and tells the person', async () => {
    const agent = await loginAs('admin@seerr.dev');
    const userId = await demoId();
    notifications.mock.resetCalls();

    const res = await agent
      .post(`/user-access/people/${userId}`)
      .send({ apps: { kavita: { enabled: true } } })
      .expect(200);

    assert.equal(res.body.person.apps.kavita.enabled, true);
    assert.equal(res.body.person.apps.kavita.status, 'none');
    assert.deepEqual(res.body.passwords, {});
    assert.equal(kavita.members.length, 1);

    assert.equal(notifications.mock.callCount(), 1);
    const [type, payload] = notifications.mock.calls[0].arguments;
    assert.equal(type, Notification.ACCESS_GRANTED);
    assert.equal(payload?.notifyUser?.id, userId);
    assert.equal(payload?.actionPath, '/profile/settings/apps?app=kavita');
    assert.equal(
      payload?.message,
      'Your Kavita access is ready. Set it up in one tap.'
    );

    // Saving again tells nobody again
    await agent
      .post(`/user-access/people/${userId}`)
      .send({ apps: { kavita: { enabled: true } } })
      .expect(200);
    assert.equal(notifications.mock.callCount(), 1);
  });

  it('makes accounts with a password shown once, then limits and locks them', async () => {
    const agent = await loginAs('admin@seerr.dev');
    const userId = await demoId();

    await agent
      .post(`/user-access/people/${userId}`)
      .send({
        ageLimit: 'kids',
        apps: {
          kavita: { enabled: true, libraryIds: ['2'] },
          komga: { enabled: true },
          audiobookshelf: { enabled: true },
        },
      })
      .expect(200);

    // The admin makes the accounts now instead of the person
    const passwords: Record<string, { password: string; emailed: boolean }> =
      {};
    for (const name of ['kavita', 'komga', 'audiobookshelf']) {
      const created = await agent
        .post(`/user-access/people/${userId}/apps/${name}/create`)
        .expect(200);
      passwords[name] = created.body.passwords[name];
    }
    const person = await agent.get(`/user-access/people/${userId}`).expect(200);
    const res = { body: { person: person.body, passwords } };

    assert.equal(res.body.person.ageLimit, 'kids');
    assert.equal(res.body.person.apps.kavita.status, 'active');
    assert.equal(res.body.person.apps.kavita.remoteUsername, 'demo');
    assert.equal(res.body.person.apps.komga.remoteUsername, 'demo@seerr.dev');
    for (const name of ['kavita', 'komga', 'audiobookshelf']) {
      assert.match(res.body.passwords[name].password, /^[a-z2-9-]{19}$/);
      assert.equal(res.body.passwords[name].emailed, false);
    }

    const member = kavita.members.find((m) => m.username === 'demo')!;
    assert.equal(member.password, res.body.passwords.kavita.password);
    assert.deepEqual(
      member.libraries.map((l) => l.name),
      ['Manga']
    );
    const komgaUser = komga.users.find((u) => u.email === 'demo@seerr.dev')!;
    assert.deepEqual(komgaUser.ageRestriction, {
      age: 9,
      restriction: 'ALLOW_ONLY',
    });
    const absUser = abs.users.find((u) => u.username === 'demo')!;
    assert.equal(absUser.permissions.accessExplicitContent, false);

    // Nothing is stored that could show the password again
    const stored = await getRepository(UserAppAccount).find();
    assert.equal(
      JSON.stringify(stored).includes(res.body.passwords.kavita.password),
      false
    );

    // Taking access away keeps the accounts but locks them
    const revoked = await agent
      .post(`/user-access/people/${userId}`)
      .send({ apps: { kavita: { enabled: false }, komga: { enabled: false } } })
      .expect(200);

    assert.equal(revoked.body.person.apps.kavita.status, 'disabled');
    assert.deepEqual(revoked.body.passwords, {});
    assert.equal(member.roles.includes('Login'), false);
    assert.deepEqual(komgaUser.roles, []);
  });

  it('links an account that already exists instead of making one', async () => {
    const agent = await loginAs('admin@seerr.dev');
    const userId = await demoId();
    abs.users.push({
      id: 'existing',
      username: 'demo',
      email: null,
      type: 'user',
      isActive: false,
      permissions: {},
    });

    const res = await agent
      .post(`/user-access/people/${userId}`)
      .send({ apps: { audiobookshelf: { enabled: true } } })
      .expect(200);

    assert.equal(res.body.passwords.audiobookshelf, undefined);
    assert.equal(res.body.person.apps.audiobookshelf.status, 'active');
    assert.equal(abs.users.find((u) => u.id === 'existing')?.isActive, true);
  });

  it('records why an app could not be synced', async () => {
    const agent = await loginAs('admin@seerr.dev');
    const userId = await demoId();
    getSettings().userAccess = {
      ...getSettings().userAccess,
      komga: { url: komga.url, apiKey: 'wrong-key' },
    };

    const res = await agent
      .post(`/user-access/people/${userId}`)
      .send({ apps: { komga: { enabled: true } } })
      .expect(200);

    assert.equal(res.body.person.apps.komga.status, 'error');
    assert.match(res.body.person.apps.komga.lastError, /Komga answered 401/);
  });

  it('resets a password and deletes an account', async () => {
    const agent = await loginAs('admin@seerr.dev');
    const userId = await demoId();

    await agent
      .post(`/user-access/people/${userId}`)
      .send({ apps: { komga: { enabled: true } } })
      .expect(200);
    await agent
      .post(`/user-access/people/${userId}/apps/komga/create`)
      .expect(200);

    const reset = await agent
      .post(`/user-access/people/${userId}/apps/komga/password`)
      .expect(200);
    assert.equal(
      komga.users.find((u) => u.email === 'demo@seerr.dev')?.password,
      reset.body.password
    );

    const removed = await agent
      .delete(`/user-access/people/${userId}/apps/komga`)
      .expect(200);
    assert.equal(removed.body.apps.komga.status, 'none');
    assert.equal(removed.body.apps.komga.enabled, false);
    assert.equal(
      komga.users.some((u) => u.email === 'demo@seerr.dev'),
      false
    );
  });

  it('rejects changes that are not valid', async () => {
    const agent = await loginAs('admin@seerr.dev');
    const userId = await demoId();

    await agent
      .post(`/user-access/people/${userId}`)
      .send({ ageLimit: 'toddler' })
      .expect(400);
    await agent
      .post(`/user-access/people/${userId}`)
      .send({ apps: { plex: { enabled: true } } })
      .expect(400);
    await agent.post('/user-access/people/9999').send({}).expect(404);
  });
});

describe('linking existing app accounts', () => {
  const userIdOf = async (email: string) =>
    (await getRepository(User).findOneOrFail({ where: { email } })).id;

  beforeEach(() => {
    // Accounts made before Allseerr managed the apps, under other names
    abs.users.push({
      id: 'abs-family',
      username: 'DemoReader',
      email: null,
      type: 'user',
      isActive: true,
      permissions: {},
    });
    kavita.members.push({
      id: 7,
      username: 'demoreads',
      email: 'old@example.com',
      isPending: false,
      roles: ['Login', 'Pleb'],
      libraries: [{ id: 2, name: 'Manga' }],
      ageRestriction: { ageRating: -1, includeUnknowns: true },
      identityProvider: 0,
    });
  });

  it('lists the accounts with a likely owner, linking nothing', async () => {
    const agent = await loginAs('admin@seerr.dev');

    const res = await agent
      .get('/user-access/apps/audiobookshelf/accounts')
      .expect(200);

    const family = res.body.accounts.find(
      (a: { id: string }) => a.id === 'abs-family'
    );
    assert.equal(family.linkedUserId, null);
    // demo is inside DemoReader
    assert.equal(family.suggestedUserId, await userIdOf('demo@seerr.dev'));
    const root = res.body.accounts.find((a: { id: string }) => a.id === 'root');
    assert.equal(root.isAdmin, true);
    assert.equal(
      (await getRepository(UserAppAccount).count()) === 0,
      true,
      'listing links nothing'
    );
  });

  it('links an account under another name and keeps it linked through the sync', async () => {
    const agent = await loginAs('admin@seerr.dev');
    const userId = await userIdOf('demo@seerr.dev');

    const res = await agent
      .post(`/user-access/people/${userId}/apps/audiobookshelf/link`)
      .send({ remoteUserId: 'abs-family' })
      .expect(200);

    assert.equal(res.body.person.apps.audiobookshelf.status, 'active');
    assert.equal(res.body.person.apps.audiobookshelf.enabled, true);
    // Renamed to the Plex username right away
    assert.equal(res.body.person.apps.audiobookshelf.remoteUsername, 'demo');
    const family = abs.users.find((u) => u.id === 'abs-family');
    // The password stays the person's own; the email is set for tidiness
    assert.equal(family?.password, undefined);
    assert.equal(family?.email, 'demo@seerr.dev');
    const saved = await getRepository(UserAppAccount).findOneOrFail({
      where: { app: 'audiobookshelf' },
    });
    assert.equal(saved.madeByAllseerr, false);

    // The scheduled sync finds the account by its id, not its name
    await syncEveryone();
    const synced = await getRepository(UserAppAccount).findOneOrFail({
      where: { app: 'audiobookshelf' },
    });
    assert.equal(synced.remoteUserId, 'abs-family');
    assert.equal(synced.status, 'active');
    assert.equal(abs.users.length, 2, 'no second account was made');

    const listed = await agent
      .get('/user-access/apps/audiobookshelf/accounts')
      .expect(200);
    assert.equal(
      listed.body.accounts.find((a: { id: string }) => a.id === 'abs-family')
        .linkedUserId,
      userId
    );
  });

  it('keeps what a linked account can see and whether it may download', async () => {
    const family = abs.users.find((u) => u.id === 'abs-family');
    if (family) {
      family.permissions = {
        download: false,
        accessAllLibraries: false,
        librariesAccessible: ['lib-audio'],
      };
    }
    const agent = await loginAs('admin@seerr.dev');
    const userId = await userIdOf('demo@seerr.dev');

    const res = await agent
      .post(`/user-access/people/${userId}/apps/audiobookshelf/link`)
      .send({ remoteUserId: 'abs-family' })
      .expect(200);
    await agent
      .post(`/user-access/people/${userId}/apps/kavita/link`)
      .send({ remoteUserId: '7' })
      .expect(200);

    assert.deepEqual(res.body.person.apps.audiobookshelf.libraryIds, [
      'lib-audio',
    ]);
    const saved = await getRepository(UserAppAccount).findOneOrFail({
      where: { app: 'audiobookshelf' },
    });
    assert.equal(saved.canDownload, false);
    // The sync that followed the link changed nothing they can do
    const permissions = abs.users.find((u) => u.id === 'abs-family')
      ?.permissions as Record<string, unknown>;
    assert.equal(permissions.download, false);
    assert.equal(permissions.accessAllLibraries, false);
    assert.deepEqual(permissions.librariesAccessible, ['lib-audio']);

    const kavitaAccount = await getRepository(UserAppAccount).findOneOrFail({
      where: { app: 'kavita' },
    });
    assert.deepEqual(kavitaAccount.libraryIds, ['2']);
    assert.deepEqual(
      kavita.members.find((m) => m.id === 7)?.libraries.map((l) => l.id),
      [2]
    );
  });

  it('refuses an account linked to someone else', async () => {
    const agent = await loginAs('admin@seerr.dev');

    await agent
      .post(
        `/user-access/people/${await userIdOf('demo@seerr.dev')}/apps/audiobookshelf/link`
      )
      .send({ remoteUserId: 'abs-family' })
      .expect(200);
    const res = await agent
      .post(
        `/user-access/people/${await userIdOf('admin@seerr.dev')}/apps/audiobookshelf/link`
      )
      .send({ remoteUserId: 'abs-family' });

    assert.equal(res.status, 409);
    await agent
      .post(
        `/user-access/people/${await userIdOf('admin@seerr.dev')}/apps/audiobookshelf/link`
      )
      .send({ remoteUserId: 'nobody' })
      .expect(404);
    await agent
      .post(
        `/user-access/people/${await userIdOf('admin@seerr.dev')}/apps/audiobookshelf/link`
      )
      .send({})
      .expect(400);
  });

  it("gives a linked Kavita account the person's email, which its sign in links by", async () => {
    const agent = await loginAs('admin@seerr.dev');

    const res = await agent
      .post(
        `/user-access/people/${await userIdOf('demo@seerr.dev')}/apps/kavita/link`
      )
      .send({ remoteUserId: '7' })
      .expect(200);

    assert.equal(res.body.warning, null);
    const member = kavita.members.find((m) => m.id === 7);
    assert.equal(member?.email, 'demo@seerr.dev');
    // Kavita's update sent the account's own roles back
    const emailUpdate = kavita.calls.find(
      (call) =>
        call.path === '/api/Account/update' &&
        (call.body as { userId?: number }).userId === 7 &&
        (call.body as { email?: string }).email === 'demo@seerr.dev'
    );
    assert.deepEqual((emailUpdate?.body as { roles: string[] }).roles, [
      'Login',
      'Pleb',
    ]);
  });

  it("warns when Kavita keeps the admin key owner's email", async () => {
    const agent = await loginAs('admin@seerr.dev');
    // The key's own account is taken for Allseerr's until marked a person's
    await agent
      .post(
        `/user-access/people/${await userIdOf('admin@seerr.dev')}/apps/kavita/link`
      )
      .send({ remoteUserId: '1' })
      .expect(400);
    await agent
      .post('/user-access/apps/kavita/accounts/1/service')
      .send({ service: false })
      .expect(200);

    const res = await agent
      .post(
        `/user-access/people/${await userIdOf('admin@seerr.dev')}/apps/kavita/link`
      )
      .send({ remoteUserId: '1' })
      .expect(200);

    assert.match(res.body.warning, /kept the old email/);
    assert.equal(kavita.members[0].email, 'admin@example.com');
    assert.equal(res.body.person.apps.kavita.status, 'active');
  });

  it('unlinks without touching the account in the app', async () => {
    const agent = await loginAs('admin@seerr.dev');
    const userId = await userIdOf('demo@seerr.dev');

    await agent
      .post(`/user-access/people/${userId}/apps/kavita/link`)
      .send({ remoteUserId: '7' })
      .expect(200);
    const res = await agent
      .post(`/user-access/people/${userId}/apps/kavita/unlink`)
      .expect(200);

    assert.equal(res.body.apps.kavita.status, 'none');
    assert.equal(res.body.apps.kavita.enabled, false);
    assert.ok(kavita.members.some((m) => m.id === 7));

    await syncEveryone();
    const account = await getRepository(UserAppAccount).findOneOrFail({
      where: { app: 'kavita' },
    });
    assert.equal(account.remoteUserId, null);
  });
});

describe('accountMatchScore', () => {
  const person = new User({
    id: 9,
    username: 'dcuellar44',
    plexUsername: 'dcuellar44',
    email: 'dan@example.com',
  });

  it('ranks the same email over the same username over a name inside another', () => {
    assert.equal(
      accountMatchScore(person, { username: 'x', email: 'DAN@example.com' }),
      3
    );
    assert.equal(
      accountMatchScore(person, { username: 'DCuellar44', email: null }),
      2
    );
    assert.equal(
      accountMatchScore(person, { username: 'dcuellar', email: null }),
      1
    );
    assert.equal(
      accountMatchScore(person, { username: 'cue', email: null }),
      0,
      'short names are not matched inside others'
    );
    assert.equal(
      accountMatchScore(new User({ id: 10, email: 'kid@allseerr.invalid' }), {
        username: 'x',
        email: 'kid@allseerr.invalid',
      }),
      0
    );
  });
});

describe('app usernames that match Plex', () => {
  const userIdOf = async (email: string) =>
    (await getRepository(User).findOneOrFail({ where: { email } })).id;
  const renameNotices = () =>
    notifications.mock.calls.filter(
      (call) => call.arguments[0] === Notification.APP_USERNAME_CHANGED
    );

  beforeEach(() => {
    notifications.mock.resetCalls();
    abs.users.push(
      {
        id: 'abs-old',
        username: 'DReader',
        email: null,
        type: 'user',
        isActive: true,
        permissions: {},
      },
      {
        id: 'abs-service',
        username: 'Talearr',
        email: null,
        type: 'admin',
        isActive: true,
        permissions: {},
      }
    );
  });

  it('renames a linked account to the Plex username and tells the person once', async () => {
    const agent = await loginAs('admin@seerr.dev');
    const userId = await userIdOf('demo@seerr.dev');

    const res = await agent
      .post(`/user-access/people/${userId}/apps/audiobookshelf/link`)
      .send({ remoteUserId: 'abs-old' })
      .expect(200);

    assert.equal(res.body.warning, null);
    assert.equal(abs.users.find((u) => u.id === 'abs-old')?.username, 'demo');
    // The password stays the person's own
    assert.equal(
      abs.users.find((u) => u.id === 'abs-old')?.password,
      undefined
    );
    const notices = renameNotices();
    assert.equal(notices.length, 1);
    const payload = notices[0].arguments[1] as {
      subject: string;
      message: string;
      notifyUser: User;
    };
    assert.equal(payload.subject, 'Your reading app username now matches Plex');
    assert.doesNotMatch(payload.message, /Audiobookshelf|Kavita/);
    assert.match(payload.message, /Your new username is demo\./);
    assert.equal(payload.notifyUser.id, userId);

    const renames = await agent.get('/user-access/renames').expect(200);
    assert.deepEqual(
      renames.body.map(
        (r: { app: string; from: string; to: string }) =>
          `${r.app} ${r.from} ${r.to}`
      ),
      ['audiobookshelf DReader demo']
    );

    // Nothing changed, so nothing is sent again
    await syncEveryone();
    assert.equal(renameNotices().length, 1);

    // A Plex rename is followed by the sync
    const user = await getRepository(User).findOneOrFail({
      where: { id: userId },
    });
    user.plexUsername = 'demo2';
    await getRepository(User).save(user);
    await syncEveryone();
    assert.equal(abs.users.find((u) => u.id === 'abs-old')?.username, 'demo2');
    assert.equal(renameNotices().length, 2);
    const account = await getRepository(UserAppAccount).findOneOrFail({
      where: { app: 'audiobookshelf' },
    });
    assert.equal(account.remoteUsername, 'demo2');
    assert.equal(account.remoteUserId, 'abs-old');
  });

  it('sends one message naming NoBookEnds for renames in two apps', async (t) => {
    const settings = getSettings();
    settings.nobookendsSync = { enabled: true };
    const mediaServerType = settings.main.mediaServerType;
    settings.main.mediaServerType = MediaServerType.PLEX;
    t.after(() => {
      settings.nobookendsSync = { enabled: false };
      settings.main.mediaServerType = mediaServerType;
    });
    kavita.members.push({
      id: 7,
      username: 'KReader',
      email: 'kreader@example.com',
      isPending: false,
      roles: ['Login'],
      libraries: [],
      ageRestriction: { ageRating: -1, includeUnknowns: true },
      identityProvider: 0,
    });
    const agent = await loginAs('admin@seerr.dev');
    const userId = await userIdOf('demo@seerr.dev');

    await agent
      .post(`/user-access/people/${userId}/apps/audiobookshelf/link`)
      .send({ remoteUserId: 'abs-old' })
      .expect(200);
    await agent
      .post(`/user-access/people/${userId}/apps/kavita/link`)
      .send({ remoteUserId: '7' })
      .expect(200);

    assert.equal(kavita.members.find((m) => m.id === 7)?.username, 'demo');
    const notices = renameNotices();
    assert.equal(notices.length, 1);
    const payload = notices[0].arguments[1] as {
      subject: string;
      message: string;
    };
    assert.equal(payload.subject, 'Your NoBookEnds username now matches Plex');
    assert.match(payload.message, /tap Sign in with Plex\./);
    assert.doesNotMatch(payload.message, /Audiobookshelf|Kavita/);
  });

  it('keeps the name when another account has it, and says so', async () => {
    abs.users.push({
      id: 'abs-other',
      username: 'Demo',
      email: null,
      type: 'user',
      isActive: true,
      permissions: {},
    });
    const agent = await loginAs('admin@seerr.dev');

    const res = await agent
      .post(
        `/user-access/people/${await userIdOf('demo@seerr.dev')}/apps/audiobookshelf/link`
      )
      .send({ remoteUserId: 'abs-old' })
      .expect(200);

    assert.match(res.body.warning, /already has an account named Demo/);
    assert.equal(
      abs.users.find((u) => u.id === 'abs-old')?.username,
      'DReader'
    );
    assert.equal(renameNotices().length, 0);
  });

  it('renames nothing while the setting is off', async () => {
    const agent = await loginAs('admin@seerr.dev');
    await agent
      .post('/settings/user-access')
      .send({ matchPlexUsernames: false })
      .expect(200);

    await agent
      .post(
        `/user-access/people/${await userIdOf('demo@seerr.dev')}/apps/audiobookshelf/link`
      )
      .send({ remoteUserId: 'abs-old' })
      .expect(200);

    assert.equal(
      abs.users.find((u) => u.id === 'abs-old')?.username,
      'DReader'
    );
    assert.equal(renameNotices().length, 0);
    const settings = await agent.get('/settings/user-access').expect(200);
    assert.equal(settings.body.matchPlexUsernames, false);
  });

  it('never suggests, links or renames service accounts', async () => {
    const agent = await loginAs('admin@seerr.dev');

    const list = await agent
      .get('/user-access/apps/audiobookshelf/accounts')
      .expect(200);
    const byId = (id: string) =>
      list.body.accounts.find((a: { id: string }) => a.id === id);
    assert.equal(byId('abs-service').service, 'name');
    assert.equal(byId('abs-service').suggestedUserId, null);
    // The account the connection's key belongs to
    assert.equal(byId('root').service, 'connection');
    assert.equal(byId('abs-old').service, null);

    await agent
      .post(
        `/user-access/people/${await userIdOf('demo@seerr.dev')}/apps/audiobookshelf/link`
      )
      .send({ remoteUserId: 'abs-service' })
      .expect(400);

    // An admin can mark any account as a service
    const marked = await agent
      .post('/user-access/apps/audiobookshelf/accounts/abs-old/service')
      .send({ service: true })
      .expect(200);
    assert.equal(
      marked.body.accounts.find((a: { id: string }) => a.id === 'abs-old')
        .service,
      'marked'
    );
    await agent
      .post(
        `/user-access/people/${await userIdOf('demo@seerr.dev')}/apps/audiobookshelf/link`
      )
      .send({ remoteUserId: 'abs-old' })
      .expect(400);
  });

  it("leaves app admin accounts alone unless they are an Allseerr admin's own", async () => {
    abs.users.push({
      id: 'abs-admin',
      username: 'helper',
      email: null,
      type: 'admin',
      isActive: true,
      permissions: {},
    });
    const agent = await loginAs('admin@seerr.dev');

    await agent
      .post(
        `/user-access/people/${await userIdOf('demo@seerr.dev')}/apps/audiobookshelf/link`
      )
      .send({ remoteUserId: 'abs-admin' })
      .expect(200);
    assert.equal(
      abs.users.find((u) => u.id === 'abs-admin')?.username,
      'helper'
    );

    // The root account is the key's, marked as the Allseerr admin's own
    await agent
      .post('/user-access/apps/audiobookshelf/accounts/root/service')
      .send({ service: false })
      .expect(200);
    await agent
      .post(
        `/user-access/people/${await userIdOf('admin@seerr.dev')}/apps/audiobookshelf/link`
      )
      .send({ remoteUserId: 'root' })
      .expect(200);
    assert.equal(abs.users.find((u) => u.id === 'root')?.username, 'admin');
  });

  it('keeps the connection signing in after its own account is renamed', async (t) => {
    const owner = kavita.members[0];
    const original = { ...owner };
    t.after(() => Object.assign(owner, original));
    owner.username = 'oldname';
    owner.password = 'owner-pass';
    owner.roles = ['Admin', 'Login'];
    const settings = getSettings();
    settings.userAccess = {
      ...settings.userAccess,
      kavita: { url: kavita.url, username: 'oldname', password: 'owner-pass' },
    };
    const agent = await loginAs('admin@seerr.dev');

    await agent
      .post(`/user-access/apps/kavita/accounts/${owner.id}/service`)
      .send({ service: false })
      .expect(200);
    await agent
      .post(
        `/user-access/people/${await userIdOf('admin@seerr.dev')}/apps/kavita/link`
      )
      .send({ remoteUserId: String(owner.id) })
      .expect(200);

    assert.equal(owner.username, 'admin');
    assert.equal(getSettings().userAccess.kavita.username, 'admin');
    await agent.get('/user-access/apps/kavita/accounts').expect(200);
  });

  it('leaves Komga, which signs people in by email, alone', async () => {
    komga.users.push({
      id: 'komga-old',
      email: 'reader@example.com',
      roles: ['PAGE_STREAMING'],
      sharedAllLibraries: true,
      sharedLibrariesIds: [],
    });
    const agent = await loginAs('admin@seerr.dev');

    await agent
      .post(
        `/user-access/people/${await userIdOf('demo@seerr.dev')}/apps/komga/link`
      )
      .send({ remoteUserId: 'komga-old' })
      .expect(200);

    assert.equal(
      komga.users.find((u) => u.id === 'komga-old')?.email,
      'reader@example.com'
    );
    assert.equal(renameNotices().length, 0);
  });
});
