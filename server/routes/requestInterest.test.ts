import assert from 'node:assert/strict';
import { before, beforeEach, describe, it, mock } from 'node:test';

import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { UserType } from '@server/constants/user';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import MediaRequestInterest from '@server/entity/MediaRequestInterest';
import { User } from '@server/entity/User';
import notificationManager, { Notification } from '@server/lib/notifications';
import type { NotificationPayload } from '@server/lib/notifications/agents/agent';
import { Permission } from '@server/lib/permissions';
import { notifyInterestedUsers } from '@server/lib/requestInterest';
import { getSettings } from '@server/lib/settings';
import { checkUser } from '@server/middleware/auth';
import { setupTestDb } from '@server/test/db';
import type { Express } from 'express';
import express from 'express';
import session from 'express-session';
import request from 'supertest';
import authRoutes from './auth';
import requestRoutes from './request';

const sendMock = mock.method(
  notificationManager,
  'sendNotification',
  () => undefined
).mock;

mock.method(MediaRequest, 'sendNotification', async () => undefined);

// Same hash the seeded users use, for the password test1234
const PASSWORD_HASH =
  '$2b$12$Z5V2P5HZgmx4/AnWFMZN1.aD5AM1NucNi.mhNTSQ9oVtmdzu7Le/a';

let app: Express;

before(() => {
  app = express();
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
});

beforeEach(() => {
  sendMock.resetCalls();
});

setupTestDb();

const loginAs = async (email: string) => {
  const settings = getSettings();
  const prior = settings.main.localLogin;
  settings.main.localLogin = true;

  try {
    const agent = request.agent(app);
    const res = await agent
      .post('/auth/local')
      .send({ email, password: 'test1234' });
    assert.equal(res.status, 200);
    return agent;
  } finally {
    settings.main.localLogin = prior;
  }
};

const makeUser = (email: string, permissions: number) =>
  getRepository(User).save(
    new User({
      email,
      username: email.split('@')[0],
      userType: UserType.LOCAL,
      password: PASSWORD_HASH,
      permissions,
      avatar: '',
    })
  );

const seed = async (status = MediaRequestStatus.APPROVED) => {
  const admin = await getRepository(User).findOneOrFail({
    where: { email: 'admin@seerr.dev' },
  });
  const demo = await getRepository(User).findOneOrFail({
    where: { email: 'demo@seerr.dev' },
  });
  const friend = await makeUser('friend@seerr.dev', Permission.REQUEST);

  const media = await getRepository(Media).save(
    new Media({
      mediaType: MediaType.MOVIE,
      tmdbId: 4242,
      status: MediaStatus.PROCESSING,
      status4k: MediaStatus.UNKNOWN,
    })
  );

  const mediaRequest = await getRepository(MediaRequest).save(
    new MediaRequest({
      type: MediaType.MOVIE,
      status,
      media,
      requestedBy: demo,
      is4k: false,
    })
  );

  return { admin, demo, friend, media, mediaRequest };
};

