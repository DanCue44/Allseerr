import {
  getOidcLoginRedirectUri,
  oidcLoginClient,
  resetOidcLoginConfig,
} from '@server/lib/oidcLogin';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { Router } from 'express';
import { z } from 'zod';

const oidcLoginSettingsRoutes = Router();

const oidcLoginSchema = z.object({
  enabled: z.boolean(),
  issuerUrl: z
    .string()
    .trim()
    .refine((value) => !value || /^https?:\/\/[^\s]+$/i.test(value), {
      message: 'The issuer URL must start with http:// or https://',
    }),
  clientId: z.string().trim(),
  clientSecret: z.string(),
  scopes: z.string().trim(),
  buttonLabel: z.string().trim().max(60),
  autoCreateUsers: z.boolean(),
  matchByEmail: z.boolean(),
  hideLocalLogin: z.boolean(),
});

const withRedirectUri = (origin: string) => ({
  ...getSettings().oidcLogin,
  redirectUri: getOidcLoginRedirectUri(origin),
});

oidcLoginSettingsRoutes.get('/', (req, res) => {
  return res
    .status(200)
    .json(withRedirectUri(`${req.protocol}://${req.get('host')}`));
});

oidcLoginSettingsRoutes.post('/', async (req, res, next) => {
  const parsed = oidcLoginSchema.safeParse(req.body);

  if (!parsed.success) {
    return next({ status: 400, message: parsed.error.issues[0]?.message });
  }

  if (
    parsed.data.enabled &&
    (!parsed.data.issuerUrl || !parsed.data.clientId)
  ) {
    return next({
      status: 400,
      message: 'An issuer URL and a client ID are needed to turn this on.',
    });
  }

  const settings = getSettings();
  settings.oidcLogin = parsed.data;
  await settings.save();
  resetOidcLoginConfig();

  return res
    .status(200)
    .json(withRedirectUri(`${req.protocol}://${req.get('host')}`));
});

/**
 * Looks the provider up with the given settings, without saving them
 */
oidcLoginSettingsRoutes.post('/test', async (req, res, next) => {
  const parsed = oidcLoginSchema.safeParse(req.body);

  if (!parsed.success || !parsed.data.issuerUrl || !parsed.data.clientId) {
    return next({
      status: 400,
      message: 'An issuer URL and a client ID are needed.',
    });
  }

  try {
    resetOidcLoginConfig();
    await oidcLoginClient.authorizationUrl(
      parsed.data,
      getOidcLoginRedirectUri(`${req.protocol}://${req.get('host')}`)
    );

    return res.status(204).send();
  } catch (e) {
    logger.warn('Could not reach the OIDC provider', {
      label: 'Auth',
      issuer: parsed.data.issuerUrl,
      errorMessage: e.message,
    });

    return next({ status: 502, message: e.message });
  } finally {
    resetOidcLoginConfig();
  }
});

export default oidcLoginSettingsRoutes;
