import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';
import zlib from 'node:zlib';

import {
  NOBOOKENDS_SYNC_PROXY_PATH,
  getNoBookEndsSyncAppInfo,
  getNoBookEndsSyncPublicUrl,
} from '@server/lib/nobookendsSync';
import nobookendsSyncProxy, {
  MAX_PROXY_BODY_BYTES,
  getProxiedPath,
} from '@server/lib/nobookendsSyncProxy';
import { getSettings } from '@server/lib/settings';
import express from 'express';
import request from 'supertest';

interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

let seen: Seen[] = [];
let upstream: http.Server;
let upstreamUrl: string;

const app = express();
app.use(NOBOOKENDS_SYNC_PROXY_PATH, nobookendsSyncProxy);
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

before(async () => {
  upstream = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      seen.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });

      if (req.url === '/api/v1/health') {
        res.writeHead(200, {
          'content-type': 'application/json',
          'set-cookie': 'sync=1',
          etag: '"abc"',
        });
        res.end(JSON.stringify({ ok: true, version: '1.6.0', gpu: false }));
        return;
      }

      if (req.url?.startsWith('/api/v1/alignments/')) {
        if (req.headers['if-none-match'] === '"v1"') {
          res.writeHead(304, { etag: '"v1"' });
          res.end();
          return;
        }
        const body = zlib.gzipSync(JSON.stringify({ status: 'ready' }));
        res.writeHead(200, {
          'content-type': 'application/json',
          'content-encoding': 'gzip',
          etag: '"v1"',
        });
        res.end(body);
        return;
      }

      if (req.url === '/api/v1/slow') {
        // Never answers
        return;
      }

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ echoed: true }));
    });
  });
  await new Promise<void>((resolve) =>
    upstream.listen(0, '127.0.0.1', resolve)
  );
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
});

after(async () => {
  upstream.closeAllConnections();
  await new Promise((resolve) => upstream.close(resolve));
});

beforeEach(() => {
  seen = [];
  getSettings().nobookendsSync = {
    enabled: true,
    proxy: true,
    url: '',
    internalUrl: upstreamUrl,
    adminToken: 'admin-secret',
  };
});

describe('getProxiedPath', () => {
  it('keeps reader API paths with their query', () => {
    assert.strictEqual(
      getProxiedPath('/api/v1/alignments/a1?ebookItemId=e1&from=0'),
      '/api/v1/alignments/a1?ebookItemId=e1&from=0'
    );
    assert.strictEqual(
      getProxiedPath('/api/v1/me/data/ratings'),
      '/api/v1/me/data/ratings'
    );
  });

  it('refuses the admin API and anything that could climb out', () => {
    for (const path of [
      '/api/v1/admin/status',
      '/api/v1/ADMIN/jobs',
      '/api/v1/admin',
      '/api/v1/me/../admin/status',
      '/api/v1/me/%2e%2e/admin/status',
      '/api/v1/me%2fadmin',
      '/api/v1/me\\admin',
      '/docs',
      '/openapi.json',
      '/',
    ]) {
      assert.strictEqual(getProxiedPath(path), null, path);
    }
  });
});

