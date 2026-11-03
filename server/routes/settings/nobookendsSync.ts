import type { NoBookEndsSyncHealth } from '@server/api/nobookendsSync';
import NoBookEndsSyncAPI from '@server/api/nobookendsSync';
import type {
  NoBookEndsSyncBackfillResponse,
  NoBookEndsSyncManualResponse,
  NoBookEndsSyncSettingsResponse,
  NoBookEndsSyncSetupResponse,
  NoBookEndsSyncTestResponse,
} from '@server/interfaces/api/settingsInterfaces';
import {
  NOBOOKENDS_SYNC_PROXY_PATH,
  backfillNoBookEndsSync,
  getNoBookEndsSyncProxyUrl,
  getNoBookEndsSyncTarget,
} from '@server/lib/nobookendsSync';
import {
  DEFAULT_ABS_USERNAME,
  DEFAULT_AUTO_WINDOW,
  DEFAULT_CONTAINER_NAME,
  DEFAULT_DATA_PATH,
  SyncSetupError,
  buildCompose,
  buildDockerRun,
  buildUnraidTemplate,
  connectSyncServer,
  dismissNotice,
  ensureAbsAccount,
  ensureSetupAdminToken,
  getDockerStatus,
  getInstallState,
  isAbsAdminConnected,
  isNoticeDismissed,
  parseInstallOptions,
  removeAbsAccount,
  removeInstalledContainer,
  startInstall,
  syncImage,
} from '@server/lib/nobookendsSyncSetup';
import type { NoBookEndsSyncSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { isAxiosError } from 'axios';
import { Router } from 'express';

const nobookendsSyncRoutes = Router();

export const maskNoBookEndsSyncSettings = (
  settings: NoBookEndsSyncSettings
): NoBookEndsSyncSettingsResponse => ({
  enabled: !!settings.enabled,
  url: settings.url ?? '',
  internalUrl: settings.internalUrl ?? '',
  adminTokenSet: !!settings.adminToken?.trim(),
  proxy: !!settings.proxy,
  proxyPath: NOBOOKENDS_SYNC_PROXY_PATH,
  proxyUrl:
    getNoBookEndsSyncProxyUrl(
      { ...settings, enabled: true, proxy: true },
      getSettings().main.applicationUrl
    ) ?? null,
  absAccount: settings.absAccount
    ? {
        username: settings.absAccount.username,
        created: !!settings.absAccount.created,
      }
    : null,
  container: settings.container
    ? {
        name: settings.container.name,
        image: settings.container.image,
        dataPath: settings.container.dataPath,
        network: settings.container.network,
      }
    : null,
});

const sendSetupError = (
  e: unknown,
  next: (err: { status: number; message: string }) => void,
  fallback: string
) => {
  if (e instanceof SyncSetupError) {
    return next({ status: e.status, message: e.message });
  }

  logger.error(fallback, {
    label: 'NoBookEnds Sync',
    errorMessage: (e as Error).message,
  });
  return next({ status: 500, message: `${fallback} ${(e as Error).message}` });
};

// The Sync server answered its health check, but not the status
class SyncStatusError extends Error {}

/**
 * Health, and with an admin token the status, of a Sync server. Throws when
 * it does not answer at all.
 */
const checkSyncServer = async (
  url: string,
  adminToken?: string
): Promise<NoBookEndsSyncTestResponse> => {
  const client = new NoBookEndsSyncAPI({ url, adminToken });
  const health: NoBookEndsSyncHealth = await client.getHealth();

  if (!adminToken) {
    return health;
  }

  try {
    const status = await client.getStatus();

    return {
      ...health,
      version: status.version ?? health.version,
      gpu: status.gpu,
      tokenValid: true,
      status,
    };
  } catch (e) {
    const code = isAxiosError(e) ? e.response?.status : undefined;

    if (code === 401 || code === 403) {
      return { ...health, tokenValid: false };
    }

    if (code === 404) {
      // An older Sync server without the status endpoint, or one started
      // without ADMIN_TOKEN, which hides the admin API
      return { ...health, statusUnavailable: true };
    }

    throw new SyncStatusError(e.message);
  }
};

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

nobookendsSyncRoutes.get('/', (_req, res) => {
  res
    .status(200)
    .json(maskNoBookEndsSyncSettings(getSettings().nobookendsSync));
});

/**
 * Saves the NoBookEnds Sync settings. A missing admin token keeps the saved
 * one, an empty one removes it.
 */
nobookendsSyncRoutes.post<
  never,
  NoBookEndsSyncSettingsResponse,
  NoBookEndsSyncSettings
>('/', async (req, res, next) => {
  const settings = getSettings();
  const url = trimmedUrl(req.body.url);
  const internalUrl = trimmedUrl(req.body.internalUrl);

  if (url && !isHttpUrl(url)) {
    return next({ status: 400, message: 'Invalid NoBookEnds Sync URL.' });
  }

  if (internalUrl && !isHttpUrl(internalUrl)) {
    return next({ status: 400, message: 'Invalid internal URL.' });
  }

  const changes: NoBookEndsSyncSettings = {
    ...(typeof req.body.enabled === 'boolean'
      ? { enabled: req.body.enabled }
      : {}),
    ...(url !== undefined ? { url } : {}),
    ...(internalUrl !== undefined ? { internalUrl } : {}),
    ...(req.body.adminToken !== undefined
      ? { adminToken: trimmed(req.body.adminToken) ?? '' }
      : {}),
    ...(typeof req.body.proxy === 'boolean' ? { proxy: req.body.proxy } : {}),
  };
  const merged = { ...settings.nobookendsSync, ...changes };

  if (merged.enabled && !merged.url && !merged.internalUrl) {
    return next({
      status: 400,
      message: 'NoBookEnds Sync needs a URL to be enabled.',
    });
  }

  settings.nobookendsSync = changes;
  await settings.save();

  return res
    .status(200)
    .json(maskNoBookEndsSyncSettings(settings.nobookendsSync));
});

/**
 * Checks that the Sync server answers at the internal address (the public
 * one when there is none), and with an admin token, that the token works
 * by reading its status. The saved token is only used for the saved server.
 * A Sync server without the status endpoint reports its health only.
 */
nobookendsSyncRoutes.post<
  never,
  NoBookEndsSyncTestResponse,
  { url?: string; internalUrl?: string; adminToken?: string }
>('/test', async (req, res, next) => {
  const saved = getSettings().nobookendsSync;
  const url = trimmedUrl(req.body.internalUrl) || trimmedUrl(req.body.url);

  if (!url || !isHttpUrl(url)) {
    return next({ status: 400, message: 'Invalid NoBookEnds Sync URL.' });
  }

  const savedUrl =
    trimmedUrl(saved.internalUrl) || trimmedUrl(saved.url) || undefined;
  const adminToken =
    req.body.adminToken !== undefined
      ? trimmed(req.body.adminToken)
      : savedUrl === url
        ? saved.adminToken?.trim()
        : undefined;
  try {
    return res.status(200).json(await checkSyncServer(url, adminToken));
  } catch (e) {
    const answered = e instanceof SyncStatusError;

    logger.error(
      answered
        ? 'Failed to read the NoBookEnds Sync status'
        : 'Failed to reach NoBookEnds Sync',
      { label: 'NoBookEnds Sync', errorMessage: e.message }
    );
    return next({
      status: 500,
      message: answered
        ? 'NoBookEnds Sync answered, but its status could not be read.'
        : 'Failed to connect to NoBookEnds Sync.',
    });
  }
});

/**
 * Queues every book with both an audiobook and an ebook in Audiobookshelf
 * as background work, which the Sync server runs in its overnight window
 */
nobookendsSyncRoutes.post<never, NoBookEndsSyncBackfillResponse>(
  '/backfill',
  async (_req, res, next) => {
    const target = getNoBookEndsSyncTarget();

    if (!target) {
      return next({
        status: 400,
        message: 'NoBookEnds Sync is not enabled or has no admin token.',
      });
    }

    const client = new NoBookEndsSyncAPI(target);

    try {
      await client.getHealth();
    } catch (e) {
      logger.error('Failed to reach NoBookEnds Sync for a backfill', {
        label: 'NoBookEnds Sync',
        errorMessage: e.message,
      });
      return next({
        status: 502,
        message: 'Failed to connect to NoBookEnds Sync.',
      });
    }

    try {
      const result = await backfillNoBookEndsSync();
      // Only to tell the admin when the books will be aligned
      const window = await client
        .getStatus()
        .then((status) => status.window)
        .catch(() => undefined);

      return res.status(200).json({ ...result, ...(window ? { window } : {}) });
    } catch (e) {
      logger.error('Failed to queue books on NoBookEnds Sync', {
        label: 'NoBookEnds Sync',
        errorMessage: e.message,
      });
      return next({ status: 500, message: 'Failed to queue the books.' });
    }
  }
);

/**
 * The saved Sync server's health and status, for the settings page
 */
nobookendsSyncRoutes.get<never, NoBookEndsSyncTestResponse>(
  '/status',
  async (_req, res, next) => {
    const saved = getSettings().nobookendsSync;
    const url = trimmedUrl(saved.internalUrl) || trimmedUrl(saved.url);

    if (!url) {
      return next({ status: 404, message: 'NoBookEnds Sync is not set up.' });
    }

    try {
      return res
        .status(200)
        .json(await checkSyncServer(url, saved.adminToken?.trim()));
    } catch (e) {
      logger.warn('NoBookEnds Sync did not answer the status check', {
        label: 'NoBookEnds Sync',
        errorMessage: e.message,
      });
      return next({
        status: 502,
        message: 'Failed to connect to NoBookEnds Sync.',
      });
    }
  }
);

/**
 * What the setup needs to offer: whether Docker can be used, the defaults
 * and how far the Audiobookshelf account and an install got
 */
nobookendsSyncRoutes.get<never, NoBookEndsSyncSetupResponse>(
  '/setup',
  async (_req, res, next) => {
    try {
      const settings = getSettings();
      const docker = await getDockerStatus();
      const absUrl =
        trimmedUrl(settings.userAccess.audiobookshelf.url) ||
        trimmedUrl(settings.audiobookshelf.url) ||
        '';

      return res.status(200).json({
        docker,
        absConnected: isAbsAdminConnected(),
        defaults: {
          gpu: docker.nvidiaRuntime,
          containerName: DEFAULT_CONTAINER_NAME,
          dataPath: DEFAULT_DATA_PATH,
          network: docker.ownNetwork ?? '',
          absUrl,
          timezone: process.env.TZ?.trim() || 'UTC',
          autoWindow: DEFAULT_AUTO_WINDOW,
          absUsername: DEFAULT_ABS_USERNAME,
          images: { gpu: syncImage(true), cpu: syncImage(false) },
        },
        install: getInstallState(),
      });
    } catch (e) {
      return sendSetupError(e, next, 'Failed to read the setup state.');
    }
  }
);

/**
 * Makes (or keeps) the read only Audiobookshelf account and its key
 */
nobookendsSyncRoutes.post<
  never,
  NoBookEndsSyncSettingsResponse,
  { username?: string }
>('/abs-account', async (req, res, next) => {
  try {
    await ensureAbsAccount(trimmed(req.body?.username));

    return res
      .status(200)
      .json(maskNoBookEndsSyncSettings(getSettings().nobookendsSync));
  } catch (e) {
    return sendSetupError(
      e,
      next,
      'Failed to prepare the Audiobookshelf account.'
    );
  }
});

/**
 * Removes the key Allseerr made, and the account when Allseerr made it
 */
nobookendsSyncRoutes.delete('/abs-account', async (_req, res, next) => {
  try {
    await removeAbsAccount();

    return res.status(204).send();
  } catch (e) {
    return sendSetupError(
      e,
      next,
      'Failed to remove the Audiobookshelf account.'
    );
  }
});

/**
 * Install instructions with every value filled in, secrets included, for
 * an admin to paste: Docker Compose, docker run and an Unraid template
 */
nobookendsSyncRoutes.post<
  never,
  NoBookEndsSyncManualResponse,
  Record<string, unknown>
>('/manual', async (req, res, next) => {
  try {
    const options = parseInstallOptions(req.body ?? {});
    const { account } = await ensureAbsAccount(trimmed(req.body?.absUsername));
    const adminToken = await ensureSetupAdminToken();
    const secrets = { absApiKey: account.apiKey, adminToken };

    return res.status(200).json({
      compose: buildCompose(options, secrets),
      dockerRun: buildDockerRun(options, secrets),
      unraidTemplate: buildUnraidTemplate(options, secrets),
      unraidTemplatePath: `/boot/config/plugins/dockerMan/templates-user/my-${options.containerName}.xml`,
      suggestedInternalUrl: options.hostPort
        ? ''
        : `http://${options.containerName}:8000`,
    });
  } catch (e) {
    return sendSetupError(e, next, 'Failed to write the instructions.');
  }
});

/**
 * Starts the automatic install through the Docker socket
 */
nobookendsSyncRoutes.post('/install', async (req, res, next) => {
  try {
    const options = parseInstallOptions(req.body ?? {});
    const state = await startInstall(options, {
      absUsername: trimmed(req.body?.absUsername),
    });

    return res.status(202).json(state);
  } catch (e) {
    return sendSetupError(e, next, 'Failed to start the install.');
  }
});

nobookendsSyncRoutes.get('/install', (_req, res) => {
  res.status(200).json(getInstallState());
});

/**
 * Removes the container Allseerr installed, keeping its data folder
 */
nobookendsSyncRoutes.delete('/container', async (_req, res, next) => {
  try {
    await removeInstalledContainer();

    return res.status(204).send();
  } catch (e) {
    return sendSetupError(e, next, 'Failed to remove the container.');
  }
});

/**
 * Connects a Sync server installed by hand with the instructions: checks
 * it answers and takes the admin token made for it, then saves it with the
 * reader API served through Allseerr
 */
nobookendsSyncRoutes.post<
  never,
  NoBookEndsSyncTestResponse,
  { internalUrl?: string }
>('/connect', async (req, res, next) => {
  const internalUrl = trimmedUrl(req.body?.internalUrl);

  if (!internalUrl || !isHttpUrl(internalUrl)) {
    return next({ status: 400, message: 'Invalid NoBookEnds Sync URL.' });
  }

  const saved = getSettings().nobookendsSync;
  const tokens = [saved.setupAdminToken, saved.adminToken]
    .map((token) => token?.trim())
    .filter((token): token is string => !!token);

  if (tokens.length === 0) {
    return next({
      status: 400,
      message:
        'Write the install instructions first, they carry the admin token.',
    });
  }

  let lastResult: NoBookEndsSyncTestResponse | undefined;

  for (const token of [...new Set(tokens)]) {
    try {
      const result = await checkSyncServer(internalUrl, token);

      if (result.tokenValid) {
        await connectSyncServer({ internalUrl, adminToken: token });
        return res.status(200).json(result);
      }

      lastResult = result;
    } catch (e) {
      logger.warn('NoBookEnds Sync did not answer the connection check', {
        label: 'NoBookEnds Sync',
        errorMessage: e.message,
      });
      return next({
        status: 502,
        message: 'Failed to connect to NoBookEnds Sync at that address.',
      });
    }
  }

  return next({
    status: 409,
    message: lastResult?.statusUnavailable
      ? 'NoBookEnds Sync answered, but has no admin token set. Start it with the ADMIN_TOKEN from the instructions.'
      : 'NoBookEnds Sync answered, but refused the admin token from the instructions.',
  });
});

/**
 * Whether this admin still has the notice about the NoBookEnds Sync page
 * to see. It is shown once, and is gone for good once closed.
 */
nobookendsSyncRoutes.get<never, { show: boolean }>('/notice', (req, res) => {
  res.status(200).json({ show: !!req.user && !isNoticeDismissed(req.user.id) });
});

nobookendsSyncRoutes.post('/notice/dismiss', async (req, res, next) => {
  if (!req.user) {
    return next({ status: 401, message: 'Not signed in.' });
  }

  await dismissNotice(req.user.id);

  return res.status(204).send();
});

export default nobookendsSyncRoutes;
