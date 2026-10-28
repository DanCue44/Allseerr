import JellyfinAPI from '@server/api/jellyfin';
import PlexTvAPI from '@server/api/plextv';
import { isBookLanguage } from '@server/constants/bookLanguages';
import { ApiErrorCode } from '@server/constants/error';
import { MediaServerType } from '@server/constants/server';
import { UserType } from '@server/constants/user';
import { getRepository } from '@server/datasource';
import { NoBookEndsDevice } from '@server/entity/NoBookEndsDevice';
import { User } from '@server/entity/User';
import { UserSettings } from '@server/entity/UserSettings';
import type {
  UserSettingsGeneralResponse,
  UserSettingsNotificationsResponse,
} from '@server/interfaces/api/userSettingsInterfaces';
import {
  MOVIE_RATINGS,
  TV_RATINGS,
  parseRatingLimit,
} from '@server/lib/contentRatingLimit';
import {
  getNoBookEndsAllseerrUrl,
  getNoBookEndsConnectTarget,
  isNoBookEndsAvailable,
} from '@server/lib/nobookends';
import type { NoBookEndsDeviceResponse } from '@server/lib/nobookendsDevices';
import {
  connectNoBookEndsDevice,
  getNoBookEndsDevices,
} from '@server/lib/nobookendsDevices';
import { Permission } from '@server/lib/permissions';
import { getSettings } from '@server/lib/settings';
import { generateUserApiKey, hashUserApiKey } from '@server/lib/userApiKey';
import logger from '@server/logger';
import { isAuthenticated } from '@server/middleware/auth';
import { quickConnectSecret } from '@server/routes/auth';
import { ApiError } from '@server/types/error';
import { normalizeHexColor } from '@server/utils/accentColor';
import { getHostname } from '@server/utils/getHostname';
import {
  isOwnProfile,
  isOwnProfileOrAdmin,
} from '@server/utils/profileMiddleware';
import type { Request } from 'express';
import { Router } from 'express';
import net from 'net';
import { Not } from 'typeorm';
import { canMakePermissionsChange } from '.';
import readingAppsRoutes from './readingApps';

const userSettingsRoutes = Router({ mergeParams: true });

// Every signed in person can set up the reading apps they were given, even
// without permission to request
userSettingsRoutes.use('/apps', isOwnProfileOrAdmin(), readingAppsRoutes);

userSettingsRoutes.get<{ id: string }, UserSettingsGeneralResponse>(
  '/main',
  isOwnProfileOrAdmin(),
  async (req, res, next) => {
    const {
      main: { defaultQuotas },
    } = getSettings();
    const userRepository = getRepository(User);

    try {
      const user = await userRepository.findOne({
        where: { id: Number(req.params.id) },
      });

      if (!user) {
        return next({ status: 404, message: 'User not found.' });
      }

      return res.status(200).json({
        username: user.username,
        email: user.email,
        locale: user.settings?.locale,
        discoverRegion: user.settings?.discoverRegion,
        streamingRegion: user.settings?.streamingRegion,
        originalLanguage: user.settings?.originalLanguage,
        accentColor: user.settings?.accentColor ?? null,
        bookLanguage: user.settings?.bookLanguage ?? null,
        movieQuotaLimit: user.movieQuotaLimit,
        movieQuotaDays: user.movieQuotaDays,
        tvQuotaLimit: user.tvQuotaLimit,
        tvQuotaDays: user.tvQuotaDays,
        musicQuotaLimit: user.musicQuotaLimit,
        musicQuotaDays: user.musicQuotaDays,
        bookQuotaLimit: user.bookQuotaLimit,
        bookQuotaDays: user.bookQuotaDays,
        movieRatingLimit: user.movieRatingLimit,
        tvRatingLimit: user.tvRatingLimit,
        globalMovieQuotaDays: defaultQuotas.movie.quotaDays,
        globalMovieQuotaLimit: defaultQuotas.movie.quotaLimit,
        globalTvQuotaDays: defaultQuotas.tv.quotaDays,
        globalTvQuotaLimit: defaultQuotas.tv.quotaLimit,
        globalMusicQuotaDays: defaultQuotas.music?.quotaDays,
        globalMusicQuotaLimit: defaultQuotas.music?.quotaLimit,
        globalBookQuotaDays: defaultQuotas.book?.quotaDays,
        globalBookQuotaLimit: defaultQuotas.book?.quotaLimit,
        watchlistSyncMovies: user.settings?.watchlistSyncMovies,
        watchlistSyncTv: user.settings?.watchlistSyncTv,
        hideWatched: user.settings?.hideWatched,
      });
    } catch (e) {
      next({ status: 500, message: e.message });
    }
  }
);

