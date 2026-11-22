import type { OidcLoginError } from '@server/lib/oidcLogin';
import {
  OIDC_LOGIN_COOKIE,
  OIDC_LOGIN_PATH,
  getOidcLoginRedirectUri,
  oidcLoginClient,
  openLoginState,
  profileFromClaims,
  resolveOidcLoginUser,
  sealLoginState,
} from '@server/lib/oidcLogin';
import { getSettings, isOidcLoginReady } from '@server/lib/settings';
import logger from '@server/logger';
import type { Request, Response } from 'express';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';

const oidcLoginRoutes = Router();

const cookieOptions = (req: Request) => ({
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: req.secure,
  path: OIDC_LOGIN_PATH,
});

const requestOrigin = (req: Request) => `${req.protocol}://${req.get('host')}`;

// Back to the sign in page, which shows what went wrong
const failTo = (res: Response, error: OidcLoginError) =>
  res.redirect(302, `/login?oidcError=${error}`);

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Sends the browser to the provider's sign in page
 */
oidcLoginRoutes.get('/start', limiter, async (req, res) => {
  const settings = getSettings();
  const oidcLogin = settings.oidcLogin;

  if (!isOidcLoginReady(oidcLogin) || !settings.public.initialized) {
    return failTo(res, 'disabled');
  }

  try {
    const { url, state } = await oidcLoginClient.authorizationUrl(
      oidcLogin,
      getOidcLoginRedirectUri(requestOrigin(req))
    );

    res.cookie(
      OIDC_LOGIN_COOKIE,
      sealLoginState({ ...state, at: Date.now() }, settings.sessionSecret),
      { ...cookieOptions(req), maxAge: 10 * 60 * 1000 }
    );

    return res.redirect(302, url.href);
  } catch (e) {
    logger.error('Could not reach the OIDC provider', {
      label: 'Auth',
      issuer: oidcLogin.issuerUrl,
      errorMessage: e.message,
    });

    return failTo(res, 'provider');
  }
});

/**
 * Where the provider sends the browser back to
 */
oidcLoginRoutes.get('/callback', limiter, async (req, res) => {
  const settings = getSettings();
  const oidcLogin = settings.oidcLogin;
  const checks = openLoginState(
    req.cookies?.[OIDC_LOGIN_COOKIE],
    settings.sessionSecret
  );

  res.clearCookie(OIDC_LOGIN_COOKIE, cookieOptions(req));

  if (!isOidcLoginReady(oidcLogin) || !settings.public.initialized) {
    return failTo(res, 'disabled');
  }

  if (typeof req.query.error === 'string') {
    logger.info('The OIDC provider did not sign the user in', {
      label: 'Auth',
      ip: req.ip,
      error: req.query.error,
    });

    return failTo(res, 'denied');
  }

  if (!checks) {
    return failTo(res, 'expired');
  }

  const query = req.originalUrl.includes('?')
    ? req.originalUrl.slice(req.originalUrl.indexOf('?'))
    : '';
  const callbackUrl = new URL(
    `${getOidcLoginRedirectUri(requestOrigin(req))}${query}`
  );

  let claims: Record<string, unknown>;

  try {
    claims = await oidcLoginClient.finish(oidcLogin, callbackUrl, checks);
  } catch (e) {
    logger.error('Could not finish signing in with the OIDC provider', {
      label: 'Auth',
      ip: req.ip,
      errorMessage: e.message,
    });

    return failTo(res, 'provider');
  }

  const profile = profileFromClaims(claims);

  if (!profile) {
    return failTo(res, 'provider');
  }

  const result = await resolveOidcLoginUser(
    profile,
    oidcLogin,
    settings.main.defaultPermissions
  );

  if ('error' in result) {
    logger.warn('Refused an OIDC sign in', {
      label: 'Auth',
      ip: req.ip,
      reason: result.error,
      email: profile.email,
    });

    return failTo(res, result.error);
  }

  logger.info('Signed in with the OIDC provider', {
    label: 'Auth',
    ip: req.ip,
    userId: result.user.id,
    outcome: result.outcome,
  });

  if (req.session) {
    await new Promise<void>((resolve, reject) =>
      req.session.regenerate((err) => (err ? reject(err) : resolve()))
    );
    req.session.userId = result.user.id;
  }

  // The sign in page finishes up: it sends the user on to the page they
  // asked for
  return res.redirect(302, '/login');
});

export default oidcLoginRoutes;
