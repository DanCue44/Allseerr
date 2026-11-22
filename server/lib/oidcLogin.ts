import { UserType } from '@server/constants/user';
import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import type { OidcLoginSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { createHmac, timingSafeEqual } from 'crypto';
import gravatarUrl from 'gravatar-url';
import * as client from 'openid-client';
import validator from 'validator';

// Signing in to Allseerr with an outside OpenID Connect provider. Allseerr
// is the client here; server/lib/oidc is the other way round, where
// Allseerr is the provider other apps sign in with.

export const OIDC_LOGIN_PATH = '/api/v1/auth/oidc-login';
export const OIDC_LOGIN_CALLBACK_PATH = `${OIDC_LOGIN_PATH}/callback`;

// Holds the state, PKCE verifier and nonce between leaving for the provider
// and coming back. The session cookie can be SameSite=Strict, which the
// browser leaves off the way back, so this one is Lax.
export const OIDC_LOGIN_COOKIE = 'allseerr-oidc-login';
const STATE_MAX_AGE_MS = 10 * 60 * 1000;

export type OidcLoginError =
  | 'disabled'
  | 'provider'
  | 'expired'
  | 'denied'
  | 'no-account'
  | 'missing-email'
  | 'email-taken'
  | 'already-linked';

export interface OidcLoginProfile {
  subject: string;
  email?: string;
  // Undefined when the provider does not say
  emailVerified?: boolean;
  username?: string;
  displayName?: string;
  picture?: string;
}

const claimString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

/**
 * What Allseerr uses from the claims the provider returns (the ID token
 * merged with the user info). Null without a subject.
 */
export const profileFromClaims = (
  claims: Record<string, unknown>
): OidcLoginProfile | null => {
  const subject = claimString(claims.sub);

  if (!subject) {
    return null;
  }

  const rawEmail = claimString(claims.email)?.toLowerCase();
  const email = rawEmail && validator.isEmail(rawEmail) ? rawEmail : undefined;

  // Some providers send the flag as a string
  const verified = claims.email_verified;
  const emailVerified =
    verified === true || verified === 'true'
      ? true
      : verified === false || verified === 'false'
        ? false
        : undefined;

  const fullName = [
    claimString(claims.given_name),
    claimString(claims.family_name),
  ]
    .filter(Boolean)
    .join(' ');

  const picture = claimString(claims.picture);

  return {
    subject,
    email,
    emailVerified,
    username:
      claimString(claims.preferred_username) ?? claimString(claims.nickname),
    displayName: claimString(claims.name) ?? (fullName || undefined),
    picture: picture && /^https?:\/\//i.test(picture) ? picture : undefined,
  };
};

/**
 * The value stored on the user: the issuer and the subject, so a subject
 * from a different provider never matches
 */
export const oidcSubjectKey = (issuer: string, subject: string): string =>
  `${issuer.trim().replace(/\/+$/, '')} ${subject}`;

export type OidcLoginResult =
  | { user: User; outcome: 'linked' | 'matched' | 'created' }
  | { error: OidcLoginError };

/**
 * Finds the Allseerr account for someone the provider signed in: the
 * account already linked to them, else the account with their email
 * address when matching by email is on, else a new account when making
 * accounts is on.
 */
export const resolveOidcLoginUser = async (
  profile: OidcLoginProfile,
  settings: OidcLoginSettings,
  defaultPermissions: number
): Promise<OidcLoginResult> => {
  const userRepository = getRepository(User);
  const key = oidcSubjectKey(settings.issuerUrl, profile.subject);

  const linked = await userRepository.findOne({ where: { oidcSubject: key } });

  if (linked) {
    return { user: linked, outcome: 'linked' };
  }

  // A provider that says the address is not verified cannot claim it
  const trustedEmail =
    profile.email && profile.emailVerified !== false
      ? profile.email
      : undefined;

  const sameEmail = trustedEmail
    ? await userRepository
        .createQueryBuilder('user')
        .addSelect('user.oidcSubject')
        .where('LOWER(user.email) = :email', { email: trustedEmail })
        .getOne()
    : null;

  if (settings.matchByEmail && sameEmail) {
    if (sameEmail.oidcSubject) {
      return { error: 'already-linked' };
    }

    sameEmail.oidcSubject = key;
    await userRepository.save(sameEmail);

    return { user: sameEmail, outcome: 'matched' };
  }

  if (!settings.autoCreateUsers) {
    return { error: 'no-account' };
  }

  if (!trustedEmail) {
    return { error: 'missing-email' };
  }

  if (sameEmail) {
    return { error: 'email-taken' };
  }

  const user = new User({
    email: trustedEmail,
    username: profile.username ?? profile.displayName,
    avatar:
      profile.picture ??
      gravatarUrl(trustedEmail, { default: 'mm', size: 200 }),
    permissions: defaultPermissions,
    plexToken: '',
    userType: UserType.LOCAL,
    oidcSubject: key,
  });

  await userRepository.save(user);

  return { user, outcome: 'created' };
};

interface LoginState {
  state: string;
  verifier: string;
  nonce: string;
  at: number;
}

const sign = (value: string, secret: string): string =>
  createHmac('sha256', secret).update(value).digest('base64url');

export const sealLoginState = (data: LoginState, secret: string): string => {
  const body = Buffer.from(JSON.stringify(data)).toString('base64url');

  return `${body}.${sign(body, secret)}`;
};

export const openLoginState = (
  value: unknown,
  secret: string,
  now = Date.now()
): LoginState | null => {
  if (typeof value !== 'string') {
    return null;
  }

  const [body, signature] = value.split('.');

  if (!body || !signature) {
    return null;
  }

  const expected = Buffer.from(sign(body, secret));
  const given = Buffer.from(signature);

  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return null;
  }

  try {
    const data = JSON.parse(
      Buffer.from(body, 'base64url').toString('utf8')
    ) as LoginState;

    if (
      typeof data.state !== 'string' ||
      typeof data.verifier !== 'string' ||
      typeof data.nonce !== 'string' ||
      typeof data.at !== 'number' ||
      now - data.at > STATE_MAX_AGE_MS
    ) {
      return null;
    }

    return data;
  } catch {
    return null;
  }
};

