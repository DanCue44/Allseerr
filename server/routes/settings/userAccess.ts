import type { AppLibrary } from '@server/api/userAccess/types';
import type {
  ReadingAppChoices,
  UserAccessApp,
} from '@server/constants/userAccess';
import {
  READING_KINDS,
  READING_KIND_APPS,
  USER_ACCESS_APPS,
  USER_ACCESS_APP_NAMES,
  isUserAccessApp,
} from '@server/constants/userAccess';
import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import type {
  NoBookEndsDirectoryStatus,
  OidcClientResponse,
  OidcSettingsResponse,
  PlexDefaultAccessResponse,
  PlexDefaultChange,
  UserAccessAppConnectionResponse,
  UserAccessSettingsResponse,
} from '@server/interfaces/api/userAccessInterfaces';
import {
  getDirectoryStatus,
  registerWithDirectory,
  unregisterFromDirectory,
} from '@server/lib/nobookendsDirectory';
import type { OidcApp } from '@server/lib/oidc/claims';
import { OIDC_APPS, isOidcApp } from '@server/lib/oidc/claims';
import { getOidcIssuer, resetOidcProvider } from '@server/lib/oidc/provider';
import type {
  OidcClientSettings,
  PlexDefaultAccessSettings,
  UserAccessAppConnection,
  UserAccessSettings,
} from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import {
  getAppClient,
  getAppPublicUrl,
  syncPerson,
} from '@server/lib/userAccess';
import { isAgeLimit, isRestricted } from '@server/lib/userAccess/ageLimits';
import { applyPlexDefaults } from '@server/lib/userAccess/plexDefaults';
import { getReadingAppChoices } from '@server/lib/userAccess/readingApps';
import logger from '@server/logger';
import { randomBytes } from 'crypto';
import { Router } from 'express';

const userAccessSettingsRoutes = Router();

const isHttpUrl = (value: string): boolean => {
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
};

const trimmed = (value: unknown): string | undefined =>
  typeof value === 'string' ? value.trim() : undefined;

const trimmedUrl = (value: unknown): string | undefined =>
  trimmed(value)?.replace(/\/+$/, '');

/**
 * The connection without its secrets, only whether they are saved
 */
export const maskConnection = (
  connection: UserAccessAppConnection
): UserAccessAppConnectionResponse => ({
  url: connection.url ?? '',
  publicUrl: connection.publicUrl ?? '',
  username: connection.username ?? '',
  apiKeySet: !!connection.apiKey,
  passwordSet: !!connection.password,
});

export const maskUserAccessSettings = (
  settings: UserAccessSettings
): UserAccessSettingsResponse => ({
  audiobookshelf: maskConnection(settings.audiobookshelf),
  kavita: maskConnection(settings.kavita),
  komga: maskConnection(settings.komga),
  grimmory: maskConnection(settings.grimmory),
  emailPasswords: settings.emailPasswords,
  matchPlexUsernames: settings.matchPlexUsernames !== false,
});

/**
 * A connection with the saved secrets kept where none were sent, and
 * removed where an empty one was
 */
const mergeConnection = (
  saved: UserAccessAppConnection,
  incoming: Partial<UserAccessAppConnection> | undefined
): UserAccessAppConnection => {
  if (!incoming) {
    return saved;
  }

  return {
    url: trimmedUrl(incoming.url) ?? saved.url,
    publicUrl: trimmedUrl(incoming.publicUrl) ?? saved.publicUrl,
    username: trimmed(incoming.username) ?? saved.username,
    apiKey:
      incoming.apiKey !== undefined ? trimmed(incoming.apiKey) : saved.apiKey,
    password:
      incoming.password !== undefined ? incoming.password : saved.password,
  };
};

userAccessSettingsRoutes.get('/', (_req, res) => {
  res.status(200).json(maskUserAccessSettings(getSettings().userAccess));
});

userAccessSettingsRoutes.post<
  never,
  UserAccessSettingsResponse,
  Partial<
    Record<UserAccessApp, Partial<UserAccessAppConnection>> & {
      emailPasswords: boolean;
      matchPlexUsernames: boolean;
    }
  >
