import assert from 'node:assert/strict';
import { beforeEach, describe, it, mock } from 'node:test';

import NoBookEndsSyncAPI from '@server/api/nobookendsSync';
import { getSettings } from '@server/lib/settings';
import addNoBookEndsSyncSettings from '@server/lib/settings/migrations/0011_add_nobookends_sync_settings';
import nobookendsSyncRoutes from '@server/routes/settings/nobookendsSync';
import { setupTestDb } from '@server/test/db';
import { AxiosError, AxiosHeaders } from 'axios';
import express from 'express';
import request from 'supertest';

const SYNC_URL = 'https://sync.example.com';
const INTERNAL_URL = 'http://192.168.1.20:8000';
const TOKEN = 'admin-token-1234';

// The backfill reads the books from the database
setupTestDb();

// Settings routes save to the settings file, which tests leave alone
mock.method(getSettings(), 'save', async () => undefined);

type ClientThis = {
  axios: {
    defaults: { baseURL?: string; headers: Record<string, unknown> };
  };
};

// What each call to the Sync server was sent with
let healthCalls: { url?: string; auth?: unknown }[] = [];
let statusCalls: { url?: string; auth?: unknown }[] = [];
let healthImpl: () => Promise<{ ok: boolean; version: string; gpu: boolean }>;
let statusImpl: () => Promise<unknown>;

mock.method(
  NoBookEndsSyncAPI.prototype,
  'getHealth',
  async function (this: ClientThis) {
    healthCalls.push({
      url: this.axios.defaults.baseURL,
      auth: this.axios.defaults.headers.Authorization,
    });
    return healthImpl();
  }
);
mock.method(
  NoBookEndsSyncAPI.prototype,
  'getStatus',
  async function (this: ClientThis) {
    statusCalls.push({
      url: this.axios.defaults.baseURL,
      auth: this.axios.defaults.headers.Authorization,
    });
    return statusImpl();
  }
);

const STATUS = {
  version: '1.1.0',
  gpu: true,
  window: { start: '01:00', end: '06:00', active: false },
  queue: { user: 1, auto: 2, total: 3 },
  current: {
    audioItemId: 'li_audio0001',
    ebookItemId: 'li_ebook0001',
    title: 'The Lighthouse Keeper',
    progress: 0.42,
  },
};

const refused = (status: number) =>
  new AxiosError('refused', 'ERR_BAD_REQUEST', undefined, undefined, {
    status,
    statusText: '',
    headers: {},
    config: { headers: new AxiosHeaders() },
    data: {},
  });

describe('0011_add_nobookends_sync_settings', () => {
  it('adds the block turned off to older settings files', () => {
    const migrated = addNoBookEndsSyncSettings({ main: {} });

    assert.deepStrictEqual(migrated.nobookendsSync, {
      enabled: false,
      url: '',
      internalUrl: '',
      adminToken: '',
    });
  });

  it('keeps saved values and tidies them', () => {
    const migrated = addNoBookEndsSyncSettings({
      nobookendsSync: {
        enabled: true,
        url: `${SYNC_URL}/`,
        internalUrl: ` ${INTERNAL_URL}/ `,
        adminToken: TOKEN,
      },
    });

    assert.deepStrictEqual(migrated.nobookendsSync, {
      enabled: true,
      url: SYNC_URL,
      internalUrl: INTERNAL_URL,
      adminToken: TOKEN,
    });
  });

  it('leaves a tidy block alone', () => {
    const settings = {
      nobookendsSync: {
        enabled: false,
        url: SYNC_URL,
        internalUrl: '',
        adminToken: '',
      },
    };

    assert.deepStrictEqual(
      addNoBookEndsSyncSettings(structuredClone(settings)),
      settings
    );
  });
});

