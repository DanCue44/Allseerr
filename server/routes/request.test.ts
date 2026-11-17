import assert from 'node:assert/strict';
import { afterEach, before, beforeEach, describe, it, mock } from 'node:test';

import type { AddSeriesOptions } from '@server/api/servarr/sonarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import TheMovieDb from '@server/api/themoviedb';
import type {
  TmdbMovieDetails,
  TmdbTvDetails,
} from '@server/api/themoviedb/interfaces';
import {
  MediaRequestMonitorMode,
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import OverrideRule from '@server/entity/OverrideRule';
import Season from '@server/entity/Season';
import SeasonRequest from '@server/entity/SeasonRequest';
import { User } from '@server/entity/User';
import { Notification } from '@server/lib/notifications';
import { Permission } from '@server/lib/permissions';
import type { RadarrSettings, SonarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { checkUser } from '@server/middleware/auth';
import { MediaRequestSubscriber } from '@server/subscriber/MediaRequestSubscriber';
import { settleTestBackgroundTasks, setupTestDb } from '@server/test/db';
import {
  assertNoCredentials,
  seedUserSettings,
} from '@server/test/userSettings';
import type { Express } from 'express';
import express from 'express';
import session from 'express-session';
import request from 'supertest';
import authRoutes from './auth';
import requestRoutes from './request';

const sendNotificationMock = mock.method(
  MediaRequest,
  'sendNotification',
  async () => undefined
).mock;

let getMovieImpl: (args: {
  movieId: number;
  language?: string;
}) => Promise<TmdbMovieDetails> = async ({ movieId }) => fakeTmdbMovie(movieId);

Object.defineProperty(TheMovieDb.prototype, 'getMovie', {
  get() {
    return async (args: { movieId: number; language?: string }) =>
      getMovieImpl(args);
  },
  set() {},
  configurable: true,
});

let getTvShowImpl: (args: {
  tvId: number;
  language?: string;
}) => Promise<TmdbTvDetails> = async ({ tvId }) => fakeTmdbShow(tvId);

Object.defineProperty(TheMovieDb.prototype, 'getTvShow', {
  get() {
    return async (args: { tvId: number; language?: string }) =>
      getTvShowImpl(args);
  },
  set() {},
  configurable: true,
});

function fakeTmdbMovie(tmdbId: number): TmdbMovieDetails {
  return {
    id: tmdbId,
    genres: [],
    original_language: 'en',
    keywords: { keywords: [] },
    external_ids: {},
  } as unknown as TmdbMovieDetails;
}

function fakeTmdbShow(tmdbId: number): TmdbTvDetails {
  return {
    id: tmdbId,
    genres: [],
    original_language: 'en',
    keywords: { results: [] },
    external_ids: {},
  } as unknown as TmdbTvDetails;
}

function configureRadarr(overrides: Partial<RadarrSettings>[]): void {
  const settings = getSettings();
  settings.radarr = overrides.map((o, i) => ({
    id: i,
    name: `Radarr ${i}`,
    hostname: 'localhost',
    port: 7878,
    apiKey: 'test-key',
    baseUrl: '',
    useSsl: false,
    activeProfileId: 1,
    activeDirectory: '/movies',
    is4k: false,
    minimumAvailability: 'released',
    tags: [],
    isDefault: i === 0,
    syncEnabled: true,
    preventSearch: false,
    externalUrl: '',
    ...o,
  })) as RadarrSettings[];
}

function configureSonarr(overrides: Partial<SonarrSettings>[]): void {
  const settings = getSettings();
  settings.sonarr = overrides.map((o, i) => ({
    id: i,
    name: `Sonarr ${i}`,
    hostname: 'localhost',
    port: 8989,
    apiKey: 'test-key',
    baseUrl: '',
    useSsl: false,
    activeProfileId: 1,
    activeDirectory: '/tv',
    activeLanguageProfileId: 1,
    animeTags: [],
    is4k: false,
    enableSeasonFolders: true,
    tags: [],
    isDefault: i === 0,
    syncEnabled: true,
    preventSearch: false,
    externalUrl: '',
    ...o,
  })) as SonarrSettings[];
}

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

before(async () => {
  app = createApp();
});

beforeEach(() => {
  sendNotificationMock.resetCalls();
});

setupTestDb();

async function loginAs(email: string, password: string) {
  const settings = getSettings();
  const priorLocalLogin = settings.main.localLogin;
  settings.main.localLogin = true;

  try {
    const agent = request.agent(app);
    const res = await agent.post('/auth/local').send({ email, password });
    assert.strictEqual(res.status, 200);
    return agent;
  } finally {
    settings.main.localLogin = priorLocalLogin;
  }
}

async function seedRequest(status = MediaRequestStatus.PENDING) {
  const userRepo = getRepository(User);
  const mediaRepo = getRepository(Media);
  const requestRepo = getRepository(MediaRequest);

  const requestedBy = await userRepo.findOneOrFail({
    where: { email: 'demo@seerr.dev' },
  });

  const media = await mediaRepo.save(
    new Media({
      mediaType: MediaType.MOVIE,
      tmdbId: 12345,
      status: MediaStatus.UNKNOWN,
      status4k: MediaStatus.UNKNOWN,
    })
  );

  const created = await requestRepo.save(
    new MediaRequest({
      type: MediaType.MOVIE,
      status,
      media,
      requestedBy,
      is4k: false,
      updatedAt: new Date('2025-03-01T00:00:00.000Z'),
    })
  );

  return requestRepo.findOneOrFail({
    where: { id: created.id },
    relations: { requestedBy: true, modifiedBy: true },
  });
}

describe('DELETE /request/:requestId', () => {
  it('allows the owner to delete their own pending request', async () => {
    const mediaRequest = await seedRequest();

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.delete(`/request/${mediaRequest.id}`);

    assert.strictEqual(res.status, 204);
  });

  it('allows an admin to delete any pending request', async () => {
    const mediaRequest = await seedRequest();

    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.delete(`/request/${mediaRequest.id}`);

    assert.strictEqual(res.status, 204);
  });

  it('prevents a non-owner non-admin from deleting a pending request', async () => {
    const userRepo = getRepository(User);
    const mediaRepo = getRepository(Media);
    const requestRepo = getRepository(MediaRequest);

    // Create a request owned by admin, then try to delete as friend
    const owner = await userRepo.findOneOrFail({
      where: { email: 'admin@seerr.dev' },
    });

    const media = await mediaRepo.save(
      new Media({
        mediaType: MediaType.MOVIE,
        tmdbId: 54321,
        status: MediaStatus.UNKNOWN,
        status4k: MediaStatus.UNKNOWN,
      })
    );

    const mediaRequest = await requestRepo.save(
      new MediaRequest({
        type: MediaType.MOVIE,
        status: MediaRequestStatus.PENDING,
        media,
        requestedBy: owner,
        is4k: false,
      })
    );

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.delete(`/request/${mediaRequest.id}`);

    assert.strictEqual(res.status, 401);
  });

  it('prevents the owner from deleting an approved request', async () => {
    const mediaRequest = await seedRequest(MediaRequestStatus.APPROVED);

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.delete(`/request/${mediaRequest.id}`);

    assert.strictEqual(res.status, 401);
  });

  it('returns 404 for a non-existent request', async () => {
    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.delete('/request/99999999');

    assert.strictEqual(res.status, 404);
  });

  it('deletes a request once when two deletes race', async () => {
    const repo = getRepository(MediaRequest);
    const mediaRequest = await seedRequest();
    const admin = await loginAs('admin@seerr.dev', 'test1234');

    const results = await Promise.all([
      admin.delete(`/request/${mediaRequest.id}`),
      admin.delete(`/request/${mediaRequest.id}`),
    ]);

    assert.deepStrictEqual(results.map((r) => r.status).sort(), [204, 404]);
    assert.strictEqual(await repo.count({ where: { id: mediaRequest.id } }), 0);
  });
});

describe('PUT /request/:requestId (movie)', () => {
  it('persists server and root folder changes to the database', async () => {
    const requestRepo = getRepository(MediaRequest);
    const mediaRequest = await seedRequest();

    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.put(`/request/${mediaRequest.id}`).send({
      mediaType: MediaType.MOVIE,
      serverId: 3,
      profileId: 7,
      rootFolder: '/updated/movies',
      tags: [1, 2],
    });

    assert.strictEqual(res.status, 200);

    const saved = await requestRepo.findOneOrFail({
      where: { id: mediaRequest.id },
    });
    assert.strictEqual(saved.serverId, 3);
    assert.strictEqual(saved.profileId, 7);
    assert.strictEqual(saved.rootFolder, '/updated/movies');
  });

  it('refuses to modify a request that is no longer pending', async () => {
    const requestRepo = getRepository(MediaRequest);
    const mediaRequest = await seedRequest(MediaRequestStatus.APPROVED);

    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.put(`/request/${mediaRequest.id}`).send({
      mediaType: MediaType.MOVIE,
      serverId: 3,
      rootFolder: '/updated/movies',
    });

    assert.strictEqual(res.status, 409);
    assert.match(res.body.message, /pending/i);

    const saved = await requestRepo.findOneOrFail({
      where: { id: mediaRequest.id },
    });
    assert.strictEqual(saved.serverId, null);
    assert.strictEqual(saved.rootFolder, null);
  });
});

async function seedUser(
  email: string,
  fields: {
    movieQuotaLimit?: number;
    tvQuotaLimit?: number;
    tvQuotaDays?: number;
    musicQuotaLimit?: number;
    bookQuotaLimit?: number;
    permissions?: number;
  } = {}
) {
  const userRepo = getRepository(User);
  const user = await userRepo.findOneOrFail({ where: { email } });
  Object.assign(user, fields);

  return userRepo.save(user);
}

async function seedTvMedia(tmdbId: number) {
  const mediaRepo = getRepository(Media);

  return (
    (await mediaRepo.findOne({
      where: { tmdbId, mediaType: MediaType.TV },
    })) ??
    (await mediaRepo.save(
      new Media({
        mediaType: MediaType.TV,
        tmdbId,
        status: MediaStatus.PENDING,
        status4k: MediaStatus.UNKNOWN,
      })
    ))
  );
}

async function seedMediaSeasons(
  tmdbId: number,
  seasons: { seasonNumber: number; status: MediaStatus }[]
) {
  const media = await seedTvMedia(tmdbId);
  media.seasons = seasons.map(
    ({ seasonNumber, status }) =>
      new Season({ seasonNumber, status, status4k: MediaStatus.UNKNOWN })
  );

  return getRepository(Media).save(media);
}

async function seedTvRequest(
  requestedBy: User,
  seasons: number[],
  { tmdbId = 67890, ignoreQuota = false, createdAt = new Date() } = {}
) {
  return getRepository(MediaRequest).save(
    new MediaRequest({
      type: MediaType.TV,
      status: MediaRequestStatus.PENDING,
      media: await seedTvMedia(tmdbId),
      requestedBy,
      is4k: false,
      ignoreQuota,
      createdAt,
      seasons: seasons.map(
        (seasonNumber) =>
          new SeasonRequest({
            seasonNumber,
            status: MediaRequestStatus.PENDING,
          })
      ),
    })
  );
}

describe('PUT /request/:requestId (tv)', () => {
  it('does not add a season held by another request', async () => {
    const requestRepo = getRepository(MediaRequest);

    const owner = await seedUser('admin@seerr.dev');
    const otherUser = await seedUser('demo@seerr.dev');

    const mediaRequest = await seedTvRequest(owner, [1, 2]);
    const otherRequest = await seedTvRequest(otherUser, [3]);

    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.put(`/request/${mediaRequest.id}`).send({
      mediaType: MediaType.TV,
      seasons: [1, 2, 3],
    });

    assert.strictEqual(res.status, 200);

    const saved = await requestRepo.findOneOrFail({
      where: { id: mediaRequest.id },
    });
    assert.deepStrictEqual(
      saved.seasons.map((s) => s.seasonNumber).sort((a, b) => a - b),
      [1, 2]
    );

    const otherSaved = await requestRepo.findOneOrFail({
      where: { id: otherRequest.id },
    });
    assert.deepStrictEqual(
      otherSaved.seasons.map((s) => s.seasonNumber),
      [3]
    );
  });

  it('gives a season to only one of two concurrent edits', async () => {
    const requestRepo = getRepository(MediaRequest);

    const owner = await seedUser('admin@seerr.dev');
    const otherUser = await seedUser('demo@seerr.dev');

    const mediaRequest = await seedTvRequest(owner, [1]);
    const otherRequest = await seedTvRequest(otherUser, [3]);

    const admin = await loginAs('admin@seerr.dev', 'test1234');
    const friend = await loginAs('demo@seerr.dev', 'test1234');

    const [adminRes, friendRes] = await Promise.all([
      admin
        .put(`/request/${mediaRequest.id}`)
        .send({ mediaType: MediaType.TV, seasons: [1, 2] }),
      friend
        .put(`/request/${otherRequest.id}`)
        .send({ mediaType: MediaType.TV, seasons: [3, 2] }),
    ]);

    assert.strictEqual(adminRes.status, 200);
    assert.strictEqual(friendRes.status, 200);

    const saved = await requestRepo.findOneOrFail({
      where: { id: mediaRequest.id },
    });
    const otherSaved = await requestRepo.findOneOrFail({
      where: { id: otherRequest.id },
    });

    const holders = [saved, otherSaved].filter((r) =>
      r.seasons.some((s) => s.seasonNumber === 2)
    );
    assert.strictEqual(holders.length, 1);

    assert.deepStrictEqual(
      [...saved.seasons, ...otherSaved.seasons]
        .map((s) => s.seasonNumber)
        .sort((a, b) => a - b),
      [1, 2, 3]
    );
  });
});

describe('PUT /request/:requestId (season availability)', () => {
  it('does not add a season the media already has', async () => {
    const requestRepo = getRepository(MediaRequest);
    const owner = await seedUser('demo@seerr.dev');
    const mediaRequest = await seedTvRequest(owner, [1]);
    await seedMediaSeasons(67890, [
      { seasonNumber: 2, status: MediaStatus.AVAILABLE },
    ]);

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.put(`/request/${mediaRequest.id}`).send({
      mediaType: MediaType.TV,
      seasons: [1, 2, 3],
    });

    assert.strictEqual(res.status, 200);

    const saved = await requestRepo.findOneOrFail({
      where: { id: mediaRequest.id },
    });
    assert.deepStrictEqual(
      saved.seasons.map((s) => s.seasonNumber).sort((a, b) => a - b),
      [1, 3]
    );
  });

  it('returns 202 when every requested season is already covered', async () => {
    const owner = await seedUser('demo@seerr.dev');
    const mediaRequest = await seedTvRequest(owner, [1]);
    await seedMediaSeasons(67890, [
      { seasonNumber: 2, status: MediaStatus.AVAILABLE },
    ]);

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.put(`/request/${mediaRequest.id}`).send({
      mediaType: MediaType.TV,
      seasons: [2],
    });

    assert.strictEqual(res.status, 202);
  });

  it('keeps the seasons it already holds once they are available', async () => {
    const requestRepo = getRepository(MediaRequest);
    const owner = await seedUser('demo@seerr.dev', {
      permissions: Permission.REQUEST | Permission.REQUEST_ADVANCED,
    });
    const mediaRequest = await seedTvRequest(owner, [1, 2]);
    await seedMediaSeasons(67890, [
      { seasonNumber: 1, status: MediaStatus.AVAILABLE },
      { seasonNumber: 2, status: MediaStatus.PROCESSING },
    ]);

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.put(`/request/${mediaRequest.id}`).send({
      mediaType: MediaType.TV,
      seasons: [1, 2],
      serverId: 3,
    });

    assert.strictEqual(res.status, 200);

    const saved = await requestRepo.findOneOrFail({
      where: { id: mediaRequest.id },
    });
    assert.deepStrictEqual(
      saved.seasons.map((s) => s.seasonNumber).sort((a, b) => a - b),
      [1, 2]
    );
    assert.strictEqual(saved.serverId, 3);
  });

  it('does not charge quota for a season the media already has', async () => {
    const requestRepo = getRepository(MediaRequest);
    const owner = await seedUser('demo@seerr.dev', { tvQuotaLimit: 1 });
    const mediaRequest = await seedTvRequest(owner, [1]);
    await seedMediaSeasons(67890, [
      { seasonNumber: 2, status: MediaStatus.AVAILABLE },
    ]);

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.put(`/request/${mediaRequest.id}`).send({
      mediaType: MediaType.TV,
      seasons: [1, 2],
    });

    assert.strictEqual(res.status, 200);

    const saved = await requestRepo.findOneOrFail({
      where: { id: mediaRequest.id },
    });
    assert.deepStrictEqual(
      saved.seasons.map((s) => s.seasonNumber),
      [1]
    );
  });
});

describe('PUT /request/:requestId (quota)', () => {
  it('rejects adding seasons beyond the season limit', async () => {
    const requestRepo = getRepository(MediaRequest);
    const owner = await seedUser('demo@seerr.dev', { tvQuotaLimit: 2 });
    const mediaRequest = await seedTvRequest(owner, [1, 2]);

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.put(`/request/${mediaRequest.id}`).send({
      mediaType: MediaType.TV,
      seasons: [1, 2, 3],
    });

    assert.strictEqual(res.status, 403);

    const saved = await requestRepo.findOneOrFail({
      where: { id: mediaRequest.id },
    });
    assert.deepStrictEqual(
      saved.seasons.map((s) => s.seasonNumber).sort((a, b) => a - b),
      [1, 2]
    );
  });

  it('rejects adding seasons to a request older than the quota window', async () => {
    const requestRepo = getRepository(MediaRequest);
    const owner = await seedUser('demo@seerr.dev', {
      tvQuotaLimit: 2,
      tvQuotaDays: 7,
    });
    const mediaRequest = await seedTvRequest(owner, [1, 2], {
      createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    });

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.put(`/request/${mediaRequest.id}`).send({
      mediaType: MediaType.TV,
      seasons: [1, 2, 3],
    });

    assert.strictEqual(res.status, 403);

    const saved = await requestRepo.findOneOrFail({
      where: { id: mediaRequest.id },
    });
    assert.deepStrictEqual(
      saved.seasons.map((s) => s.seasonNumber).sort((a, b) => a - b),
      [1, 2]
    );
  });

  it('allows swapping seasons at the season limit', async () => {
    const requestRepo = getRepository(MediaRequest);
    const owner = await seedUser('demo@seerr.dev', { tvQuotaLimit: 2 });
    const mediaRequest = await seedTvRequest(owner, [1, 2]);

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.put(`/request/${mediaRequest.id}`).send({
      mediaType: MediaType.TV,
      seasons: [3, 4],
    });

    assert.strictEqual(res.status, 200);

    const saved = await requestRepo.findOneOrFail({
      where: { id: mediaRequest.id },
    });
    assert.deepStrictEqual(
      saved.seasons.map((s) => s.seasonNumber).sort((a, b) => a - b),
      [3, 4]
    );
  });

  it('rejects reassignment to a user without room for the existing seasons', async () => {
    const requestRepo = getRepository(MediaRequest);
    const owner = await seedUser('admin@seerr.dev');
    const target = await seedUser('demo@seerr.dev', { tvQuotaLimit: 1 });
    const mediaRequest = await seedTvRequest(owner, [1, 2]);

    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.put(`/request/${mediaRequest.id}`).send({
      mediaType: MediaType.TV,
      seasons: [1, 2],
      userId: target.id,
    });

    assert.strictEqual(res.status, 403);

    const saved = await requestRepo.findOneOrFail({
      where: { id: mediaRequest.id },
    });
    assert.strictEqual(saved.requestedBy.id, owner.id);
  });

  it('rejects reassignment of a movie request to a user at their limit', async () => {
    const requestRepo = getRepository(MediaRequest);
    const mediaRepo = getRepository(Media);

    const owner = await seedUser('admin@seerr.dev');
    const target = await seedUser('demo@seerr.dev', { movieQuotaLimit: 1 });

    // Uses up the target's single movie request
    await seedRequest();

    const media = await mediaRepo.save(
      new Media({
        mediaType: MediaType.MOVIE,
        tmdbId: 55555,
        status: MediaStatus.PENDING,
        status4k: MediaStatus.UNKNOWN,
      })
    );
    const mediaRequest = await requestRepo.save(
      new MediaRequest({
        type: MediaType.MOVIE,
        status: MediaRequestStatus.PENDING,
        media,
        requestedBy: owner,
        is4k: false,
      })
    );

    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.put(`/request/${mediaRequest.id}`).send({
      mediaType: MediaType.MOVIE,
      userId: target.id,
    });

    assert.strictEqual(res.status, 403);

    const saved = await requestRepo.findOneOrFail({
      where: { id: mediaRequest.id },
    });
    assert.strictEqual(saved.requestedBy.id, owner.id);
  });

  it('rejects reassignment of music and book requests to a user at their limit', async () => {
    const requestRepo = getRepository(MediaRequest);
    const mediaRepo = getRepository(Media);

    const owner = await seedUser('admin@seerr.dev');
    const target = await seedUser('demo@seerr.dev', {
      musicQuotaLimit: 1,
      bookQuotaLimit: 1,
    });

    const seedPair = async (requestedBy: User, suffix: string) => {
      const album = await mediaRepo.save(
        new Media({
          mediaType: MediaType.MUSIC,
          mbId: `album-${suffix}`,
          status: MediaStatus.PENDING,
        })
      );
      const book = await mediaRepo.save(
        new Media({
          mediaType: MediaType.BOOK,
          olId: `OL${suffix}W`,
          status: MediaStatus.PENDING,
        })
      );

      return Promise.all([
        requestRepo.save(
          new MediaRequest({
            type: MediaType.MUSIC,
            status: MediaRequestStatus.PENDING,
            media: album,
            requestedBy,
            is4k: false,
          })
        ),
        requestRepo.save(
          new MediaRequest({
            type: MediaType.BOOK,
            status: MediaRequestStatus.PENDING,
            media: book,
            requestedBy,
            is4k: false,
            isAudiobook: false,
          })
        ),
      ]);
    };

    // Uses up the target's single album and book requests
    await seedPair(target, '1');
    const [musicRequest, bookRequest] = await seedPair(owner, '2');

    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const musicRes = await agent.put(`/request/${musicRequest.id}`).send({
      mediaType: MediaType.MUSIC,
      userId: target.id,
    });
    const bookRes = await agent.put(`/request/${bookRequest.id}`).send({
      mediaType: MediaType.BOOK,
      userId: target.id,
    });

    assert.strictEqual(musicRes.status, 403);
    assert.strictEqual(musicRes.body.message, 'Music Quota exceeded.');
    assert.strictEqual(bookRes.status, 403);
    assert.strictEqual(bookRes.body.message, 'Book Quota exceeded.');

    for (const id of [musicRequest.id, bookRequest.id]) {
      const saved = await requestRepo.findOneOrFail({ where: { id } });
      assert.strictEqual(saved.requestedBy.id, owner.id);
    }
  });

  it('allows reassignment to a user who bypasses quotas', async () => {
    const requestRepo = getRepository(MediaRequest);
    const owner = await seedUser('demo@seerr.dev', { tvQuotaLimit: 1 });
    const target = await seedUser('admin@seerr.dev');
    const mediaRequest = await seedTvRequest(owner, [1, 2]);

    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.put(`/request/${mediaRequest.id}`).send({
      mediaType: MediaType.TV,
      seasons: [1, 2],
      userId: target.id,
    });

    assert.strictEqual(res.status, 200);

    const saved = await requestRepo.findOneOrFail({
      where: { id: mediaRequest.id },
    });
    assert.strictEqual(saved.requestedBy.id, target.id);
  });

  it('allows an edit that exceeds the limit when the request ignores quota', async () => {
    const requestRepo = getRepository(MediaRequest);
    const owner = await seedUser('demo@seerr.dev', { tvQuotaLimit: 2 });

    await seedTvRequest(owner, [1, 2], { tmdbId: 77777 });
    const mediaRequest = await seedTvRequest(owner, [1, 2], {
      ignoreQuota: true,
    });

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.put(`/request/${mediaRequest.id}`).send({
      mediaType: MediaType.TV,
      seasons: [1, 2, 3],
    });

    assert.strictEqual(res.status, 200);

    const saved = await requestRepo.findOneOrFail({
      where: { id: mediaRequest.id },
    });
    assert.deepStrictEqual(
      saved.seasons.map((s) => s.seasonNumber).sort((a, b) => a - b),
      [1, 2, 3]
    );
  });

  it('charges only the net increase when an edit both adds and removes', async () => {
    const requestRepo = getRepository(MediaRequest);
    const owner = await seedUser('demo@seerr.dev', { tvQuotaLimit: 4 });
    const mediaRequest = await seedTvRequest(owner, [1, 2, 3]);

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.put(`/request/${mediaRequest.id}`).send({
      mediaType: MediaType.TV,
      seasons: [1, 2, 4, 5],
    });

    assert.strictEqual(res.status, 200);

    const saved = await requestRepo.findOneOrFail({
      where: { id: mediaRequest.id },
    });
    assert.deepStrictEqual(
      saved.seasons.map((s) => s.seasonNumber).sort((a, b) => a - b),
      [1, 2, 4, 5]
    );
  });
});

const movieOptions = {
  serverId: 2,
  profileId: 9,
  rootFolder: '/chosen',
  tags: [3],
};

const tvOptions = { ...movieOptions, languageProfileId: 4 };

const noOptions = {
  serverId: null,
  profileId: null,
  rootFolder: null,
  languageProfileId: null,
  tags: null,
};

function storedOptions(request: MediaRequest) {
  return {
    serverId: request.serverId,
    profileId: request.profileId,
    rootFolder: request.rootFolder,
    languageProfileId: request.languageProfileId,
    tags: request.tags,
  };
}

describe('PUT /request/:requestId (advanced options)', () => {
  it('keeps the stored options when a regular requester edits their seasons', async () => {
    const requestRepo = getRepository(MediaRequest);
    const owner = await seedUser('demo@seerr.dev');
    const mediaRequest = await seedTvRequest(owner, [1]);
    const stored = {
      serverId: 1,
      profileId: 5,
      rootFolder: '/stored',
      languageProfileId: 2,
      tags: [6],
    };
    await requestRepo.save(Object.assign(mediaRequest, stored));

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.put(`/request/${mediaRequest.id}`).send({
      mediaType: MediaType.TV,
      seasons: [1, 2],
      ...tvOptions,
    });

    assert.strictEqual(res.status, 200);

    const saved = await requestRepo.findOneOrFail({
      where: { id: mediaRequest.id },
    });
    assert.deepStrictEqual(
      saved.seasons.map((s) => s.seasonNumber).sort((a, b) => a - b),
      [1, 2]
    );
    assert.deepStrictEqual(storedOptions(saved), stored);
  });

  it('rejects a regular requester editing their movie request as a series', async () => {
    const mediaRequest = await seedRequest();

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.put(`/request/${mediaRequest.id}`).send({
      mediaType: MediaType.TV,
      seasons: [1],
      ...tvOptions,
    });

    assert.strictEqual(res.status, 403);
  });
});

describe('GET /request/:requestId', () => {
  it('omits notification settings from requestedBy and modifiedBy', async () => {
    const pending = await seedRequest();
    await seedUserSettings('demo@seerr.dev');
    await seedUserSettings('admin@seerr.dev');

    const admin = await loginAs('admin@seerr.dev', 'test1234');
    const approved = await admin.post(`/request/${pending.id}/approve`);
    assert.strictEqual(approved.status, 200);

    const res = await admin.get(`/request/${pending.id}`);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.requestedBy.email, 'demo@seerr.dev');
    assert.strictEqual(res.body.modifiedBy.email, 'admin@seerr.dev');
    assert.ok(!('settings' in res.body.requestedBy));
    assert.ok(!('settings' in res.body.modifiedBy));
    assertNoCredentials(res.body);
  });
});

describe('POST /request/:requestId/:status', () => {
  const cases = [
    { action: 'approve', expected: MediaRequestStatus.APPROVED },
    { action: 'decline', expected: MediaRequestStatus.DECLINED },
  ] as const;

  for (const { action, expected } of cases) {
    it(`transitions to ${action}d and records the acting user`, async () => {
      const repo = getRepository(MediaRequest);
      const pending = await seedRequest();
      const admin = await loginAs('admin@seerr.dev', 'test1234');

      const res = await admin.post(`/request/${pending.id}/${action}`);

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.status, expected);
      assert.strictEqual(res.body.modifiedBy.email, 'admin@seerr.dev');

      const persisted = await repo.findOneOrFail({
        where: { id: pending.id },
        relations: { modifiedBy: true },
      });

      assert.strictEqual(persisted.status, expected);
      assert.strictEqual(persisted.modifiedBy?.email, 'admin@seerr.dev');
      assert.ok(persisted.updatedAt > pending.updatedAt);
    });
  }

  it('stores the reason given when declining', async () => {
    const repo = getRepository(MediaRequest);
    const pending = await seedRequest();
    const admin = await loginAs('admin@seerr.dev', 'test1234');

    const res = await admin
      .post(`/request/${pending.id}/decline`)
      .send({ reason: '  Already streaming on Netflix  ' });

    assert.strictEqual(res.status, 200);
    const persisted = await repo.findOneOrFail({ where: { id: pending.id } });
    assert.strictEqual(persisted.declineReason, 'Already streaming on Netflix');
  });

  it('ignores a reason when approving', async () => {
    const repo = getRepository(MediaRequest);
    const pending = await seedRequest();
    const admin = await loginAs('admin@seerr.dev', 'test1234');

    await admin
      .post(`/request/${pending.id}/approve`)
      .send({ reason: 'Not used' });

    const persisted = await repo.findOneOrFail({ where: { id: pending.id } });
    assert.strictEqual(persisted.declineReason ?? null, null);
  });

  it('rejects a status the route does not define', async () => {
    const repo = getRepository(MediaRequest);
    const pending = await seedRequest();
    const admin = await loginAs('admin@seerr.dev', 'test1234');

    const res = await admin.post(`/request/${pending.id}/frobnicate`);

    assert.strictEqual(res.status, 400);
    assert.match(res.body.message, /approve/i);

    const persisted = await repo.findOneOrFail({
      where: { id: pending.id },
      relations: { modifiedBy: true },
    });
    assert.strictEqual(persisted.status, MediaRequestStatus.PENDING);
    assert.ok(!persisted.modifiedBy);
  });

  it('refuses to act on a request that is no longer pending', async () => {
    const repo = getRepository(MediaRequest);
    const approved = await seedRequest(MediaRequestStatus.APPROVED);
    const admin = await loginAs('admin@seerr.dev', 'test1234');

    const res = await admin.post(`/request/${approved.id}/decline`);

    assert.strictEqual(res.status, 409);
    assert.match(res.body.message, /pending/i);

    const persisted = await repo.findOneOrFail({ where: { id: approved.id } });
    assert.strictEqual(persisted.status, MediaRequestStatus.APPROVED);
  });

  it('applies only one of a concurrent approve and decline', async () => {
    const repo = getRepository(MediaRequest);
    const pending = await seedRequest();
    const admin = await loginAs('admin@seerr.dev', 'test1234');

    const [approve, decline] = await Promise.all([
      admin.post(`/request/${pending.id}/approve`),
      admin.post(`/request/${pending.id}/decline`),
    ]);

    assert.deepStrictEqual([approve.status, decline.status].sort(), [200, 409]);

    const persisted = await repo.findOneOrFail({ where: { id: pending.id } });
    assert.strictEqual(
      persisted.status,
      approve.status === 200
        ? MediaRequestStatus.APPROVED
        : MediaRequestStatus.DECLINED
    );
  });

  it('rejects the removed pending verb even on a non-pending request', async () => {
    const repo = getRepository(MediaRequest);
    const declined = await seedRequest(MediaRequestStatus.DECLINED);
    const admin = await loginAs('admin@seerr.dev', 'test1234');

    const res = await admin.post(`/request/${declined.id}/pending`);

    assert.strictEqual(res.status, 400);
    assert.match(res.body.message, /approve/i);

    const persisted = await repo.findOneOrFail({ where: { id: declined.id } });
    assert.strictEqual(persisted.status, MediaRequestStatus.DECLINED);
  });
});

