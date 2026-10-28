import useInterfaceStyle from '@app/hooks/useInterfaceStyle';
import useToasts from '@app/hooks/useToasts';
import { refreshTvWatched } from '@app/hooks/useTvWatched';
import defineMessages from '@app/utils/defineMessages';
import { EyeIcon } from '@heroicons/react/24/outline';
import { EyeIcon as FilledEyeIcon } from '@heroicons/react/24/solid';
import axios from 'axios';
import { useState } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.WatchedButton', {
  markSeasonWatched: 'Mark season as watched',
  markSeasonUnwatched: 'Mark season as unwatched',
  seasonError: 'Something went wrong. Please try again.',
});

/**
 * Marks every episode of a season watched or unwatched on the media server
 * with the person's own account
 */
const SeasonWatchedButton = ({
  mediaId,
  tvId,
  seasonNumber,
  watched,
}: {
  mediaId: number;
  tvId: number;
  seasonNumber: number;
  /** Every episode of the season is already seen */
  watched: boolean;
}) => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const [interfaceStyle] = useInterfaceStyle();
  const ambient = interfaceStyle === 'ambient';
  const [isUpdating, setIsUpdating] = useState(false);

  const onClick = async () => {
    setIsUpdating(true);

    try {
      await axios.post(`/api/v1/media/${mediaId}/watched`, {
        watched: !watched,
        seasonNumber,
      });
      await refreshTvWatched(tvId);
    } catch {
      addToast(intl.formatMessage(messages.seasonError), {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      setIsUpdating(false);
    }
  };

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={isUpdating}
      className={`inline-flex items-center gap-1.5 text-xs font-semibold transition ${
        ambient
          ? 'text-as-ink-muted hover:text-as-ink'
          : 'text-gray-400 hover:text-white'
      } ${isUpdating ? 'opacity-50' : ''}`}
    >
      {watched ? (
        <FilledEyeIcon className="h-4 w-4 text-green-400" />
      ) : (
        <EyeIcon className="h-4 w-4" />
      )}
      {intl.formatMessage(
        watched ? messages.markSeasonUnwatched : messages.markSeasonWatched
      )}
    </button>
  );
};

export default SeasonWatchedButton;
