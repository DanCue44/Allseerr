import type { ServarrStatusMessage } from '@server/api/servarr/base';
import ChaptarrAPI from '@server/api/servarr/chaptarr';
import LidarrAPI from '@server/api/servarr/lidarr';
import RadarrAPI from '@server/api/servarr/radarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import { bookServiceName, usesChaptarr } from '@server/constants/bookService';
import {
  MediaRequestStatus,
  MediaType,
  type BookFormat,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import type { MediaRequest } from '@server/entity/MediaRequest';
import type { User } from '@server/entity/User';
import type { ArrTarget } from '@server/interfaces/api/arrActionInterfaces';
import type {
  DownloadItem,
  DownloadProtocol,
  DownloadRemoveBody,
  DownloadRemoveResponse,
  DownloadRequester,
  DownloadRetryImportResponse,
  DownloadServerError,
  DownloadService,
  DownloadStatus,
  DownloadTotals,
  DownloadsResponse,
} from '@server/interfaces/api/downloadInterfaces';
import { ArrActionError, searchAgain } from '@server/lib/arrActions';
import type { DVRSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { getStatusMessages } from '@server/lib/stuckDownloads';
import logger from '@server/logger';
import { uniqWith } from 'lodash';
import type { FindOptionsWhere } from 'typeorm';
import { In } from 'typeorm';

const LOG_LABEL = 'Downloads';

// The page refreshes every few seconds, so the arrs are asked at most this
// often however many admins have it open
export const DOWNLOADS_CACHE_MS = 5 * 1000;

interface QueueImage {
  coverType?: string;
  remoteUrl?: string;
}

/**
 * A download in a queue as the arrs send it with its movie, series, album
 * or book included. Only the fields read here are typed.
 */
export interface QueueRecord {
  id: number;
  title?: string;
  size?: number;
  sizeleft?: number;
  timeleft?: string;
  estimatedCompletionTime?: string;
  added?: string;
  status?: string;
  trackedDownloadStatus?: string;
  trackedDownloadState?: string;
  statusMessages?: ServarrStatusMessage[];
  errorMessage?: string;
  downloadId?: string;
  protocol?: string;
  downloadClient?: string;
  indexer?: string;
  seeders?: number;
  leechers?: number;
  quality?: { quality?: { name?: string } };
  outputPath?: string;
  movieId?: number;
  movie?: {
    title?: string;
    year?: number;
    tmdbId?: number;
    images?: QueueImage[];
  };
  seriesId?: number;
  episodeId?: number;
  seasonNumber?: number;
  series?: {
    title?: string;
    year?: number;
    tvdbId?: number;
    tmdbId?: number;
    images?: QueueImage[];
  };
  episode?: {
    id?: number;
    seasonNumber?: number;
    episodeNumber?: number;
    title?: string;
  };
  albumId?: number;
  artistId?: number;
  album?: {
    title?: string;
    foreignAlbumId?: string;
    releaseDate?: string;
    images?: QueueImage[];
    artist?: { artistName?: string };
  };
  artist?: { artistName?: string };
  bookId?: number;
  authorId?: number;
  book?: {
    title?: string;
    mediaType?: BookFormat;
    foreignBookId?: string;
    images?: QueueImage[];
    author?: { authorName?: string };
  };
}

/**
 * The arr ids a download is of, to link it to its media and act on it
 */
export interface DownloadRef {
  queueIds: number[];
  movieId?: number;
  seriesId?: number;
  episodeIds?: number[];
  albumId?: number;
  bookId?: number;
  bookFormat?: BookFormat;
  tmdbId?: number;
  tvdbId?: number;
  foreignAlbumId?: string;
  foreignBookId?: string;
  // The download client's id of the download, a torrent's info hash
  downloadId?: string;
}

export interface MappedDownload {
  item: DownloadItem;
  ref: DownloadRef;
}

/**
 * One arr, once per address, with the ids of every server setting that
 * points at it (a server can be set up twice, such as for two profiles)
 */
export interface DownloadServerGroup {
  service: DownloadService;
  server: DVRSettings;
  serverIds: number[];
}

const SERVICE_NAMES: Record<DownloadService, string> = {
  radarr: 'Radarr',
  sonarr: 'Sonarr',
  lidarr: 'Lidarr',
  chaptarr: 'Chaptarr',
};

// Book downloads are named after the book service, Chaptarr or Talearr
const serviceName = (service: DownloadService) =>
  service === 'chaptarr'
    ? bookServiceName(getSettings().bookService)
    : SERVICE_NAMES[service];

const sameAddress = (a: DVRSettings, b: DVRSettings) =>
  a.hostname === b.hostname && a.port === b.port && a.baseUrl === b.baseUrl;

const groupServers = (
  service: DownloadService,
  servers: DVRSettings[]
): DownloadServerGroup[] =>
  uniqWith(servers, sameAddress).map((server) => ({
    service,
    server,
    serverIds: servers
      .filter((other) => sameAddress(other, server))
      .map((other) => other.id),
  }));

/**
 * Every Radarr, Sonarr and Lidarr server, 4K ones too, and the Chaptarr
 * servers when Chaptarr is the book service
 */
export const getDownloadServers = (): DownloadServerGroup[] => {
  const settings = getSettings();

  return [
    ...groupServers('radarr', settings.radarr),
    ...groupServers('sonarr', settings.sonarr),
    ...groupServers('lidarr', settings.lidarr),
    ...(usesChaptarr(settings.bookService)
      ? groupServers('chaptarr', settings.chaptarr)
      : []),
  ];
};

const createApi = ({ service, server }: DownloadServerGroup) => {
  switch (service) {
    case 'radarr':
      return new RadarrAPI({
        apiKey: server.apiKey,
        url: RadarrAPI.buildUrl(server, '/api/v3'),
      });
    case 'sonarr':
      return new SonarrAPI({
        apiKey: server.apiKey,
        url: SonarrAPI.buildUrl(server, '/api/v3'),
      });
    case 'lidarr':
      return new LidarrAPI({
        apiKey: server.apiKey,
        url: LidarrAPI.buildUrl(server, '/api/v1'),
      });
    case 'chaptarr':
      return new ChaptarrAPI({
        apiKey: server.apiKey,
        url: ChaptarrAPI.buildUrl(server, '/api/v1'),
      });
  }
};

const fetchQueue = async (
  group: DownloadServerGroup
): Promise<QueueRecord[]> => {
  const api = createApi(group);

  switch (group.service) {
    case 'radarr':
      return api.getQueueRecords<QueueRecord>({
        includeMovie: true,
        includeUnknownMovieItems: true,
      });
    case 'sonarr':
      return api.getQueueRecords<QueueRecord>({
        includeSeries: true,
        includeEpisode: true,
        includeUnknownSeriesItems: true,
      });
    case 'lidarr':
      return api.getQueueRecords<QueueRecord>({
        includeArtist: true,
        includeAlbum: true,
        includeUnknownArtistItems: true,
      });
    case 'chaptarr':
      return (await (api as ChaptarrAPI).getBookQueue()) as QueueRecord[];
  }
};

/**
 * Seconds in a time left the way the arrs send it: hh:mm:ss, with the days
 * in front (d.hh:mm:ss) past a day
 */
export const parseTimeLeft = (value?: string): number | undefined => {
  const match = value?.match(/^(?:(\d+)\.)?(\d+):(\d{2}):(\d{2})/);

  if (!match) {
    return undefined;
  }

  const [, days, hours, minutes, seconds] = match;

  return (
    Number(days ?? 0) * 86_400 +
    Number(hours) * 3600 +
    Number(minutes) * 60 +
    Number(seconds)
  );
};

// What download clients say about a torrent nobody seeds or a download that
// stopped moving, as the arrs pass it on
const STALLED_MESSAGE = /stalled|no connections|no seeds|not enough seeders/i;

/**
 * One status for a download from the arr's status (what the download client
 * says) and its tracked state (where the arr is with it)
 */
export const mapDownloadStatus = (record: QueueRecord): DownloadStatus => {
  const status = record.status?.toLowerCase() ?? '';
  const state = record.trackedDownloadState?.toLowerCase() ?? '';
  const tracked = record.trackedDownloadStatus?.toLowerCase() ?? '';

  if (
    ['failed', 'failedpending', 'importfailed'].includes(state) ||
    status === 'failed' ||
    tracked === 'error'
  ) {
    return 'failed';
  }
  if (state === 'importing') {
    return 'importing';
  }
  if (state === 'imported') {
    return 'completed';
  }
  if (state === 'importblocked') {
    return 'warning';
  }
  if (
    status === 'warning' ||
    status === 'downloadclientunavailable' ||
    tracked === 'warning'
  ) {
    return status === 'stalled' ||
      getStatusMessages(record).some((message) => STALLED_MESSAGE.test(message))
      ? 'stalled'
      : 'warning';
  }
  if (state === 'importpending' || status === 'completed') {
    return 'importPending';
  }
  if (status === 'paused') {
    return 'paused';
  }
  if (status === 'downloading') {
    return 'downloading';
  }
  if (status === 'stalled') {
    return 'stalled';
  }

  // queued, delay and anything newer the arrs add
  return 'queued';
};

export const ATTENTION_STATUSES: DownloadStatus[] = [
  'failed',
  'stalled',
  'warning',
];

/**
 * How far along a download is, from 0 to 1. Downloads the arr is importing
 * are done downloading.
 */
export const getProgress = (
  size: number,
  sizeLeft: number,
  status: DownloadStatus
): number => {
  if (['importing', 'importPending', 'completed'].includes(status)) {
    return 1;
  }
  if (!size || size <= 0) {
    return 0;
  }

  return Math.min(1, Math.max(0, (size - sizeLeft) / size));
};

const toProtocol = (value?: string): DownloadProtocol =>
  value === 'usenet' || value === 'torrent' ? value : 'unknown';

const pickImage = (images: QueueImage[] | undefined, types: string[]) =>
  images?.find(
    (image) =>
      types.includes(image.coverType?.toLowerCase() ?? '') &&
      /^https?:\/\//.test(image.remoteUrl ?? '')
  )?.remoteUrl;

const positiveId = (value?: number) =>
  typeof value === 'number' && value > 0 ? value : undefined;

const yearOf = (date?: string) => {
  const year = date ? new Date(date).getFullYear() : NaN;
  return Number.isFinite(year) ? year : undefined;
};

const optionalNumber = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

/**
 * What the download is of, from the item the arr includes with it
 */
const describeRecord = (
  service: DownloadService,
  record: QueueRecord
): Pick<
  DownloadItem,
  | 'mediaType'
  | 'title'
  | 'year'
  | 'seasonNumber'
  | 'episodeNumbers'
  | 'episodeTitle'
  | 'artistName'
  | 'authorName'
  | 'posterUrl'
  | 'backdropUrl'
> & { ref: Omit<DownloadRef, 'queueIds'> } => {
  const releaseTitle = record.title ?? '';

  switch (service) {
    case 'radarr':
      return {
        mediaType: 'movie',
        title: record.movie?.title || releaseTitle,
        year: optionalNumber(record.movie?.year) || undefined,
        posterUrl: pickImage(record.movie?.images, ['poster']),
        backdropUrl: pickImage(record.movie?.images, ['fanart']),
        ref: {
          movieId: positiveId(record.movieId),
          tmdbId: positiveId(record.movie?.tmdbId),
        },
      };
    case 'sonarr': {
      const seasonNumber = record.episode?.seasonNumber ?? record.seasonNumber;
      const episodeNumber = record.episode?.episodeNumber;
      const episodeId = positiveId(record.episodeId ?? record.episode?.id);

      return {
        mediaType: 'tv',
        title: record.series?.title || releaseTitle,
        year: optionalNumber(record.series?.year) || undefined,
        seasonNumber,
        episodeNumbers: episodeNumber !== undefined ? [episodeNumber] : [],
        episodeTitle: record.episode?.title || undefined,
        posterUrl: pickImage(record.series?.images, ['poster']),
        backdropUrl: pickImage(record.series?.images, ['fanart']),
        ref: {
          seriesId: positiveId(record.seriesId),
          episodeIds: episodeId ? [episodeId] : [],
          tvdbId: positiveId(record.series?.tvdbId),
          tmdbId: positiveId(record.series?.tmdbId),
        },
      };
    }
    case 'lidarr':
      return {
        mediaType: 'music',
        title: record.album?.title || releaseTitle,
        year: yearOf(record.album?.releaseDate),
        artistName:
          record.artist?.artistName ||
          record.album?.artist?.artistName ||
          undefined,
        posterUrl: pickImage(record.album?.images, ['cover']),
        ref: {
          albumId: positiveId(record.albumId),
          foreignAlbumId: record.album?.foreignAlbumId || undefined,
        },
      };
    case 'chaptarr':
      return {
        mediaType:
          record.book?.mediaType === 'audiobook' ? 'audiobook' : 'ebook',
        title: record.book?.title || releaseTitle,
        authorName: record.book?.author?.authorName || undefined,
        posterUrl: pickImage(record.book?.images, ['cover', 'poster']),
        ref: {
          bookId: positiveId(record.bookId),
          bookFormat: record.book?.mediaType,
          foreignBookId: record.book?.foreignBookId || undefined,
        },
      };
  }
};

const mapRecord = (
  group: DownloadServerGroup,
  record: QueueRecord
): MappedDownload => {
  const { ref, ...described } = describeRecord(group.service, record);
  const size = optionalNumber(record.size) ?? 0;
  const sizeLeft = optionalNumber(record.sizeleft) ?? 0;
  const status = mapDownloadStatus(record);
  const messages = getStatusMessages(record);
  const errorMessage = record.errorMessage?.trim() || undefined;

  return {
    item: {
      id: `${group.service}:${group.server.id}:${record.id}`,
      service: group.service,
      serverId: group.server.id,
      serverName: group.server.name || serviceName(group.service),
      is4k: !!group.server.is4k,
      ...described,
      releaseTitle: record.title ?? '',
      protocol: toProtocol(record.protocol),
      downloadClient: record.downloadClient || undefined,
      indexer: record.indexer || undefined,
      size,
      sizeLeft,
      progress: getProgress(size, sizeLeft, status),
      timeLeft: record.timeleft || undefined,
      timeLeftSeconds: parseTimeLeft(record.timeleft),
      estimatedCompletionTime: record.estimatedCompletionTime || undefined,
      status,
      arrStatus: record.status || undefined,
      trackedDownloadState: record.trackedDownloadState || undefined,
      trackedDownloadStatus: record.trackedDownloadStatus || undefined,
      // The error message is kept apart, it is shown on its own
      statusMessages: messages.filter((message) => message !== errorMessage),
      errorMessage,
      needsAttention: ATTENTION_STATUSES.includes(status),
      added: record.added || undefined,
      seeders: optionalNumber(record.seeders),
      leechers: optionalNumber(record.leechers),
      quality: record.quality?.quality?.name || undefined,
      outputPath: record.outputPath || undefined,
      canSearch: false,
      ...(group.service === 'chaptarr' &&
        !!record.downloadId &&
        /importblocked|importfailed/i.test(
          record.trackedDownloadState ?? ''
        ) && { canRetryImport: true }),
    },
    ref: {
      queueIds: [record.id],
      ...ref,
      ...(record.downloadId && { downloadId: record.downloadId }),
    },
  };
};

/**
 * Turns one arr's queue into downloads. Sonarr lists a season pack once per
 * episode, so its episodes are gathered into one download.
 */
export const mapQueueRecords = (
  group: DownloadServerGroup,
  records: QueueRecord[]
): MappedDownload[] => {
  const downloads: MappedDownload[] = [];
  const packs = new Map<string, MappedDownload>();

  for (const record of records) {
    if (!record || typeof record.id !== 'number') {
      continue;
    }

    const mapped = mapRecord(group, record);
    const pack =
      group.service === 'sonarr' && record.downloadId
        ? packs.get(record.downloadId)
        : undefined;

    if (pack) {
      pack.ref.queueIds.push(record.id);
      pack.ref.episodeIds = [
        ...(pack.ref.episodeIds ?? []),
        ...(mapped.ref.episodeIds ?? []),
      ];
      pack.item.episodeNumbers = [
        ...new Set([
          ...(pack.item.episodeNumbers ?? []),
          ...(mapped.item.episodeNumbers ?? []),
        ]),
      ].sort((a, b) => a - b);
      if (pack.item.seasonNumber !== mapped.item.seasonNumber) {
        pack.item.seasonNumber = undefined;
      }
      pack.item.episodeTitle = undefined;
      continue;
    }

    if (group.service === 'sonarr' && record.downloadId) {
      packs.set(record.downloadId, mapped);
    }
    downloads.push(mapped);
  }

  for (const { item, ref } of downloads) {
    item.canSearch = canSearch(group.service, ref);
  }

  return downloads;
};

const canSearch = (service: DownloadService, ref: DownloadRef): boolean => {
  switch (service) {
    case 'radarr':
      return !!ref.movieId;
    case 'sonarr':
      return (ref.episodeIds?.length ?? 0) > 0;
    case 'lidarr':
      return !!ref.albumId;
    case 'chaptarr':
      return !!ref.bookId;
  }
};

const ACTIVE_REQUEST = [
  MediaRequestStatus.PENDING,
  MediaRequestStatus.APPROVED,
];

/**
 * Who asked for what a download is of: a request still on its way before a
 * finished one, one for the season in the download before one for another,
 * then the newest. Declined requests are left out.
 */
export const pickRequester = (
  media: Media,
  {
    is4k = false,
    bookFormat,
    seasonNumber,
  }: { is4k?: boolean; bookFormat?: BookFormat; seasonNumber?: number }
): DownloadRequester | undefined => {
  const score = (request: MediaRequest) =>
    (ACTIVE_REQUEST.includes(request.status) ? 2 : 0) +
    (seasonNumber !== undefined &&
    (request.seasons ?? []).some(
      (season) => season.seasonNumber === seasonNumber
    )
      ? 1
      : 0);
  const [request] = (media.requests ?? [])
    .filter(
      (request) =>
        !!request.requestedBy &&
        request.status !== MediaRequestStatus.DECLINED &&
        (media.mediaType === MediaType.BOOK
          ? !!request.isAudiobook === (bookFormat === 'audiobook')
          : !!request.is4k === is4k)
    )
    .sort(
      (a, b) =>
        score(b) - score(a) ||
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );

  if (!request) {
    return undefined;
  }

  return {
    id: request.requestedBy.id,
    displayName: request.requestedBy.displayName,
    avatar: request.requestedBy.avatar,
  };
};

const unique = <T>(values: (T | undefined)[]): T[] => [
  ...new Set(values.filter((value): value is T => value !== undefined)),
];

/**
 * Looks up the media in Allseerr each download is of: by the arr ids the
 * media was linked with first, then by TMDB, TVDB, MusicBrainz or work id,
 * and adds the media ids, the target of the arr actions and the requester
 */
export const linkDownloads = async (
  group: DownloadServerGroup,
  downloads: MappedDownload[]
): Promise<void> => {
  if (downloads.length === 0) {
    return;
  }

  const ids = group.serverIds;
  const is4k = !!group.server.is4k;
  const refs = downloads.map(({ ref }) => ref);
  const where: FindOptionsWhere<Media>[] = [];
  let byArrId: (media: Media, ref: DownloadRef) => boolean;
  let byForeignId: (media: Media, ref: DownloadRef) => boolean;

  switch (group.service) {
    case 'radarr':
    case 'sonarr': {
      const mediaType =
        group.service === 'radarr' ? MediaType.MOVIE : MediaType.TV;
      const arrIdOf = (ref: DownloadRef) =>
        group.service === 'radarr' ? ref.movieId : ref.seriesId;
      const arrIds = unique(refs.map(arrIdOf));
      const tmdbIds = unique(refs.map((ref) => ref.tmdbId));
      const tvdbIds = unique(refs.map((ref) => ref.tvdbId));

      if (arrIds.length) {
        where.push(
          is4k
            ? {
                mediaType,
                serviceId4k: In(ids),
                externalServiceId4k: In(arrIds),
              }
            : { mediaType, serviceId: In(ids), externalServiceId: In(arrIds) }
        );
      }
      if (tmdbIds.length) {
        where.push({ mediaType, tmdbId: In(tmdbIds) });
      }
      if (group.service === 'sonarr' && tvdbIds.length) {
        where.push({ mediaType, tvdbId: In(tvdbIds) });
      }

      byArrId = (media, ref) =>
        media.mediaType === mediaType &&
        !!arrIdOf(ref) &&
        (is4k
          ? ids.includes(media.serviceId4k ?? -1) &&
            media.externalServiceId4k === arrIdOf(ref)
          : ids.includes(media.serviceId ?? -1) &&
            media.externalServiceId === arrIdOf(ref));
      byForeignId = (media, ref) =>
        media.mediaType === mediaType &&
        ((!!ref.tmdbId && media.tmdbId === ref.tmdbId) ||
          (group.service === 'sonarr' &&
            !!ref.tvdbId &&
            media.tvdbId === ref.tvdbId));
      break;
    }
    case 'lidarr': {
      const albumIds = unique(refs.map((ref) => ref.albumId));
      const mbIds = unique(refs.map((ref) => ref.foreignAlbumId));

      if (albumIds.length) {
        where.push({
          mediaType: MediaType.MUSIC,
          serviceId: In(ids),
          externalServiceId: In(albumIds),
        });
      }
      if (mbIds.length) {
        where.push({ mediaType: MediaType.MUSIC, mbId: In(mbIds) });
      }

      byArrId = (media, ref) =>
        media.mediaType === MediaType.MUSIC &&
        !!ref.albumId &&
        ids.includes(media.serviceId ?? -1) &&
        media.externalServiceId === ref.albumId;
      byForeignId = (media, ref) =>
        media.mediaType === MediaType.MUSIC &&
        !!ref.foreignAlbumId &&
        media.mbId === ref.foreignAlbumId;
      break;
    }
    case 'chaptarr': {
      const bookIds = unique(refs.map((ref) => ref.bookId));
      const workIds = unique(refs.map((ref) => ref.foreignBookId));

      if (bookIds.length) {
        where.push(
          {
            mediaType: MediaType.BOOK,
            serviceId: In(ids),
            externalServiceId: In(bookIds),
          },
          {
            mediaType: MediaType.BOOK,
            serviceId: In(ids),
            externalServiceIdAudio: In(bookIds),
          }
        );
      }
      if (workIds.length) {
        where.push({ mediaType: MediaType.BOOK, foreignBookId: In(workIds) });
      }

      byArrId = (media, ref) =>
        media.mediaType === MediaType.BOOK &&
        !!ref.bookId &&
        ids.includes(media.serviceId ?? -1) &&
        (media.externalServiceId === ref.bookId ||
          media.externalServiceIdAudio === ref.bookId);
      byForeignId = (media, ref) =>
        media.mediaType === MediaType.BOOK &&
        !!ref.foreignBookId &&
        media.foreignBookId === ref.foreignBookId;
      break;
    }
  }

  const medias = where.length
    ? await getRepository(Media).find({
        where,
        relations: { requests: { requestedBy: true, seasons: true } },
      })
    : [];

  for (const { item, ref } of downloads) {
    const media =
      medias.find((m) => byArrId(m, ref)) ??
      medias.find((m) => byForeignId(m, ref));

    if (!media) {
      continue;
    }

    let bookFormat = ref.bookFormat;
    if (group.service === 'chaptarr' && !bookFormat) {
      bookFormat =
        ref.bookId &&
        media.externalServiceIdAudio === ref.bookId &&
        media.externalServiceId !== ref.bookId
          ? 'audiobook'
          : 'ebook';
      ref.bookFormat = bookFormat;
      item.mediaType = bookFormat;
    }

    item.mediaId = media.id;
    item.tmdbId = media.tmdbId || undefined;
    item.tvdbId = media.tvdbId || undefined;
    item.mbId = media.mbId || undefined;
    item.olId = media.olId || undefined;
    item.target = getTarget(group, item, bookFormat);
    item.requester = pickRequester(media, {
      is4k,
      bookFormat,
      seasonNumber: item.seasonNumber,
    });
  }
};

const getTarget = (
  group: DownloadServerGroup,
  item: DownloadItem,
  bookFormat?: BookFormat
): ArrTarget => {
  switch (group.service) {
    case 'radarr':
      return { is4k: !!group.server.is4k };
    case 'sonarr':
      return {
        is4k: !!group.server.is4k,
        ...(item.seasonNumber !== undefined && {
          seasonNumber: item.seasonNumber,
          ...(item.episodeNumbers?.length === 1 && {
            episodeNumber: item.episodeNumbers[0],
          }),
        }),
      };
    case 'lidarr':
      return {};
    case 'chaptarr':
      return { bookFormat: bookFormat ?? 'ebook' };
  }
};

/**
 * One arr's downloads, linked to the media in Allseerr. Fails when the arr
 * does not answer; a failed media lookup only leaves the links out.
 */
export const loadServerDownloads = async (
  group: DownloadServerGroup,
  fetch: (group: DownloadServerGroup) => Promise<QueueRecord[]> = fetchQueue
): Promise<MappedDownload[]> => {
  const downloads = mapQueueRecords(group, await fetch(group));

  try {
    await linkDownloads(group, downloads);
  } catch (e) {
    logger.warn('Unable to link downloads to their media', {
      label: LOG_LABEL,
      server: group.server.name,
      errorMessage: e.message,
    });
  }

  return downloads;
};

// Failed and stuck downloads first, then the ones moving, then the waiting
const STATUS_ORDER: DownloadStatus[] = [
  'failed',
  'stalled',
  'warning',
  'downloading',
  'importing',
  'importPending',
  'paused',
  'queued',
  'completed',
];

export const sortDownloads = (items: DownloadItem[]): DownloadItem[] =>
  [...items].sort(
    (a, b) =>
      STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) ||
      b.progress - a.progress ||
      a.title.localeCompare(b.title) ||
      a.id.localeCompare(b.id)
  );

export const getTotals = (items: DownloadItem[]): DownloadTotals => ({
  total: items.length,
  downloading: items.filter((item) => item.status === 'downloading').length,
  queued: items.filter(
    (item) => item.status === 'queued' || item.status === 'paused'
  ).length,
  attention: items.filter((item) => item.needsAttention).length,
});

/**
 * Reads every arr's queue at once. An arr that does not answer is listed in
 * serverErrors, the others are shown anyway.
 */
export const collectDownloads = async (
  groups: DownloadServerGroup[],
  fetch: (group: DownloadServerGroup) => Promise<QueueRecord[]> = fetchQueue,
  now = Date.now()
): Promise<DownloadsResponse> => {
  const serverErrors: DownloadServerError[] = [];
  const loaded = await Promise.all(
    groups.map(async (group) => {
      try {
        return await loadServerDownloads(group, fetch);
      } catch (e) {
        logger.warn('Unable to read the queue of a server', {
          label: LOG_LABEL,
          service: group.service,
          server: group.server.name,
          errorMessage: e.message,
        });
        serverErrors.push({
          service: group.service,
          serverId: group.server.id,
          serverName: group.server.name || serviceName(group.service),
          message: e.message,
        });
        return [];
      }
    })
  );
  const results = sortDownloads(loaded.flat().map(({ item }) => item));

  return {
    results,
    totals: getTotals(results),
    serverErrors: serverErrors.sort(
      (a, b) => a.service.localeCompare(b.service) || a.serverId - b.serverId
    ),
    updatedAt: new Date(now).toISOString(),
  };
};

let cache: { at: number; data: DownloadsResponse } | undefined;
let pending: Promise<DownloadsResponse> | undefined;

export const clearDownloadsCache = (): void => {
  cache = undefined;
};

/**
 * Every download of every arr, answered from a short cache. Callers asking
 * at the same time share one read of the queues.
 */
export const getDownloads = async ({
  maxAgeMs = DOWNLOADS_CACHE_MS,
  now = Date.now(),
}: { maxAgeMs?: number; now?: number } = {}): Promise<DownloadsResponse> => {
  if (cache && now - cache.at < maxAgeMs) {
    return cache.data;
  }

  if (!pending) {
    pending = collectDownloads(getDownloadServers())
      .then((data) => {
        cache = { at: Date.now(), data };
        return data;
      })
      .finally(() => {
        pending = undefined;
      });
  }

  return pending;
};

const DOWNLOAD_ID = /^(radarr|sonarr|lidarr|chaptarr):(\d+):(\d+)$/;

/**
 * Finds a download in its arr's queue as it is right now
 */
const findDownload = async (
  id: string
): Promise<{ group: DownloadServerGroup; download: MappedDownload }> => {
  const match = id.match(DOWNLOAD_ID);

  if (!match) {
    throw new ArrActionError(400, 'Invalid download id.');
  }

  const [, service, serverId] = match;
  const group = getDownloadServers().find(
    (g) => g.service === service && g.serverIds.includes(Number(serverId))
  );

  if (!group) {
    throw new ArrActionError(404, 'This server is not set up.');
  }

  const scoped = id.replace(
    /^(\w+):\d+:/,
    `${group.service}:${group.server.id}:`
  );
  const download = (await loadServerDownloads(group)).find(
    ({ item }) => item.id === scoped
  );

  if (!download) {
    throw new ArrActionError(404, 'This download is no longer in the queue.');
  }

  return { group, download };
};

/**
 * Starts a new search in the arr for what a download is of: the movie, the
 * episodes, the album or the book. Books in Allseerr are readied first the
 * way the admin search action does.
 */
const searchFor = async (
  group: DownloadServerGroup,
  { item, ref }: MappedDownload,
  user: User
): Promise<void> => {
  if (!item.canSearch) {
    throw new ArrActionError(
      409,
      `${item.serverName} does not say what this download is of.`
    );
  }

  if (group.service === 'chaptarr' && item.mediaId && item.target) {
    const media = await getRepository(Media).findOne({
      where: { id: item.mediaId },
    });

    if (media) {
      await searchAgain(media, item.target, user);
      return;
    }
  }

  const api = createApi(group);

  switch (group.service) {
    case 'radarr':
      await api.startSearch('MoviesSearch', { movieIds: [ref.movieId] });
      break;
    case 'sonarr':
      await api.startSearch('EpisodeSearch', { episodeIds: ref.episodeIds });
      break;
    case 'lidarr':
      await api.startSearch('AlbumSearch', { albumIds: [ref.albumId] });
      break;
    case 'chaptarr':
      await api.startSearch('BookSearch', { bookIds: [ref.bookId] });
      break;
  }

  logger.info('Started a search for a download', {
    label: LOG_LABEL,
    server: item.serverName,
    title: item.title,
    userId: user.id,
  });
};

/**
 * Has the book service try a stuck import again, such as one whose book
 * changed after the grab, and says whether the download is in now or why
 * it is still stuck
 */
export const retryImportDownload = async (
  id: string,
  user: User
): Promise<DownloadRetryImportResponse> => {
  const { group, download } = await findDownload(id);
  const downloadId = download.ref.downloadId;

  if (!download.item.canRetryImport || !downloadId) {
    throw new ArrActionError(
      409,
      `${download.item.serverName} has no stuck import to retry for this download.`
    );
  }

  const api = createApi(group) as ChaptarrAPI;
  const result = await api.retryImport(downloadId);

  logger.info('Retried the import of a download', {
    label: LOG_LABEL,
    server: download.item.serverName,
    title: download.item.title,
    userId: user.id,
    finished: result.finished,
    error: result.error,
  });

  clearDownloadsCache();

  if (!result.finished) {
    return { imported: false, pending: true };
  }

  // Still in the queue means the import is stuck again, with its reason
  const after = (await loadServerDownloads(group)).find(
    ({ ref }) => ref.downloadId === downloadId
  );

  if (!after) {
    return { imported: true };
  }

  return {
    imported: false,
    message:
      result.error ||
      after.item.errorMessage ||
      after.item.statusMessages[0] ||
      undefined,
  };
};

export const searchDownload = async (id: string, user: User): Promise<void> => {
  const { group, download } = await findDownload(id);

  await searchFor(group, download, user);
  clearDownloadsCache();
};

/**
 * Removes a download from its arr's queue and, unless told not to, from the
 * download client, blocklisting its release when asked, then searches again
 * when asked. The arr is kept from searching by itself.
 */
export const removeDownload = async (
  id: string,
  user: User,
  {
    removeFromClient = true,
    blocklist = false,
    search = false,
  }: DownloadRemoveBody = {}
): Promise<DownloadRemoveResponse> => {
  const { group, download } = await findDownload(id);
  const api = createApi(group);
  const [first, ...rest] = download.ref.queueIds;

  await api.removeQueueItem(first, { blocklist, removeFromClient });
  // The other episodes of a season pack are the same download
  for (const queueId of rest) {
    await api
      .removeQueueItem(queueId, { blocklist: false, removeFromClient: false })
      .catch(() => undefined);
  }
  clearDownloadsCache();

  logger.info('Removed a download from the queue', {
    label: LOG_LABEL,
    server: download.item.serverName,
    title: download.item.releaseTitle,
    removeFromClient,
    blocklist,
    userId: user.id,
  });

  const result: DownloadRemoveResponse = {
    removed: true,
    blocklisted: blocklist,
    searched: false,
  };

  if (search) {
    try {
      await searchFor(group, download, user);
      result.searched = true;
    } catch (e) {
      logger.warn('Removed a download but could not search again', {
        label: LOG_LABEL,
        title: download.item.releaseTitle,
        errorMessage: e.message,
      });
      result.searchError = e.message;
    }
  }

  return result;
};
