import LazyLibrarianAPI, {
  getLazyLibrarianState,
  isLazyLibrarianConfigured,
} from '@server/api/lazylibrarian';
import type {
  ServarrHistoryRecord,
  ServarrRelease,
} from '@server/api/servarr/base';
import ChaptarrAPI, { getBookFileCount } from '@server/api/servarr/chaptarr';
import LidarrAPI from '@server/api/servarr/lidarr';
import type { RadarrMovie } from '@server/api/servarr/radarr';
import RadarrAPI from '@server/api/servarr/radarr';
import type { EpisodeResult } from '@server/api/servarr/sonarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import type { BookLanguage } from '@server/constants/bookLanguages';
import {
  getEffectiveBookLanguage,
  isBookLanguage,
} from '@server/constants/bookLanguages';
import {
  bookServiceName,
  isTalearrService,
} from '@server/constants/bookService';
import { IssueStatus } from '@server/constants/issue';
import type { BookFormat } from '@server/constants/media';
import { MediaStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Issue from '@server/entity/Issue';
import IssueComment from '@server/entity/IssueComment';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import type { User } from '@server/entity/User';
import type {
  ArrActionName,
  ArrActionResponse,
  ArrEpisode,
  ArrItemResponse,
  ArrRelease,
  ArrReleaseGrabState,
  ArrReplaceBody,
  ArrReplaceResponse,
  ArrServiceName,
  ArrTarget,
} from '@server/interfaces/api/arrActionInterfaces';
import {
  getChaptarrFormatSettings,
  getChaptarrLibraryBook,
  linkChaptarrBook,
  matchChaptarrLibraryBook,
  prepareChaptarrBookSearch,
} from '@server/lib/chaptarrRequests';
import { getMediaServiceSettings } from '@server/lib/mediaFiles';
import { Permission } from '@server/lib/permissions';
import { getDefaultChaptarr, getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { IsNull } from 'typeorm';

/**
 * An action that cannot be done, with the status the API answers with
 */
export class ArrActionError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

/**
 * One movie, season, episode, album or book format in an arr, with what
 * can be done to it there
 */
export interface ArrItem {
  service: ArrServiceName;
  serviceName: string;
  title: string;
  hasFile: boolean;
  episodes?: ArrEpisode[];
  // Actions the arr cannot do for this item, with the reason
  unavailable: Partial<Record<ArrActionName, string>>;
  search(): Promise<void>;
  getReleases(): Promise<ArrRelease[]>;
  grab(release: { guid: string; indexerId: number }): Promise<void>;
  getFileIds(): Promise<number[]>;
  deleteFiles(fileIds: number[]): Promise<void>;
  // The grabs that brought in the current files
  getGrabs(): Promise<ServarrHistoryRecord[]>;
  // Every history record of the item, to recognize releases grabbed before
  getHistory?(): Promise<ServarrHistoryRecord[]>;
  // The arr's queue, to tell a grab still downloading from one long gone
  getQueue?(): Promise<GrabQueueRecord[]>;
  markFailed(historyId: number): Promise<void>;
}

const LOG_LABEL = 'Arr Actions';

const ACTIONS: ArrActionName[] = ['search', 'interactive', 'replace'];

const NO_FILE_REASON = 'There is no file to replace.';

/**
 * Turns a release from any arr into the shape the UI lists. Releases a
 * Chaptarr filter hid are never approved.
 */
export const normalizeRelease = (
  raw: ServarrRelease,
  {
    hidden = false,
    serviceName = 'Chaptarr',
    rejectionLabels = false,
  }: {
    hidden?: boolean;
    // The book service a hidden release was filtered by
    serviceName?: string;
    // Talearr labels every rejection, such as "Language" or "Pack"
    rejectionLabels?: boolean;
  } = {}
): ArrRelease => {
  const protocol =
    raw.protocol === 'torrent' || raw.protocol === 'usenet'
      ? raw.protocol
      : 'unknown';
  const rejections = (raw.rejections ?? [])
    .map((rejection) =>
      typeof rejection === 'string'
        ? rejection
        : (rejection?.reason ?? rejection?.message ?? '')
    )
    .filter((rejection) => rejection.length > 0);
  const labels = rejectionLabels
    ? [
        ...new Set(
          (raw.rejectionDetails ?? [])
            .map((detail) =>
              typeof detail?.label === 'string' ? detail.label.trim() : ''
            )
            .filter((label) => label.length > 0)
        ),
      ]
    : [];
  const ageHours =
    typeof raw.ageHours === 'number'
      ? raw.ageHours
      : raw.publishDate
        ? Math.max(0, (Date.now() - Date.parse(raw.publishDate)) / 3_600_000)
        : 0;

  return {
    guid: raw.guid,
    indexerId: raw.indexerId,
    title: raw.title ?? '',
    size: raw.size ?? 0,
    ageHours: Number.isFinite(ageHours) ? ageHours : 0,
    indexer: raw.indexer ?? '',
    protocol,
    ...(protocol === 'torrent' && {
      seeders: raw.seeders ?? undefined,
      leechers: raw.leechers ?? undefined,
    }),
    quality: raw.quality?.quality?.name ?? 'Unknown',
    qualityWeight: raw.qualityWeight ?? 0,
    languages: (raw.languages ?? [])
      .map((language) => language?.name ?? '')
      .filter((name) => name.length > 0),
    approved: !hidden && !!raw.approved,
    rejections:
      hidden && rejections.length === 0
        ? [`Hidden by a release filter in ${serviceName}`]
        : rejections,
    ...(labels.length > 0 && { rejectionLabels: labels }),
    ...(typeof raw.customFormatScore === 'number' && {
      customFormatScore: raw.customFormatScore,
    }),
    ...(raw.releaseGroup && { releaseGroup: raw.releaseGroup }),
    ...(raw.infoUrl && { infoUrl: raw.infoUrl }),
    ...(typeof raw.infoHash === 'string' &&
      raw.infoHash && { infoHash: raw.infoHash }),
  };
};

/**
 * A download in an arr's queue, only the fields that place an earlier grab
 */
export interface GrabQueueRecord {
  downloadId?: string;
  trackedDownloadState?: string;
  downloadClient?: string;
}

const sameId = (a?: string | null, b?: string | null) =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase();

/**
 * Marks the releases that were grabbed for the item before, by the guid the
 * grab recorded or the torrent's info hash, and moves them to the top: an
 * admin re-grabbing the download that is already in the client gets a
 * conflict from the client, and one that is waiting to import needs its
 * import retried, not a new download.
 */
export const markGrabbedReleases = (
  releases: ArrRelease[],
  history: ServarrHistoryRecord[],
  queue: GrabQueueRecord[] = []
): ArrRelease[] => {
  const grabs = history.filter(isGrab).sort(byNewest);

  if (grabs.length === 0) {
    return releases;
  }

  const marked = releases.map((release) => {
    const grab = grabs.find(
      (record) =>
        (!!record.data?.guid && record.data.guid === release.guid) ||
        sameId(release.infoHash, record.downloadId) ||
        sameId(release.infoHash, record.data?.torrentInfoHash)
    );

    if (!grab) {
      return release;
    }

    const queued = queue.find((record) =>
      sameId(record.downloadId, grab.downloadId)
    );
    const imported = history.some(
      (record) => isImport(record) && sameId(record.downloadId, grab.downloadId)
    );
    const state: ArrReleaseGrabState = queued
      ? /importblocked|importfailed|failedpending/i.test(
          queued.trackedDownloadState ?? ''
        )
        ? 'importBlocked'
        : 'downloading'
      : imported
        ? 'imported'
        : 'earlier';
    const downloadClient =
      queued?.downloadClient || grab.data?.downloadClientName || undefined;

    return {
      ...release,
      grabbed: {
        date: grab.date,
        state,
        ...(downloadClient && { downloadClient }),
      },
    };
  });

  return [
    ...marked.filter((release) => release.grabbed),
    ...marked.filter((release) => !release.grabbed),
  ];
};

/**
 * Approved releases first, then the best quality, custom format score,
 * the largest and the newest
 */
export const compareReleases = (a: ArrRelease, b: ArrRelease): number =>
  Number(b.approved) - Number(a.approved) ||
  b.qualityWeight - a.qualityWeight ||
  (b.customFormatScore ?? 0) - (a.customFormatScore ?? 0) ||
  b.size - a.size ||
  a.ageHours - b.ageHours;

const isImport = (record: ServarrHistoryRecord) =>
  /imported/i.test(record.eventType) && !/incomplete/i.test(record.eventType);

const isGrab = (record: ServarrHistoryRecord) =>
  record.eventType.toLowerCase() === 'grabbed';

const byNewest = (a: ServarrHistoryRecord, b: ServarrHistoryRecord) =>
  Date.parse(b.date) - Date.parse(a.date) || b.id - a.id;

/**
 * Finds the grab behind the current file of each unit (an episode, or the
 * item itself): the grab of the newest import's download, or else the
 * newest grab. A season pack shows up once.
 */
export const pickGrabs = (
  records: ServarrHistoryRecord[],
  unitOf: (record: ServarrHistoryRecord) => string | number = () => 0
): ServarrHistoryRecord[] => {
  const units = new Map<string | number, ServarrHistoryRecord[]>();

  for (const record of [...records].sort(byNewest)) {
    const unit = unitOf(record);
    units.set(unit, [...(units.get(unit) ?? []), record]);
  }

  const picked = new Map<string, ServarrHistoryRecord>();

  for (const unitRecords of units.values()) {
    const lastImport = unitRecords.find(
      (record) => isImport(record) && record.downloadId
    );
    const grab =
      (lastImport &&
        unitRecords.find(
          (record) =>
            isGrab(record) && record.downloadId === lastImport.downloadId
        )) ??
      unitRecords.find(isGrab);

    if (grab) {
      picked.set(grab.downloadId || `history-${grab.id}`, grab);
    }
  }

  return [...picked.values()];
};

const episodeLabel = (seasonNumber: number, episodeNumber: number) =>
  `S${String(seasonNumber).padStart(2, '0')}E${String(episodeNumber).padStart(
    2,
    '0'
  )}`;

/**
 * Which arr handles a media item, without asking it
 */
export const getArrService = (
  media: Media,
  is4k = false
): { service: ArrServiceName; serviceName: string } => {
  switch (media.mediaType) {
    case MediaType.MOVIE:
      return { service: 'radarr', serviceName: is4k ? '4K Radarr' : 'Radarr' };
    case MediaType.TV:
      return { service: 'sonarr', serviceName: is4k ? '4K Sonarr' : 'Sonarr' };
    case MediaType.MUSIC:
      return { service: 'lidarr', serviceName: 'Lidarr' };
    default:
      return getSettings().bookService === 'lazylibrarian'
        ? { service: 'lazylibrarian', serviceName: 'LazyLibrarian' }
        : {
            service: 'chaptarr',
            serviceName: bookServiceName(getSettings().bookService),
          };
  }
};

const normalizeReleases = (raw: ServarrRelease[]): ArrRelease[] =>
  raw
    .filter((release) => release?.guid)
    .map((release) => normalizeRelease(release))
    .sort(compareReleases);

const resolveRadarr = async (media: Media, is4k: boolean): Promise<ArrItem> => {
  const serviceName = is4k ? '4K Radarr' : 'Radarr';
  const server = getMediaServiceSettings(media, is4k);

  if (!server) {
    throw new ArrActionError(409, `No ${serviceName} server is set up.`);
  }

  const radarr = new RadarrAPI({
    apiKey: server.apiKey,
    url: RadarrAPI.buildUrl(server, '/api/v3'),
  });
  const externalId = is4k ? media.externalServiceId4k : media.externalServiceId;
  let movie: RadarrMovie | undefined;

  if (externalId) {
    movie = await radarr.getMovie({ id: externalId }).catch(() => undefined);
  }
  if (!movie?.id && media.tmdbId) {
    // The lookup leaves out the movie file, the movie itself has it
    const found = await radarr
      .getMovieByTmdbId(media.tmdbId)
      .catch(() => undefined);
    movie = found?.id
      ? await radarr.getMovie({ id: found.id }).catch(() => undefined)
      : undefined;
  }
  if (!movie?.id) {
    throw new ArrActionError(404, `This movie is not in ${serviceName}.`);
  }

  const movieId = movie.id;
  const movieFile = movie.movieFile;

  return {
    service: 'radarr',
    serviceName,
    title: movie.title,
    hasFile: !!movieFile,
    unavailable: {},
    search: () => radarr.startSearch('MoviesSearch', { movieIds: [movieId] }),
    getReleases: async () =>
      normalizeReleases(await radarr.getReleases(movieId)),
    grab: ({ guid, indexerId }) =>
      radarr.grabRelease({ guid, indexerId, movieId }),
    getFileIds: async () => (movieFile ? [movieFile.id] : []),
    deleteFiles: async (fileIds) => {
      for (const fileId of fileIds) {
        await radarr.deleteMovieFile(fileId);
      }
    },
    getGrabs: async () => pickGrabs(await radarr.getMovieHistory(movieId)),
    getHistory: () => radarr.getMovieHistory(movieId),
    getQueue: () => radarr.getQueueRecords<GrabQueueRecord>(),
    markFailed: (historyId) => radarr.markHistoryFailed(historyId),
  };
};

const resolveSonarr = async (
  media: Media,
  { is4k = false, seasonNumber, episodeNumber }: ArrTarget
): Promise<ArrItem> => {
  const serviceName = is4k ? '4K Sonarr' : 'Sonarr';
  const server = getMediaServiceSettings(media, is4k);

  if (!server) {
    throw new ArrActionError(409, `No ${serviceName} server is set up.`);
  }

  const sonarr = new SonarrAPI({
    apiKey: server.apiKey,
    url: SonarrAPI.buildUrl(server, '/api/v3'),
  });
  const externalId = is4k ? media.externalServiceId4k : media.externalServiceId;
  let seriesId: number | undefined;
  let title = '';

  if (externalId) {
    const series = await sonarr
      .getSeriesById(externalId)
      .catch(() => undefined);
    seriesId = series?.id;
    title = series?.title ?? '';
  }
  if (!seriesId && media.tvdbId) {
    const series = await sonarr
      .getSeriesByTvdbId(media.tvdbId)
      .catch(() => undefined);
    seriesId = series?.id;
    title = series?.title ?? '';
  }
  if (!seriesId) {
    throw new ArrActionError(404, `This series is not in ${serviceName}.`);
  }

  const id = seriesId;
  const episodes = await sonarr.getEpisodes(id);
  const episodeList: ArrEpisode[] = episodes
    .map((episode) => ({
      seasonNumber: episode.seasonNumber,
      episodeNumber: episode.episodeNumber,
      title: episode.title,
      hasFile: episode.hasFile,
    }))
    .sort(
      (a, b) =>
        a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber
    );
  const base = {
    service: 'sonarr' as const,
    serviceName,
    episodes: episodeList,
    markFailed: (historyId: number) => sonarr.markHistoryFailed(historyId),
    deleteFiles: (fileIds: number[]) => sonarr.deleteEpisodeFiles(fileIds),
  };

  if (seasonNumber === undefined) {
    const reason = 'Choose a season or an episode first.';

    return {
      ...base,
      title,
      hasFile: episodes.some((episode) => episode.hasFile),
      unavailable: { interactive: reason, replace: reason },
      search: () => sonarr.startSearch('SeriesSearch', { seriesId: id }),
      getReleases: async () => {
        throw new ArrActionError(400, reason);
      },
      grab: async () => {
        throw new ArrActionError(400, reason);
      },
      getFileIds: async () => [],
      getGrabs: async () => [],
    };
  }

  const seasonEpisodes = episodes.filter(
    (episode) => episode.seasonNumber === seasonNumber
  );

  if (seasonEpisodes.length === 0) {
    throw new ArrActionError(
      404,
      `Season ${seasonNumber} is not in ${serviceName}.`
    );
  }

  const historyFor = async (targets: EpisodeResult[]) => {
    const withFiles = new Set(
      targets.filter((episode) => episode.hasFile).map((episode) => episode.id)
    );
    const history = await sonarr.getSeriesHistory(id, seasonNumber);

    return pickGrabs(
      history.filter(
        (record) => record.episodeId && withFiles.has(record.episodeId)
      ),
      (record) => record.episodeId ?? 0
    );
  };
  const fileIdsOf = (targets: EpisodeResult[]) => [
    ...new Set(
      targets
        .filter((episode) => episode.hasFile && episode.episodeFileId)
        .map((episode) => episode.episodeFileId)
    ),
  ];

  if (episodeNumber !== undefined) {
    const episode = seasonEpisodes.find(
      (e) => e.episodeNumber === episodeNumber
    );

    if (!episode) {
      throw new ArrActionError(
        404,
        `${episodeLabel(seasonNumber, episodeNumber)} is not in ${serviceName}.`
      );
    }

    return {
      ...base,
      title: `${title} ${episodeLabel(seasonNumber, episodeNumber)}`,
      hasFile: episode.hasFile,
      unavailable: {},
      search: () =>
        sonarr.startSearch('EpisodeSearch', { episodeIds: [episode.id] }),
      getReleases: async () =>
        normalizeReleases(await sonarr.getReleases({ episodeId: episode.id })),
      grab: ({ guid, indexerId }) =>
        sonarr.grabRelease({
          guid,
          indexerId,
          seriesId: id,
          episodeId: episode.id,
        }),
      getFileIds: async () => fileIdsOf([episode]),
      getGrabs: () => historyFor([episode]),
    };
  }

  return {
    ...base,
    title: `${title} Season ${seasonNumber}`,
    hasFile: seasonEpisodes.some((episode) => episode.hasFile),
    unavailable: {},
    search: () =>
      sonarr.startSearch('SeasonSearch', { seriesId: id, seasonNumber }),
    getReleases: async () =>
      normalizeReleases(
        await sonarr.getReleases({ seriesId: id, seasonNumber })
      ),
    grab: ({ guid, indexerId }) =>
      sonarr.grabRelease({ guid, indexerId, seriesId: id, seasonNumber }),
    getFileIds: async () => fileIdsOf(seasonEpisodes),
    getGrabs: () => historyFor(seasonEpisodes),
  };
};

const resolveLidarr = async (media: Media): Promise<ArrItem> => {
  const settings = getSettings();
  const server =
    settings.lidarr.find((lidarr) => lidarr.id === media.serviceId) ??
    settings.lidarr.find((lidarr) => lidarr.isDefault);

  if (!server) {
    throw new ArrActionError(409, 'No Lidarr server is set up.');
  }

  const lidarr = new LidarrAPI({
    apiKey: server.apiKey,
    url: LidarrAPI.buildUrl(server, '/api/v1'),
  });
  let albumId: number | undefined;

  if (media.externalServiceId && media.serviceId === server.id) {
    const album = await lidarr
      .getAlbumById(media.externalServiceId)
      .catch(() => undefined);
    albumId = album?.id;
  }
  if (!albumId && media.mbId) {
    const album = await lidarr
      .getAlbumByForeignAlbumId(media.mbId)
      .catch(() => undefined);
    albumId = album?.id;
  }

  const album = albumId
    ? await lidarr.getAlbumById(albumId).catch(() => undefined)
    : undefined;

  if (!album?.id) {
    throw new ArrActionError(404, 'This album is not in Lidarr.');
  }

  const { id, artistId } = album;

  return {
    service: 'lidarr',
    serviceName: 'Lidarr',
    title: album.title,
    hasFile: (album.statistics?.trackFileCount ?? 0) > 0,
    unavailable: {},
    search: () => lidarr.startSearch('AlbumSearch', { albumIds: [id] }),
    getReleases: async () => normalizeReleases(await lidarr.getReleases(id)),
    grab: ({ guid, indexerId }) =>
      lidarr.grabRelease({ guid, indexerId, albumId: id, artistId }),
    getFileIds: async () =>
      (await lidarr.getTrackFilesByAlbumId(id)).map((file) => file.id),
    deleteFiles: (fileIds) => lidarr.deleteTrackFiles(fileIds),
    getGrabs: async () => pickGrabs(await lidarr.getAlbumHistory(artistId, id)),
    getHistory: () => lidarr.getAlbumHistory(artistId, id),
    getQueue: () => lidarr.getQueueRecords<GrabQueueRecord>(),
    markFailed: (historyId) => lidarr.markHistoryFailed(historyId),
  };
};

const formatName = (format: BookFormat) =>
  format === 'audiobook' ? 'audiobook' : 'ebook';

/**
 * The language of the newest request for a format of a book, otherwise the
 * server default
 */
const getMediaBookLanguage = async (
  media: Media,
  format: BookFormat
): Promise<BookLanguage> => {
  const latest = await getRepository(MediaRequest).findOne({
    where: {
      media: { id: media.id },
      isAudiobook: format === 'audiobook',
      recording: IsNull(),
    },
    order: { createdAt: 'DESC' },
  });

  return isBookLanguage(latest?.language)
    ? latest.language
    : getEffectiveBookLanguage(null, getSettings().main.bookLanguage);
};

const resolveChaptarr = async (
  media: Media,
  format: BookFormat
): Promise<ArrItem> => {
  const settings = getSettings();
  const server =
    settings.chaptarr.find((chaptarr) => chaptarr.id === media.serviceId) ??
    getDefaultChaptarr(settings.chaptarr);

  const serviceName = bookServiceName(settings.bookService);
  const talearr = isTalearrService(settings.bookService);

  if (!server) {
    throw new ArrActionError(409, `No ${serviceName} server is set up.`);
  }

  const chaptarr = new ChaptarrAPI({
    apiKey: server.apiKey,
    url: ChaptarrAPI.buildUrl(server, '/api/v1'),
  });
  const sameServer = media.serviceId === server.id;
  let book = await getChaptarrLibraryBook(
    chaptarr,
    sameServer
      ? media
      : { foreignBookId: media.foreignBookId ?? media.olId ?? undefined },
    format
  ).catch((e) => {
    logger.debug('Could not find the book in Chaptarr', {
      label: LOG_LABEL,
      mediaId: media.id,
      format,
      errorMessage: e.message,
    });
    return undefined;
  });

  // Books downloaded before Chaptarr (or added there by hand) have no
  // Chaptarr ids yet, so they are matched by title and author and linked
  if (!book?.id && media.olId) {
    book = await matchChaptarrLibraryBook(chaptarr, media.olId, format).catch(
      (e) => {
        logger.debug('Could not match the book in Chaptarr', {
          label: LOG_LABEL,
          mediaId: media.id,
          format,
          errorMessage: e.message,
        });
        return undefined;
      }
    );

    if (book?.id) {
      await linkChaptarrBook(media, server.id, format, book);
    }
  }

  if (!book?.id) {
    throw new ArrActionError(
      404,
      `The ${formatName(format)} of this book is not in ${serviceName}.`
    );
  }

  const bookId = book.id;
  const authorId = book.authorId || book.author?.id;

  return {
    service: 'chaptarr',
    serviceName,
    title: book.title,
    hasFile: getBookFileCount(book) > 0,
    unavailable: {},
    // Books monitored only for a request, or not at all (downloaded before
    // Chaptarr), would have every release refused by an automatic search
    search: async () => {
      try {
        await prepareChaptarrBookSearch(
          chaptarr,
          book,
          format,
          getChaptarrFormatSettings(server, format),
          await getMediaBookLanguage(media, format)
        );
      } catch (e) {
        logger.warn('Could not ready the book for an automatic search', {
          label: LOG_LABEL,
          mediaId: media.id,
          format,
          errorMessage: e.message,
        });
      }
      return chaptarr.startSearch('BookSearch', { bookIds: [bookId] });
    },
    getReleases: async () => {
      const { releases, hidden } = await chaptarr.getReleases(bookId);

      return [
        ...releases.map((release) =>
          normalizeRelease(release, { serviceName, rejectionLabels: talearr })
        ),
        ...hidden.map((release) =>
          normalizeRelease(release, {
            hidden: true,
            serviceName,
            rejectionLabels: talearr,
          })
        ),
      ]
        .filter((release) => release.guid)
        .sort(compareReleases);
    },
    grab: ({ guid, indexerId }) =>
      chaptarr.grabRelease({
        guid,
        indexerId,
        bookId,
        ...(authorId && { authorId }),
      }),
    getFileIds: async () =>
      (await chaptarr.getBookFiles(bookId)).map((file) => file.id),
    deleteFiles: (fileIds) => chaptarr.deleteBookFiles(fileIds),
    getGrabs: async () =>
      authorId
        ? pickGrabs(await chaptarr.getBookHistory(authorId, bookId))
        : [],
    getHistory: async () =>
      authorId ? chaptarr.getBookHistory(authorId, bookId) : [],
    getQueue: () => chaptarr.getBookQueue(),
    markFailed: (historyId) => chaptarr.markHistoryFailed(historyId),
  };
};

export const LAZYLIBRARIAN_NO_RELEASES =
  'LazyLibrarian cannot list releases to pick from.';
export const LAZYLIBRARIAN_NO_DELETE = 'LazyLibrarian cannot delete files.';

const resolveLazyLibrarian = async (
  media: Media,
  format: BookFormat
): Promise<ArrItem> => {
  const settings = getSettings();

  if (!isLazyLibrarianConfigured(settings.lazylibrarian)) {
    throw new ArrActionError(409, 'LazyLibrarian is not set up.');
  }

  const lazyLibrarian = new LazyLibrarianAPI(settings.lazylibrarian);
  const bookId = media.externalServiceSlug ?? media.olId;
  const book = bookId ? await lazyLibrarian.getBook(bookId) : undefined;

  if (!book) {
    throw new ArrActionError(404, 'This book is not in LazyLibrarian.');
  }

  const type = format === 'audiobook' ? 'AudioBook' : 'eBook';
  const unsupported = (reason: string) => async (): Promise<never> => {
    throw new ArrActionError(400, reason);
  };

  return {
    service: 'lazylibrarian',
    serviceName: 'LazyLibrarian',
    title: book.title,
    hasFile:
      getLazyLibrarianState(
        format === 'audiobook' ? book.audioStatus : book.status
      ) === 'available',
    unavailable: {
      interactive: LAZYLIBRARIAN_NO_RELEASES,
      replace: LAZYLIBRARIAN_NO_DELETE,
    },
    search: () => lazyLibrarian.searchBook(book.bookId, type),
    getReleases: unsupported(LAZYLIBRARIAN_NO_RELEASES),
    grab: unsupported(LAZYLIBRARIAN_NO_RELEASES),
    getFileIds: unsupported(LAZYLIBRARIAN_NO_DELETE),
    deleteFiles: unsupported(LAZYLIBRARIAN_NO_DELETE),
    getGrabs: async () => [],
    markFailed: unsupported(LAZYLIBRARIAN_NO_DELETE),
  };
};

/**
 * Checks a target against the media and fills in what it leaves out
 */
export const parseArrTarget = (media: Media, body: object): ArrTarget => {
  const input = body as Record<string, unknown>;
  const toInt = (value: unknown, name: string): number | undefined => {
    if (value === undefined || value === null || value === '') {
      return undefined;
    }
    const number = Number(value);
    if (!Number.isInteger(number) || number < 0) {
      throw new ArrActionError(400, `${name} must be a whole number.`);
    }
    return number;
  };
  const is4k = input.is4k === true || input.is4k === 'true';
  const target: ArrTarget = { is4k };

  if (media.mediaType === MediaType.TV) {
    target.seasonNumber = toInt(input.seasonNumber, 'seasonNumber');
    target.episodeNumber = toInt(input.episodeNumber, 'episodeNumber');

    if (
      target.episodeNumber !== undefined &&
      target.seasonNumber === undefined
    ) {
      throw new ArrActionError(400, 'An episode needs its season number.');
    }
  }

  if (media.mediaType === MediaType.BOOK) {
    const format = input.bookFormat;

    if (format !== 'ebook' && format !== 'audiobook') {
      throw new ArrActionError(400, 'Choose the ebook or the audiobook.');
    }
    target.bookFormat = format;
  }

  if (
    is4k &&
    media.mediaType !== MediaType.MOVIE &&
    media.mediaType !== MediaType.TV
  ) {
    throw new ArrActionError(400, 'Only movies and series have 4K servers.');
  }

  return target;
};

/**
 * Finds the item in its arr. Fails with a 404 when the arr does not have
 * it and a 409 when no arr is set up for it.
 */
export const resolveArrItem = async (
  media: Media,
  target: ArrTarget
): Promise<ArrItem> => {
  switch (media.mediaType) {
    case MediaType.MOVIE:
      return resolveRadarr(media, !!target.is4k);
    case MediaType.TV:
      return resolveSonarr(media, target);
    case MediaType.MUSIC:
      return resolveLidarr(media);
    case MediaType.BOOK: {
      const format = target.bookFormat ?? 'ebook';

      return getSettings().bookService === 'lazylibrarian'
        ? resolveLazyLibrarian(media, format)
        : resolveChaptarr(media, format);
    }
    default:
      throw new ArrActionError(400, 'This media cannot be managed in an arr.');
  }
};

export const getArrItemInfo = async (
  media: Media,
  target: ArrTarget
): Promise<ArrItemResponse> => {
  try {
    const item = await resolveArrItem(media, target);
    const actions = Object.fromEntries(
      ACTIONS.map((action) => {
        const reason =
          item.unavailable[action] ??
          (action === 'replace' && !item.hasFile ? NO_FILE_REASON : undefined);

        return [
          action,
          reason ? { available: false, reason } : { available: true },
        ];
      })
    ) as ArrItemResponse['actions'];

    return {
      service: item.service,
      serviceName: item.serviceName,
      inService: true,
      title: item.title,
      hasFile: item.hasFile,
      actions,
      ...(item.episodes && { episodes: item.episodes }),
    };
  } catch (e) {
    if (!(e instanceof ArrActionError) || e.status === 400) {
      throw e;
    }

    const { service, serviceName } = getArrService(media, target.is4k);

    return {
      service,
      serviceName,
      inService: false,
      hasFile: false,
      actions: Object.fromEntries(
        ACTIONS.map((action) => [
          action,
          { available: false, reason: e.message },
        ])
      ) as ArrItemResponse['actions'],
    };
  }
};

const describeTarget = (media: Media, target: ArrTarget): string => {
  if (target.seasonNumber !== undefined) {
    return target.episodeNumber !== undefined
      ? episodeLabel(target.seasonNumber, target.episodeNumber)
      : `Season ${target.seasonNumber}`;
  }
  if (media.mediaType === MediaType.BOOK && target.bookFormat) {
    return target.bookFormat === 'audiobook' ? 'Audiobook' : 'Ebook';
  }
  return '';
};

/**
 * Comments on the issue an action was taken from and resolves it when
 * asked, for a user allowed to. Returns whether it was resolved.
 */
export const followUpIssue = async (
  media: Media,
  target: ArrTarget,
  user: User,
  { issueId, resolveIssue }: { issueId?: number; resolveIssue?: boolean },
  message: string
): Promise<boolean> => {
  if (!issueId) {
    return false;
  }

  const issueRepository = getRepository(Issue);
  const issue = await issueRepository.findOne({ where: { id: issueId } });

  if (!issue || issue.media?.id !== media.id) {
    logger.warn('Issue for an arr action not found on this media', {
      label: LOG_LABEL,
      mediaId: media.id,
      issueId,
    });
    return false;
  }

  const targetName = describeTarget(media, target);
  const comment = new IssueComment({
    user,
    message: targetName ? `${targetName}: ${message}` : message,
  });
  const resolve =
    !!resolveIssue &&
    issue.status === IssueStatus.OPEN &&
    user.hasPermission(Permission.MANAGE_ISSUES);

  issue.comments = [...(issue.comments ?? []), comment];
  issue.updatedAt = new Date();
  if (resolve) {
    issue.status = IssueStatus.RESOLVED;
    issue.modifiedBy = user;
  }
  await issueRepository.save(issue);

  return resolve;
};

/**
 * Marks the replaced item as processing until a scan finds the new file
 */
export const markReplacedAsProcessing = async (
  media: Media,
  target: ArrTarget
): Promise<void> => {
  if (media.mediaType === MediaType.BOOK) {
    media[target.bookFormat === 'audiobook' ? 'statusAudio' : 'status'] =
      MediaStatus.PROCESSING;
  } else if (media.mediaType === MediaType.TV) {
    const key = target.is4k ? 'status4k' : 'status';
    const season = media.seasons?.find(
      (s) => s.seasonNumber === target.seasonNumber
    );

    if (season) {
      season[key] = MediaStatus.PROCESSING;
    }
    if (media[key] === MediaStatus.AVAILABLE) {
      media[key] = MediaStatus.PARTIALLY_AVAILABLE;
    }
  } else {
    media[target.is4k ? 'status4k' : 'status'] = MediaStatus.PROCESSING;
  }

  await getRepository(Media).save(media);
};

const logAction = (
  message: string,
  media: Media,
  item: ArrItem,
  target: ArrTarget,
  user: User,
  extra: Record<string, unknown> = {}
) =>
  logger.info(message, {
    label: LOG_LABEL,
    mediaId: media.id,
    service: item.serviceName,
    title: item.title,
    ...target,
    userId: user.id,
    ...extra,
  });

export const searchAgain = async (
  media: Media,
  target: ArrTarget,
  user: User,
  followUp: { issueId?: number; resolveIssue?: boolean } = {}
): Promise<ArrActionResponse> => {
  const item = await resolveArrItem(media, target);

  await item.search();
  logAction('Started a search', media, item, target, user);

  const issueResolved = await followUpIssue(
    media,
    target,
    user,
    followUp,
    `Started a new search in ${item.serviceName}.`
  );

  return { issueResolved };
};

export const listReleases = async (
  media: Media,
  target: ArrTarget
): Promise<ArrRelease[]> => {
  const item = await resolveArrItem(media, target);

  if (item.unavailable.interactive) {
    throw new ArrActionError(400, item.unavailable.interactive);
  }

  const [releases, history, queue] = await Promise.all([
    item.getReleases(),
    // The list still shows when the history or queue cannot be read
    (item.getHistory?.() ?? item.getGrabs()).catch(() => []),
    (item.getQueue?.() ?? Promise.resolve([])).catch(() => []),
  ]);

  return markGrabbedReleases(releases, history, queue);
};

const DOWNLOAD_CLIENTS =
  /qBittorrent|Transmission|Deluge|rTorrent|uTorrent|SABnzbd|NZBGet|Aria2|Flood|Vuze|Download Station/i;

/**
 * Says in plain words why an arr could not grab a release when its own
 * message buries it: the download client already has that download
 * (qBittorrent answers 409 Conflict). Other errors keep the arr's message.
 */
export const explainGrabError = (e: unknown): Error => {
  const message = e instanceof Error ? e.message : String(e);
  const client = message.match(DOWNLOAD_CLIENTS)?.[0] ?? 'the download client';

  if (/conflict|\b409\b|already (exists|added|in )|duplicate/i.test(message)) {
    return new ArrActionError(
      409,
      `That release is already in ${client}, so it does not need downloading again. If it finished, retry its import from Downloads instead.`
    );
  }

  return e instanceof Error ? e : new Error(message);
};

export const grabRelease = async (
  media: Media,
  target: ArrTarget,
  user: User,
  release: {
    guid: string;
    indexerId: number;
    title?: string;
    replaced?: boolean;
  },
  followUp: { issueId?: number; resolveIssue?: boolean } = {}
): Promise<ArrActionResponse> => {
  const item = await resolveArrItem(media, target);

  if (item.unavailable.interactive) {
    throw new ArrActionError(400, item.unavailable.interactive);
  }

  try {
    await item.grab({ guid: release.guid, indexerId: release.indexerId });
  } catch (e) {
    throw explainGrabError(e);
  }
  logAction('Grabbed a release', media, item, target, user, {
    release: release.title ?? release.guid,
    indexerId: release.indexerId,
  });

  const name = release.title || 'the chosen release';
  const issueResolved = await followUpIssue(
    media,
    target,
    user,
    followUp,
    release.replaced
      ? `Replaced the file and grabbed ${name}.`
      : `Grabbed ${name}.`
  );

  return { issueResolved };
};

/**
 * Deletes the current files in the arr, blocklists the releases they came
 * from when asked, then searches again unless the admin picks a release.
 * The media shows as processing until a scan finds the new file.
 */
export const replaceFile = async (
  media: Media,
  target: ArrTarget,
  user: User,
  {
    blocklist = true,
    search = 'automatic',
    issueId,
    resolveIssue,
  }: Pick<ArrReplaceBody, 'blocklist' | 'search' | 'issueId' | 'resolveIssue'>
): Promise<ArrReplaceResponse> => {
  const item = await resolveArrItem(media, target);

  if (item.unavailable.replace) {
    throw new ArrActionError(400, item.unavailable.replace);
  }

  const fileIds = await item.getFileIds();

  if (fileIds.length === 0) {
    throw new ArrActionError(409, NO_FILE_REASON);
  }

  // History is read first, deleting files adds events to it
  const grabs = blocklist ? await item.getGrabs() : [];

  await item.deleteFiles(fileIds);

  const blocklisted: string[] = [];
  for (const grab of grabs) {
    try {
      await item.markFailed(grab.id);
      blocklisted.push(grab.sourceTitle ?? grab.data?.guid ?? String(grab.id));
    } catch (e) {
      logger.warn('Could not blocklist the release of the replaced file', {
        label: LOG_LABEL,
        mediaId: media.id,
        historyId: grab.id,
        errorMessage: e.message,
      });
    }
  }

  const searched = search === 'automatic';
  if (searched) {
    await item.search();
  }

  await markReplacedAsProcessing(media, target);
  logAction('Replaced the file', media, item, target, user, {
    deletedFiles: fileIds.length,
    blocklisted,
    search,
  });

  // The grab comments on the issue when the admin picks the release
  const issueResolved = searched
    ? await followUpIssue(
        media,
        target,
        user,
        { issueId, resolveIssue },
        blocklisted.length
          ? `Replaced the file, blocklisted ${blocklisted.join(', ')} and started a new search in ${item.serviceName}.`
          : `Replaced the file and started a new search in ${item.serviceName}.`
      )
    : false;

  return {
    deletedFiles: fileIds.length,
    blocklisted,
    searched,
    issueResolved,
  };
};
