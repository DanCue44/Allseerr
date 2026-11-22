import type { BookFormatChoice } from '@server/constants/media';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
  RemovalRequestStatus,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import RemovalRequest from '@server/entity/RemovalRequest';
import type { User } from '@server/entity/User';
import WatchedItem from '@server/entity/WatchedItem';
import { getBookFormatName } from '@server/lib/bookNotifications';
import {
  getBookFormatChoiceName,
  getMediaNotificationDetails,
} from '@server/lib/mediaNotificationDetails';
import { removeMediaFromService } from '@server/lib/mediaRemoval';
import notificationManager, { Notification } from '@server/lib/notifications';
import { Permission } from '@server/lib/permissions';
import { getSettings } from '@server/lib/settings';
import { hasViewState } from '@server/lib/watchedState';
import logger from '@server/logger';
import { runInBackground } from '@server/utils/backgroundTasks';
import { truncate } from 'lodash';
import { In, Not } from 'typeorm';

export class RemovalNotAllowedError extends Error {}
export class DuplicateRemovalRequestError extends Error {}
export class RemovalRequestStateError extends Error {}

const REASON_MAX_LENGTH = 500;

const cleanReason = (reason?: string | null): string | null =>
  reason?.trim().slice(0, REASON_MAX_LENGTH) || null;

const removableStatuses = [
  MediaStatus.AVAILABLE,
  MediaStatus.PARTIALLY_AVAILABLE,
];

const isRemovable = (media: Media, is4k: boolean): boolean =>
  removableStatuses.includes(media[is4k ? 'status4k' : 'status']);

/**
 * The formats of a book that a removal request covers, narrowed to the
 * formats that are available. Undefined when none of them are.
 */
export const getRemovableBookFormat = (
  media: Media,
  bookFormat: BookFormatChoice = 'both'
): BookFormatChoice | undefined => {
  const ebook =
    bookFormat !== 'audiobook' && removableStatuses.includes(media.status);
  const audiobook =
    bookFormat !== 'ebook' && removableStatuses.includes(media.statusAudio);

  if (ebook && audiobook) {
    return 'both';
  }

  return ebook ? 'ebook' : audiobook ? 'audiobook' : undefined;
};

/**
 * Whether the user is the only one who asked for what a removal covers: every
 * request that is not declined, for each 4K type or book format removed,
 * belongs to them, and there is at least one. Media added without a request
 * belongs to no one, so it always waits for an admin.
 */
export const isOnlyRequester = (
  requests: Pick<
    MediaRequest,
    'status' | 'is4k' | 'isAudiobook' | 'requestedBy'
  >[],
  userId: number,
  {
    mediaType,
    is4k,
    bookFormat,
  }: {
    mediaType: MediaType;
    is4k: boolean;
    bookFormat?: BookFormatChoice | null;
  }
): boolean => {
  const live = requests.filter(
    (request) => request.status !== MediaRequestStatus.DECLINED
  );
  const groups =
    mediaType === MediaType.BOOK
      ? (bookFormat === 'both'
          ? [false, true]
          : [bookFormat === 'audiobook']
        ).map((isAudiobook) =>
          live.filter((request) => !!request.isAudiobook === isAudiobook)
        )
      : [live.filter((request) => !!request.is4k === is4k)];

  return groups.every(
    (group) =>
      group.length > 0 &&
      group.every((request) => request.requestedBy?.id === userId)
  );
};

/**
 * Whether a user may remove media at once instead of asking an admin: the
 * Users setting is on, they do not already manage requests, they are the
 * only requester and, when the setting asks for it, nobody else has watched
 * the movie or series on the media server. Music and books have no watched
 * state, so only the requests count for them.
 */
