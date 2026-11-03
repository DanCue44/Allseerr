import type {
  NoBookEndsSyncHealth,
  NoBookEndsSyncStatus,
} from '@server/api/nobookendsSync';
import type { AudiobookVersionsMode } from '@server/constants/audiobookVersion';
import type { BookLanguage } from '@server/constants/bookLanguages';
import type { BookFormatChoice } from '@server/constants/media';
import type {
  DockerStatus,
  InstallState,
} from '@server/lib/nobookendsSyncSetup';
import type { AudiobookshelfSettings, BookService } from '@server/lib/settings';
import type { DnsEntries, DnsStats } from 'dns-caching';
import type { PaginatedResponse } from './common';

export type LogMessage = {
  timestamp: string;
  level: string;
  label?: string;
  message: string;
  data?: Record<string, unknown>;
};

export interface LogsResultsResponse extends PaginatedResponse {
  results: LogMessage[];
}

export interface SettingsAboutResponse {
  version: string;
  releaseBuild: boolean;
  totalRequests: number;
  totalMediaItems: number;
  tz?: string;
  appDataPath: string;
}

export interface PublicSettingsResponse {
  jellyfinHost?: string;
  jellyfinExternalHost?: string;
  jellyfinServerName?: string;
  jellyfinForgotPasswordUrl?: string;
  initialized: boolean;
  applicationTitle: string;
  applicationUrl: string;
  applicationLogoVersion: string;
  accentColor: string;
  hideAvailable: boolean;
  hideBlocklisted: boolean;
  hideRequested: boolean;
  localLogin: boolean;
  mediaServerLogin: boolean;
  movie4kEnabled: boolean;
  series4kEnabled: boolean;
  booksEnabled: boolean;
  bookService?: BookService;
  discoverRegion: string;
  streamingRegion: string;
  blockedWatchProviders: string;
  musicEnabled: boolean;
  // Whether Bazarr is set up, so subtitles can be checked and requested
  subtitlesEnabled: boolean;
  audiobookshelfEnabled: boolean;
  // Whether Allseerr manages accounts in any reading app
  readingAppsEnabled: boolean;
  originalLanguage: string;
  mediaServerType: number;
  partialRequestsEnabled: boolean;
  allowCurrentSeasonRequests: boolean;
  defaultBookFormat: BookFormatChoice;
  bookLanguage: BookLanguage;
  // Talearr only, the Audiobook Versions setting in effect
  audiobookVersions?: AudiobookVersionsMode;
  enableSpecialEpisodes: boolean;
  cacheImages: boolean;
  vapidPublic: string;
  enablePushRegistration: boolean;
  locale: string;
  emailEnabled: boolean;
  newPlexLogin: boolean;
  youtubeUrl: string;
  versionCheck: boolean;
  plexClientIdentifier: string;
}

export interface CacheItem {
  id: string;
  name: string;
  stats: {
    hits: number;
    misses: number;
    keys: number;
    ksize: number;
    vsize: number;
  };
}

export interface CacheResponse {
  apiCaches: CacheItem[];
  imageCache: Record<'tmdb' | 'avatar', { size: number; imageCount: number }>;
  dnsCache: {
    stats: DnsStats | undefined;
    entries: DnsEntries | undefined;
  };
}

export interface StatusResponse {
  version: string;
  commitTag: string;
  releaseBuild: boolean;
  updateAvailable?: boolean;
  commitsBehind?: number;
  restartRequired: boolean;
}

/**
 * The NoBookEnds Sync settings as the API returns them: the admin token
 * never leaves the server, only whether one is saved
 */
export interface NoBookEndsSyncSettingsResponse {
  enabled: boolean;
  url: string;
  internalUrl: string;
  adminTokenSet: boolean;
  // Phones reach the Sync server through Allseerr
  proxy: boolean;
  proxyPath: string;
  // The proxied address under the application URL, null without one
  proxyUrl: string | null;
  // The read only Audiobookshelf account Allseerr made or reused
  absAccount: { username: string; created: boolean } | null;
  // The container Allseerr installed
  container: {
    name: string;
    image: string;
    dataPath: string;
    network: string;
  } | null;
}

export interface NoBookEndsSyncSetupResponse {
  docker: DockerStatus;
  // Allseerr has an Audiobookshelf admin key to make the account with
  absConnected: boolean;
  defaults: {
    gpu: boolean;
    containerName: string;
    dataPath: string;
    network: string;
    absUrl: string;
    timezone: string;
    autoWindow: string;
    absUsername: string;
    images: { gpu: string; cpu: string };
  };
  install: InstallState;
}

export interface NoBookEndsSyncManualResponse {
  compose: string;
  dockerRun: string;
  unraidTemplate: string;
  unraidTemplatePath: string;
  // Where Allseerr likely reaches it, empty when it cannot be guessed
  suggestedInternalUrl: string;
}

export interface NoBookEndsSyncTestResponse extends NoBookEndsSyncHealth {
  // Set when an admin token was checked
  tokenValid?: boolean;
  // Window, queue and running job, when the token works on a Sync server
  // that reports them
  status?: NoBookEndsSyncStatus;
  // The Sync server has no status endpoint (an older version), so only
  // its health is known
  statusUnavailable?: boolean;
}

export interface NoBookEndsSyncBackfillResponse {
  // Books with both an audiobook and an ebook item
  total: number;
  // Taken by the Sync server
  accepted: number;
  // Refused for good: an item gone, or without audio or EPUB
  rejected: number;
  // Not taken this time, tried again later
  failed: number;
  // When background alignments run, when the Sync server reports it
  window?: NoBookEndsSyncStatus['window'];
}

/**
 * The Audiobookshelf settings as the settings page gets them: the admin API
 * key is never returned, only whether one is saved
 */
export type AudiobookshelfSettingsResponse = Omit<
  AudiobookshelfSettings,
  'adminApiKey'
> & {
  adminApiKeySet: boolean;
};

export interface AudiobookshelfAuthorMatchResponse {
  // Authors in the libraries
  total: number;
  // Authors without a photo that got one
  matched: number;
  // Authors without a photo that Audnexus has none for
  noPhoto: number;
  // Authors that could not be matched this time
  failed: number;
  // False while matching still runs in the background
  done: boolean;
}
