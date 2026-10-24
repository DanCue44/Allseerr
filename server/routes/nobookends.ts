import { isUserAccessApp } from '@server/constants/userAccess';
import { ArrActionError } from '@server/lib/arrActions';
import { getNoBookEndsStatus } from '@server/lib/nobookends';
import {
  dismissAttentionItem,
  getAttentionItems,
} from '@server/lib/nobookendsAttention';
import { isPendingDirectoryNonce } from '@server/lib/nobookendsDirectory';
import {
  findNoBookEndsItem,
  withNoBookEndsRecordings,
} from '@server/lib/nobookendsItem';
import { Permission } from '@server/lib/permissions';
import { getSettings } from '@server/lib/settings';
import {
  ReadingAppError,
  connectNoBookEnds,
  getReadingApps,
  isTooManyAttempts,
  requestReadingAppAccess,
} from '@server/lib/userAccess/readingApps';
import logger from '@server/logger';
import { isAuthenticated } from '@server/middleware/auth';
import type { RequestHandler } from 'express';
import { Router } from 'express';

const nobookendsRoutes = Router();

// Audiobookshelf item ids are UUIDs, or li_ followed by letters and digits
const ITEM_ID = /^[\w-]{1,100}$/;

// Stuck download keys: chaptarr:<server id>:<download id>:<state>
const ATTENTION_KEY = /^chaptarr:\d+:.{1,300}:[a-z]+$/;

/**
 * Answers the NoBookEnds directory while Allseerr registers with it, which
 * proves this address is the Allseerr registering. Needs no sign in, and
 * says nothing for any other code.
 */
export const nobookendsDirectoryCheck: RequestHandler = (req, res, next) => {
  const nonce = req.query.nonce;

  if (typeof nonce !== 'string' || !isPendingDirectoryNonce(nonce)) {
    return next({ status: 404, message: 'Not found.' });
  }

  return res
    .status(200)
    .json({ nonce, title: getSettings().main.applicationTitle });
};

const getHint = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim()
    ? value.trim().slice(0, 300)
    : undefined;

/**
 * What the NoBookEnds app may offer the signed in user. The app calls it
 * with the key from its connect link to check the key and the features.
 */
nobookendsRoutes.get('/status', async (req, res, next) => {
  if (!req.user) {
    return next({ status: 403, message: 'Not signed in.' });
  }

  try {
    return res.status(200).json(await getNoBookEndsStatus(req.user));
  } catch (e) {
    logger.error('Failed to read the NoBookEnds status', {
      label: 'NoBookEnds',
      errorMessage: e.message,
    });
    return next({ status: 500, message: 'Unable to read the status.' });
  }
});

/**
 * Book downloads Chaptarr is stuck on, for the app's attention screen
 */
nobookendsRoutes.get(
  '/attention',
  isAuthenticated(Permission.MANAGE_REQUESTS),
  async (_req, res, next) => {
    try {
      return res.status(200).json({ results: await getAttentionItems() });
    } catch (e) {
      logger.error('Failed to list the stuck book downloads', {
        label: 'NoBookEnds',
        errorMessage: e.message,
      });
      return next({ status: 500, message: 'Unable to list the downloads.' });
    }
  }
);

/**
 * Removes a stuck download from Chaptarr and searches for the book again
 */
nobookendsRoutes.post<{ key: string }>(
  '/attention/:key/dismiss',
  isAuthenticated(Permission.MANAGE_REQUESTS),
  async (req, res, next) => {
    const { key } = req.params;

    if (!req.user || !ATTENTION_KEY.test(key)) {
      return next({ status: 400, message: 'Invalid download key.' });
    }

    const blocklist = String(req.query.blocklist ?? '').toLowerCase();

    try {
      return res.status(200).json(
        await dismissAttentionItem(key, req.user, {
          blocklist: blocklist !== 'false' && blocklist !== '0',
        })
      );
    } catch (e) {
      if (e instanceof ArrActionError) {
        return next({ status: e.status, message: e.message });
      }

      logger.error('Failed to remove a stuck book download', {
        label: 'NoBookEnds',
        key,
        errorMessage: e.message,
      });
      return next({ status: 502, message: e.message });
    }
  }
);

