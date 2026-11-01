import BlocklistButton from '@app/components/BlocklistButton';
import Button from '@app/components/Common/Button';
import CachedImage from '@app/components/Common/CachedImage';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import type { PlayButtonLink } from '@app/components/Common/PlayButton';
import PlayButton from '@app/components/Common/PlayButton';
import PosterLightbox, {
  fullSizeCover,
} from '@app/components/Common/PosterLightbox';
import Tag from '@app/components/Common/Tag';
import Tooltip from '@app/components/Common/Tooltip';
import FavoriteButton from '@app/components/FavoriteButton';
import IssueModal from '@app/components/IssueModal';
import ManageSlideOver from '@app/components/ManageSlideOver';
import RemovalRequestButton from '@app/components/RemovalRequestButton';
import RequestModal from '@app/components/RequestModal';
import StatusBadge from '@app/components/StatusBadge';
import WatchlistButton from '@app/components/WatchlistButton';
import useDeepLinks from '@app/hooks/useDeepLinks';
import useSettings from '@app/hooks/useSettings';
import { Permission, useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import ErrorPage from '@app/pages/_error';
import defineMessages from '@app/utils/defineMessages';
import { refreshIntervalHelper } from '@app/utils/refreshIntervalHelper';
import {
  CogIcon,
  ExclamationTriangleIcon,
  MusicalNoteIcon,
} from '@heroicons/react/24/outline';
import { ArrowDownTrayIcon, PlayIcon } from '@heroicons/react/24/solid';
import { IssueStatus } from '@server/constants/issue';
import { MediaRequestStatus, MediaStatus } from '@server/constants/media';
import { MediaServerType } from '@server/constants/server';
import type { MusicDetails as MusicDetailsType } from '@server/models/Music';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { Fragment, useEffect, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.MusicDetails', {
  tracks: 'Tracks',
  trackcount: '{trackCount, plural, one {# Track} other {# Tracks}}',
  disc: 'Disc {discNumber}',
  aboutartist: 'About {artist}',
  overviewunavailable: 'No information is available for this artist.',
  readmore: 'Read more on Wikipedia',
  viewartist: 'View Artist',
  releasedate: 'Release Date',
  type: 'Type',
  artist: 'Artist',
  viewrequest: 'View Request',
  managealbum: 'Manage Album',
  playonmediaserver: 'Play on {mediaServerName}',
  openinmusicbrainz: 'Open in MusicBrainz',
  notracks: 'The track list is not available.',
  reportissue: 'Report an Issue',
});

/**
 * Formats a length in milliseconds as minutes and seconds
 */
