import EmbyLogo from '@app/assets/services/emby.svg';
import JellyfinLogo from '@app/assets/services/jellyfin.svg';
import PlexLogo from '@app/assets/services/plex.svg';
import {
  Card,
  DetailRow,
  LinkChips,
  TitleHero,
} from '@app/components/Allseerr/Title';
import {
  AlbumCoverCard,
  CoverRail,
  railCoverClass,
} from '@app/components/Allseerr/Title/CoverCard';
import StatusPill from '@app/components/Allseerr/Title/StatusPill';
import {
  chip,
  pillIcon,
  pillIconWarn,
  pillPrimary,
  pillPrimaryCollapse,
  pillSecondary,
  pillSecondaryCollapse,
} from '@app/components/Allseerr/Title/styles';
import BlocklistButton from '@app/components/BlocklistButton';
import Button from '@app/components/Common/Button';
import CachedImage from '@app/components/Common/CachedImage';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import Tooltip from '@app/components/Common/Tooltip';
import FavoriteButton from '@app/components/FavoriteButton';
import IssueModal from '@app/components/IssueModal';
import ManageSlideOver from '@app/components/ManageSlideOver';
import { formatTrackLength } from '@app/components/MusicDetails';
import NotifyMeButton from '@app/components/NotifyMeButton';
import RemovalRequestButton from '@app/components/RemovalRequestButton';
import RequestModal from '@app/components/RequestModal';
import WatchlistButton from '@app/components/WatchlistButton';
import useDeepLinks from '@app/hooks/useDeepLinks';
import useSettings from '@app/hooks/useSettings';
import { Permission, useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import ErrorPage from '@app/pages/_error';
import defineMessages from '@app/utils/defineMessages';
import { refreshIntervalHelper } from '@app/utils/refreshIntervalHelper';
import {
  ArrowDownTrayIcon,
  ClockIcon,
  CogIcon,
  ExclamationTriangleIcon,
  MusicalNoteIcon,
  PlayIcon,
} from '@heroicons/react/24/outline';
import { IssueStatus } from '@server/constants/issue';
import { MediaRequestStatus, MediaStatus } from '@server/constants/media';
import { MediaServerType } from '@server/constants/server';
import type {
  ArtistDetails as ArtistDetailsType,
  MusicDetails as MusicDetailsType,
} from '@server/models/Music';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.Allseerr.MusicDetails', {
  tracks: 'Tracks',
  trackcount: '{trackCount, plural, one {# track} other {# tracks}}',
  disc: 'Disc {discNumber}',
  aboutartist: 'About {artist}',
  overviewunavailable: 'No information is available for this artist.',
  readmore: 'Read more on Wikipedia',
  viewartist: 'View Artist',
  releasedate: 'Release Date',
  type: 'Type',
  artist: 'Artist',
  details: 'Details',
  tags: 'Tags',
  musicbrainzid: 'MusicBrainz ID',
  viewrequest: 'View Request',
  managealbum: 'Manage Album',
  playonmediaserver: 'Play on {mediaServerName}',
  notracks: 'The track list is not available.',
  byartist: 'by {artist}',
  morefrom: 'More from {artist}',
  seeall: 'See all',
  requestedby: 'Requested by {user} on {date}',
  reportissue: 'Report an Issue',
});

