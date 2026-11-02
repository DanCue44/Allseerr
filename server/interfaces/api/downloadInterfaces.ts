import type { ArrTarget } from '@server/interfaces/api/arrActionInterfaces';

export type DownloadService = 'radarr' | 'sonarr' | 'lidarr' | 'chaptarr';

export type DownloadMediaType =
  | 'movie'
  | 'tv'
  | 'music'
  | 'ebook'
  | 'audiobook';

export type DownloadStatus =
  | 'downloading'
  | 'queued'
  | 'paused'
  | 'importing'
  | 'importPending'
  | 'completed'
  | 'warning'
  | 'failed'
  | 'stalled';

export type DownloadProtocol = 'usenet' | 'torrent' | 'unknown';

export interface DownloadRequester {
  id: number;
  displayName: string;
  avatar: string;
}

/**
 * A download in the queue of one of the arrs, the same for every arr
 */
export interface DownloadItem {
  // service:serverId:queueId, for the actions
  id: string;
  service: DownloadService;
  serverId: number;
  // The arr as it is set up in Allseerr, such as "4K Radarr"
  serverName: string;
  is4k: boolean;
  mediaType: DownloadMediaType;
  // The movie, series, album or book
  title: string;
  year?: number;
  // Series: the season and the episodes in the download, more than one for
  // a season pack
  seasonNumber?: number;
  episodeNumbers?: number[];
  episodeTitle?: string;
  // Albums
  artistName?: string;
  // Books
  authorName?: string;
  // The release in the download client
  releaseTitle: string;
  protocol: DownloadProtocol;
  downloadClient?: string;
  indexer?: string;
  // Bytes
  size: number;
  sizeLeft: number;
  // 0 to 1
  progress: number;
  // As the arr says it, such as 01:02:03 or 1.02:03:04
  timeLeft?: string;
  timeLeftSeconds?: number;
  estimatedCompletionTime?: string;
  status: DownloadStatus;
  // What the arr itself says
  arrStatus?: string;
  trackedDownloadState?: string;
  trackedDownloadStatus?: string;
  statusMessages: string[];
  errorMessage?: string;
  // Failed, stalled or showing a warning
  needsAttention: boolean;
  added?: string;
  // Torrents, when the arr says
  seeders?: number;
  leechers?: number;
  posterUrl?: string;
  // Fanart for the card backdrop, movies and series only
  backdropUrl?: string;
  // The quality the arr expects the release to be, such as Bluray-1080p
  quality?: string;
  // Where the download client puts the files
  outputPath?: string;
  // The media in Allseerr, when the download is of one
  mediaId?: number;
  tmdbId?: number;
  tvdbId?: number;
  mbId?: string;
  olId?: string;
  // For the /media/{mediaId}/arr actions
  target?: ArrTarget;
  requester?: DownloadRequester;
  // A new search can be started for what the download is of
  canSearch: boolean;
  // The book service can try the stuck import of this download again
  canRetryImport?: boolean;
}

export interface DownloadRetryImportResponse {
  // The import went through and the download left the queue
  imported: boolean;
  // Still importing when the page stopped waiting
  pending?: boolean;
  // Why the import is still stuck
  message?: string;
}

export interface DownloadServerError {
  service: DownloadService;
  serverId: number;
  serverName: string;
  message: string;
}

export interface DownloadTotals {
  total: number;
  downloading: number;
  queued: number;
  attention: number;
}

export interface DownloadsResponse {
  results: DownloadItem[];
  totals: DownloadTotals;
  serverErrors: DownloadServerError[];
  updatedAt: string;
}

export interface DownloadRemoveBody {
  // Also delete it from NZBGet or qBittorrent
  removeFromClient?: boolean;
  // Never grab this release again
  blocklist?: boolean;
  // Start a new search after removing
  search?: boolean;
}

export interface DownloadRemoveResponse {
  removed: boolean;
  blocklisted: boolean;
  searched: boolean;
  // Why the new search could not be started, the download is gone anyway
  searchError?: string;
}

export type SeedingState =
  | 'seeding'
  | 'stalled'
  | 'queued'
  | 'paused'
  | 'checking'
  | 'error'
  | 'downloading';

/**
 * A torrent Talearr's download client is seeding, or should be. Bytes and
 * seconds, ISO 8601 times. Fields Talearr does not know are null.
 */
// Comic only comes from a file name; Talearr itself reports audiobook or ebook
export type SeedingMediaType = 'audiobook' | 'ebook' | 'comic';

export interface SeedingTorrent {
  // The hash in the download client
  downloadId: string;
  // The release name in the client
  title: string;
  // Null when Talearr cannot match the torrent to a book
  bookId: number | null;
  bookTitle: string | null;
  authorName: string | null;
  mediaType: SeedingMediaType | null;
  indexer: string | null;
  isPrivateTracker: boolean;
  // Seeded only to build ratio (Talearr's MyAnonamouse filler), not a library book
  isFiller: boolean;
  downloadClient: string | null;
  state: SeedingState;
  size: number;
  uploaded: number;
  ratio: number;
  seedingSeconds: number;
  // The tracker's minimum seeding time
  requiredSeedingSeconds: number | null;
  // When the client stops seeding by itself
  seedGoalSeconds: number | null;
  requirementMet: boolean;
  atRisk: boolean;
  riskReason: string | null;
  addedAt: string | null;
  completedAt: string | null;
  // Added by Allseerr: the book in Allseerr, when it has the Talearr book
  mediaId?: number;
  olId?: string;
  // Added by Allseerr: the book's cover from Talearr
  posterUrl?: string;
  // Added by Allseerr: who requested the book in this format, null when
  // nobody did (such as filler torrents)
  requester?: DownloadRequester | null;
}

export interface SeedingSummary {
  total: number;
  seeding: number;
  atRisk: number;
  privateUnsatisfied: number;
}

/**
 * The private tracker account Talearr checks, for its seeding rules
 */
export interface TrackerAccount {
  userClass: string | null;
  isVip: boolean;
  unsatisfied: number | null;
  unsatisfiedLimit: number | null;
  wedges: number | null;
  bonusPoints: number | null;
  checkedAt: string | null;
}

export interface TalearrSeeding {
  generatedAt: string | null;
  torrents: SeedingTorrent[];
  summary: SeedingSummary;
  // Null when Talearr checks no tracker account
  trackerAccount: TrackerAccount | null;
  // Talearr's public address from the book service settings, for links to it
  talearrUrl?: string | null;
}

/**
 * Seeding is only known to Talearr; stock Chaptarr and LazyLibrarian answer
 * unsupported
 */
export type SeedingResponse =
  | { supported: false }
  | ({ supported: true } & TalearrSeeding);
