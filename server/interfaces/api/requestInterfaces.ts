import type { AudiobookVersion } from '@server/constants/audiobookVersion';
import type { BookRecordingKind } from '@server/constants/bookRecording';
import type {
  BookFormatChoice,
  ComicKind,
  MediaRequestMonitorMode,
  MediaRequestStatus,
  MediaType,
} from '@server/constants/media';
import type { MediaRequest } from '@server/entity/MediaRequest';
import type { RequestedEpisodes } from '@server/lib/episodeRequests';
import type { NonFunctionProperties, PaginatedResponse } from './common';

export interface RequestResultsResponse extends PaginatedResponse {
  results: (NonFunctionProperties<MediaRequest> & {
    profileName?: string;
    canRemove?: boolean;
    // "Notify me too": how many users asked to be told, and whether the
    // user asking is one of them
    interest?: { count: number; interested: boolean };
  })[];
  serviceErrors: {
    radarr: { id: number; name: string }[];
    sonarr: { id: number; name: string }[];
    lidarr?: { id: number; name: string }[];
  };
}

export type MediaRequestBody = {
  mediaType: MediaType;
  // TMDB id for movies and series, MusicBrainz release group id for music,
  // OpenLibrary work id for books and comic id for comics, such as al-30013
  mediaId: number | string;
  tvdbId?: number;
  seasons?: number[] | 'all';
  episodes?: RequestedEpisodes[];
  monitorMode?: MediaRequestMonitorMode;
  is4k?: boolean;
  // Books only, requests the audiobook instead of the ebook
  isAudiobook?: boolean;
  // Books only, an ISO 639-1 code or 'any'. Only honored for users who
  // manage requests, everyone else requests in their own language.
  language?: string;
  // Audiobooks on Talearr only: asks for another recording of an audiobook
  // that is already available instead of the audiobook itself
  recording?: BookRecordingKind;
  // The narrator a narrator recording is asked for
  recordingNarrator?: string;
  // Talearr's id of the edition an edition recording is asked for
  recordingEditionId?: number;
  // Audiobooks on Talearr only, with Audiobook Versions at `requester`:
  // the unabridged reading, the abridged one or both
  audiobookVersion?: AudiobookVersion | null;
  // Comics only: files a series as manga or as a comic, for a series only
  // Hardcover knows, whose kind the lookup could not tell
  comicKind?: ComicKind;
  // Comics only: the volume numbers to ask for. None asks for the whole
  // series.
  volumes?: number[] | null;
  serverId?: number;
  profileId?: number;
  profileName?: string;
  rootFolder?: string;
  languageProfileId?: number;
  userId?: number;
  tags?: number[];
  ignoreQuota?: boolean;
};

// Albums of an artist's discography, requested in one go
export type DiscographyRequestBody = {
  // MusicBrainz artist id
  artistId: string;
  // MusicBrainz release group ids of the albums to request
  mbIds: string[];
  serverId?: number;
  profileId?: number;
  rootFolder?: string;
  tags?: number[];
  userId?: number;
  ignoreQuota?: boolean;
  // Has Lidarr monitor the new albums of the artist
  monitorNewReleases?: boolean;
};

// Works of an author, requested in one go in one or both formats
export type AuthorCatalogRequestBody = {
  // OpenLibrary author id
  authorId: string;
  // OpenLibrary work ids of the books to request
  olIds: string[];
  format: BookFormatChoice;
  // An ISO 639-1 code or 'any', only honored for users who manage requests
  language?: string;
  userId?: number;
  ignoreQuota?: boolean;
};

export interface BulkRequestItem {
  mediaId: string;
  title: string;
  // Books only
  isAudiobook?: boolean;
  // Created requests only
  requestId?: number;
  status?: MediaRequestStatus;
  // Why the album or book was skipped (a BulkSkipReason), or the error
  // that failed it
  reason?: string;
}

export interface BulkRequestResponse {
  created: BulkRequestItem[];
  skipped: BulkRequestItem[];
  failed: BulkRequestItem[];
  // Discography requests only: whether Lidarr was asked to monitor new
  // releases of the artist
  monitorNewReleases?: boolean;
}

export interface RequestInterestResponse {
  results: {
    requestId: number;
    count: number;
    interested: boolean;
  }[];
}
