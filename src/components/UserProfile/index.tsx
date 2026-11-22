import ImageFader from '@app/components/Common/ImageFader';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import ProgressCircle from '@app/components/Common/ProgressCircle';
import ReadingAppsNudge from '@app/components/ReadingApps/ReadingAppsNudge';
import RequestCard from '@app/components/RequestCard';
import Slider from '@app/components/Slider';
import TmdbTitleCard from '@app/components/TitleCard/TmdbTitleCard';
import FavoritesSlider from '@app/components/UserProfile/FavoritesSlider';
import ProfileHeader from '@app/components/UserProfile/ProfileHeader';
import useInterfaceStyle from '@app/hooks/useInterfaceStyle';
import useSettings from '@app/hooks/useSettings';
import { Permission, UserType, useUser } from '@app/hooks/useUser';
import ErrorPage from '@app/pages/_error';
import defineMessages from '@app/utils/defineMessages';
import { ArrowRightCircleIcon } from '@heroicons/react/24/outline';
import type { WatchlistResponse } from '@server/interfaces/api/discoverInterfaces';
import type {
  QuotaResponse,
  QuotaStatus,
  UserRequestsResponse,
  UserWatchDataResponse,
} from '@server/interfaces/api/userInterfaces';
import type { BookDetails } from '@server/models/Book';
import type { ComicDetails } from '@server/models/Comic';
import type { MovieDetails } from '@server/models/Movie';
import type { MusicDetails } from '@server/models/Music';
import type { TvDetails } from '@server/models/Tv';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useCallback, useEffect, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.UserProfile', {
  recentrequests: 'Recent Requests',
  limit: '{remaining} of {limit}',
  requestsperdays: '{limit} remaining',
  unlimited: 'Unlimited',
  totalrequests: 'Total Requests',
  pastdays: '{type} (past {days} days)',
  movierequests: 'Movie Requests',
  seriesrequest: 'Series Requests',
  musicrequests: 'Music Requests',
  bookrequests: 'Book Requests',
  recentlywatched: 'Recently Watched',
  plexwatchlist: 'Plex Watchlist',
  localWatchlist: "{username}'s Watchlist",
  emptywatchlist:
    'Media added to your <PlexWatchlistSupportLink>Plex Watchlist</PlexWatchlistSupportLink> will appear here.',
});

type MediaTitle =
  | MovieDetails
  | TvDetails
  | MusicDetails
  | BookDetails
  | ComicDetails;

