import BazarrAPI from '@server/api/bazarr';
import GoogleBooks from '@server/api/googlebooks';
import type { JellyfinLibrary } from '@server/api/jellyfin';
import JellyfinAPI from '@server/api/jellyfin';
import LazyLibrarianAPI from '@server/api/lazylibrarian';
import PlexAPI, { plexStatusProbe } from '@server/api/plexapi';
import PlexTvAPI from '@server/api/plextv';
import TautulliAPI from '@server/api/tautulli';
import { isAudiobookVersionsMode } from '@server/constants/audiobookVersion';
import { isBookLanguage } from '@server/constants/bookLanguages';
import { isBookService } from '@server/constants/bookService';
import { ApiErrorCode } from '@server/constants/error';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import type { PlexConnection } from '@server/interfaces/api/plexInterfaces';
import type {
  LogMessage,
  LogsResultsResponse,
  SettingsAboutResponse,
} from '@server/interfaces/api/settingsInterfaces';
import { scheduledJobs } from '@server/job/schedule';
import {
  LogoValidationError,
  removeApplicationLogo,
  saveApplicationLogo,
} from '@server/lib/branding';
import type { AvailableCacheIds } from '@server/lib/cache';
import cacheManager from '@server/lib/cache';
import ImageProxy from '@server/lib/imageproxy';
import { Permission } from '@server/lib/permissions';
import type { PlexAddress } from '@server/lib/plexConnection';
import {
  PlexAddressError,
  explainPlexConnection,
  parsePlexAddress,
  plexAddressUrl,
  testPlexConnection,
} from '@server/lib/plexConnection';
import { jellyfinFullScanner } from '@server/lib/scanners/jellyfin';
import { plexFullScanner } from '@server/lib/scanners/plex';
import scanHealth, {
  SCAN_FAILURE_THRESHOLD,
  SCAN_SERVICE_PATHS,
  scanServiceName,
} from '@server/lib/scanners/scanHealth';
import type { JobId, Library, MainSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { isAuthenticated } from '@server/middleware/auth';
import discoverSettingRoutes from '@server/routes/settings/discover';
import { ApiError } from '@server/types/error';
import { normalizeHexColor } from '@server/utils/accentColor';
import { appDataPath } from '@server/utils/appDataVolume';
import { getAppVersion, isReleaseBuild } from '@server/utils/appVersion';
import { dnsCache } from '@server/utils/dnsCache';
import { getHostname } from '@server/utils/getHostname';
import type { DnsEntries, DnsStats } from 'dns-caching';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import fs from 'fs';
import { escapeRegExp, merge, omit, set, sortBy } from 'lodash';
import { rescheduleJob } from 'node-schedule';
import path from 'path';
import semver from 'semver';
import { URL } from 'url';
import { z } from 'zod';
import audiobookshelfRoutes from './audiobookshelf';
import chaptarrRoutes from './chaptarr';
import lidarrRoutes from './lidarr';
import metadataRoutes from './metadata';
import nobookendsSyncRoutes from './nobookendsSync';
import notificationRoutes from './notifications';
import radarrRoutes from './radarr';
import sonarrRoutes from './sonarr';
import userAccessSettingsRoutes from './userAccess';

const settingsRoutes = Router();

settingsRoutes.use('/notifications', notificationRoutes);
settingsRoutes.use('/radarr', radarrRoutes);
settingsRoutes.use('/sonarr', sonarrRoutes);
settingsRoutes.use('/lidarr', lidarrRoutes);
settingsRoutes.use('/chaptarr', chaptarrRoutes);
settingsRoutes.use('/audiobookshelf', audiobookshelfRoutes);
settingsRoutes.use('/nobookends-sync', nobookendsSyncRoutes);
settingsRoutes.use('/user-access', userAccessSettingsRoutes);
settingsRoutes.use('/discover', discoverSettingRoutes);
settingsRoutes.use('/metadatas', metadataRoutes);

const libraryUpdateSchema = z.object({
  enabled: z.boolean(),
});

const filteredMainSettings = (
  user: User,
  main: MainSettings
): Partial<MainSettings> => {
  if (!user?.hasPermission(Permission.ADMIN)) {
    return omit(main, ['apiKey', 'googleBooksApiKey']);
  }

  return main;
};

settingsRoutes.get('/main', (req, res, next) => {
  const settings = getSettings();

  if (!req.user) {
    return next({ status: 400, message: 'User missing from request.' });
  }

  res.status(200).json(filteredMainSettings(req.user, settings.main));
});

settingsRoutes.post('/main', async (req, res, next) => {
  const settings = getSettings();

  // The logo version only changes with an upload or reset
  const body = omit(req.body, 'applicationLogoVersion');

  if (body.accentColor !== undefined) {
    const accentColor = normalizeHexColor(body.accentColor);

    if (!accentColor) {
      return next({ status: 400, message: 'Invalid accent color.' });
    }

    body.accentColor = accentColor;
  }

  if (body.bookLanguage !== undefined && !isBookLanguage(body.bookLanguage)) {
    return next({ status: 400, message: 'Unknown book language.' });
  }

  if (body.bookService !== undefined && !isBookService(body.bookService)) {
    return next({ status: 400, message: 'Unknown book service.' });
  }

  if (
    body.audiobookVersions !== undefined &&
    !isAudiobookVersionsMode(body.audiobookVersions)
  ) {
    return next({ status: 400, message: 'Unknown audiobook versions.' });
  }

  settings.main = merge(settings.main, body);
  await settings.save();

  return res.status(200).json(settings.main);
});

settingsRoutes.post<never, unknown, { file?: string }>(
  '/main/logo',
  async (req, res, next) => {
    try {
      const applicationLogoVersion = await saveApplicationLogo(req.body.file);

      return res.status(200).json({ applicationLogoVersion });
    } catch (e) {
      if (e instanceof LogoValidationError) {
        return next({ status: 400, message: e.message });
      }

      logger.error('Failed to save the application logo', {
        label: 'Branding',
        errorMessage: e.message,
      });
      return next({ status: 500, message: 'Unable to save the logo.' });
    }
  }
);

settingsRoutes.delete('/main/logo', async (_req, res, next) => {
  try {
    await removeApplicationLogo();

    return res.status(200).json({ applicationLogoVersion: '' });
  } catch (e) {
    logger.error('Failed to remove the application logo', {
      label: 'Branding',
      errorMessage: e.message,
    });
    return next({ status: 500, message: 'Unable to remove the logo.' });
  }
});

settingsRoutes.get('/network', (req, res) => {
  const settings = getSettings();

  res.status(200).json(settings.network);
});

settingsRoutes.post('/network', async (req, res) => {
  const settings = getSettings();

  settings.network = merge(settings.network, req.body);
  await settings.save();

  return res.status(200).json(settings.network);
});

settingsRoutes.post('/main/regenerate', async (req, res, next) => {
  const settings = getSettings();

  const main = await settings.regenerateApiKey();

  if (!req.user) {
    return next({ status: 500, message: 'User missing from request.' });
  }

  return res.status(200).json(filteredMainSettings(req.user, main));
});

settingsRoutes.post<never, Record<string, never>, { apiKey?: unknown }>(
  '/googlebooks/test',
  async (req, res, next) => {
    const apiKey = (
      typeof req.body.apiKey === 'string' && req.body.apiKey.trim()
        ? req.body.apiKey
        : (getSettings().main.googleBooksApiKey ?? '')
    ).trim();

    if (!apiKey) {
      return next({ status: 400, message: 'No Google Books API key is set.' });
    }

    try {
      await GoogleBooks.testApiKey(apiKey);

      return res.status(200).json({});
    } catch (e) {
      logger.error('Failed to test Google Books', {
        label: 'Google Books',
        errorMessage: e.response?.data?.error?.message ?? e.message,
      });

      return next({
        status: 500,
        message: 'Failed to connect to Google Books',
      });
    }
  }
);

settingsRoutes.get('/plex', (_req, res) => {
  const settings = getSettings();

  res.status(200).json(settings.plex);
});

settingsRoutes.post('/plex', async (req, res, next) => {
  const userRepository = getRepository(User);
  const settings = getSettings();

  // The hostname field may hold a full URL, which sets the port and SSL too
  let address: PlexAddress;

  try {
    address = parsePlexAddress({
      ip: req.body.ip ?? settings.plex.ip,
      port: req.body.port ?? settings.plex.port,
      useSsl: req.body.useSsl ?? settings.plex.useSsl,
    });
  } catch (e) {
    if (e instanceof PlexAddressError) {
      return next({ status: 400, message: e.message });
    }

    throw e;
  }

  try {
    const admin = await userRepository.findOneOrFail({
      select: { id: true, plexToken: true },
      where: { id: 1 },
    });

    const result = await testPlexConnection(address, {
      probe: plexStatusProbe(admin.plexToken),
    });

    if (!result.ok || !result.identity) {
      const explanation = explainPlexConnection(result);

      logger.error('Something went wrong testing Plex connection', {
        label: 'API',
        errorMessage: result.message,
        explanation,
        suggestion: result.suggestion
          ? plexAddressUrl(result.suggestion)
          : undefined,
      });

      // Nothing is saved. The admin chooses whether to use the suggestion.
      return res.status(500).json({
        message: result.message ?? 'Unable to connect to Plex.',
        explanation,
        reason: result.reason,
        url: result.url,
        suggestion: result.suggestion,
        attempts: result.attempts,
      });
    }

    Object.assign(settings.plex, omit(req.body, ['name', 'machineId']), {
      ip: address.ip,
      port: address.port,
      useSsl: address.useSsl,
      machineId: result.identity.machineId,
      name: result.identity.name,
    });

    await settings.save();
  } catch (e) {
    logger.error('Something went wrong testing Plex connection', {
      label: 'API',
      errorMessage: e.message,
    });
    return next({
      status: 500,
      message: 'Unable to connect to Plex.',
    });
  }

  return res.status(200).json(settings.plex);
});

settingsRoutes.get('/plex/devices/servers', async (req, res, next) => {
  const userRepository = getRepository(User);
  try {
    const admin = await userRepository.findOneOrFail({
      select: { id: true, plexToken: true },
      where: { id: 1 },
    });
    const plexTvClient = admin.plexToken
      ? new PlexTvAPI(admin.plexToken)
      : null;
    const devices = (await plexTvClient?.getDevices())?.filter((device) => {
      return device.provides.includes('server') && device.owned;
    });
    const settings = getSettings();

    if (devices) {
      await Promise.all(
        devices.map(async (device) => {
          const plexDirectConnections: PlexConnection[] = [];

          device.connection.forEach((connection) => {
            const url = new URL(connection.uri);

            if (url.hostname !== connection.address) {
              const plexDirectConnection = { ...connection };
              plexDirectConnection.address = url.hostname;
              plexDirectConnections.push(plexDirectConnection);

              // Connect to IP addresses over HTTP
              connection.protocol = 'http';
            }
          });

          plexDirectConnections.forEach((plexDirectConnection) => {
            device.connection.push(plexDirectConnection);
          });

          await Promise.all(
            device.connection.map(async (connection) => {
              const plexDeviceSettings = {
                ...settings.plex,
                ip: connection.address,
                port: connection.port,
                useSsl: connection.protocol === 'https',
              };
              const plexClient = new PlexAPI({
                plexToken: admin.plexToken,
                plexSettings: plexDeviceSettings,
                timeout: 5000,
              });

              try {
                await plexClient.getStatus();
                connection.status = 200;
                connection.message = 'OK';
              } catch (e) {
                connection.status = 500;
                connection.message = e.message.split(':')[0];
              }
            })
          );
        })
      );
    }
    return res.status(200).json(devices);
  } catch (e) {
    logger.error('Something went wrong retrieving Plex server list', {
      label: 'API',
      errorMessage: e.message,
    });
    return next({
      status: 500,
      message: 'Unable to retrieve Plex server list.',
    });
  }
});

settingsRoutes.get('/plex/library', (_req, res) => {
  const settings = getSettings();

  return res.status(200).json(settings.plex.libraries);
});

settingsRoutes.put('/plex/library/:libraryId', async (req, res, next) => {
  const settings = getSettings();

  const bodyResult = libraryUpdateSchema.safeParse(req.body);

  if (!bodyResult.success) {
    return next({ status: 400, message: 'Invalid request body.' });
  }

  const library = settings.plex.libraries.find(
    (l) => l.id === req.params.libraryId
  );

  if (!library) {
    return next({ status: 404, message: 'Library does not exist.' });
  }

  library.enabled = bodyResult.data.enabled;
  await settings.save();

  return res.status(200).json(library);
});

settingsRoutes.post('/plex/library/sync', async (_req, res, next) => {
  const settings = getSettings();

  const userRepository = getRepository(User);
  const admin = await userRepository.findOneOrFail({
    select: { id: true, plexToken: true },
    where: { id: 1 },
  });
  const plexapi = new PlexAPI({ plexToken: admin.plexToken });

  try {
    await plexapi.syncLibraries();
  } catch (e) {
    return next({
      status: e.statusCode ?? 500,
      message: e.errorCode ?? ApiErrorCode.Unknown,
    });
  }

  return res.status(200).json(settings.plex.libraries);
});

settingsRoutes.get('/plex/sync', (_req, res) => {
  return res.status(200).json(plexFullScanner.status());
});

settingsRoutes.post('/plex/sync', (req, res) => {
  if (req.body.cancel) {
    plexFullScanner.cancel();
  } else if (req.body.start) {
    plexFullScanner.run();
  }
  return res.status(200).json(plexFullScanner.status());
});

settingsRoutes.get('/jellyfin', (_req, res) => {
  const settings = getSettings();

  res.status(200).json(settings.jellyfin);
});

settingsRoutes.post('/jellyfin', async (req, res, next) => {
  const userRepository = getRepository(User);
  const settings = getSettings();

  try {
    const admin = await userRepository.findOneOrFail({
      where: { id: 1 },
      select: ['id', 'jellyfinUserId', 'jellyfinDeviceId'],
      order: { id: 'ASC' },
    });

    const tempJellyfinSettings = { ...settings.jellyfin, ...req.body };

    const jellyfinClient = new JellyfinAPI(
      getHostname(tempJellyfinSettings),
      tempJellyfinSettings.apiKey,
      admin.jellyfinDeviceId ?? ''
    );

    const result = await jellyfinClient.getSystemInfo();

    if (!result?.Id) {
      throw new ApiError(result?.status, ApiErrorCode.InvalidUrl);
    }

    Object.assign(settings.jellyfin, req.body);
    settings.jellyfin.serverId = result.Id;
    settings.jellyfin.name = result.ServerName;
    await settings.save();
  } catch (e) {
    if (e instanceof ApiError) {
      logger.error('Something went wrong testing Jellyfin connection', {
        label: 'API',
        status: e.statusCode,
        errorMessage: ApiErrorCode.InvalidUrl,
      });

      return next({
        status: e.statusCode,
        message: ApiErrorCode.InvalidUrl,
      });
    } else {
      logger.error('Something went wrong', {
        label: 'API',
        errorMessage: e.message,
      });

      return next({
        status: e.statusCode ?? 500,
        message: ApiErrorCode.Unknown,
      });
    }
  }

  return res.status(200).json(settings.jellyfin);
});

settingsRoutes.get('/jellyfin/library', (_req, res) => {
  const settings = getSettings();

  return res.status(200).json(settings.jellyfin.libraries);
});

settingsRoutes.put('/jellyfin/library/:libraryId', async (req, res, next) => {
  const settings = getSettings();

  const bodyResult = libraryUpdateSchema.safeParse(req.body);

  if (!bodyResult.success) {
    return next({ status: 400, message: 'Invalid request body.' });
  }

  const library = settings.jellyfin.libraries.find(
    (l) => l.id === req.params.libraryId
  );

  if (!library) {
    return next({ status: 404, message: 'Library does not exist.' });
  }

  library.enabled = bodyResult.data.enabled;
  await settings.save();

  return res.status(200).json(library);
});

settingsRoutes.post('/jellyfin/library/sync', async (_req, res, next) => {
  const settings = getSettings();

  const userRepository = getRepository(User);
  const admin = await userRepository.findOneOrFail({
    select: ['id', 'jellyfinDeviceId', 'jellyfinUserId'],
    where: { id: 1 },
    order: { id: 'ASC' },
  });
  const jellyfinClient = new JellyfinAPI(
    getHostname(),
    settings.jellyfin.apiKey,
    admin.jellyfinDeviceId ?? ''
  );

  jellyfinClient.setUserId(admin.jellyfinUserId ?? '');

  let libraries: JellyfinLibrary[];

  try {
    libraries = await jellyfinClient.getLibraries();

    if (libraries.length === 0) {
      // Check if no libraries are found due to the fallback to user views
      // This only affects LDAP users
      const account = await jellyfinClient.getUser();

      // Automatic Library grouping is not supported when user views are used to get library
      if (account.Configuration.GroupedFolders?.length > 0) {
        return next({
          status: 501,
          message: ApiErrorCode.SyncErrorGroupedFolders,
        });
      }

      return next({ status: 404, message: ApiErrorCode.SyncErrorNoLibraries });
    }
  } catch (e) {
    return next({
      status: e.statusCode ?? 500,
      message: e.errorCode ?? ApiErrorCode.Unknown,
    });
  }

  const newLibraries: Library[] = libraries.map((library) => {
    const existing = settings.jellyfin.libraries.find(
      (l) => l.id === library.key
    );

    return {
      id: library.key,
      name: library.title,
      enabled: existing?.enabled ?? false,
      type: library.type,
      lastScan: existing?.lastScan,
    };
  });

  settings.jellyfin.libraries = newLibraries;
  await settings.save();

  return res.status(200).json(settings.jellyfin.libraries);
});

settingsRoutes.get('/jellyfin/users', async (req, res) => {
  const settings = getSettings();

  const userRepository = getRepository(User);
  const admin = await userRepository.findOneOrFail({
    select: ['id', 'jellyfinDeviceId', 'jellyfinUserId'],
    where: { id: 1 },
    order: { id: 'ASC' },
  });
  const jellyfinClient = new JellyfinAPI(
    getHostname(),
    settings.jellyfin.apiKey,
    admin.jellyfinDeviceId ?? ''
  );

  jellyfinClient.setUserId(admin.jellyfinUserId ?? '');
  const resp = await jellyfinClient.getUsers();
  const users = resp.users.map((user) => ({
    username: user.Name,
    id: user.Id,
    thumb: `/avatarproxy/${user.Id}`,
    email: user.Name,
  }));

  return res.status(200).json(users);
});

settingsRoutes.get('/jellyfin/sync', (_req, res) => {
  return res.status(200).json(jellyfinFullScanner.status());
});

settingsRoutes.post('/jellyfin/sync', (req, res) => {
  if (req.body.cancel) {
    jellyfinFullScanner.cancel();
  } else if (req.body.start) {
    jellyfinFullScanner.run();
  }
  return res.status(200).json(jellyfinFullScanner.status());
});
settingsRoutes.get('/bazarr', (_req, res) => {
  const settings = getSettings();

  res.status(200).json(settings.bazarr);
});

settingsRoutes.post('/bazarr', async (req, res, next) => {
  const settings = getSettings();

  Object.assign(settings.bazarr, req.body);

  if (settings.bazarr.hostname) {
    try {
      const bazarrClient = new BazarrAPI(settings.bazarr);

      await bazarrClient.getVersion();
    } catch (e) {
      logger.error('Something went wrong testing Bazarr connection', {
        label: 'API',
        errorMessage: e.message,
      });
      return next({
        status: 500,
        message: 'Unable to connect to Bazarr.',
      });
    }
  }

  await settings.save();

  return res.status(200).json(settings.bazarr);
});

settingsRoutes.post('/bazarr/test', async (req, res, next) => {
  try {
    const bazarrClient = new BazarrAPI({
      hostname: req.body.hostname,
      port: req.body.port,
      useSsl: req.body.useSsl,
      urlBase: req.body.urlBase,
      apiKey: req.body.apiKey,
    });

    const version = await bazarrClient.getVersion();

    return res.status(200).json({ version });
  } catch (e) {
    logger.error('Failed to test Bazarr', {
      label: 'Bazarr',
      message: e.message,
    });

    next({ status: 500, message: 'Failed to connect to Bazarr' });
  }
});

settingsRoutes.get('/lazylibrarian', (_req, res) => {
  const settings = getSettings();

  res.status(200).json(settings.lazylibrarian);
});

settingsRoutes.post('/lazylibrarian', async (req, res, next) => {
  const settings = getSettings();

  Object.assign(settings.lazylibrarian, req.body);

  if (settings.lazylibrarian.hostname) {
    try {
      const lazyLibrarianClient = new LazyLibrarianAPI(settings.lazylibrarian);

      await lazyLibrarianClient.getVersion();
    } catch (e) {
      logger.error('Something went wrong testing LazyLibrarian connection', {
        label: 'API',
        errorMessage: e.message,
      });
      return next({
        status: 500,
        message: 'Unable to connect to LazyLibrarian.',
      });
    }
  }

  await settings.save();

  return res.status(200).json(settings.lazylibrarian);
});

settingsRoutes.post('/lazylibrarian/test', async (req, res, next) => {
  try {
    const lazyLibrarianClient = new LazyLibrarianAPI({
      hostname: req.body.hostname,
      port: req.body.port,
      useSsl: req.body.useSsl,
      urlBase: req.body.urlBase,
      apiKey: req.body.apiKey,
    });

    const version = await lazyLibrarianClient.getVersion();

    return res.status(200).json({ version });
  } catch (e) {
    logger.error('Failed to test LazyLibrarian', {
      label: 'LazyLibrarian',
      message: e.message,
    });

    next({ status: 500, message: 'Failed to connect to LazyLibrarian' });
  }
});

settingsRoutes.get('/tautulli', (_req, res) => {
  const settings = getSettings();

  res.status(200).json(settings.tautulli);
});

settingsRoutes.post('/tautulli', async (req, res, next) => {
  const settings = getSettings();

  Object.assign(settings.tautulli, req.body);

  if (settings.tautulli.hostname) {
    try {
      const tautulliClient = new TautulliAPI(settings.tautulli);

      const result = await tautulliClient.getInfo();

      if (!semver.gte(semver.coerce(result?.tautulli_version) ?? '', '2.9.0')) {
        throw new Error('Tautulli version not supported');
      }

      await settings.save();
    } catch (e) {
      logger.error('Something went wrong testing Tautulli connection', {
        label: 'API',
        errorMessage: e.message,
      });
      return next({
        status: 500,
        message: 'Unable to connect to Tautulli.',
      });
    }
  }

  return res.status(200).json(settings.tautulli);
});

settingsRoutes.get(
  '/plex/users',
  isAuthenticated(Permission.MANAGE_USERS),
  async (req, res, next) => {
    const userRepository = getRepository(User);
    const qb = userRepository.createQueryBuilder('user');

    try {
      const admin = await userRepository.findOneOrFail({
        select: { id: true, plexToken: true },
        where: { id: 1 },
      });
      const plexApi = new PlexTvAPI(admin.plexToken ?? '');
      const plexUsers = (await plexApi.getUsers()).MediaContainer.User.map(
        (user) => user.$
      ).filter((user) => user.email);

      const unimportedPlexUsers: {
        id: string;
        title: string;
        username: string;
        email: string;
        thumb: string;
      }[] = [];

      const plexIds = plexUsers.map((plexUser) => plexUser.id);
      const plexEmails = plexUsers.map((plexUser) =>
        plexUser.email.toLowerCase()
      );
      if (!plexIds.length) plexIds.push('-1');
      if (!plexEmails.length) plexEmails.push('@');

      const existingUsers = await qb
        .where('user.plexId IN (:...plexIds)', { plexIds })
        .orWhere('user.email IN (:...plexEmails)', { plexEmails })
        .getMany();

      await Promise.all(
        plexUsers.map(async (plexUser) => {
          if (
            !existingUsers.find(
              (user) =>
                user.plexId === parseInt(plexUser.id) ||
                user.email === plexUser.email.toLowerCase()
            ) &&
            (await plexApi.checkUserAccess(parseInt(plexUser.id)))
          ) {
            unimportedPlexUsers.push(plexUser);
          }
        })
      );

      return res.status(200).json(sortBy(unimportedPlexUsers, 'username'));
    } catch (e) {
      logger.error('Something went wrong getting unimported Plex users', {
        label: 'API',
        errorMessage: e.message,
      });
      next({
        status: 500,
        message: 'Unable to retrieve unimported Plex users.',
      });
    }
  }
);

settingsRoutes.get(
  '/logs',
  rateLimit({ windowMs: 60 * 1000, max: 50 }),
  (req, res, next) => {
    const pageSize = req.query.take ? Number(req.query.take) : 25;
    const skip = req.query.skip ? Number(req.query.skip) : 0;
    const search = (req.query.search as string) ?? '';
    const searchRegexp = new RegExp(escapeRegExp(search), 'i');

    let filter: string[] = [];
    switch (req.query.filter) {
      case 'debug':
        filter.push('debug');
      // falls through
      case 'info':
        filter.push('info');
      // falls through
      case 'warn':
        filter.push('warn');
      // falls through
      case 'error':
        filter.push('error');
        break;
      default:
        filter = ['debug', 'info', 'warn', 'error'];
    }

    const logFile = process.env.CONFIG_DIRECTORY
      ? `${process.env.CONFIG_DIRECTORY}/logs/.machinelogs.json`
      : path.join(__dirname, '../../../config/logs/.machinelogs.json');
    const logs: LogMessage[] = [];
    const logMessageProperties = [
      'timestamp',
      'level',
      'label',
      'message',
      'data',
    ];

    const deepValueStrings = (obj: Record<string, unknown>): string[] => {
      const values = [];

      for (const val of Object.values(obj)) {
        if (typeof val === 'string') {
          values.push(val);
        } else if (typeof val === 'number') {
          values.push(val.toString());
        } else if (val !== null && typeof val === 'object') {
          values.push(...deepValueStrings(val as Record<string, unknown>));
        }
      }

      return values;
    };

    try {
      fs.readFileSync(logFile, 'utf-8')
        .split('\n')
        .forEach((line) => {
          if (!line.length) return;

          const logMessage = JSON.parse(line);

          if (!filter.includes(logMessage.level)) {
            return;
          }

          if (
            !Object.keys(logMessage).every((key) =>
              logMessageProperties.includes(key)
            )
          ) {
            Object.keys(logMessage)
              .filter((prop) => !logMessageProperties.includes(prop))
              .forEach((prop) => {
                set(logMessage, `data.${prop}`, logMessage[prop]);
              });
          }

          if (req.query.search) {
            if (
              // label and data are sometimes undefined
              !searchRegexp.test(logMessage.label ?? '') &&
              !searchRegexp.test(logMessage.message) &&
              !deepValueStrings(logMessage.data ?? {}).some((val) =>
                searchRegexp.test(val)
              )
            ) {
              return;
            }
          }

          logs.push(logMessage);
        });

      const displayedLogs = logs.reverse().slice(skip, skip + pageSize);

      return res.status(200).json({
        pageInfo: {
          pages: Math.ceil(logs.length / pageSize),
          pageSize,
          results: logs.length,
          page: Math.ceil(skip / pageSize) + 1,
        },
        results: displayedLogs,
      } as LogsResultsResponse);
    } catch (error) {
      logger.error('Something went wrong while retrieving logs', {
        label: 'Logs',
        errorMessage: error.message,
      });
      return next({
        status: 500,
        message: 'Unable to retrieve logs.',
      });
    }
  }
);

// A job with the health of its last runs. Only scan jobs track health.
const serializeJob = (job: (typeof scheduledJobs)[number]) => {
  const health = scanHealth.get(job.id);

  return {
    id: job.id,
    name: job.name,
    type: job.type,
    interval: job.interval,
    cronSchedule: job.cronSchedule,
    nextExecutionTime: job.job.nextInvocation(),
    running: job.running ? job.running() : false,
    lastSuccess: health?.lastSuccess ?? null,
    lastError: health?.lastError ?? null,
    consecutiveFailures: health?.consecutiveFailures ?? 0,
    failing: (health?.consecutiveFailures ?? 0) >= SCAN_FAILURE_THRESHOLD,
  };
};

settingsRoutes.get('/jobs', (_req, res) => {
  return res
    .status(200)
    .json(
      scheduledJobs.filter((job) => job.inUse?.() ?? true).map(serializeJob)
    );
});

// Scans that keep failing, one per service, for the admin banner
settingsRoutes.get('/jobs/alerts', (_req, res) => {
  return res.status(200).json(
    scanHealth.alerts().map((alert) => ({
      service: alert.service,
      serviceName: scanServiceName(alert.service),
      jobId: alert.jobId,
      reason: alert.reason,
      lastSuccess: alert.lastSuccess ?? null,
      consecutiveFailures: alert.consecutiveFailures,
      settingsPath: SCAN_SERVICE_PATHS[alert.service],
    }))
  );
});

settingsRoutes.post<{ jobId: string }>('/jobs/:jobId/run', (req, res, next) => {
  const scheduledJob = scheduledJobs.find((job) => job.id === req.params.jobId);

  if (!scheduledJob) {
    return next({ status: 404, message: 'Job not found.' });
  }

  scheduledJob.job.invoke();

  return res.status(200).json(serializeJob(scheduledJob));
});

settingsRoutes.post<{ jobId: JobId }>(
  '/jobs/:jobId/cancel',
  (req, res, next) => {
    const scheduledJob = scheduledJobs.find(
      (job) => job.id === req.params.jobId
    );

    if (!scheduledJob) {
      return next({ status: 404, message: 'Job not found.' });
    }

    if (scheduledJob.cancelFn) {
      scheduledJob.cancelFn();
    }

    return res.status(200).json(serializeJob(scheduledJob));
  }
);

settingsRoutes.post<{ jobId: JobId }>(
  '/jobs/:jobId/schedule',
  async (req, res, next) => {
    const scheduledJob = scheduledJobs.find(
      (job) => job.id === req.params.jobId
    );

    if (!scheduledJob) {
      return next({ status: 404, message: 'Job not found.' });
    }

    const result = rescheduleJob(scheduledJob.job, req.body.schedule);
    const settings = getSettings();

    if (result) {
      settings.jobs[scheduledJob.id].schedule = req.body.schedule;
      await settings.save();

      scheduledJob.cronSchedule = req.body.schedule;

      return res.status(200).json(serializeJob(scheduledJob));
    } else {
      return next({ status: 400, message: 'Invalid job schedule.' });
    }
  }
);

settingsRoutes.get('/cache', async (_req, res) => {
  const cacheManagerCaches = cacheManager.getAllCaches();

  const apiCaches = Object.values(cacheManagerCaches).map((cache) => ({
    id: cache.id,
    name: cache.name,
    stats: cache.getStats(),
  }));

  const tmdbImageCache = await ImageProxy.getImageStats('tmdb');
  const avatarImageCache = await ImageProxy.getImageStats('avatar');

  const stats: DnsStats | undefined = dnsCache?.getStats();
  const entries: DnsEntries | undefined = dnsCache?.getCacheEntries();

  return res.status(200).json({
    apiCaches,
    imageCache: {
      tmdb: tmdbImageCache,
      avatar: avatarImageCache,
    },
    dnsCache: {
      stats,
      entries,
    },
  });
});

settingsRoutes.post<{ cacheId: AvailableCacheIds }>(
  '/cache/:cacheId/flush',
  (req, res, next) => {
    const cache = cacheManager.getCache(req.params.cacheId);

    if (cache) {
      cache.flush();
      return res.status(204).send();
    }

    next({ status: 404, message: 'Cache not found.' });
  }
);

settingsRoutes.post<{ dnsEntry: string }>(
  '/cache/dns/:dnsEntry/flush',
  (req, res, next) => {
    const dnsEntry = req.params.dnsEntry;

    if (dnsCache) {
      dnsCache.clear(dnsEntry);
      return res.status(204).send();
    }

    next({ status: 404, message: 'Cache not found.' });
  }
);

settingsRoutes.post(
  '/initialize',
  isAuthenticated(Permission.ADMIN),
  async (_req, res) => {
    const settings = getSettings();

    settings.public.initialized = true;
    await settings.save();

    return res.status(200).json(settings.public);
  }
);

settingsRoutes.get('/about', async (req, res) => {
  const mediaRepository = getRepository(Media);
  const mediaRequestRepository = getRepository(MediaRequest);

  const totalMediaItems = await mediaRepository.count();
  const totalRequests = await mediaRequestRepository.count();

  return res.status(200).json({
    version: getAppVersion(),
    releaseBuild: isReleaseBuild(),
    totalMediaItems,
    totalRequests,
    tz: process.env.TZ,
    appDataPath: appDataPath(),
  } as SettingsAboutResponse);
});

export default settingsRoutes;
