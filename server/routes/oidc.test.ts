import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';

import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import {
  OIDC_PATH,
  oidcMiddleware,
  resetOidcProvider,
} from '@server/lib/oidc/provider';
import { Permission } from '@server/lib/permissions';
import { defaultPlexDefaultAccess, getSettings } from '@server/lib/settings';
import { updatePerson } from '@server/lib/userAccess';
import { checkUser, isAuthenticated } from '@server/middleware/auth';
import authRoutes from '@server/routes/auth';
import oidcRoutes from '@server/routes/oidc';
import userAccessSettingsRoutes from '@server/routes/settings/userAccess';
import { setupTestDb } from '@server/test/db';
import { startFakeKavita } from '@server/test/fakeApps';
import express from 'express';
import session from 'express-session';
import request from 'supertest';

let server: Server;
let base: string;
let kavita: Awaited<ReturnType<typeof startFakeKavita>>;

const KAVITA_REDIRECT = 'https://kavita.example.com/signin-oidc';

function createApp() {
  const app = express();
  app.use(OIDC_PATH, oidcMiddleware);
  app.use(express.json());
  app.use(
    session({ secret: 'test-secret', resave: false, saveUninitialized: false })
  );
  app.use(checkUser);
  app.use('/api/v1/auth/oidc', oidcRoutes);
  app.use('/api/v1/auth', authRoutes);
  app.use(
    '/api/v1/settings/user-access',
    isAuthenticated(Permission.ADMIN),
    userAccessSettingsRoutes
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
  kavita = await startFakeKavita('kavita-key');
  server = createApp().listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await kavita.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

setupTestDb();

let clientSecret: string;

beforeEach(async () => {
  resetOidcProvider();
  const settings = getSettings();
  settings.main.applicationUrl = base;
  settings.notifications.agents.email.enabled = false;
  settings.userAccess = {
    audiobookshelf: {},
    kavita: {
      url: kavita.url,
      apiKey: 'kavita-key',
      publicUrl: 'https://kavita.example.com',
    },
    komga: {},
    grimmory: {},
    emailPasswords: false,
    oidc: { enabled: false, clients: [] },
    plexDefault: defaultPlexDefaultAccess(),
  };

  const admin = await loginAs('admin@seerr.dev');
  await admin
    .post('/api/v1/settings/user-access/oidc')
    .send({ enabled: true })
    .expect(200);
  const created = await admin
    .post('/api/v1/settings/user-access/oidc/clients')
    .send({ app: 'kavita' })
    .expect(201);
  clientSecret = created.body.clientSecret;
});

async function loginAs(email: string, password = 'test1234') {
  const agent = request.agent(server);
  await agent.post('/api/v1/auth/local').send({ email, password }).expect(200);
  return agent;
}

const demoUser = () =>
  getRepository(User).findOneOrFail({ where: { email: 'demo@seerr.dev' } });

const pathOf = (location: string): string => {
  const url = new URL(location, base);
  return `${url.pathname}${url.search}`;
};

/**
 * Runs the browser side of a sign in, from the app's authorize link to the
 * redirect back to the app
 */
async function signIn(
  agent: ReturnType<typeof request.agent>,
  prompt: string | undefined = 'consent'
) {
  const start = await agent.get('/oidc/auth').query({
    client_id: 'allseerr-kavita',
    redirect_uri: KAVITA_REDIRECT,
    response_type: 'code',
    scope: 'openid profile email roles offline_access',
    state: 'state-1',
    nonce: 'nonce-1',
    ...(prompt ? { prompt } : {}),
  });
  assert.equal(start.status, 303, start.text);
  const interaction = pathOf(start.headers.location);
  assert.match(interaction, /^\/api\/v1\/auth\/oidc\/interaction\/[\w-]+$/);

  const finished = await agent.get(interaction);
  assert.equal(finished.status, 303, finished.text);

  const resumed = await agent.get(pathOf(finished.headers.location));
  assert.equal(resumed.status, 303, resumed.text);

  return new URL(resumed.headers.location);
}

describe('sign in with Allseerr', () => {
  it('publishes its discovery document with the scopes the apps need', async () => {
    const res = await request(server)
      .get('/oidc/.well-known/openid-configuration')
      .expect(200);

    assert.equal(res.body.issuer, `${base}/oidc`);
    for (const scope of ['openid', 'email', 'roles', 'abs_groups']) {
      assert.ok(res.body.scopes_supported.includes(scope), scope);
    }
    assert.equal(res.body.token_endpoint, `${base}/oidc/token`);
  });

  it('gives the public address behind a proxy it does not trust', async () => {
    const settings = getSettings();
    settings.main.applicationUrl = 'https://requests.example.com';
    settings.network.trustProxy = false;

    const res = await request(server)
      .get('/oidc/.well-known/openid-configuration')
      .expect(200);

    assert.equal(res.body.issuer, 'https://requests.example.com/oidc');
    assert.equal(
      res.body.token_endpoint,
      'https://requests.example.com/oidc/token'
    );
    assert.equal(
      res.body.authorization_endpoint,
      'https://requests.example.com/oidc/auth'
    );
  });

  it('sends people who are not signed in to the Allseerr login', async () => {
    const agent = request.agent(server);
    const start = await agent.get('/oidc/auth').query({
      client_id: 'allseerr-kavita',
      redirect_uri: KAVITA_REDIRECT,
      response_type: 'code',
      scope: 'openid',
    });
    const interaction = await agent.get(pathOf(start.headers.location));

    assert.equal(interaction.status, 302);
    assert.match(
      interaction.headers.location,
      /^\/login\?next=%2Fsignin%2F[\w-]+$/
    );
  });

  it('signs a person with access in and hands Kavita their libraries and age limit', async () => {
    const user = await demoUser();
    await updatePerson(user.id, {
      ageLimit: 'kids',
      apps: { kavita: { enabled: true, libraryIds: ['2'] } },
    });

    const agent = await loginAs('demo@seerr.dev');
    const back = await signIn(agent);

    assert.equal(`${back.origin}${back.pathname}`, KAVITA_REDIRECT);
    assert.equal(back.searchParams.get('state'), 'state-1');
    const code = back.searchParams.get('code');
    assert.ok(code);

    // Kavita sends its secret in the body
    const token = await request(server)
      .post('/oidc/token')
      .type('form')
      .send({
        grant_type: 'authorization_code',
        code,
        redirect_uri: KAVITA_REDIRECT,
        client_id: 'allseerr-kavita',
        client_secret: clientSecret,
      })
      .expect(200);

    assert.ok(token.body.access_token);
    assert.ok(token.body.refresh_token);

    const idToken = JSON.parse(
      Buffer.from(token.body.id_token.split('.')[1], 'base64url').toString()
    );
    assert.equal(idToken.sub, String(user.id));
    assert.equal(idToken.nonce, 'nonce-1');
    assert.equal(idToken.email, 'demo@seerr.dev');
    assert.equal(idToken.email_verified, true);
    assert.deepEqual(idToken.role, [
      'Login',
      'Download',
      'Change Password',
      'library-Manga',
      'age-restriction-G',
    ]);

    const info = await request(server)
      .get('/oidc/me')
      .set('Authorization', `Bearer ${token.body.access_token}`)
      .expect(200);
    assert.equal(info.body.preferred_username, 'demo');
    assert.ok(info.body.role.includes('library-Manga'));
  });

  it('turns away a person without access to the app', async () => {
    const agent = await loginAs('demo@seerr.dev');
    const back = await signIn(agent);

    assert.equal(back.searchParams.get('error'), 'access_denied');
    assert.equal(back.searchParams.get('code'), null);
  });

  it('stops a signed in person as soon as their access is taken away', async () => {
    const user = await demoUser();
    await updatePerson(user.id, { apps: { kavita: { enabled: true } } });
    const agent = await loginAs('demo@seerr.dev');
    const code = (await signIn(agent)).searchParams.get('code');
    const token = await request(server)
      .post('/oidc/token')
      .type('form')
      .send({
        grant_type: 'authorization_code',
        code,
        redirect_uri: KAVITA_REDIRECT,
        client_id: 'allseerr-kavita',
        client_secret: clientSecret,
      })
      .expect(200);

    await updatePerson(user.id, { apps: { kavita: { enabled: false } } });

    // The Allseerr session and the earlier approval are still there (an app
    // coming back sends no prompt), but no new code is handed out
    const back = await signIn(agent, undefined);
    assert.equal(back.searchParams.get('code'), null);
    assert.equal(back.searchParams.get('error'), 'access_denied');

    await request(server)
      .post('/oidc/token')
      .type('form')
      .send({
        grant_type: 'refresh_token',
        refresh_token: token.body.refresh_token,
        client_id: 'allseerr-kavita',
        client_secret: clientSecret,
      })
      .expect(400);

    await request(server)
      .get('/oidc/me')
      .set('Authorization', `Bearer ${token.body.access_token}`)
      .expect(401);
  });

  it('refuses a wrong client secret', async () => {
    const user = await demoUser();
    await updatePerson(user.id, { apps: { kavita: { enabled: true } } });
    const agent = await loginAs('demo@seerr.dev');
    const code = (await signIn(agent)).searchParams.get('code');

    await request(server)
      .post('/oidc/token')
      .type('form')
      .send({
        grant_type: 'authorization_code',
        code,
        redirect_uri: KAVITA_REDIRECT,
        client_id: 'allseerr-kavita',
        client_secret: 'not-the-secret',
      })
      .expect(401);
  });

  it('is off until an admin turns it on', async () => {
    const admin = await loginAs('admin@seerr.dev');
    await admin
      .post('/api/v1/settings/user-access/oidc')
      .send({ enabled: false })
      .expect(200);

    await request(server)
      .get('/oidc/.well-known/openid-configuration')
      .expect(404);
  });

  it('shows the client secret once and can replace it', async () => {
    const admin = await loginAs('admin@seerr.dev');
    const settings = await admin
      .get('/api/v1/settings/user-access/oidc')
      .expect(200);

    assert.equal(JSON.stringify(settings.body).includes(clientSecret), false);
    assert.deepEqual(settings.body.defaultRedirectUris.kavita, [
      KAVITA_REDIRECT,
    ]);
    assert.deepEqual(settings.body.clients[0].redirectUris, [KAVITA_REDIRECT]);

    const rotated = await admin
      .post('/api/v1/settings/user-access/oidc/clients/allseerr-kavita/secret')
      .expect(200);
    assert.notEqual(rotated.body.clientSecret, clientSecret);
  });
});