// External links worth a chip in the Details card, by MusicBrainz link type
const LINK_LABELS: Record<string, string> = {
  discogs: 'Discogs',
  allmusic: 'AllMusic',
  wikidata: 'Wikidata',
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

  // The rest of the artist's discography, for the rail at the bottom
  const { data: artistData } = useSWR<ArtistDetailsType>(
    data?.artist.id ? `/api/v1/artist/${data.artist.id}` : null
  );

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

  const isAvailable = data.mediaInfo?.status === MediaStatus.AVAILABLE;
  const canReportIssue =
    isAvailable &&
    hasPermission([Permission.CREATE_ISSUES, Permission.MANAGE_ISSUES], {
      type: 'or',
    });
  const openIssues = (data.mediaInfo?.issues ?? []).filter(
    (issue) => issue.status === IssueStatus.OPEN
  );
  // The removal and issue buttons join the row once the album is available,
  // labelled pills then drop to icons on phones to keep it on one line
  const compactActions = isAvailable;

  const latestRequest = (data.mediaInfo?.requests ?? [])
    .filter((request) => request.requestedBy)
    .sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    )[0];

  const totalLength = data.tracks.reduce(
    (total, track) => total + (track.length ?? 0),
    0
  );
  const discNumbers = [...new Set(data.tracks.map((track) => track.disc))];
  const artistName = data.artist.name || data.artistCredit;

  const artistLink = data.artist.id ? (
    <Link
      href={`/artist/${data.artist.id}`}
      className="font-semibold text-as-ink hover:underline"
    >
      {data.artistCredit}
    </Link>
  ) : (
    <span className="font-semibold text-as-ink">{data.artistCredit}</span>
  );

  const externalLinks = [
    ...(plexUrl
      ? [
          {
            key: 'server',
            href: plexUrl,
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
      key: 'musicbrainz',
      href: `https://musicbrainz.org/release-group/${data.mbId}`,
      label: 'MusicBrainz',
    },
    {
      key: 'listenbrainz',
      href: `https://listenbrainz.org/album/${data.mbId}`,
      label: 'ListenBrainz',
    },
    ...data.links
      .filter((link) => LINK_LABELS[link.type])
      .filter(
        (link, index, links) =>
          links.findIndex((other) => other.type === link.type) === index
      )
      .map((link) => ({
        key: `link-${link.type}`,
        href: link.url,
        label: LINK_LABELS[link.type],
      })),
  ];

  const moreFromArtist = (artistData?.releaseGroups ?? [])
    .filter((releaseGroup) => releaseGroup.id !== data.mbId)
    .slice(0, 20);

  return (
    <div className="relative -mx-4 -mt-20 pb-10 lg:-mt-28">
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

      <TitleHero
        imageType="music"
        backdropPath={data.artistBackdrop ?? data.posterPath}
        blurBackdrop={!data.artistBackdrop}
        posterPath={data.posterPath}
        posterAlt={data.title}
        posterShape="square"
        posterFallback={<MusicalNoteIcon />}
        badges={
          data.mediaInfo?.status &&
          data.mediaInfo.status !== MediaStatus.UNKNOWN ? (
            <StatusPill
              status={data.mediaInfo.status}
              downloads={data.mediaInfo.downloadStatus}
              href={plexUrl}
            />
          ) : undefined
        }
      >
        {latestRequest && (
          <span className="flex items-center gap-2 text-[13px] text-as-ink-muted">
            <span className="relative h-6 w-6 overflow-hidden rounded-full bg-as-tile">
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

        <div className="flex flex-col gap-1.5">
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
          <span className="text-lg text-as-ink-muted">
            {intl.formatMessage(messages.byartist, { artist: artistLink })}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-3 text-as-ink-muted">
          {[data.type, ...data.secondaryTypes].map((type) => (
            <span
              key={`type-${type}`}
              className="rounded-md border border-as-line-strong px-2 py-0.5 text-[13px] font-bold"
            >
              {type}
            </span>
          ))}
          {data.tracks.length > 0 && (
            <span>
              {intl.formatMessage(messages.trackcount, {
                trackCount: data.tracks.length,
              })}
            </span>
          )}
          {totalLength > 0 && (
            <span className="flex items-center gap-1">
              <ClockIcon className="h-4 w-4" />
              {formatTrackLength(totalLength)}
            </span>
          )}
          {data.genres.length > 0 && <span>·</span>}
          {data.genres.slice(0, 4).map((genre) => (
            <span key={`genre-${genre}`} className={chip}>
              {genre}
            </span>
          ))}
        </div>

        {data.disambiguation && (
          <p className="italic text-as-ink-muted">{data.disambiguation}</p>
        )}

        <div className="flex flex-wrap items-center gap-2.5 max-sm:justify-center">
          {plexUrl && canRequest && (
            <a
              href={plexUrl}
              target="_blank"
              rel="noreferrer"
              className={`inline-flex items-center border transition [&_svg]:h-4 [&_svg]:w-4 ${
                compactActions ? pillPrimaryCollapse : pillPrimary
              }`}
              aria-label={intl.formatMessage(messages.playonmediaserver, {
                mediaServerName,
              })}
            >
              <PlayIcon />
              <span className={compactActions ? 'max-sm:sr-only' : ''}>
                {intl.formatMessage(messages.playonmediaserver, {
                  mediaServerName,
                })}
              </span>
            </a>
          )}
          {canRequest && isRequestable && (
            <Button
              className={plexUrl ? pillSecondary : pillPrimary}
              onClick={() => setShowRequestModal(true)}
            >
              <ArrowDownTrayIcon />
              <span>{intl.formatMessage(globalMessages.request)}</span>
            </Button>
          )}
          {canViewRequest && (
            <Button
              className={compactActions ? pillSecondaryCollapse : pillSecondary}
              onClick={() => setShowRequestModal(true)}
            >
              <ClockIcon />
              <span className={compactActions ? 'max-sm:sr-only' : ''}>
                {intl.formatMessage(messages.viewrequest)}
              </span>
            </Button>
          )}
          {data.mediaInfo?.status !== MediaStatus.BLOCKLISTED && (
            <WatchlistButton
              mediaType="music"
              id={data.mbId}
              title={data.title}
              onUserWatchlist={data.onUserWatchlist}
              ambient
            />
          )}
          <FavoriteButton
            mediaType="music"
            id={data.mbId}
            title={data.title}
            className={pillIcon}
          />
          <BlocklistButton
            mediaType="music"
            id={data.mbId}
            title={data.title}
            media={data.mediaInfo}
            onUpdate={() => revalidate()}
            ambient
          />
          <NotifyMeButton
            media={data.mediaInfo}
            title={data.title}
            className={pillSecondaryCollapse}
            ambient
          />
          <RemovalRequestButton
            media={data.mediaInfo}
            title={data.title}
            className={pillIcon}
          />
          {canReportIssue && (
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
            data.mediaInfo.status !== MediaStatus.UNKNOWN && (
              <Tooltip content={intl.formatMessage(messages.managealbum)}>
                <Button
                  className={`relative ${pillIcon}`}
                  onClick={() => setShowManager(true)}
                  aria-label={intl.formatMessage(messages.managealbum)}
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
      </TitleHero>

      <div className="px-4 lg:px-10">
        <section className="grid items-start gap-6 pt-7 lg:grid-cols-[minmax(0,1fr)_340px]">
          <div className="flex min-w-0 flex-col gap-6">
            <Card title={intl.formatMessage(messages.tracks)}>
              {data.tracks.length === 0 ? (
                <p className="text-as-ink-muted">
                  {intl.formatMessage(messages.notracks)}
                </p>
              ) : (
                discNumbers.map((discNumber) => (
                  <div key={`disc-${discNumber}`} className="flex flex-col">
                    {discNumbers.length > 1 && (
                      <h3 className="pb-2 pt-1 text-xs font-bold uppercase tracking-wider text-as-ink-faint">
                        {intl.formatMessage(messages.disc, { discNumber })}
                      </h3>
                    )}
                    <ol>
                      {data.tracks
                        .filter((track) => track.disc === discNumber)
                        .map((track) => (
                          <li
                            key={`track-${discNumber}-${track.position}-${track.recordingMbid}`}
                            className="flex items-center gap-4 border-t border-as-line py-2.5 text-sm"
                          >
                            <span className="w-7 flex-shrink-0 text-right tabular-nums text-as-ink-faint">
                              {track.number}
                            </span>
                            <span className="min-w-0 flex-1 truncate text-as-ink">
                              {track.name}
                            </span>
                            <span className="flex-shrink-0 tabular-nums text-as-ink-muted">
                              {formatTrackLength(track.length)}
                            </span>
                          </li>
                        ))}
                    </ol>
                  </div>
                ))
              )}
            </Card>
            {data.genres.length > 0 && (
              <Card title={intl.formatMessage(messages.tags)}>
                <div className="flex flex-wrap gap-2">
                  {data.genres.map((genre) => (
                    <span
                      key={`tag-${genre}`}
                      className="rounded-full border border-as-line bg-as-tile px-3 py-[7px] text-[13px] text-as-ink-soft"
                    >
                      {genre}
                    </span>
                  ))}
                </div>
              </Card>
            )}
            <Card
              title={intl.formatMessage(messages.aboutartist, {
                artist: artistName,
              })}
            >
              <p className="whitespace-pre-line leading-relaxed text-as-ink-soft">
                {data.artistWikipedia?.content ??
                  intl.formatMessage(messages.overviewunavailable)}
              </p>
              {(data.artistWikipedia?.url || data.artist.id) && (
                <div className="flex flex-wrap gap-4 text-sm font-semibold">
                  {data.artistWikipedia?.url && (
                    <a
                      href={data.artistWikipedia.url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-as-accent hover:text-as-accent-soft"
                    >
                      {intl.formatMessage(messages.readmore)}
                    </a>
                  )}
                  {data.artist.id && (
                    <Link
                      href={`/artist/${data.artist.id}`}
                      className="text-as-accent hover:text-as-accent-soft"
                    >
                      {intl.formatMessage(messages.viewartist)}
                    </Link>
                  )}
                </div>
              )}
            </Card>
          </div>

          <div className="flex min-w-0 flex-col gap-6">
            <Card title={intl.formatMessage(messages.details)}>
              <div>
                <DetailRow label={intl.formatMessage(messages.artist)}>
                  {data.artist.id ? (
                    <Link
                      href={`/artist/${data.artist.id}`}
                      className="hover:text-as-ink hover:underline"
                    >
                      {data.artistCredit}
                    </Link>
                  ) : (
                    data.artistCredit
                  )}
                </DetailRow>
                {data.releaseDate && (
                  <DetailRow label={intl.formatMessage(messages.releasedate)}>
                    {intl.formatDate(data.releaseDate, {
                      year: 'numeric',
                      month: data.releaseDate.length > 4 ? 'long' : undefined,
                      day: data.releaseDate.length > 7 ? 'numeric' : undefined,
                      timeZone: 'UTC',
                    })}
                  </DetailRow>
                )}
                <DetailRow label={intl.formatMessage(messages.type)}>
                  {[data.type, ...data.secondaryTypes].join(', ')}
                </DetailRow>
                {data.tracks.length > 0 && (
                  <DetailRow label={intl.formatMessage(messages.tracks)}>
                    {intl.formatNumber(data.tracks.length)}
                    {totalLength > 0 && ` · ${formatTrackLength(totalLength)}`}
                  </DetailRow>
                )}
                <DetailRow label={intl.formatMessage(messages.musicbrainzid)}>
                  <a
                    href={`https://musicbrainz.org/release-group/${data.mbId}`}
                    target="_blank"
                    rel="noreferrer"
                    className="break-all font-mono text-xs hover:text-as-ink hover:underline"
                  >
                    {data.mbId}
                  </a>
                </DetailRow>
              </div>
              <LinkChips links={externalLinks} />
            </Card>
          </div>
        </section>

        {moreFromArtist.length > 0 && (
          <CoverRail
            title={intl.formatMessage(messages.morefrom, {
              artist: artistName,
            })}
            href={data.artist.id ? `/artist/${data.artist.id}` : undefined}
            seeAllLabel={intl.formatMessage(messages.seeall)}
          >
            {moreFromArtist.map((releaseGroup) => (
              <AlbumCoverCard
                key={`more-${releaseGroup.id}`}
                album={releaseGroup}
                className={railCoverClass}
                subtitle={[
                  releaseGroup.albumType,
                  releaseGroup.releaseDate?.slice(0, 4),
                ]
                  .filter(Boolean)
                  .join(' · ')}
                showLabel={false}
              />
            ))}
          </CoverRail>
        )}
      </div>
    </div>
  );
};

export default MusicDetails;