/**
 * The book an Audiobookshelf library item is of, so the app can show its
 * request status or report an issue with it
 */
nobookendsRoutes.get<{ absItemId: string }>(
  '/item/:absItemId',
  async (req, res, next) => {
    if (!req.user) {
      return next({ status: 403, message: 'Not signed in.' });
    }

    const { absItemId } = req.params;

    if (!ITEM_ID.test(absItemId)) {
      return next({ status: 400, message: 'Invalid item id.' });
    }

    try {
      const item = await findNoBookEndsItem(absItemId, {
        title: getHint(req.query.title),
        author: getHint(req.query.author),
      });

      if (!item) {
        return next({ status: 404, message: 'Book not found.' });
      }

      return res
        .status(200)
        .json(await withNoBookEndsRecordings(item, req.user));
    } catch (e) {
      logger.debug('Failed to find the book of an Audiobookshelf item', {
        label: 'NoBookEnds',
        absItemId,
        errorMessage: e.message,
      });
      return next({ status: 500, message: 'Unable to find the book.' });
    }
  }
);

/**
 * The reading apps the signed in user can use and where they stand in each,
 * like their Reading apps settings. Needs no request permission, people who
 * can only read and listen use it too.
 */
nobookendsRoutes.get('/reading-apps', async (req, res, next) => {
  if (!req.user) {
    return next({ status: 403, message: 'Not signed in.' });
  }

  const apps = await getReadingApps(req.user);

  return res.status(200).json({
    apps: apps.map(
      ({ app, name, purpose, state, username, publicUrl, message }) => ({
        app,
        name,
        purpose,
        state,
        ...(username ? { username } : {}),
        ...(publicUrl ? { publicUrl } : {}),
        ...(message ? { message } : {}),
      })
    ),
  });
});

const readingAppError = (e: unknown, app: string) => {
  if (e instanceof ReadingAppError) {
    return { status: e.status, message: e.message };
  }

  logger.error('Failed to connect NoBookEnds to a reading app', {
    label: 'NoBookEnds',
    app,
    errorMessage: (e as Error).message,
  });
  return { status: 500, message: 'Something went wrong. Try again.' };
};

/**
 * Signs NoBookEnds in to a reading app as the user: sets their account up
 * when an admin or the default for Plex users gave them the app (never
 * gives access), then answers with a key to sign in with, or a password
 * shown once where the app has no keys
 */
nobookendsRoutes.post<{ app: string }>(
  '/reading-apps/:app/connect',
  async (req, res, next) => {
    const { app } = req.params;

    if (!req.user) {
      return next({ status: 403, message: 'Not signed in.' });
    }
    if (!isUserAccessApp(app)) {
      return next({ status: 404, message: 'Unknown app.' });
    }
    if (isTooManyAttempts(`connect:${req.user.id}:${app}`)) {
      return next({
        status: 429,
        message: 'Too many tries. Wait a few minutes and try again.',
      });
    }

    try {
      return res.status(200).json(await connectNoBookEnds(req.user, app));
    } catch (e) {
      if (e instanceof ReadingAppError && e.signIn) {
        return res
          .status(e.status)
          .json({ message: e.message, signIn: e.signIn });
      }
      return next(readingAppError(e, app));
    }
  }
);

/**
 * Asks the admins for access to a reading app
 */
nobookendsRoutes.post<{ app: string }>(
  '/reading-apps/:app/request-access',
  async (req, res, next) => {
    const { app } = req.params;

    if (!req.user) {
      return next({ status: 403, message: 'Not signed in.' });
    }
    if (!isUserAccessApp(app)) {
      return next({ status: 404, message: 'Unknown app.' });
    }

    try {
      const status = await requestReadingAppAccess(req.user, app);

      return res.status(200).json({ state: status.state });
    } catch (e) {
      return next(readingAppError(e, app));
    }
  }
);

export default nobookendsRoutes;
