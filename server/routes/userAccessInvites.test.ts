import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it, mock } from 'node:test';

import PlexTvAPI from '@server/api/plextv';
import { MediaServerType } from '@server/constants/server';
import { getRepository } from '@server/datasource';
import { AccessInvite } from '@server/entity/AccessInvite';
import { User } from '@server/entity/User';
import { UserAccessProfile } from '@server/entity/UserAccessProfile';
import { Permission } from '@server/lib/permissions';
import { defaultPlexDefaultAccess, getSettings } from '@server/lib/settings';
import { checkUser, isAuthenticated } from '@server/middleware/auth';
import authRoutes from '@server/routes/auth';
import userAccessRoutes from '@server/routes/userAccess';
import { setupTestDb } from '@server/test/db';
import { startFakeKavita } from '@server/test/fakeApps';
import type { Express } from 'express';
import express from 'express';
import session from 'express-session';
import request from 'supertest';

let app: Express;
let kavita: Awaited<ReturnType<typeof startFakeKavita>>;

// A Plex account that is not shared the Plex server
const stranger = {
  id: 4242,
  email: 'niece@example.com',
  username: 'niece',
  thumb: 'https://plex.tv/users/niece/avatar',
  authToken: 'plex-token-niece',
};

mock.method(PlexTvAPI.prototype, 'getUser', async () => stranger);
const checkAccess = mock.method(
  PlexTvAPI.prototype,
  'checkUserAccess',
  async () => false
);

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(
    session({ secret: 'test-secret', resave: false, saveUninitialized: false })
  );
  app.use(checkUser);
  app.use('/auth', authRoutes);
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
  kavita = await startFakeKavita('kavita-key');
});

after(() => kavita.close());

setupTestDb();

beforeEach(() => {
  kavita.members.splice(1);
  checkAccess.mock.resetCalls();
  const settings = getSettings();
  settings.main.mediaServerType = MediaServerType.PLEX;
  settings.main.mediaServerLogin = true;
  settings.main.newPlexLogin = false;
  settings.main.applicationUrl = 'https://allseerr.example.com';
  settings.notifications.agents.email.enabled = false;
  settings.userAccess = {
    audiobookshelf: {},
    kavita: { url: kavita.url, apiKey: 'kavita-key' },
    komga: {},
    grimmory: {},
    emailPasswords: true,
    oidc: { enabled: false, clients: [] },
    plexDefault: defaultPlexDefaultAccess(),
  };
});

async function loginAs(email: string, password = 'test1234') {
  const agent = request.agent(app);
  await agent.post('/auth/local').send({ email, password }).expect(200);
  return agent;
}

const makeInvite = async (body: Record<string, unknown>) => {
  const admin = await loginAs('admin@seerr.dev');
  return admin.post('/user-access/invites').send(body);
};

describe('invite links', () => {
  it('makes a link that is only shown once', async () => {
    const res = await makeInvite({
      label: 'Niece',
      ageLimit: 'tween',
      apps: { kavita: { enabled: true, libraryIds: ['2'] } },
    });

    assert.equal(res.status, 201);
    assert.match(
      res.body.link,
      /^https:\/\/allseerr\.example\.com\/invite\/[\w-]{32}$/
    );
    assert.deepEqual(res.body.invite.apps, { kavita: { libraryIds: ['2'] } });

    const stored = await getRepository(AccessInvite)
      .createQueryBuilder('invite')
      .addSelect('invite.tokenHash')
      .getOneOrFail();
    assert.notEqual(stored.tokenHash, res.body.token);
    assert.equal(stored.tokenHash.length, 64);
  });

  it('needs at least one app', async () => {
    const res = await makeInvite({ apps: {} });
    assert.equal(res.status, 400);
  });

  it('describes itself without signing in', async () => {
    const { body } = await makeInvite({
      apps: { kavita: { enabled: true } },
    });

    const res = await request(app).get(`/auth/invite/${body.token}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.apps, [
      { app: 'kavita', name: 'Kavita', url: kavita.url },
    ]);

    await request(app).get('/auth/invite/not-a-real-invite-token').expect(404);
  });

  it('lets a Plex account without server access in and gives it the apps', async () => {
    const { body } = await makeInvite({
      ageLimit: 'kids',
      apps: { kavita: { enabled: true, libraryIds: ['2'] } },
    });

    // Without the invite the stranger is turned away
    await request(app)
      .post('/auth/plex')
      .send({ authToken: 'plex-token-niece' })
      .expect(403);

    const agent = request.agent(app);
    const signIn = await agent
      .post('/auth/plex')
      .send({ authToken: 'plex-token-niece', inviteToken: body.token })
      .expect(200);
    assert.ok(signIn.body.id);

    const redeemed = await agent
      .post(`/auth/invite/${body.token}/redeem`)
      .expect(200);
    assert.match(redeemed.body.passwords.kavita.password, /^[a-z2-9-]{19}$/);

    const member = kavita.members.find((m) => m.username === 'niece')!;
    assert.deepEqual(
      member.libraries.map((l) => l.name),
      ['Manga']
    );
    assert.equal(member.ageRestriction.includeUnknowns, false);

    const user = await getRepository(User).findOneOrFail({
      where: { email: 'niece@example.com' },
    });
    const profile = await getRepository(UserAccessProfile).findOneOrFail({
      where: { user: { id: user.id } },
    });
    assert.equal(profile.ageLimit, 'kids');

    // The link is used up, but the person keeps signing in with Plex
    await agent.post(`/auth/invite/${body.token}/redeem`).expect(404);
    await request(app)
      .post('/auth/plex')
      .send({ authToken: 'plex-token-niece' })
      .expect(200);
    await request(app).get(`/auth/invite/${body.token}`).expect(404);
  });

  it('stops working once revoked', async () => {
    const { body } = await makeInvite({ apps: { kavita: { enabled: true } } });
    const admin = await loginAs('admin@seerr.dev');

    await admin.delete(`/user-access/invites/${body.invite.id}`).expect(204);
    await request(app)
      .post('/auth/plex')
      .send({ authToken: 'plex-token-niece', inviteToken: body.token })
      .expect(403);

    const list = await admin.get('/user-access/invites').expect(200);
    assert.ok(list.body[0].revokedAt);
  });

  it('is managed by people who may manage users only', async () => {
    const demo = await loginAs('demo@seerr.dev');
    await demo.get('/user-access/invites').expect(403);
    await demo
      .post('/user-access/invites')
      .send({ apps: { kavita: { enabled: true } } })
      .expect(403);
  });
});