const UserProfile = () => {
  const intl = useIntl();
  const router = useRouter();
  const { user, error } = useUser({
    id: Number(router.query.userId),
  });
  const { user: currentUser, hasPermission: currentHasPermission } = useUser();
  const [interfaceStyle] = useInterfaceStyle();
  const ambient = interfaceStyle === 'ambient';
  const { currentSettings } = useSettings();
  const [availableTitles, setAvailableTitles] = useState<
    Record<number, MediaTitle>
  >({});

  const { data: requests, error: requestError } = useSWR<UserRequestsResponse>(
    user &&
      (user.id === currentUser?.id ||
        currentHasPermission(
          [Permission.MANAGE_REQUESTS, Permission.REQUEST_VIEW],
          { type: 'or' }
        ))
      ? `/api/v1/user/${user?.id}/requests?take=10&skip=0`
      : null
  );
  const { data: quota } = useSWR<QuotaResponse>(
    user &&
      (user.id === currentUser?.id ||
        currentHasPermission(
          [Permission.MANAGE_USERS, Permission.MANAGE_REQUESTS],
          { type: 'and' }
        ))
      ? `/api/v1/user/${user.id}/quota`
      : null
  );
  const { data: watchData, error: watchDataError } =
    useSWR<UserWatchDataResponse>(
      user &&
        user.userType !== UserType.LOCAL &&
        (user.id === currentUser?.id || currentHasPermission(Permission.ADMIN))
        ? `/api/v1/user/${user.id}/watch_data`
        : null
    );

  const { data: watchlistItems, error: watchlistError } =
    useSWR<WatchlistResponse>(
      user?.id === currentUser?.id ||
        currentHasPermission(
          [Permission.MANAGE_REQUESTS, Permission.WATCHLIST_VIEW],
          {
            type: 'or',
          }
        )
        ? `/api/v1/user/${user?.id}/watchlist`
        : null,
      {
        revalidateOnMount: true,
      }
    );

  const updateAvailableTitles = useCallback(
    (requestId: number, mediaTitle: MediaTitle) => {
      setAvailableTitles((titles) => ({
        ...titles,
        [requestId]: mediaTitle,
      }));
    },
    []
  );

  useEffect(() => {
    setAvailableTitles({});
  }, [user?.id]);

  if (!user && !error) {
    return <LoadingSpinner />;
  }

  if (!user) {
    return <ErrorPage statusCode={404} />;
  }

  // Stat tiles: soft surface tiles under Ambient, Seerr's cards otherwise
  const statTile = (restricted = false) =>
    ambient
      ? `overflow-hidden rounded-[22px] px-5 py-4 sm:px-6 sm:py-[22px] ${
          restricted ? 'bg-as-bad-bg' : 'bg-as-surface'
        }`
      : `overflow-hidden rounded-lg bg-gray-800/50 px-4 py-5 shadow ring-1 ${
          restricted
            ? 'bg-gradient-to-t from-red-900 to-transparent ring-red-500'
            : 'ring-gray-700'
        } sm:p-6`;
  const statLabel = (restricted = false) =>
    ambient
      ? `truncate text-[12px] font-semibold uppercase tracking-wide sm:text-[13px] ${
          restricted ? 'text-as-bad' : 'text-as-ink-faint'
        }`
      : `truncate text-sm font-bold ${
          restricted ? 'text-red-500' : 'text-gray-300'
        }`;
  const statValue = (restricted = false) =>
    ambient
      ? `mt-2 flex items-center text-sm ${
          restricted ? 'text-as-bad' : 'text-as-ink-muted'
        }`
      : `mt-1 flex items-center text-sm ${
          restricted ? 'text-red-500' : 'text-white'
        }`;
  const statNumber = ambient
    ? 'font-display text-[21px] font-medium leading-tight text-as-ink sm:text-[28px]'
    : 'text-3xl font-semibold';

  // Music and book tiles only show once Lidarr or LazyLibrarian is set up
  const quotaTiles = quota
    ? [
        {
          key: 'movie',
          label: messages.movierequests,
          status: quota.movie,
        },
        { key: 'tv', label: messages.seriesrequest, status: quota.tv },
        ...(currentSettings.musicEnabled
          ? [
              {
                key: 'music',
                label: messages.musicrequests,
                status: quota.music,
              },
            ]
          : []),
        ...(currentSettings.booksEnabled
          ? [{ key: 'book', label: messages.bookrequests, status: quota.book }]
          : []),
      ]
    : [];

  // Total and the media tiles: one row on wide screens, otherwise two columns
  // (one on classic phones) with Total full width whenever the count is odd
  const statGrid =
    quotaTiles.length === 2
      ? ambient
        ? 'grid-cols-2 gap-3 sm:grid-cols-3'
        : 'grid-cols-1 gap-5 lg:grid-cols-3'
      : quotaTiles.length === 3
        ? ambient
          ? 'grid-cols-2 gap-3 xl:grid-cols-4'
          : 'grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-4'
        : ambient
          ? 'grid-cols-2 gap-3 xl:grid-cols-5'
          : 'grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-5';
  const totalTileSpan =
    quotaTiles.length === 2
      ? ambient
        ? 'col-span-2 sm:col-span-1'
        : ''
      : quotaTiles.length === 4
        ? ambient
          ? 'col-span-2 xl:col-span-1'
          : 'sm:col-span-2 xl:col-span-1'
        : '';

  const renderQuotaTile = (
    key: string,
    label: (typeof messages)[keyof typeof messages],
    status?: QuotaStatus
  ) => (
    <div key={key} className={statTile(status?.restricted)}>
      <dt className={statLabel(status?.restricted)}>
        {status?.limit
          ? intl.formatMessage(messages.pastdays, {
              type: intl.formatMessage(label),
              days: status.days,
            })
          : intl.formatMessage(label)}
      </dt>
      <dd className={statValue(status?.restricted)}>
        {status?.limit ? (
          <>
            <ProgressCircle
              progress={Math.round(
                ((status.remaining ?? 0) / (status.limit ?? 1)) * 100
              )}
              useHeatLevel
              className="mr-2 h-8 w-8"
            />
            <div>
              {intl.formatMessage(messages.requestsperdays, {
                limit: (
                  <span className={statNumber}>
                    {intl.formatMessage(messages.limit, {
                      remaining: status.remaining,
                      limit: status.limit,
                    })}
                  </span>
                ),
              })}
            </div>
          </>
        ) : (
          <span className={statNumber}>
            {intl.formatMessage(messages.unlimited)}
          </span>
        )}
      </dd>
    </div>
  );

  const watchlistSliderTitle = intl.formatMessage(
    user.userType === UserType.PLEX
      ? messages.plexwatchlist
      : messages.localWatchlist,
    { username: user.displayName }
  );

  return (
    <>
      <PageTitle title={user.displayName} />
      {Object.keys(availableTitles).length > 0 && (
        <div className="absolute -top-16 left-0 right-0 z-0 h-96">
          <ImageFader
            key={user.id}
            isDarker
            backgroundImages={Object.values(availableTitles)
              .filter(
                (media): media is MovieDetails | TvDetails =>
                  'backdropPath' in media && !!media.backdropPath
              )
              .map(
                (media) =>
                  `https://image.tmdb.org/t/p/w1920_and_h800_multi_faces/${media.backdropPath}`
              )
              .slice(0, 6)}
          />
        </div>
      )}
      <ProfileHeader user={user} />
      {user.id === currentUser?.id && <ReadingAppsNudge className="mt-5" />}
      {quota &&
        (user.id === currentUser?.id ||
          currentHasPermission(
            [Permission.MANAGE_USERS, Permission.MANAGE_REQUESTS],
            { type: 'and' }
          )) && (
          <div className="relative z-40">
            <dl className={`mt-5 grid ${statGrid}`}>
              <div className={`${statTile()} ${totalTileSpan}`}>
                <dt className={statLabel()}>
                  {intl.formatMessage(messages.totalrequests)}
                </dt>
                <dd
                  className={
                    ambient
                      ? `mt-2 ${statNumber} hover:text-as-accent-soft`
                      : 'mt-1 text-3xl font-semibold text-white'
                  }
                >
                  <Link
                    href={
                      currentHasPermission(
                        [Permission.MANAGE_REQUESTS, Permission.REQUEST_VIEW],
                        { type: 'or' }
                      )
                        ? `/users/${user?.id}/requests?filter=all`
                        : '/requests'
                    }
                  >
                    {intl.formatNumber(user.requestCount)}
                  </Link>
                </dd>
              </div>
              {quotaTiles.map(({ key, label, status }) =>
                renderQuotaTile(key, label, status)
              )}
            </dl>
          </div>
        )}
      {(user.id === currentUser?.id ||
        currentHasPermission(
          [Permission.MANAGE_REQUESTS, Permission.REQUEST_VIEW],
          { type: 'or' }
        )) &&
        (!requests || !!requests.results.length) &&
        !requestError && (
          <>
            <div className="slider-header">
              <Link
                href={
                  currentHasPermission(
                    [Permission.MANAGE_REQUESTS, Permission.REQUEST_VIEW],
                    { type: 'or' }
                  )
                    ? `/users/${user?.id}/requests?filter=all`
                    : '/requests'
                }
                className="slider-title"
              >
                <span>{intl.formatMessage(messages.recentrequests)}</span>
                <ArrowRightCircleIcon />
              </Link>
            </div>
            <Slider
              sliderKey="requests"
              isLoading={!requests}
              items={(requests?.results ?? []).map((request) => (
                <RequestCard
                  key={`request-slider-item-${request.id}`}
                  request={request}
                  onTitleData={updateAvailableTitles}
                />
              ))}
              placeholder={<RequestCard.Placeholder />}
            />
          </>
        )}
      {(user.id === currentUser?.id ||
        currentHasPermission(
          [Permission.MANAGE_REQUESTS, Permission.WATCHLIST_VIEW],
          { type: 'or' }
        )) &&
        (!watchlistItems ||
          !!watchlistItems.results.length ||
          (user.id === currentUser?.id &&
            (user.settings?.watchlistSyncMovies ||
              user.settings?.watchlistSyncTv))) &&
        !watchlistError && (
          <>
            <div className="slider-header">
              <Link
                href={
                  user.id === currentUser?.id
                    ? '/profile/watchlist'
                    : `/users/${user.id}/watchlist`
                }
                className="slider-title"
              >
                <span>{watchlistSliderTitle}</span>
                <ArrowRightCircleIcon />
              </Link>
            </div>
            <Slider
              sliderKey="watchlist"
              isLoading={!watchlistItems}
              isEmpty={!!watchlistItems && watchlistItems.results.length === 0}
              emptyMessage={intl.formatMessage(messages.emptywatchlist, {
                PlexWatchlistSupportLink: (msg: React.ReactNode) => (
                  <a
                    href="https://support.plex.tv/articles/universal-watchlist/"
                    className="text-white transition duration-300 hover:underline"
                    target="_blank"
                    rel="noreferrer"
                  >
                    {msg}
                  </a>
                ),
              })}
              items={watchlistItems?.results.map((item) => (
                <TmdbTitleCard
                  id={item.tmdbId}
                  key={`watchlist-slider-item-${item.ratingKey || `${item.mediaType}-${item.id}`}`}
                  tmdbId={item.tmdbId}
                  mbId={item.mbId}
                  olId={item.olId}
                  type={item.mediaType}
                  title={item.title}
                  image={item.image}
                />
              ))}
            />
          </>
        )}
      <FavoritesSlider user={user} />
      {user.userType !== UserType.LOCAL &&
        (user.id === currentUser?.id ||
          currentHasPermission(Permission.ADMIN)) &&
        (!watchData || !!watchData.recentlyWatched?.length) &&
        !watchDataError && (
          <>
            <div className="slider-header">
              <div className="slider-title">
                <span>{intl.formatMessage(messages.recentlywatched)}</span>
              </div>
            </div>
            <Slider
              sliderKey="media"
              isLoading={!watchData}
              items={watchData?.recentlyWatched?.map((item) => (
                <TmdbTitleCard
                  key={`media-slider-item-${item.id}`}
                  id={item.id}
                  tmdbId={item.tmdbId}
                  tvdbId={item.tvdbId}
                  type={item.mediaType}
                />
              ))}
            />
          </>
        )}
    </>
  );
};

export default UserProfile;
