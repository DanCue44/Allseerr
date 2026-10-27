import RTAudFresh from '@app/assets/rt_aud_fresh.svg';
import RTAudRotten from '@app/assets/rt_aud_rotten.svg';
import RTFresh from '@app/assets/rt_fresh.svg';
import RTRotten from '@app/assets/rt_rotten.svg';
import EmbyLogo from '@app/assets/services/emby.svg';
import ImdbLogo from '@app/assets/services/imdb.svg';
import JellyfinLogo from '@app/assets/services/jellyfin.svg';
import LetterboxdLogo from '@app/assets/services/letterboxd.svg';
import PlexLogo from '@app/assets/services/plex.svg';
import SimklLogo from '@app/assets/services/simkl.svg';
import TraktLogo from '@app/assets/services/trakt.svg';
import Spinner from '@app/assets/spinner.svg';
import TmdbLogo from '@app/assets/tmdb_logo.svg';
import FileInfoCard from '@app/components/Allseerr/MediaFiles';
import SubtitlesPanel from '@app/components/Allseerr/SubtitlesPanel';
import type { CrewGroup, RatingItem } from '@app/components/Allseerr/Title';
import {
  Card,
  CastRail,
  ChipLinks,
  CollectionBanner,
  CrewGrid,
  DetailRow,
  LinkChips,
  RailHeader,
  RatingsStrip,
  TitleHero,
} from '@app/components/Allseerr/Title';
import PosterRail from '@app/components/Allseerr/Title/PosterRail';
import StatusPill from '@app/components/Allseerr/Title/StatusPill';
import {
  chip,
  pillIcon,
  pillIconWarn,
  pillPrimary,
  pillSecondary,
  pillSecondaryCollapse,
} from '@app/components/Allseerr/Title/styles';
import BlocklistModal from '@app/components/BlocklistModal';
import Button from '@app/components/Common/Button';
import CachedImage from '@app/components/Common/CachedImage';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import type { PlayButtonLink } from '@app/components/Common/PlayButton';
import Tooltip from '@app/components/Common/Tooltip';
import FavoriteButton from '@app/components/FavoriteButton';
import IssueModal from '@app/components/IssueModal';
import ManageSlideOver from '@app/components/ManageSlideOver';
import RemovalRequestButton from '@app/components/RemovalRequestButton';
import RequestButton from '@app/components/RequestButton';
import WatchedButton from '@app/components/WatchedButton';
import useDeepLinks from '@app/hooks/useDeepLinks';
import useLocale from '@app/hooks/useLocale';
import useSettings from '@app/hooks/useSettings';
import useToasts from '@app/hooks/useToasts';
import { Permission, UserType, useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import ErrorPage from '@app/pages/_error';
import { sortCrewPriority } from '@app/utils/creditHelpers';
import defineMessages from '@app/utils/defineMessages';
import { refreshIntervalHelper } from '@app/utils/refreshIntervalHelper';
import {
  CloudIcon,
  CogIcon,
  ExclamationTriangleIcon,
  EyeIcon,
  EyeSlashIcon,
  FilmIcon,
  MinusCircleIcon,
  PlayIcon,
  TicketIcon,
} from '@heroicons/react/24/outline';
import {
  ChevronDoubleDownIcon,
  ChevronDoubleUpIcon,
} from '@heroicons/react/24/solid';
import { type RatingResponse } from '@server/api/ratings';
import { IssueStatus } from '@server/constants/issue';
import { MediaStatus, MediaType } from '@server/constants/media';
import { MediaServerType } from '@server/constants/server';
import { getMovieCertification } from '@server/lib/contentRatingLimit';
import type { MovieDetails as MovieDetailsType } from '@server/models/Movie';
import axios from 'axios';
import { countries } from 'country-flag-icons';
import 'country-flag-icons/3x2/flags.css';
import { uniqBy } from 'lodash';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.Allseerr.MovieDetails', {
  originaltitle: 'Original Title',
  releasedate:
    '{releaseCount, plural, one {Release Date} other {Release Dates}}',
  revenue: 'Revenue',
  budget: 'Budget',
  watchtrailer: 'Watch Trailer',
  originallanguage: 'Original Language',
  overview: 'Overview',
  runtime: '{minutes} minutes',
  cast: 'Cast',
  recommendations: 'Recommendations',
  similar: 'Similar Titles',
  overviewunavailable: 'Overview unavailable.',
  studio: '{studioCount, plural, one {Studio} other {Studios}}',
  viewfullcrew: 'View Full Crew',
  openradarr: 'Open Movie in Radarr',
  openradarr4k: 'Open Movie in 4K Radarr',
  downloadstatus: 'Download Status',
  play: 'Play on {mediaServerName}',
  play4k: 'Play 4K on {mediaServerName}',
  markavailable: 'Mark as Available',
  mark4kavailable: 'Mark as Available in 4K',
  showmore: 'Show More',
  showless: 'Show Less',
  productioncountries:
    'Production {countryCount, plural, one {Country} other {Countries}}',
  theatricalrelease: 'Theatrical Release',
  digitalrelease: 'Digital Release',
  physicalrelease: 'Physical Release',
  reportissue: 'Report an Issue',
  managemovie: 'Manage Movie',
  rtcriticsscore: 'Rotten Tomatoes Tomatometer',
  rtaudiencescore: 'Rotten Tomatoes Audience Score',
  tmdbuserscore: 'TMDB User Score',
  imdbuserscore: 'IMDB User Score – votes: {formattedCount}',
  watchlistSuccess: '<strong>{title}</strong> added to watchlist successfully!',
  watchlistDeleted:
    '<strong>{title}</strong> Removed from watchlist successfully!',
  watchlistError: 'Something went wrong. Please try again.',
  removefromwatchlist: 'Remove From Watchlist',
  addtowatchlist: 'Add To Watchlist',
  details: 'Details',
  crew: 'Crew',
  keywords: 'Keywords',
  wheretowatch: 'Where to watch',
  stream: 'Stream',
  seeall: 'See all',
  watchlist: 'Watchlist',
  onwatchlist: 'On watchlist',
  tomatometer: 'Tomatometer',
  audience: 'Audience',
  rottentomatoes: 'Rotten Tomatoes',
  imdbvotes: '{count} votes',
  userscore: 'User score',
  runtimeshort: '{hours}h {minutes}m',
  runtimeminutes: '{minutes}m',
  requestedby: 'Requested by {user} on {date}',
});

