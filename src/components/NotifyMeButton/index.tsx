import Button from '@app/components/Common/Button';
import Tooltip from '@app/components/Common/Tooltip';
import useToasts from '@app/hooks/useToasts';
import { Permission, useUser } from '@app/hooks/useUser';
import defineMessages from '@app/utils/defineMessages';
import { BellAlertIcon, BellIcon } from '@heroicons/react/24/outline';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import type Media from '@server/entity/Media';
import type { MediaRequest } from '@server/entity/MediaRequest';
import type { RequestInterestResponse } from '@server/interfaces/api/requestInterfaces';
import axios from 'axios';
import { useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.NotifyMeButton', {
  notifyMe: 'Notify Me Too',
  notifyMe4k: 'Notify Me Too (4K)',
  notifyMeAudiobook: 'Notify Me Too (Audiobook)',
  notifyMeEbook: 'Notify Me Too (Ebook)',
  notifying: 'Notifying You',
  notifying4k: 'Notifying You (4K)',
  notifyingAudiobook: 'Notifying You (Audiobook)',
  notifyingEbook: 'Notifying You (Ebook)',
  notifyMeTip:
    '{requester} already requested this. Get the same notification when it becomes available, without using a request.',
  notifyingTip: 'You will be told when this becomes available. Click to stop.',
  added: 'You will be told when <strong>{title}</strong> is available.',
  removed: 'You will no longer be told about <strong>{title}</strong>.',
  error: 'Something went wrong. Please try again.',
});

const ACTIVE_STATUSES = [
  MediaRequestStatus.PENDING,
  MediaRequestStatus.APPROVED,
];

const getRequestPermissions = (request: MediaRequest): Permission[] => {
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

const getStatusKey = (request: MediaRequest) =>
  request.isAudiobook ? 'statusAudio' : request.is4k ? 'status4k' : 'status';

// One request per version (4K, ebook or audiobook) is enough to follow
const variantKey = (request: MediaRequest) =>
  `${request.is4k ? '4k' : ''}${request.isAudiobook ? 'audio' : ''}`;

interface NotifyMeButtonProps {
  media?: Media;
  title: string;
  className?: string;
  // Ambient title pages style the button as a pill that drops its label on
  // phones
  ambient?: boolean;
}

/**
 * "Notify me too": on a title someone else already requested, lets the
 * user get the same availability notification without a request of their
 * own
 */
const NotifyMeButton = ({
  media,
  title,
  className = 'ml-2',
  ambient = false,
}: NotifyMeButtonProps) => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const { user, hasPermission } = useUser();
  const [isUpdating, setIsUpdating] = useState(false);

  const requests = media?.requests ?? [];
  const ownVariants = new Set(
    requests
      .filter(
        (request) =>
          request.requestedBy?.id === user?.id &&
          ACTIVE_STATUSES.includes(request.status)
      )
      .map(variantKey)
  );
  const candidates = Object.values(
    requests
      .filter(
        (request) =>
          !!user &&
          request.requestedBy?.id !== user.id &&
          ACTIVE_STATUSES.includes(request.status) &&
          media?.[getStatusKey(request)] !== MediaStatus.AVAILABLE &&
          !ownVariants.has(variantKey(request)) &&
          hasPermission(getRequestPermissions(request), { type: 'or' })
      )
      .reduce<Record<string, MediaRequest>>((byVariant, request) => {
        byVariant[variantKey(request)] ??= request;
        return byVariant;
      }, {})
  );

  const interestKey =
    candidates.length > 0
      ? `/api/v1/request/interest?mediaId=${media?.id}`
      : null;
  const { data, mutate } = useSWR<RequestInterestResponse>(interestKey);

  if (candidates.length === 0) {
    return null;
  }

  // Following any request of the same version counts
  const followedOf = (request: MediaRequest) =>
    (data?.results ?? []).filter(
      (summary) =>
        summary.interested &&
        requests.some(
          (other) =>
            other.id === summary.requestId &&
            variantKey(other) === variantKey(request)
        )
    );
  const isInterested = (request: MediaRequest) =>
    followedOf(request).length > 0;

  const toggle = async (request: MediaRequest) => {
    const interested = isInterested(request);
    setIsUpdating(true);

    try {
      if (interested) {
        const followed = followedOf(request);
        await Promise.all(
          followed.map((summary) =>
            axios.delete(`/api/v1/request/${summary.requestId}/interest`)
          )
        );
      } else {
        await axios.post(`/api/v1/request/${request.id}/interest`);
      }

      addToast(
        intl.formatMessage(interested ? messages.removed : messages.added, {
          title,
          strong: (msg: React.ReactNode) => <strong>{msg}</strong>,
        }),
        { autoDismiss: true, appearance: 'success' }
      );
      mutate();
    } catch {
      addToast(intl.formatMessage(messages.error), {
        autoDismiss: true,
        appearance: 'error',
      });
    } finally {
      setIsUpdating(false);
    }
  };

  const label = (request: MediaRequest, interested: boolean) => {
    const isBook = request.type === MediaType.BOOK;
    const showVariant = candidates.length > 1 || isBook;

    if (showVariant && request.is4k) {
      return interested ? messages.notifying4k : messages.notifyMe4k;
    }
    if (showVariant && isBook) {
      return request.isAudiobook
        ? interested
          ? messages.notifyingAudiobook
          : messages.notifyMeAudiobook
        : interested
          ? messages.notifyingEbook
          : messages.notifyMeEbook;
    }
    return interested ? messages.notifying : messages.notifyMe;
  };

  return (
    <>
      {candidates.map((request) => {
        const interested = isInterested(request);

        return (
          <Tooltip
            key={`notify-me-${request.id}`}
            content={
              interested
                ? intl.formatMessage(messages.notifyingTip)
                : intl.formatMessage(messages.notifyMeTip, {
                    requester: request.requestedBy?.displayName ?? '',
                  })
            }
          >
            <Button
              buttonType={interested && !ambient ? 'primary' : 'ghost'}
              className={className}
              disabled={isUpdating || !data}
              onClick={() => toggle(request)}
            >
              {interested ? <BellAlertIcon /> : <BellIcon />}
              <span className={ambient ? 'max-sm:sr-only' : undefined}>
                {intl.formatMessage(label(request, interested))}
              </span>
            </Button>
          </Tooltip>
        );
      })}
    </>
  );
};

export default NotifyMeButton;
