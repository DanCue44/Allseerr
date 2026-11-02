import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, before, beforeEach, describe, it, mock } from 'node:test';

import type { ChaptarrQueueItem } from '@server/api/servarr/chaptarr';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import MediaRequest from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import { clearAttentionCache } from '@server/lib/nobookendsAttention';
import { Permission } from '@server/lib/permissions';
import type { ChaptarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { stuckDownloadMonitor } from '@server/lib/stuckBookDownloads';
import { STUCK_GRACE_MS } from '@server/lib/stuckDownloads';
import { generateUserApiKey, hashUserApiKey } from '@server/lib/userApiKey';
import { checkUser, isAuthenticated } from '@server/middleware/auth';
import arrActionRoutes from '@server/routes/arrActions';
import nobookendsRoutes from '@server/routes/nobookends';
import { setupTestDb } from '@server/test/db';
import axios from 'axios';
import type { Express } from 'express';
import express from 'express';
import request from 'supertest';

/**
 * Chaptarr is replaced by a fake axios instance that answers from the
 * handlers below and records each call. Nothing reaches the network.
 */
interface ChaptarrCall {
  method: string;
  url: string;
  params?: Record<string, unknown>;
  data?: unknown;
}

let calls: ChaptarrCall[] = [];
let handlers: Record<string, (call: ChaptarrCall) => unknown> = {};

mock.method(axios, 'create', () => {
  const send =
    (method: string) =>
    async (url: string, first?: unknown, second?: unknown) => {
      const withBody = method === 'post' || method === 'put';
      const options = (withBody ? second : first) as
        | { params?: Record<string, unknown>; data?: unknown }
        | undefined;
      const call: ChaptarrCall = {
        method: method.toUpperCase(),
        url,
        params: options?.params,
        data: withBody ? first : options?.data,
      };
      calls.push(call);

      const handler = handlers[`${call.method} ${url}`];
      if (!handler) {
        throw Object.assign(new Error(`No handler for ${call.method} ${url}`), {
          response: { status: 404, data: { message: 'Not found' } },
        });
      }

      return { data: await handler(call) };
    };

  return {
    get: send('get'),
    post: send('post'),
    put: send('put'),
    delete: send('delete'),
    interceptors: {
      request: { use: () => 0 },
      response: { use: () => 0 },
    },
    defaults: { headers: {} },
  };
});

mock.method(MediaRequest, 'sendNotification', async () => undefined);

const readQueue = (): ChaptarrQueueItem[] =>
  JSON.parse(
    readFileSync(
      path.join(__dirname, '../api/servarr/fixtures/chaptarr/queue-stuck.json'),
      'utf8'
    )
  ).records;

const server: ChaptarrSettings = {
  id: 0,
  name: 'Chaptarr',
  hostname: 'chaptarr',
  port: 8789,
  apiKey: 'test-key',
  useSsl: false,
  activeProfileId: 1,
  activeProfileName: 'E-Book',
  activeDirectory: '/ebooks',
  activeMetadataProfileId: 2,
  activeMetadataProfileName: 'Ebook Default',
  tags: [],
  is4k: false,
  isDefault: true,
  syncEnabled: true,
  preventSearch: false,
  tagRequests: false,
  overrideRule: [],
};

const LANTERN_KEY = 'chaptarr:0:SABnzbd_nzo_a1b2c3d4:importblocked';

let app: Express;

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(checkUser);
  app.use('/nobookends', isAuthenticated(), nobookendsRoutes);
  app.use('/media/:mediaId/arr', isAuthenticated(), arrActionRoutes);
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

before(() => {
  app = createApp();
});

setupTestDb();

let queue: ChaptarrQueueItem[] = [];

beforeEach(() => {
  calls = [];
  queue = readQueue();
  handlers = {
    'GET /queue': () => ({ records: queue }),
    'GET /author/7': () => ({ id: 7, authorName: 'Jane Example' }),
    'GET /author/8': () => ({ id: 8, authorName: 'Sam Sample' }),
    'DELETE /queue/1900000001': () => ({}),
    'DELETE /queue/1900000002': () => ({}),
    'POST /command': () => ({}),
  };
  clearAttentionCache();
  stuckDownloadMonitor.reset();
  getSettings().main.bookService = 'chaptarr';
  getSettings().chaptarr = [server];
});

afterEach(() => {
  getSettings().chaptarr = [];
  getSettings().main.bookService = undefined;
});

/**
 * Has the stuck download check see the queue, as the download tracker does,
 * the Lantern Keeper first and the Paper Birds a minute later
 */
const seedStuck = (stuckFor = STUCK_GRACE_MS + 60_000) => {
  const items = readQueue();
  const now = Date.now();
  stuckDownloadMonitor.update('chaptarr:0', [items[0]], now - stuckFor);
  stuckDownloadMonitor.update('chaptarr:0', items, now - stuckFor + 60_000);
};

// The audiobook of The Lantern Keeper, requested by a made up listener
const seedLanternKeeper = async () => {
  const media = await getRepository(Media).save(
    new Media({
      mediaType: MediaType.BOOK,
      olId: 'OL900001W',
      status: MediaStatus.UNKNOWN,
      statusAudio: MediaStatus.PROCESSING,
      serviceId: 0,
      externalServiceIdAudio: 501,
    })
  );
  const listener = await createUser('listener@example.com', Permission.REQUEST);

  // Saved without Chaptarr set up, so it is not sent there
  getSettings().chaptarr = [];
  await getRepository(MediaRequest).save(
    new MediaRequest({
      type: MediaType.BOOK,
      status: MediaRequestStatus.APPROVED,
      media,
      requestedBy: listener.user,
      isAudiobook: true,
    })
  );
  getSettings().chaptarr = [server];

  return media;
};

async function createUser(email: string, permissions: number) {
  const apiKey = generateUserApiKey();
  const user = await getRepository(User).save(
    new User({
      email,
      username: email.split('@')[0],
      avatar: '',
      permissions,
      apiKeyHash: hashUserApiKey(apiKey),
    })
  );

  return { user, apiKey };
}

const manager = () =>
  createUser(
    'manager@example.com',
    Permission.REQUEST | Permission.MANAGE_REQUESTS
  );

describe('GET /nobookends/attention', () => {
  it('lists the stuck downloads, newest first, for managers', async () => {
    seedStuck();
    const media = await seedLanternKeeper();
    const { apiKey } = await manager();

    const res = await request(app)
      .get('/nobookends/attention')
      .set('X-Api-Key', apiKey);

    assert.strictEqual(res.status, 200, res.body.message);
    assert.deepStrictEqual(
      res.body.results.map((item: { title: string }) => item.title),
      ['A Field of Paper Birds', 'The Lantern Keeper']
    );

    const [birds, lantern] = res.body.results;
    assert.deepStrictEqual(
      { ...lantern, since: undefined },
      {
        key: LANTERN_KEY,
        mediaId: media.id,
        olId: 'OL900001W',
        title: 'The Lantern Keeper',
        author: 'Jane Example',
        format: 'audiobook',
        reason:
          'No supported audio or ebook files were found in /downloads/complete/books/Jane.Example.The.Lantern.Keeper.Unabridged.M4B',
        state: 'importblocked',
        since: undefined,
        downloadTitle: 'Jane.Example.The.Lantern.Keeper.Unabridged.M4B',
        requesters: ['listener'],
        canRetryImport: true,
      }
    );
    assert.ok(Date.parse(lantern.since) < Date.parse(birds.since));

    // Not in the app
    assert.strictEqual(birds.mediaId, null);
    assert.strictEqual(birds.olId, null);
    assert.strictEqual(birds.format, 'ebook');
    assert.strictEqual(birds.author, 'Sam Sample');
    assert.strictEqual(birds.state, 'warning');
    assert.deepStrictEqual(birds.requesters, []);
  });

  it('leaves out downloads still in the grace period', async () => {
    seedStuck(STUCK_GRACE_MS / 2);
    const { apiKey } = await manager();

    const res = await request(app)
      .get('/nobookends/attention')
      .set('X-Api-Key', apiKey);

    assert.deepStrictEqual(res.body.results, []);
  });

  it('reads the queue again only after a short while', async () => {
    seedStuck();
    const { apiKey } = await manager();

    await request(app).get('/nobookends/attention').set('X-Api-Key', apiKey);
    await request(app).get('/nobookends/attention').set('X-Api-Key', apiKey);

    assert.strictEqual(calls.filter((call) => call.url === '/queue').length, 1);
  });

  it('is empty when Chaptarr does not answer or is not used', async () => {
    seedStuck();
    const { apiKey } = await manager();
    handlers['GET /queue'] = () => {
      throw new Error('connect ECONNREFUSED 192.168.1.50:8789');
    };

    const down = await request(app)
      .get('/nobookends/attention')
      .set('X-Api-Key', apiKey);
    assert.strictEqual(down.status, 200);
    assert.deepStrictEqual(down.body.results, []);

    clearAttentionCache();
    getSettings().main.bookService = 'lazylibrarian';
    const lazy = await request(app)
      .get('/nobookends/attention')
      .set('X-Api-Key', apiKey);
    assert.deepStrictEqual(lazy.body.results, []);
  });

  it('turns away users who cannot manage requests', async () => {
    seedStuck();
    const { apiKey } = await createUser(
      'reader@example.com',
      Permission.REQUEST
    );

    const list = await request(app)
      .get('/nobookends/attention')
      .set('X-Api-Key', apiKey);
    const dismiss = await request(app)
      .post(`/nobookends/attention/${encodeURIComponent(LANTERN_KEY)}/dismiss`)
      .set('X-Api-Key', apiKey);

    assert.strictEqual(list.status, 403);
    assert.strictEqual(dismiss.status, 403);
    assert.deepStrictEqual(calls, []);
  });
});

describe('POST /nobookends/attention/{key}/dismiss', () => {
  it('removes and blocklists the download, then searches the format again', async () => {
    seedStuck();
    const media = await seedLanternKeeper();
    handlers['GET /book/501'] = () => ({
      id: 501,
      title: 'The Lantern Keeper',
      mediaType: 'audiobook',
      authorId: 7,
      monitored: true,
      audiobookMonitored: true,
    });
    const { apiKey } = await manager();

    const res = await request(app)
      .post(`/nobookends/attention/${encodeURIComponent(LANTERN_KEY)}/dismiss`)
      .set('X-Api-Key', apiKey);

    assert.strictEqual(res.status, 200, res.body.message);
    assert.deepStrictEqual(res.body, {
      removed: true,
      blocklisted: true,
      searched: true,
    });

    const removal = calls.find((call) => call.method === 'DELETE');
    assert.strictEqual(removal?.url, '/queue/1900000001');
    assert.deepStrictEqual(removal?.params, {
      removeFromClient: true,
      blocklist: true,
      skipRedownload: true,
    });
    assert.deepStrictEqual(
      calls.filter((call) => call.url === '/command').at(-1)?.data,
      { name: 'BookSearch', bookIds: [501] }
    );
    // The book is no longer stuck once it left the queue
    queue = queue.filter((item) => item.bookId !== 501);
    const list = await request(app)
      .get('/nobookends/attention')
      .set('X-Api-Key', apiKey);
    assert.deepStrictEqual(
      list.body.results.map((item: { mediaId: number }) => item.mediaId),
      [null]
    );
    assert.notStrictEqual(media.id, null);
  });

  it('keeps the release when asked and searches a book not in the app', async () => {
    seedStuck();
    const { apiKey } = await manager();
    const key = 'chaptarr:0:SABnzbd_nzo_e5f6a7b8:warning';

    const res = await request(app)
      .post(`/nobookends/attention/${encodeURIComponent(key)}/dismiss`)
      .query({ blocklist: 'false' })
      .set('X-Api-Key', apiKey);

    assert.strictEqual(res.status, 200, res.body.message);
    assert.strictEqual(res.body.blocklisted, false);
    assert.strictEqual(res.body.searched, true);
    assert.deepStrictEqual(
      calls.find((call) => call.method === 'DELETE')?.params,
      { removeFromClient: true, blocklist: false, skipRedownload: true }
    );
    assert.deepStrictEqual(
      calls.find((call) => call.url === '/command')?.data,
      { name: 'BookSearch', bookIds: [602] }
    );
  });

  it('retries a stuck import and says the book came in', async () => {
    seedStuck();
    handlers['POST /command'] = () => ({ id: 55 });
    handlers['GET /command/55'] = () => {
      // The import went through, so the download left the queue
      queue = queue.filter(
        (item) => item.downloadId !== 'SABnzbd_nzo_a1b2c3d4'
      );
      return { status: 'completed' };
    };
    const { apiKey } = await manager();

    const res = await request(app)
      .post(
        `/nobookends/attention/${encodeURIComponent(LANTERN_KEY)}/retry-import`
      )
      .set('X-Api-Key', apiKey);

    assert.strictEqual(res.status, 200, res.body.message);
    assert.deepStrictEqual(res.body, { imported: true });
    assert.deepStrictEqual(
      calls.find((call) => call.url === '/command')?.data,
      { name: 'RetryFailedImport', downloadId: 'SABnzbd_nzo_a1b2c3d4' }
    );
    assert.ok(!calls.some((call) => call.method === 'DELETE'));
  });

  it('refuses to retry a download whose import is not stuck', async () => {
    seedStuck();
    const { apiKey } = await manager();
    const key = 'chaptarr:0:SABnzbd_nzo_e5f6a7b8:warning';

    const res = await request(app)
      .post(`/nobookends/attention/${encodeURIComponent(key)}/retry-import`)
      .set('X-Api-Key', apiKey);

    assert.strictEqual(res.status, 409);
    assert.ok(!calls.some((call) => call.url === '/command'));
  });

  it('answers 404 for a download that is no longer stuck', async () => {
    const { apiKey } = await manager();
    queue = [];

    const res = await request(app)
      .post(`/nobookends/attention/${encodeURIComponent(LANTERN_KEY)}/dismiss`)
      .set('X-Api-Key', apiKey);

    assert.strictEqual(res.status, 404);
    assert.ok(!calls.some((call) => call.method === 'DELETE'));
  });

  it('refuses a key that is not a stuck download key', async () => {
    const { apiKey } = await manager();

    const res = await request(app)
      .post('/nobookends/attention/radarr:0:abc/dismiss')
      .set('X-Api-Key', apiKey);

    assert.strictEqual(res.status, 400);
  });

  it('passes on what Chaptarr says when the removal fails', async () => {
    seedStuck();
    const { apiKey } = await manager();
    handlers['DELETE /queue/1900000001'] = () => {
      throw Object.assign(new Error('Request failed with status code 500'), {
        response: { status: 500, data: { message: 'Download client offline' } },
      });
    };

    const res = await request(app)
      .post(`/nobookends/attention/${encodeURIComponent(LANTERN_KEY)}/dismiss`)
      .set('X-Api-Key', apiKey);

    assert.strictEqual(res.status, 502);
    assert.match(res.body.message, /Download client offline/);
    assert.ok(!calls.some((call) => call.url === '/command'));
  });
});

describe('release actions with a personal key', () => {
  it('lets a manager search, list and grab releases of a book format', async () => {
    const media = await seedLanternKeeper();
    handlers['GET /book/501'] = () => ({
      id: 501,
      title: 'The Lantern Keeper',
      mediaType: 'audiobook',
      authorId: 7,
    });
    handlers['GET /release'] = () => ({
      releases: [{ guid: 'm4b', indexerId: 1, approved: true }],
    });
    handlers['POST /release'] = () => ({});
    const { apiKey } = await manager();

    const search = await request(app)
      .post(`/media/${media.id}/arr/search`)
      .set('X-Api-Key', apiKey)
      .send({ bookFormat: 'audiobook' });
    const releases = await request(app)
      .get(`/media/${media.id}/arr/releases`)
      .query({ bookFormat: 'audiobook' })
      .set('X-Api-Key', apiKey);
    const grab = await request(app)
      .post(`/media/${media.id}/arr/grab`)
      .set('X-Api-Key', apiKey)
      .send({ guid: 'm4b', indexerId: 1, bookFormat: 'audiobook' });

    assert.strictEqual(search.status, 200, search.body.message);
    assert.strictEqual(releases.status, 200, releases.body.message);
    assert.deepStrictEqual(
      releases.body.results.map((release: { guid: string }) => release.guid),
      ['m4b']
    );
    assert.strictEqual(grab.status, 200, grab.body.message);
  });

  it('turns away a personal key of a user who cannot manage requests', async () => {
    const media = await seedLanternKeeper();
    const { apiKey } = await createUser(
      'reader@example.com',
      Permission.REQUEST
    );

    const res = await request(app)
      .get(`/media/${media.id}/arr/releases`)
      .query({ bookFormat: 'audiobook' })
      .set('X-Api-Key', apiKey);

    assert.strictEqual(res.status, 403);
  });
});