interface MovieDetailsProps {
  movie?: MovieDetailsType;
}

const MovieDetails = ({ movie }: MovieDetailsProps) => {
  const settings = useSettings();
  const { user, hasPermission } = useUser();
  const router = useRouter();
  const intl = useIntl();
  const { locale } = useLocale();
  const [showManager, setShowManager] = useState(false);
  const minStudios = 3;
  const [showMoreStudios, setShowMoreStudios] = useState(false);
  const [showIssueModal, setShowIssueModal] = useState(false);
  const [isUpdating, setIsUpdating] = useState<boolean>(false);
  const [toggleWatchlist, setToggleWatchlist] = useState<boolean>(
    !movie?.onUserWatchlist
  );
  const [isBlocklistUpdating, setIsBlocklistUpdating] =
    useState<boolean>(false);
  const [showBlocklistModal, setShowBlocklistModal] = useState(false);
  const { addToast } = useToasts();

  const {
    data,
    error,
    mutate: revalidate,
  } = useSWR<MovieDetailsType>(`/api/v1/movie/${router.query.movieId}`, {
    fallbackData: movie,
    refreshInterval: refreshIntervalHelper(
      {
        downloadStatus: movie?.mediaInfo?.downloadStatus,
        downloadStatus4k: movie?.mediaInfo?.downloadStatus4k,
      },
      15000
    ),
  });

  const { data: ratingData } = useSWR<RatingResponse>(
    `/api/v1/movie/${router.query.movieId}/ratingscombined`
  );

  const sortedCrew = useMemo(
    () => sortCrewPriority(data?.credits.crew ?? []),
    [data]
  );

  useEffect(() => {
    if (router.query.manage === '1') {
      setShowManager(true);
      router.replace({
        pathname: router.pathname,
        query: { movieId: router.query.movieId },
      });
    }
  }, [router, router.query.manage]);

  const closeBlocklistModal = useCallback(
    () => setShowBlocklistModal(false),
    []
  );

  const { mediaUrl: plexUrl, mediaUrl4k: plexUrl4k } = useDeepLinks({
    mediaUrl: data?.mediaInfo?.mediaUrl,
    mediaUrl4k: data?.mediaInfo?.mediaUrl4k,
    iOSPlexUrl: data?.mediaInfo?.iOSPlexUrl,
    iOSPlexUrl4k: data?.mediaInfo?.iOSPlexUrl4k,
  });

  if (!data && !error) {
    return <LoadingSpinner />;
  }

  if (!data) {
    return <ErrorPage statusCode={404} />;
  }

  const showAllStudios = data.productionCompanies.length <= minStudios + 1;
  const mediaLinks: PlayButtonLink[] = [];

  if (
    plexUrl &&
    hasPermission([Permission.REQUEST, Permission.REQUEST_MOVIE], {
      type: 'or',
    })
  ) {
    mediaLinks.push({
      text: getAvailableMediaServerName(),
      url: plexUrl,
      svg: <PlayIcon />,
    });
  }

  if (
    settings.currentSettings.movie4kEnabled &&
    plexUrl4k &&
    hasPermission([Permission.REQUEST_4K, Permission.REQUEST_4K_MOVIE], {
      type: 'or',
    })
  ) {
    mediaLinks.push({
      text: getAvailable4kMediaServerName(),
      url: plexUrl4k,
      svg: <PlayIcon />,
    });
  }

  const trailerVideo = data.relatedVideos
    ?.filter((r) => r.type === 'Trailer')
    .sort((a, b) => a.size - b.size)
    .pop();
  const trailerUrl =
    trailerVideo?.site === 'YouTube' &&
    settings.currentSettings.youtubeUrl != ''
      ? `${settings.currentSettings.youtubeUrl}${trailerVideo?.key}`
      : trailerVideo?.url;

  if (trailerUrl) {
    mediaLinks.push({
      text: intl.formatMessage(messages.watchtrailer),
      url: trailerUrl,
      svg: <FilmIcon />,
    });
  }

  const discoverRegion = user?.settings?.discoverRegion
    ? user.settings.discoverRegion
    : settings.currentSettings.discoverRegion
      ? settings.currentSettings.discoverRegion
      : 'US';

  const releases = data.releases.results.find(
    (r) => r.iso_3166_1 === discoverRegion
  )?.release_dates;

  // Release date types:
  // 1. Premiere
  // 2. Theatrical (limited)
  // 3. Theatrical
  // 4. Digital
  // 5. Physical
  // 6. TV
  const filteredReleases = uniqBy(
    releases?.filter((r) => r.type > 2 && r.type < 6),
    'type'
  );

  const certification = releases?.find((r) => r.certification)?.certification;

  const streamingRegion = user?.settings?.streamingRegion
    ? user.settings.streamingRegion
    : settings.currentSettings.streamingRegion
      ? settings.currentSettings.streamingRegion
      : 'US';
  const streamingProviders =
    data?.watchProviders?.find(
      (provider) => provider.iso_3166_1 === streamingRegion
    )?.flatrate ?? [];

  function getAvailableMediaServerName() {
    if (settings.currentSettings.mediaServerType === MediaServerType.EMBY) {
      return intl.formatMessage(messages.play, { mediaServerName: 'Emby' });
    }

    if (settings.currentSettings.mediaServerType === MediaServerType.PLEX) {
      return intl.formatMessage(messages.play, { mediaServerName: 'Plex' });
    }

    return intl.formatMessage(messages.play, { mediaServerName: 'Jellyfin' });
  }

  function getAvailable4kMediaServerName() {
    if (settings.currentSettings.mediaServerType === MediaServerType.EMBY) {
      return intl.formatMessage(messages.play, { mediaServerName: 'Emby' });
    }

    if (settings.currentSettings.mediaServerType === MediaServerType.PLEX) {
      return intl.formatMessage(messages.play4k, { mediaServerName: 'Plex' });
    }

    return intl.formatMessage(messages.play4k, { mediaServerName: 'Jellyfin' });
  }

  const onClickWatchlistBtn = async (): Promise<void> => {
    setIsUpdating(true);

    try {
      const response = await axios.post('/api/v1/watchlist', {
        tmdbId: movie?.id,
        mediaType: MediaType.MOVIE,
        title: movie?.title,
      });

      if (response.data) {
        addToast(
          <span>
            {intl.formatMessage(messages.watchlistSuccess, {
              title: movie?.title,
              strong: (msg: React.ReactNode) => <strong>{msg}</strong>,
            })}
          </span>,
          { appearance: 'success', autoDismiss: true }
        );
      }
    } catch {
      addToast(intl.formatMessage(messages.watchlistError), {
        appearance: 'error',
        autoDismiss: true,
      });
    }

    setIsUpdating(false);
    setToggleWatchlist((prevState) => !prevState);
  };

  const onClickDeleteWatchlistBtn = async (): Promise<void> => {
    setIsUpdating(true);
    try {
      await axios.delete(
        `/api/v1/watchlist/${movie?.id}?mediaType=${MediaType.MOVIE}`
      );

      addToast(
        <span>
          {intl.formatMessage(messages.watchlistDeleted, {
            title: movie?.title,
            strong: (msg: React.ReactNode) => <strong>{msg}</strong>,
          })}
        </span>,
        { appearance: 'info', autoDismiss: true }
      );
    } catch {
      addToast(intl.formatMessage(messages.watchlistError), {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      setIsUpdating(false);
      setToggleWatchlist((prevState) => !prevState);
    }
  };

  const onClickHideItemBtn = async (): Promise<void> => {
    setIsBlocklistUpdating(true);

    try {
      await axios.post('/api/v1/blocklist', {
        tmdbId: movie?.id,
        mediaType: 'movie',
        title: movie?.title,
        user: user?.id,
      });

      addToast(
        <span>
          {intl.formatMessage(globalMessages.blocklistSuccess, {
            title: movie?.title,
            strong: (msg: React.ReactNode) => <strong>{msg}</strong>,
          })}
        </span>,
        { appearance: 'success', autoDismiss: true }
      );

      revalidate();
    } catch (e) {
      if (e?.response?.status === 412) {
        addToast(
          <span>
            {intl.formatMessage(globalMessages.blocklistDuplicateError, {
              title: movie?.title,
              strong: (msg: React.ReactNode) => <strong>{msg}</strong>,
            })}
          </span>,
          { appearance: 'info', autoDismiss: true }
        );
      } else {
        addToast(intl.formatMessage(globalMessages.blocklistError), {
          appearance: 'error',
          autoDismiss: true,
        });
      }
    }

    setIsBlocklistUpdating(false);
    closeBlocklistModal();
  };

  const showHideButton = hasPermission([Permission.MANAGE_BLOCKLIST], {
    type: 'or',
  });

  const isAvailable =
    data.mediaInfo?.status === MediaStatus.AVAILABLE ||
    data.mediaInfo?.status === MediaStatus.PARTIALLY_AVAILABLE ||
    data.mediaInfo?.status4k === MediaStatus.AVAILABLE ||
    data.mediaInfo?.status4k === MediaStatus.PARTIALLY_AVAILABLE;

  const show4kStatus =
    settings.currentSettings.movie4kEnabled &&
    hasPermission(
      [
        Permission.MANAGE_REQUESTS,
        Permission.REQUEST_4K,
        Permission.REQUEST_4K_MOVIE,
      ],
      { type: 'or' }
    );

  const latestRequest = (data.mediaInfo?.requests ?? [])
    .filter((request) => request.requestedBy)
    .sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    )[0];

  const runtime = data.runtime
    ? data.runtime >= 60
      ? intl.formatMessage(messages.runtimeshort, {
          hours: Math.floor(data.runtime / 60),
          minutes: data.runtime % 60,
        })
      : intl.formatMessage(messages.runtimeminutes, { minutes: data.runtime })
    : undefined;

  const ratings: RatingItem[] = [];
  if (
    ratingData?.rt?.criticsRating &&
    typeof ratingData?.rt?.criticsScore === 'number'
  ) {
    ratings.push({
      key: 'rt-critics',
      label: intl.formatMessage(messages.tomatometer),
      value: `${ratingData.rt.criticsScore}%`,
      caption: intl.formatMessage(messages.rottentomatoes),
      href: ratingData.rt.url,
      tooltip: intl.formatMessage(messages.rtcriticsscore),
      icon:
        ratingData.rt.criticsRating === 'Rotten' ? <RTRotten /> : <RTFresh />,
    });
  }
  if (ratingData?.rt?.audienceRating && !!ratingData?.rt?.audienceScore) {
    ratings.push({
      key: 'rt-audience',
      label: intl.formatMessage(messages.audience),
      value: `${ratingData.rt.audienceScore}%`,
      caption: intl.formatMessage(messages.rottentomatoes),
      href: ratingData.rt.url,
      tooltip: intl.formatMessage(messages.rtaudiencescore),
      icon:
        ratingData.rt.audienceRating === 'Spilled' ? (
          <RTAudRotten />
        ) : (
          <RTAudFresh />
        ),
    });
  }
  if (ratingData?.imdb?.criticsScore) {
    const formattedCount = intl.formatNumber(
      ratingData.imdb.criticsScoreCount,
      { notation: 'compact', compactDisplay: 'short', maximumFractionDigits: 1 }
    );
    ratings.push({
      key: 'imdb',
      label: 'IMDb',
      value: Number(ratingData.imdb.criticsScore).toFixed(1),
      caption: intl.formatMessage(messages.imdbvotes, {
        count: formattedCount,
      }),
      href: ratingData.imdb.url,
      tooltip: intl.formatMessage(messages.imdbuserscore, { formattedCount }),
      icon: <ImdbLogo />,
    });
  }
  if (data.voteCount) {
    ratings.push({
      key: 'tmdb',
      label: 'TMDB',
      value: `${Math.round(data.voteAverage * 10)}%`,
      caption: intl.formatMessage(messages.userscore),
      icon: <TmdbLogo />,
      href: `https://www.themoviedb.org/movie/${data.id}?language=${locale}`,
      tooltip: intl.formatMessage(messages.tmdbuserscore),
    });
  }

  // Crew grouped by job, keeping the priority order
  const crewGroups: CrewGroup[] = [];
  sortedCrew.forEach((person) => {
    const group = crewGroups.find((g) => g.job === person.job);
    if (group) {
      if (
        group.people.length < 3 &&
        !group.people.some((p) => p.id === person.id)
      ) {
        group.people.push(person);
      }
    } else if (crewGroups.length < 7) {
      crewGroups.push({ job: person.job, people: [person] });
    }
  });

  const mediaServerName =
    settings.currentSettings.mediaServerType === MediaServerType.PLEX
      ? 'Plex'
      : settings.currentSettings.mediaServerType === MediaServerType.EMBY
        ? 'Emby'
        : 'Jellyfin';
  const mediaUrl = data.mediaInfo?.mediaUrl ?? data.mediaInfo?.mediaUrl4k;

  const externalLinks = [
    ...(mediaUrl
      ? [
          {
            key: 'server',
            href: mediaUrl,
            label: mediaServerName,
            icon:
              mediaServerName === 'Plex' ? (
                <PlexLogo />
              ) : mediaServerName === 'Emby' ? (
                <EmbyLogo />
              ) : (
                <JellyfinLogo />
              ),
          },
        ]
      : []),
    {
      key: 'tmdb',
      href: `https://www.themoviedb.org/movie/${data.id}?language=${locale}`,
      label: 'TMDB',
      icon: <TmdbLogo />,
    },
    ...(data.externalIds.imdbId
      ? [
          {
            key: 'imdb',
            href: `https://www.imdb.com/title/${data.externalIds.imdbId}`,
            label: 'IMDb',
            icon: <ImdbLogo />,
          },
        ]
      : []),
    ...(ratingData?.rt?.url
      ? [
          {
            key: 'rt',
            href: ratingData.rt.url,
            label: 'Rotten Tomatoes',
            icon: <RTFresh />,
          },
        ]
      : []),
    ...(data.externalIds.imdbId
      ? [
          {
            key: 'trakt',
            href: `https://trakt.tv/movies/${data.externalIds.imdbId}`,
            label: 'Trakt',
            icon: <TraktLogo />,
          },
          {
            key: 'simkl',
            href: `https://api.simkl.com/redirect?to=Simkl&imdb=${encodeURIComponent(
              data.externalIds.imdbId
            )}`,
            label: 'Simkl',
            icon: <SimklLogo />,
          },
        ]
      : []),
    {
      key: 'letterboxd',
      href: `https://letterboxd.com/tmdb/${data.id}`,
      label: 'Letterboxd',
      icon: <LetterboxdLogo />,
    },
  ];

  const openIssues = (data.mediaInfo?.issues ?? []).filter(
    (issue) => issue.status === IssueStatus.OPEN
  );

  return (
    <div className="relative -mx-4 -mt-20 pb-10 lg:-mt-28">
      <PageTitle title={data.title} />
      <IssueModal
        onCancel={() => setShowIssueModal(false)}
        show={showIssueModal}
        mediaType="movie"
        tmdbId={data.id}
      />
      <ManageSlideOver
        data={data}
        mediaType="movie"
        onClose={() => {
          setShowManager(false);
          router.replace({
            pathname: router.pathname,
            query: { movieId: router.query.movieId },
          });
        }}
        revalidate={() => revalidate()}
        show={showManager}
      />
      <BlocklistModal
        tmdbId={data.id}
        type="movie"
        show={showBlocklistModal}
        onCancel={closeBlocklistModal}
        onComplete={onClickHideItemBtn}
        isUpdating={isBlocklistUpdating}
      />

      <TitleHero
        backdropPath={data.backdropPath}
        posterPath={data.posterPath}
        posterAlt={data.title}
        badges={
          <>
            {show4kStatus && (
              <StatusPill
                status={data.mediaInfo?.status4k}
                downloads={data.mediaInfo?.downloadStatus4k}
                is4k
                href={plexUrl4k}
              />
            )}
            <StatusPill
              status={data.mediaInfo?.status}
              downloads={data.mediaInfo?.downloadStatus}
              labelHd={
                show4kStatus &&
                !!data.mediaInfo?.status4k &&
                data.mediaInfo.status4k !== MediaStatus.UNKNOWN
              }
              href={plexUrl}
            />
          </>
        }
      >
        {latestRequest && (
          <span className="flex items-center gap-2 text-[13px] text-as-ink-muted">
            <span className="bg-as-mid relative h-6 w-6 overflow-hidden rounded-full">
              <CachedImage
                type="avatar"
                src={latestRequest.requestedBy.avatar}
                alt=""
                fill
                style={{ objectFit: 'cover' }}
              />
            </span>
            {intl.formatMessage(messages.requestedby, {
              user: latestRequest.requestedBy.displayName,
              date: intl.formatDate(latestRequest.createdAt, {
                month: 'short',
                day: 'numeric',
              }),
            })}
          </span>
        )}

        <h1
          className="font-display text-3xl font-bold leading-[1.05] tracking-[-1px] text-as-ink sm:text-4xl lg:text-5xl"
          data-testid="media-title"
        >
          {data.title}{' '}
          {data.releaseDate && (
            <span className="font-medium text-as-ink-faint">
              ({data.releaseDate.slice(0, 4)})
            </span>
          )}
        </h1>

        <div className="flex flex-wrap items-center gap-3 text-as-ink-muted">
          {certification && (
            <span className="rounded-md border border-as-line-strong px-2 py-0.5 text-[13px] font-bold">
              {certification}
            </span>
          )}
          {runtime && <span>{runtime}</span>}
          {(certification || runtime) && data.genres.length > 0 && (
            <span>·</span>
          )}
          {data.genres.map((genre) => (
            <Link
              key={`genre-${genre.id}`}
              href={`/discover/movies?genre=${genre.id}`}
              className={chip}
            >
              {genre.name}
            </Link>
          ))}
        </div>

        {data.tagline && (
          <p className="italic text-as-ink-muted">{data.tagline}</p>
        )}
        <p className="max-w-[760px] leading-relaxed text-as-ink-soft">
          {data.overview
            ? data.overview
            : intl.formatMessage(messages.overviewunavailable)}
        </p>

        <div className="flex flex-wrap items-center gap-2.5 max-sm:justify-center">
          {mediaLinks.map((link, i) => (
            <a
              key={`media-link-${i}`}
              href={link.url}
              target="_blank"
              rel="noreferrer"
              className={`inline-flex items-center border transition [&_svg]:h-4 [&_svg]:w-4 ${
                i === 0 && !link.url.includes('youtube')
                  ? pillPrimary
                  : pillSecondary
              }`}
            >
              {link.svg}
              <span>{link.text}</span>
            </a>
          ))}
          <RequestButton
            mediaType="movie"
            media={data.mediaInfo}
            tmdbId={data.id}
            watchProviders={data.watchProviders}
            contentRating={getMovieCertification(data.releases)}
            onUpdate={() => revalidate()}
            ambient
          />
          {data?.mediaInfo?.status !== MediaStatus.BLOCKLISTED &&
            user?.userType !== UserType.PLEX && (
              <Button
                className={pillSecondaryCollapse}
                onClick={
                  toggleWatchlist
                    ? onClickWatchlistBtn
                    : onClickDeleteWatchlistBtn
                }
                disabled={isUpdating}
              >
                {isUpdating ? (
                  <Spinner />
                ) : toggleWatchlist ? (
                  <EyeIcon />
                ) : (
                  <MinusCircleIcon />
                )}
                <span className="max-sm:sr-only">
                  {intl.formatMessage(
                    toggleWatchlist ? messages.watchlist : messages.onwatchlist
                  )}
                </span>
              </Button>
            )}
          <WatchedButton
            media={data.mediaInfo}
            title={data.title}
            onUpdate={() => revalidate()}
            className={pillIcon}
          />
          <FavoriteButton
            tmdbId={data.id}
            mediaType="movie"
            title={data.title}
            className={pillIcon}
          />
          <RemovalRequestButton
            media={data.mediaInfo}
            title={data.title}
            className={pillIcon}
          />
          {showHideButton &&
            data?.mediaInfo?.status !== MediaStatus.PROCESSING &&
            data?.mediaInfo?.status !== MediaStatus.AVAILABLE &&
            data?.mediaInfo?.status !== MediaStatus.PARTIALLY_AVAILABLE &&
            data?.mediaInfo?.status !== MediaStatus.PENDING &&
            data?.mediaInfo?.status !== MediaStatus.BLOCKLISTED && (
              <Tooltip
                content={intl.formatMessage(globalMessages.addToBlocklist)}
              >
                <Button
                  className={pillIcon}
                  onClick={() => setShowBlocklistModal(true)}
                >
                  <EyeSlashIcon />
                </Button>
              </Tooltip>
            )}
          {(data.mediaInfo?.status === MediaStatus.AVAILABLE ||
            (settings.currentSettings.movie4kEnabled &&
              hasPermission(
                [Permission.REQUEST_4K, Permission.REQUEST_4K_MOVIE],
                { type: 'or' }
              ) &&
              data.mediaInfo?.status4k === MediaStatus.AVAILABLE)) &&
            hasPermission(
              [Permission.CREATE_ISSUES, Permission.MANAGE_ISSUES],
              { type: 'or' }
            ) && (
              <Tooltip content={intl.formatMessage(messages.reportissue)}>
                <Button
                  className={pillIconWarn}
                  onClick={() => setShowIssueModal(true)}
                  aria-label={intl.formatMessage(messages.reportissue)}
                >
                  <ExclamationTriangleIcon />
                </Button>
              </Tooltip>
            )}
          {hasPermission(Permission.MANAGE_REQUESTS) &&
            data.mediaInfo &&
            (data.mediaInfo.jellyfinMediaId ||
              data.mediaInfo.jellyfinMediaId4k ||
              data.mediaInfo.status !== MediaStatus.UNKNOWN ||
              data.mediaInfo.status4k !== MediaStatus.UNKNOWN) && (
              <Tooltip content={intl.formatMessage(messages.managemovie)}>
                <Button
                  className={`relative ${pillIcon}`}
                  onClick={() => setShowManager(true)}
                  aria-label={intl.formatMessage(messages.managemovie)}
                >
                  <CogIcon />
                  {hasPermission(
                    [Permission.MANAGE_ISSUES, Permission.VIEW_ISSUES],
                    { type: 'or' }
                  ) &&
                    openIssues.length > 0 && (
                      <>
                        <span className="absolute -right-0.5 -top-0.5 h-3 w-3 rounded-full bg-red-600" />
                        <span className="absolute -right-0.5 -top-0.5 h-3 w-3 animate-ping rounded-full bg-red-600" />
                      </>
                    )}
                </Button>
              </Tooltip>
            )}
        </div>

        <RatingsStrip items={ratings} />
      </TitleHero>

      <div className="px-4 lg:px-10">
        <section className="grid items-start gap-6 pt-7 lg:grid-cols-[minmax(0,1fr)_340px]">
          <div className="flex min-w-0 flex-col gap-6">
            {crewGroups.length > 0 && (
              <Card title={intl.formatMessage(messages.crew)}>
                <CrewGrid groups={crewGroups} />
                <Link
                  href={`/movie/${data.id}/crew`}
                  className="text-sm font-semibold text-as-accent hover:text-as-accent-soft"
                >
                  {intl.formatMessage(messages.viewfullcrew)}
                </Link>
              </Card>
            )}
            {data.keywords.length > 0 && (
              <Card title={intl.formatMessage(messages.keywords)}>
                <ChipLinks
                  items={data.keywords.map((keyword) => ({
                    key: `keyword-${keyword.id}`,
                    href: `/discover/movies?keywords=${keyword.id}`,
                    label: keyword.name,
                  }))}
                />
              </Card>
            )}
            {data.mediaInfo && isAvailable && (
              <SubtitlesPanel mediaId={data.mediaInfo.id} mediaType="movie" />
            )}
            {data.mediaInfo && isAvailable && (
              <FileInfoCard mediaId={data.mediaInfo.id} mediaType="movie" />
            )}
            {streamingProviders.length > 0 && (
              <Card title={intl.formatMessage(messages.wheretowatch)}>
                <div className="flex flex-wrap items-center gap-3.5">
                  {streamingProviders.map((p) => (
                    <Tooltip content={p.name} key={`provider-${p.id}`}>
                      <span className="block">
                        <CachedImage
                          type="tmdb"
                          src={'https://image.tmdb.org/t/p/w92/' + p.logoPath}
                          alt={p.name}
                          width={44}
                          height={44}
                          className="rounded-[10px]"
                        />
                      </span>
                    </Tooltip>
                  ))}
                </div>
              </Card>
            )}
          </div>

          <div className="flex min-w-0 flex-col gap-6">
            {data.collection && (
              <CollectionBanner
                href={`/collection/${data.collection.id}`}
                name={data.collection.name}
                backdropPath={data.collection.backdropPath}
                viewLabel={intl.formatMessage(globalMessages.view)}
              />
            )}
            <Card title={intl.formatMessage(messages.details)}>
              <div>
                {data.originalTitle &&
                  data.originalLanguage !== locale.slice(0, 2) && (
                    <DetailRow
                      label={intl.formatMessage(messages.originaltitle)}
                    >
                      {data.originalTitle}
                    </DetailRow>
                  )}
                <DetailRow label={intl.formatMessage(globalMessages.status)}>
                  {data.status}
                </DetailRow>
                {filteredReleases && filteredReleases.length > 0 ? (
                  <DetailRow
                    label={intl.formatMessage(messages.releasedate, {
                      releaseCount: filteredReleases.length,
                    })}
                  >
                    {filteredReleases.map((r, i) => (
                      <span
                        className="flex items-center gap-2"
                        key={`release-date-${i}`}
                      >
                        {r.type === 3 ? (
                          <Tooltip
                            content={intl.formatMessage(
                              messages.theatricalrelease
                            )}
                          >
                            <TicketIcon className="h-4 w-4 text-as-ink-faint" />
                          </Tooltip>
                        ) : r.type === 4 ? (
                          <Tooltip
                            content={intl.formatMessage(
                              messages.digitalrelease
                            )}
                          >
                            <CloudIcon className="h-4 w-4 text-as-ink-faint" />
                          </Tooltip>
                        ) : (
                          <Tooltip
                            content={intl.formatMessage(
                              messages.physicalrelease
                            )}
                          >
                            <svg
                              className="h-4 w-4 text-as-ink-faint"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                            >
                              <circle cx="12" cy="12" r="9" />
                              <circle cx="12" cy="12" r="2.5" />
                            </svg>
                          </Tooltip>
                        )}
                        {intl.formatDate(r.release_date, {
                          year: 'numeric',
                          month: 'short',
                          day: 'numeric',
                          timeZone: 'UTC',
                        })}
                      </span>
                    ))}
                  </DetailRow>
                ) : (
                  data.releaseDate && (
                    <DetailRow
                      label={intl.formatMessage(messages.releasedate, {
                        releaseCount: 1,
                      })}
                    >
                      {intl.formatDate(data.releaseDate, {
                        year: 'numeric',
                        month: 'short',
                        day: 'numeric',
                        timeZone: 'UTC',
                      })}
                    </DetailRow>
                  )
                )}
                {data.revenue > 0 && (
                  <DetailRow label={intl.formatMessage(messages.revenue)}>
                    {intl.formatNumber(data.revenue, {
                      currency: 'USD',
                      style: 'currency',
                      maximumFractionDigits: 0,
                    })}
                  </DetailRow>
                )}
                {data.budget > 0 && (
                  <DetailRow label={intl.formatMessage(messages.budget)}>
                    {intl.formatNumber(data.budget, {
                      currency: 'USD',
                      style: 'currency',
                      maximumFractionDigits: 0,
                    })}
                  </DetailRow>
                )}
                {data.originalLanguage && (
                  <DetailRow
                    label={intl.formatMessage(messages.originallanguage)}
                  >
                    <Link
                      href={`/discover/movies/language/${data.originalLanguage}`}
                      className="hover:text-as-ink hover:underline"
                    >
                      {intl.formatDisplayName(data.originalLanguage, {
                        type: 'language',
                        fallback: 'none',
                      }) ??
                        data.spokenLanguages.find(
                          (lng) => lng.iso_639_1 === data.originalLanguage
                        )?.name}
                    </Link>
                  </DetailRow>
                )}
                {data.productionCountries.length > 0 && (
                  <DetailRow
                    label={intl.formatMessage(messages.productioncountries, {
                      countryCount: data.productionCountries.length,
                    })}
                  >
                    {data.productionCountries.map((c) => (
                      <span
                        className="flex items-center whitespace-nowrap"
                        key={`prodcountry-${c.iso_3166_1}`}
                      >
                        {countries.includes(c.iso_3166_1) && (
                          <span
                            className={`mr-1.5 text-xs leading-5 flag:${c.iso_3166_1}`}
                          />
                        )}
                        {intl.formatDisplayName(c.iso_3166_1, {
                          type: 'region',
                          fallback: 'none',
                        }) ?? c.name}
                      </span>
                    ))}
                  </DetailRow>
                )}
                {data.productionCompanies.length > 0 && (
                  <DetailRow
                    label={intl.formatMessage(messages.studio, {
                      studioCount: data.productionCompanies.length,
                    })}
                  >
                    {data.productionCompanies
                      .slice(
                        0,
                        showAllStudios || showMoreStudios
                          ? data.productionCompanies.length
                          : minStudios
                      )
                      .map((s) => (
                        <Link
                          href={`/discover/movies/studio/${s.id}`}
                          key={`studio-${s.id}`}
                          className="hover:text-as-ink hover:underline"
                        >
                          {s.name}
                        </Link>
                      ))}
                    {!showAllStudios && (
                      <button
                        type="button"
                        className="flex items-center text-sm text-as-ink-faint hover:text-as-ink"
                        onClick={() => setShowMoreStudios(!showMoreStudios)}
                      >
                        {intl.formatMessage(
                          !showMoreStudios
                            ? messages.showmore
                            : messages.showless
                        )}
                        {!showMoreStudios ? (
                          <ChevronDoubleDownIcon className="ml-1 h-4 w-4" />
                        ) : (
                          <ChevronDoubleUpIcon className="ml-1 h-4 w-4" />
                        )}
                      </button>
                    )}
                  </DetailRow>
                )}
              </div>
              <LinkChips links={externalLinks} />
            </Card>
          </div>
        </section>

        {data.credits.cast.length > 0 && (
          <section className="flex flex-col gap-4 pt-[34px]">
            <RailHeader
              title={intl.formatMessage(messages.cast)}
              href={`/movie/${data.id}/cast`}
              seeAllLabel={intl.formatMessage(messages.seeall)}
            />
            <CastRail
              people={data.credits.cast.slice(0, 20).map((person) => ({
                id: person.id,
                name: person.name,
                character: person.character,
                profilePath: person.profilePath,
              }))}
            />
          </section>
        )}
        <PosterRail
          title={intl.formatMessage(messages.recommendations)}
          url={`/api/v1/movie/${router.query.movieId}/recommendations`}
          linkUrl={`/movie/${data.id}/recommendations`}
          seeAllLabel={intl.formatMessage(messages.seeall)}
        />
        <PosterRail
          title={intl.formatMessage(messages.similar)}
          url={`/api/v1/movie/${router.query.movieId}/similar`}
          linkUrl={`/movie/${data.id}/similar`}
          seeAllLabel={intl.formatMessage(messages.seeall)}
        />
      </div>
    </div>
  );
};

export default MovieDetails;