const canRemoveOwnMedia = async (
  media: Media,
  user: User,
  is4k: boolean,
  bookFormat?: BookFormatChoice | null
): Promise<boolean> => {
  const { main } = getSettings();

  if (!main.selfRemoval || user.hasPermission(Permission.MANAGE_REQUESTS)) {
    return false;
  }

  const requests = await getRepository(MediaRequest).find({
    where: { media: { id: media.id } },
  });

  if (
    !isOnlyRequester(requests, user.id, {
      mediaType: media.mediaType,
      is4k,
      bookFormat,
    })
  ) {
    return false;
  }

  if (
    (main.selfRemovalUnwatchedOnly ?? true) &&
    (media.mediaType === MediaType.MOVIE || media.mediaType === MediaType.TV) &&
    media.tmdbId != null
  ) {
    const watchedByOthers = await getRepository(WatchedItem).find({
      where: {
        tmdbId: media.tmdbId,
        mediaType: media.mediaType,
        user: { id: Not(user.id) },
      },
    });

    if (watchedByOthers.some((row) => hasViewState(row))) {
      return false;
    }
  }

  return true;
};

const getMediaTypeName = (removal: RemovalRequest): string => {
  switch (removal.media.mediaType) {
    case MediaType.MOVIE:
      return 'Movie';
    case MediaType.MUSIC:
      return 'Album';
    case MediaType.BOOK:
      return removal.bookFormat === 'ebook' ||
        removal.bookFormat === 'audiobook'
        ? getBookFormatName(removal.bookFormat === 'audiobook')
        : 'Book';
    default:
      return 'Series';
  }
};

export const sendRemovalNotification = async (
  type: Notification,
  removal: RemovalRequest
): Promise<void> => {
  const { media } = removal;
  const quality = removal.is4k ? '4K ' : '';
  const mediaType = getMediaTypeName(removal);

  let event: string;
  switch (type) {
    case Notification.REMOVAL_APPROVED:
      event = `${quality}${mediaType} Removal Approved`;
      break;
    case Notification.REMOVAL_DECLINED:
      event = `${quality}${mediaType} Removal Declined`;
      break;
    default:
      event = `New ${quality}${mediaType} Removal Request`;
  }

  try {
    const { subject, message, image } =
      await getMediaNotificationDetails(media);

    const reason =
      type === Notification.REMOVAL_DECLINED
        ? removal.declineReason
        : removal.reason;

    notificationManager.sendNotification(type, {
      event,
      subject,
      message: message
        ? truncate(message, {
            length: 500,
            separator: /\s/,
            omission: '…',
          })
        : undefined,
      image,
      media,
      removal,
      notifyAdmin: type === Notification.REMOVAL_PENDING,
      notifySystem: true,
      notifyUser:
        type === Notification.REMOVAL_PENDING ? undefined : removal.requestedBy,
      extra: [
        { name: 'Requested By', value: removal.requestedBy.displayName },
        ...(media.mediaType === MediaType.BOOK
          ? [
              {
                name: 'Format',
                value: getBookFormatChoiceName(removal.bookFormat),
              },
            ]
          : []),
        ...(reason ? [{ name: 'Reason', value: reason }] : []),
      ],
    });
  } catch (e) {
    logger.error('Something went wrong sending removal notification(s)', {
      label: 'Notifications',
      errorMessage: e.message,
      removalRequestId: removal.id,
    });
  }
};

