import type { BookFormat } from '@server/constants/media';

export type ArrServiceName =
  | 'radarr'
  | 'sonarr'
  | 'lidarr'
  | 'chaptarr'
  | 'lazylibrarian';

export type ArrActionName = 'search' | 'interactive' | 'replace';

export interface ArrActionAvailability {
  available: boolean;
  // Why the action cannot be used, shown next to it
  reason?: string;
}

/**
 * What an action works on: a movie or album as a whole, a season or one
 * episode of a series, or one format of a book. is4k picks the 4K Radarr
 * or Sonarr server.
 */
export interface ArrTarget {
  is4k?: boolean;
  bookFormat?: BookFormat;
  seasonNumber?: number;
  episodeNumber?: number;
}

export interface ArrEpisode {
  seasonNumber: number;
  episodeNumber: number;
  title: string;
  hasFile: boolean;
}

export interface ArrItemResponse {
  service: ArrServiceName;
  // The arr as it is shown, such as "4K Radarr"
  serviceName: string;
  // False when the arr does not have the item, or is not set up
  inService: boolean;
  title?: string;
  hasFile: boolean;
  actions: Record<ArrActionName, ArrActionAvailability>;
  // Series only, every episode Sonarr has, for picking a target
  episodes?: ArrEpisode[];
}

export type ArrReleaseProtocol = 'usenet' | 'torrent' | 'unknown';

/**
 * A release an arr found on its indexers, the same for every arr
 */
export interface ArrRelease {
  guid: string;
  indexerId: number;
  title: string;
  size: number;
  ageHours: number;
  indexer: string;
  protocol: ArrReleaseProtocol;
  // Torrents only
  seeders?: number;
  leechers?: number;
  quality: string;
  // How the quality profile ranks the quality, higher is better
  qualityWeight: number;
  languages: string[];
  // The arr would grab it by itself
  approved: boolean;
  rejections: string[];
  // Talearr only: short labels of the rejections, such as "Language"
  rejectionLabels?: string[];
  customFormatScore?: number;
  releaseGroup?: string;
  infoUrl?: string;
  // Torrents only, used to recognize a release that was grabbed before
  infoHash?: string;
  // This release was grabbed for the item before
  grabbed?: ArrReleaseGrab;
}

/**
 * What became of an earlier grab of a release: its file is the one in the
 * library, it is still in the download client (downloading or waiting to
 * import), its import is stuck, or it was grabbed and is gone since
 */
export type ArrReleaseGrabState =
  | 'imported'
  | 'downloading'
  | 'importBlocked'
  | 'earlier';

export interface ArrReleaseGrab {
  date: string;
  state: ArrReleaseGrabState;
  downloadClient?: string;
}

export interface ArrReleasesResponse {
  results: ArrRelease[];
}

export interface ArrIssueFollowUp {
  // The issue the action was taken from, a comment is added to it
  issueId?: number;
  resolveIssue?: boolean;
}

export interface ArrSearchBody extends ArrTarget, ArrIssueFollowUp {}

export interface ArrGrabBody extends ArrTarget, ArrIssueFollowUp {
  guid: string;
  indexerId: number;
  // The release title, for the log and the issue comment
  title?: string;
  // The file was replaced right before, for the issue comment
  replaced?: boolean;
}

export interface ArrReplaceBody extends ArrTarget, ArrIssueFollowUp {
  // Add the release of the current file to the arr's blocklist
  blocklist?: boolean;
  // automatic has the arr search right away, interactive leaves the pick
  // to the admin
  search?: 'automatic' | 'interactive';
}

export interface ArrActionResponse {
  issueResolved?: boolean;
}

export interface ArrReplaceResponse extends ArrActionResponse {
  deletedFiles: number;
  // Releases added to the arr's blocklist
  blocklisted: string[];
  searched: boolean;
}