>('/', async (req, res, next) => {
  const settings = getSettings();
  const current = settings.userAccess;

  for (const app of USER_ACCESS_APPS) {
    const incoming = req.body[app];
    for (const field of ['url', 'publicUrl'] as const) {
      const value = trimmedUrl(incoming?.[field]);
      if (value && !isHttpUrl(value)) {
        return next({
          status: 400,
          message: `Invalid ${USER_ACCESS_APP_NAMES[app]} address.`,
        });
      }
    }
  }

  settings.userAccess = {
    ...current,
    audiobookshelf: mergeConnection(
      current.audiobookshelf,
      req.body.audiobookshelf
    ),
    kavita: mergeConnection(current.kavita, req.body.kavita),
    komga: mergeConnection(current.komga, req.body.komga),
    grimmory: mergeConnection(current.grimmory, req.body.grimmory),
    emailPasswords:
      typeof req.body.emailPasswords === 'boolean'
        ? req.body.emailPasswords
        : current.emailPasswords,
    matchPlexUsernames:
      typeof req.body.matchPlexUsernames === 'boolean'
        ? req.body.matchPlexUsernames
        : current.matchPlexUsernames,
  };

  await settings.save();

  return res.status(200).json(maskUserAccessSettings(settings.userAccess));
});

const toPlexDefaultResponse = (
  defaults: PlexDefaultAccessSettings
): PlexDefaultAccessResponse => ({
  enabled: defaults.enabled,
  apps: Object.fromEntries(
    USER_ACCESS_APPS.map((app) => [
      app,
      {
        enabled: !!defaults.apps[app]?.enabled,
        libraryIds: defaults.apps[app]?.libraryIds ?? null,
      },
    ])
  ) as PlexDefaultAccessResponse['apps'],
  ageLimit: isAgeLimit(defaults.ageLimit) ? defaults.ageLimit : null,
  includeUnrated: defaults.includeUnrated,
});

/**
 * The apps everyone with access to the Plex server gets
 */
userAccessSettingsRoutes.get<never, PlexDefaultAccessResponse>(
  '/plex-default',
  (_req, res) => {
    res
      .status(200)
      .json(toPlexDefaultResponse(getSettings().userAccess.plexDefault));
  }
);

userAccessSettingsRoutes.post<
  never,
  PlexDefaultAccessResponse,
  Partial<PlexDefaultAccessResponse>
>('/plex-default', async (req, res, next) => {
  const settings = getSettings();
  const current = settings.userAccess.plexDefault;
  const body = req.body ?? {};

  if (body.ageLimit != null && !isAgeLimit(body.ageLimit)) {
    return next({ status: 400, message: 'Invalid age limit.' });
  }

  const apps = { ...current.apps };

  for (const app of USER_ACCESS_APPS) {
    const incoming = body.apps?.[app];

    if (!incoming) {
      continue;
    }

    if (
      incoming.libraryIds != null &&
      (!Array.isArray(incoming.libraryIds) ||
        incoming.libraryIds.some((id) => typeof id !== 'string'))
    ) {
      return next({ status: 400, message: 'Invalid library list.' });
    }

    apps[app] = {
      enabled:
        typeof incoming.enabled === 'boolean'
          ? incoming.enabled
          : apps[app].enabled,
      libraryIds:
        incoming.libraryIds !== undefined
          ? incoming.libraryIds?.length
            ? incoming.libraryIds
            : null
          : apps[app].libraryIds,
    };
  }

  settings.userAccess = {
    ...settings.userAccess,
    plexDefault: {
      enabled:
        typeof body.enabled === 'boolean' ? body.enabled : current.enabled,
      apps,
      ageLimit:
        body.ageLimit !== undefined
          ? isRestricted(body.ageLimit)
            ? body.ageLimit
            : null
          : current.ageLimit,
      includeUnrated:
        typeof body.includeUnrated === 'boolean'
          ? body.includeUnrated
          : current.includeUnrated,
    },
  };

  await settings.save();

  return res
    .status(200)
    .json(toPlexDefaultResponse(settings.userAccess.plexDefault));
});