export const getOidcLoginRedirectUri = (fallbackOrigin: string): string => {
  const applicationUrl = getSettings().main.applicationUrl.replace(/\/+$/, '');

  return `${applicationUrl || fallbackOrigin}${OIDC_LOGIN_CALLBACK_PATH}`;
};

const configCache = new Map<string, Promise<client.Configuration>>();

export const resetOidcLoginConfig = (): void => {
  configCache.clear();
};

const getConfig = (
  settings: OidcLoginSettings
): Promise<client.Configuration> => {
  const issuer = settings.issuerUrl.trim();
  const cacheKey = JSON.stringify([
    issuer,
    settings.clientId,
    settings.clientSecret,
  ]);
  const cached = configCache.get(cacheKey);

  if (cached) {
    return cached;
  }

  // Providers on the local network are often reached over plain http
  const insecure = issuer.toLowerCase().startsWith('http://');

  const config = client
    .discovery(
      new URL(issuer),
      settings.clientId,
      undefined,
      settings.clientSecret
        ? client.ClientSecretBasic(settings.clientSecret)
        : client.None(),
      {
        execute: insecure ? [client.allowInsecureRequests] : [],
        timeout: 15,
      }
    )
    .catch((e) => {
      configCache.delete(cacheKey);
      throw e;
    });

  configCache.set(cacheKey, config);

  // Look the provider up again now and then, in case its keys change
  setTimeout(() => configCache.delete(cacheKey), 60 * 60 * 1000).unref();

  return config;
};

/**
 * Talks to the provider. Kept in one object so tests can stand in for it.
 */
export const oidcLoginClient = {
  async authorizationUrl(
    settings: OidcLoginSettings,
    redirectUri: string
  ): Promise<{ url: URL; state: Omit<LoginState, 'at'> }> {
    const config = await getConfig(settings);
    const verifier = client.randomPKCECodeVerifier();
    const state = client.randomState();
    const nonce = client.randomNonce();

    const url = client.buildAuthorizationUrl(config, {
      redirect_uri: redirectUri,
      scope: settings.scopes.trim() || 'openid profile email',
      code_challenge: await client.calculatePKCECodeChallenge(verifier),
      code_challenge_method: 'S256',
      state,
      nonce,
    });

    return { url, state: { state, verifier, nonce } };
  },

  async finish(
    settings: OidcLoginSettings,
    callbackUrl: URL,
    checks: Omit<LoginState, 'at'>
  ): Promise<Record<string, unknown>> {
    const config = await getConfig(settings);
    const tokens = await client.authorizationCodeGrant(config, callbackUrl, {
      pkceCodeVerifier: checks.verifier,
      expectedState: checks.state,
      expectedNonce: checks.nonce,
      idTokenExpected: true,
    });
    const claims = tokens.claims();

    if (!claims) {
      throw new Error('The provider did not return an ID token');
    }

    // Some providers, such as Authelia, only give the email address and
    // name through the user info endpoint
    if (config.serverMetadata().userinfo_endpoint) {
      try {
        const userInfo = await client.fetchUserInfo(
          config,
          tokens.access_token,
          claims.sub
        );

        return { ...claims, ...userInfo };
      } catch (e) {
        logger.warn('Could not read the user info from the OIDC provider', {
          label: 'Auth',
          errorMessage: e.message,
        });
      }
    }

    return { ...claims };
  },
};
