import type { BookFormatChoice } from '@server/constants/media';
import type RemovalRequest from '@server/entity/RemovalRequest';
import type {
  CleanupActionResult,
  CleanupSuggestion,
} from '@server/lib/watchedCleanup';
import type { PaginatedResponse } from './common';

export interface RemovalRequestResultsResponse extends PaginatedResponse {
  results: RemovalRequest[];
}

export interface RemovalRequestBody {
  mediaId: number;
  is4k?: boolean;
  reason?: string;
  bookFormat?: BookFormatChoice;
}

export interface WatchedCleanupResponse {
  results: CleanupSuggestion[];
}

export interface WatchedCleanupActionBody {
  items: { mediaId: number; is4k?: boolean }[];
  action: 'request' | 'remove';
}

export interface WatchedCleanupActionResponse {
  results: CleanupActionResult[];
}
