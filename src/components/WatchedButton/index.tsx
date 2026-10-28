import Spinner from '@app/assets/spinner.svg';
import Button from '@app/components/Common/Button';
import Tooltip from '@app/components/Common/Tooltip';
import useToasts from '@app/hooks/useToasts';
import defineMessages from '@app/utils/defineMessages';
import { EyeIcon } from '@heroicons/react/24/outline';
import { EyeIcon as FilledEyeIcon } from '@heroicons/react/24/solid';
import { MediaStatus } from '@server/constants/media';
import type Media from '@server/entity/Media';
import axios from 'axios';
import { useState } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.WatchedButton', {
  markwatched: 'Mark As Watched',
  markunwatched: 'Mark As Unwatched',
  inprogress: 'In Progress',
  watchedSuccess: '<strong>{title}</strong> marked as watched.',
  unwatchedSuccess: '<strong>{title}</strong> marked as unwatched.',
  watchedError: 'Something went wrong. Please try again.',
});

/**
 * Marks a movie or series watched or unwatched on the media server, with the
 * person's own account there. Shown only to people with such an account, for
 * titles the server has.
 */
const WatchedButton = ({
  media,
  title,
  onUpdate,
  className = 'z-40 mr-2',
}: {
  media?: Media;
  title: string;
  onUpdate: () => void;
  className?: string;
}) => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const [isUpdating, setIsUpdating] = useState(false);

  const onServer = [media?.status, media?.status4k].some(
    (status) =>
      status === MediaStatus.AVAILABLE ||
      status === MediaStatus.PARTIALLY_AVAILABLE
  );

  if (!media?.watched || !media.id || !onServer) {
    return null;
  }

  const { watched, inProgress } = media.watched;

  const onClick = async (): Promise<void> => {
    setIsUpdating(true);

    try {
      await axios.post(`/api/v1/media/${media.id}/watched`, {
        watched: !watched,
      });

      addToast(
        <span>
          {intl.formatMessage(
            watched ? messages.unwatchedSuccess : messages.watchedSuccess,
            {
              title,
              strong: (msg: React.ReactNode) => <strong>{msg}</strong>,
            }
          )}
        </span>,
        { appearance: watched ? 'info' : 'success', autoDismiss: true }
      );
      onUpdate();
    } catch {
      addToast(intl.formatMessage(messages.watchedError), {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      setIsUpdating(false);
    }
  };

  const tooltip = watched
    ? intl.formatMessage(messages.markunwatched)
    : inProgress
      ? `${intl.formatMessage(messages.inprogress)} - ${intl.formatMessage(
          messages.markwatched
        )}`
      : intl.formatMessage(messages.markwatched);

  return (
    <Tooltip content={tooltip}>
      <Button
        buttonType="ghost"
        className={className}
        buttonSize="md"
        onClick={onClick}
        disabled={isUpdating}
      >
        {isUpdating ? (
          <Spinner />
        ) : watched ? (
          <FilledEyeIcon className="text-green-400" />
        ) : (
          <EyeIcon className={inProgress ? 'text-orange-400' : undefined} />
        )}
      </Button>
    </Tooltip>
  );
};

export default WatchedButton;