describe('POST /request/:requestId/interest', () => {
  it('adds the user to an approved request of someone else', async () => {
    const { friend, mediaRequest } = await seed();
    const agent = await loginAs(friend.email);

    const res = await agent.post(`/request/${mediaRequest.id}/interest`);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, {
      requestId: mediaRequest.id,
      count: 1,
      interested: true,
    });
  });

  it('adds the user only once', async () => {
    const { friend, mediaRequest } = await seed(MediaRequestStatus.PENDING);
    const agent = await loginAs(friend.email);

    await agent.post(`/request/${mediaRequest.id}/interest`);
    const res = await agent.post(`/request/${mediaRequest.id}/interest`);

    assert.equal(res.status, 200);
    assert.equal(res.body.count, 1);
  });

  it('refuses the requester', async () => {
    const { mediaRequest } = await seed();
    const agent = await loginAs('demo@seerr.dev');

    const res = await agent.post(`/request/${mediaRequest.id}/interest`);

    assert.equal(res.status, 409);
  });

  it('refuses a user who cannot request movies', async () => {
    const { mediaRequest } = await seed();
    const viewer = await makeUser('viewer@seerr.dev', Permission.REQUEST_TV);
    const agent = await loginAs(viewer.email);

    const res = await agent.post(`/request/${mediaRequest.id}/interest`);

    assert.equal(res.status, 403);
  });

  it('refuses a request that is finished', async () => {
    const { friend, mediaRequest } = await seed(MediaRequestStatus.COMPLETED);
    const agent = await loginAs(friend.email);

    const res = await agent.post(`/request/${mediaRequest.id}/interest`);

    assert.equal(res.status, 409);
  });

  it('does not use up the request quota', async () => {
    const { friend, mediaRequest } = await seed();
    friend.movieQuotaLimit = 1;
    friend.movieQuotaDays = 7;
    await getRepository(User).save(friend);
    const agent = await loginAs(friend.email);

    await agent.post(`/request/${mediaRequest.id}/interest`);
    const quota = await (
      await getRepository(User).findOneOrFail({ where: { id: friend.id } })
    ).getQuota();

    assert.equal(quota.movie.used, 0);
  });
});

describe('DELETE /request/:requestId/interest', () => {
  it('removes the user', async () => {
    const { friend, mediaRequest } = await seed();
    const agent = await loginAs(friend.email);
    await agent.post(`/request/${mediaRequest.id}/interest`);

    const res = await agent.delete(`/request/${mediaRequest.id}/interest`);

    assert.equal(res.status, 204);
    assert.equal(await getRepository(MediaRequestInterest).count(), 0);
  });
});

describe('GET /request/interest', () => {
  it('summarises the open requests of a title', async () => {
    const { friend, media, mediaRequest } = await seed();
    const agent = await loginAs(friend.email);
    await agent.post(`/request/${mediaRequest.id}/interest`);

    const res = await agent.get(`/request/interest?mediaId=${media.id}`);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body.results, [
      { requestId: mediaRequest.id, count: 1, interested: true },
    ]);
  });
});

describe('GET /request (interested requests)', () => {
  it('lists the requests a user asked to be told about', async () => {
    const { friend, mediaRequest } = await seed();
    const agent = await loginAs(friend.email);

    const before = await agent.get('/request');
    assert.equal(before.body.results.length, 0);

    await agent.post(`/request/${mediaRequest.id}/interest`);
    const res = await agent.get('/request');

    assert.equal(res.status, 200);
    assert.deepEqual(
      res.body.results.map((r: { id: number }) => r.id),
      [mediaRequest.id]
    );
    assert.deepEqual(res.body.results[0].interest, {
      count: 1,
      interested: true,
    });
  });
});

describe('notifyInterestedUsers', () => {
  it('sends the availability notification to each interested user', async () => {
    const { demo, friend, media, mediaRequest } = await seed();
    await getRepository(MediaRequestInterest).save(
      new MediaRequestInterest({ request: mediaRequest, user: friend })
    );
    mediaRequest.requestedBy = demo;

    await notifyInterestedUsers(mediaRequest, media, {
      event: 'Movie Request Now Available',
      subject: 'Test',
      media,
      request: mediaRequest,
    });

    const calls = sendMock.calls.filter(
      (call) => call.arguments[0] === Notification.MEDIA_AVAILABLE
    );
    assert.equal(calls.length, 1);
    const payload = calls[0].arguments[1] as NotificationPayload;
    assert.equal(payload.notifyUser?.id, friend.id);
    assert.equal(payload.notifyAdmin, false);
    assert.equal(payload.notifySystem, false);
  });

  it('goes away with the request', async () => {
    const { friend, mediaRequest } = await seed();
    await getRepository(MediaRequestInterest).save(
      new MediaRequestInterest({ request: mediaRequest, user: friend })
    );

    await getRepository(MediaRequest).delete(mediaRequest.id);

    assert.equal(await getRepository(MediaRequestInterest).count(), 0);
  });
});