describe('POST /request/:requestId/retry', () => {
  it('re-approves a failed request and records the acting user', async () => {
    const repo = getRepository(MediaRequest);
    const failed = await seedRequest(MediaRequestStatus.FAILED);
    const admin = await loginAs('admin@seerr.dev', 'test1234');

    const res = await admin.post(`/request/${failed.id}/retry`);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.status, MediaRequestStatus.APPROVED);
    assert.strictEqual(res.body.modifiedBy.email, 'admin@seerr.dev');

    const persisted = await repo.findOneOrFail({
      where: { id: failed.id },
      relations: { modifiedBy: true },
    });

    assert.strictEqual(persisted.status, MediaRequestStatus.APPROVED);
    assert.strictEqual(persisted.modifiedBy?.email, 'admin@seerr.dev');
    assert.ok(persisted.updatedAt > failed.updatedAt);
  });

  it('refuses to retry a request that has not failed', async () => {
    const repo = getRepository(MediaRequest);
    const pending = await seedRequest();
    const admin = await loginAs('admin@seerr.dev', 'test1234');

    const res = await admin.post(`/request/${pending.id}/retry`);

    assert.strictEqual(res.status, 409);
    assert.match(res.body.message, /failed/i);

    const persisted = await repo.findOneOrFail({ where: { id: pending.id } });
    assert.strictEqual(persisted.status, MediaRequestStatus.PENDING);
  });

  it('sends a concurrently retried request to *arr once', async (t) => {
    const repo = getRepository(MediaRequest);
    const failed = await seedRequest(MediaRequestStatus.FAILED);
    const admin = await loginAs('admin@seerr.dev', 'test1234');

    const sendToRadarr = t.mock.method(
      MediaRequestSubscriber.prototype,
      'sendToRadarr',
      async () => undefined
    );

    const results = await Promise.all([
      admin.post(`/request/${failed.id}/retry`),
      admin.post(`/request/${failed.id}/retry`),
    ]);

    assert.deepStrictEqual(results.map((r) => r.status).sort(), [200, 409]);
    assert.strictEqual(sendToRadarr.mock.callCount(), 1);

    const persisted = await repo.findOneOrFail({ where: { id: failed.id } });
    assert.strictEqual(persisted.status, MediaRequestStatus.APPROVED);
  });
});