export const formatTrackLength = (length?: number | null): string => {
  if (!length) {
    return '';
  }

  const totalSeconds = Math.round(length / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = String(totalSeconds % 60).padStart(2, '0');

  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
    : `${minutes}:${seconds}`;
};

interface MusicDetailsProps {
  album?: MusicDetailsType;
}

const MusicDetails = ({ album }: MusicDetailsProps) => {
  const settings = useSettings();
  const { user, hasPermission } = useUser();
  const router = useRouter();
  const intl = useIntl();
  const [showRequestModal, setShowRequestModal] = useState(false);
  const [showManager, setShowManager] = useState(false);
  const [showIssueModal, setShowIssueModal] = useState(false);

  const {
    data,
    error,
    mutate: revalidate,
  } = useSWR<MusicDetailsType>(`/api/v1/music/${router.query.musicId}`, {
    fallbackData: album,
    refreshInterval: refreshIntervalHelper(
      {
        downloadStatus: album?.mediaInfo?.downloadStatus,
        downloadStatus4k: undefined,
      },
      15000
    ),
  });

  useEffect(() => {
    if (router.query.manage === '1') {
      setShowManager(true);
      router.replace({
        pathname: router.pathname,
        query: { musicId: router.query.musicId },
      });
    }
  }, [router, router.query.manage]);

  const { mediaUrl: plexUrl } = useDeepLinks({
    mediaUrl: data?.mediaInfo?.mediaUrl,
    iOSPlexUrl: data?.mediaInfo?.iOSPlexUrl,
  });

  if (!data && !error) {
    return <LoadingSpinner />;
  }

  if (!data) {
    return <ErrorPage statusCode={404} />;
  }

  const mediaServerName =
    settings.currentSettings.mediaServerType === MediaServerType.EMBY
      ? 'Emby'
      : settings.currentSettings.mediaServerType === MediaServerType.PLEX
        ? 'Plex'
        : 'Jellyfin';

  const canRequest = hasPermission(
    [Permission.REQUEST, Permission.REQUEST_MUSIC],
    { type: 'or' }
  );

  const mediaLinks: PlayButtonLink[] = [];

  if (plexUrl && canRequest) {
    mediaLinks.push({
      text: intl.formatMessage(messages.playonmediaserver, {
        mediaServerName,
      }),
      url: plexUrl,
      svg: <PlayIcon />,
    });
  }

  const activeRequest = data.mediaInfo?.requests?.find(
    (request) => request.status === MediaRequestStatus.PENDING
  );
  const canViewRequest =
    !!activeRequest &&
    (activeRequest.requestedBy.id === user?.id ||
      hasPermission(Permission.MANAGE_REQUESTS));
  const isRequestable =
    !data.mediaInfo ||
    data.mediaInfo.status === MediaStatus.UNKNOWN ||
    data.mediaInfo.status === MediaStatus.DELETED;

  const totalLength = data.tracks.reduce(
    (total, track) => total + (track.length ?? 0),
    0
  );
  const albumAttributes: string[] = [data.type, ...data.secondaryTypes];
  if (data.tracks.length > 0) {
    albumAttributes.push(
      intl.formatMessage(messages.trackcount, {
        trackCount: data.tracks.length,
      })
    );
  }
  if (totalLength > 0) {
    albumAttributes.push(formatTrackLength(totalLength));
  }

  const discNumbers = [...new Set(data.tracks.map((track) => track.disc))];

  const canReportIssue =
    data.mediaInfo?.status === MediaStatus.AVAILABLE &&
    hasPermission([Permission.CREATE_ISSUES, Permission.MANAGE_ISSUES], {
      type: 'or',
    });
  const openIssues = (data.mediaInfo?.issues ?? []).filter(
    (issue) => issue.status === IssueStatus.OPEN
  );

  return (
    <div className="media-page" style={{ height: 493 }}>
      {data.artistBackdrop && (
        <div className="media-page-bg-image">
          <CachedImage
            type="music"
            alt=""
            src={data.artistBackdrop}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            fill
            priority
          />
          <div
            className="absolute inset-0"
            style={{
              backgroundImage:
                'linear-gradient(180deg, rgb(var(--tw-gray-900, 17 24 39) / 0.47) 0%, rgb(var(--tw-gray-900, 17 24 39) / 1) 100%)',
            }}
          />
        </div>
      )}
      <PageTitle title={[data.title, data.artistCredit]} />
      <RequestModal
        type="music"
        tmdbId={0}
        mbId={data.mbId}
        show={showRequestModal}
        editRequest={canViewRequest ? activeRequest : undefined}
        onComplete={() => {
          revalidate();
          setShowRequestModal(false);
        }}
        onCancel={() => setShowRequestModal(false)}
      />
      <IssueModal
        onCancel={() => setShowIssueModal(false)}
        show={showIssueModal}
        mediaType="music"
        mbId={data.mbId}
      />
      <ManageSlideOver
        data={data}
        mediaType="music"
        onClose={() => {
          setShowManager(false);
          router.replace({
            pathname: router.pathname,
            query: { musicId: router.query.musicId },
          });
        }}
        revalidate={() => revalidate()}
        show={showManager}
      />
      <div className="media-header">
        <div className="media-poster aspect-square bg-gray-800">
          {data.posterPath ? (
            <PosterLightbox
              type="music"
              src={data.posterPath}
              fullSrc={fullSizeCover(data.posterPath)}
            >
              <CachedImage
                type="music"
                src={data.posterPath}
                alt=""
                sizes="100vw"
                style={{ width: '100%', height: 'auto' }}
                width={500}
                height={500}
                priority
              />
            </PosterLightbox>
          ) : (
            <div className="flex h-full w-full items-center justify-center text-gray-600">
              <MusicalNoteIcon className="h-1/2 w-1/2" />
            </div>
          )}
        </div>
        <div className="media-title">
          <div className="media-status">
            <StatusBadge
              status={data.mediaInfo?.status}
              downloadItem={data.mediaInfo?.downloadStatus}
              title={data.title}
              inProgress={(data.mediaInfo?.downloadStatus ?? []).length > 0}
              mbId={data.mediaInfo?.mbId}
              mediaType="music"
              plexUrl={plexUrl}
              serviceUrl={data.mediaInfo?.serviceUrl}
            />
          </div>
          <h1 data-testid="media-title">
            {data.title}{' '}
            {data.releaseDate && (
              <span className="media-year">
                ({data.releaseDate.slice(0, 4)})
              </span>
            )}
          </h1>
          <span className="media-attributes">
            {data.artist.id ? (
              <Link
                href={`/artist/${data.artist.id}`}
                className="hover:underline"
              >
                {data.artistCredit}
              </Link>
            ) : (
              <span>{data.artistCredit}</span>
            )}
            {albumAttributes.map((attribute, index) => (
              <Fragment key={`attribute-${index}`}>
                <span>|</span>
                <span>{attribute}</span>
              </Fragment>
            ))}
          </span>
        </div>
        <div className="media-actions">
          <div className="z-20">
            <PlayButton links={mediaLinks} />
          </div>
          {canRequest && isRequestable && (
            <Button
              buttonType="primary"
              onClick={() => setShowRequestModal(true)}
              className="ml-2 first:ml-0"
            >
              <ArrowDownTrayIcon />
              <span>{intl.formatMessage(globalMessages.request)}</span>
            </Button>
          )}
          {canViewRequest && (
            <Button
              buttonType="warning"
              onClick={() => setShowRequestModal(true)}
              className="ml-2 first:ml-0"
            >
              <span>{intl.formatMessage(messages.viewrequest)}</span>
            </Button>
          )}
          {data.mediaInfo?.status !== MediaStatus.BLOCKLISTED && (
            <WatchlistButton
              mediaType="music"
              id={data.mbId}
              title={data.title}
              onUserWatchlist={data.onUserWatchlist}
            />
          )}
          <FavoriteButton
            mediaType="music"
            id={data.mbId}
            title={data.title}
            className="ml-2 first:ml-0"
          />
          <BlocklistButton
            mediaType="music"
            id={data.mbId}
            title={data.title}
            media={data.mediaInfo}
            onUpdate={() => revalidate()}
          />
          <RemovalRequestButton
            media={data.mediaInfo}
            title={data.title}
            className="ml-2 first:ml-0"
          />
          {canReportIssue && (
            <Tooltip content={intl.formatMessage(messages.reportissue)}>
              <Button
                buttonType="warning"
                onClick={() => setShowIssueModal(true)}
                className="ml-2 first:ml-0"
                aria-label={intl.formatMessage(messages.reportissue)}
              >
                <ExclamationTriangleIcon />
              </Button>
            </Tooltip>
          )}
          {hasPermission(Permission.MANAGE_REQUESTS) &&
            data.mediaInfo &&
            data.mediaInfo.status !== MediaStatus.UNKNOWN && (
              <Tooltip content={intl.formatMessage(messages.managealbum)}>
                <Button
                  buttonType="ghost"
                  onClick={() => setShowManager(true)}
                  className="relative ml-2 first:ml-0"
                >
                  <CogIcon className="!mr-0" />
                  {hasPermission(
                    [Permission.MANAGE_ISSUES, Permission.VIEW_ISSUES],
                    { type: 'or' }
                  ) &&
                    openIssues.length > 0 && (
                      <>
                        <div className="absolute -right-1 -top-1 h-3 w-3 rounded-full bg-red-600" />
                        <div className="absolute -right-1 -top-1 h-3 w-3 animate-ping rounded-full bg-red-600" />
                      </>
                    )}
                </Button>
              </Tooltip>
            )}
        </div>
      </div>
      <div className="media-overview">
        <div className="media-overview-left">
          <h2>
            {intl.formatMessage(messages.aboutartist, {
              artist: data.artist.name || data.artistCredit,
            })}
          </h2>
          <p>
            {data.artistWikipedia?.content ??
              intl.formatMessage(messages.overviewunavailable)}
          </p>
          <div className="mt-4 flex justify-end space-x-4">
            {data.artistWikipedia?.url && (
              <a
                href={data.artistWikipedia.url}
                target="_blank"
                rel="noreferrer"
                className="text-gray-400 transition duration-300 hover:text-gray-100"
              >
                {intl.formatMessage(messages.readmore)}
              </a>
            )}
            {data.artist.id && (
              <Link
                href={`/artist/${data.artist.id}`}
                className="text-gray-400 transition duration-300 hover:text-gray-100"
              >
                {intl.formatMessage(messages.viewartist)}
              </Link>
            )}
          </div>
          <h2 className="mt-6">{intl.formatMessage(messages.tracks)}</h2>
          {data.tracks.length === 0 ? (
            <p>{intl.formatMessage(messages.notracks)}</p>
          ) : (
            discNumbers.map((discNumber) => (
              <div key={`disc-${discNumber}`} className="mt-2">
                {discNumbers.length > 1 && (
                  <h3 className="mb-1 mt-4 text-sm font-bold uppercase tracking-wider text-gray-400">
                    {intl.formatMessage(messages.disc, { discNumber })}
                  </h3>
                )}
                <ul className="divide-y divide-gray-700 overflow-hidden rounded-lg bg-gray-800 ring-1 ring-gray-700">
                  {data.tracks
                    .filter((track) => track.disc === discNumber)
                    .map((track) => (
                      <li
                        key={`track-${discNumber}-${track.position}-${track.recordingMbid}`}
                        className="flex items-center px-4 py-2 text-sm"
                      >
                        <span className="w-8 flex-shrink-0 text-gray-500">
                          {track.number}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-gray-200">
                          {track.name}
                        </span>
                        <span className="ml-4 flex-shrink-0 text-gray-400">
                          {formatTrackLength(track.length)}
                        </span>
                      </li>
                    ))}
                </ul>
              </div>
            ))
          )}
        </div>
        <div className="media-overview-right">
          <div className="media-facts">
            <div className="media-fact">
              <span>{intl.formatMessage(messages.artist)}</span>
              <span className="media-fact-value">
                {data.artist.id ? (
                  <Link href={`/artist/${data.artist.id}`}>
                    {data.artistCredit}
                  </Link>
                ) : (
                  data.artistCredit
                )}
              </span>
            </div>
            {data.releaseDate && (
              <div className="media-fact">
                <span>{intl.formatMessage(messages.releasedate)}</span>
                <span className="media-fact-value">
                  {intl.formatDate(data.releaseDate, {
                    year: 'numeric',
                    month: data.releaseDate.length > 4 ? 'long' : undefined,
                    day: data.releaseDate.length > 7 ? 'numeric' : undefined,
                    timeZone: 'UTC',
                  })}
                </span>
              </div>
            )}
            <div className="media-fact">
              <span>{intl.formatMessage(messages.type)}</span>
              <span className="media-fact-value">
                {[data.type, ...data.secondaryTypes].join(', ')}
              </span>
            </div>
            <div className="media-fact">
              <a
                href={`https://musicbrainz.org/release-group/${data.mbId}`}
                target="_blank"
                rel="noreferrer"
                className="hover:text-gray-100"
              >
                {intl.formatMessage(messages.openinmusicbrainz)}
              </a>
            </div>
          </div>
          {data.genres.length > 0 && (
            <div className="mt-6">
              {data.genres.map((genre) => (
                <span key={`genre-${genre}`} className="mb-2 mr-2 inline-flex">
                  <Tag>{genre}</Tag>
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="extra-bottom-space relative" />
    </div>
  );
};

export default MusicDetails;
