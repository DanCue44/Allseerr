import Tooltip from '@app/components/Common/Tooltip';
import useToasts from '@app/hooks/useToasts';
import { refreshTvWatched } from '@app/hooks/useTvWatched';
import defineMessages from '@app/utils/defineMessages';
import { EyeIcon } from '@heroicons/react/24/outline';
import { EyeIcon as FilledEyeIcon } from '@heroicons/react/24/solid';
import type { UserEpisodeState } from '@server/lib/watchedState';
import axios from 'axios';
import { useState } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.WatchedButton', {
  markEpisodeWatched: 'Mark episode as watched',
  markEpisodeUnwatched: 'Mark episode as unwatched',
  episodeInProgress: 'In progress',
  episodeError: 'Something went wrong. Please try again.',
});

/**
 * The eye next to an episode: green once seen, orange part way, grey
 * otherwise. A tap marks the episode watched or unwatched on the media
 * server with the person's own account.
 */
const EpisodeWatchedToggle = ({
  mediaId,
  tvId,
  seasonNumber,
  episodeNumber,
  state,
  className = '',
}: {
  mediaId: number;
  tvId: number;
  seasonNumber: number;
  episodeNumber: number;
  state?: UserEpisodeState;
  className?: string;
}) => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const [isUpdating, setIsUpdating] = useState(false);

  const label = state?.watched
    ? intl.formatMessage(messages.markEpisodeUnwatched)
    : state?.inProgress
      ? `${intl.formatMessage(messages.episodeInProgress)} - ${intl.formatMessage(
          messages.markEpisodeWatched
        )}`
      : intl.formatMessage(messages.markEpisodeWatched);

  const onClick = async (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setIsUpdating(true);

    try {
      await axios.post(`/api/v1/media/${mediaId}/watched`, {
        watched: !state?.watched,
        seasonNumber,
        episodeNumber,
      });
      await refreshTvWatched(tvId);
    } catch {
      addToast(intl.formatMessage(messages.episodeError), {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      setIsUpdating(false);
    }
  };

  return (
    <Tooltip content={label}>
      <button
        type="button"
        aria-label={label}
        onClick={onClick}
        disabled={isUpdating}
        className={`rounded-full p-0.5 transition ${
          isUpdating ? 'opacity-50' : 'hover:bg-white/10'
        } ${className}`}
      >
        {state?.watched ? (
          <FilledEyeIcon className="h-5 w-5 text-green-400" />
        ) : (
          <EyeIcon
            className={`h-5 w-5 ${
              state?.inProgress ? 'text-orange-400' : 'text-gray-500'
            }`}
          />
        )}
      </button>
    </Tooltip>
  );
};

export default EpisodeWatchedToggle;
