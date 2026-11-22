import assert from 'node:assert/strict';
import { before, beforeEach, describe, it, mock } from 'node:test';

import JellyfinAPI from '@server/api/jellyfin';
import { MediaServerType } from '@server/constants/server';
import { UserType } from '@server/constants/user';
import { getRepository } from '@server/datasource';
import { NoBookEndsDevice } from '@server/entity/NoBookEndsDevice';
import { User } from '@server/entity/User';
import { Permission } from '@server/lib/permissions';
import { getSettings } from '@server/lib/settings';
import { checkUser, isAuthenticated } from '@server/middleware/auth';
import authRoutes from '@server/routes/auth';
import { setupTestDb } from '@server/test/db';
import { permissionsOf, seedManagerAndAdmin } from '@server/test/users';
import type { Express } from 'express';
import express from 'express';
import session from 'express-session';
import request from 'supertest';
import userRoutes from '.';

const defaultAuthenticateResponse = {
  User: {
    Id: 'jf-link-user-001',
    Name: 'linkeduser',
    ServerId: 'server-1',
    Policy: { IsAdministrator: false },
  },
  AccessToken: 'fake-qc-access-token',
};

const authenticateQCMock = mock.method(
  JellyfinAPI.prototype,
  'authenticateQuickConnect',
  async () => ({ ...defaultAuthenticateResponse })
);

let app: Express;

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

function configureJellyfin() {
  const settings = getSettings();
  settings.main.mediaServerType = MediaServerType.JELLYFIN;
  settings.jellyfin.ip = 'localhost';
  settings.jellyfin.port = 8096;
  settings.jellyfin.useSsl = false;
  settings.jellyfin.urlBase = '';
}

async function loginAs(email: string, password: string) {
  const settings = getSettings();
  settings.main.localLogin = true;

  const agent = request.agent(app);
  const res = await agent.post('/auth/local').send({ email, password });

  assert.strictEqual(res.status, 200);
  return { agent, userId: res.body.id as number };
}

describe('POST /user/:id/settings/linked-accounts/jellyfin/quickconnect', () => {
  beforeEach(() => {
    authenticateQCMock.mock.resetCalls();
    authenticateQCMock.mock.mockImplementation(async () => ({
      ...defaultAuthenticateResponse,
    }));
    configureJellyfin();
  });

  it('links the account when the media server is Jellyfin', async () => {
    const { agent, userId } = await loginAs('demo@seerr.dev', 'test1234');

    const res = await agent
      .post(`/user/${userId}/settings/linked-accounts/jellyfin/quickconnect`)
      .send({ secret: 'abc123def456abc123def456' });

    assert.strictEqual(res.status, 204);
    assert.strictEqual(authenticateQCMock.mock.callCount(), 1);

    const user = await getRepository(User).findOneOrFail({
      where: { id: userId },
    });
    assert.strictEqual(user.jellyfinUserId, 'jf-link-user-001');
    assert.strictEqual(user.userType, UserType.JELLYFIN);
  });

  it('returns 403 when the media server is Emby', async () => {
    const { agent, userId } = await loginAs('demo@seerr.dev', 'test1234');
    getSettings().main.mediaServerType = MediaServerType.EMBY;

    const res = await agent
      .post(`/user/${userId}/settings/linked-accounts/jellyfin/quickconnect`)
      .send({ secret: 'abc123def456abc123def456' });

    assert.strictEqual(res.status, 403);
    assert.strictEqual(authenticateQCMock.mock.callCount(), 0);

    const user = await getRepository(User).findOneOrFail({
      where: { id: userId },
    });
    assert.strictEqual(user.jellyfinUserId, null);
  });
});