userSettingsRoutes.post<
  { id: string },
  UserSettingsGeneralResponse,
  UserSettingsGeneralResponse
>('/main', isOwnProfileOrAdmin(), async (req, res, next) => {
  const userRepository = getRepository(User);

  try {
    const user = await userRepository.findOne({
      where: { id: Number(req.params.id) },
    });

    if (!user) {
      return next({ status: 404, message: 'User not found.' });
    }

    // "Owner" user settings cannot be modified by other users
    if (user.id === 1 && req.user?.id !== 1) {
      return next({
        status: 403,
        message: "You do not have permission to modify this user's settings.",
      });
    }

    const oldEmail = user.email;
    user.username = req.body.username;
    if (user.userType !== UserType.PLEX) {
      user.email = req.body.email || user.jellyfinUsername || user.email;
    }

    const existingUser = await userRepository.findOne({
      where: { email: user.email, id: Not(user.id) },
    });

    if (oldEmail !== user.email && existingUser) {
      throw new ApiError(400, ApiErrorCode.InvalidEmail);
    }

    // Update quota values only if the user has the correct permissions
    if (
      !user.hasPermission(Permission.MANAGE_USERS) &&
      req.user?.id !== user.id
    ) {
      user.movieQuotaDays = req.body.movieQuotaDays;
      user.movieQuotaLimit = req.body.movieQuotaLimit;
      user.tvQuotaDays = req.body.tvQuotaDays;
      user.tvQuotaLimit = req.body.tvQuotaLimit;
      user.musicQuotaDays = req.body.musicQuotaDays;
      user.musicQuotaLimit = req.body.musicQuotaLimit;
      user.bookQuotaDays = req.body.bookQuotaDays;
      user.bookQuotaLimit = req.body.bookQuotaLimit;
    }

    // Rating limits can only be changed by users with the MANAGE_USERS
    // permission, which also covers managers limiting their own profile
    if (
      req.user?.hasPermission(Permission.MANAGE_USERS) &&
      req.body.movieRatingLimit !== undefined
    ) {
      user.movieRatingLimit = parseRatingLimit(
        MOVIE_RATINGS,
        req.body.movieRatingLimit
      );
    }

    if (
      req.user?.hasPermission(Permission.MANAGE_USERS) &&
      req.body.tvRatingLimit !== undefined
    ) {
      user.tvRatingLimit = parseRatingLimit(TV_RATINGS, req.body.tvRatingLimit);
    }

    // An empty or invalid color falls back to the server accent
    const accentColor = normalizeHexColor(req.body.accentColor) ?? null;

    if (
      req.body.bookLanguage !== undefined &&
      req.body.bookLanguage !== null &&
      req.body.bookLanguage !== '' &&
      !isBookLanguage(req.body.bookLanguage)
    ) {
      return next({ status: 400, message: 'Unknown book language.' });
    }

    // An empty language uses the server default
    const bookLanguage = req.body.bookLanguage || null;

    if (!user.settings) {
      user.settings = new UserSettings({
        user: req.user,
        locale: req.body.locale,
        accentColor,
        bookLanguage,
        discoverRegion: req.body.discoverRegion,
        streamingRegion: req.body.streamingRegion,
        originalLanguage: req.body.originalLanguage,
        watchlistSyncMovies: req.body.watchlistSyncMovies,
        watchlistSyncTv: req.body.watchlistSyncTv,
        hideWatched: req.body.hideWatched,
      });
    } else {
      user.settings.locale = req.body.locale;
      user.settings.discoverRegion = req.body.discoverRegion;
      user.settings.streamingRegion = req.body.streamingRegion;
      user.settings.originalLanguage = req.body.originalLanguage;
      if (req.body.accentColor !== undefined) {
        user.settings.accentColor = accentColor;
      }
      if (req.body.bookLanguage !== undefined) {
        user.settings.bookLanguage = bookLanguage;
      }
      user.settings.watchlistSyncMovies = req.body.watchlistSyncMovies;
      user.settings.watchlistSyncTv = req.body.watchlistSyncTv;
      user.settings.hideWatched = req.body.hideWatched;
    }

    const savedUser = await userRepository.save(user);

    return res.status(200).json({
      username: savedUser.username,
      locale: savedUser.settings?.locale,
      discoverRegion: savedUser.settings?.discoverRegion,
      streamingRegion: savedUser.settings?.streamingRegion,
      originalLanguage: savedUser.settings?.originalLanguage,
      accentColor: savedUser.settings?.accentColor ?? null,
      bookLanguage: savedUser.settings?.bookLanguage ?? null,
      watchlistSyncMovies: savedUser.settings?.watchlistSyncMovies,
      watchlistSyncTv: savedUser.settings?.watchlistSyncTv,
      hideWatched: savedUser.settings?.hideWatched,
      movieRatingLimit: savedUser.movieRatingLimit,
      tvRatingLimit: savedUser.tvRatingLimit,
      email: savedUser.email,
    });
  } catch (e) {
    if (e.errorCode) {
      return next({
        status: e.statusCode,
        message: e.errorCode,
      });
    }
    return next({ status: 500, message: e.message });
  }
});

