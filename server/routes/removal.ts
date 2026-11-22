import { RemovalRequestStatus } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import RemovalRequest from '@server/entity/RemovalRequest';
import type {
  RemovalRequestBody,
  RemovalRequestResultsResponse,
  WatchedCleanupActionBody,
  WatchedCleanupActionResponse,
  WatchedCleanupResponse,
} from '@server/interfaces/api/removalInterfaces';
import { NoRemovalServiceError } from '@server/lib/mediaRemoval';
import { Permission } from '@server/lib/permissions';
import {
  DuplicateRemovalRequestError,
  RemovalNotAllowedError,
  RemovalRequestStateError,
  approveRemovalRequest,
  createRemovalRequest,
  declineRemovalRequest,
} from '@server/lib/removalRequests';
import {
  WatchedCleanupDisabledError,
  actOnCleanupSuggestions,
  getCleanupSuggestions,
} from '@server/lib/watchedCleanup';
import logger from '@server/logger';
import { isAuthenticated } from '@server/middleware/auth';
import { Router } from 'express';
import { EntityNotFoundError } from 'typeorm';

const removalRoutes = Router();

const filterStatuses: Record<string, RemovalRequestStatus[]> = {
  pending: [RemovalRequestStatus.PENDING, RemovalRequestStatus.FAILED],
  approved: [RemovalRequestStatus.APPROVED],
  declined: [RemovalRequestStatus.DECLINED],
  failed: [RemovalRequestStatus.FAILED],
};

removalRoutes.get<Record<string, string>, RemovalRequestResultsResponse>(
  '/',
  async (req, res, next) => {
    try {
      const pageSize = req.query.take ? Number(req.query.take) : 10;
      const skip = req.query.skip ? Number(req.query.skip) : 0;
      const filter = req.query.filter ? String(req.query.filter) : 'all';
      const mediaId = req.query.mediaId ? Number(req.query.mediaId) : undefined;

      let query = getRepository(RemovalRequest)
        .createQueryBuilder('removal')
        .leftJoinAndSelect('removal.media', 'media')
        .leftJoinAndSelect('removal.requestedBy', 'requestedBy')
        .leftJoinAndSelect('removal.modifiedBy', 'modifiedBy');

      if (filterStatuses[filter]) {
        query = query.where('removal.status IN (:...statuses)', {
          statuses: filterStatuses[filter],
        });
      }

      // Users without Manage Requests only ever see their own removal requests
      if (!req.user?.hasPermission(Permission.MANAGE_REQUESTS)) {
        query = query.andWhere('requestedBy.id = :userId', {
          userId: req.user?.id,
        });
      }

      if (mediaId) {
        query = query.andWhere('media.id = :mediaId', { mediaId });
      }

      const [removals, total] = await query
        .orderBy('removal.createdAt', 'DESC')
        .take(pageSize)
        .skip(skip)
        .getManyAndCount();

      return res.status(200).json({
        pageInfo: {
          pages: Math.ceil(total / pageSize),
          pageSize,
          results: total,
          page: Math.ceil(skip / pageSize) + 1,
        },
        results: removals,
      });
    } catch (e) {
      next({ status: 500, message: e.message });
    }
  }
);

removalRoutes.get(
  '/count',
  isAuthenticated(Permission.MANAGE_REQUESTS),
  async (_req, res, next) => {
    try {
      const pending = await getRepository(RemovalRequest)
        .createQueryBuilder('removal')
        .where('removal.status IN (:...statuses)', {
          statuses: filterStatuses.pending,
        })
        .getCount();

      return res.status(200).json({ pending });
    } catch (e) {
      next({ status: 500, message: e.message });
    }
  }
);

// Requested titles every requester has watched, for the admin to clear out.
// Listing and acting are admin only, and nothing is removed without a click.
removalRoutes.get<never, WatchedCleanupResponse>(
  '/suggestions',
  isAuthenticated(Permission.ADMIN),
  async (_req, res, next) => {
    try {
      return res.status(200).json({ results: await getCleanupSuggestions() });
    } catch (e) {
      if (e instanceof WatchedCleanupDisabledError) {
        return next({ status: 403, message: e.message });
      }
      logger.error('Failed to list watched cleanup suggestions', {
        label: 'Watched Cleanup',
        errorMessage: e.message,
      });
      next({ status: 500, message: e.message });
    }
  }
);

