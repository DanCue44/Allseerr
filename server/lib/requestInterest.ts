import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import type Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import MediaRequestInterest from '@server/entity/MediaRequestInterest';
import type { User } from '@server/entity/User';
import { getRequestStatusKey } from '@server/lib/bookRequests';
import notificationManager, { Notification } from '@server/lib/notifications';
import type { NotificationPayload } from '@server/lib/notifications/agents/agent';
import { Permission } from '@server/lib/permissions';
import { alreadyNotified } from '@server/lib/watchlistNotifications';
import logger from '@server/logger';
import { In } from 'typeorm';

/**
 * "Notify me too": a user who wants a title someone else has already
 * requested asks to hear when that request becomes available, without
 * making a request of their own. The interest is kept on the request, so it
 * matches the request's format (4K, ebook or audiobook, seasons).
 */

// Requests that are still on their way: waiting for approval, or approved
// and being searched for or downloaded
export const INTEREST_STATUSES = [
  MediaRequestStatus.PENDING,
  MediaRequestStatus.APPROVED,
];

export class InterestError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

/**
 * The permissions that would let the user make the same request, any one
 * of which lets them be notified about it
 */
export const getInterestPermissions = (
  request: Pick<MediaRequest, 'type' | 'is4k'>
): Permission[] => {
  switch (request.type) {
    case MediaType.MOVIE:
      return request.is4k
        ? [Permission.REQUEST_4K, Permission.REQUEST_4K_MOVIE]
        : [Permission.REQUEST, Permission.REQUEST_MOVIE];
    case MediaType.TV:
      return request.is4k
        ? [Permission.REQUEST_4K, Permission.REQUEST_4K_TV]
        : [Permission.REQUEST, Permission.REQUEST_TV];
    case MediaType.MUSIC:
      return [Permission.REQUEST, Permission.REQUEST_MUSIC];
    default:
      return [Permission.REQUEST, Permission.REQUEST_BOOK];
  }
};

/**
 * Why the user cannot add their interest to the request, or undefined when
 * they can
 */
export const getInterestRefusal = (
  request: MediaRequest,
  user: User,
  ownRequests: MediaRequest[] = []
): InterestError | undefined => {
  if (!user.hasPermission(getInterestPermissions(request), { type: 'or' })) {
    return new InterestError(
      403,
      'You do not have permission to request this title.'
    );
  }

  if (request.requestedBy?.id === user.id) {
    return new InterestError(409, 'This is your own request.');
  }

  if (
    !INTEREST_STATUSES.includes(request.status) ||
    request.media?.[getRequestStatusKey(request)] === MediaStatus.AVAILABLE
  ) {
    return new InterestError(409, 'This request is no longer in progress.');
  }

  // A request of the user's own for the same version already tells them
  if (
    ownRequests.some(
      (own) =>
        own.id !== request.id &&
        INTEREST_STATUSES.includes(own.status) &&
        own.is4k === request.is4k &&
        own.isAudiobook === request.isAudiobook
    )
  ) {
    return new InterestError(409, 'You already requested this title.');
  }

  return undefined;
};

const loadRequest = async (requestId: number): Promise<MediaRequest> => {
  const request = await getRepository(MediaRequest).findOne({
    where: { id: requestId },
    relations: { media: true, requestedBy: true },
  });

  if (!request) {
    throw new InterestError(404, 'Request not found.');
  }

  return request;
};

/**
 * Adds the user's interest to a request. Adding it twice is not an error.
 */
export const addInterest = async (
  requestId: number,
  user: User
): Promise<MediaRequestInterest> => {
  const request = await loadRequest(requestId);
  const ownRequests = await getRepository(MediaRequest).find({
    where: { media: { id: request.media.id }, requestedBy: { id: user.id } },
  });
  const refusal = getInterestRefusal(request, user, ownRequests);

  if (refusal) {
    throw refusal;
  }

  const repository = getRepository(MediaRequestInterest);
  const existing = await repository.findOne({
    where: { request: { id: request.id }, user: { id: user.id } },
  });

  if (existing) {
    return existing;
  }

  try {
    return await repository.save(new MediaRequestInterest({ request, user }));
  } catch (e) {
    // A second click that raced the first one
    const raced = await repository.findOne({
      where: { request: { id: request.id }, user: { id: user.id } },
    });

    if (raced) {
      return raced;
    }

    throw e;
  }
};

/**
 * Takes the user's interest off a request. Returns whether there was one.
 */
export const removeInterest = async (
  requestId: number,
  user: User
): Promise<boolean> => {
  const result = await getRepository(MediaRequestInterest).delete({
    request: { id: requestId },
    user: { id: user.id },
  });

  return !!result.affected;
};

/**
 * Whether the user asked to be told about the request
 */
export const isInterested = async (
  requestId: number,
  user?: User
): Promise<boolean> =>
  !!user &&
  (await getRepository(MediaRequestInterest).exist({
    where: { request: { id: requestId }, user: { id: user.id } },
  }));

export interface RequestInterestSummary {
  requestId: number;
  // How many users asked to be told, besides the requester
  count: number;
  // Whether the user asking is one of them
  interested: boolean;
}

/**
 * How many users are interested in each request, and whether the given
 * user is one of them
 */
export const getInterestSummaries = async (
  requestIds: number[],
  user?: User
): Promise<Map<number, RequestInterestSummary>> => {
  const summaries = new Map<number, RequestInterestSummary>(
    requestIds.map((requestId) => [
      requestId,
      { requestId, count: 0, interested: false },
    ])
  );

  if (requestIds.length === 0) {
    return summaries;
  }

  const interests = await getRepository(MediaRequestInterest).find({
    where: { request: { id: In(requestIds) } },
    relations: { request: true },
  });

  for (const interest of interests) {
    const summary = summaries.get(interest.request.id);

    if (!summary) {
      continue;
    }

    summary.count += 1;

    if (user && interest.user?.id === user.id) {
      summary.interested = true;
    }
  }

  return summaries;
};

/**
 * The users who asked to be told about a request, leaving out the
 * requester
 */
export const getInterestedUsers = async (
  request: Pick<MediaRequest, 'id' | 'requestedBy'>
): Promise<User[]> => {
  const interests = await getRepository(MediaRequestInterest).find({
    where: { request: { id: request.id } },
  });

  return interests
    .map((interest) => interest.user)
    .filter((user): user is User => !!user)
    .filter((user) => user.id !== request.requestedBy?.id);
};

/**
 * Sends the availability notification the requester got to every user who
 * asked to be told about the request, through each user's own notification
 * settings. A user also told through their watchlist hears once.
 */
export const notifyInterestedUsers = async (
  request: MediaRequest,
  media: Media,
  payload: Omit<
    NotificationPayload,
    'notifyUser' | 'notifyAdmin' | 'notifySystem'
  >
): Promise<void> => {
  try {
    const recipients = (await getInterestedUsers(request)).filter(
      (user) => !alreadyNotified(media.id, user.id)
    );

    for (const user of recipients) {
      notificationManager.sendNotification(Notification.MEDIA_AVAILABLE, {
        ...payload,
        notifyAdmin: false,
        notifySystem: false,
        notifyUser: user,
      });
    }

    if (recipients.length) {
      logger.info('Sent availability notifications to interested users', {
        label: 'Notifications',
        requestId: request.id,
        users: recipients.length,
      });
    }
  } catch (e) {
    logger.error('Failed to notify interested users', {
      label: 'Notifications',
      errorMessage: e.message,
      requestId: request.id,
    });
  }
};