/**
 * Runs the default access for Plex users once and says what changed
 */
userAccessSettingsRoutes.post<never, { changes: PlexDefaultChange[] }>(
  '/plex-default/apply',
  async (_req, res, next) => {
    if (!getSettings().userAccess.plexDefault.enabled) {
      return next({
        status: 400,
        message: 'Turn on default access for Plex users first.',
      });
    }

    try {
      const changes = await applyPlexDefaults();
      const changedUserIds = [...new Set(changes.map((c) => c.userId))];

      for (const userId of changedUserIds) {
        const user = await getRepository(User).findOne({
          where: { id: userId },
        });

        if (user) {
          await syncPerson(user, { create: false });
        }
      }

      return res.status(200).json({ changes });
    } catch (e) {
      logger.error('Could not apply default access for Plex users', {
        label: 'User Access',
        errorMessage: (e as Error).message,
      });
      return next({ status: 500, message: (e as Error).message });
    }
  }
);

/**
 * The app each kind of book is read or heard in, which the Reading apps
 * settings and the prompt after a request point people to
 */
userAccessSettingsRoutes.get<never, ReadingAppChoices>(
  '/reading-apps',
  (_req, res) => {
    res.status(200).json(getReadingAppChoices());
  }
);

userAccessSettingsRoutes.post<
  never,
  ReadingAppChoices,
  Partial<ReadingAppChoices>
>('/reading-apps', async (req, res, next) => {
  const choices = getReadingAppChoices();

  for (const kind of READING_KINDS) {
    const app = req.body?.[kind];

    if (app === undefined) {
      continue;
    }
    if (!isUserAccessApp(app) || !READING_KIND_APPS[kind].includes(app)) {
      return next({ status: 400, message: 'Invalid app for this kind.' });
    }
    choices[kind] = app;
  }

  const settings = getSettings();
  settings.userAccess = { ...settings.userAccess, readingApps: choices };
  await settings.save();

  return res.status(200).json(getReadingAppChoices());
});

/**
 * Whether this server is listed in the NoBookEnds directory, and how the
 * last registration went
 */
userAccessSettingsRoutes.get<never, NoBookEndsDirectoryStatus>(
  '/nobookends-directory',
  async (_req, res) => {
    res.status(200).json(await getDirectoryStatus());
  }
);

/**
 * Lists this server in the NoBookEnds directory right away, or takes it out.
 * It needs the Application URL and Plex.
 */
userAccessSettingsRoutes.post<
  never,
  NoBookEndsDirectoryStatus,
  { enabled?: boolean }
>('/nobookends-directory', async (req, res, next) => {
  const enabled = req.body?.enabled;

  if (typeof enabled !== 'boolean') {
    return next({ status: 400, message: 'Invalid setting.' });
  }

  const status = await getDirectoryStatus();

  if (enabled && status.applicationUrlMissing) {
    return next({
      status: 400,
      message: 'Set the Application URL in the General settings first.',
    });
  }
  if (enabled && status.plexMissing) {
    return next({ status: 400, message: 'Set up Plex first.' });
  }

  const settings = getSettings();
  settings.userAccess = {
    ...settings.userAccess,
    nobookendsDirectory: enabled,
  };
  await settings.save();

  if (enabled) {
    await registerWithDirectory();
  } else {
    await unregisterFromDirectory();
  }

  return res.status(200).json(await getDirectoryStatus());
});

/**
 * Checks an app's address and admin credentials, with the saved ones where
 * none are sent, and lists its libraries
 */
userAccessSettingsRoutes.post<
  { app: string },
  { version?: string; libraries: AppLibrary[] },
  Partial<UserAccessAppConnection>
