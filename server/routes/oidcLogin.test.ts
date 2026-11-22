import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';

import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import { resetOidcLoginConfig } from '@server/lib/oidcLogin';
import { Permission } from '@server/lib/permissions';
import { defaultOidcLoginSettings, getSettings } from '@server/lib/settings';
import { checkUser, isAuthenticated } from '@server/middleware/auth';
import authRoutes from '@server/routes/auth';
import oidcLoginRoutes from '@server/routes/oidcLogin';
import oidcLoginSettingsRoutes from '@server/routes/settings/oidcLogin';
import { setupTestDb } from '@server/test/db';
import cookieParser from 'cookie-parser';
import express from 'express';
import session from 'express-session';
import Provider from 'oidc-provider';
import request from 'supertest';

// An outside provider, standing in for Authentik, Keycloak and the like
let idpServer: Server;
let idpBase: string;
let appServer: Server;
let appBase: string;

// Who the provider signs in next
let account: Record<string, unknown> = {};

function createApp() {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use(
    session({ secret: 'test-secret', resave: false, saveUninitialized: false })
  );
  app.use(checkUser);
  app.use('/api/v1/auth/oidc-login', oidcLoginRoutes);
  app.use('/api/v1/auth', authRoutes);
  app.use(
    '/api/v1/settings/oidc-login',
    isAuthenticated(Permission.ADMIN),
    oidcLoginSettingsRoutes
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

const listen = async (handler: express.Express) => {
  const server = handler.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  return {
    server,
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  };
};

before(async () => {
  ({ server: appServer, base: appBase } = await listen(createApp()));

  const idpApp = express();
  ({ server: idpServer, base: idpBase } = await listen(idpApp));

  const provider = new Provider(idpBase, {
    clients: [
      {
        client_id: 'allseerr',
        client_secret: 'allseerr-secret',
        redirect_uris: [`${appBase}/api/v1/auth/oidc-login/callback`],
        token_endpoint_auth_method: 'client_secret_basic',
      },
    ],
    claims: {
      openid: ['sub'],
      email: ['email', 'email_verified'],
      profile: ['preferred_username', 'name'],
    },
    findAccount: async (_ctx, sub) => ({
      accountId: sub,
      claims: async () => ({ ...account, sub }),
    }),
    features: { devInteractions: { enabled: false } },
    interactions: {
      url: (_ctx, interaction) => `/interaction/${interaction.uid}`,
    },
    pkce: { required: () => true },
  });

  // Signs in whoever `account` is, without a form
  idpApp.get('/interaction/:uid', async (req, res, next) => {
    try {
      const details = await provider.interactionDetails(req, res);
      const grant = new provider.Grant({
        accountId: account.sub as string,
        clientId: details.params.client_id as string,
      });
      grant.addOIDCScope(details.params.scope as string);
      const grantId = await grant.save();

      await provider.interactionFinished(
        req,
        res,
        {
          login: { accountId: account.sub as string },
          consent: { grantId },
        },
        { mergeWithLastSubmission: false }
      );
    } catch (e) {
      next(e);
    }
  });
  idpApp.use(provider.callback());
});

after(async () => {
  for (const server of [appServer, idpServer]) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

setupTestDb();

beforeEach(() => {
  resetOidcLoginConfig();
  const settings = getSettings();
  settings.main.applicationUrl = appBase;
  settings.public.initialized = true;
  settings.main.defaultPermissions = Permission.REQUEST;
  settings.oidcLogin = {
    ...defaultOidcLoginSettings(),
    enabled: true,
    issuerUrl: idpBase,
    clientId: 'allseerr',
    clientSecret: 'allseerr-secret',
  };
  account = {
    sub: 'reader-1',
    email: 'demo@seerr.dev',
    email_verified: true,
    preferred_username: 'demo',
  };
});

/**
 * Runs the browser through the sign in, following redirects between
 * Allseerr and the provider. Returns where it lands back in Allseerr.
 */
async function signIn(app: ReturnType<typeof request.agent>) {
  const idp = request.agent(idpServer);
  let response = await app.get('/api/v1/auth/oidc-login/start');
  let current = appBase;

  for (let hop = 0; hop < 10; hop++) {
    const location = response.headers.location;
    assert.ok(location, `hop ${hop} has no redirect (${response.status})`);
    const url = new URL(location, current);
    const path = `${url.pathname}${url.search}`;
    current = url.origin;

    if (url.origin === idpBase) {
      response = await idp.get(path);
    } else if (url.pathname.startsWith('/api/')) {
      response = await app.get(path);
    } else {
      return path;
    }
  }

  throw new Error('Too many redirects');
}

describe('sign in with an OpenID Connect provider', () => {
  it('signs in the account with the same email address', async () => {
    const app = request.agent(appServer);

    assert.equal(await signIn(app), '/login');

    const me = await app.get('/api/v1/auth/me').expect(200);
    assert.equal(me.body.email, 'demo@seerr.dev');

    const user = await getRepository(User)
      .createQueryBuilder('user')
      .addSelect('user.oidcSubject')
      .where('user.email = :email', { email: 'demo@seerr.dev' })
      .getOneOrFail();
    assert.equal(user.oidcSubject, `${idpBase} reader-1`);
  });

  it('refuses people without an account while making accounts is off', async () => {
    account = { sub: 'stranger', email: 'stranger@example.com' };
    const app = request.agent(appServer);

    assert.equal(await signIn(app), '/login?oidcError=no-account');
    await app.get('/api/v1/auth/me').expect(403);
  });

  it('makes an account when that is on', async () => {
    getSettings().oidcLogin = {
      ...getSettings().oidcLogin,
      autoCreateUsers: true,
    };
    account = {
      sub: 'stranger',
      email: 'stranger@example.com',
      email_verified: true,
      preferred_username: 'stranger',
    };
    const app = request.agent(appServer);

    assert.equal(await signIn(app), '/login');

    const me = await app.get('/api/v1/auth/me').expect(200);
    assert.equal(me.body.email, 'stranger@example.com');
    assert.equal(me.body.permissions, Permission.REQUEST);
  });

  it('is off until it is turned on', async () => {
    getSettings().oidcLogin = defaultOidcLoginSettings();

    const response = await request(appServer)
      .get('/api/v1/auth/oidc-login/start')
      .expect(302);
    assert.equal(response.headers.location, '/login?oidcError=disabled');
  });

  it('refuses a callback that did not start here', async () => {
    const response = await request(appServer)
      .get('/api/v1/auth/oidc-login/callback?code=abc&state=xyz')
      .expect(302);
    assert.equal(response.headers.location, '/login?oidcError=expired');
  });

  it('reports a provider that cannot be reached', async () => {
    getSettings().oidcLogin = {
      ...getSettings().oidcLogin,
      issuerUrl: 'http://127.0.0.1:1',
    };

    const response = await request(appServer)
      .get('/api/v1/auth/oidc-login/start')
      .expect(302);
    assert.equal(response.headers.location, '/login?oidcError=provider');
  });

  it('shows only the button settings in the public settings', () => {
    assert.deepEqual(getSettings().fullPublicSettings.oidcLogin, {
      buttonLabel: '',
      hideLocalLogin: false,
    });

    getSettings().oidcLogin = defaultOidcLoginSettings();
    assert.equal(getSettings().fullPublicSettings.oidcLogin, undefined);
  });
});

describe('OpenID Connect sign in settings', () => {
  async function loginAs(email: string) {
    const agent = request.agent(appServer);
    await agent
      .post('/api/v1/auth/local')
      .send({ email, password: 'test1234' })
      .expect(200);
    return agent;
  }

  it('saves the settings and gives the redirect URI', async () => {
    const admin = await loginAs('admin@seerr.dev');

    const saved = await admin
      .post('/api/v1/settings/oidc-login')
      .send({
        ...defaultOidcLoginSettings(),
        enabled: true,
        issuerUrl: idpBase,
        clientId: 'allseerr',
        clientSecret: 'allseerr-secret',
        buttonLabel: 'Sign in with Authentik',
      })
      .expect(200);

    assert.equal(saved.body.buttonLabel, 'Sign in with Authentik');
    assert.equal(
      saved.body.redirectUri,
      `${appBase}/api/v1/auth/oidc-login/callback`
    );
    assert.equal(getSettings().oidcLogin.buttonLabel, 'Sign in with Authentik');
  });

  it('needs an issuer and a client id to turn it on', async () => {
    const admin = await loginAs('admin@seerr.dev');

    await admin
      .post('/api/v1/settings/oidc-login')
      .send({ ...defaultOidcLoginSettings(), enabled: true })
      .expect(400);
  });

  it('checks that the provider answers', async () => {
    const admin = await loginAs('admin@seerr.dev');
    const body = {
      ...defaultOidcLoginSettings(),
      issuerUrl: idpBase,
      clientId: 'allseerr',
    };

    await admin.post('/api/v1/settings/oidc-login/test').send(body).expect(204);
    await admin
      .post('/api/v1/settings/oidc-login/test')
      .send({ ...body, issuerUrl: 'http://127.0.0.1:1' })
      .expect(502);
  });

  it('is for admins only', async () => {
    const demo = await loginAs('demo@seerr.dev');

    await demo.get('/api/v1/settings/oidc-login').expect(403);
  });
});