describe('personal API keys', () => {
  it('generates a key that authenticates as its owner', async () => {
    const { agent, userId } = await loginAs('demo@seerr.dev', 'test1234');

    const created = await agent.post(`/user/${userId}/settings/api-key`);
    assert.strictEqual(created.status, 201);
    assert.match(created.body.apiKey, /^asu_/);

    const status = await agent.get(`/user/${userId}/settings/api-key`);
    assert.strictEqual(status.body.hasApiKey, true);
    assert.strictEqual(status.body.apiKey, undefined);

    const me = await request(app)
      .get(`/user/${userId}`)
      .set('X-API-Key', created.body.apiKey)
      .set('X-API-User', '1');
    assert.strictEqual(me.status, 200);
    assert.strictEqual(me.body.id, userId);
  });

  it('stores only a hash of the key', async () => {
    const { agent, userId } = await loginAs('demo@seerr.dev', 'test1234');
    const created = await agent.post(`/user/${userId}/settings/api-key`);

    const stored = await getRepository(User).findOneOrFail({
      where: { id: userId },
      select: ['id', 'apiKeyHash'],
    });
    assert.ok(stored.apiKeyHash);
    assert.notStrictEqual(stored.apiKeyHash, created.body.apiKey);
  });

  it('rejects a revoked or replaced key', async () => {
    const { agent, userId } = await loginAs('demo@seerr.dev', 'test1234');
    const first = await agent.post(`/user/${userId}/settings/api-key`);
    await agent.post(`/user/${userId}/settings/api-key`);

    const replaced = await request(app)
      .get(`/user/${userId}`)
      .set('X-API-Key', first.body.apiKey);
    assert.strictEqual(replaced.status, 403);

    const second = await agent.post(`/user/${userId}/settings/api-key`);
    const revoke = await agent.delete(`/user/${userId}/settings/api-key`);
    assert.strictEqual(revoke.status, 204);

    const revoked = await request(app)
      .get(`/user/${userId}`)
      .set('X-API-Key', second.body.apiKey);
    assert.strictEqual(revoked.status, 403);
  });

  it("does not let an admin create another user's key", async () => {
    const { userId } = await loginAs('demo@seerr.dev', 'test1234');
    const { agent: admin } = await loginAs('admin@seerr.dev', 'test1234');

    const res = await admin.post(`/user/${userId}/settings/api-key`);
    assert.strictEqual(res.status, 403);
  });

  it("does not let a user read another user's key status", async () => {
    const { agent } = await loginAs('demo@seerr.dev', 'test1234');

    const res = await agent.get('/user/1/settings/api-key');
    assert.strictEqual(res.status, 403);
  });
});

describe('content rating limits', () => {
  it('lets an admin set the rating limits of a user', async () => {
    const { userId } = await loginAs('demo@seerr.dev', 'test1234');
    const { agent: admin } = await loginAs('admin@seerr.dev', 'test1234');

    const res = await admin.post(`/user/${userId}/settings/main`).send({
      username: 'demo',
      movieRatingLimit: 'PG-13',
      tvRatingLimit: 'not-a-rating',
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.movieRatingLimit, 'PG-13');
    assert.strictEqual(res.body.tvRatingLimit, null);

    const settings = await admin.get(`/user/${userId}/settings/main`);
    assert.strictEqual(settings.body.movieRatingLimit, 'PG-13');
  });

  it('does not let a user change their own rating limits', async () => {
    const { agent, userId } = await loginAs('demo@seerr.dev', 'test1234');
    const userRepo = getRepository(User);
    const user = await userRepo.findOneOrFail({ where: { id: userId } });
    user.movieRatingLimit = 'PG';
    await userRepo.save(user);

    const res = await agent.post(`/user/${userId}/settings/main`).send({
      username: 'demo',
      movieRatingLimit: null,
      tvRatingLimit: 'TV-MA',
    });
    assert.strictEqual(res.status, 200);

    const stored = await userRepo.findOneOrFail({ where: { id: userId } });
    assert.strictEqual(stored.movieRatingLimit, 'PG');
    assert.strictEqual(stored.tvRatingLimit, null);
  });
});

describe('blocked genres', () => {
  it("lets an admin give a user their own list and go back to the server's", async () => {
    const { userId } = await loginAs('demo@seerr.dev', 'test1234');
    const { agent: admin } = await loginAs('admin@seerr.dev', 'test1234');

    const res = await admin.post(`/user/${userId}/settings/main`).send({
      username: 'demo',
      blockedGenres: { movie: '27', tv: '', music: 'Christmas', book: '' },
    });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.blockedGenres, {
      movie: '27',
      tv: '',
      music: 'christmas',
      book: '',
    });

    const cleared = await admin
      .post(`/user/${userId}/settings/main`)
      .send({ username: 'demo', blockedGenres: null });
    assert.strictEqual(cleared.body.blockedGenres, null);
  });

  it('does not let a user change their own list', async () => {
    const { agent, userId } = await loginAs('demo@seerr.dev', 'test1234');

    await agent.post(`/user/${userId}/settings/main`).send({
      username: 'demo',
      blockedGenres: { movie: '27', tv: '', music: '', book: '' },
    });

    const stored = await getRepository(User).findOneOrFail({
      where: { id: userId },
    });
    assert.strictEqual(stored.blockedGenres ?? null, null);
  });
});

