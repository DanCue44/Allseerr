import type Media from '@server/entity/Media';
import type { User } from '@server/entity/User';
import type { UserEpisodeState } from '@server/lib/watchedState';
import type { PaginatedResponse } from './common';

export interface MediaResultsResponse extends PaginatedResponse {
  results: Media[];
}

export interface MediaWatchDataResponse {
  data?: {
    users: User[];
    playCount: number;
    playCount7Days: number;
    playCount30Days: number;
  };
  data4k?: {
    users: User[];
    playCount: number;
    playCount7Days: number;
    playCount30Days: number;
  };
}

export interface MediaFileInfo {
  id: number;
  fileName: string;
  // Only included for users who can manage requests
  path?: string;
  size: number;
  dateAdded: string;
  quality?: string;
  resolution?: number;
  releaseGroup?: string;
  sceneName?: string;
  edition?: string;
  languages: string[];
  seasonNumber?: number;
  episodeNumbers?: number[];
  mediaInfo?: {
    videoCodec?: string;
    videoBitDepth?: number;
    videoBitrate?: number;
    videoFps?: number;
    videoDynamicRange?: string;
    resolution?: string;
    scanType?: string;
    runTime?: string;
    audioCodec?: string;
    audioChannels?: number;
    audioBitrate?: number;
    audioStreamCount?: number;
    audioLanguages: string[];
    subtitles: string[];
  };
}

export interface MediaFilesResponse {
  files?: MediaFileInfo[];
  files4k?: MediaFileInfo[];
}

/** What the signed-in user has watched of a series, per season and episode */
export interface TvWatchedResponse {
  seasons: Record<
    number,
    { watchedEpisodes: number; inProgressEpisodes: number }
  >;
  /** Keyed "<season>-<episode>" */
  episodes: Record<string, UserEpisodeState>;
}
