import AirDateBadge from '@app/components/AirDateBadge';
import CachedImage from '@app/components/Common/CachedImage';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import EpisodeWatchedToggle from '@app/components/WatchedButton/EpisodeWatchedToggle';
import SeasonWatchedButton from '@app/components/WatchedButton/SeasonWatchedButton';
import useTvWatched from '@app/hooks/useTvWatched';
import defineMessages from '@app/utils/defineMessages';
import type { SeasonWithEpisodes } from '@server/models/Tv';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.TvDetails.Season', {
  somethingwentwrong: 'Something went wrong while retrieving season data.',
  noepisodes: 'Episode list unavailable.',
});

type SeasonProps = {
  seasonNumber: number;
  tvId: number;
  /** The title's media id, when the server has it, for marking episodes */
  mediaId?: number;
};

const Season = ({ seasonNumber, tvId, mediaId }: SeasonProps) => {
  const intl = useIntl();
  const { data, error } = useSWR<SeasonWithEpisodes>(
    `/api/v1/tv/${tvId}/season/${seasonNumber}`
  );
  const { watched, canMark } = useTvWatched(tvId);
  const showMarks = canMark && !!mediaId;
  const seasonSummary = watched?.seasons[seasonNumber];

  if (!data && !error) {
    return <LoadingSpinner />;
  }

  if (!data) {
    return <div>{intl.formatMessage(messages.somethingwentwrong)}</div>;
  }

  return (
    <div className="flex flex-col justify-center divide-y divide-gray-700">
      {showMarks && mediaId && data.episodes.length > 0 && (
        <div className="flex justify-end py-2">
          <SeasonWatchedButton
            mediaId={mediaId}
            tvId={tvId}
            seasonNumber={seasonNumber}
            watched={
              (seasonSummary?.watchedEpisodes ?? 0) >= data.episodes.length
            }
          />
        </div>
      )}
      {data.episodes.length === 0 ? (
        <p>{intl.formatMessage(messages.noepisodes)}</p>
      ) : (
        data.episodes
          .slice()
          .reverse()
          .map((episode) => {
            return (
              <div
                className="flex flex-col space-y-4 py-4 xl:flex-row xl:space-x-4 xl:space-y-4"
                key={`season-${seasonNumber}-episode-${episode.episodeNumber}`}
              >
                <div className="flex-1">
                  <div className="flex flex-col space-y-2 xl:flex-row xl:items-center xl:space-x-2 xl:space-y-0">
                    <h3 className="flex items-center gap-2 text-lg">
                      {showMarks && mediaId && (
                        <EpisodeWatchedToggle
                          mediaId={mediaId}
                          tvId={tvId}
                          seasonNumber={seasonNumber}
                          episodeNumber={episode.episodeNumber}
                          state={
                            watched?.episodes[
                              `${seasonNumber}-${episode.episodeNumber}`
                            ]
                          }
                        />
                      )}
                      <span>
                        {episode.episodeNumber} - {episode.name}
                      </span>
                    </h3>
                    {episode.airDate && (
                      <AirDateBadge airDate={episode.airDate} />
                    )}
                  </div>
                  {episode.overview && <p>{episode.overview}</p>}
                </div>
                {episode.stillPath && (
                  <div className="relative aspect-video xl:h-32">
                    <CachedImage
                      type="tmdb"
                      className="rounded-lg object-contain"
                      src={episode.stillPath}
                      alt=""
                      fill
                    />
                  </div>
                )}
              </div>
            );
          })
      )}
    </div>
  );
};

export default Season;