describe('DELETE /request/:requestId, deleted media status restoration', () => {
  async function seedDeletedMediaScenario() {
    const userRepo = getRepository(User);
    const mediaRepo = getRepository(Media);
    const requestRepo = getRepository(MediaRequest);

    const admin = await userRepo.findOneOrFail({
      where: { email: 'admin@seerr.dev' },
    });

    const media = await mediaRepo.save(
      new Media({
        mediaType: MediaType.MOVIE,
        tmdbId: 99001,
        status: MediaStatus.DELETED,
        status4k: MediaStatus.UNKNOWN,
      })
    );

    const staleRequest = await requestRepo.save(
      new MediaRequest({
        type: MediaType.MOVIE,
        status: MediaRequestStatus.COMPLETED,
        media,
        requestedBy: admin,
        is4k: false,
        isAutoRequest: true,
      })
    );

    media.status = MediaStatus.PENDING;
    await mediaRepo.save(media);

    const newRequest = await requestRepo.save(
      new MediaRequest({
        type: MediaType.MOVIE,
        status: MediaRequestStatus.APPROVED,
        media,
        requestedBy: admin,
        is4k: false,
      })
    );

    return { media, staleRequest, newRequest, admin };
  }

  it('restores media status to DELETED when the re-request is deleted and a stale completed request remains', async () => {
    const mediaRepo = getRepository(Media);
    const { media, newRequest } = await seedDeletedMediaScenario();

    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.delete(`/request/${newRequest.id}`);

    assert.strictEqual(res.status, 204);

    const updated = await mediaRepo.findOneOrFail({ where: { id: media.id } });
    assert.strictEqual(updated.status, MediaStatus.DELETED);
  });

  it('restores media status4k to DELETED when the re-request is deleted and a stale completed request remains', async () => {
    const userRepo = getRepository(User);
    const mediaRepo = getRepository(Media);
    const requestRepo = getRepository(MediaRequest);

    const admin = await userRepo.findOneOrFail({
      where: { email: 'admin@seerr.dev' },
    });

    const media = await mediaRepo.save(
      new Media({
        mediaType: MediaType.MOVIE,
        tmdbId: 99003,
        status: MediaStatus.UNKNOWN,
        status4k: MediaStatus.DELETED,
      })
    );

    await requestRepo.save(
      new MediaRequest({
        type: MediaType.MOVIE,
        status: MediaRequestStatus.COMPLETED,
        media,
        requestedBy: admin,
        is4k: true,
        isAutoRequest: true,
      })
    );

    media.status4k = MediaStatus.PENDING;
    await mediaRepo.save(media);

    const newRequest = await requestRepo.save(
      new MediaRequest({
        type: MediaType.MOVIE,
        status: MediaRequestStatus.APPROVED,
        media,
        requestedBy: admin,
        is4k: true,
      })
    );

    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.delete(`/request/${newRequest.id}`);

    assert.strictEqual(res.status, 204);

    const updated = await mediaRepo.findOneOrFail({ where: { id: media.id } });
    assert.strictEqual(updated.status4k, MediaStatus.DELETED);
  });

  it('resets media status to UNKNOWN when the stale completed request is also deleted', async () => {
    const mediaRepo = getRepository(Media);
    const requestRepo = getRepository(MediaRequest);
    const { media, newRequest, staleRequest } =
      await seedDeletedMediaScenario();

    const agent = await loginAs('admin@seerr.dev', 'test1234');

    await agent.delete(`/request/${newRequest.id}`);

    const res = await agent.delete(`/request/${staleRequest.id}`);
    assert.strictEqual(res.status, 204);

    const updated = await mediaRepo.findOneOrFail({ where: { id: media.id } });
    assert.strictEqual(updated.status, MediaStatus.UNKNOWN);

    const remaining = await requestRepo.find({
      where: { media: { id: media.id } },
    });
    assert.strictEqual(remaining.length, 0);
  });

  it('resets media status4k to UNKNOWN when the stale completed 4K request is also deleted', async () => {
    const userRepo = getRepository(User);
    const mediaRepo = getRepository(Media);
    const requestRepo = getRepository(MediaRequest);

    const admin = await userRepo.findOneOrFail({
      where: { email: 'admin@seerr.dev' },
    });

    const media = await mediaRepo.save(
      new Media({
        mediaType: MediaType.MOVIE,
        tmdbId: 99004,
        status: MediaStatus.UNKNOWN,
        status4k: MediaStatus.DELETED,
      })
    );

    const staleRequest = await requestRepo.save(
      new MediaRequest({
        type: MediaType.MOVIE,
        status: MediaRequestStatus.COMPLETED,
        media,
        requestedBy: admin,
        is4k: true,
        isAutoRequest: true,
      })
    );

    media.status4k = MediaStatus.PENDING;
    await mediaRepo.save(media);

    const newRequest = await requestRepo.save(
      new MediaRequest({
        type: MediaType.MOVIE,
        status: MediaRequestStatus.APPROVED,
        media,
        requestedBy: admin,
        is4k: true,
      })
    );

    const agent = await loginAs('admin@seerr.dev', 'test1234');

    await agent.delete(`/request/${newRequest.id}`);

    const res = await agent.delete(`/request/${staleRequest.id}`);
    assert.strictEqual(res.status, 204);

    const updated = await mediaRepo.findOneOrFail({ where: { id: media.id } });
    assert.strictEqual(updated.status4k, MediaStatus.UNKNOWN);
  });

  it('does not reset media status when other active requests still exist', async () => {
    const userRepo = getRepository(User);
    const mediaRepo = getRepository(Media);
    const requestRepo = getRepository(MediaRequest);

    const admin = await userRepo.findOneOrFail({
      where: { email: 'admin@seerr.dev' },
    });

    const media = await mediaRepo.save(
      new Media({
        mediaType: MediaType.MOVIE,
        tmdbId: 99002,
        status: MediaStatus.PENDING,
        status4k: MediaStatus.UNKNOWN,
      })
    );

    const req1 = await requestRepo.save(
      new MediaRequest({
        type: MediaType.MOVIE,
        status: MediaRequestStatus.PENDING,
        media,
        requestedBy: admin,
        is4k: false,
      })
    );

    await requestRepo.save(
      new MediaRequest({
        type: MediaType.MOVIE,
        status: MediaRequestStatus.PENDING,
        media,
        requestedBy: admin,
        is4k: false,
      })
    );

    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.delete(`/request/${req1.id}`);

    assert.strictEqual(res.status, 204);

    const updated = await mediaRepo.findOneOrFail({ where: { id: media.id } });
    assert.strictEqual(updated.status, MediaStatus.PENDING);
  });

  it('does not reset media status when status is PARTIALLY_AVAILABLE and only completed requests remain', async () => {
    const userRepo = getRepository(User);
    const mediaRepo = getRepository(Media);
    const requestRepo = getRepository(MediaRequest);

    const admin = await userRepo.findOneOrFail({
      where: { email: 'admin@seerr.dev' },
    });

    const media = await mediaRepo.save(
      new Media({
        mediaType: MediaType.MOVIE,
        tmdbId: 99005,
        status: MediaStatus.PARTIALLY_AVAILABLE,
        status4k: MediaStatus.UNKNOWN,
      })
    );

    const completedRequest = await requestRepo.save(
      new MediaRequest({
        type: MediaType.MOVIE,
        status: MediaRequestStatus.COMPLETED,
        media,
        requestedBy: admin,
        is4k: false,
      })
    );

    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.delete(`/request/${completedRequest.id}`);

    assert.strictEqual(res.status, 204);

    const updated = await mediaRepo.findOneOrFail({ where: { id: media.id } });
    assert.strictEqual(updated.status, MediaStatus.PARTIALLY_AVAILABLE);
  });
});