>('/:app/test', async (req, res, next) => {
  const { app } = req.params;

  if (!isUserAccessApp(app)) {
    return next({ status: 404, message: 'Unknown app.' });
  }

  const connection = mergeConnection(getSettings().userAccess[app], req.body);

  if (!connection.url || !isHttpUrl(connection.url)) {
    return next({
      status: 400,
      message: `Invalid ${USER_ACCESS_APP_NAMES[app]} address.`,
    });
  }

  const client = getAppClient(app, connection);

  if (!client) {
    return next({
      status: 400,
      message: `Add the ${USER_ACCESS_APP_NAMES[app]} admin credentials.`,
    });
  }

  try {
    const { version } = await client.test();
    const libraries = await client.getLibraries();

    return res.status(200).json({ version, libraries });
  } catch (e) {
    logger.warn('Failed to test an app for user access', {
      label: 'User Access',
      app,
      message: (e as Error).message,
    });

    return next({ status: 502, message: (e as Error).message });
  }
});

/**
 * The addresses each app sends people back to after signing in with
 * Allseerr, from the app's public address
 */
export const defaultRedirectUris = (app: OidcApp): string[] => {
  if (app === 'nobookends') {
    return ['nobookends://oidc'];
  }

  const base = getAppPublicUrl(app)?.replace(/\/+$/, '');

  if (!base) {
    return [];
  }

  switch (app) {
    case 'audiobookshelf':
      return [
        `${base}/auth/openid/callback`,
        `${base}/auth/openid/mobile-redirect`,
      ];
    case 'kavita':
      return [`${base}/signin-oidc`];
    case 'komga':
      return [`${base}/login/oauth2/code/allseerr`];
  }
};

const maskClient = (client: OidcClientSettings): OidcClientResponse => ({
  app: client.app as OidcApp,
  clientId: client.clientId,
  redirectUris: client.redirectUris,
  enabled: client.enabled,
});

const oidcResponse = (): OidcSettingsResponse => {
  const { oidc } = getSettings().userAccess;

  return {
    enabled: oidc.enabled,
    issuer: getOidcIssuer(),
    clients: oidc.clients.filter((c) => isOidcApp(c.app)).map(maskClient),
    defaultRedirectUris: Object.fromEntries(
      OIDC_APPS.map((app) => [app, defaultRedirectUris(app)])
    ) as Record<OidcApp, string[]>,
  };
};

const generateClientSecret = (): string =>
  randomBytes(32).toString('base64url');

/**
 * Redirect addresses an app may use: web addresses, or an app scheme for
 * the mobile apps
 */
const parseRedirectUris = (value: unknown): string[] | null => {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > 10 ||
    value.some((uri) => typeof uri !== 'string')
  ) {
    return null;
  }

  const uris = (value as string[]).map((uri) => uri.trim()).filter(Boolean);

  for (const uri of uris) {
    try {
      const url = new URL(uri);
      if (
        url.hash ||
        url.protocol === 'javascript:' ||
        url.protocol === 'data:'
      ) {
        return null;
      }
    } catch {
      return null;
    }
  }

  return uris.length ? uris : null;
};

const saveOidc = async (
  change: (oidc: UserAccessSettings['oidc']) => UserAccessSettings['oidc']
): Promise<void> => {
  const settings = getSettings();
  const current = settings.userAccess;
  settings.userAccess = { ...current, oidc: change(current.oidc) };
  await settings.save();
  resetOidcProvider();
};

userAccessSettingsRoutes.get<never, OidcSettingsResponse>(
  '/oidc',
  (_req, res) => {
    res.status(200).json(oidcResponse());
  }
);

/**
 * Turns signing in with Allseerr on or off. It needs the application
 * address, which apps reach the provider at.
 */
userAccessSettingsRoutes.post<
  never,
  OidcSettingsResponse,
  { enabled?: boolean }
>('/oidc', async (req, res, next) => {
  if (typeof req.body.enabled !== 'boolean') {
    return next({ status: 400, message: 'Invalid setting.' });
  }
  if (req.body.enabled && !getOidcIssuer()) {
    return next({
      status: 400,
      message: 'Set the Application URL in the general settings first.',
    });
  }

  await saveOidc((oidc) => ({ ...oidc, enabled: req.body.enabled! }));

  return res.status(200).json(oidcResponse());
});

