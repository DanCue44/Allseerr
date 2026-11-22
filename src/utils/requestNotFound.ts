import { getRequestMediaStatus } from '@app/utils/bookRecordings';
import { MediaRequestStatus, MediaStatus } from '@server/constants/media';
import type Media from '@server/entity/Media';

/**
 * Whether a request shows as Not Found: approved, marked by the Request
 * Not Found check, and still without its title. A request whose file
 * turned up later shows its usual status again.
 */
export const isNotFound = (request: {
  status: MediaRequestStatus;
  notFoundAt?: Date | string | null;
  recording?: string | null;
  is4k?: boolean;
  isAudiobook?: boolean;
  media: Media;
}): boolean => {
  if (request.status !== MediaRequestStatus.APPROVED || !request.notFoundAt) {
    return false;
  }

  const status = getRequestMediaStatus(request);

  return (
    status !== MediaStatus.AVAILABLE &&
    status !== MediaStatus.PARTIALLY_AVAILABLE
  );
};
