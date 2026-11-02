import type {
  DownloadRemoveBody,
  DownloadRemoveResponse,
  DownloadRetryImportResponse,
  DownloadsResponse,
  SeedingResponse,
} from '@server/interfaces/api/downloadInterfaces';
import { ArrActionError } from '@server/lib/arrActions';
import {
  getDownloads,
  removeDownload,
  retryImportDownload,
  searchDownload,
} from '@server/lib/downloads';
import { Permission } from '@server/lib/permissions';
import { getSeeding } from '@server/lib/talearrSeeding';
import logger from '@server/logger';
import { isAuthenticated } from '@server/middleware/auth';
import type { NextFunction } from 'express';
import { Router } from 'express';

// The count only feeds the badge in the navigation, so it may be older
const COUNT_MAX_AGE_MS = 60 * 1000;

/**
 * The queues of every Radarr, Sonarr, Lidarr and Chaptarr server in one
 * list, for admins, mounted at /downloads
 */
const downloadRoutes = Router();

downloadRoutes.use(isAuthenticated(Permission.ADMIN));

const handleError = (
  e: Error,
  id: string | undefined,
  next: NextFunction,
  action: string
) => {
  if (e instanceof ArrActionError) {
    return next({ status: e.status, message: e.message });
  }

  logger.error(`Something went wrong ${action}`, {
    label: 'Downloads',
    downloadId: id,
    errorMessage: e.message,
  });
  return next({ status: 502, message: e.message });
};

downloadRoutes.get<never, DownloadsResponse>('/', async (_req, res, next) => {
  try {
    return res.status(200).json(await getDownloads());
  } catch (e) {
    return handleError(e, undefined, next, 'listing the downloads');
  }
});

// The seeding torrents at risk, for the badge; Talearr not answering only
// leaves them out of the count
const countSeedingAtRisk = async (): Promise<number> => {
  try {
    const seeding = await getSeeding();
    return seeding.supported ? seeding.summary.atRisk : 0;
  } catch {
    return 0;
  }
};

downloadRoutes.get<
  never,
  { total: number; attention: number; seedingAtRisk: number }
>('/count', async (_req, res, next) => {
  try {
    const [{ totals }, seedingAtRisk] = await Promise.all([
      getDownloads({ maxAgeMs: COUNT_MAX_AGE_MS }),
      countSeedingAtRisk(),
    ]);

    return res.status(200).json({
      total: totals.total,
      attention: totals.attention,
      seedingAtRisk,
    });
  } catch (e) {
    return handleError(e, undefined, next, 'counting the downloads');
  }
});

downloadRoutes.get<never, SeedingResponse>(
  '/seeding',
  async (_req, res, next) => {
    try {
      return res.status(200).json(await getSeeding());
    } catch (e) {
      return handleError(e, undefined, next, 'reading what Talearr seeds');
    }
  }
);

downloadRoutes.post<{ downloadId: string }, DownloadRemoveResponse>(
  '/:downloadId/search',
  async (req, res, next) => {
    if (!req.user) {
      return next({ status: 500, message: 'User missing from request.' });
    }

    try {
      await searchDownload(req.params.downloadId, req.user);
      return res
        .status(200)
        .json({ removed: false, blocklisted: false, searched: true });
    } catch (e) {
      return handleError(e, req.params.downloadId, next, 'searching again');
    }
  }
);

downloadRoutes.post<{ downloadId: string }, DownloadRetryImportResponse>(
  '/:downloadId/retry-import',
  async (req, res, next) => {
    if (!req.user) {
      return next({ status: 500, message: 'User missing from request.' });
    }

    try {
      return res
        .status(200)
        .json(await retryImportDownload(req.params.downloadId, req.user));
    } catch (e) {
      return handleError(e, req.params.downloadId, next, 'retrying the import');
    }
  }
);

downloadRoutes.post<
  { downloadId: string },
  DownloadRemoveResponse,
  DownloadRemoveBody
>('/:downloadId/remove', async (req, res, next) => {
  if (!req.user) {
    return next({ status: 500, message: 'User missing from request.' });
  }

  try {
    return res.status(200).json(
      await removeDownload(req.params.downloadId, req.user, {
        removeFromClient: req.body?.removeFromClient !== false,
        blocklist: req.body?.blocklist === true,
        search: req.body?.search === true,
      })
    );
  } catch (e) {
    return handleError(e, req.params.downloadId, next, 'removing the download');
  }
});

export default downloadRoutes;