/**
 * Registers an app to sign in with Allseerr. The client secret is only
 * returned now.
 */
userAccessSettingsRoutes.post<
  never,
  { client: OidcClientResponse; clientSecret: string },
  { app?: string; redirectUris?: string[] }
>('/oidc/clients', async (req, res, next) => {
  const { app } = req.body;

  if (!isOidcApp(app)) {
    return next({ status: 400, message: 'Unknown app.' });
  }

  const redirectUris =
    req.body.redirectUris !== undefined
      ? parseRedirectUris(req.body.redirectUris)
      : defaultRedirectUris(app);

  if (!redirectUris?.length) {
    return next({
      status: 400,
      message:
        "Add the redirect address, or the app's public address in its connection.",
    });
  }

  const { clients } = getSettings().userAccess.oidc;
  let clientId = `allseerr-${app}`;
  for (let n = 2; clients.some((c) => c.clientId === clientId); n++) {
    clientId = `allseerr-${app}-${n}`;
  }

  const client: OidcClientSettings = {
    app,
    clientId,
    clientSecret: generateClientSecret(),
    redirectUris,
    enabled: true,
  };

  await saveOidc((oidc) => ({ ...oidc, clients: [...oidc.clients, client] }));

  return res
    .status(201)
    .json({ client: maskClient(client), clientSecret: client.clientSecret });
});

userAccessSettingsRoutes.post<
  { clientId: string },
  OidcClientResponse,
  { redirectUris?: string[]; enabled?: boolean }
>('/oidc/clients/:clientId', async (req, res, next) => {
  const existing = getSettings().userAccess.oidc.clients.find(
    (c) => c.clientId === req.params.clientId
  );

  if (!existing) {
    return next({ status: 404, message: 'Client not found.' });
  }

  const redirectUris =
    req.body.redirectUris !== undefined
      ? parseRedirectUris(req.body.redirectUris)
      : existing.redirectUris;

  if (!redirectUris) {
    return next({ status: 400, message: 'Invalid redirect addresses.' });
  }
  if (req.body.enabled !== undefined && typeof req.body.enabled !== 'boolean') {
    return next({ status: 400, message: 'Invalid setting.' });
  }

  const updated: OidcClientSettings = {
    ...existing,
    redirectUris,
    enabled: req.body.enabled ?? existing.enabled,
  };

  await saveOidc((oidc) => ({
    ...oidc,
    clients: oidc.clients.map((c) =>
      c.clientId === existing.clientId ? updated : c
    ),
  }));

  return res.status(200).json(maskClient(updated));
});

/**
 * Gives a client a new secret, returned only now. The app needs it before
 * it can sign people in again.
 */
userAccessSettingsRoutes.post<
  { clientId: string },
  { client: OidcClientResponse; clientSecret: string }
>('/oidc/clients/:clientId/secret', async (req, res, next) => {
  const existing = getSettings().userAccess.oidc.clients.find(
    (c) => c.clientId === req.params.clientId
  );

  if (!existing) {
    return next({ status: 404, message: 'Client not found.' });
  }

  const updated = { ...existing, clientSecret: generateClientSecret() };

  await saveOidc((oidc) => ({
    ...oidc,
    clients: oidc.clients.map((c) =>
      c.clientId === existing.clientId ? updated : c
    ),
  }));

  return res
    .status(200)
    .json({ client: maskClient(updated), clientSecret: updated.clientSecret });
});

userAccessSettingsRoutes.delete<{ clientId: string }>(
  '/oidc/clients/:clientId',
  async (req, res, next) => {
    const { clients } = getSettings().userAccess.oidc;

    if (!clients.some((c) => c.clientId === req.params.clientId)) {
      return next({ status: 404, message: 'Client not found.' });
    }

    await saveOidc((oidc) => ({
      ...oidc,
      clients: oidc.clients.filter((c) => c.clientId !== req.params.clientId),
    }));

    return res.status(204).send();
  }
);

export default userAccessSettingsRoutes;