// Records the guided tour version a user has seen, so it is offered once
// per user and not again on every device they sign in from
userSettingsRoutes.post<{ id: string }, { tourVersion: number }>(
  '/tour',
  isOwnProfile(),
  async (req, res, next) => {
    const userRepository = getRepository(User);
    const version = Number(req.body?.version);

    if (!Number.isInteger(version) || version < 0) {
      return next({ status: 400, message: 'Invalid tour version.' });
    }

    try {
      const user = await userRepository.findOne({
        where: { id: Number(req.params.id) },
      });

      if (!user) {
        return next({ status: 404, message: 'User not found.' });
      }

      if (!user.settings) {
        user.settings = new UserSettings({ user, tourVersion: version });
      } else {
        user.settings.tourVersion = version;
      }

      const savedUser = await userRepository.save(user);

      return res
        .status(200)
        .json({ tourVersion: savedUser.settings?.tourVersion ?? version });
    } catch (e) {
      return next({ status: 500, message: e.message });
    }
  }
);

userSettingsRoutes.get<{ id: string }, { hasPassword: boolean }>(
  '/password',
  isOwnProfileOrAdmin(),
  async (req, res, next) => {
    const userRepository = getRepository(User);

    try {
      const user = await userRepository.findOne({
        where: { id: Number(req.params.id) },
        select: ['id', 'password'],
      });

      if (!user) {
        return next({ status: 404, message: 'User not found.' });
      }

      return res.status(200).json({ hasPassword: !!user.password });
    } catch (e) {
      next({ status: 500, message: e.message });
    }
  }
);

userSettingsRoutes.post<
  { id: string },
  null,
  { currentPassword?: string; newPassword: string }
>('/password', isOwnProfileOrAdmin(), async (req, res, next) => {
  const userRepository = getRepository(User);

  try {
    const user = await userRepository.findOne({
      where: { id: Number(req.params.id) },
    });

    const userWithPassword = await userRepository.findOne({
      select: ['id', 'password'],
      where: { id: Number(req.params.id) },
    });

    if (!user || !userWithPassword) {
      return next({ status: 404, message: 'User not found.' });
    }

    if (req.body.newPassword.length < 8) {
      return next({
        status: 400,
        message: 'Password must be at least 8 characters.',
      });
    }

    if (
      (user.id === 1 && req.user?.id !== 1) ||
      (user.hasPermission(Permission.ADMIN) &&
        user.id !== req.user?.id &&
        req.user?.id !== 1)
    ) {
      return next({
        status: 403,
        message: "You do not have permission to modify this user's password.",
      });
    }

    // If the user has the permission to manage users and they are not
    // editing themselves, we will just set the new password
    if (
      req.user?.hasPermission(Permission.MANAGE_USERS) &&
      req.user?.id !== user.id
    ) {
      await user.setPassword(req.body.newPassword);
      await userRepository.save(user);
      logger.debug('Password overriden by user.', {
        label: 'User Settings',
        userEmail: user.email,
        changingUser: req.user.email,
      });
      return res.status(204).send();
    }

    // If the user has a password, we need to check the currentPassword is correct
    if (
      user.password &&
      (!req.body.currentPassword ||
        !(await userWithPassword.passwordMatch(req.body.currentPassword)))
    ) {
      logger.debug(
        'Attempt to change password for user failed. Invalid current password provided.',
        { label: 'User Settings', userEmail: user.email }
      );
      return next({ status: 403, message: 'Current password is invalid.' });
    }

    await user.setPassword(req.body.newPassword);
    await userRepository.save(user);

    return res.status(204).send();
  } catch (e) {
    next({ status: 500, message: e.message });
  }
});