describe('POST /request (movie), override rules', () => {
  it('applies an override rule when the default Radarr server id differs from its array index', async () => {
    configureRadarr([{ id: 5, isDefault: true, is4k: false }]);
    getSettings().sonarr = [];

    const userRepo = getRepository(User);
    const friend = await userRepo.findOneOrFail({
      where: { email: 'demo@seerr.dev' },
    });

    const overrideRuleRepo = getRepository(OverrideRule);
    await overrideRuleRepo.save(
      new OverrideRule({
        radarrServiceId: 5,
        users: String(friend.id),
        rootFolder: '/overridden/movies',
      })
    );

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.post('/request').send({
      mediaType: MediaType.MOVIE,
      mediaId: 88001,
    });

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.rootFolder, '/overridden/movies');
  });

  it('applies an override rule when the default Radarr server id matches its array index (sanity check)', async () => {
    configureRadarr([{ id: 0, isDefault: true, is4k: false }]);
    getSettings().sonarr = [];

    const userRepo = getRepository(User);
    const friend = await userRepo.findOneOrFail({
      where: { email: 'demo@seerr.dev' },
    });

    const overrideRuleRepo = getRepository(OverrideRule);
    await overrideRuleRepo.save(
      new OverrideRule({
        radarrServiceId: 0,
        users: String(friend.id),
        rootFolder: '/overridden/movies',
      })
    );

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.post('/request').send({
      mediaType: MediaType.MOVIE,
      mediaId: 88002,
    });

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.rootFolder, '/overridden/movies');
  });

  it('does not apply an unrelated override rule when there is no default Radarr server configured', async () => {
    getSettings().radarr = [];
    getSettings().sonarr = [];

    const userRepo = getRepository(User);
    const friend = await userRepo.findOneOrFail({
      where: { email: 'demo@seerr.dev' },
    });

    const overrideRuleRepo = getRepository(OverrideRule);
    await overrideRuleRepo.save(
      new OverrideRule({
        radarrServiceId: 999,
        users: String(friend.id),
        rootFolder: '/overridden/movies',
      })
    );

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.post('/request').send({
      mediaType: MediaType.MOVIE,
      mediaId: 88005,
    });

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.rootFolder, null);
  });

  it('applies the selected server override rule when a specific server is requested', async () => {
    configureRadarr([
      { id: 1, isDefault: true, is4k: false },
      { id: 2, is4k: false },
    ]);
    getSettings().sonarr = [];

    const friend = await seedUser('demo@seerr.dev', {
      permissions: Permission.REQUEST | Permission.REQUEST_ADVANCED,
    });

    const overrideRuleRepo = getRepository(OverrideRule);
    await overrideRuleRepo.save(
      new OverrideRule({
        radarrServiceId: 2,
        users: String(friend.id),
        rootFolder: '/selected/movies',
      })
    );

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.post('/request').send({
      mediaType: MediaType.MOVIE,
      mediaId: 88007,
      serverId: 2,
    });

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.rootFolder, '/selected/movies');
  });

  it('does not apply the default server override rule when another server is requested', async () => {
    configureRadarr([
      { id: 1, isDefault: true, is4k: false },
      { id: 2, is4k: false },
    ]);
    getSettings().sonarr = [];

    const friend = await seedUser('demo@seerr.dev', {
      permissions: Permission.REQUEST | Permission.REQUEST_ADVANCED,
    });

    const overrideRuleRepo = getRepository(OverrideRule);
    await overrideRuleRepo.save(
      new OverrideRule({
        radarrServiceId: 1,
        users: String(friend.id),
        rootFolder: '/default/movies',
      })
    );

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.post('/request').send({
      mediaType: MediaType.MOVIE,
      mediaId: 88008,
      serverId: 2,
    });

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.rootFolder, null);
  });

  it('falls back to the default server override rule when the requested server does not exist', async () => {
    configureRadarr([{ id: 1, isDefault: true, is4k: false }]);
    getSettings().sonarr = [];

    const userRepo = getRepository(User);
    const friend = await userRepo.findOneOrFail({
      where: { email: 'demo@seerr.dev' },
    });

    const overrideRuleRepo = getRepository(OverrideRule);
    await overrideRuleRepo.save(
      new OverrideRule({
        radarrServiceId: 1,
        users: String(friend.id),
        rootFolder: '/default/movies',
      })
    );

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.post('/request').send({
      mediaType: MediaType.MOVIE,
      mediaId: 88009,
      serverId: 7,
    });

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.rootFolder, '/default/movies');
  });
});

