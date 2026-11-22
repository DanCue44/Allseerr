import assert from 'node:assert/strict';
import type { IncomingHttpHeaders, Server } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';

import { Notification } from '@server/lib/notifications';
import { ExtraWebhooksAgent } from '@server/lib/notifications/agents/webhook';
import { Permission } from '@server/lib/permissions';
import { getSettings } from '@server/lib/settings';
import { checkUser, isAuthenticated } from '@server/middleware/auth';
import authRoutes from '@server/routes/auth';
import notificationRoutes from '@server/routes/settings/notifications';
import { setupTestDb } from '@server/test/db';
import express from 'express';
import session from 'express-session';
import request from 'supertest';

let app: express.Express;

// Collects what the webhooks send
let receiver: Server;
let receiverBase: string;
let received: { path: string; headers: IncomingHttpHeaders; body: unknown }[];

const payload = (name: string) =>
  JSON.stringify({ source: name, subject: '{{subject}}' });

const encoded = (name: string) =>
  Buffer.from(JSON.stringify(payload(name))).toString('base64');

before(async () => {
  app = express();
  app.use(express.json());
  app.use(
    session({ secret: 'test-secret', resave: false, saveUninitialized: false })
  );
  app.use(checkUser);
  app.use('/api/v1/auth', authRoutes);
  app.use(
    '/api/v1/settings/notifications',
    isAuthenticated(Permission.ADMIN),
    notificationRoutes
  );

  receiver = createServer((req, res) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => {
      received.push({
        path: req.url ?? '',
        headers: req.headers,
        body: JSON.parse(data),
      });
      res.writeHead(200).end();
    });
  });
  receiver.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => receiver.once('listening', resolve));
  receiverBase = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
});

after(async () => {
  receiver.closeAllConnections();
  await new Promise<void>((resolve) => receiver.close(() => resolve()));
});

setupTestDb();

beforeEach(() => {
  received = [];
  const settings = getSettings();
  // A webhook set up before there could be more than one
  settings.notifications.agents.webhook = {
    enabled: true,
    embedPoster: false,
    types: Notification.MEDIA_PENDING,
    options: {
      webhookUrl: `${receiverBase}/first`,
      jsonPayload: encoded('first'),
      authHeader: 'Bearer first',
    },
  };
  settings.notifications.webhooks = undefined;
});

async function admin() {
  const agent = request.agent(app);
  await agent
    .post('/api/v1/auth/local')
    .send({ email: 'admin@seerr.dev', password: 'test1234' })
    .expect(200);
  return agent;
}

const webhookBody = (name: string, types: number) => ({
  name,
  enabled: true,
  types,
  options: {
    webhookUrl: `${receiverBase}/${name}`,
    jsonPayload: payload(name),
    authHeader: `Bearer ${name}`,
  },
});

describe('webhooks', () => {
  it('lists the existing webhook first, unchanged', async () => {
    const agent = await admin();

    const list = await agent
      .get('/api/v1/settings/notifications/webhooks')
      .expect(200);

    assert.equal(list.body.length, 1);
    assert.equal(list.body[0].id, 0);
    assert.equal(list.body[0].name, 'Webhook');
    assert.equal(list.body[0].options.webhookUrl, `${receiverBase}/first`);
    assert.equal(list.body[0].options.jsonPayload, payload('first'));
    assert.equal(list.body[0].types, Notification.MEDIA_PENDING);
  });

  it('adds, updates and removes more webhooks', async () => {
    const agent = await admin();

    const created = await agent
      .post('/api/v1/settings/notifications/webhooks')
      .send(webhookBody('second', Notification.MEDIA_AVAILABLE))
      .expect(201);
    assert.equal(created.body.id, 1);
    assert.equal(created.body.name, 'second');

    await agent
      .post('/api/v1/settings/notifications/webhooks/1')
      .send({
        ...webhookBody('second', Notification.MEDIA_FAILED),
        name: 'Renamed',
      })
      .expect(200);

    const list = await agent
      .get('/api/v1/settings/notifications/webhooks')
      .expect(200);
    assert.deepEqual(
      list.body.map((w: { id: number; name: string; types: number }) => [
        w.id,
        w.name,
        w.types,
      ]),
      [
        [0, 'Webhook', Notification.MEDIA_PENDING],
        [1, 'Renamed', Notification.MEDIA_FAILED],
      ]
    );

    await agent.delete('/api/v1/settings/notifications/webhooks/1').expect(204);
    await agent.get('/api/v1/settings/notifications/webhooks/1').expect(404);
  });

  it('keeps the first webhook on the old endpoint', async () => {
    const agent = await admin();

    await agent
      .post('/api/v1/settings/notifications/webhooks/0')
      .send({
        ...webhookBody('first', Notification.MEDIA_DECLINED),
        name: 'Main',
      })
      .expect(200);

    const old = await agent
      .get('/api/v1/settings/notifications/webhook')
      .expect(200);
    assert.equal(old.body.types, Notification.MEDIA_DECLINED);
    assert.equal(old.body.name, undefined);

    // Saving on the old endpoint keeps the name
    await agent
      .post('/api/v1/settings/notifications/webhook')
      .send(webhookBody('first', Notification.MEDIA_PENDING))
      .expect(200);
    const list = await agent
      .get('/api/v1/settings/notifications/webhooks')
      .expect(200);
    assert.equal(list.body[0].name, 'Main');
    assert.equal(list.body[0].types, Notification.MEDIA_PENDING);
  });

  it('will not remove the first webhook', async () => {
    const agent = await admin();

    await agent.delete('/api/v1/settings/notifications/webhooks/0').expect(400);
  });

  it('refuses a payload that is not JSON', async () => {
    const agent = await admin();

    await agent
      .post('/api/v1/settings/notifications/webhooks')
      .send({
        ...webhookBody('bad', Notification.MEDIA_PENDING),
        options: { webhookUrl: `${receiverBase}/bad`, jsonPayload: '{nope' },
      })
      .expect(400);
  });

  it('sends each webhook only its own notification types', async () => {
    const agent = await admin();
    await agent
      .post('/api/v1/settings/notifications/webhooks')
      .send(webhookBody('second', Notification.MEDIA_AVAILABLE))
      .expect(201);
    await agent
      .post('/api/v1/settings/notifications/webhooks')
      .send(
        webhookBody(
          'third',
          Notification.MEDIA_AVAILABLE | Notification.MEDIA_PENDING
        )
      )
      .expect(201);
    await agent
      .post('/api/v1/settings/notifications/webhooks')
      .send({
        ...webhookBody('off', Notification.MEDIA_AVAILABLE),
        enabled: false,
      })
      .expect(201);

    const extra = new ExtraWebhooksAgent();
    assert.equal(extra.shouldSend(), true);
    assert.equal(
      await extra.send(Notification.MEDIA_AVAILABLE, {
        subject: 'Available',
        notifySystem: true,
        notifyAdmin: false,
      }),
      true
    );

    assert.deepEqual(received.map((r) => r.path).sort(), ['/second', '/third']);
    const third = received.find((r) => r.path === '/third');
    assert.equal(third?.headers.authorization, 'Bearer third');
    assert.deepEqual(third?.body, { source: 'third', subject: 'Available' });

    received = [];
    await extra.send(Notification.MEDIA_PENDING, {
      subject: 'Pending',
      notifySystem: true,
      notifyAdmin: false,
    });
    assert.deepEqual(
      received.map((r) => r.path),
      ['/third']
    );
  });

  it('sends nothing without extra webhooks', () => {
    assert.equal(new ExtraWebhooksAgent().shouldSend(), false);
  });
});
