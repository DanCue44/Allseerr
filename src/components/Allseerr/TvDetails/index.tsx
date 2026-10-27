import RTAudFresh from '@app/assets/rt_aud_fresh.svg';
import RTAudRotten from '@app/assets/rt_aud_rotten.svg';
import RTFresh from '@app/assets/rt_fresh.svg';
import RTRotten from '@app/assets/rt_rotten.svg';
import EmbyLogo from '@app/assets/services/emby.svg';
import ImdbLogo from '@app/assets/services/imdb.svg';
import JellyfinLogo from '@app/assets/services/jellyfin.svg';
import PlexLogo from '@app/assets/services/plex.svg';
import SimklLogo from '@app/assets/services/simkl.svg';
import TraktLogo from '@app/assets/services/trakt.svg';
import TvdbLogo from '@app/assets/services/tvdb.svg';
import Spinner from '@app/assets/spinner.svg';
import TmdbLogo from '@app/assets/tmdb_logo.svg';
import FileInfoCard from '@app/components/Allseerr/MediaFiles';
import SubtitlesPanel from '@app/components/Allseerr/SubtitlesPanel';
import type { CrewGroup, RatingItem } from '@app/components/Allseerr/Title';
import {
  Card,
  CastRail,
  ChipLinks,
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
import SeasonEpisodes from '@app/components/Allseerr/TvDetails/SeasonEpisodes';
import BlocklistModal from '@app/components/BlocklistModal';
import Badge from '@app/components/Common/Badge';
import Button from '@app/components/Common/Button';
import CachedImage from '@app/components/Common/CachedImage';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import type { PlayButtonLink } from '@app/components/Common/PlayButton';
import StatusBadgeMini from '@app/components/Common/StatusBadgeMini';
import Tooltip from '@app/components/Common/Tooltip';
import FavoriteButton from '@app/components/FavoriteButton';
import IssueModal from '@app/components/IssueModal';
import ManageSlideOver from '@app/components/ManageSlideOver';
import RemovalRequestButton from '@app/components/RemovalRequestButton';
import RequestButton from '@app/components/RequestButton';
import RequestModal from '@app/components/RequestModal';
import SeasonRolloverNotice from '@app/components/SeasonRolloverNotice';
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
  Disclosure,
  DisclosureButton,
  DisclosurePanel,
  Transition,
} from '@headlessui/react';
import { ChevronDownIcon } from '@heroicons/react/24/outline';
import {
  CogIcon,
  ExclamationTriangleIcon,
  EyeIcon,
  EyeSlashIcon,
  FilmIcon,
  MinusCircleIcon,
  PlayIcon,
} from '@heroicons/react/24/solid';
import type { RTRating } from '@server/api/rating/rottentomatoes';
import { ANIME_KEYWORD_ID } from '@server/api/themoviedb/constants';
import { IssueStatus } from '@server/constants/issue';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { MediaServerType } from '@server/constants/server';
import { getTvContentRating } from '@server/lib/contentRatingLimit';
import type { TvDetails as TvDetailsType } from '@server/models/Tv';
import type { Crew } from '@server/models/common';
import axios from 'axios';
import { countries } from 'country-flag-icons';
import 'country-flag-icons/3x2/flags.css';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.Allseerr.TvDetails', {
  firstAirDate: 'First Air Date',
  nextAirDate: 'Next Air Date',
  originallanguage: 'Original Language',
  overview: 'Overview',
  cast: 'Cast',
  recommendations: 'Recommendations',
  similar: 'Similar Series',
  watchtrailer: 'Watch Trailer',
  overviewunavailable: 'Overview unavailable.',
  originaltitle: 'Original Title',
  showtype: 'Series Type',
  anime: 'Anime',
  network: '{networkCount, plural, one {Network} other {Networks}}',
  viewfullcrew: 'View Full Crew',
  play: 'Play on {mediaServerName}',
  play4k: 'Play 4K on {mediaServerName}',
  seasons: '{seasonCount, plural, one {# Season} other {# Seasons}}',
  episodeRuntime: 'Episode Runtime',
  episodeRuntimeMinutes: '{runtime} minutes',
  productioncountries:
    'Production {countryCount, plural, one {Country} other {Countries}}',
  reportissue: 'Report an Issue',
  manageseries: 'Manage Series',
  seasonstitle: 'Seasons',
  episodeCount: '{episodeCount, plural, one {# Episode} other {# Episodes}}',
  seasonnumber: 'Season {seasonNumber}',
  status4k: '4K {status}',
  rtcriticsscore: 'Rotten Tomatoes Tomatometer',
  rtaudiencescore: 'Rotten Tomatoes Audience Score',
  tmdbuserscore: 'TMDB User Score',
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
  seeall: 'See all',
  watchlist: 'Watchlist',
  onwatchlist: 'On watchlist',
  tomatometer: 'Tomatometer',
  audience: 'Audience',
  rottentomatoes: 'Rotten Tomatoes',
  userscore: 'User score',
  requestedby: 'Requested by {user} on {date}',
});