describe('POST /request (tv), override rules', () => {
  it('applies an override rule when the default Sonarr server id differs from its array index', async () => {
    configureSonarr([{ id: 5, isDefault: true, is4k: false }]);
    getSettings().radarr = [];

    const userRepo = getRepository(User);
    const friend = await userRepo.findOneOrFail({
      where: { email: 'demo@seerr.dev' },
    });

    const overrideRuleRepo = getRepository(OverrideRule);
    await overrideRuleRepo.save(
      new OverrideRule({
        sonarrServiceId: 5,
        users: String(friend.id),
        rootFolder: '/overridden/tv',
      })
    );

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.post('/request').send({
      mediaType: MediaType.TV,
      mediaId: 88003,
      seasons: [1],
    });

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.rootFolder, '/overridden/tv');
  });

  it('applies an override rule when the default Sonarr server id matches its array index (sanity check)', async () => {
    configureSonarr([{ id: 0, isDefault: true, is4k: false }]);
    getSettings().radarr = [];

    const userRepo = getRepository(User);
    const friend = await userRepo.findOneOrFail({
      where: { email: 'demo@seerr.dev' },
    });

    const overrideRuleRepo = getRepository(OverrideRule);
    await overrideRuleRepo.save(
      new OverrideRule({
        sonarrServiceId: 0,
        users: String(friend.id),
        rootFolder: '/overridden/tv',
      })
    );

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.post('/request').send({
      mediaType: MediaType.TV,
      mediaId: 88004,
      seasons: [1],
    });

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.rootFolder, '/overridden/tv');
  });

  it('does not apply an unrelated override rule when there is no default Sonarr server configured', async () => {
    getSettings().radarr = [];
    getSettings().sonarr = [];

    const userRepo = getRepository(User);
    const friend = await userRepo.findOneOrFail({
      where: { email: 'demo@seerr.dev' },
    });

    const overrideRuleRepo = getRepository(OverrideRule);
    await overrideRuleRepo.save(
      new OverrideRule({
        sonarrServiceId: 999,
        users: String(friend.id),
        rootFolder: '/overridden/tv',
      })
    );

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.post('/request').send({
      mediaType: MediaType.TV,
      mediaId: 88006,
      seasons: [1],
    });

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.rootFolder, null);
  });

  it('applies the selected server override rule when a specific server is requested', async () => {
    configureSonarr([
      { id: 1, isDefault: true, is4k: false },
      { id: 2, is4k: false },
    ]);
    getSettings().radarr = [];

    const friend = await seedUser('demo@seerr.dev', {
      permissions: Permission.REQUEST | Permission.REQUEST_ADVANCED,
    });

    const overrideRuleRepo = getRepository(OverrideRule);
    await overrideRuleRepo.save(
      new OverrideRule({
        sonarrServiceId: 2,
        users: String(friend.id),
        rootFolder: '/selected/tv',
      })
    );

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.post('/request').send({
      mediaType: MediaType.TV,
      mediaId: 88011,
      seasons: [1],
      serverId: 2,
    });

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.rootFolder, '/selected/tv');
  });

  it('does not apply the default server override rule when another server is requested', async () => {
    configureSonarr([
      { id: 1, isDefault: true, is4k: false },
      { id: 2, is4k: false },
    ]);
    getSettings().radarr = [];

    const friend = await seedUser('demo@seerr.dev', {
      permissions: Permission.REQUEST | Permission.REQUEST_ADVANCED,
    });

    const overrideRuleRepo = getRepository(OverrideRule);
    await overrideRuleRepo.save(
      new OverrideRule({
        sonarrServiceId: 1,
        users: String(friend.id),
        rootFolder: '/default/tv',
      })
    );

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.post('/request').send({
      mediaType: MediaType.TV,
      mediaId: 88012,
      seasons: [1],
      serverId: 2,
    });

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.rootFolder, null);
  });

  it('falls back to the default server override rule when the requested server does not exist', async () => {
    configureSonarr([{ id: 1, isDefault: true, is4k: false }]);
    getSettings().radarr = [];

    const userRepo = getRepository(User);
    const friend = await userRepo.findOneOrFail({
      where: { email: 'demo@seerr.dev' },
    });

    const overrideRuleRepo = getRepository(OverrideRule);
    await overrideRuleRepo.save(
      new OverrideRule({
        sonarrServiceId: 1,
        users: String(friend.id),
        rootFolder: '/default/tv',
      })
    );

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.post('/request').send({
      mediaType: MediaType.TV,
      mediaId: 88013,
      seasons: [1],
      serverId: 7,
    });

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.rootFolder, '/default/tv');
  });
});

describe('POST /request, override rules and requester choices', () => {
  async function requestWithRule(permissions: number) {
    configureRadarr([{ id: 1, isDefault: true, is4k: false }]);
    getSettings().sonarr = [];

    const userRepo = getRepository(User);
    const requester = await userRepo.findOneOrFail({
      where: { email: 'demo@seerr.dev' },
    });
    requester.permissions = permissions;
    await userRepo.save(requester);

    await getRepository(OverrideRule).save(
      new OverrideRule({
        radarrServiceId: 1,
        rootFolder: '/rule',
        profileId: 7,
        tags: '2',
      })
    );

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    return agent.post('/request').send({
      mediaType: MediaType.MOVIE,
      mediaId: 88010,
      serverId: 1,
      rootFolder: '/chosen',
      tags: [],
    });
  }

  it('keeps what an advanced requester sets and fills the rest from the rule', async () => {
    const res = await requestWithRule(
      Permission.REQUEST | Permission.REQUEST_ADVANCED
    );

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.rootFolder, '/chosen');
    assert.strictEqual(res.body.profileId, 7);
    assert.deepStrictEqual(res.body.tags, []);
  });

  it('keeps what a request manager sets and fills the rest from the rule', async (t) => {
    // Manage Requests auto-approves; keep it from calling Radarr
    t.mock.method(
      MediaRequestSubscriber.prototype,
      'sendToRadarr',
      async () => undefined
    );
    const res = await requestWithRule(
      Permission.REQUEST | Permission.MANAGE_REQUESTS
    );

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.rootFolder, '/chosen');
    assert.strictEqual(res.body.profileId, 7);
    assert.deepStrictEqual(res.body.tags, []);
  });

  it('applies the rule over what a regular requester sets', async () => {
    const res = await requestWithRule(Permission.REQUEST);

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.rootFolder, '/rule');
  });
});

describe('POST /request, advanced options', () => {
  it('ignores advanced options on a movie request from a regular requester', async () => {
    configureRadarr([{ id: 1, isDefault: true, is4k: false }, { id: 2 }]);
    getSettings().sonarr = [];

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.post('/request').send({
      mediaType: MediaType.MOVIE,
      mediaId: 88020,
      ...movieOptions,
    });

    assert.strictEqual(res.status, 201);

    const saved = await getRepository(MediaRequest).findOneOrFail({
      where: { id: res.body.id },
    });
    assert.deepStrictEqual(storedOptions(saved), noOptions);
  });

  it('ignores advanced options on a series request from a regular requester', async () => {
    configureSonarr([{ id: 1, isDefault: true, is4k: false }, { id: 2 }]);
    getSettings().radarr = [];

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.post('/request').send({
      mediaType: MediaType.TV,
      mediaId: 88021,
      seasons: [1],
      ...tvOptions,
    });

    assert.strictEqual(res.status, 201);

    const saved = await getRepository(MediaRequest).findOneOrFail({
      where: { id: res.body.id },
    });
    assert.deepStrictEqual(storedOptions(saved), noOptions);
  });

  it('ignores a 4K server and its options on a non-4K request', async () => {
    configureRadarr([
      { id: 1, isDefault: true, is4k: false },
      { id: 2, isDefault: true, is4k: true },
    ]);
    getSettings().sonarr = [];
    await seedUser('demo@seerr.dev', {
      permissions: Permission.REQUEST | Permission.REQUEST_ADVANCED,
    });

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.post('/request').send({
      mediaType: MediaType.MOVIE,
      mediaId: 88022,
      is4k: false,
      ...movieOptions,
    });

    assert.strictEqual(res.status, 201);

    const saved = await getRepository(MediaRequest).findOneOrFail({
      where: { id: res.body.id },
    });
    assert.deepStrictEqual(storedOptions(saved), noOptions);
  });

  it('keeps advanced options from an advanced requester', async () => {
    configureSonarr([{ id: 1, isDefault: true, is4k: false }, { id: 2 }]);
    getSettings().radarr = [];
    await seedUser('demo@seerr.dev', {
      permissions: Permission.REQUEST | Permission.REQUEST_ADVANCED,
    });

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.post('/request').send({
      mediaType: MediaType.TV,
      mediaId: 88023,
      seasons: [1],
      ...tvOptions,
    });

    assert.strictEqual(res.status, 201);

    const saved = await getRepository(MediaRequest).findOneOrFail({
      where: { id: res.body.id },
    });
    assert.deepStrictEqual(storedOptions(saved), tvOptions);
  });

  it('keeps advanced options when the serverId is null', async () => {
    configureRadarr([{ id: 1, isDefault: true, is4k: false }]);
    getSettings().sonarr = [];
    await seedUser('demo@seerr.dev', {
      permissions: Permission.REQUEST | Permission.REQUEST_ADVANCED,
    });

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.post('/request').send({
      mediaType: MediaType.MOVIE,
      mediaId: 88024,
      ...movieOptions,
      serverId: null,
    });

    assert.strictEqual(res.status, 201);

    const saved = await getRepository(MediaRequest).findOneOrFail({
      where: { id: res.body.id },
    });
    assert.deepStrictEqual(storedOptions(saved), {
      ...movieOptions,
      serverId: null,
      languageProfileId: null,
    });
  });
});