describe('advanced request options', () => {
  it('lets an admin narrow and widen the options of a user', async () => {
    const { userId } = await loginAs('demo@seerr.dev', 'test1234');
    const { agent: admin } = await loginAs('admin@seerr.dev', 'test1234');
    const permissions = Permission.REQUEST | Permission.REQUEST_ADVANCED;

    const narrowed = await admin
      .post(`/user/${userId}/settings/permissions`)
      .send({ permissions, advancedRequestOptions: 2 });
    assert.strictEqual(narrowed.status, 200);
    assert.strictEqual(narrowed.body.advancedRequestOptions, 2);

    const kept = await admin
      .post(`/user/${userId}/settings/permissions`)
      .send({ permissions });
    assert.strictEqual(kept.body.advancedRequestOptions, 2);

    const widened = await admin
      .post(`/user/${userId}/settings/permissions`)
      .send({ permissions, advancedRequestOptions: 15 });
    assert.strictEqual(widened.body.advancedRequestOptions, null);
  });
});

describe('book language', () => {
  it('lets a user pick their book language and go back to the default', async () => {
    const { agent, userId } = await loginAs('demo@seerr.dev', 'test1234');

    const saved = await agent
      .post(`/user/${userId}/settings/main`)
      .send({ username: 'demo', bookLanguage: 'es' });
    assert.strictEqual(saved.status, 200);
    assert.strictEqual(saved.body.bookLanguage, 'es');

    const settings = await agent.get(`/user/${userId}/settings/main`);
    assert.strictEqual(settings.body.bookLanguage, 'es');

    const me = await agent.get('/auth/me');
    assert.strictEqual(me.body.settings.bookLanguage, 'es');

    const cleared = await agent
      .post(`/user/${userId}/settings/main`)
      .send({ username: 'demo', bookLanguage: null });
    assert.strictEqual(cleared.body.bookLanguage, null);
  });

  it('refuses an unknown book language', async () => {
    const { agent, userId } = await loginAs('demo@seerr.dev', 'test1234');

    const res = await agent
      .post(`/user/${userId}/settings/main`)
      .send({ username: 'demo', bookLanguage: 'xx' });
    assert.strictEqual(res.status, 400);
  });
});

describe('guided tour', () => {
  it('stores the seen tour version and returns it from /auth/me', async () => {
    const { agent, userId } = await loginAs('demo@seerr.dev', 'test1234');

    const before = await agent.get('/auth/me');
    assert.strictEqual(before.body.settings?.tourVersion ?? null, null);

    const res = await agent
      .post(`/user/${userId}/settings/tour`)
      .send({ version: 1 });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.tourVersion, 1);

    const after = await agent.get('/auth/me');
    assert.strictEqual(after.body.settings.tourVersion, 1);
  });

  it('refuses an invalid version', async () => {
    const { agent, userId } = await loginAs('demo@seerr.dev', 'test1234');

    const res = await agent
      .post(`/user/${userId}/settings/tour`)
      .send({ version: 'soon' });
    assert.strictEqual(res.status, 400);
  });

  it("does not let another user mark someone's tour", async () => {
    const { userId } = await loginAs('demo@seerr.dev', 'test1234');
    const { agent: admin } = await loginAs('admin@seerr.dev', 'test1234');

    const res = await admin
      .post(`/user/${userId}/settings/tour`)
      .send({ version: 1 });
    assert.strictEqual(res.status, 403);
  });
});

describe('POST /user/:id/settings/permissions', () => {
  it('stops a manager from removing admin from another admin', async () => {
    const { otherAdmin } = await seedManagerAndAdmin();
    const { agent } = await loginAs('demo@seerr.dev', 'test1234');

    const res = await agent
      .post(`/user/${otherAdmin.id}/settings/permissions`)
      .send({ permissions: Permission.REQUEST });

    assert.strictEqual(res.status, 403);
    assert.strictEqual(await permissionsOf(otherAdmin.id), Permission.ADMIN);
  });
});

describe('POST /user/:id/settings/main', () => {
  it("stops a manager from changing an admin's email", async () => {
    const { otherAdmin } = await seedManagerAndAdmin();
    const { agent } = await loginAs('demo@seerr.dev', 'test1234');

    const res = await agent
      .post(`/user/${otherAdmin.id}/settings/main`)
      .send({ username: 'admin2', email: 'new@example.com' });

    assert.strictEqual(res.status, 403);
    const user = await getRepository(User).findOneOrFail({
      where: { id: otherAdmin.id },
    });
    assert.strictEqual(user.email, 'admin2@seerr.dev');
  });

  it("lets the owner change an admin's email", async () => {
    const { otherAdmin } = await seedManagerAndAdmin();
    const { agent } = await loginAs('admin@seerr.dev', 'test1234');

    const res = await agent
      .post(`/user/${otherAdmin.id}/settings/main`)
      .send({ username: 'admin2', email: 'new@example.com' });

    assert.strictEqual(res.status, 200);
    const user = await getRepository(User).findOneOrFail({
      where: { id: otherAdmin.id },
    });
    assert.strictEqual(user.email, 'new@example.com');
  });
});