userSettingsRoutes.post<{ authToken: string }>(
  '/linked-accounts/plex',
  isOwnProfile(),
  async (req, res) => {
    const settings = getSettings();
    const userRepository = getRepository(User);

    if (!req.user) {
      return res.status(404).json({ code: ApiErrorCode.Unauthorized });
    }
    // Make sure Plex login is enabled
    if (settings.main.mediaServerType !== MediaServerType.PLEX) {
      return res.status(500).json({ message: 'Plex login is disabled' });
    }

    // First we need to use this auth token to get the user's email from plex.tv
    const plextv = new PlexTvAPI(req.body.authToken);
    const account = await plextv.getUser();

    // Do not allow linking of an already linked account
    if (await userRepository.exist({ where: { plexId: account.id } })) {
      return res.status(422).json({
        message: 'This Plex account is already linked to a Seerr user',
      });
    }

    const user = req.user;

    // Emails do not match
    if (user.email !== account.email) {
      return res.status(422).json({
        message:
          'This Plex account is registered under a different email address.',
      });
    }

    // valid plex user found, link to current user
    user.userType = UserType.PLEX;
    user.plexId = account.id;
    user.plexUsername = account.username;
    user.plexToken = account.authToken;
    user.plexTokenInvalidAt = null;
    await userRepository.save(user);

    return res.status(204).send();
  }
);

userSettingsRoutes.delete<{ id: string }>(
  '/linked-accounts/plex',
  isOwnProfileOrAdmin(),
  async (req, res) => {
    const settings = getSettings();
    const userRepository = getRepository(User);

    // Make sure Plex login is enabled
    if (settings.main.mediaServerType !== MediaServerType.PLEX) {
      return res.status(500).json({ message: 'Plex login is disabled' });
    }

    try {
      const user = await userRepository
        .createQueryBuilder('user')
        .addSelect('user.password')
        .where({
          id: Number(req.params.id),
        })
        .getOne();

      if (!user) {
        return res.status(404).json({ message: 'User not found.' });
      }

      if (user.id === 1) {
        return res.status(400).json({
          message:
            'Cannot unlink media server accounts for the primary administrator.',
        });
      }

      if (!user.email || !user.password) {
        return res.status(400).json({
          message: 'User does not have a local email or password set.',
        });
      }

      user.userType = UserType.LOCAL;
      user.plexId = null;
      user.plexUsername = null;
      user.plexToken = null;
      await userRepository.save(user);

      return res.status(204).send();
    } catch (e) {
      return res.status(500).json({ message: e.message });
    }
  }
);

userSettingsRoutes.post<{ username: string; password: string }>(
  '/linked-accounts/jellyfin',
  isOwnProfile(),
  async (req, res) => {
    const settings = getSettings();
    const userRepository = getRepository(User);

    if (!req.user) {
      return res.status(401).json({ code: ApiErrorCode.Unauthorized });
    }
    // Make sure jellyfin login is enabled
    if (
      settings.main.mediaServerType !== MediaServerType.JELLYFIN &&
      settings.main.mediaServerType !== MediaServerType.EMBY
    ) {
      return res
        .status(500)
        .json({ message: 'Jellyfin/Emby login is disabled' });
    }

    // Do not allow linking of an already linked account
    if (
      await userRepository.exist({
        where: { jellyfinUsername: req.body.username },
      })
    ) {
      return res.status(422).json({
        message: 'The specified account is already linked to a Seerr user',
      });
    }

    const hostname = getHostname();
    const deviceId = Buffer.from(
      req.user?.id === 1 ? 'BOT_seerr' : `BOT_seerr_${req.user.username ?? ''}`
    ).toString('base64');

    const jellyfinserver = new JellyfinAPI(hostname, undefined, deviceId);

    const ip = req.ip;
    let clientIp: string | undefined;
    if (ip) {
      if (net.isIPv4(ip)) {
        clientIp = ip;
      } else if (net.isIPv6(ip)) {
        clientIp = ip.startsWith('::ffff:') ? ip.substring(7) : ip;
      }
    }

    try {
      const account = await jellyfinserver.login(
        req.body.username,
        req.body.password,
        clientIp
      );

      // Do not allow linking of an already linked account
      if (
        await userRepository.exist({
          where: { jellyfinUserId: account.User.Id },
        })
      ) {
        return res.status(422).json({
          message: 'The specified account is already linked to a Seerr user',
        });
      }

      const user = req.user;

      // valid jellyfin user found, link to current user
      user.userType =
        settings.main.mediaServerType === MediaServerType.EMBY
          ? UserType.EMBY
          : UserType.JELLYFIN;
      user.jellyfinUserId = account.User.Id;
      user.jellyfinUsername = account.User.Name;
      user.jellyfinAuthToken = account.AccessToken;
      user.jellyfinDeviceId = deviceId;
      await userRepository.save(user);

      return res.status(204).send();
    } catch (e) {
      logger.error('Failed to link account to user.', {
        label: 'API',
        ip: req.ip,
        error: e,
      });
      if (
        e instanceof ApiError &&
        e.errorCode === ApiErrorCode.InvalidCredentials
      ) {
        return res.status(401).json({ code: e.errorCode });
      }

      return res.status(500).send();
    }
  }
);