describe('DELETE /request/:requestId, orphaned season status reset', () => {
  // Seeding an approved request sends it to any configured Sonarr
  beforeEach(() => {
    getSettings().sonarr = [];
  });

  async function seedTvShow(
    tmdbId: number,
    seasons: Partial<Season>[]
  ): Promise<Media> {
    const mediaRepo = getRepository(Media);

    return mediaRepo.save(
      new Media({
        mediaType: MediaType.TV,
        tmdbId,
        status: MediaStatus.PROCESSING,
        status4k: MediaStatus.UNKNOWN,
        seasons: seasons.map((season) => new Season(season)),
      })
    );
  }

  async function seedTvRequest(
    media: Media,
    seasonNumbers: number[]
  ): Promise<MediaRequest> {
    const userRepo = getRepository(User);
    const requestRepo = getRepository(MediaRequest);

    const admin = await userRepo.findOneOrFail({
      where: { email: 'admin@seerr.dev' },
    });

    return requestRepo.save(
      new MediaRequest({
        type: MediaType.TV,
        status: MediaRequestStatus.APPROVED,
        media,
        requestedBy: admin,
        is4k: false,
        seasons: seasonNumbers.map(
          (seasonNumber) =>
            new SeasonRequest({
              seasonNumber,
              status: MediaRequestStatus.APPROVED,
            })
        ),
      })
    );
  }

  it('resets a request-covered PROCESSING season to UNKNOWN so it can be re-requested', async () => {
    const mediaRepo = getRepository(Media);
    const media = await seedTvShow(99101, [
      { seasonNumber: 1, status: MediaStatus.PROCESSING },
    ]);
    const tvRequest = await seedTvRequest(media, [1]);

    const admin = await loginAs('admin@seerr.dev', 'test1234');
    const res = await admin.delete(`/request/${tvRequest.id}`);
    assert.strictEqual(res.status, 204);

    const updated = await mediaRepo.findOneOrFail({
      where: { id: media.id },
    });
    assert.strictEqual(updated.seasons[0].status, MediaStatus.UNKNOWN);

    const friend = await loginAs('demo@seerr.dev', 'test1234');
    const reRequest = await friend.post('/request').send({
      mediaType: MediaType.TV,
      mediaId: 99101,
      seasons: [1],
    });
    assert.strictEqual(reRequest.status, 201);
  });

  it('does not touch PROCESSING seasons the deleted request did not cover', async () => {
    const mediaRepo = getRepository(Media);
    const media = await seedTvShow(99102, [
      { seasonNumber: 1, status: MediaStatus.PROCESSING },
      { seasonNumber: 2, status: MediaStatus.PROCESSING },
    ]);
    const tvRequest = await seedTvRequest(media, [1]);

    const admin = await loginAs('admin@seerr.dev', 'test1234');
    const res = await admin.delete(`/request/${tvRequest.id}`);
    assert.strictEqual(res.status, 204);

    const updated = await mediaRepo.findOneOrFail({ where: { id: media.id } });
    const seasonOne = updated.seasons.find((s) => s.seasonNumber === 1);
    const seasonTwo = updated.seasons.find((s) => s.seasonNumber === 2);
    assert.strictEqual(seasonOne?.status, MediaStatus.UNKNOWN);
    assert.strictEqual(seasonTwo?.status, MediaStatus.PROCESSING);
  });

  it('keeps a season PROCESSING while another active request still covers it', async () => {
    const mediaRepo = getRepository(Media);
    const media = await seedTvShow(99103, [
      { seasonNumber: 1, status: MediaStatus.PROCESSING },
    ]);
    const firstRequest = await seedTvRequest(media, [1]);
    await seedTvRequest(media, [1]);

    const admin = await loginAs('admin@seerr.dev', 'test1234');
    const res = await admin.delete(`/request/${firstRequest.id}`);
    assert.strictEqual(res.status, 204);

    const updated = await mediaRepo.findOneOrFail({ where: { id: media.id } });
    assert.strictEqual(updated.seasons[0].status, MediaStatus.PROCESSING);
  });

  it('leaves season status4k untouched when deleting a non-4K request', async () => {
    const mediaRepo = getRepository(Media);
    const media = await seedTvShow(99104, [
      {
        seasonNumber: 1,
        status: MediaStatus.PROCESSING,
        status4k: MediaStatus.PROCESSING,
      },
    ]);
    const tvRequest = await seedTvRequest(media, [1]);

    const admin = await loginAs('admin@seerr.dev', 'test1234');
    const res = await admin.delete(`/request/${tvRequest.id}`);
    assert.strictEqual(res.status, 204);

    const updated = await mediaRepo.findOneOrFail({ where: { id: media.id } });
    assert.strictEqual(updated.seasons[0].status, MediaStatus.UNKNOWN);
    assert.strictEqual(updated.seasons[0].status4k, MediaStatus.PROCESSING);
  });
});

describe('POST /request, blocked streaming providers', () => {
  const netflixMovie = (movieId: number) =>
    ({
      ...fakeTmdbMovie(movieId),
      'watch/providers': {
        results: {
          US: {
            flatrate: [
              { provider_id: 8, provider_name: 'Netflix' },
              { provider_id: 538, provider_name: 'Plex' },
            ],
          },
        },
      },
    }) as unknown as TmdbMovieDetails;

  beforeEach(() => {
    configureRadarr([{ id: 0, isDefault: true, is4k: false }]);
    getSettings().sonarr = [];
    getSettings().main.streamingRegion = 'US';
  });

  it('refuses a title streaming on a blocked provider', async (t) => {
    const priorImpl = getMovieImpl;
    getMovieImpl = async ({ movieId }) => netflixMovie(movieId);
    getSettings().main.blockedWatchProviders = '8|1796';
    t.after(() => {
      getMovieImpl = priorImpl;
      getSettings().main.blockedWatchProviders = '';
    });

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.post('/request').send({
      mediaType: MediaType.MOVIE,
      mediaId: 89001,
    });

    assert.strictEqual(res.status, 403);
    assert.match(res.body.message, /Netflix/);
  });

  it('allows a title whose only provider is not blocked', async (t) => {
    const priorImpl = getMovieImpl;
    getMovieImpl = async ({ movieId }) => netflixMovie(movieId);
    getSettings().main.blockedWatchProviders = '337';
    t.after(() => {
      getMovieImpl = priorImpl;
      getSettings().main.blockedWatchProviders = '';
    });

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.post('/request').send({
      mediaType: MediaType.MOVIE,
      mediaId: 89002,
    });

    assert.strictEqual(res.status, 201);
  });

  it('lets a manager request a blocked title by hand', async (t) => {
    const priorImpl = getMovieImpl;
    getMovieImpl = async ({ movieId }) => netflixMovie(movieId);
    getSettings().main.blockedWatchProviders = '8';
    t.after(() => {
      getMovieImpl = priorImpl;
      getSettings().main.blockedWatchProviders = '';
    });

    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.post('/request').send({
      mediaType: MediaType.MOVIE,
      mediaId: 89003,
    });

    assert.strictEqual(res.status, 201);
  });
});

describe('POST /request, content rating limits', () => {
  const ratedMovie = (movieId: number, certification: string) =>
    ({
      ...fakeTmdbMovie(movieId),
      release_dates: {
        results: [
          {
            iso_3166_1: 'US',
            release_dates: [
              {
                certification,
                release_date: '2020-01-01T00:00:00.000Z',
                type: 3,
              },
            ],
          },
        ],
      },
    }) as unknown as TmdbMovieDetails;

  const ratedShow = (tvId: number, rating: string) =>
    ({
      ...fakeTmdbShow(tvId),
      name: 'Rated Show',
      seasons: [{ season_number: 1, episode_count: 10 }],
      content_ratings: { results: [{ iso_3166_1: 'US', rating }] },
    }) as unknown as TmdbTvDetails;

  const setRatingLimits = async (
    email: string,
    limits: Pick<User, 'movieRatingLimit' | 'tvRatingLimit'>
  ) => {
    const userRepo = getRepository(User);
    const user = await userRepo.findOneOrFail({ where: { email } });
    Object.assign(user, limits);
    await userRepo.save(user);
  };

  beforeEach(() => {
    configureRadarr([{ id: 0, isDefault: true, is4k: false }]);
    configureSonarr([{ id: 0, isDefault: true, is4k: false }]);
  });

  it('refuses a movie rated above the user limit', async (t) => {
    const priorImpl = getMovieImpl;
    getMovieImpl = async ({ movieId }) => ratedMovie(movieId, 'R');
    t.after(() => {
      getMovieImpl = priorImpl;
    });
    await setRatingLimits('demo@seerr.dev', { movieRatingLimit: 'PG-13' });

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.post('/request').send({
      mediaType: MediaType.MOVIE,
      mediaId: 89101,
    });

    assert.strictEqual(res.status, 403);
    assert.match(res.body.message, /rated R/);
  });

  it('allows a movie at the user limit', async (t) => {
    const priorImpl = getMovieImpl;
    getMovieImpl = async ({ movieId }) => ratedMovie(movieId, 'PG-13');
    t.after(() => {
      getMovieImpl = priorImpl;
    });
    await setRatingLimits('demo@seerr.dev', { movieRatingLimit: 'PG-13' });

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.post('/request').send({
      mediaType: MediaType.MOVIE,
      mediaId: 89102,
    });

    assert.strictEqual(res.status, 201);
  });

  it('allows a movie without a US rating', async (t) => {
    const priorImpl = getMovieImpl;
    getMovieImpl = async ({ movieId }) => ratedMovie(movieId, 'NR');
    t.after(() => {
      getMovieImpl = priorImpl;
    });
    await setRatingLimits('demo@seerr.dev', { movieRatingLimit: 'G' });

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.post('/request').send({
      mediaType: MediaType.MOVIE,
      mediaId: 89103,
    });

    assert.strictEqual(res.status, 201);
  });

  it('lets a manager request a title above their limit by hand', async (t) => {
    const priorImpl = getMovieImpl;
    getMovieImpl = async ({ movieId }) => ratedMovie(movieId, 'NC-17');
    t.after(() => {
      getMovieImpl = priorImpl;
    });
    await setRatingLimits('admin@seerr.dev', { movieRatingLimit: 'PG' });

    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.post('/request').send({
      mediaType: MediaType.MOVIE,
      mediaId: 89104,
    });

    assert.strictEqual(res.status, 201);
  });

  it('refuses a series rated above the user limit', async (t) => {
    const priorImpl = getTvShowImpl;
    getTvShowImpl = async ({ tvId }) => ratedShow(tvId, 'TV-MA');
    t.after(() => {
      getTvShowImpl = priorImpl;
    });
    await setRatingLimits('demo@seerr.dev', { tvRatingLimit: 'TV-PG' });

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.post('/request').send({
      mediaType: MediaType.TV,
      mediaId: 89105,
      seasons: [1],
    });

    assert.strictEqual(res.status, 403);
    assert.match(res.body.message, /rated TV-MA/);
  });
});

