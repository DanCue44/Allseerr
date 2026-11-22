import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it, mock } from 'node:test';

import TracearrAPI from '@server/api/tracearr';
import { getSettings } from '@server/lib/settings';
import { checkUser } from '@server/middleware/auth';
import { setupTestDb } from '@server/test/db';
import type { Express } from 'express';
import express from 'express';
import session from 'express-session';
import request from 'supertest';
import authRoutes from './auth';
import settingsRoutes from './settings';

// Settings routes save to the settings file, which tests leave alone
mock.method(getSettings(), 'save', async () => undefined);

let connects = true;
// The connection test is the only call that leaves the server
const getServers = mock.method(
  TracearrAPI.prototype,
  'getServers',
  async () => {
    if (!connects) {
      throw new Error('ECONNREFUSED');
    }
    return { data: [], tracearr_version: '3.2.1' };
  }
).mock;

const main = getSettings().main;
let app: Express;

async function login(email: string) {
  const priorLocalLogin = main.localLogin;
  main.localLogin = true;

  try {
    const agent = request.agent(app);
    const res = await agent
      .post('/auth/local')
      .send({ email, password: 'test1234' });
    assert.strictEqual(res.status, 200);
    return agent;
  } finally {
    main.localLogin = priorLocalLogin;
  }
}

before(() => {
  app = express();
  app.use(express.json());
  app.use(
    session({ secret: 'test-secret', resave: false, saveUninitialized: false })
  );
  app.use(checkUser);
  app.use('/auth', authRoutes);
  app.use('/settings', settingsRoutes);
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
});

after(() => {
  getSettings().tracearr = {};
});

setupTestDb();

beforeEach(() => {
  connects = true;
  getServers.resetCalls();
  getSettings().tracearr = {};
});

describe('Tracearr settings', () => {
  it('tests a connection without saving it', async () => {
    const admin = await login('admin@seerr.dev');
    const res = await admin
      .post('/settings/tracearr/test')
      .send({ url: 'http://tracearr:3000', apiKey: 'trr_pub_x' });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.version, '3.2.1');
    assert.deepStrictEqual(getSettings().tracearr, {});
  });

  it('saves only settings that connect', async () => {
    const admin = await login('admin@seerr.dev');

    connects = false;
    const failed = await admin
      .post('/settings/tracearr')
      .send({ url: 'http://tracearr:3000', apiKey: 'trr_pub_x' });
    assert.strictEqual(failed.status, 500);
    assert.deepStrictEqual(getSettings().tracearr, {});

    connects = true;
    const saved = await admin
      .post('/settings/tracearr')
      .send({ url: 'http://tracearr:3000/', apiKey: ' trr_pub_x ' });
    assert.strictEqual(saved.status, 200);
    assert.deepStrictEqual(getSettings().tracearr, {
      url: 'http://tracearr:3000',
      apiKey: 'trr_pub_x',
    });
  });

  it('needs both fields, and clearing both turns it off', async () => {
    const admin = await login('admin@seerr.dev');

    const half = await admin
      .post('/settings/tracearr')
      .send({ url: 'http://tracearr:3000' });
    assert.strictEqual(half.status, 400);

    getSettings().tracearr = { url: 'http://tracearr:3000', apiKey: 'k' };
    const cleared = await admin
      .post('/settings/tracearr')
      .send({ url: '', apiKey: '' });
    assert.strictEqual(cleared.status, 200);
    assert.strictEqual(getServers.callCount(), 0);
    assert.strictEqual(getSettings().tracearr.url, undefined);
  });
});