describe('NoBookEnds Sync proxy', () => {
  it('forwards a reader request and its answer', async () => {
    const res = await request(app)
      .get(`${NOBOOKENDS_SYNC_PROXY_PATH}/api/v1/health`)
      .set('Authorization', 'Bearer reader-token')
      .set('Cookie', 'connect.sid=allseerr-session')
      .set('X-Api-Key', 'allseerr-key');

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body, {
      ok: true,
      version: '1.6.0',
      gpu: false,
    });
    assert.strictEqual(res.headers.etag, '"abc"');
    // The Sync server sets no cookies on Allseerr's address
    assert.strictEqual(res.headers['set-cookie'], undefined);

    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].url, '/api/v1/health');
    assert.strictEqual(seen[0].headers.authorization, 'Bearer reader-token');
    assert.strictEqual(seen[0].headers.cookie, undefined);
    assert.strictEqual(seen[0].headers['x-api-key'], undefined);
    // Never the admin token
    assert.ok(!JSON.stringify(seen[0].headers).includes('admin-secret'));
    assert.ok(seen[0].headers['x-forwarded-for']);
  });

  it('streams gzip answers untouched and passes conditional requests', async () => {
    const path = `${NOBOOKENDS_SYNC_PROXY_PATH}/api/v1/alignments/a1?ebookItemId=e1`;
    const res = await request(app)
      .get(path)
      .set('Accept-Encoding', 'gzip')
      .set('Authorization', 'Bearer reader-token');

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers['content-encoding'], 'gzip');
    assert.deepStrictEqual(res.body, { status: 'ready' });
    assert.strictEqual(seen[0].url, '/api/v1/alignments/a1?ebookItemId=e1');

    const cached = await request(app)
      .get(path)
      .set('If-None-Match', '"v1"')
      .set('Authorization', 'Bearer reader-token');

    assert.strictEqual(cached.status, 304);
  });

  it('forwards request bodies', async () => {
    const res = await request(app)
      .post(`${NOBOOKENDS_SYNC_PROXY_PATH}/api/v1/me/data/ratings`)
      .set('Authorization', 'Bearer reader-token')
      .set('Content-Type', 'application/json')
      .send({ items: [{ id: 'b1', data: { stars: 4 }, updatedAt: 1 }] });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(seen[0].method, 'POST');
    assert.deepStrictEqual(JSON.parse(seen[0].body), {
      items: [{ id: 'b1', data: { stars: 4 }, updatedAt: 1 }],
    });
  });

  it('does not serve the admin API', async () => {
    const res = await request(app)
      .get(`${NOBOOKENDS_SYNC_PROXY_PATH}/api/v1/admin/status`)
      .set('Authorization', 'Bearer admin-secret');

    assert.strictEqual(res.status, 404);
    assert.strictEqual(seen.length, 0);
  });

  it('answers 404 while the proxy is off', async () => {
    getSettings().nobookendsSync = { proxy: false };

    const res = await request(app).get(
      `${NOBOOKENDS_SYNC_PROXY_PATH}/api/v1/health`
    );

    assert.strictEqual(res.status, 404);
    assert.strictEqual(seen.length, 0);
  });

  it('refuses methods the Sync server does not use', async () => {
    const res = await request(app).put(
      `${NOBOOKENDS_SYNC_PROXY_PATH}/api/v1/me/data/ratings`
    );

    assert.strictEqual(res.status, 405);
  });

  it('refuses bodies over the limit', async () => {
    const res = await request(app)
      .post(`${NOBOOKENDS_SYNC_PROXY_PATH}/api/v1/me/data/ratings`)
      .set('Content-Type', 'application/json')
      .send('x'.repeat(MAX_PROXY_BODY_BYTES + 1));

    assert.strictEqual(res.status, 413);
    assert.strictEqual(seen.length, 0);
  });

  it('answers 502 when the Sync server cannot be reached', async () => {
    getSettings().nobookendsSync = { internalUrl: 'http://127.0.0.1:1' };

    const res = await request(app).get(
      `${NOBOOKENDS_SYNC_PROXY_PATH}/api/v1/health`
    );

    assert.strictEqual(res.status, 502);
  });
});

describe('NoBookEnds Sync address for the apps', () => {
  it('hands out the proxied address and path while proxying', () => {
    const settings = {
      enabled: true,
      proxy: true,
      url: 'https://sync.example.com',
      internalUrl: 'http://nobookends-sync:8000',
    };

    assert.strictEqual(
      getNoBookEndsSyncPublicUrl(settings, 'https://allseerr.example.com/'),
      'https://allseerr.example.com/api/v1/nbe-sync'
    );
    assert.deepStrictEqual(
      getNoBookEndsSyncAppInfo(settings, 'https://allseerr.example.com'),
      {
        url: 'https://allseerr.example.com/api/v1/nbe-sync',
        proxyPath: '/api/v1/nbe-sync',
      }
    );
    // Without an application URL the app joins the path to its own address
    assert.deepStrictEqual(getNoBookEndsSyncAppInfo(settings, ''), {
      proxyPath: '/api/v1/nbe-sync',
    });
  });

  it('hands out the public address without the proxy, and nothing while off', () => {
    assert.deepStrictEqual(
      getNoBookEndsSyncAppInfo(
        { enabled: true, proxy: false, url: 'https://sync.example.com/' },
        'https://allseerr.example.com'
      ),
      { url: 'https://sync.example.com' }
    );
    assert.strictEqual(
      getNoBookEndsSyncAppInfo(
        { enabled: false, proxy: true, internalUrl: 'http://sync:8000' },
        'https://allseerr.example.com'
      ),
      undefined
    );
  });
});
