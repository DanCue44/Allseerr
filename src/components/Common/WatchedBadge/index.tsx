import defineMessages from '@app/utils/defineMessages';
import { EyeIcon } from '@heroicons/react/24/solid';
import type { UserWatchedState } from '@server/lib/watchedState';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.WatchedBadge', {
  watched: 'Watched',
  inprogress: 'In progress',
});

/**
 * A small eye on a title card: filled when the person has watched the title
 * on the media server, outlined on dark when they are part way. Nothing for
 * a title never touched.
 */
const WatchedBadge = ({
  state,
  shrink = false,
}: {
  state?: UserWatchedState;
  shrink?: boolean;
}) => {
  const intl = useIntl();

  if (!state || (!state.watched && !state.inProgress)) {
    return null;
  }

  return (
    <div
      className={`relative inline-flex whitespace-nowrap rounded-full border-gray-700 text-xs font-semibold leading-5 ring-gray-700 ${
        shrink ? '' : 'ring-1'
      }`}
      role="img"
      aria-label={intl.formatMessage(
        state.watched ? messages.watched : messages.inprogress
      )}
    >
      <div
        className={`rounded-full shadow-md ${
          shrink ? 'w-4 border p-0 sm:w-5' : 'w-5 p-0.5 ring-1'
        } ${
          state.watched
            ? 'border-sky-400 bg-sky-500/80 text-sky-100 ring-sky-400'
            : 'border-sky-400 bg-gray-800/80 text-sky-300 ring-sky-400'
        }`}
      >
        <EyeIcon />
      </div>
    </div>
  );
};

export default WatchedBadge;