userSettingsRoutes.delete<{ id: string }>(
  '/linked-accounts/jellyfin',
  isOwnProfileOrAdmin(),
  async (req, res) => {
    const settings = getSettings();
    const userRepository = getRepository(User);

    // Make sure jellyfin login is enabled
    if (
      settings.main.mediaServerType !== MediaServerType.JELLYFIN &&
      settings.main.mediaServerType !== MediaServerType.EMBY
    ) {
      return res
        .status(500)
        .json({ message: 'Jellyfin/Emby login is disabled' });
    }

    try {
      const user = await userRepository
        .createQueryBuilder('user')
        .addSelect('user.password')
        .where({
          id: Number(req.params.id),
        })
        .getOne();

      if (!user) {
        return res.status(404).json({ message: 'User not found.' });
      }

      if (user.id === 1) {
        return res.status(400).json({
          message:
            'Cannot unlink media server accounts for the primary administrator.',
        });
      }

      if (!user.email || !user.password) {
        return res.status(400).json({
          message: 'User does not have a local email or password set.',
        });
      }

      user.userType = UserType.LOCAL;
      user.jellyfinUserId = null;
      user.jellyfinUsername = null;
      user.jellyfinAuthToken = null;
      user.jellyfinDeviceId = null;
      await userRepository.save(user);

      return res.status(204).send();
    } catch (e) {
      return res.status(500).json({ message: e.message });
    }
  }
);

userSettingsRoutes.post<{ secret: string }>(
  '/linked-accounts/jellyfin/quickconnect',
  isOwnProfile(),
  async (req, res) => {
    const settings = getSettings();
    const userRepository = getRepository(User);

    if (!req.user) {
      return res.status(401).json({ code: ApiErrorCode.Unauthorized });
    }

    const result = quickConnectSecret.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({ message: 'Invalid secret format' });
    }

    const { secret } = result.data;

    if (
      settings.main.mediaServerType !== MediaServerType.JELLYFIN &&
      settings.main.mediaServerType !== MediaServerType.EMBY
    ) {
      return res
        .status(500)
        .json({ message: 'Jellyfin/Emby login is disabled' });
    }

    if (settings.main.mediaServerType !== MediaServerType.JELLYFIN) {
      return res
        .status(403)
        .json({ message: 'Quick Connect is only supported by Jellyfin.' });
    }

    const hostname = getHostname();
    const jellyfinServer = new JellyfinAPI(hostname);

    try {
      const account = await jellyfinServer.authenticateQuickConnect(secret);

      if (
        await userRepository.exist({
          where: { jellyfinUserId: account.User.Id },
        })
      ) {
        return res.status(422).json({
          message: 'The specified account is already linked to a Seerr user',
        });
      }

      const user = req.user;
      const deviceId = Buffer.from(
        user.id === 1 ? 'BOT_seerr' : `BOT_seerr_${user.username ?? ''}`
      ).toString('base64');

      user.userType = UserType.JELLYFIN;
      user.jellyfinUserId = account.User.Id;
      user.jellyfinUsername = account.User.Name;
      user.jellyfinAuthToken = account.AccessToken;
      user.jellyfinDeviceId = deviceId;
      await userRepository.save(user);

      return res.status(204).send();
    } catch (e) {
      logger.error('Failed to link account with Quick Connect.', {
        label: 'API',
        ip: req.ip,
        error: e,
      });

      const status = e instanceof ApiError ? e.statusCode : 500;
      return res.status(status).send();
    }
  }
);

