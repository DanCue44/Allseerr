import Spinner from '@app/assets/spinner.svg';
import type { DownloadsLayout } from '@app/components/Allseerr/Downloads/DownloadCard';
import { Detail } from '@app/components/Allseerr/Downloads/DownloadCard';
import UserAvatar from '@app/components/Allseerr/RequestList/UserAvatar';
import { statusTone } from '@app/components/Allseerr/Title/styles';
import CachedImage from '@app/components/Common/CachedImage';
import FormatIcon, {
  getRequestFormat,
} from '@app/components/Common/FormatIcon';
import Tooltip from '@app/components/Common/Tooltip';
import DeclineRequestModal from '@app/components/DeclineRequestModal';
import DownloadBlock from '@app/components/DownloadBlock';
import RequestModal from '@app/components/RequestModal';
import RequestSeasonBadges from '@app/components/RequestSeasonBadges';
import useClickOutside from '@app/hooks/useClickOutside';
import useDeepLinks from '@app/hooks/useDeepLinks';
import useSettings from '@app/hooks/useSettings';
import useToasts from '@app/hooks/useToasts';
import { Permission, useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import {
  getBookRequestFormat,
  getRequestDownloads,
  getRequestMediaStatus,
} from '@app/utils/bookRecordings';
import defineMessages from '@app/utils/defineMessages';
import {
  getRequestDownloadStatus,
  refreshIntervalHelper,
} from '@app/utils/refreshIntervalHelper';
import { Menu, MenuButton, MenuItem, MenuItems } from '@headlessui/react';
import {
  ArrowPathIcon,
  ArrowTopRightOnSquareIcon,
  CheckIcon,
  Cog6ToothIcon,
  EllipsisVerticalIcon,
  PencilIcon,
  PlayIcon,
  ServerStackIcon,
  TrashIcon,
  XMarkIcon,
} from '@heroicons/react/24/solid';
import { bookArrName } from '@server/constants/bookService';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { MediaServerType } from '@server/constants/server';
import type { MediaRequest } from '@server/entity/MediaRequest';
import type { NonFunctionProperties } from '@server/interfaces/api/common';
import type { RequestResultsResponse } from '@server/interfaces/api/requestInterfaces';
import type { ServiceCommonServer } from '@server/interfaces/api/serviceInterfaces';
import { formatVolumeRanges } from '@server/lib/comicVolumes';
import type { DownloadingItem } from '@server/lib/downloadtracker';
import type { BookDetails } from '@server/models/Book';
import type { ComicDetails } from '@server/models/Comic';
import type { MovieDetails } from '@server/models/Movie';
import type { MusicDetails } from '@server/models/Music';
import type { TvDetails } from '@server/models/Tv';
import axios from 'axios';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { useRef, useState } from 'react';
import { useInView } from 'react-intersection-observer';
import { FormattedRelativeTime, useIntl } from 'react-intl';
import useSWR, { mutate } from 'swr';

const messages = defineMessages('components.Allseerr.RequestList', {
  typeMovie: 'Movie',
  typeMovie4k: '4K Movie',
  typeTv: 'TV',
  typeTv4k: '4K TV',
  typeAlbum: 'Album',
  typeBook: 'Book',
  typeAudiobook: 'Audiobook',
  typeAudiobookRecording: 'Audiobook Recording',
  typeUnabridgedAudiobook: 'Unabridged Audiobook',
  typeAbridgedAudiobook: 'Abridged Audiobook',
  typeDate: '{type} · {date}',
  waitingApproval: 'Waiting for approval',
  downloadingProgress: 'Downloading {progress}%',
  readyWatch: 'Ready to watch',
  readyListen: 'Ready to listen',
  readyRead: 'Ready to read',
  partlyReady: 'Partly ready',
  declinedReason: 'Declined: {reason}',
  byArtist: 'by {artist}',
  requestedAgo: 'Requested {date}',
  modifiedBy: 'Modified {date} by {user}',
  byUser: '{date} by {user}',
  requestedBy: 'Requested by {name}',
  labelStatus: 'Status',
  labelSeasons: 'Seasons',
  labelVolumes: 'Volumes',
  labelFormat: 'Format',
  labelProfile: 'Profile',
  labelFolder: 'Folder',
  labelServer: 'Server',
  labelDeclined: 'Declined',
  labelRequested: 'Requested',
  labelModified: 'Modified',
  actions: 'Actions for {title}',
  keep: 'Keep',
  defaultSetting: 'Default',
  approve: 'Approve',
  decline: 'Decline',
  editRequest: 'Edit Request',
  deleteRequest: 'Delete Request',
  cancelRequest: 'Cancel Request',
  retryRequest: 'Retry Request',
  removeFromArr: 'Remove from {arr}',
  playOn: 'Play on {server}',
  manageMedia: 'Manage',
  openInArr: 'Open in {arr}',
  failedRetry: 'Something went wrong while retrying the request.',
  failedModify: 'Something went wrong while modifying the request.',
  removeMediaError: 'Something went wrong while removing the media.',
  mediaNotFound: '{mediaType} Not Found',
  tmdbId: 'TMDB ID {id}',
  tvdbId: 'TheTVDB ID {id}',
  unknownTitle: 'Unknown Title',
});

type RequestTitle =
  | MovieDetails
  | TvDetails
  | MusicDetails
  | BookDetails
  | ComicDetails;
type RequestData = NonFunctionProperties<MediaRequest> & {
  profileName?: string;
  canRemove?: boolean;
};

const isMusic = (title: RequestTitle): title is MusicDetails =>
  (title as MusicDetails).mediaType === 'album';

const isBook = (title: RequestTitle): title is BookDetails =>
  (title as BookDetails).mediaType === 'book';

const isComic = (title: RequestTitle): title is ComicDetails =>
  (title as ComicDetails).mediaType === 'comic';

const isMovie = (title: RequestTitle): title is MovieDetails =>
  !isMusic(title) &&
  !isBook(title) &&
  !isComic(title) &&
  (title as MovieDetails).title !== undefined;

const getTitleName = (title: RequestTitle): string =>
  isMovie(title) || isMusic(title) || isBook(title) || isComic(title)
    ? title.title
    : title.name;

const getTitleYear = (title: RequestTitle): string | undefined =>
  isComic(title)
    ? title.year?.toString()
    : isBook(title)
      ? title.firstPublishYear?.toString()
      : (isMovie(title) || isMusic(title)
          ? title.releaseDate
          : title.firstAirDate
        )?.slice(0, 4);

const getMediaPath = (request: NonFunctionProperties<MediaRequest>): string =>
  request.type === 'music'
    ? `/music/${request.media.mbId}`
    : request.type === 'book'
      ? `/book/${request.media.olId}`
      : request.type === 'comic'
        ? `/comic/${request.media.comicId}`
        : `/${request.type}/${request.media.tmdbId}`;

const arrName = (type: MediaRequest['type'], bookService?: string) =>
  type === 'movie'
    ? 'Radarr'
    : type === 'music'
      ? 'Lidarr'
      : type === 'book'
        ? bookArrName(bookService)
        : type === 'comic'
          ? 'Talearr'
          : 'Sonarr';

const serviceName = (type: MediaRequest['type']) =>
  type === 'movie'
    ? 'radarr'
    : type === 'music'
      ? 'lidarr'
      : type === 'tv'
        ? 'sonarr'
        : null;

const secondsAgo = (date: Date | string) =>
  Math.floor((new Date(date).getTime() - Date.now()) / 1000);

const statusPill =
  'inline-flex w-fit items-center rounded-full px-3 py-1.5 text-[13px] font-semibold';
const iconButton =
  'inline-flex h-9 w-9 flex-none items-center justify-center rounded-full border border-as-line-strong bg-as-raised text-as-ink transition hover:bg-as-line disabled:opacity-50 [&_svg]:h-4 [&_svg]:w-4';
const iconButtonBad = `${iconButton} hover:!bg-[#3b2427] hover:text-[#f2b0aa]`;
const cardShell = 'flex flex-col gap-2 rounded-[20px] bg-as-surface p-[18px]';
const cornerButton =
  'inline-flex h-8 w-8 flex-none items-center justify-center rounded-full bg-as-raised/80 text-as-ink transition hover:bg-as-line disabled:opacity-50 [&_svg]:h-4 [&_svg]:w-4';
const cornerButtonOk = `${cornerButton} hover:!bg-[#1d3b33] hover:text-[#a8e6c4]`;
const cornerButtonBad = `${cornerButton} hover:!bg-[#3b2427] hover:text-[#f2b0aa]`;
const menuEntry =
  'flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-sm font-semibold';

/** The list layout's columns: art, title, status, requested, details, actions */
export const REQUEST_LIST_GRID =
  'md:grid-cols-[2.5rem_minmax(0,1fr)_9.5rem_9rem_minmax(8rem,13rem)_7rem]';

/**
 * The card's backdrop: the title's art blurred and darkened behind the
 * details, like the download cards
 */
const CardArt = ({
  backdrop,
}: {
  backdrop?: { type: 'music' | 'book' | 'tmdb'; src: string };
}) => (
  <div className="pointer-events-none absolute inset-0" aria-hidden="true">
    {backdrop && (
      <CachedImage
        type={backdrop.type}
        src={backdrop.src}
        alt=""
        className="scale-110 blur-2xl"
        style={{ width: '100%', height: '100%', objectFit: 'cover' }}
        fill
      />
    )}
    <div className="absolute inset-0 bg-gradient-to-r from-as-surface via-as-surface/85 to-as-surface/70" />
  </div>
);

/** Round icon action with a tooltip. */
const IconAction = ({
  label,
  onClick,
  disabled,
  className = iconButton,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}) => (
  <Tooltip content={label}>
    <button
      type="button"
      className={className}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
    >
      {children}
    </button>
  </Tooltip>
);

/**
 * Round icon action that asks "Are you sure?" on the first click and runs
 * on the second.
 */
const ConfirmIconAction = ({
  label,
  onConfirm,
  children,
}: {
  label: string;
  onConfirm: () => void;
  children: ReactNode;
}) => {
  const intl = useIntl();
  const ref = useRef<HTMLButtonElement>(null);
  const [armed, setArmed] = useState(false);
  useClickOutside(ref, () => setArmed(false));

  return (
    <Tooltip content={armed ? undefined : label}>
      <span className="inline-flex">
        <button
          ref={ref}
          type="button"
          aria-label={
            armed ? intl.formatMessage(globalMessages.areyousure) : label
          }
          className={
            armed
              ? 'inline-flex h-9 items-center rounded-full bg-[#3b2427] px-3 text-[13px] font-semibold text-[#f2b0aa] transition hover:brightness-110'
              : iconButtonBad
          }
          onClick={() => {
            if (armed) {
              setArmed(false);
              onConfirm();
            } else {
              setArmed(true);
            }
          }}
        >
          {armed ? intl.formatMessage(globalMessages.areyousure) : children}
        </button>
      </span>
    </Tooltip>
  );
};

/** Who requested it and when, plus who last changed it. */
const RequestMeta = ({
  requestData,
  showRequester,
}: {
  requestData: NonFunctionProperties<MediaRequest>;
  showRequester: boolean;
}) => {
  const intl = useIntl();

  return (
    <div className="flex min-w-0 flex-col gap-1 text-xs text-as-ink-muted">
      {showRequester ? (
        <Link
          href={`/users/${requestData.requestedBy.id}`}
          className="group flex min-w-0 items-center gap-2"
        >
          <UserAvatar
            id={requestData.requestedBy.id}
            name={requestData.requestedBy.displayName}
            avatar={requestData.requestedBy.avatar}
            size={24}
          />
          <span className="min-w-0 truncate">
            <span className="font-semibold text-as-ink-soft group-hover:text-as-ink group-hover:underline">
              {requestData.requestedBy.displayName}
            </span>{' '}
            <FormattedRelativeTime
              value={secondsAgo(requestData.createdAt)}
              updateIntervalInSeconds={1}
              numeric="auto"
            />
          </span>
        </Link>
      ) : (
        <span className="truncate">
          {intl.formatMessage(messages.requestedAgo, {
            date: (
              <FormattedRelativeTime
                value={secondsAgo(requestData.createdAt)}
                updateIntervalInSeconds={1}
                numeric="auto"
              />
            ),
          })}
        </span>
      )}
      {requestData.modifiedBy && (
        <span className="truncate">
          {intl.formatMessage(messages.modifiedBy, {
            date: (
              <FormattedRelativeTime
                value={secondsAgo(requestData.updatedAt)}
                updateIntervalInSeconds={1}
                numeric="auto"
              />
            ),
            user: (
              <Link
                href={`/users/${requestData.modifiedBy.id}`}
                className="font-semibold text-as-ink-soft hover:text-as-ink hover:underline"
              >
                {requestData.modifiedBy.displayName}
              </Link>
            ),
          })}
        </span>
      )}
    </div>
  );
};

const progressOf = (downloads: DownloadingItem[]) => {
  const size = downloads.reduce((total, item) => total + item.size, 0);
  const left = downloads.reduce((total, item) => total + item.sizeLeft, 0);

  return size ? Math.round(((size - left) / size) * 100) : 0;
};

/** Status pill, or a progress bar while downloading. */
const RequestStatus = ({
  requestData,
  downloads,
  titleName,
}: {
  requestData: NonFunctionProperties<MediaRequest>;
  downloads: DownloadingItem[];
  titleName: string;
}) => {
  const intl = useIntl();
  const mediaStatus = getRequestMediaStatus(requestData);
  const managePath = `${getMediaPath(requestData)}?manage=1`;

  if (requestData.status === MediaRequestStatus.DECLINED) {
    return (
      <span className={`${statusPill} ${statusTone.bad}`}>
        {intl.formatMessage(globalMessages.declined)}
      </span>
    );
  }

  if (requestData.status === MediaRequestStatus.FAILED) {
    return (
      <Link
        href={managePath}
        className={`${statusPill} ${statusTone.bad} hover:brightness-110`}
      >
        {intl.formatMessage(globalMessages.failed)}
      </Link>
    );
  }

  if (requestData.status === MediaRequestStatus.PENDING) {
    const pill = (
      <span className={`${statusPill} bg-[#3b2a25] text-[#ffd2c0]`}>
        {intl.formatMessage(messages.waitingApproval)}
      </span>
    );

    return mediaStatus === MediaStatus.DELETED ? (
      <Link href={managePath} className="w-fit hover:brightness-110">
        {pill}
      </Link>
    ) : (
      pill
    );
  }

  if (downloads.length > 0) {
    const progress = progressOf(downloads);

    return (
      <Tooltip
        content={
          <div className="max-h-96 overflow-y-auto">
            {downloads.map((item) => (
              <DownloadBlock
                key={`download-${item.downloadId}-${item.episode?.seasonNumber}-${item.episode?.episodeNumber}`}
                downloadItem={item}
                is4k={requestData.is4k}
                title={titleName}
              />
            ))}
          </div>
        }
        className="!p-0"
      >
        <div className="flex flex-col gap-1.5 py-1">
          <div
            className="h-2 w-full overflow-hidden rounded-full bg-[#1e3247]"
            role="progressbar"
            aria-valuenow={progress}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className="h-full rounded-full bg-[#aac8f0] transition-[width] duration-500"
              style={{ width: `${progress}%` }}
            />
          </div>
          <span className="text-[13px] font-semibold text-[#aac8f0]">
            {intl.formatMessage(messages.downloadingProgress, { progress })}
          </span>
        </div>
      </Tooltip>
    );
  }

  switch (mediaStatus) {
    case MediaStatus.AVAILABLE:
      return (
        <span className={`${statusPill} ${statusTone.ok}`}>
          {intl.formatMessage(
            requestData.type === 'music'
              ? messages.readyListen
              : requestData.type === 'book'
                ? requestData.isAudiobook
                  ? messages.readyListen
                  : messages.readyRead
                : requestData.type === 'comic'
                  ? messages.readyRead
                  : messages.readyWatch
          )}
        </span>
      );
    case MediaStatus.PARTIALLY_AVAILABLE:
      return (
        <span className={`${statusPill} ${statusTone.ok}`}>
          {intl.formatMessage(messages.partlyReady)}
        </span>
      );
    case MediaStatus.PROCESSING:
      return (
        <span className={`${statusPill} ${statusTone.info}`}>
          {intl.formatMessage(globalMessages.processing)}
        </span>
      );
    case MediaStatus.DELETED:
      return (
        <span className={`${statusPill} ${statusTone.bad}`}>
          {intl.formatMessage(globalMessages.deleted)}
        </span>
      );
    case MediaStatus.BLOCKLISTED:
      return (
        <span className={`${statusPill} ${statusTone.bad}`}>
          {intl.formatMessage(globalMessages.blocklisted)}
        </span>
      );
    case MediaStatus.PENDING:
      return (
        <span className={`${statusPill} ${statusTone.info}`}>
          {intl.formatMessage(globalMessages.requested)}
        </span>
      );
    default:
      return requestData.status === MediaRequestStatus.APPROVED ? (
        <span className={`${statusPill} ${statusTone.info}`}>
          {intl.formatMessage(globalMessages.requested)}
        </span>
      ) : (
        <span className={`${statusPill} ${statusTone.neutral}`}>
          {intl.formatMessage(globalMessages.unavailable)}
        </span>
      );
  }
};

const typeMessage = (request: NonFunctionProperties<MediaRequest>) =>
  request.type === 'movie'
    ? request.is4k
      ? messages.typeMovie4k
      : messages.typeMovie
    : request.type === 'tv'
      ? request.is4k
        ? messages.typeTv4k
        : messages.typeTv
      : request.type === 'music'
        ? messages.typeAlbum
        : request.type === 'comic'
          ? request.media.comicKind === 'manga'
            ? globalMessages.manga
            : globalMessages.comic
          : {
              ebook: messages.typeBook,
              audiobook: messages.typeAudiobook,
              unabridgedaudiobook: messages.typeUnabridgedAudiobook,
              abridgedaudiobook: messages.typeAbridgedAudiobook,
              audiobookrecording: messages.typeAudiobookRecording,
            }[getBookRequestFormat(request)];

/** The line under the title: "{Type} · {short date}", then the detail. */
const TypeLine = ({
  request,
  extra,
}: {
  request: NonFunctionProperties<MediaRequest>;
  // The artist, the authors or the year
  extra?: string;
}) => {
  const intl = useIntl();
  const created = new Date(request.createdAt);
  const typeDate = intl.formatMessage(messages.typeDate, {
    type: intl.formatMessage(typeMessage(request)),
    date: intl.formatDate(created, {
      month: 'short',
      day: 'numeric',
      year:
        created.getFullYear() === new Date().getFullYear()
          ? undefined
          : 'numeric',
    }),
  });

  return (
    <div className="flex min-w-0 items-center gap-1.5 text-xs text-as-ink-muted">
      <FormatIcon format={getRequestFormat(request)} size="small" />
      <span className="truncate">
        {[typeDate, extra].filter(Boolean).join(' · ')}
      </span>
    </div>
  );
};

interface RequestCardErrorProps {
  requestData?: RequestData;
  revalidateList: () => void;
  showRequester: boolean;
}

/** Card for a request whose title could not be loaded. */
const RequestCardError = ({
  requestData,
  revalidateList,
  showRequester,
}: RequestCardErrorProps) => {
  const intl = useIntl();
  const { hasPermission } = useUser();

  const deleteMedia = async () => {
    await axios.delete(`/api/v1/media/${requestData?.media.id}`);
    revalidateList();
    mutate('/api/v1/request/count');
  };

  const downloads = getRequestDownloadStatus(
    requestData ? getRequestDownloads(requestData) : undefined,
    requestData?.type === 'tv'
      ? (requestData?.seasons ?? []).map((season) => season.seasonNumber)
      : []
  );

  return (
    <div className={`${cardShell} ring-1 ring-[#f2b0aa]/40`}>
      {requestData && <TypeLine request={requestData} />}
      <div className="text-[17px] font-bold text-as-ink">
        {intl.formatMessage(messages.mediaNotFound, {
          mediaType: intl.formatMessage(
            requestData
              ? requestData.type === 'movie'
                ? globalMessages.movie
                : requestData.type === 'music'
                  ? globalMessages.album
                  : requestData.type === 'book'
                    ? globalMessages.book
                    : requestData.type === 'comic'
                      ? globalMessages.comic
                      : globalMessages.tvshow
              : globalMessages.request
          ),
        })}
      </div>
      {requestData && hasPermission(Permission.MANAGE_REQUESTS) && (
        <div className="flex flex-col text-sm text-as-ink-soft">
          {requestData.media.tmdbId && (
            <span>
              {intl.formatMessage(messages.tmdbId, {
                id: requestData.media.tmdbId,
              })}
            </span>
          )}
          {requestData.media.tvdbId && (
            <span>
              {intl.formatMessage(messages.tvdbId, {
                id: requestData.media.tvdbId,
              })}
            </span>
          )}
        </div>
      )}
      {requestData && (
        <>
          <RequestStatus
            requestData={requestData}
            downloads={downloads}
            titleName={intl.formatMessage(messages.unknownTitle)}
          />
          <div className="mt-auto flex items-end justify-between gap-2 pt-2">
            <RequestMeta
              requestData={requestData}
              showRequester={showRequester}
            />
            {hasPermission(Permission.MANAGE_REQUESTS) &&
              requestData.media.id && (
                <ConfirmIconAction
                  label={intl.formatMessage(messages.deleteRequest)}
                  onConfirm={() => deleteMedia()}
                >
                  <TrashIcon />
                </ConfirmIconAction>
              )}
          </div>
        </>
      )}
    </div>
  );
};

interface RequestCardProps {
  request: RequestResultsResponse['results'][number];
  revalidateList: () => void;
  // Show the requester's avatar and name in the footer
  showRequester: boolean;
  // A card with the art and details, or one compact row
  layout?: DownloadsLayout;
}

/**
 * One request in the Ambient request grid, laid out like the download
 * cards: the art and the details in a tile, the title under it, and the
 * actions in the corner. Same data and actions as the classic RequestItem.
 */
const RequestCard = ({
  request,
  revalidateList,
  showRequester,
  layout = 'cards',
}: RequestCardProps) => {
  const { ref, inView } = useInView({ triggerOnce: true });
  const { addToast } = useToasts();
  const intl = useIntl();
  const settings = useSettings();
  const { user, hasPermission } = useUser();
  const [showEditModal, setShowEditModal] = useState(false);
  const [showDeclineModal, setShowDeclineModal] = useState(false);
  const [isRetrying, setRetrying] = useState(false);
  const [updatingType, setUpdatingType] = useState<
    'approve' | 'decline' | null
  >(null);
  // A delete, remove or cancel asks once before it runs
  const [confirm, setConfirm] = useState<{
    label: string;
    run: () => void;
  } | null>(null);

  const isManager = hasPermission(Permission.MANAGE_REQUESTS);
  const url =
    request.type === 'movie'
      ? `/api/v1/movie/${request.media.tmdbId}`
      : request.type === 'music'
        ? `/api/v1/music/${request.media.mbId}`
        : request.type === 'book'
          ? `/api/v1/book/${request.media.olId}`
          : request.type === 'comic'
            ? `/api/v1/comic/${request.media.comicId}`
            : `/api/v1/tv/${request.media.tmdbId}`;
  const { data: title, error } = useSWR<RequestTitle>(inView ? url : null);
  const { data: requestData, mutate: revalidate } = useSWR<RequestData>(
    `/api/v1/request/${request.id}`,
    {
      fallbackData: request,
      refreshInterval: refreshIntervalHelper(
        {
          downloadStatus: request.media.downloadStatus,
          downloadStatus4k: request.media.downloadStatus4k,
          downloadStatusAudio: request.media.downloadStatusAudio,
        },
        15000
      ),
    }
  );

  // Server names for the override line, managers only
  const service = serviceName(request.type);
  const { data: servers } = useSWR<ServiceCommonServer[]>(
    isManager && service && request.serverId !== null && inView
      ? `/api/v1/service/${service}`
      : null
  );

  const { mediaUrl: plexUrl, mediaUrl4k: plexUrl4k } = useDeepLinks({
    mediaUrl: requestData?.media?.mediaUrl,
    mediaUrl4k: requestData?.media?.mediaUrl4k,
    iOSPlexUrl: requestData?.media?.iOSPlexUrl,
    iOSPlexUrl4k: requestData?.media?.iOSPlexUrl4k,
  });

  const modifyRequest = async (
    type: 'approve' | 'decline',
    reason?: string
  ) => {
    setUpdatingType(type);
    try {
      await axios.post(
        `/api/v1/request/${request.id}/${type}`,
        reason ? { reason } : undefined
      );
      setShowDeclineModal(false);
      revalidate();
      revalidateList();
      mutate('/api/v1/request/count');
    } catch {
      addToast(intl.formatMessage(messages.failedModify), {
        autoDismiss: true,
        appearance: 'error',
      });
    } finally {
      setUpdatingType(null);
    }
  };

  const deleteRequest = async () => {
    await axios.delete(`/api/v1/request/${request.id}`);
    revalidateList();
    mutate('/api/v1/request/count');
  };

  const deleteMediaFile = async () => {
    if (request.media) {
      try {
        await axios.delete(
          `/api/v1/media/${request.media.id}/file?is4k=${request.is4k}`
        );
      } catch (e) {
        if (!axios.isAxiosError(e) || e.response?.status !== 404) {
          addToast(intl.formatMessage(messages.removeMediaError), {
            autoDismiss: true,
            appearance: 'error',
          });
          revalidateList();
          return;
        }
      }
      revalidateList();
    }
  };

  const retryRequest = async () => {
    setRetrying(true);
    try {
      const result = await axios.post(`/api/v1/request/${request.id}/retry`);
      revalidate(result.data);
    } catch {
      addToast(intl.formatMessage(messages.failedRetry), {
        autoDismiss: true,
        appearance: 'error',
      });
    } finally {
      setRetrying(false);
    }
  };

  if (!title && !error) {
    return (
      <div
        ref={ref}
        className={
          layout === 'list'
            ? 'h-[72px] animate-pulse'
            : 'h-[252px] animate-pulse rounded-[18px] bg-as-surface'
        }
      />
    );
  }

  if (!title || !requestData) {
    return (
      <RequestCardError
        requestData={requestData}
        revalidateList={revalidateList}
        showRequester={showRequester}
      />
    );
  }

  const titleName = getTitleName(title);
  const mediaPath = getMediaPath(requestData);
  const downloads = getRequestDownloadStatus(
    getRequestDownloads(requestData),
    requestData.type === 'tv'
      ? requestData.seasons.map((season) => season.seasonNumber)
      : []
  );
  const mediaStatus = getRequestMediaStatus(requestData);
  const isPending = requestData.status === MediaRequestStatus.PENDING;
  const isOwn = requestData.requestedBy.id === user?.id;

  // Same rule as the classic status badge for the "Play on" link
  const playUrl = requestData.is4k ? plexUrl4k : plexUrl;
  const canPlay =
    !!playUrl &&
    (mediaStatus === MediaStatus.AVAILABLE ||
      mediaStatus === MediaStatus.PARTIALLY_AVAILABLE) &&
    hasPermission(
      requestData.is4k
        ? [
            Permission.REQUEST_4K,
            requestData.type === 'movie'
              ? Permission.REQUEST_4K_MOVIE
              : Permission.REQUEST_4K_TV,
          ]
        : [
            Permission.REQUEST,
            requestData.type === 'movie'
              ? Permission.REQUEST_MOVIE
              : requestData.type === 'music'
                ? Permission.REQUEST_MUSIC
                : requestData.type === 'book' || requestData.type === 'comic'
                  ? Permission.REQUEST_BOOK
                  : Permission.REQUEST_TV,
          ],
      { type: 'or' }
    ) &&
    (!requestData.is4k ||
      (requestData.type === 'movie'
        ? settings.currentSettings.movie4kEnabled
        : settings.currentSettings.series4kEnabled));
  const mediaServerName =
    settings.currentSettings.mediaServerType === MediaServerType.EMBY
      ? 'Emby'
      : settings.currentSettings.mediaServerType === MediaServerType.PLEX
        ? 'Plex'
        : 'Jellyfin';
  const serviceUrl = requestData.is4k
    ? requestData.media.serviceUrl4k
    : requestData.media.serviceUrl;

  const serverName =
    requestData.serverId !== null && requestData.serverId !== undefined
      ? servers?.find((server) => server.id === requestData.serverId)?.name
      : undefined;
  const posterSquare = isMusic(title);
  const poster = isMusic(title) ? (
    title.posterPath ? (
      <CachedImage
        type="music"
        src={title.posterPath}
        alt=""
        style={{ width: '100%', height: '100%', objectFit: 'cover' }}
        fill
      />
    ) : null
  ) : isBook(title) || isComic(title) ? (
    <CachedImage
      type="book"
      src={title.posterPath ?? '/images/allseerr_poster_not_found.png'}
      alt=""
      style={{ width: '100%', height: '100%', objectFit: 'cover' }}
      fill
    />
  ) : (
    <CachedImage
      type="tmdb"
      src={
        title.posterPath
          ? `https://image.tmdb.org/t/p/w600_and_h900_bestv2${title.posterPath}`
          : '/images/allseerr_poster_not_found.png'
      }
      alt=""
      style={{ width: '100%', height: '100%', objectFit: 'cover' }}
      fill
    />
  );
  // Albums, books and comics have no backdrop art, so their cover stands in
  const backdrop =
    isMusic(title) || isBook(title) || isComic(title)
      ? title.posterPath
        ? {
            type: isMusic(title) ? ('music' as const) : ('book' as const),
            src: title.posterPath,
          }
        : undefined
      : title.backdropPath
        ? {
            type: 'tmdb' as const,
            src: `https://image.tmdb.org/t/p/w780${title.backdropPath}`,
          }
        : undefined;

  const year = getTitleYear(title);
  const detail = isMusic(title)
    ? title.artistCredit
      ? intl.formatMessage(messages.byArtist, { artist: title.artistCredit })
      : undefined
    : isComic(title)
      ? title.authors
      : isBook(title)
        ? title.authors.map((author) => author.name).join(', ')
        : isMovie(title)
          ? year
          : undefined;

  // Comic requests take no options
  const canEdit =
    requestData.type !== 'comic' &&
    isPending &&
    (isManager ||
      (isOwn &&
        (requestData.type === 'tv' ||
          hasPermission(Permission.REQUEST_ADVANCED))));

  // The rows of the tile, after the status
  const details: {
    key: string;
    label: string;
    value: ReactNode;
    title?: string;
  }[] = [];
  if (requestData.type === 'tv' && requestData.seasons.length > 0) {
    details.push({
      key: 'seasons',
      label: intl.formatMessage(messages.labelSeasons),
      value: (
        <RequestSeasonBadges
          request={requestData}
          variant="text"
          className=""
        />
      ),
    });
  }
  if (requestData.type === 'comic' && requestData.comicVolumes?.length) {
    details.push({
      key: 'volumes',
      label: intl.formatMessage(messages.labelVolumes),
      value: formatVolumeRanges(requestData.comicVolumes),
    });
  }
  if (requestData.type === 'book') {
    details.push({
      key: 'format',
      label: intl.formatMessage(messages.labelFormat),
      value: intl.formatMessage(
        globalMessages[getBookRequestFormat(requestData)]
      ),
    });
  }
  // Managers see the same three rows on every card, "Default" when the
  // request does not override the server's own setting
  if (isManager) {
    const fallback = intl.formatMessage(messages.defaultSetting);
    details.push(
      {
        key: 'profile',
        label: intl.formatMessage(messages.labelProfile),
        value: request.profileName ?? fallback,
      },
      {
        key: 'folder',
        label: intl.formatMessage(messages.labelFolder),
        value: requestData.rootFolder ?? fallback,
        title: requestData.rootFolder ?? undefined,
      },
      {
        key: 'server',
        label: intl.formatMessage(messages.labelServer),
        value: serverName ?? fallback,
      }
    );
  } else if (request.profileName) {
    details.push({
      key: 'profile',
      label: intl.formatMessage(messages.labelProfile),
      value: request.profileName,
    });
  }
  if (
    requestData.status === MediaRequestStatus.DECLINED &&
    requestData.declineReason
  ) {
    details.push({
      key: 'declined',
      label: intl.formatMessage(messages.labelDeclined),
      value: requestData.declineReason,
      title: requestData.declineReason,
    });
  }

  const requestedAgo = (
    <FormattedRelativeTime
      value={secondsAgo(requestData.createdAt)}
      updateIntervalInSeconds={1}
      numeric="auto"
    />
  );
  const modifiedAgo = (
    <FormattedRelativeTime
      value={secondsAgo(requestData.updatedAt)}
      updateIntervalInSeconds={1}
      numeric="auto"
    />
  );
  const modified = requestData.modifiedBy
    ? intl.formatMessage(messages.byUser, {
        date: modifiedAgo,
        user: (
          <Link
            href={`/users/${requestData.modifiedBy.id}`}
            className="font-semibold text-as-ink-soft hover:text-as-ink hover:underline"
          >
            {requestData.modifiedBy.displayName}
          </Link>
        ),
      })
    : modifiedAgo;
  const requesterName = requestData.requestedBy.displayName;

  const askFirst = (label: string, run: () => void) => () =>
    setConfirm({ label, run });

  // Approve and decline stay in reach; everything else is in the menu
  const approveDecline = isPending && isManager && (
    <>
      <IconAction
        label={intl.formatMessage(messages.approve)}
        onClick={() => modifyRequest('approve')}
        disabled={updatingType !== null}
        className={cornerButtonOk}
      >
        {updatingType === 'approve' ? <Spinner /> : <CheckIcon />}
      </IconAction>
      <IconAction
        label={intl.formatMessage(messages.decline)}
        onClick={() => setShowDeclineModal(true)}
        disabled={updatingType !== null}
        className={cornerButtonBad}
      >
        {updatingType === 'decline' ? <Spinner /> : <XMarkIcon />}
      </IconAction>
    </>
  );

  type Entry = {
    key: string;
    icon: ReactNode;
    label: string;
    danger?: boolean;
  } & ({ onClick: () => void } | { href: string; external?: boolean });
  const entries: Entry[] = [];
  if (canEdit) {
    entries.push({
      key: 'edit',
      icon: <PencilIcon className="h-5 w-5" />,
      label: intl.formatMessage(messages.editRequest),
      onClick: () => setShowEditModal(true),
    });
  }
  if (requestData.status === MediaRequestStatus.FAILED && isManager) {
    entries.push({
      key: 'retry',
      icon: (
        <ArrowPathIcon
          className={`h-5 w-5 ${isRetrying ? 'animate-spin' : ''}`}
          style={{ animationDirection: 'reverse' }}
        />
      ),
      label: intl.formatMessage(
        isRetrying ? globalMessages.retrying : messages.retryRequest
      ),
      onClick: () => retryRequest(),
    });
  }
  if (canPlay && playUrl) {
    entries.push({
      key: 'play',
      icon: <PlayIcon className="h-5 w-5" />,
      label: intl.formatMessage(messages.playOn, { server: mediaServerName }),
      href: playUrl,
      external: true,
    });
  }
  if (isManager) {
    entries.push({
      key: 'manage',
      icon: <Cog6ToothIcon className="h-5 w-5" />,
      label: intl.formatMessage(messages.manageMedia),
      href: `${mediaPath}?manage=1`,
    });
  }
  if (hasPermission(Permission.ADMIN) && serviceUrl) {
    entries.push({
      key: 'arr',
      icon: <ArrowTopRightOnSquareIcon className="h-5 w-5" />,
      label: intl.formatMessage(messages.openInArr, {
        arr: arrName(requestData.type, settings.currentSettings.bookService),
      }),
      href: serviceUrl,
      external: true,
    });
  }
  if (!isPending && isManager) {
    const label = intl.formatMessage(messages.deleteRequest);
    entries.push({
      key: 'delete',
      icon: <TrashIcon className="h-5 w-5" />,
      label,
      danger: true,
      onClick: askFirst(label, () => deleteRequest()),
    });
    if (request.canRemove) {
      const removeLabel = intl.formatMessage(messages.removeFromArr, {
        arr: arrName(request.type, settings.currentSettings.bookService),
      });
      entries.push({
        key: 'remove',
        icon: <ServerStackIcon className="h-5 w-5" />,
        label: removeLabel,
        danger: true,
        onClick: askFirst(removeLabel, () => deleteMediaFile()),
      });
    }
  }
  if (isPending && !isManager && isOwn) {
    const label = intl.formatMessage(messages.cancelRequest);
    entries.push({
      key: 'cancel',
      icon: <XMarkIcon className="h-5 w-5" />,
      label,
      danger: true,
      onClick: askFirst(label, () => deleteRequest()),
    });
  }

  const actionsMenu = entries.length > 0 && (
    <Menu as="div" className="relative flex-none">
      <MenuButton
        className="flex h-8 w-8 items-center justify-center rounded-full bg-as-raised/80 text-as-ink-soft transition hover:bg-as-line hover:text-as-ink focus:outline-none"
        aria-label={intl.formatMessage(messages.actions, { title: titleName })}
      >
        <EllipsisVerticalIcon className="h-5 w-5" />
      </MenuButton>
      <MenuItems
        anchor="bottom end"
        className="z-50 w-60 rounded-2xl bg-as-surface p-1.5 shadow-xl shadow-black/40 ring-1 ring-as-line [--anchor-gap:4px] focus:outline-none"
      >
        {entries.map((entry) => (
          <MenuItem key={entry.key}>
            {({ focus }) => {
              const className = `${menuEntry} ${focus ? 'bg-as-raised' : ''} ${
                entry.danger ? 'text-[#f2b0aa]' : 'text-as-ink'
              }`;

              return 'href' in entry ? (
                entry.external ? (
                  <a
                    href={entry.href}
                    target="_blank"
                    rel="noreferrer"
                    className={className}
                  >
                    {entry.icon}
                    {entry.label}
                  </a>
                ) : (
                  <Link href={entry.href} className={className}>
                    {entry.icon}
                    {entry.label}
                  </Link>
                )
              ) : (
                <button
                  type="button"
                  onClick={entry.onClick}
                  className={className}
                >
                  {entry.icon}
                  {entry.label}
                </button>
              );
            }}
          </MenuItem>
        ))}
      </MenuItems>
    </Menu>
  );
  const actionCluster = (approveDecline || actionsMenu) && (
    <div className="flex items-center gap-1">
      {approveDecline}
      {actionsMenu}
    </div>
  );
  const confirmBar = confirm && (
    <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
      <span className="font-semibold text-as-ink">
        {intl.formatMessage(globalMessages.areyousure)}
      </span>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => {
            const { run } = confirm;
            setConfirm(null);
            run();
          }}
          className="h-8 rounded-full bg-[#3b2427] px-3 text-[13px] font-semibold text-[#f2b0aa] transition hover:brightness-110"
        >
          {confirm.label}
        </button>
        <button
          type="button"
          onClick={() => setConfirm(null)}
          className="h-8 rounded-full bg-as-raised px-3 text-[13px] font-semibold text-as-ink transition hover:bg-as-line"
        >
          {intl.formatMessage(messages.keep)}
        </button>
      </div>
    </div>
  );

  const status = (
    <RequestStatus
      requestData={requestData}
      downloads={downloads}
      titleName={titleName}
    />
  );
  const titleLink = (
    <Link
      href={mediaPath}
      className="line-clamp-1 text-[15px] font-bold leading-snug text-as-ink hover:underline"
    >
      {titleName}
    </Link>
  );
  const modals = (
    <>
      <DeclineRequestModal
        show={showDeclineModal}
        title={titleName}
        isUpdating={updatingType === 'decline'}
        onDecline={(reason) => modifyRequest('decline', reason)}
        onCancel={() => setShowDeclineModal(false)}
      />
      {request.type !== MediaType.COMIC && (
        <RequestModal
          show={showEditModal}
          tmdbId={request.media.tmdbId}
          mbId={request.media.mbId}
          olId={request.media.olId}
          type={request.type}
          is4k={request.is4k}
          editRequest={request}
          onCancel={() => setShowEditModal(false)}
          onComplete={() => {
            revalidateList();
            setShowEditModal(false);
          }}
        />
      )}
    </>
  );

  if (layout === 'list') {
    return (
      <>
        {modals}
        <article
          className={`grid grid-cols-[2.5rem_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 px-4 py-3 md:gap-y-0 ${REQUEST_LIST_GRID}`}
          data-testid="request-row"
        >
          <Link
            href={mediaPath}
            aria-label={titleName}
            className={`relative row-span-2 flex-none self-start overflow-hidden rounded-[8px] bg-as-tile md:row-span-1 md:self-center ${
              posterSquare ? 'h-10 w-10' : 'h-[60px] w-10'
            }`}
          >
            {poster}
          </Link>
          <div className="flex min-w-0 flex-col gap-0.5">
            {titleLink}
            <TypeLine request={requestData} extra={detail} />
          </div>
          <div className="flex items-center gap-1 md:contents">
            <div className="hidden min-w-0 md:flex">{status}</div>
            <div className="md:hidden">{actionCluster}</div>
          </div>
          <div className="col-span-2 flex min-w-0 flex-col gap-1.5 md:col-span-1">
            <div className="md:hidden">{status}</div>
            <div className="flex min-w-0 items-center gap-2 text-xs text-as-ink-muted">
              {showRequester && (
                <UserAvatar
                  id={requestData.requestedBy.id}
                  name={requesterName}
                  avatar={requestData.requestedBy.avatar}
                  size={22}
                />
              )}
              <span className="min-w-0 truncate">
                {showRequester && (
                  <>
                    <Link
                      href={`/users/${requestData.requestedBy.id}`}
                      className="font-semibold text-as-ink-soft hover:text-as-ink hover:underline"
                    >
                      {requesterName}
                    </Link>{' '}
                  </>
                )}
                {requestedAgo}
              </span>
            </div>
          </div>
          <div className="hidden min-w-0 flex-col text-xs text-as-ink-muted md:flex">
            {details.slice(0, 2).map((row) => (
              <span key={row.key} className="truncate" title={row.title}>
                <span className="text-as-ink-faint">{row.label}</span>{' '}
                {row.value}
              </span>
            ))}
          </div>
          <div className="hidden items-center justify-end md:flex">
            {actionCluster}
          </div>
          {confirmBar && <div className="col-span-full">{confirmBar}</div>}
        </article>
      </>
    );
  }

  const trailing = approveDecline ? 'pr-28' : actionsMenu ? 'pr-10' : '';

  return (
    <>
      {modals}
      <article className="flex flex-col gap-2" data-testid="request-card">
        <div className="relative overflow-hidden rounded-[18px] bg-as-surface">
          <CardArt backdrop={backdrop} />
          <div className="relative flex gap-4 p-3 sm:p-4">
            {/* The box is the size of a portrait poster for every card, so a
                square album cover sits centered in it and the tiles line up */}
            <Link
              href={mediaPath}
              aria-label={titleName}
              className="flex h-[180px] w-[120px] flex-none items-center self-center"
            >
              <span
                className={`relative block overflow-hidden rounded-[10px] bg-as-tile shadow-lg shadow-black/40 transition hover:opacity-90 ${
                  posterSquare ? 'h-[120px] w-[120px]' : 'h-full w-full'
                }`}
              >
                {poster}
              </span>
            </Link>
            <div className="flex min-w-0 flex-1 flex-col justify-between gap-3">
              <dl className={`flex min-w-0 flex-col gap-1 ${trailing}`}>
                <Detail label={intl.formatMessage(messages.labelStatus)}>
                  {status}
                </Detail>
                {details.map((row) => (
                  <Detail key={row.key} label={row.label} title={row.title}>
                    {row.value}
                  </Detail>
                ))}
                <Detail label={intl.formatMessage(messages.labelRequested)}>
                  {requestedAgo}
                </Detail>
                <Detail label={intl.formatMessage(messages.labelModified)}>
                  {modified}
                </Detail>
              </dl>
              {confirmBar}
            </div>
            {actionCluster && (
              <div className="absolute right-2 top-2">{actionCluster}</div>
            )}
          </div>
        </div>
        <div className="flex min-w-0 items-start gap-3 px-1">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            {titleLink}
            <TypeLine request={requestData} extra={detail} />
          </div>
          {showRequester && (
            <Link
              href={`/users/${requestData.requestedBy.id}`}
              className="group flex flex-none items-center gap-2 pt-0.5 text-xs text-as-ink-soft"
              title={intl.formatMessage(messages.requestedBy, {
                name: requesterName,
              })}
            >
              <span className="hidden max-w-[8rem] truncate group-hover:underline sm:inline">
                {requesterName}
              </span>
              <UserAvatar
                id={requestData.requestedBy.id}
                name={requesterName}
                avatar={requestData.requestedBy.avatar}
                size={28}
              />
            </Link>
          )}
        </div>
      </article>
    </>
  );
};

export default RequestCard;
