import assert from 'node:assert/strict';
import { beforeEach, describe, it, mock } from 'node:test';

import NoBookEndsSyncAPI from '@server/api/nobookendsSync';
import { AudiobookshelfAdminAPI } from '@server/api/userAccess/audiobookshelfAdmin';
import { getSettings } from '@server/lib/settings';
import nobookendsSyncRoutes from '@server/routes/settings/nobookendsSync';
import { AxiosError, AxiosHeaders } from 'axios';
import express from 'express';
import request from 'supertest';

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const id = Number(req.headers['x-test-user'] ?? 1);
  (req as unknown as { user: { id: number } }).user = { id };
  next();
});
app.use('/nobookends-sync', nobookendsSyncRoutes);
app.use(
  (
    err: { status?: number; message?: string },
    _req: express.Request,
    res: express.Response,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _next: express.NextFunction
  ) => {
    res.status(err.status ?? 500).json({ message: err.message });
  }
);

mock.method(AudiobookshelfAdminAPI.prototype, 'listAccounts', async () => []);
mock.method(
  AudiobookshelfAdminAPI.prototype,
  'createServiceAccount',
  async (username: string) => ({ id: 'u1', username })
);
mock.method(AudiobookshelfAdminAPI.prototype, 'createUserKey', async () => ({
  id: 'k1',
  key: 'abs-secret-key',
}));
mock.method(
  AudiobookshelfAdminAPI.prototype,
  'isUserKeyValid',
  async () => true
);

// The token the Sync server was started with
let serverToken = '';

type ClientThis = {
  axios: { defaults: { headers: { Authorization?: string } } };
};

mock.method(NoBookEndsSyncAPI.prototype, 'getHealth', async () => ({
  ok: true,
  version: '1.6.0',
  gpu: false,
}));
mock.method(
  NoBookEndsSyncAPI.prototype,
  'getStatus',
  async function (this: ClientThis) {
    if (this.axios.defaults.headers.Authorization !== `Bearer ${serverToken}`) {
      throw new AxiosError('refused', 'ERR_BAD_REQUEST', undefined, undefined, {
        status: 401,
        statusText: '',
        headers: {},
        config: { headers: new AxiosHeaders() },
        data: {},
      });
    }
    return {
      version: '1.6.0',
      gpu: false,
      window: { start: '01:00', end: '06:00', active: false },
      queue: { user: 0, auto: 0, total: 0 },
      current: null,
    };
  }
);

beforeEach(() => {
  serverToken = '';
  const settings = getSettings();
  settings.userAccess = {
    ...settings.userAccess,
    audiobookshelf: { url: 'http://audiobookshelf:80', apiKey: 'admin-key' },
  };
  const sync = settings.nobookendsSync;
  for (const key of Object.keys(sync)) {
    delete (sync as Record<string, unknown>)[key];
  }
  Object.assign(sync, {
    enabled: false,
    url: '',
    internalUrl: '',
    adminToken: '',
  });
  settings.main.applicationUrl = 'https://allseerr.example.com';
});

describe('NoBookEnds Sync setup routes', () => {
  it('writes filled in instructions, then connects the server they start', async () => {
    const manual = await request(app)
      .post('/nobookends-sync/manual')
      .send({ absUrl: 'http://audiobookshelf:80', network: 'proxynet' });

    assert.strictEqual(manual.status, 200);
    assert.match(manual.body.compose, /ABS_API_KEY: "abs-secret-key"/);
    assert.match(manual.body.dockerRun, /--network proxynet/);
    assert.match(manual.body.unraidTemplate, /<Container version="2">/);
    assert.strictEqual(
      manual.body.suggestedInternalUrl,
      'http://nobookends-sync:8000'
    );

    const token = /ADMIN_TOKEN: "([^"]+)"/.exec(manual.body.compose)?.[1];
    assert.ok(token);

    // The server was started without the token from the instructions
    serverToken = 'something-else';
    const refused = await request(app)
      .post('/nobookends-sync/connect')
      .send({ internalUrl: 'http://nobookends-sync:8000' });
    assert.strictEqual(refused.status, 409);
    assert.strictEqual(getSettings().nobookendsSync.enabled, false);

    serverToken = token;
    const connected = await request(app)
      .post('/nobookends-sync/connect')
      .send({ internalUrl: 'http://nobookends-sync:8000/' });

    assert.strictEqual(connected.status, 200);
    assert.strictEqual(connected.body.tokenValid, true);

    const sync = getSettings().nobookendsSync;
    assert.strictEqual(sync.enabled, true);
    assert.strictEqual(sync.proxy, true);
    assert.strictEqual(sync.internalUrl, 'http://nobookends-sync:8000');
    assert.strictEqual(sync.adminToken, token);

    // The settings page never gets the secrets back
    const saved = await request(app).get('/nobookends-sync');
    const text = JSON.stringify(saved.body);

    assert.strictEqual(saved.body.proxy, true);
    assert.strictEqual(
      saved.body.proxyUrl,
      'https://allseerr.example.com/api/v1/nbe-sync'
    );
    assert.deepStrictEqual(saved.body.absAccount, {
      username: 'nobookends-sync',
      created: true,
    });
    assert.ok(!text.includes('abs-secret-key'));
    assert.ok(!text.includes(token));

    const status = await request(app).get('/nobookends-sync/status');
    assert.strictEqual(status.status, 200);
    assert.strictEqual(status.body.status.queue.total, 0);
  });

  it('refuses invalid install values', async () => {
    const res = await request(app)
      .post('/nobookends-sync/manual')
      .send({ absUrl: 'http://audiobookshelf:80', containerName: 'a b' });

    assert.strictEqual(res.status, 400);
  });

  it('needs the instructions before connecting', async () => {
    const res = await request(app)
      .post('/nobookends-sync/connect')
      .send({ internalUrl: 'http://nobookends-sync:8000' });

    assert.strictEqual(res.status, 400);
  });

  it('turns the proxy on and off with the settings', async () => {
    const res = await request(app)
      .post('/nobookends-sync')
      .send({ enabled: true, internalUrl: 'http://sync:8000', proxy: true });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.proxy, true);

    const off = await request(app)
      .post('/nobookends-sync')
      .send({ proxy: false });
    assert.strictEqual(off.body.proxy, false);
  });

  it('shows the notice once per admin', async () => {
    const first = await request(app).get('/nobookends-sync/notice');
    assert.deepStrictEqual(first.body, { show: true });

    const dismissed = await request(app).post(
      '/nobookends-sync/notice/dismiss'
    );
    assert.strictEqual(dismissed.status, 204);

    const again = await request(app).get('/nobookends-sync/notice');
    assert.deepStrictEqual(again.body, { show: false });

    const other = await request(app)
      .get('/nobookends-sync/notice')
      .set('x-test-user', '2');
    assert.deepStrictEqual(other.body, { show: true });
  });

  it('reports Docker as unavailable without the socket', async () => {
    process.env.DOCKER_SOCKET = '/nonexistent/docker.sock';
    const res = await request(app).get('/nobookends-sync/setup');
    delete process.env.DOCKER_SOCKET;

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.docker.available, false);
    assert.strictEqual(res.body.docker.reason, 'no_socket');
    assert.strictEqual(res.body.absConnected, true);
    assert.strictEqual(res.body.defaults.absUrl, 'http://audiobookshelf:80');
  });
});