describe('/settings/nobookends-sync', () => {
  const app = express();
  app.use(express.json());
  app.use('/settings/nobookends-sync', nobookendsSyncRoutes);
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

  beforeEach(() => {
    healthCalls = [];
    statusCalls = [];
    healthImpl = async () => ({ ok: true, version: '1.0.0', gpu: true });
    statusImpl = async () => STATUS;
    getSettings().nobookendsSync = {
      enabled: false,
      url: '',
      internalUrl: '',
      adminToken: '',
    };
  });

  it('never returns the admin token', async () => {
    getSettings().nobookendsSync = {
      enabled: true,
      url: SYNC_URL,
      internalUrl: INTERNAL_URL,
      adminToken: TOKEN,
    };

    const res = await request(app).get('/settings/nobookends-sync');

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body, {
      enabled: true,
      url: SYNC_URL,
      internalUrl: INTERNAL_URL,
      adminTokenSet: true,
      proxy: false,
      proxyPath: '/api/v1/nbe-sync',
      proxyUrl: null,
      absAccount: null,
      container: null,
    });
    assert.doesNotMatch(JSON.stringify(res.body), new RegExp(TOKEN));
  });

  it('saves the settings and keeps the token when it is left out', async () => {
    const saved = await request(app)
      .post('/settings/nobookends-sync')
      .send({
        enabled: true,
        url: `${SYNC_URL}/`,
        internalUrl: INTERNAL_URL,
        adminToken: ` ${TOKEN} `,
      });

    assert.strictEqual(saved.status, 200);
    assert.deepStrictEqual(saved.body, {
      enabled: true,
      url: SYNC_URL,
      internalUrl: INTERNAL_URL,
      adminTokenSet: true,
      proxy: false,
      proxyPath: '/api/v1/nbe-sync',
      proxyUrl: null,
      absAccount: null,
      container: null,
    });
    assert.strictEqual(getSettings().nobookendsSync.adminToken, TOKEN);

    const kept = await request(app)
      .post('/settings/nobookends-sync')
      .send({ enabled: true, url: SYNC_URL, internalUrl: '' });

    assert.strictEqual(kept.body.adminTokenSet, true);
    assert.strictEqual(kept.body.internalUrl, '');
    assert.strictEqual(getSettings().nobookendsSync.adminToken, TOKEN);

    const cleared = await request(app)
      .post('/settings/nobookends-sync')
      .send({ adminToken: '' });

    assert.strictEqual(cleared.body.adminTokenSet, false);
    assert.strictEqual(getSettings().nobookendsSync.adminToken, '');
  });

  it('refuses addresses that are not web URLs', async () => {
    const bad = await request(app)
      .post('/settings/nobookends-sync')
      .send({ url: 'ftp://sync' });
    assert.strictEqual(bad.status, 400);

    const badInternal = await request(app)
      .post('/settings/nobookends-sync')
      .send({ url: SYNC_URL, internalUrl: 'sync:8000' });
    assert.strictEqual(badInternal.status, 400);
  });

  it('refuses to enable without an address', async () => {
    const res = await request(app)
      .post('/settings/nobookends-sync')
      .send({ enabled: true });

    assert.strictEqual(res.status, 400);
    assert.strictEqual(getSettings().nobookendsSync.enabled, false);
  });

  it('tests the internal address, without a token only the health', async () => {
    const res = await request(app)
      .post('/settings/nobookends-sync/test')
      .send({ url: SYNC_URL, internalUrl: INTERNAL_URL });

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body, { ok: true, version: '1.0.0', gpu: true });
    assert.deepStrictEqual(healthCalls, [
      { url: INTERNAL_URL, auth: undefined },
    ]);
    assert.strictEqual(statusCalls.length, 0);
  });

  it('checks the saved token, but only against the saved server', async () => {
    getSettings().nobookendsSync = {
      enabled: true,
      url: SYNC_URL,
      internalUrl: INTERNAL_URL,
      adminToken: TOKEN,
    };

    const res = await request(app)
      .post('/settings/nobookends-sync/test')
      .send({ url: SYNC_URL, internalUrl: INTERNAL_URL });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.tokenValid, true);
    assert.strictEqual(res.body.version, '1.1.0');
    assert.deepStrictEqual(res.body.status, STATUS);
    assert.deepStrictEqual(statusCalls, [
      { url: INTERNAL_URL, auth: `Bearer ${TOKEN}` },
    ]);

    // Another address does not get the saved token
    statusCalls = [];
    const other = await request(app)
      .post('/settings/nobookends-sync/test')
      .send({ url: 'https://203.0.113.10' });

    assert.strictEqual(other.status, 200);
    assert.strictEqual(other.body.tokenValid, undefined);
    assert.strictEqual(statusCalls.length, 0);
    assert.strictEqual(healthCalls.at(-1)?.auth, undefined);
  });

  it('reports a token the Sync server refuses', async () => {
    statusImpl = async () => {
      throw refused(403);
    };

    const res = await request(app)
      .post('/settings/nobookends-sync/test')
      .send({ url: SYNC_URL, adminToken: 'wrong' });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.tokenValid, false);
    assert.strictEqual(res.body.status, undefined);
  });

  it('falls back to the health of a Sync server without the status endpoint', async () => {
    statusImpl = async () => {
      throw refused(404);
    };

    const res = await request(app)
      .post('/settings/nobookends-sync/test')
      .send({ url: SYNC_URL, adminToken: TOKEN });

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body, {
      ok: true,
      version: '1.0.0',
      gpu: true,
      statusUnavailable: true,
    });
  });

  it('reports a server that does not answer', async () => {
    healthImpl = async () => {
      throw new Error('ECONNREFUSED');
    };

    const res = await request(app)
      .post('/settings/nobookends-sync/test')
      .send({ url: SYNC_URL });

    assert.strictEqual(res.status, 500);
  });

  it('refuses a backfill while not set up', async () => {
    const res = await request(app).post('/settings/nobookends-sync/backfill');

    assert.strictEqual(res.status, 400);
  });

  it('tells when the backfilled books will be aligned', async () => {
    getSettings().nobookendsSync = {
      enabled: true,
      url: SYNC_URL,
      internalUrl: INTERNAL_URL,
      adminToken: TOKEN,
    };

    const res = await request(app).post('/settings/nobookends-sync/backfill');

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body, {
      total: 0,
      accepted: 0,
      rejected: 0,
      failed: 0,
      window: STATUS.window,
    });

    // An older Sync server without the status endpoint
    statusImpl = async () => {
      throw refused(404);
    };
    const older = await request(app).post('/settings/nobookends-sync/backfill');
    assert.strictEqual(older.status, 200);
    assert.strictEqual(older.body.window, undefined);
  });
});