userSettingsRoutes.get<{ id: string }, UserSettingsNotificationsResponse>(
  '/notifications',
  isOwnProfileOrAdmin(),
  async (req, res, next) => {
    const userRepository = getRepository(User);
    const settings = getSettings()?.notifications.agents;

    try {
      const user = await userRepository.findOne({
        where: { id: Number(req.params.id) },
      });

      if (!user) {
        return next({ status: 404, message: 'User not found.' });
      }

      return res.status(200).json({
        emailEnabled: settings.email.enabled,
        pgpKey: user.settings?.pgpKey,
        discordEnabled:
          settings?.discord.enabled && settings.discord.options.enableMentions,
        discordEnabledTypes:
          settings?.discord.enabled && settings.discord.options.enableMentions
            ? settings.discord.types
            : 0,
        discordIds: user.settings?.discordIds ?? [],
        pushbulletAccessToken: user.settings?.pushbulletAccessToken,
        pushoverApplicationToken: user.settings?.pushoverApplicationToken,
        pushoverUserKey: user.settings?.pushoverUserKey,
        pushoverSound: user.settings?.pushoverSound,
        telegramEnabled: settings.telegram.enabled,
        telegramBotUsername: settings.telegram.options.botUsername,
        telegramChatId: user.settings?.telegramChatId,
        telegramMessageThreadId: user.settings?.telegramMessageThreadId,
        telegramSendSilently: user.settings?.telegramSendSilently,
        webPushEnabled: settings.webpush.enabled,
        notificationTypes: user.settings?.notificationTypes ?? {},
      });
    } catch (e) {
      next({ status: 500, message: e.message });
    }
  }
);

userSettingsRoutes.post<{ id: string }, UserSettingsNotificationsResponse>(
  '/notifications',
  isOwnProfileOrAdmin(),
  async (req, res, next) => {
    const userRepository = getRepository(User);

    try {
      const user = await userRepository.findOne({
        where: { id: Number(req.params.id) },
      });

      if (!user) {
        return next({ status: 404, message: 'User not found.' });
      }

      // "Owner" user settings cannot be modified by other users
      if (user.id === 1 && req.user?.id !== 1) {
        return next({
          status: 403,
          message: "You do not have permission to modify this user's settings.",
        });
      }

      const discordIds =
        req.body.discordIds?.filter((id: string) => id !== '') ?? [];

      if (!user.settings) {
        user.settings = new UserSettings({
          user: req.user,
          pgpKey: req.body.pgpKey,
          discordIds,
          pushbulletAccessToken: req.body.pushbulletAccessToken,
          pushoverApplicationToken: req.body.pushoverApplicationToken,
          pushoverUserKey: req.body.pushoverUserKey,
          telegramChatId: req.body.telegramChatId,
          telegramMessageThreadId: req.body.telegramMessageThreadId,
          telegramSendSilently: req.body.telegramSendSilently,
          notificationTypes: req.body.notificationTypes,
        });
      } else {
        user.settings.pgpKey = req.body.pgpKey;
        user.settings.discordIds = discordIds;
        user.settings.pushbulletAccessToken = req.body.pushbulletAccessToken;
        user.settings.pushoverApplicationToken =
          req.body.pushoverApplicationToken;
        user.settings.pushoverUserKey = req.body.pushoverUserKey;
        user.settings.pushoverSound = req.body.pushoverSound;
        user.settings.telegramChatId = req.body.telegramChatId;
        user.settings.telegramMessageThreadId =
          req.body.telegramMessageThreadId;
        user.settings.telegramSendSilently = req.body.telegramSendSilently;
        user.settings.notificationTypes = Object.assign(
          {},
          user.settings.notificationTypes,
          req.body.notificationTypes
        );
      }

      await userRepository.save(user);

      return res.status(200).json({
        pgpKey: user.settings.pgpKey,
        discordIds: user.settings.discordIds ?? [],
        pushbulletAccessToken: user.settings.pushbulletAccessToken,
        pushoverApplicationToken: user.settings.pushoverApplicationToken,
        pushoverUserKey: user.settings.pushoverUserKey,
        pushoverSound: user.settings.pushoverSound,
        telegramChatId: user.settings.telegramChatId,
        telegramMessageThreadId: user.settings.telegramMessageThreadId,
        telegramSendSilently: user.settings.telegramSendSilently,
        notificationTypes: user.settings.notificationTypes,
      });
    } catch (e) {
      next({ status: 500, message: e.message });
    }
  }
);