removalRoutes.post<
  never,
  WatchedCleanupActionResponse,
  WatchedCleanupActionBody
>('/suggestions', isAuthenticated(Permission.ADMIN), async (req, res, next) => {
  try {
    if (!req.user) {
      return next({ status: 401, message: 'You must be logged in.' });
    }

    const { items, action } = req.body ?? {};

    if (!Array.isArray(items) || items.length === 0) {
      return next({ status: 400, message: 'Choose at least one title.' });
    }
    if (action !== 'request' && action !== 'remove') {
      return next({
        status: 400,
        message: 'Action must be request or remove.',
      });
    }

    return res.status(200).json({
      results: await actOnCleanupSuggestions(items, action, req.user),
    });
  } catch (e) {
    if (e instanceof WatchedCleanupDisabledError) {
      return next({ status: 403, message: e.message });
    }
    next({ status: 500, message: e.message });
  }
});

removalRoutes.post<never, RemovalRequest, RemovalRequestBody>(
  '/',
  isAuthenticated(
    [
      Permission.REQUEST,
      Permission.REQUEST_MOVIE,
      Permission.REQUEST_TV,
      Permission.REQUEST_MUSIC,
      Permission.REQUEST_BOOK,
    ],
    { type: 'or' }
  ),
  async (req, res, next) => {
    try {
      if (!req.user) {
        return next({ status: 401, message: 'You must be logged in.' });
      }

      const removal = await createRemovalRequest(req.body, req.user);

      return res.status(201).json(removal);
    } catch (e) {
      if (e instanceof EntityNotFoundError) {
        return next({ status: 404, message: 'Media not found.' });
      }
      if (e instanceof RemovalNotAllowedError) {
        return next({ status: 400, message: e.message });
      }
      if (e instanceof DuplicateRemovalRequestError) {
        return next({ status: 409, message: e.message });
      }
      logger.error('Failed to create removal request', {
        label: 'Removal Request',
        errorMessage: e.message,
      });
      next({ status: 500, message: e.message });
    }
  }
);

removalRoutes.post<
  { removalId: string; status: 'approve' | 'decline' },
  RemovalRequest,
  { reason?: string }
>(
  '/:removalId/:status',
  isAuthenticated(Permission.MANAGE_REQUESTS),
  async (req, res, next) => {
    const removalId = Number(req.params.removalId);

    try {
      if (!req.user) {
        return next({ status: 401, message: 'You must be logged in.' });
      }

      switch (req.params.status) {
        case 'approve':
          return res
            .status(200)
            .json(await approveRemovalRequest(removalId, req.user));
        case 'decline':
          return res
            .status(200)
            .json(
              await declineRemovalRequest(removalId, req.user, req.body?.reason)
            );
        default:
          return next({
            status: 400,
            message: 'Status must be approve or decline.',
          });
      }
    } catch (e) {
      if (e instanceof EntityNotFoundError) {
        return next({ status: 404, message: 'Removal request not found.' });
      }
      if (e instanceof RemovalRequestStateError) {
        return next({ status: 409, message: e.message });
      }
      if (e instanceof NoRemovalServiceError) {
        return next({ status: 409, message: e.message });
      }
      next({ status: 500, message: e.message });
    }
  }
);

removalRoutes.delete<{ removalId: string }>(
  '/:removalId',
  async (req, res, next) => {
    try {
      const removalRepository = getRepository(RemovalRequest);
      const removal = await removalRepository.findOneOrFail({
        where: { id: Number(req.params.removalId) },
      });

      const isManager = req.user?.hasPermission(Permission.MANAGE_REQUESTS);

      if (!isManager && removal.requestedBy.id !== req.user?.id) {
        return next({
          status: 403,
          message: 'You do not have permission to delete this removal request.',
        });
      }

      if (!isManager && removal.status !== RemovalRequestStatus.PENDING) {
        return next({
          status: 409,
          message: 'Only pending removal requests can be cancelled.',
        });
      }

      await removalRepository.remove(removal);

      return res.status(204).send();
    } catch (e) {
      if (e instanceof EntityNotFoundError) {
        return next({ status: 404, message: 'Removal request not found.' });
      }
      next({ status: 500, message: e.message });
    }
  }
);

export default removalRoutes;
