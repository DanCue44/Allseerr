import type { BlockedGenres } from '@server/lib/genreBlock';
import type { NotificationAgentKey } from '@server/lib/settings';

export interface UserSettingsGeneralResponse {
  username?: string;
  email?: string;
  locale?: string;
  discoverRegion?: string;
  streamingRegion?: string;
  originalLanguage?: string;
  accentColor?: string | null;
  // Null uses the server default
  bookLanguage?: string | null;
  movieQuotaLimit?: number;
  movieQuotaDays?: number;
  tvQuotaLimit?: number;
  tvQuotaDays?: number;
  musicQuotaLimit?: number;
  musicQuotaDays?: number;
  bookQuotaLimit?: number;
  bookQuotaDays?: number;
  unwatchedQuotaLimit?: number | null;
  unwatchedQuotaDays?: number | null;
  movieRatingLimit?: string | null;
  tvRatingLimit?: string | null;
  // The user's own blocked genres, null to follow the server's list
  blockedGenres?: BlockedGenres | null;
  globalMovieQuotaDays?: number;
  globalMovieQuotaLimit?: number;
  globalTvQuotaLimit?: number;
  globalTvQuotaDays?: number;
  globalMusicQuotaLimit?: number;
  globalMusicQuotaDays?: number;
  globalBookQuotaLimit?: number;
  globalBookQuotaDays?: number;
  globalUnwatchedQuotaLimit?: number;
  globalUnwatchedQuotaDays?: number;
  watchlistSyncMovies?: boolean;
  watchlistSyncTv?: boolean;
  hideWatched?: boolean;
}

export type NotificationAgentTypes = Record<NotificationAgentKey, number>;
export interface UserSettingsNotificationsResponse {
  emailEnabled?: boolean;
  pgpKey?: string;
  discordEnabled?: boolean;
  discordEnabledTypes?: number;
  discordIds?: string[];
  pushbulletAccessToken?: string;
  pushoverApplicationToken?: string;
  pushoverUserKey?: string;
  pushoverSound?: string;
  telegramEnabled?: boolean;
  telegramBotUsername?: string;
  telegramChatId?: string;
  telegramMessageThreadId?: string;
  telegramSendSilently?: boolean;
  webPushEnabled?: boolean;
  notificationTypes: Partial<NotificationAgentTypes>;
}
