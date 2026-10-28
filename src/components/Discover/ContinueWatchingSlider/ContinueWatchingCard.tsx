import CachedImage from '@app/components/Common/CachedImage';
import useInterfaceStyle from '@app/hooks/useInterfaceStyle';
import defineMessages from '@app/utils/defineMessages';
import type { ContinueWatchingItem } from '@server/interfaces/api/discoverInterfaces';
import Link from 'next/link';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Discover.ContinueWatchingSlider', {
  episode: 'S{seasonNumber} E{episodeNumber}',
  nextUp: 'Next up',
  percentWatched: '{progress}% watched',
});

/**
 * Artwork for a title to pick up again: a movie left part way with how far
 * through it is, or the next episode of a series.
 */
const ContinueWatchingCard = ({ item }: { item: ContinueWatchingItem }) => {
  const intl = useIntl();
  const [interfaceStyle] = useInterfaceStyle();
  const ambient = interfaceStyle === 'ambient';

  const href = `/${item.mediaType}/${item.tmdbId}`;
  const episode =
    item.mediaType === 'tv' &&
    item.seasonNumber != null &&
    item.episodeNumber != null
      ? intl.formatMessage(messages.episode, {
          seasonNumber: item.seasonNumber,
          episodeNumber: item.episodeNumber,
        })
      : undefined;
  const caption = episode
    ? [episode, item.episodeTitle].filter(Boolean).join(' · ')
    : (item.year ?? undefined);
  const label =
    item.progress != null && item.progress > 0
      ? intl.formatMessage(messages.percentWatched, {
          progress: item.progress,
        })
      : episode
        ? intl.formatMessage(messages.nextUp)
        : undefined;

  return (
    <Link
      href={href}
      className={`group block ${
        ambient ? 'w-[150px] sm:w-[176px]' : 'w-36 sm:w-36 md:w-44'
      }`}
    >
      <div
        className={`relative overflow-hidden ${
          ambient
            ? 'rounded-[18px] bg-as-tile'
            : 'rounded-xl bg-gray-800 ring-1 ring-gray-700'
        }`}
        style={{ paddingBottom: '150%' }}
      >
        <CachedImage
          type="tmdb"
          src={
            item.posterPath
              ? `https://image.tmdb.org/t/p/w300_and_h450_face${item.posterPath}`
              : '/images/allseerr_poster_not_found_logo_top.png'
          }
          alt=""
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          fill
        />
        {label && (
          <span
            className={`absolute left-2 top-2 rounded-full px-2.5 py-1 text-xs font-bold ${
              ambient
                ? 'bg-as-ground/90 text-as-ink'
                : 'bg-gray-900/90 text-white'
            }`}
          >
            {label}
          </span>
        )}
        {item.progress != null && item.progress > 0 && (
          <div
            className="absolute inset-x-0 bottom-0 h-1.5 bg-black/60"
            role="progressbar"
            aria-valuenow={item.progress}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className="h-full bg-orange-400"
              style={{ width: `${item.progress}%` }}
            />
          </div>
        )}
      </div>
      <div className="mt-2.5">
        <div
          className={`line-clamp-2 whitespace-normal break-words font-bold group-hover:underline ${
            ambient ? 'text-as-ink' : 'text-sm text-white'
          }`}
        >
          {item.title}
        </div>
        {caption && (
          <div
            className={`truncate text-[13px] ${
              ambient ? 'text-as-ink-faint' : 'text-gray-400'
            }`}
          >
            {caption}
          </div>
        )}
      </div>
    </Link>
  );
};

export default ContinueWatchingCard;