export const createRemovalRequest = async (
  {
    mediaId,
    is4k = false,
    reason,
    bookFormat,
  }: {
    mediaId: number;
    is4k?: boolean;
    reason?: string;
    bookFormat?: BookFormatChoice;
  },
  user: User
): Promise<RemovalRequest> => {
  const media = await getRepository(Media).findOneOrFail({
    where: { id: mediaId },
  });

  const isBook = media.mediaType === MediaType.BOOK;

  if (
    isBook &&
    bookFormat !== undefined &&
    !['ebook', 'audiobook', 'both'].includes(bookFormat)
  ) {
    throw new RemovalNotAllowedError(
      'Book format must be ebook, audiobook or both.'
    );
  }

  // Music and books have no 4K version
  const removalIs4k =
    media.mediaType === MediaType.MOVIE || media.mediaType === MediaType.TV
      ? is4k
      : false;
  const removableBookFormat = isBook
    ? getRemovableBookFormat(media, bookFormat)
    : undefined;

  if (isBook ? !removableBookFormat : !isRemovable(media, removalIs4k)) {
    throw new RemovalNotAllowedError(
      'Only available media can be requested for removal.'
    );
  }

  const removalRepository = getRepository(RemovalRequest);
  const existing = await removalRepository.findOne({
    where: {
      media: { id: media.id },
      is4k: removalIs4k,
      status: In([RemovalRequestStatus.PENDING, RemovalRequestStatus.FAILED]),
    },
  });

  if (existing) {
    throw new DuplicateRemovalRequestError(
      'A removal request for this media already exists.'
    );
  }

  const removal = await removalRepository.save(
    new RemovalRequest({
      media,
      is4k: removalIs4k,
      bookFormat: removableBookFormat ?? null,
      reason: cleanReason(reason),
      requestedBy: user,
      status: RemovalRequestStatus.PENDING,
    })
  );

  // Media only this user asked for is removed at once, through the same
  // approval an admin gives. If the service call fails the request stays
  // (failed) for an admin, who is told about it as for any new request.
  if (await canRemoveOwnMedia(media, user, removalIs4k, removableBookFormat)) {
    try {
      return await approveRemovalRequest(removal.id, user);
    } catch (e) {
      logger.warn('Could not remove media for its only requester', {
        label: 'Removal Request',
        removalRequestId: removal.id,
        errorMessage: e.message,
      });

      const failed = await removalRepository.findOneOrFail({
        where: { id: removal.id },
      });

      runInBackground(
        sendRemovalNotification(Notification.REMOVAL_PENDING, failed)
      );

      return failed;
    }
  }

  runInBackground(
    sendRemovalNotification(Notification.REMOVAL_PENDING, removal)
  );

  return removal;
};

const findActionable = async (id: number): Promise<RemovalRequest> => {
  const removal = await getRepository(RemovalRequest).findOneOrFail({
    where: { id },
  });

  if (
    removal.status !== RemovalRequestStatus.PENDING &&
    removal.status !== RemovalRequestStatus.FAILED
  ) {
    throw new RemovalRequestStateError(
      'Only pending removal requests can be approved or declined.'
    );
  }

  return removal;
};

/**
 * Approves a removal request and deletes the title from Radarr, Sonarr,
 * Lidarr or LazyLibrarian.
 * If the service call fails the request is marked failed so it can be
 * approved again.
 */
export const approveRemovalRequest = async (
  id: number,
  user: User
): Promise<RemovalRequest> => {
  const removalRepository = getRepository(RemovalRequest);
  const removal = await findActionable(id);

  removal.modifiedBy = user;

  try {
    await removeMediaFromService(removal.media, removal.is4k, {
      bookFormat: removal.bookFormat ?? undefined,
    });
  } catch (e) {
    removal.status = RemovalRequestStatus.FAILED;
    await removalRepository.save(removal);
    logger.error('Failed to remove media for a removal request', {
      label: 'Removal Request',
      removalRequestId: removal.id,
      errorMessage: e.message,
    });
    throw e;
  }

  removal.status = RemovalRequestStatus.APPROVED;
  await removalRepository.save(removal);

  runInBackground(
    sendRemovalNotification(Notification.REMOVAL_APPROVED, removal)
  );

  return removal;
};

export const declineRemovalRequest = async (
  id: number,
  user: User,
  reason?: string
): Promise<RemovalRequest> => {
  const removalRepository = getRepository(RemovalRequest);
  const removal = await findActionable(id);

  removal.status = RemovalRequestStatus.DECLINED;
  removal.declineReason = cleanReason(reason);
  removal.modifiedBy = user;
  await removalRepository.save(removal);

  runInBackground(
    sendRemovalNotification(Notification.REMOVAL_DECLINED, removal)
  );

  return removal;
};