describe('POST /request, auto-approve rules', () => {
  const showWithSeasons = (tvId: number) =>
    ({
      ...fakeTmdbShow(tvId),
      name: 'Multi-Season Show',
      seasons: [
        { season_number: 1, episode_count: 10 },
        { season_number: 2, episode_count: 10 },
      ],
    }) as unknown as TmdbTvDetails;

  const getDemoUser = () =>
    getRepository(User).findOneOrFail({ where: { email: 'demo@seerr.dev' } });

  const waitForNotification = async (type: Notification) => {
    await settleTestBackgroundTasks();
    for (let i = 0; i < 50; i++) {
      if (
        sendNotificationMock.calls.some((call) => call.arguments[2] === type)
      ) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return false;
  };

  let arrMocks: { mock: { restore: () => void } }[] = [];

  beforeEach(() => {
    configureRadarr([{ id: 0, isDefault: true, is4k: false }]);
    configureSonarr([{ id: 0, isDefault: true, is4k: false }]);
    arrMocks = [
      mock.method(
        MediaRequestSubscriber.prototype,
        'sendToRadarr',
        async () => undefined
      ),
      mock.method(
        MediaRequestSubscriber.prototype,
        'sendToSonarr',
        async () => undefined
      ),
    ];
  });

  afterEach(() => {
    arrMocks.forEach((arrMock) => arrMock.mock.restore());
  });

  it('approves a matching request for a user without the permission', async () => {
    const demo = await getDemoUser();
    await getRepository(OverrideRule).save(
      new OverrideRule({
        radarrServiceId: 0,
        users: String(demo.id),
        autoApprove: true,
      })
    );

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.post('/request').send({
      mediaType: MediaType.MOVIE,
      mediaId: 89201,
    });

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.status, MediaRequestStatus.APPROVED);
    assert.ok(await waitForNotification(Notification.MEDIA_AUTO_APPROVED));
  });

  it('leaves a request pending when no rule matches', async () => {
    const admin = await getRepository(User).findOneOrFail({
      where: { email: 'admin@seerr.dev' },
    });
    await getRepository(OverrideRule).save(
      new OverrideRule({
        radarrServiceId: 0,
        users: String(admin.id),
        autoApprove: true,
      })
    );

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.post('/request').send({
      mediaType: MediaType.MOVIE,
      mediaId: 89202,
    });

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.status, MediaRequestStatus.PENDING);
  });

  it('leaves a request pending when the matching rule does not auto-approve', async () => {
    const demo = await getDemoUser();
    await getRepository(OverrideRule).save(
      new OverrideRule({
        radarrServiceId: 0,
        users: String(demo.id),
        rootFolder: '/rule',
      })
    );

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.post('/request').send({
      mediaType: MediaType.MOVIE,
      mediaId: 89203,
    });

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.status, MediaRequestStatus.PENDING);
    assert.strictEqual(res.body.rootFolder, '/rule');
  });

  it('does not let an auto-approve rule hide the settings of another rule', async () => {
    const demo = await getDemoUser();
    await getRepository(OverrideRule).save([
      new OverrideRule({
        radarrServiceId: 0,
        users: String(demo.id),
        rootFolder: '/rule',
      }),
      new OverrideRule({
        radarrServiceId: 0,
        users: String(demo.id),
        language: 'en',
        autoApprove: true,
      }),
    ]);

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.post('/request').send({
      mediaType: MediaType.MOVIE,
      mediaId: 89204,
    });

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.status, MediaRequestStatus.APPROVED);
    assert.strictEqual(res.body.rootFolder, '/rule');
  });

  it('does not bypass a blocked streaming provider', async (t) => {
    const priorImpl = getMovieImpl;
    getMovieImpl = async ({ movieId }) =>
      ({
        ...fakeTmdbMovie(movieId),
        'watch/providers': {
          results: {
            US: { flatrate: [{ provider_id: 8, provider_name: 'Netflix' }] },
          },
        },
      }) as unknown as TmdbMovieDetails;
    getSettings().main.streamingRegion = 'US';
    getSettings().main.blockedWatchProviders = '8';
    t.after(() => {
      getMovieImpl = priorImpl;
      getSettings().main.blockedWatchProviders = '';
    });

    const demo = await getDemoUser();
    await getRepository(OverrideRule).save(
      new OverrideRule({
        radarrServiceId: 0,
        users: String(demo.id),
        autoApprove: true,
      })
    );

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.post('/request').send({
      mediaType: MediaType.MOVIE,
      mediaId: 89205,
    });

    assert.strictEqual(res.status, 403);
    assert.match(res.body.message, /Netflix/);
    assert.strictEqual(await getRepository(MediaRequest).count(), 0);
  });

  it('does not bypass the request quota', async () => {
    const demo = await getDemoUser();
    demo.movieQuotaLimit = 1;
    demo.movieQuotaDays = 7;
    await getRepository(User).save(demo);
    await getRepository(OverrideRule).save(
      new OverrideRule({
        radarrServiceId: 0,
        users: String(demo.id),
        autoApprove: true,
      })
    );

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const first = await agent.post('/request').send({
      mediaType: MediaType.MOVIE,
      mediaId: 89206,
    });
    const second = await agent.post('/request').send({
      mediaType: MediaType.MOVIE,
      mediaId: 89207,
    });

    assert.strictEqual(first.status, 201);
    assert.strictEqual(first.body.status, MediaRequestStatus.APPROVED);
    assert.strictEqual(second.status, 403);
    assert.match(second.body.message, /Quota exceeded/);
  });

  it('approves a series request within the season limit', async (t) => {
    const priorImpl = getTvShowImpl;
    getTvShowImpl = async ({ tvId }) => showWithSeasons(tvId);
    t.after(() => {
      getTvShowImpl = priorImpl;
    });

    await getRepository(OverrideRule).save(
      new OverrideRule({
        sonarrServiceId: 0,
        language: 'en',
        autoApprove: true,
        maxSeasons: 1,
      })
    );

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const single = await agent.post('/request').send({
      mediaType: MediaType.TV,
      mediaId: 89208,
      seasons: [1],
    });
    const multiple = await agent.post('/request').send({
      mediaType: MediaType.TV,
      mediaId: 89209,
      seasons: [1, 2],
    });

    assert.strictEqual(single.status, 201);
    assert.strictEqual(single.body.status, MediaRequestStatus.APPROVED);
    assert.deepStrictEqual(
      single.body.seasons.map((season: SeasonRequest) => season.status),
      [MediaRequestStatus.APPROVED]
    );
    assert.strictEqual(multiple.status, 201);
    assert.strictEqual(multiple.body.status, MediaRequestStatus.PENDING);
  });

  it('only approves a 4K request through a rule on a 4K service', async () => {
    configureRadarr([
      { id: 0, isDefault: true, is4k: false },
      { id: 1, isDefault: true, is4k: true },
    ]);

    const demo = await getDemoUser();
    demo.permissions = Permission.REQUEST | Permission.REQUEST_4K;
    await getRepository(User).save(demo);
    await getRepository(OverrideRule).save(
      new OverrideRule({
        radarrServiceId: 0,
        users: String(demo.id),
        autoApprove: true,
      })
    );

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const before = await agent.post('/request').send({
      mediaType: MediaType.MOVIE,
      mediaId: 89210,
      is4k: true,
    });

    assert.strictEqual(before.status, 201);
    assert.strictEqual(before.body.status, MediaRequestStatus.PENDING);

    await getRepository(OverrideRule).save(
      new OverrideRule({
        radarrServiceId: 1,
        users: String(demo.id),
        autoApprove: true,
      })
    );

    const after = await agent.post('/request').send({
      mediaType: MediaType.MOVIE,
      mediaId: 89211,
      is4k: true,
    });

    assert.strictEqual(after.status, 201);
    assert.strictEqual(after.body.status, MediaRequestStatus.APPROVED);
  });
});

describe('POST /request (tv), episode requests', () => {
  const showWithSeasons = (tvId: number) =>
    ({
      ...fakeTmdbShow(tvId),
      name: 'Episode Show',
      external_ids: { tvdb_id: 5000 + tvId },
      seasons: [
        { season_number: 1, episode_count: 8, air_date: '2020-01-01' },
        { season_number: 2, episode_count: 8, air_date: '2021-01-01' },
      ],
    }) as unknown as TmdbTvDetails;

  let addSeriesCalls: AddSeriesOptions[] = [];
  let addSeriesMock: { mock: { restore: () => void } };

  beforeEach(() => {
    getTvShowImpl = async ({ tvId }) => showWithSeasons(tvId);
    getSettings().radarr = [];
    configureSonarr([{ id: 0, isDefault: true, is4k: false }]);
    addSeriesCalls = [];
    addSeriesMock = mock.method(
      SonarrAPI.prototype,
      'addSeries',
      async (options: AddSeriesOptions) => {
        addSeriesCalls.push(options);
        return { id: 9, titleSlug: 'episode-show' };
      }
    );
  });

  afterEach(() => {
    addSeriesMock.mock.restore();
    getTvShowImpl = async ({ tvId }) => fakeTmdbShow(tvId);
    getSettings().main.partialRequestsEnabled = true;
  });

  it('stores the requested episodes on their season', async () => {
    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.post('/request').send({
      mediaType: MediaType.TV,
      mediaId: 89301,
      seasons: [1],
      episodes: [{ seasonNumber: 2, episodeNumbers: [5, 3, 3] }],
    });

    assert.strictEqual(res.status, 201);

    const saved = await getRepository(MediaRequest).findOneOrFail({
      where: { id: res.body.id },
    });
    assert.deepStrictEqual(
      saved.seasons.map((season) => [season.seasonNumber, season.episodes]),
      [
        [1, null],
        [2, [3, 5]],
      ]
    );
    assert.strictEqual(saved.monitorMode, null);
  });

  it('sends only the requested episodes to Sonarr', async () => {
    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.post('/request').send({
      mediaType: MediaType.TV,
      mediaId: 89302,
      seasons: [1],
      episodes: [{ seasonNumber: 2, episodeNumbers: [3, 5] }],
    });

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.status, MediaRequestStatus.APPROVED);
    assert.strictEqual(addSeriesCalls.length, 1);
    assert.strictEqual(addSeriesCalls[0].tvdbid, 94302);
    assert.deepStrictEqual(addSeriesCalls[0].seasons, [1]);
    assert.deepStrictEqual(addSeriesCalls[0].episodes, [
      { seasonNumber: 2, episodeNumbers: [3, 5] },
    ]);
    assert.strictEqual(addSeriesCalls[0].monitor, undefined);
    assert.strictEqual(addSeriesCalls[0].searchNow, true);
  });

  it('lets another request take the episodes that are still free', async () => {
    const first = await (await loginAs('demo@seerr.dev', 'test1234'))
      .post('/request')
      .send({
        mediaType: MediaType.TV,
        mediaId: 89303,
        episodes: [{ seasonNumber: 1, episodeNumbers: [1, 2] }],
      });
    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const second = await agent.post('/request').send({
      mediaType: MediaType.TV,
      mediaId: 89303,
      episodes: [{ seasonNumber: 1, episodeNumbers: [2, 3] }],
    });
    const wholeSeason = await agent.post('/request').send({
      mediaType: MediaType.TV,
      mediaId: 89303,
      seasons: [1],
    });

    assert.strictEqual(first.status, 201);
    assert.strictEqual(second.status, 201);
    assert.deepStrictEqual(second.body.seasons[0].episodes, [3]);
    assert.strictEqual(wholeSeason.status, 202);
  });

  it('allows episodes of a partially available season', async () => {
    await seedMediaSeasons(89304, [
      { seasonNumber: 1, status: MediaStatus.PARTIALLY_AVAILABLE },
      { seasonNumber: 2, status: MediaStatus.AVAILABLE },
    ]);

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.post('/request').send({
      mediaType: MediaType.TV,
      mediaId: 89304,
      episodes: [
        { seasonNumber: 1, episodeNumbers: [4] },
        { seasonNumber: 2, episodeNumbers: [4] },
      ],
    });

    assert.strictEqual(res.status, 201);
    assert.deepStrictEqual(
      res.body.seasons.map((season: SeasonRequest) => season.seasonNumber),
      [1]
    );
  });

  it('counts an episode request as one season against the quota', async () => {
    await seedUser('demo@seerr.dev', { tvQuotaLimit: 1, tvQuotaDays: 7 });

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const tooMany = await agent.post('/request').send({
      mediaType: MediaType.TV,
      mediaId: 89305,
      episodes: [
        { seasonNumber: 1, episodeNumbers: [1] },
        { seasonNumber: 2, episodeNumbers: [1] },
      ],
    });
    const single = await agent.post('/request').send({
      mediaType: MediaType.TV,
      mediaId: 89305,
      episodes: [{ seasonNumber: 1, episodeNumbers: [1, 2, 3] }],
    });
    const quota = await (
      await getRepository(User).findOneOrFail({
        where: { email: 'demo@seerr.dev' },
      })
    ).getQuota();

    assert.strictEqual(tooMany.status, 403);
    assert.match(tooMany.body.message, /Quota exceeded/);
    assert.strictEqual(single.status, 201);
    assert.strictEqual(quota.tv.used, 1);
  });

  it('counts an episode request by its seasons for auto-approve rules', async () => {
    const demo = await getRepository(User).findOneOrFail({
      where: { email: 'demo@seerr.dev' },
    });
    await getRepository(OverrideRule).save(
      new OverrideRule({
        sonarrServiceId: 0,
        users: String(demo.id),
        autoApprove: true,
        maxSeasons: 1,
      })
    );

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const single = await agent.post('/request').send({
      mediaType: MediaType.TV,
      mediaId: 89306,
      episodes: [{ seasonNumber: 1, episodeNumbers: [1, 2, 3, 4] }],
    });
    const multiple = await agent.post('/request').send({
      mediaType: MediaType.TV,
      mediaId: 89307,
      episodes: [
        { seasonNumber: 1, episodeNumbers: [1] },
        { seasonNumber: 2, episodeNumbers: [1] },
      ],
    });

    assert.strictEqual(single.body.status, MediaRequestStatus.APPROVED);
    assert.strictEqual(multiple.body.status, MediaRequestStatus.PENDING);
  });

  it('refuses episodes when partial series requests are disabled', async () => {
    getSettings().main.partialRequestsEnabled = false;

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.post('/request').send({
      mediaType: MediaType.TV,
      mediaId: 89308,
      episodes: [{ seasonNumber: 1, episodeNumbers: [1] }],
    });

    assert.strictEqual(res.status, 403);
    assert.strictEqual(await getRepository(MediaRequest).count(), 0);
  });

  it('replaces the episodes of a season when a pending request is edited', async () => {
    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const created = await agent.post('/request').send({
      mediaType: MediaType.TV,
      mediaId: 89309,
      episodes: [{ seasonNumber: 1, episodeNumbers: [1, 2] }],
    });
    const edited = await agent.put(`/request/${created.body.id}`).send({
      mediaType: MediaType.TV,
      seasons: [2],
      episodes: [{ seasonNumber: 1, episodeNumbers: [4] }],
    });

    assert.strictEqual(edited.status, 200);

    const saved = await getRepository(MediaRequest).findOneOrFail({
      where: { id: created.body.id },
    });
    assert.deepStrictEqual(
      saved.seasons.map((season) => [season.seasonNumber, season.episodes]),
      [
        [1, [4]],
        [2, null],
      ]
    );
  });
});