userSettingsRoutes.get<{ id: string }, { permissions?: number }>(
  '/permissions',
  isAuthenticated(Permission.MANAGE_USERS),
  async (req, res, next) => {
    const userRepository = getRepository(User);

    try {
      const user = await userRepository.findOne({
        where: { id: Number(req.params.id) },
      });

      if (!user) {
        return next({ status: 404, message: 'User not found.' });
      }

      return res.status(200).json({ permissions: user.permissions });
    } catch (e) {
      next({ status: 500, message: e.message });
    }
  }
);

userSettingsRoutes.post<
  { id: string },
  { permissions?: number },
  { permissions: number }
>(
  '/permissions',
  isAuthenticated(Permission.MANAGE_USERS),
  async (req, res, next) => {
    const userRepository = getRepository(User);

    try {
      const user = await userRepository.findOne({
        where: { id: Number(req.params.id) },
      });

      if (!user) {
        return next({ status: 404, message: 'User not found.' });
      }

      // "Owner" user permissions cannot be modified, and users cannot set their own permissions
      if (user.id === 1 || req.user?.id === user.id) {
        return next({
          status: 403,
          message: 'You do not have permission to modify this user',
        });
      }

      if (!canMakePermissionsChange(req.body.permissions, req.user)) {
        return next({
          status: 403,
          message: 'You do not have permission to grant this level of access',
        });
      }
      user.permissions = req.body.permissions;

      await userRepository.save(user);

      return res.status(200).json({ permissions: user.permissions });
    } catch (e) {
      next({ status: 500, message: e.message });
    }
  }
);

userSettingsRoutes.get<
  { id: string },
  { hasApiKey: boolean; createdAt?: Date | null }
>('/api-key', isOwnProfileOrAdmin(), async (req, res, next) => {
  const userRepository = getRepository(User);

  try {
    const user = await userRepository.findOne({
      where: { id: Number(req.params.id) },
      select: ['id', 'apiKeyHash', 'apiKeyCreatedAt'],
    });

    if (!user) {
      return next({ status: 404, message: 'User not found.' });
    }

    return res.status(200).json({
      hasApiKey: !!user.apiKeyHash,
      createdAt: user.apiKeyHash ? user.apiKeyCreatedAt : null,
    });
  } catch (e) {
    next({ status: 500, message: e.message });
  }
});

// Only the owner can create a key, since it is shown once and acts as them
userSettingsRoutes.post<{ id: string }, { apiKey: string; createdAt: Date }>(
  '/api-key',
  isOwnProfile(),
  async (req, res, next) => {
    const userRepository = getRepository(User);

    try {
      const user = await userRepository.findOne({
        where: { id: Number(req.params.id) },
      });

      if (!user) {
        return next({ status: 404, message: 'User not found.' });
      }

      const apiKey = generateUserApiKey();
      const createdAt = new Date();

      await userRepository.update(user.id, {
        apiKeyHash: hashUserApiKey(apiKey),
        apiKeyCreatedAt: createdAt,
      });

      logger.info('Personal API key generated', {
        label: 'API',
        userId: user.id,
      });

      return res.status(201).json({ apiKey, createdAt });
    } catch (e) {
      next({ status: 500, message: e.message });
    }
  }
);

userSettingsRoutes.delete<{ id: string }>(
  '/api-key',
  isOwnProfileOrAdmin(),
  async (req, res, next) => {
    const userRepository = getRepository(User);

    try {
      const user = await userRepository.findOne({
        where: { id: Number(req.params.id) },
      });

      if (!user) {
        return next({ status: 404, message: 'User not found.' });
      }

      await userRepository.update(user.id, {
        apiKeyHash: null,
        apiKeyCreatedAt: null,
      });

      logger.info('Personal API key revoked', {
        label: 'API',
        userId: user.id,
        revokedBy: req.user?.id,
      });

      return res.status(204).send();
    } catch (e) {
      next({ status: 500, message: e.message });
    }
  }
);

interface NoBookEndsConnection {
  // Whether books and Audiobookshelf are set up, so the app can connect
  available: boolean;
  // Whether any device is connected
  connected: boolean;
  // When the newest device connected
  createdAt?: Date | null;
  devices: NoBookEndsDeviceResponse[];
  // No Application URL is set and Allseerr was opened at a home address,
  // which the app could not reach away from home
  applicationUrlMissing: boolean;
}

