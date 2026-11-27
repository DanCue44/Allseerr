// Apps whose accounts Allseerr can manage for the people it knows
export const USER_ACCESS_APPS = [
  'audiobookshelf',
  'kavita',
  'komga',
  'grimmory',
] as const;

export type UserAccessApp = (typeof USER_ACCESS_APPS)[number];

export const isUserAccessApp = (value: unknown): value is UserAccessApp =>
  typeof value === 'string' &&
  (USER_ACCESS_APPS as readonly string[]).includes(value);

export const USER_ACCESS_APP_NAMES: Record<UserAccessApp, string> = {
  audiobookshelf: 'Audiobookshelf',
  kavita: 'Kavita',
  komga: 'Komga',
  grimmory: 'Grimmory',
};

/**
 * Where an account in an app stands: none yet, working, turned off because
 * access was taken away, or failed to sync
 */
export enum UserAppAccountStatus {
  NONE = 'none',
  ACTIVE = 'active',
  DISABLED = 'disabled',
  ERROR = 'error',
}

/**
 * Who gave a person an app: an admin, on purpose, or the default access for
 * everyone with access to the Plex server. Explicit choices always win.
 */
export enum UserAppAccountGrant {
  ADMIN = 'admin',
  PLEX = 'plex',
}

// How long an invite link can be used, unless the admin picks another time
export const DEFAULT_INVITE_DAYS = 7;
export const MAX_INVITE_DAYS = 90;

// Kinds of books a person can ask for, each read or heard in one app
export const READING_KINDS = ['audiobook', 'ebook', 'comic'] as const;

export type ReadingKind = (typeof READING_KINDS)[number];

export const isReadingKind = (value: unknown): value is ReadingKind =>
  typeof value === 'string' &&
  (READING_KINDS as readonly string[]).includes(value);

// The apps the admin can pick to serve each kind
export const READING_KIND_APPS: Record<ReadingKind, readonly UserAccessApp[]> =
  {
    audiobook: ['audiobookshelf', 'grimmory'],
    ebook: ['audiobookshelf', 'kavita', 'grimmory'],
    comic: ['kavita', 'komga'],
  };

export type ReadingAppChoices = Record<ReadingKind, UserAccessApp>;

export const defaultReadingAppChoices = (): ReadingAppChoices => ({
  audiobook: 'audiobookshelf',
  ebook: 'audiobookshelf',
  comic: 'kavita',
});

/**
 * Where a person stands in an app, as their Reading apps settings show it:
 * signed up, allowed but without an account yet, not allowed, asked an
 * admin for access, or the account could not be made
 */
export enum ReadingAppState {
  READY = 'ready',
  AVAILABLE = 'available',
  NOT_GRANTED = 'notGranted',
  REQUESTED = 'requested',
  ERROR = 'error',
}