describe('POST /request (tv), future seasons only', () => {
  const airingShow = (tvId: number) =>
    ({
      ...fakeTmdbShow(tvId),
      name: 'Airing Show',
      external_ids: { tvdb_id: 6000 + tvId },
      last_episode_to_air: { season_number: 3 },
      next_episode_to_air: { season_number: 3 },
      seasons: [
        { season_number: 0, episode_count: 2, air_date: '2019-01-01' },
        { season_number: 1, episode_count: 8, air_date: '2020-01-01' },
        { season_number: 2, episode_count: 8, air_date: '2021-01-01' },
        { season_number: 3, episode_count: 8, air_date: '2026-01-01' },
        { season_number: 4, episode_count: 0, air_date: null },
      ],
    }) as unknown as TmdbTvDetails;

  let addSeriesCalls: AddSeriesOptions[] = [];
  let addSeriesMock: { mock: { restore: () => void } };

  beforeEach(() => {
    getTvShowImpl = async ({ tvId }) => airingShow(tvId);
    getSettings().radarr = [];
    configureSonarr([{ id: 0, isDefault: true, is4k: false }]);
    addSeriesCalls = [];
    addSeriesMock = mock.method(
      SonarrAPI.prototype,
      'addSeries',
      async (options: AddSeriesOptions) => {
        addSeriesCalls.push(options);
        return { id: 9, titleSlug: 'airing-show' };
      }
    );
  });

  afterEach(() => {
    addSeriesMock.mock.restore();
    getTvShowImpl = async ({ tvId }) => fakeTmdbShow(tvId);
  });

  it('requests only the airing and announced seasons', async () => {
    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.post('/request').send({
      mediaType: MediaType.TV,
      mediaId: 89401,
      seasons: [1],
      monitorMode: MediaRequestMonitorMode.FUTURE,
    });

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.monitorMode, MediaRequestMonitorMode.FUTURE);
    assert.deepStrictEqual(
      res.body.seasons.map((season: SeasonRequest) => season.seasonNumber),
      [3, 4]
    );
  });

  it('tells Sonarr to monitor future episodes without a search', async () => {
    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.post('/request').send({
      mediaType: MediaType.TV,
      mediaId: 89402,
      monitorMode: MediaRequestMonitorMode.FUTURE,
    });

    assert.strictEqual(res.status, 201);
    assert.strictEqual(addSeriesCalls.length, 1);
    assert.strictEqual(addSeriesCalls[0].monitor, 'future');
    assert.strictEqual(addSeriesCalls[0].searchNow, false);
    assert.deepStrictEqual(addSeriesCalls[0].seasons, [3, 4]);
    assert.strictEqual(addSeriesCalls[0].episodes, undefined);
  });

  it('returns 202 when the series has nothing left to air', async () => {
    getTvShowImpl = async ({ tvId }) =>
      ({
        ...airingShow(tvId),
        last_episode_to_air: { season_number: 2 },
        next_episode_to_air: undefined,
        seasons: airingShow(tvId).seasons.slice(0, 3),
      }) as unknown as TmdbTvDetails;

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.post('/request').send({
      mediaType: MediaType.TV,
      mediaId: 89403,
      monitorMode: MediaRequestMonitorMode.FUTURE,
    });

    assert.strictEqual(res.status, 202);
  });
});

describe('POST /request (tv), current season only', () => {
  const talkShow = (tvId: number) =>
    ({
      ...fakeTmdbShow(tvId),
      name: 'Talk Show',
      external_ids: { tvdb_id: 7000 + tvId },
      last_episode_to_air: { season_number: 3 },
      // The next season is announced, but season 3 is still current
      next_episode_to_air: { season_number: 4 },
      seasons: [
        { season_number: 0, episode_count: 2, air_date: '2019-01-01' },
        { season_number: 1, episode_count: 8, air_date: '2020-01-01' },
        { season_number: 2, episode_count: 8, air_date: '2021-01-01' },
        { season_number: 3, episode_count: 8, air_date: '2026-01-01' },
        { season_number: 4, episode_count: 0, air_date: '2099-01-01' },
      ],
    }) as unknown as TmdbTvDetails;

  let addSeriesCalls: AddSeriesOptions[] = [];
  let addSeriesMock: { mock: { restore: () => void } };

  beforeEach(() => {
    getTvShowImpl = async ({ tvId }) => talkShow(tvId);
    getSettings().radarr = [];
    getSettings().main.allowCurrentSeasonRequests = true;
    configureSonarr([{ id: 0, isDefault: true, is4k: false }]);
    addSeriesCalls = [];
    addSeriesMock = mock.method(
      SonarrAPI.prototype,
      'addSeries',
      async (options: AddSeriesOptions) => {
        addSeriesCalls.push(options);
        return { id: 9, titleSlug: 'talk-show' };
      }
    );
  });

  afterEach(() => {
    addSeriesMock.mock.restore();
    getTvShowImpl = async ({ tvId }) => fakeTmdbShow(tvId);
    getSettings().main.allowCurrentSeasonRequests = false;
    getSettings().main.partialRequestsEnabled = true;
  });

  it('requests only the season with the latest aired episode', async () => {
    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.post('/request').send({
      mediaType: MediaType.TV,
      mediaId: 89501,
      seasons: [1, 2],
      monitorMode: MediaRequestMonitorMode.CURRENT,
    });

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.monitorMode, MediaRequestMonitorMode.CURRENT);
    assert.deepStrictEqual(
      res.body.seasons.map((season: SeasonRequest) => [
        season.seasonNumber,
        season.episodes,
      ]),
      [[3, null]]
    );
  });

  it('tells Sonarr to monitor and search the current season and follow new ones', async () => {
    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.post('/request').send({
      mediaType: MediaType.TV,
      mediaId: 89502,
      monitorMode: MediaRequestMonitorMode.CURRENT,
    });

    assert.strictEqual(res.status, 201);
    assert.strictEqual(addSeriesCalls.length, 1);
    assert.deepStrictEqual(addSeriesCalls[0].seasons, [3]);
    assert.strictEqual(addSeriesCalls[0].monitor, undefined);
    assert.strictEqual(addSeriesCalls[0].monitorNewSeasons, true);
    assert.strictEqual(addSeriesCalls[0].searchNow, true);
    assert.strictEqual(addSeriesCalls[0].episodes, undefined);
  });

  it('works without partial series requests', async () => {
    getSettings().main.partialRequestsEnabled = false;

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.post('/request').send({
      mediaType: MediaType.TV,
      mediaId: 89503,
      monitorMode: MediaRequestMonitorMode.CURRENT,
    });

    assert.strictEqual(res.status, 201);
  });

  it('refuses current season requests from users when they are turned off', async () => {
    getSettings().main.allowCurrentSeasonRequests = false;

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.post('/request').send({
      mediaType: MediaType.TV,
      mediaId: 89504,
      monitorMode: MediaRequestMonitorMode.CURRENT,
    });

    assert.strictEqual(res.status, 403);
    assert.strictEqual(addSeriesCalls.length, 0);
    assert.strictEqual(await getRepository(MediaRequest).count(), 0);
  });

  it('lets managers request the current season when users cannot', async () => {
    getSettings().main.allowCurrentSeasonRequests = false;

    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.post('/request').send({
      mediaType: MediaType.TV,
      mediaId: 89504,
      monitorMode: MediaRequestMonitorMode.CURRENT,
    });

    assert.strictEqual(res.status, 201);
    const request = await getRepository(MediaRequest).findOneOrFail({
      where: { id: res.body.id },
    });
    assert.strictEqual(request.monitorMode, MediaRequestMonitorMode.CURRENT);
    // Nothing was on the server yet
    assert.deepStrictEqual(request.preexistingSeasons, []);
  });

  it('returns 202 when the current season is already requested', async () => {
    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const first = await agent.post('/request').send({
      mediaType: MediaType.TV,
      mediaId: 89505,
      seasons: [3],
    });
    const res = await agent.post('/request').send({
      mediaType: MediaType.TV,
      mediaId: 89505,
      monitorMode: MediaRequestMonitorMode.CURRENT,
    });

    assert.strictEqual(first.status, 201);
    assert.strictEqual(res.status, 202);
  });

  it('switches a pending request to the current season on edit', async () => {
    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const created = await agent.post('/request').send({
      mediaType: MediaType.TV,
      mediaId: 89506,
      seasons: [1],
    });
    const edited = await agent.put(`/request/${created.body.id}`).send({
      mediaType: MediaType.TV,
      seasons: [],
      monitorMode: MediaRequestMonitorMode.CURRENT,
    });

    assert.strictEqual(edited.status, 200);

    const saved = await getRepository(MediaRequest).findOneOrFail({
      where: { id: created.body.id },
    });
    assert.strictEqual(saved.monitorMode, MediaRequestMonitorMode.CURRENT);
    assert.deepStrictEqual(saved.preexistingSeasons, []);
    assert.deepStrictEqual(
      saved.seasons.map((season) => season.seasonNumber),
      [3]
    );
  });

  it('keeps a request on the current season when an edit leaves out the mode', async () => {
    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const created = await agent.post('/request').send({
      mediaType: MediaType.TV,
      mediaId: 89507,
      monitorMode: MediaRequestMonitorMode.CURRENT,
    });
    const edited = await agent.put(`/request/${created.body.id}`).send({
      mediaType: MediaType.TV,
      seasons: [],
    });

    assert.strictEqual(edited.status, 200);

    const saved = await getRepository(MediaRequest).findOneOrFail({
      where: { id: created.body.id },
    });
    assert.strictEqual(saved.monitorMode, MediaRequestMonitorMode.CURRENT);
  });

  it('refuses switching to the current season when it is turned off', async () => {
    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const created = await agent.post('/request').send({
      mediaType: MediaType.TV,
      mediaId: 89508,
      seasons: [1],
    });
    getSettings().main.allowCurrentSeasonRequests = false;
    const edited = await agent.put(`/request/${created.body.id}`).send({
      mediaType: MediaType.TV,
      seasons: [],
      monitorMode: MediaRequestMonitorMode.CURRENT,
    });

    assert.strictEqual(edited.status, 403);
  });
});