interface TvDetailsProps {
  tv?: TvDetailsType;
}

const TvDetails = ({ tv }: TvDetailsProps) => {
  const settings = useSettings();
  const { user, hasPermission } = useUser();
  const router = useRouter();
  const intl = useIntl();
  const { locale } = useLocale();
  const [showRequestModal, setShowRequestModal] = useState(false);
  const [showManager, setShowManager] = useState(false);
  const [showIssueModal, setShowIssueModal] = useState(false);
  const [isUpdating, setIsUpdating] = useState<boolean>(false);
  const [toggleWatchlist, setToggleWatchlist] = useState<boolean>(
    !tv?.onUserWatchlist
  );
  const [isBlocklistUpdating, setIsBlocklistUpdating] =
    useState<boolean>(false);
  const [showBlocklistModal, setShowBlocklistModal] = useState(false);
  const { addToast } = useToasts();

  const {
    data,
    error,
    mutate: revalidate,
  } = useSWR<TvDetailsType>(`/api/v1/tv/${router.query.tvId}`, {
    fallbackData: tv,
    refreshInterval: refreshIntervalHelper(
      {
        downloadStatus: tv?.mediaInfo?.downloadStatus,
        downloadStatus4k: tv?.mediaInfo?.downloadStatus4k,
      },
      15000
    ),
  });

  const { data: ratingData } = useSWR<RTRating>(
    `/api/v1/tv/${router.query.tvId}/ratings`
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
        query: { tvId: router.query.tvId },
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

  const mediaLinks: PlayButtonLink[] = [];

  if (
    plexUrl &&
    hasPermission([Permission.REQUEST, Permission.REQUEST_TV], {
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
    settings.currentSettings.series4kEnabled &&
    plexUrl4k &&
    hasPermission([Permission.REQUEST_4K, Permission.REQUEST_4K_TV], {
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

  const contentRating = data.contentRatings.results.find(
    (r) => r.iso_3166_1 === discoverRegion
  )?.rating;

  // Does NOT include "Specials"
  const seasonCount = data.seasons.filter(
    (season) => season.seasonNumber !== 0 && season.episodeCount !== 0
  ).length;

  const getAllRequestedSeasons = (is4k: boolean): number[] => {
    const requestedSeasons = (data?.mediaInfo?.requests ?? [])
      .filter(
        (request) =>
          request.is4k === is4k &&
          request.status !== MediaRequestStatus.DECLINED &&
          request.status !== MediaRequestStatus.COMPLETED
      )
      .reduce((requestedSeasons, request) => {
        return [
          ...requestedSeasons,
          ...request.seasons.map((sr) => sr.seasonNumber),
        ];
      }, [] as number[]);

    const availableSeasons = (data?.mediaInfo?.seasons ?? [])
      .filter(
        (season) =>
          (season[is4k ? 'status4k' : 'status'] === MediaStatus.AVAILABLE ||
            season[is4k ? 'status4k' : 'status'] ===
              MediaStatus.PARTIALLY_AVAILABLE ||
            season[is4k ? 'status4k' : 'status'] === MediaStatus.PROCESSING) &&
          !requestedSeasons.includes(season.seasonNumber)
      )
      .map((season) => season.seasonNumber);

    return [...requestedSeasons, ...availableSeasons];
  };

  // Mirrors the season list the request modal offers, so the two agree.
  const requestableSeasons = data.seasons
    .filter(
      (season) =>
        season.episodeCount !== 0 &&
        (settings.currentSettings.enableSpecialEpisodes ||
          season.seasonNumber !== 0)
    )
    .map((season) => season.seasonNumber);

  const isSeasonSetComplete = (is4k: boolean) => {
    const requested = getAllRequestedSeasons(is4k);
    return requestableSeasons.every((seasonNumber) =>
      requested.includes(seasonNumber)
    );
  };

  const isComplete = isSeasonSetComplete(false);

  const is4kComplete = isSeasonSetComplete(true);

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

    return intl.formatMessage(messages.play, { mediaServerName: 'Jellyfin' });
  }

  const onClickWatchlistBtn = async (): Promise<void> => {
    setIsUpdating(true);

    try {
      await axios.post('/api/v1/watchlist', {
        tmdbId: tv?.id,
        mediaType: MediaType.TV,
        title: tv?.name,
      });
      addToast(
        <span>
          {intl.formatMessage(messages.watchlistSuccess, {
            title: tv?.name,
            strong: (msg: React.ReactNode) => <strong>{msg}</strong>,
          })}
        </span>,
        { appearance: 'success', autoDismiss: true }
      );

      setIsUpdating(false);
      setToggleWatchlist((prevState) => !prevState);
    } catch {
      addToast(intl.formatMessage(messages.watchlistError), {
        appearance: 'error',
        autoDismiss: true,
      });

      setIsUpdating(false);
    }
  };

  const onClickDeleteWatchlistBtn = async (): Promise<void> => {
    setIsUpdating(true);

    try {
      await axios.delete(
        `/api/v1/watchlist/${tv?.id}?mediaType=${MediaType.TV}`
      );

      addToast(
        <span>
          {intl.formatMessage(messages.watchlistDeleted, {
            title: tv?.name,
            strong: (msg: React.ReactNode) => <strong>{msg}</strong>,
          })}
        </span>,
        { appearance: 'info', autoDismiss: true }
      );

      setIsUpdating(false);
      setToggleWatchlist((prevState) => !prevState);
    } catch {
      addToast(intl.formatMessage(messages.watchlistError), {
        appearance: 'error',
        autoDismiss: true,
      });

      setIsUpdating(false);
    }
  };

  const onClickHideItemBtn = async (): Promise<void> => {
    setIsBlocklistUpdating(true);

    try {
      const res = await axios.post('/api/v1/blocklist', {
        tmdbId: tv?.id,
        mediaType: 'tv',
        title: tv?.name,
        user: user?.id,
      });

      if (res.status === 201) {
        addToast(
          <span>
            {intl.formatMessage(globalMessages.blocklistSuccess, {
              title: tv?.name,
              strong: (msg: React.ReactNode) => <strong>{msg}</strong>,
            })}
          </span>,
          { appearance: 'success', autoDismiss: true }
        );

        revalidate();
      }
    } catch (e) {
      if (e?.response?.status === 412) {
        addToast(
          <span>
            {intl.formatMessage(globalMessages.blocklistDuplicateError, {
              title: tv?.name,
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
    settings.currentSettings.series4kEnabled &&
    hasPermission(
      [
        Permission.MANAGE_REQUESTS,
        Permission.REQUEST_4K,
        Permission.REQUEST_4K_TV,
      ],
      { type: 'or' }
    );

  const latestRequest = (data.mediaInfo?.requests ?? [])
    .filter((request) => request.requestedBy)
    .sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    )[0];

  const ratings: RatingItem[] = [];
  if (ratingData?.criticsRating && !!ratingData?.criticsScore) {
    ratings.push({
      key: 'rt-critics',
      label: intl.formatMessage(messages.tomatometer),
      value: `${ratingData.criticsScore}%`,
      caption: intl.formatMessage(messages.rottentomatoes),
      href: ratingData.url,
      tooltip: intl.formatMessage(messages.rtcriticsscore),
      icon: ratingData.criticsRating === 'Rotten' ? <RTRotten /> : <RTFresh />,
    });
  }
  if (ratingData?.audienceRating && !!ratingData?.audienceScore) {
    ratings.push({
      key: 'rt-audience',
      label: intl.formatMessage(messages.audience),
      value: `${ratingData.audienceScore}%`,
      caption: intl.formatMessage(messages.rottentomatoes),
      href: ratingData.url,
      tooltip: intl.formatMessage(messages.rtaudiencescore),
      icon:
        ratingData.audienceRating === 'Spilled' ? (
          <RTAudRotten />
        ) : (
          <RTAudFresh />
        ),
    });
  }
  if (data.voteCount) {
    ratings.push({
      key: 'tmdb',
      label: 'TMDB',
      value: `${Math.round(data.voteAverage * 10)}%`,
      caption: intl.formatMessage(messages.userscore),
      icon: <TmdbLogo />,
      href: `https://www.themoviedb.org/tv/${data.id}?language=${locale}`,
      tooltip: intl.formatMessage(messages.tmdbuserscore),
    });
  }

  // Creators first, then the crew grouped by job in priority order
  const crewGroups: CrewGroup[] = [];
  [
    ...data.createdBy.map(
      (person): Partial<Crew> => ({
        id: person.id,
        job: 'Creator',
        name: person.name,
      })
    ),
    ...sortedCrew,
  ].forEach((person) => {
    const group = crewGroups.find((g) => g.job === person.job);
    if (group) {
      if (
        group.people.length < 3 &&
        !group.people.some((p) => p.id === person.id)
      ) {
        group.people.push(person);
      }
    } else if (crewGroups.length < 7 && person.job) {
      crewGroups.push({ job: person.job, people: [person] });
    }
  });

  const mediaServerName =
    settings.currentSettings.mediaServerType === MediaServerType.PLEX
      ? 'Plex'
      : settings.currentSettings.mediaServerType === MediaServerType.EMBY
        ? 'Emby'
        : 'Jellyfin';
  const mediaUrl = plexUrl ?? plexUrl4k;

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
      href: `https://www.themoviedb.org/tv/${data.id}?language=${locale}`,
      label: 'TMDB',
      icon: <TmdbLogo />,
    },
    ...(data.externalIds.tvdbId
      ? [
          {
            key: 'tvdb',
            href: `http://www.thetvdb.com/?tab=series&id=${data.externalIds.tvdbId}`,
            label: 'TheTVDB',
            icon: <TvdbLogo />,
          },
        ]
      : []),
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
    ...(ratingData?.url
      ? [
          {
            key: 'rt',
            href: ratingData.url,
            label: 'Rotten Tomatoes',
            icon: <RTFresh />,
          },
        ]
      : []),
    ...(data.externalIds.imdbId
      ? [
          {
            key: 'trakt',
            href: `https://trakt.tv/shows/${data.externalIds.imdbId}`,
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
  ];

  const openIssues = (data.mediaInfo?.issues ?? []).filter(
    (issue) => issue.status === IssueStatus.OPEN
  );

  const dateFormat = {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  } as const;

  return (
    <div className="relative -mx-4 -mt-20 pb-10 lg:-mt-28">
      <PageTitle title={data.name} />
      <BlocklistModal
        tmdbId={data.id}
        type="tv"
        show={showBlocklistModal}
        onCancel={closeBlocklistModal}
        onComplete={onClickHideItemBtn}
        isUpdating={isBlocklistUpdating}
      />
      <IssueModal
        onCancel={() => setShowIssueModal(false)}
        show={showIssueModal}
        mediaType="tv"
        tmdbId={data.id}
      />
      <RequestModal
        tmdbId={data.id}
        show={showRequestModal}
        type="tv"
        onComplete={() => {
          revalidate();
          setShowRequestModal(false);
        }}
        onCancel={() => setShowRequestModal(false)}
      />
      <ManageSlideOver
        data={data}
        mediaType="tv"
        onClose={() => {
          setShowManager(false);
          router.replace({
            pathname: router.pathname,
            query: { tvId: router.query.tvId },
          });
        }}
        revalidate={() => revalidate()}
        show={showManager}
      />

      <TitleHero
        backdropPath={data.backdropPath}
        posterPath={data.posterPath}
        posterAlt={data.name}
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
          {data.name}{' '}
          {data.firstAirDate && (
            <span className="font-medium text-as-ink-faint">
              ({data.firstAirDate.slice(0, 4)})
            </span>
          )}
        </h1>

        <div className="flex flex-wrap items-center gap-3 text-as-ink-muted">
          {contentRating && (
            <span className="rounded-md border border-as-line-strong px-2 py-0.5 text-[13px] font-bold">
              {contentRating}
            </span>
          )}
          {seasonCount > 0 && (
            <span>{intl.formatMessage(messages.seasons, { seasonCount })}</span>
          )}
          {(contentRating || seasonCount > 0) && data.genres.length > 0 && (
            <span>·</span>
          )}
          {data.genres.map((genre) => (
            <Link
              key={`genre-${genre.id}`}
              href={`/discover/tv?genre=${genre.id}`}
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
                i === 0 && plexUrl ? pillPrimary : pillSecondary
              }`}
            >
              {link.svg}
              <span>{link.text}</span>
            </a>
          ))}
          <RequestButton
            mediaType="tv"
            onUpdate={() => revalidate()}
            tmdbId={data?.id}
            media={data?.mediaInfo}
            isShowComplete={isComplete}
            is4kShowComplete={is4kComplete}
            watchProviders={data?.watchProviders}
            contentRating={getTvContentRating(data.contentRatings)}
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
            media={data?.mediaInfo}
            title={data.name}
            onUpdate={() => revalidate()}
            className={pillIcon}
          />
          <FavoriteButton
            tmdbId={data.id}
            mediaType="tv"
            title={data.name}
            className={pillIcon}
          />
          <RemovalRequestButton
            media={data?.mediaInfo}
            title={data.name}
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
            data.mediaInfo?.status === MediaStatus.PARTIALLY_AVAILABLE ||
            (settings.currentSettings.series4kEnabled &&
              hasPermission([Permission.REQUEST_4K, Permission.REQUEST_4K_TV], {
                type: 'or',
              }) &&
              (data.mediaInfo?.status4k === MediaStatus.AVAILABLE ||
                data?.mediaInfo?.status4k ===
                  MediaStatus.PARTIALLY_AVAILABLE))) &&
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
          {hasPermission(Permission.MANAGE_REQUESTS) && data.mediaInfo && (
            <Tooltip content={intl.formatMessage(messages.manageseries)}>
              <Button
                className={`relative ${pillIcon}`}
                onClick={() => setShowManager(true)}
                aria-label={intl.formatMessage(messages.manageseries)}
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
            <SeasonRolloverNotice
              media={data.mediaInfo}
              onUpdate={revalidate}
              ambient
            />
            <Card title={intl.formatMessage(messages.seasonstitle)}>
              <div className="flex w-full flex-col space-y-2">
                {data.seasons
                  .slice()
                  .reverse()
                  .filter(
                    (season) =>
                      settings.currentSettings.enableSpecialEpisodes ||
                      season.seasonNumber !== 0
                  )
                  .map((season) => {
                    const show4k =
                      settings.currentSettings.series4kEnabled &&
                      hasPermission(
                        [
                          Permission.MANAGE_REQUESTS,
                          Permission.REQUEST_4K,
                          Permission.REQUEST_4K_TV,
                        ],
                        {
                          type: 'or',
                        }
                      );
                    const mSeason = (data.mediaInfo?.seasons ?? []).find(
                      (s) =>
                        season.seasonNumber === s.seasonNumber &&
                        s.status !== MediaStatus.UNKNOWN
                    );
                    const mSeason4k = (data.mediaInfo?.seasons ?? []).find(
                      (s) =>
                        season.seasonNumber === s.seasonNumber &&
                        s.status4k !== MediaStatus.UNKNOWN
                    );
                    const request = (data.mediaInfo?.requests ?? [])
                      .filter(
                        (r) =>
                          !!r.seasons.find(
                            (s) => s.seasonNumber === season.seasonNumber
                          ) && !r.is4k
                      )
                      .sort(
                        (a, b) =>
                          new Date(b.createdAt).getTime() -
                          new Date(a.createdAt).getTime()
                      )[0];
                    const request4k = (data.mediaInfo?.requests ?? [])
                      .filter(
                        (r) =>
                          !!r.seasons.find(
                            (s) => s.seasonNumber === season.seasonNumber
                          ) && r.is4k
                      )
                      .sort(
                        (a, b) =>
                          new Date(b.createdAt).getTime() -
                          new Date(a.createdAt).getTime()
                      )[0];

                    if (season.episodeCount === 0) {
                      return null;
                    }

                    return (
                      <Disclosure
                        key={`season-discoslure-${season.seasonNumber}`}
                      >
                        {({ open }) => (
                          <>
                            <DisclosureButton
                              className={`mt-2 flex w-full items-center justify-between space-x-2 border-as-line bg-as-tile px-4 py-3 text-as-ink ${
                                open
                                  ? 'rounded-t-2xl border-l border-r border-t'
                                  : 'rounded-2xl border'
                              }`}
                            >
                              <div className="flex flex-1 items-center space-x-2 font-semibold">
                                <span>
                                  {season.seasonNumber === 0
                                    ? intl.formatMessage(
                                        globalMessages.specials
                                      )
                                    : intl.formatMessage(
                                        messages.seasonnumber,
                                        {
                                          seasonNumber: season.seasonNumber,
                                        }
                                      )}
                                </span>
                                <Badge badgeType="dark">
                                  {intl.formatMessage(messages.episodeCount, {
                                    episodeCount: season.episodeCount,
                                  })}
                                </Badge>
                              </div>
                              {((!mSeason &&
                                request?.status ===
                                  MediaRequestStatus.APPROVED) ||
                                mSeason?.status === MediaStatus.PROCESSING ||
                                (request?.status ===
                                  MediaRequestStatus.APPROVED &&
                                  mSeason?.status === MediaStatus.DELETED)) && (
                                <>
                                  <div className="hidden md:flex">
                                    <Badge badgeType="primary">
                                      {intl.formatMessage(
                                        globalMessages.requested
                                      )}
                                    </Badge>
                                  </div>
                                  <div className="flex md:hidden">
                                    <StatusBadgeMini
                                      status={MediaStatus.PROCESSING}
                                    />
                                  </div>
                                </>
                              )}
                              {((!mSeason &&
                                request?.status ===
                                  MediaRequestStatus.PENDING) ||
                                mSeason?.status === MediaStatus.PENDING) && (
                                <>
                                  <div className="hidden md:flex">
                                    <Badge badgeType="warning">
                                      {intl.formatMessage(
                                        globalMessages.pending
                                      )}
                                    </Badge>
                                  </div>
                                  <div className="flex md:hidden">
                                    <StatusBadgeMini
                                      status={MediaStatus.PENDING}
                                    />
                                  </div>
                                </>
                              )}
                              {mSeason?.status ===
                                MediaStatus.PARTIALLY_AVAILABLE && (
                                <>
                                  <div className="hidden md:flex">
                                    <Badge badgeType="success">
                                      {intl.formatMessage(
                                        globalMessages.partiallyavailable
                                      )}
                                    </Badge>
                                  </div>
                                  <div className="flex md:hidden">
                                    <StatusBadgeMini
                                      status={MediaStatus.PARTIALLY_AVAILABLE}
                                    />
                                  </div>
                                </>
                              )}
                              {mSeason?.status === MediaStatus.AVAILABLE && (
                                <>
                                  <div className="hidden md:flex">
                                    <Badge badgeType="success">
                                      {intl.formatMessage(
                                        globalMessages.available
                                      )}
                                    </Badge>
                                  </div>
                                  <div className="flex md:hidden">
                                    <StatusBadgeMini
                                      status={MediaStatus.AVAILABLE}
                                    />
                                  </div>
                                </>
                              )}
                              {mSeason?.status === MediaStatus.DELETED &&
                                request?.status !==
                                  MediaRequestStatus.APPROVED && (
                                  <>
                                    <div className="hidden md:flex">
                                      <Badge badgeType="danger">
                                        {intl.formatMessage(
                                          globalMessages.deleted
                                        )}
                                      </Badge>
                                    </div>
                                    <div className="flex md:hidden">
                                      <StatusBadgeMini
                                        status={MediaStatus.DELETED}
                                      />
                                    </div>
                                  </>
                                )}
                              {((!mSeason4k &&
                                request4k?.status ===
                                  MediaRequestStatus.APPROVED) ||
                                mSeason4k?.status4k ===
                                  MediaStatus.PROCESSING ||
                                (request4k?.status ===
                                  MediaRequestStatus.APPROVED &&
                                  mSeason4k?.status4k ===
                                    MediaStatus.DELETED)) &&
                                show4k && (
                                  <>
                                    <div className="hidden md:flex">
                                      <Badge badgeType="primary">
                                        {intl.formatMessage(messages.status4k, {
                                          status: intl.formatMessage(
                                            globalMessages.requested
                                          ),
                                        })}
                                      </Badge>
                                    </div>
                                    <div className="flex md:hidden">
                                      <StatusBadgeMini
                                        status={MediaStatus.PROCESSING}
                                        is4k={true}
                                      />
                                    </div>
                                  </>
                                )}
                              {((!mSeason4k &&
                                request4k?.status ===
                                  MediaRequestStatus.PENDING) ||
                                mSeason?.status4k === MediaStatus.PENDING) &&
                                show4k && (
                                  <>
                                    <div className="hidden md:flex">
                                      <Badge badgeType="warning">
                                        {intl.formatMessage(messages.status4k, {
                                          status: intl.formatMessage(
                                            globalMessages.pending
                                          ),
                                        })}
                                      </Badge>
                                    </div>
                                    <div className="flex md:hidden">
                                      <StatusBadgeMini
                                        status={MediaStatus.PENDING}
                                        is4k={true}
                                      />
                                    </div>
                                  </>
                                )}
                              {mSeason4k?.status4k ===
                                MediaStatus.PARTIALLY_AVAILABLE &&
                                show4k && (
                                  <>
                                    <div className="hidden md:flex">
                                      <Badge badgeType="success">
                                        {intl.formatMessage(messages.status4k, {
                                          status: intl.formatMessage(
                                            globalMessages.partiallyavailable
                                          ),
                                        })}
                                      </Badge>
                                    </div>
                                    <div className="flex md:hidden">
                                      <StatusBadgeMini
                                        status={MediaStatus.PARTIALLY_AVAILABLE}
                                        is4k={true}
                                      />
                                    </div>
                                  </>
                                )}
                              {mSeason4k?.status4k === MediaStatus.AVAILABLE &&
                                show4k && (
                                  <>
                                    <div className="hidden md:flex">
                                      <Badge badgeType="success">
                                        {intl.formatMessage(messages.status4k, {
                                          status: intl.formatMessage(
                                            globalMessages.available
                                          ),
                                        })}
                                      </Badge>
                                    </div>
                                    <div className="flex md:hidden">
                                      <StatusBadgeMini
                                        status={MediaStatus.AVAILABLE}
                                        is4k={true}
                                      />
                                    </div>
                                  </>
                                )}
                              {mSeason4k?.status4k === MediaStatus.DELETED &&
                                request4k?.status !==
                                  MediaRequestStatus.APPROVED &&
                                show4k && (
                                  <>
                                    <div className="hidden md:flex">
                                      <Badge badgeType="danger">
                                        {intl.formatMessage(messages.status4k, {
                                          status: intl.formatMessage(
                                            globalMessages.deleted
                                          ),
                                        })}
                                      </Badge>
                                    </div>
                                    <div className="flex md:hidden">
                                      <StatusBadgeMini
                                        status={MediaStatus.DELETED}
                                        is4k={true}
                                      />
                                    </div>
                                  </>
                                )}
                              <ChevronDownIcon
                                className={`${
                                  open ? 'rotate-180' : ''
                                } h-6 w-6 text-as-ink-faint`}
                              />
                            </DisclosureButton>
                            <Transition
                              as="div"
                              show={open}
                              enter="transition-opacity duration-100 ease-out"
                              enterFrom="opacity-0"
                              enterTo="opacity-100"
                              leave="transition-opacity duration-75 ease-out"
                              leaveFrom="opacity-100"
                              leaveTo="opacity-0"
                              // Not sure why this transition is adding a margin without this here
                              style={{ margin: '0px' }}
                            >
                              <DisclosurePanel className="w-full rounded-b-2xl border-b border-l border-r border-as-line bg-as-tile/50 px-4 pb-2">
                                <SeasonEpisodes
                                  tvId={data.id}
                                  seasonNumber={season.seasonNumber}
                                />
                              </DisclosurePanel>
                            </Transition>
                          </>
                        )}
                      </Disclosure>
                    );
                  })}
              </div>
            </Card>
            {crewGroups.length > 0 && (
              <Card title={intl.formatMessage(messages.crew)}>
                <CrewGrid groups={crewGroups} />
                <Link
                  href={`/tv/${data.id}/crew`}
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
                    href: `/discover/tv?keywords=${keyword.id}`,
                    label: keyword.name,
                  }))}
                />
              </Card>
            )}
            {data.mediaInfo && isAvailable && (
              <SubtitlesPanel mediaId={data.mediaInfo.id} mediaType="tv" />
            )}
            {data.mediaInfo && isAvailable && (
              <FileInfoCard mediaId={data.mediaInfo.id} mediaType="tv" />
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
            <Card title={intl.formatMessage(messages.details)}>
              <div>
                {data.originalName &&
                  data.originalLanguage !== locale.slice(0, 2) && (
                    <DetailRow
                      label={intl.formatMessage(messages.originaltitle)}
                    >
                      {data.originalName}
                    </DetailRow>
                  )}
                {data.keywords.some(
                  (keyword) => keyword.id === ANIME_KEYWORD_ID
                ) && (
                  <DetailRow label={intl.formatMessage(messages.showtype)}>
                    {intl.formatMessage(messages.anime)}
                  </DetailRow>
                )}
                <DetailRow label={intl.formatMessage(globalMessages.status)}>
                  {data.status}
                </DetailRow>
                {data.firstAirDate && (
                  <DetailRow label={intl.formatMessage(messages.firstAirDate)}>
                    {intl.formatDate(data.firstAirDate, dateFormat)}
                  </DetailRow>
                )}
                {data.nextEpisodeToAir &&
                  data.nextEpisodeToAir.airDate &&
                  data.nextEpisodeToAir.airDate !== data.firstAirDate && (
                    <DetailRow label={intl.formatMessage(messages.nextAirDate)}>
                      {intl.formatDate(
                        data.nextEpisodeToAir.airDate,
                        dateFormat
                      )}
                    </DetailRow>
                  )}
                {data.episodeRunTime.length > 0 && (
                  <DetailRow
                    label={intl.formatMessage(messages.episodeRuntime)}
                  >
                    {intl.formatMessage(messages.episodeRuntimeMinutes, {
                      runtime: data.episodeRunTime[0],
                    })}
                  </DetailRow>
                )}
                {data.originalLanguage && (
                  <DetailRow
                    label={intl.formatMessage(messages.originallanguage)}
                  >
                    <Link
                      href={`/discover/tv/language/${data.originalLanguage}`}
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
                {data.networks.length > 0 && (
                  <DetailRow
                    label={intl.formatMessage(messages.network, {
                      networkCount: data.networks.length,
                    })}
                  >
                    {data.networks.map((n) => (
                      <Link
                        href={`/discover/tv/network/${n.id}`}
                        key={`network-${n.id}`}
                        className="hover:text-as-ink hover:underline"
                      >
                        {n.name}
                      </Link>
                    ))}
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
              href={`/tv/${data.id}/cast`}
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
          url={`/api/v1/tv/${router.query.tvId}/recommendations`}
          linkUrl={`/tv/${data.id}/recommendations`}
          seeAllLabel={intl.formatMessage(messages.seeall)}
        />
        <PosterRail
          title={intl.formatMessage(messages.similar)}
          url={`/api/v1/tv/${router.query.tvId}/similar`}
          linkUrl={`/tv/${data.id}/similar`}
          seeAllLabel={intl.formatMessage(messages.seeall)}
        />
      </div>
    </div>
  );
};

export default TvDetails;
