import type {
  ReadingAppChoices,
  ReadingAppState,
  ReadingKind,
  UserAccessApp,
  UserAppAccountGrant,
  UserAppAccountStatus,
} from '@server/constants/userAccess';

// Kept free of server code, so the settings pages can use them too

export type AgeLimit = 'none' | 'teen' | 'tween' | 'kids';

export type OidcApp = 'audiobookshelf' | 'kavita' | 'komga' | 'nobookends';

export interface AppLibrary {
  id: string;
  name: string;
}

export interface UserAccessAppConnectionResponse {
  url: string;
  publicUrl: string;
  username: string;
  apiKeySet: boolean;
  passwordSet: boolean;
}

export interface UserAccessSettingsResponse {
  audiobookshelf: UserAccessAppConnectionResponse;
  kavita: UserAccessAppConnectionResponse;
  komga: UserAccessAppConnectionResponse;
  grimmory: UserAccessAppConnectionResponse;
  emailPasswords: boolean;
  // Keeps linked app usernames the same as Plex usernames
  matchPlexUsernames: boolean;
}

export interface PlexDefaultAppSettings {
  enabled: boolean;
  libraryIds: string[] | null;
}

export interface PlexDefaultAccessResponse {
  enabled: boolean;
  apps: Record<UserAccessApp, PlexDefaultAppSettings>;
  ageLimit: AgeLimit | null;
  includeUnrated: boolean;
}

export interface PlexDefaultChange {
  userId: number;
  displayName: string;
  app: UserAccessApp;
  change: 'granted' | 'removed';
}

export interface UserAccessAppInfo {
  app: UserAccessApp;
  name: string;
  connected: boolean;
  publicUrl: string | null;
  libraries: AppLibrary[];
  error: string | null;
}

export interface PersonAppAccess {
  enabled: boolean;
  libraryIds: string[] | null;
  status: UserAppAccountStatus;
  remoteUsername: string | null;
  lastError: string | null;
  syncedAt: Date | null;
  // admin, plex (the default for Plex users) or null for older accounts
  grantedBy: UserAppAccountGrant | null;
  // When the person asked for access and no admin has answered yet
  accessRequestedAt: Date | null;
}

export interface PersonAccess {
  userId: number;
  displayName: string;
  email: string;
  avatar: string;
  userType: number;
  isAdmin: boolean;
  ageLimit: AgeLimit | null;
  includeUnrated: boolean;
  apps: Record<UserAccessApp, PersonAppAccess>;
}

export interface NewAppPassword {
  username: string;
  password: string;
  emailed: boolean;
}

/**
 * New passwords made while saving, keyed by app. They are shown once and
 * never stored.
 */
export type NewPasswords = Partial<Record<UserAccessApp, NewAppPassword>>;

export interface PersonUpdateResult {
  person: PersonAccess;
  passwords: NewPasswords;
}

/**
 * An account in an app, who it is linked to and who it likely belongs to
 */
export interface AppAccountListItem {
  id: string;
  username: string;
  email: string | null;
  isAdmin: boolean;
  // The person the account is linked to
  linkedUserId: number | null;
  linkedDisplayName: string | null;
  // A person without an account in the app who likely owns this one: the
  // same email, the same username, or one username inside the other
  suggestedUserId: number | null;
  suggestedDisplayName: string | null;
  // Why the account is a service account and no person's: its name is one
  // Allseerr's tools use, the app connection signs in with it, or an admin
  // marked it. Service accounts are never suggested, linked or renamed.
  service: 'name' | 'connection' | 'marked' | null;
}

export interface AppAccountRenameItem {
  userId: number;
  displayName: string;
  app: UserAccessApp;
  from: string;
  to: string;
  date: string;
}

export interface AppAccountsResponse {
  app: UserAccessApp;
  accounts: AppAccountListItem[];
}

export interface LinkAppAccountResult extends PersonUpdateResult {
  // Something the link could not do, such as set the email in the app
  warning: string | null;
}

export type InviteApps = Partial<
  Record<UserAccessApp, { libraryIds: string[] | null }>
>;

export interface InviteSummary {
  id: number;
  label: string | null;
  apps: InviteApps;
  ageLimit: AgeLimit | null;
  includeUnrated: boolean;
  expiresAt: Date;
  redeemedAt: Date | null;
  redeemedBy: { id: number; displayName: string } | null;
  revokedAt: Date | null;
  createdAt: Date;
  createdBy: { id: number; displayName: string } | null;
}

export interface OidcClientResponse {
  app: OidcApp;
  clientId: string;
  redirectUris: string[];
  enabled: boolean;
}

export interface OidcSettingsResponse {
  enabled: boolean;
  // The issuer apps are given, null until the application address is set
  issuer: string | null;
  clients: OidcClientResponse[];
  // Redirect addresses each app uses, from its public address
  defaultRedirectUris: Record<OidcApp, string[]>;
}

/**
 * Where a person stands in a reading app, for their Reading apps settings
 * and NoBookEnds
 */
export interface ReadingAppStatus {
  app: UserAccessApp;
  name: string;
  // What the app is for, such as "Audiobooks and ebooks"
  purpose: string;
  // The kinds of books the admin picked this app for
  kinds: ReadingKind[];
  state: ReadingAppState;
  // The person's username in the app, once their account is ready
  username?: string;
  publicUrl?: string;
  message?: string;
  // Whether the app offers "Sign in with Allseerr"
  signInWithAllseerr: boolean;
  // A ready account the person had before Allseerr linked it, which keeps
  // the password they chose
  ownAccount: boolean;
  // Whether the person can get a new password here, only for accounts
  // Allseerr made
  canResetPassword: boolean;
}

export interface ReadingAppsResponse {
  apps: ReadingAppStatus[];
  // The app each kind of book is read or heard in
  readingApps: ReadingAppChoices;
}

export interface ReadingAppSetupResult {
  app: ReadingAppStatus;
  // The new password, shown once, when an account was made
  password?: NewAppPassword;
}

/**
 * Whether this server is listed in the NoBookEnds directory
 */
export interface NoBookEndsDirectoryStatus {
  enabled: boolean;
  // What is missing before the server can be listed
  applicationUrlMissing: boolean;
  plexMissing: boolean;
  // How the last registration went, null before the first one
  lastResult: {
    date: string;
    // The Plex servers listed, when it worked
    registered: number | null;
    error: string | null;
  } | null;
}