const noBookEndsRequest = (req: Request) => ({
  protocol: req.protocol,
  hostname: req.hostname,
  host: req.get('host'),
});

userSettingsRoutes.get<{ id: string }, NoBookEndsConnection>(
  '/nobookends',
  isOwnProfileOrAdmin(),
  async (req, res, next) => {
    const userRepository = getRepository(User);

    try {
      const user = await userRepository.findOne({
        where: { id: Number(req.params.id) },
        select: ['id', 'nobookendsKeyHash', 'nobookendsKeyCreatedAt'],
      });

      if (!user) {
        return next({ status: 404, message: 'User not found.' });
      }

      const devices = await getNoBookEndsDevices(user.id);
      const legacyCreatedAt = user.nobookendsKeyHash
        ? (user.nobookendsKeyCreatedAt ?? null)
        : null;

      return res.status(200).json({
        available: isNoBookEndsAvailable(),
        connected: devices.length > 0 || !!user.nobookendsKeyHash,
        createdAt: devices[0]?.createdAt ?? legacyCreatedAt,
        devices,
        applicationUrlMissing: !getNoBookEndsAllseerrUrl(
          noBookEndsRequest(req)
        ),
      });
    } catch (e) {
      next({ status: 500, message: e.message });
    }
  }
);

/**
 * Connects NoBookEnds on one more device: makes its key, the link that sets
 * the app up with it, and the app URL the connect page hands it back with.
 * Devices connected before keep working. Like the personal key, only the
 * owner can make it, as it is shown once.
 */
userSettingsRoutes.post<
  { id: string },
  {
    apiKey: string;
    createdAt: Date;
    connectUrl: string;
    appUrl: string;
    device: NoBookEndsDeviceResponse;
  },
  { device?: string } | undefined
>('/nobookends', isOwnProfile(), async (req, res, next) => {
  const userRepository = getRepository(User);

  try {
    const target = getNoBookEndsConnectTarget(noBookEndsRequest(req));

    if (target.error) {
      return next({ status: 400, message: target.message });
    }

    const user = await userRepository.findOne({
      where: { id: Number(req.params.id) },
    });

    if (!user) {
      return next({ status: 404, message: 'User not found.' });
    }

    const { apiKey, device, connectUrl, appUrl } =
      await connectNoBookEndsDevice(user, target.allseerrUrl, req.body?.device);

    return res.status(201).json({
      apiKey,
      createdAt: device.createdAt,
      connectUrl,
      appUrl,
      device,
    });
  } catch (e) {
    next({ status: 500, message: e.message });
  }
});

/**
 * Disconnects NoBookEnds on every device
 */
userSettingsRoutes.delete<{ id: string }>(
  '/nobookends',
  isOwnProfileOrAdmin(),
  async (req, res, next) => {
    const userRepository = getRepository(User);

    try {
      const user = await userRepository.findOne({
        where: { id: Number(req.params.id) },
      });

      if (!user) {
        return next({ status: 404, message: 'User not found.' });
      }

      await getRepository(NoBookEndsDevice).delete({ user: { id: user.id } });
      await userRepository.update(user.id, {
        nobookendsKeyHash: null,
        nobookendsKeyCreatedAt: null,
      });

      logger.info('NoBookEnds keys revoked', {
        label: 'API',
        userId: user.id,
        revokedBy: req.user?.id,
      });

      return res.status(204).send();
    } catch (e) {
      next({ status: 500, message: e.message });
    }
  }
);

/**
 * Disconnects NoBookEnds on one device
 */
userSettingsRoutes.delete<{ id: string; deviceId: string }>(
  '/nobookends/devices/:deviceId',
  isOwnProfileOrAdmin(),
  async (req, res, next) => {
    const repository = getRepository(NoBookEndsDevice);

    try {
      const device = await repository.findOne({
        where: {
          id: Number(req.params.deviceId),
          user: { id: Number(req.params.id) },
        },
      });

      if (!device) {
        return next({ status: 404, message: 'Device not found.' });
      }

      await repository.delete(device.id);

      logger.info('NoBookEnds device removed', {
        label: 'API',
        userId: Number(req.params.id),
        deviceId: device.id,
        revokedBy: req.user?.id,
      });

      return res.status(204).send();
    } catch (e) {
      next({ status: 500, message: e.message });
    }
  }
);

export default userSettingsRoutes;