describe('POST /user/:id/settings/password', () => {
  async function passwordUnchanged(userId: number) {
    const user = await getRepository(User).findOneOrFail({
      select: ['id', 'password'],
      where: { id: userId },
    });
    return user.passwordMatch('test1234');
  }

  it('rejects a wrong current password', async () => {
    const { agent, userId } = await loginAs('demo@seerr.dev', 'test1234');

    const res = await agent
      .post(`/user/${userId}/settings/password`)
      .send({ currentPassword: 'wrong-password', newPassword: 'new-password' });

    assert.strictEqual(res.status, 403);
    assert.ok(await passwordUnchanged(userId));
  });

  it('rejects a missing current password', async () => {
    const { agent, userId } = await loginAs('demo@seerr.dev', 'test1234');

    const res = await agent
      .post(`/user/${userId}/settings/password`)
      .send({ newPassword: 'new-password' });

    assert.strictEqual(res.status, 403);
    assert.ok(await passwordUnchanged(userId));
  });

  it('stops a manager from demoting an admin to reset their password', async () => {
    const { otherAdmin } = await seedManagerAndAdmin();
    const { agent } = await loginAs('demo@seerr.dev', 'test1234');

    const demote = await agent
      .post(`/user/${otherAdmin.id}/settings/permissions`)
      .send({ permissions: Permission.REQUEST });
    const reset = await agent
      .post(`/user/${otherAdmin.id}/settings/password`)
      .send({ newPassword: 'takeover1234' });

    assert.strictEqual(demote.status, 403);
    assert.strictEqual(reset.status, 403);
    const user = await getRepository(User).findOneOrFail({
      select: ['id', 'password'],
      where: { id: otherAdmin.id },
    });
    assert.ok(!user.password);
  });

  it('lets the owner demote an admin and reset their password', async () => {
    const { otherAdmin } = await seedManagerAndAdmin();
    const { agent } = await loginAs('admin@seerr.dev', 'test1234');

    const demote = await agent
      .post(`/user/${otherAdmin.id}/settings/permissions`)
      .send({ permissions: Permission.REQUEST });
    const reset = await agent
      .post(`/user/${otherAdmin.id}/settings/password`)
      .send({ newPassword: 'reset12345' });

    assert.strictEqual(demote.status, 200);
    assert.strictEqual(reset.status, 204);
    const user = await getRepository(User).findOneOrFail({
      select: ['id', 'password'],
      where: { id: otherAdmin.id },
    });
    assert.ok(await user.passwordMatch('reset12345'));
  });
});

describe("a manager and another admin's Allseerr settings", () => {
  it("stops a manager from revoking an admin's keys or devices", async () => {
    const { otherAdmin } = await seedManagerAndAdmin();
    const device = await getRepository(NoBookEndsDevice).save(
      new NoBookEndsDevice({ user: otherAdmin, keyHash: 'test-device-hash' })
    );
    const { agent } = await loginAs('demo@seerr.dev', 'test1234');

    const apiKey = await agent.delete(
      `/user/${otherAdmin.id}/settings/api-key`
    );
    const nobookends = await agent.delete(
      `/user/${otherAdmin.id}/settings/nobookends`
    );
    const oneDevice = await agent.delete(
      `/user/${otherAdmin.id}/settings/nobookends/devices/${device.id}`
    );

    assert.strictEqual(apiKey.status, 403);
    assert.strictEqual(nobookends.status, 403);
    assert.strictEqual(oneDevice.status, 403);
    assert.ok(
      await getRepository(NoBookEndsDevice).findOne({
        where: { id: device.id },
      })
    );
  });

  it("stops a manager from making an admin's reading app passwords", async () => {
    const { otherAdmin } = await seedManagerAndAdmin();
    const { agent } = await loginAs('demo@seerr.dev', 'test1234');

    const setup = await agent.post(
      `/user/${otherAdmin.id}/settings/apps/kavita/setup`
    );
    const password = await agent.post(
      `/user/${otherAdmin.id}/settings/apps/kavita/password`
    );

    assert.strictEqual(setup.status, 403);
    assert.strictEqual(password.status, 403);
  });

  it("still lets a manager revoke a regular user's devices", async () => {
    await seedManagerAndAdmin();
    const regular = await getRepository(User).save(
      new User({
        email: 'regular@seerr.dev',
        username: 'regular',
        permissions: Permission.REQUEST,
        userType: UserType.LOCAL,
        avatar: '',
      })
    );
    const { agent } = await loginAs('demo@seerr.dev', 'test1234');

    const res = await agent.delete(`/user/${regular.id}/settings/nobookends`);
    assert.strictEqual(res.status, 204);
  });
});
