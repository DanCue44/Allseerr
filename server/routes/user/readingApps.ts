import type { UserAccessApp } from '@server/constants/userAccess';
import { isUserAccessApp } from '@server/constants/userAccess';
import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import type {
  NewAppPassword,
  ReadingAppSetupResult,
  ReadingAppStatus,
  ReadingAppsResponse,
} from '@server/interfaces/api/userAccessInterfaces';
import {
  ReadingAppError,
  getReadingAppChoices,
  getReadingApps,
  isTooManyAttempts,
  newReadingAppPassword,
  requestReadingAppAccess,
  setUpReadingApp,
} from '@server/lib/userAccess/readingApps';
import logger from '@server/logger';
import type { NextFunction, Request } from 'express';
import { Router } from 'express';
import { canModifyUser } from '.';

/**
 * A person's own reading app accounts, under their user settings. The
 * person themself or an admin who manages users may use them; nobody can
 * give themselves access here.
 */
const readingAppsRoutes = Router({ mergeParams: true });

const findUser = async (req: Request): Promise<User | null> => {
  const id = Number(req.params.id);

  return Number.isInteger(id) && id > 0
    ? getRepository(User).findOne({ where: { id } })
    : null;
};

const CANNOT_MODIFY =
  "You do not have permission to modify this user's settings.";

const parseApp = (value: string): UserAccessApp | null =>
  isUserAccessApp(value) ? value : null;

const handleError = (e: unknown, next: NextFunction, app: string) => {
  if (e instanceof ReadingAppError) {
    return next({ status: e.status, message: e.message });
  }

  logger.error('Failed to handle a reading app request', {
    label: 'User Access',
    app,
    errorMessage: (e as Error).message,
  });
  return next({ status: 500, message: 'Something went wrong. Try again.' });
};

readingAppsRoutes.get<{ id: string }, ReadingAppsResponse>(
  '/',
  async (req, res, next) => {
    const user = await findUser(req);

    if (!user) {
      return next({ status: 404, message: 'User not found.' });
    }

    return res.status(200).json({
      apps: await getReadingApps(user),
      readingApps: getReadingAppChoices(),
    });
  }
);

/**
 * Makes the person's account in an app they were given, in one tap
 */
readingAppsRoutes.post<{ id: string; app: string }, ReadingAppSetupResult>(
  '/:app/setup',
  async (req, res, next) => {
    const user = await findUser(req);
    const app = parseApp(req.params.app);

    if (!user) {
      return next({ status: 404, message: 'User not found.' });
    }
    if (!canModifyUser(user, req.user)) {
      return next({ status: 403, message: CANNOT_MODIFY });
    }
    if (!app) {
      return next({ status: 404, message: 'Unknown app.' });
    }
    if (isTooManyAttempts(`setup:${user.id}:${app}`)) {
      return next({
        status: 429,
        message: 'Too many tries. Wait a few minutes and try again.',
      });
    }

    try {
      const { status, password } = await setUpReadingApp(user, app);

      return res
        .status(200)
        .json({ app: status, ...(password ? { password } : {}) });
    } catch (e) {
      return handleError(e, next, app);
    }
  }
);

/**
 * A new password for the person's account, shown once
 */
readingAppsRoutes.post<{ id: string; app: string }, NewAppPassword>(
  '/:app/password',
  async (req, res, next) => {
    const user = await findUser(req);
    const app = parseApp(req.params.app);

    if (!user) {
      return next({ status: 404, message: 'User not found.' });
    }
    if (!canModifyUser(user, req.user)) {
      return next({ status: 403, message: CANNOT_MODIFY });
    }
    if (!app) {
      return next({ status: 404, message: 'Unknown app.' });
    }
    if (isTooManyAttempts(`password:${user.id}:${app}`)) {
      return next({
        status: 429,
        message: 'Too many tries. Wait a few minutes and try again.',
      });
    }

    try {
      return res.status(200).json(await newReadingAppPassword(user, app));
    } catch (e) {
      return handleError(e, next, app);
    }
  }
);

/**
 * Asks the admins for access to an app
 */
readingAppsRoutes.post<{ id: string; app: string }, { app: ReadingAppStatus }>(
  '/:app/request-access',
  async (req, res, next) => {
    const user = await findUser(req);
    const app = parseApp(req.params.app);

    if (!user) {
      return next({ status: 404, message: 'User not found.' });
    }
    if (!canModifyUser(user, req.user)) {
      return next({ status: 403, message: CANNOT_MODIFY });
    }
    if (!app) {
      return next({ status: 404, message: 'Unknown app.' });
    }

    try {
      return res
        .status(200)
        .json({ app: await requestReadingAppAccess(user, app) });
    } catch (e) {
      return handleError(e, next, app);
    }
  }
);

export default readingAppsRoutes;
