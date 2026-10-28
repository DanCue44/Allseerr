import ContinueWatchingCard from '@app/components/Discover/ContinueWatchingSlider/ContinueWatchingCard';
import Slider from '@app/components/Slider';
import { UserType, useUser } from '@app/hooks/useUser';
import defineMessages from '@app/utils/defineMessages';
import type { ContinueWatchingResponse } from '@server/interfaces/api/discoverInterfaces';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.Discover.ContinueWatchingSlider', {
  continuewatching: 'Continue Watching',
});

interface ContinueWatchingSliderProps {
  /** Only show this media type */
  mediaType?: 'movie' | 'tv';
}

/**
 * What the person is part way through on the media server: movies left
 * part way and the next episode of each series in progress. Hidden for
 * local accounts and when there is nothing to pick up.
 */
const ContinueWatchingSlider = ({ mediaType }: ContinueWatchingSliderProps) => {
  const intl = useIntl();
  const { user } = useUser();
  const hasAccount = !!user && user.userType !== UserType.LOCAL;
  const { data, error } = useSWR<ContinueWatchingResponse>(
    hasAccount ? '/api/v1/discover/continue-watching' : null,
    { revalidateOnMount: true }
  );

  const items = mediaType
    ? data?.results.filter((item) => item.mediaType === mediaType)
    : data?.results;

  if (!hasAccount || error || (items && items.length === 0)) {
    return null;
  }

  return (
    <>
      <div className="slider-header">
        <div className="slider-title">
          <span>{intl.formatMessage(messages.continuewatching)}</span>
        </div>
      </div>
      <Slider
        sliderKey={`continue-watching-${mediaType ?? 'all'}`}
        isLoading={!items}
        items={(items ?? []).map((item) => (
          <ContinueWatchingCard
            key={`continue-watching-${item.mediaType}-${item.tmdbId}`}
            item={item}
          />
        ))}
      />
    </>
  );
};

export default ContinueWatchingSlider;
