import { AudiobookshelfAdminAPI } from '@server/api/userAccess/audiobookshelfAdmin';
import { GrimmoryAdminAPI } from '@server/api/userAccess/grimmoryAdmin';
import { KavitaAdminAPI } from '@server/api/userAccess/kavitaAdmin';
import { KomgaAdminAPI } from '@server/api/userAccess/komgaAdmin';
import type {
  AppAccess,
  AppAccountSummary,
  RemoteAccount,
  UserAccessAppClient,
} from '@server/api/userAccess/types';
import type { UserAccessApp } from '@server/constants/userAccess';
import {
  USER_ACCESS_APPS,
  USER_ACCESS_APP_NAMES,
  UserAppAccountGrant,
  UserAppAccountStatus,
} from '@server/constants/userAccess';
import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import { UserAccessProfile } from '@server/entity/UserAccessProfile';
import { UserAppAccount } from '@server/entity/UserAppAccount';
import type {
  AppAccountListItem,
  LinkAppAccountResult,
  NewPasswords,
  PersonAccess,
  PersonAppAccess,
  PersonUpdateResult,
} from '@server/interfaces/api/userAccessInterfaces';
import notificationManager, { Notification } from '@server/lib/notifications';
import { hasRealEmail } from '@server/lib/oidc/claims';
import { Permission } from '@server/lib/permissions';
import type { UserAccessAppConnection } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import type { AgeLimit } from '@server/lib/userAccess/ageLimits';
import { isRestricted } from '@server/lib/userAccess/ageLimits';
import { sendAppAccountEmail } from '@server/lib/userAccess/email';
import { applyPlexDefaults } from '@server/lib/userAccess/plexDefaults';
import { savedKey } from '@server/lib/userAccess/readingApps';
import {
  connectionAccountIdFor,
  isMatchingPlexUsernames,
  renameToPlexUsername,
  serviceReasonFor,
} from '@server/lib/userAccess/rename';
import logger from '@server/logger';
import { randomInt } from 'crypto';

export type { NewPasswords, PersonAccess, PersonAppAccess, PersonUpdateResult };

export interface PersonAccessChanges {
  ageLimit?: AgeLimit | null;
  includeUnrated?: boolean;
  apps?: Partial<
    Record<UserAccessApp, { enabled?: boolean; libraryIds?: string[] | null }>
  >;
}

// Letters and digits that cannot be mistaken for each other when read aloud
const PASSWORD_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

/**
 * A password that is easy to type: four groups of four, such as
 * kx7m-4qpr-9fhd-2wne
 */
export const generateAppPassword = (): string =>
  Array.from({ length: 4 }, () =>
    Array.from(
      { length: 4 },
      () => PASSWORD_ALPHABET[randomInt(PASSWORD_ALPHABET.length)]
    ).join('')
  ).join('-');

/**
 * The username a person gets in the apps: their Plex username, so it is the
 * name Plex shows, else their Allseerr or Jellyfin username, else the start
 * of their email, with only letters, digits, dots, dashes and underscores
 */
export const appUsernameFor = (user: User): string => {
  const base =
    user.plexUsername ||
    user.username ||
    user.jellyfinUsername ||
    user.email?.split('@')[0] ||
    `user${user.id}`;
  const cleaned = base
    .normalize('NFKD')
    .replace(/[^\w.-]+/g, '')
    .replace(/^[.-]+/, '');

  return cleaned || `user${user.id}`;
};

const connectionFor = (app: UserAccessApp): UserAccessAppConnection => {
  const settings = getSettings();
  const connection = settings.userAccess[app];

  // Grimmory set up in the services signs in the same way
  if (app === 'grimmory' && !connection.url && settings.grimmory.url) {
    return {
      ...connection,
      url: settings.grimmory.url,
      publicUrl: connection.publicUrl || settings.grimmory.publicUrl,
      username: connection.username || settings.grimmory.username,
      password: connection.password || settings.grimmory.password,
    };
  }

  // Audiobookshelf is often already linked for book links
  if (app === 'audiobookshelf' && !connection.url) {
    return {
      ...connection,
      url: settings.audiobookshelf.url,
      publicUrl: connection.publicUrl || settings.audiobookshelf.url,
    };
  }

  return connection;
};

export const isAppConnected = (app: UserAccessApp): boolean => {
  const { url, apiKey, username, password } = connectionFor(app);

  return !!url && (!!apiKey || (!!username && !!password));
};

/**
 * The admin client for an app, or null while it is not set up
 */
export const getAppClient = (
  app: UserAccessApp,
  connection: UserAccessAppConnection = connectionFor(app)
): UserAccessAppClient | null => {
  if (
    !connection.url ||
    (!connection.apiKey && !(connection.username && connection.password))
  ) {
    return null;
  }

  const options = {
    url: connection.url,
    apiKey: connection.apiKey,
    username: connection.username,
    password: connection.password,
  };

  switch (app) {
    case 'audiobookshelf':
      return new AudiobookshelfAdminAPI(options);
    case 'kavita':
      return new KavitaAdminAPI(options);
    case 'komga':
      return new KomgaAdminAPI(options);
    case 'grimmory':
      return new GrimmoryAdminAPI(options);
  }
};

export const getAppPublicUrl = (app: UserAccessApp): string | undefined => {
  const connection = connectionFor(app);

  return connection.publicUrl || connection.url || undefined;
};

const emptyAppAccess = (): PersonAppAccess => ({
  enabled: false,
  libraryIds: null,
  status: UserAppAccountStatus.NONE,
  remoteUsername: null,
  lastError: null,
  syncedAt: null,
  grantedBy: null,
  accessRequestedAt: null,
});

const toPersonAccess = (
  user: User,
  profile: UserAccessProfile | undefined,
  accounts: UserAppAccount[]
): PersonAccess => {
  const apps = Object.fromEntries(
    USER_ACCESS_APPS.map((app) => {
      const account = accounts.find((a) => a.app === app);

      return [
        app,
        account
          ? {
              enabled: account.enabled,
              libraryIds: account.libraryIds ?? null,
              status: account.status,
              remoteUsername: account.remoteUsername ?? null,
              lastError: account.lastError ?? null,
              syncedAt: account.syncedAt ?? null,
              grantedBy: account.grantedBy ?? null,
              accessRequestedAt: account.enabled
                ? null
                : (account.accessRequestedAt ?? null),
            }
          : emptyAppAccess(),
      ];
    })
  ) as Record<UserAccessApp, PersonAppAccess>;

  return {
    userId: user.id,
    displayName: user.displayName,
    email: user.email,
    avatar: user.avatar,
    userType: user.userType,
    isAdmin: user.hasPermission(Permission.ADMIN),
    ageLimit: profile?.ageLimit ?? null,
    includeUnrated: profile?.includeUnrated ?? false,
    apps,
  };
};

export const getAccessProfile = async (
  userId: number
): Promise<UserAccessProfile | null> =>
  getRepository(UserAccessProfile).findOne({
    where: { user: { id: userId } },
  });

/**
 * The age limit for a person, none when no limit is set. Admins are never
 * limited.
 */
export const getAgeLimit = async (
  user: User
): Promise<{ ageLimit: AgeLimit | null; includeUnrated: boolean }> => {
  if (user.hasPermission(Permission.ADMIN)) {
    return { ageLimit: null, includeUnrated: true };
  }

  const profile = await getAccessProfile(user.id);

  return {
    ageLimit: isRestricted(profile?.ageLimit) ? profile.ageLimit : null,
    includeUnrated: profile?.includeUnrated ?? false,
  };
};

export const listPeople = async (): Promise<PersonAccess[]> => {
  const users = await getRepository(User).find({ order: { id: 'ASC' } });
  const profiles = await getRepository(UserAccessProfile).find({
    relations: { user: true },
  });
  const accounts = await getRepository(UserAppAccount).find({
    relations: { user: true },
  });

  return users.map((user) =>
    toPersonAccess(
      user,
      profiles.find((profile) => profile.user?.id === user.id),
      accounts.filter((account) => account.user?.id === user.id)
    )
  );
};

export const getPerson = async (userId: number): Promise<PersonAccess> => {
  const user = await getRepository(User).findOneOrFail({
    where: { id: userId },
  });
  const profile = await getAccessProfile(userId);
  const accounts = await getRepository(UserAppAccount).find({
    where: { user: { id: userId } },
  });

  return toPersonAccess(user, profile ?? undefined, accounts);
};

const accessFor = (
  account: UserAppAccount,
  limit: { ageLimit: AgeLimit | null; includeUnrated: boolean }
): AppAccess => ({
  enabled: account.enabled,
  libraryIds: account.libraryIds ?? null,
  canDownload: account.canDownload ?? null,
  ageLimit: limit.ageLimit,
  includeUnrated: limit.includeUnrated,
});

const recordError = async (
  account: UserAppAccount,
  error: unknown
): Promise<void> => {
  account.status = UserAppAccountStatus.ERROR;
  account.lastError = (error as Error)?.message ?? String(error);
  await getRepository(UserAppAccount).save(account);

  logger.warn('Failed to sync an app account', {
    label: 'User Access',
    app: account.app,
    userId: account.user?.id,
    message: account.lastError,
  });
};

/**
 * Forgets the key made for NoBookEnds, such as when the account it signs
 * in to is gone
 */
export const clearNoBookEndsToken = (account: UserAppAccount): void => {
  account.nobookendsToken = null;
  account.nobookendsTokenId = null;
};

export const remoteOf = (account: UserAppAccount): RemoteAccount | null =>
  account.remoteUserId
    ? {
        id: account.remoteUserId,
        username: account.remoteUsername ?? '',
      }
    : null;

/**
 * Makes sure the person's account in the app matches their access: links
 * an account with the same username or email, makes one with a new password
 * when access is on and there is none, and turns it off when access is off.
 * Answers with the new password when one was made.
 */
export const syncAppAccount = async (
  user: User,
  account: UserAppAccount,
  options: { sendEmail?: boolean; create?: boolean } = {}
): Promise<{ username: string; password: string; emailed: boolean } | null> => {
  const client = getAppClient(account.app);

  if (!client) {
    return null;
  }

  const limit = await getAgeLimit(user);
  const access = accessFor(account, limit);
  const repository = getRepository(UserAppAccount);

  try {
    let remote =
      remoteOf(account) ??
      (await client.findAccount({
        username: appUsernameFor(user),
        email: user.email,
      }));

    // A linked account that was removed in the app is looked up again
    if (remote && account.remoteUserId) {
      const found = await client.findAccount({ remoteUserId: remote.id });
      remote =
        found ??
        (await client.findAccount({
          username: appUsernameFor(user),
          email: user.email,
        }));
    }

    let created: {
      username: string;
      password: string;
      emailed: boolean;
    } | null = null;

    if (!remote) {
      if (!account.enabled || options.create === false) {
        account.status = UserAppAccountStatus.NONE;
        account.lastError = null;
        account.remoteUserId = null;
        account.remoteUsername = null;
        account.madeByAllseerr = false;
        clearNoBookEndsToken(account);
        account.syncedAt = new Date();
        await repository.save(account);
        return null;
      }

      const username = appUsernameFor(user);
      const password = generateAppPassword();
      remote = await client.createAccount({
        ...access,
        username,
        email: user.email,
        password,
      });

      const emailed =
        options.sendEmail !== false &&
        getSettings().userAccess.emailPasswords &&
        (await sendAppAccountEmail({
          user,
          appName: USER_ACCESS_APP_NAMES[account.app],
          appUrl: getAppPublicUrl(account.app),
          username: remote.username || username,
          password,
        }));

      created = {
        username: remote.username || username,
        password,
        emailed: !!emailed,
      };
    } else {
      await client.updateAccount(remote, access);
    }

    // A key made for another account is of no use to this one
    if (account.remoteUserId && account.remoteUserId !== remote.id) {
      clearNoBookEndsToken(account);
    }
    if (created) {
      account.madeByAllseerr = true;
    } else if (account.remoteUserId !== remote.id) {
      // An account the person already had keeps the password they chose
      account.madeByAllseerr = false;
    }
    account.remoteUserId = remote.id;
    account.remoteUsername = remote.username;
    account.status = account.enabled
      ? UserAppAccountStatus.ACTIVE
      : UserAppAccountStatus.DISABLED;
    account.lastError = null;
    account.syncedAt = new Date();
    await repository.save(account);

    return created;
  } catch (e) {
    await recordError(account, e);
    return null;
  }
};

/**
 * Tells a person an app was turned on for them, with a link that sets it up
 * in one tap
 */
export const sendAccessGranted = (user: User, app: UserAccessApp): void => {
  const appName = USER_ACCESS_APP_NAMES[app];

  notificationManager.sendNotification(Notification.ACCESS_GRANTED, {
    event: 'Reading App Access Granted',
    subject: `Your ${appName} access is ready`,
    message: `Your ${appName} access is ready. Set it up in one tap.`,
    notifyAdmin: false,
    notifySystem: false,
    notifyUser: user,
    actionPath: `/profile/settings/apps?app=${app}`,
  });
};

/**
 * Saves a person's age limit and app access, then brings their accounts in
 * line with it. Turning an app on only allows it: the person sets the
 * account up themselves, unless createAccounts asks for it now, as an invite
 * does. Accounts the person already has are linked either way.
 */
export const updatePerson = async (
  userId: number,
  changes: PersonAccessChanges,
  options: { createAccounts?: boolean; notify?: boolean } = {}
): Promise<PersonUpdateResult> => {
  const user = await getRepository(User).findOneOrFail({
    where: { id: userId },
  });
  const profileRepository = getRepository(UserAccessProfile);
  const accountRepository = getRepository(UserAppAccount);
  const granted: UserAccessApp[] = [];

  if (changes.ageLimit !== undefined || changes.includeUnrated !== undefined) {
    const profile =
      (await getAccessProfile(userId)) ??
      new UserAccessProfile({ user, includeUnrated: false });

    if (changes.ageLimit !== undefined) {
      profile.ageLimit = isRestricted(changes.ageLimit)
        ? changes.ageLimit
        : null;
    }
    if (changes.includeUnrated !== undefined) {
      profile.includeUnrated = changes.includeUnrated;
    }

    await profileRepository.save(profile);
  }

  for (const app of USER_ACCESS_APPS) {
    const change = changes.apps?.[app];

    if (!change) {
      continue;
    }

    const account =
      (await accountRepository.findOne({
        where: { user: { id: userId }, app },
      })) ??
      new UserAppAccount({
        user,
        app,
        enabled: false,
        libraryIds: null,
        status: UserAppAccountStatus.NONE,
      });

    if (change.enabled !== undefined) {
      if (change.enabled && !account.enabled) {
        granted.push(app);
      }
      account.enabled = change.enabled;
      // Turning access on or off answers an ask for it
      account.accessRequestedAt = null;
    }
    // A choice made for this person wins over the default access for Plex
    // users from now on
    account.grantedBy = UserAppAccountGrant.ADMIN;
    if (change.libraryIds !== undefined) {
      account.libraryIds = change.libraryIds?.length ? change.libraryIds : null;
    }

    await accountRepository.save(account);
  }

  const passwords = await syncPerson(user, {
    create: !!options.createAccounts,
  });

  if (options.notify) {
    for (const app of granted) {
      const account = await accountRepository.findOne({
        where: { user: { id: userId }, app },
      });

      // Nothing to tell someone whose account was linked and is ready
      if (account?.status !== UserAppAccountStatus.ACTIVE) {
        sendAccessGranted(user, app);
      }
    }
  }

  return { person: await getPerson(userId), passwords };
};

/**
 * Makes the person's account in an app now, for an admin who wants to hand
 * over the password themselves
 */
export const createAppAccountNow = async (
  userId: number,
  app: UserAccessApp
): Promise<PersonUpdateResult> => {
  const user = await getRepository(User).findOneOrFail({
    where: { id: userId },
  });
  const account = await getRepository(UserAppAccount).findOne({
    where: { user: { id: userId }, app },
    relations: { user: true },
  });

  if (!account?.enabled) {
    throw new Error(`Turn on ${USER_ACCESS_APP_NAMES[app]} for them first.`);
  }

  const created = await syncAppAccount(user, account, { create: true });

  return {
    person: await getPerson(userId),
    passwords: created ? { [app]: created } : {},
  };
};

/**
 * Brings every app account of a person in line with their access
 */
export const syncPerson = async (
  user: User,
  options: { create?: boolean } = {}
): Promise<NewPasswords> => {
  const accounts = await getRepository(UserAppAccount).find({
    where: { user: { id: user.id } },
    relations: { user: true },
  });
  const passwords: NewPasswords = {};

  for (const account of accounts) {
    // Nothing to do for an app the person never had and still does not have
    if (!account.enabled && !account.remoteUserId) {
      continue;
    }

    const created = await syncAppAccount(user, account, options);

    if (created) {
      passwords[account.app] = created;
    }
  }

  return passwords;
};

/**
 * Gives the person a new password in an app, shown once and emailed when
 * email is set up
 */
export const resetAppPassword = async (
  userId: number,
  app: UserAccessApp
): Promise<{ username: string; password: string; emailed: boolean }> => {
  const user = await getRepository(User).findOneOrFail({
    where: { id: userId },
  });
  const account = await getRepository(UserAppAccount).findOne({
    where: { user: { id: userId }, app },
  });
  const client = getAppClient(app);
  const remote = account ? remoteOf(account) : null;

  if (!client || !account || !remote) {
    throw new Error(`${USER_ACCESS_APP_NAMES[app]} has no account to reset.`);
  }

  const password = generateAppPassword();
  await client.setPassword(remote, password);

  const emailed =
    getSettings().userAccess.emailPasswords &&
    (await sendAppAccountEmail({
      user,
      appName: USER_ACCESS_APP_NAMES[app],
      appUrl: getAppPublicUrl(app),
      username: remote.username,
      password,
    }));

  return { username: remote.username, password, emailed: !!emailed };
};

/**
 * Deletes the person's account in the app, with its reading progress, and
 * takes away their access to it
 */
export const removeAppAccount = async (
  userId: number,
  app: UserAccessApp
): Promise<PersonAccess> => {
  const account = await getRepository(UserAppAccount).findOne({
    where: { user: { id: userId }, app },
  });

  if (account) {
    const client = getAppClient(app);
    const remote = remoteOf(account);

    if (client && remote) {
      await client.deleteAccount(remote);
    }

    account.enabled = false;
    account.remoteUserId = null;
    account.remoteUsername = null;
    account.accessRequestedAt = null;
    account.madeByAllseerr = false;
    clearNoBookEndsToken(account);
    account.status = UserAppAccountStatus.NONE;
    account.lastError = null;
    account.syncedAt = new Date();
    await getRepository(UserAppAccount).save(account);
  }

  return getPerson(userId);
};

/**
 * Brings everyone's accounts in line, for the scheduled sync. Accounts
 * made by signing in with Allseerr get their libraries and age limit this
 * way.
 */
let syncRunning = false;

export const isSyncRunning = (): boolean => syncRunning;

export const syncEveryone = async (): Promise<void> => {
  if (syncRunning) {
    return;
  }
  syncRunning = true;

  try {
    // Plex shares can change any time, so the default access is checked
    // before the accounts are brought in line
    try {
      await applyPlexDefaults();
    } catch (e) {
      logger.error('Could not apply default access for Plex users', {
        label: 'User Access',
        errorMessage: (e as Error).message,
      });
    }
    await syncAllAccounts();
    await renameDriftedAccounts();
  } finally {
    syncRunning = false;
  }
};

const syncAllAccounts = async (): Promise<void> => {
  const accounts = await getRepository(UserAppAccount).find({
    relations: { user: true },
  });
  const users = new Map<number, User>();

  for (const account of accounts) {
    if (account.user) {
      users.set(account.user.id, account.user);
    }
  }

  // Accounts are only made when an admin turns access on, so nobody gets
  // a password they never see
  for (const user of users.values()) {
    await syncPerson(user, { create: false });
  }
};

export class AccountLinkConflictError extends Error {}
export class ServiceAccountError extends Error {}
export class AccountNotFoundError extends Error {}

const sameName = (a?: string | null, b?: string | null): boolean =>
  !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

// Shorter names than this match too much when one is inside the other
const MIN_CONTAINED_LENGTH = 4;

/**
 * How likely an app account is the person's: 3 for the same email, 2 for
 * the same username, 1 for one username inside the other, such as dcuellar
 * and dcuellar44, and 0 otherwise. Any of the person's names counts: their
 * Allseerr, Plex and Jellyfin usernames, the name they get in the apps and
 * the start of their email.
 */
export const accountMatchScore = (
  user: User,
  account: Pick<RemoteAccount, 'username' | 'email'>
): number => {
  if (
    user.email &&
    hasRealEmail(user.email) &&
    sameName(user.email, account.email)
  ) {
    return 3;
  }

  const names = [
    user.username,
    user.plexUsername,
    user.jellyfinUsername,
    appUsernameFor(user),
    user.email && hasRealEmail(user.email)
      ? user.email.split('@')[0]
      : undefined,
  ]
    .filter((name): name is string => !!name)
    .map((name) => name.trim().toLowerCase());
  const username = account.username.trim().toLowerCase();

  if (!username) {
    return 0;
  }
  if (names.includes(username)) {
    return 2;
  }

  return names.some(
    (name) =>
      Math.min(name.length, username.length) >= MIN_CONTAINED_LENGTH &&
      (name.includes(username) || username.includes(name))
  )
    ? 1
    : 0;
};

/**
 * The person who best matches an account, among those not linked in the
 * app yet. None when two people match equally well.
 */
const suggestPerson = (
  users: User[],
  account: AppAccountSummary
): User | null => {
  const scored = users
    .map((user) => ({ user, score: accountMatchScore(user, account) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0 || scored[1]?.score === scored[0].score) {
    return null;
  }

  return scored[0].user;
};

/**
 * Every account in an app with the person it is linked to, and for the
 * others the person it likely belongs to. Nothing is linked here: an admin
 * confirms each link.
 */
export const listAppAccounts = async (
  app: UserAccessApp
): Promise<AppAccountListItem[]> => {
  const client = getAppClient(app);

  if (!client) {
    throw new Error(`${USER_ACCESS_APP_NAMES[app]} is not connected.`);
  }

  const [accounts, links, users] = await Promise.all([
    client.listAccounts(),
    getRepository(UserAppAccount).find({
      where: { app },
      relations: { user: true },
    }),
    getRepository(User).find({ order: { id: 'ASC' } }),
  ]);
  // Asked after the list, so both do not sign in to the app at once
  const connectionAccountId = await connectionAccountIdFor(client);
  const linkedTo = new Map(
    links
      .filter((link) => link.remoteUserId && link.user)
      .map((link) => [link.remoteUserId as string, link.user])
  );
  const linkedUserIds = new Set([...linkedTo.values()].map((user) => user.id));
  const unlinkedUsers = users.filter((user) => !linkedUserIds.has(user.id));

  return accounts.map((account) => {
    const linked = linkedTo.get(account.id);
    const service = serviceReasonFor(app, account, connectionAccountId);
    const suggested =
      linked || service ? null : suggestPerson(unlinkedUsers, account);

    return {
      id: account.id,
      username: account.username,
      email: account.email ?? null,
      isAdmin: account.isAdmin,
      linkedUserId: linked?.id ?? null,
      linkedDisplayName: linked?.displayName ?? null,
      suggestedUserId: suggested?.id ?? null,
      suggestedDisplayName: suggested?.displayName ?? null,
      service,
    };
  });
};

/**
 * Links a person to an account they already have in an app, such as one
 * made before Allseerr managed the app or under another name. The account
 * keeps its password, Allseerr turns the app on for the person and keeps
 * the account in line with their access from now on. Kavita links people
 * signing in with Allseerr by email, so the account gets the person's email
 * when they have one; Audiobookshelf links them by username, which signing
 * in sends as the linked account's.
 */
export const linkAppAccount = async (
  userId: number,
  app: UserAccessApp,
  remoteUserId: string
): Promise<LinkAppAccountResult> => {
  const user = await getRepository(User).findOneOrFail({
    where: { id: userId },
  });
  const client = getAppClient(app);
  const appName = USER_ACCESS_APP_NAMES[app];

  if (!client) {
    throw new Error(`${appName} is not connected.`);
  }

  const accounts = await client.listAccounts();
  const remote = accounts.find((account) => account.id === remoteUserId);

  if (!remote) {
    throw new AccountNotFoundError(`${appName} has no such account.`);
  }

  const connectionAccountId = await connectionAccountIdFor(client);

  if (serviceReasonFor(app, remote, connectionAccountId)) {
    throw new ServiceAccountError(
      `${remote.username} is a service account, not a person's.`
    );
  }

  const repository = getRepository(UserAppAccount);
  const taken = await repository.findOne({
    where: { app, remoteUserId },
    relations: { user: true },
  });

  if (taken && taken.user?.id !== userId) {
    throw new AccountLinkConflictError(
      `${remote.username} is linked to ${taken.user?.displayName ?? 'someone else'} already.`
    );
  }

  const account =
    (await repository.findOne({
      where: { user: { id: userId }, app },
      relations: { user: true },
    })) ??
    new UserAppAccount({
      user,
      app,
      enabled: false,
      libraryIds: null,
      status: UserAppAccountStatus.NONE,
    });

  if (account.remoteUserId && account.remoteUserId !== remote.id) {
    clearNoBookEndsToken(account);
  }
  // What the account sees now becomes the person's access, so linking
  // changes nothing they can see
  const current = await client.getAccountAccess(remote);

  account.remoteUserId = remote.id;
  account.remoteUsername = remote.username;
  account.libraryIds = current.libraryIds;
  account.canDownload =
    current.canDownload === undefined ? null : current.canDownload;
  // The account and its password are the person's own
  account.madeByAllseerr = false;
  account.enabled = true;
  account.grantedBy = UserAppAccountGrant.ADMIN;
  account.accessRequestedAt = null;
  await repository.save(account);

  let warning: string | null = null;

  if (
    client.setEmail &&
    user.email &&
    hasRealEmail(user.email) &&
    !sameName(user.email, remote.email)
  ) {
    try {
      const changed = await client.setEmail(remote, user.email);

      if (!changed) {
        warning = `${appName} kept the old email of ${remote.username}. Change it there to ${user.email} so signing in with Allseerr finds the account.`;
      }
    } catch (e) {
      warning = `Could not set the email of ${remote.username} in ${appName}: ${(e as Error).message}`;
    }
  }

  await syncAppAccount(user, account, { create: false });

  // The account takes the person's Plex username right away
  if (account.remoteUserId === remote.id) {
    const renamed = await renameToPlexUsername({
      user,
      account,
      client,
      accounts,
      connectionAccountId,
      targetName: appUsernameFor(user),
      keyStillWorks: (linked) => nobookendsKeyWorks(client, linked),
    });

    if (renamed.status === 'clash' || renamed.status === 'failed') {
      warning = [warning, renamed.message].filter(Boolean).join(' ');
    }
  }

  if (warning) {
    logger.warn('Linked an app account without its email', {
      label: 'User Access',
      app,
      userId,
      message: warning,
    });
  }

  return { person: await getPerson(userId), passwords: {}, warning };
};

/**
 * Stops managing a person's account in an app without touching it there:
 * the account stays with its reading progress, and the app is turned off
 * for the person so the next sync does not link it again
 */
export const unlinkAppAccount = async (
  userId: number,
  app: UserAccessApp
): Promise<PersonAccess> => {
  const repository = getRepository(UserAppAccount);
  const account = await repository.findOne({
    where: { user: { id: userId }, app },
  });

  if (account) {
    account.enabled = false;
    account.remoteUserId = null;
    account.remoteUsername = null;
    account.madeByAllseerr = false;
    account.accessRequestedAt = null;
    clearNoBookEndsToken(account);
    account.status = UserAppAccountStatus.NONE;
    account.lastError = null;
    account.syncedAt = new Date();
    await repository.save(account);
  }

  return getPerson(userId);
};

/**
 * Whether the key NoBookEnds signs in with still works for the account,
 * true when there is none
 */
const nobookendsKeyWorks = async (
  client: UserAccessAppClient,
  account: UserAppAccount
): Promise<boolean> => {
  const remote = remoteOf(account);
  const saved = await savedKey(account);

  if (!remote || !saved || !client.isUserKeyValid) {
    return true;
  }

  return client.isUserKeyValid(remote, saved.key);
};

/**
 * Renames linked accounts whose username drifted from the person's Plex
 * username, such as after a Plex rename, for the scheduled sync
 */
const renameDriftedAccounts = async (): Promise<void> => {
  if (!isMatchingPlexUsernames()) {
    return;
  }

  for (const app of USER_ACCESS_APPS) {
    const client = getAppClient(app);

    if (!client?.renameAccount) {
      continue;
    }

    const linked = (
      await getRepository(UserAppAccount).find({
        where: { app },
        relations: { user: true },
      })
    ).filter((account) => account.remoteUserId && account.user);

    if (linked.length === 0) {
      continue;
    }

    try {
      // One after the other, so both do not sign in to the app at once
      const accounts = await client.listAccounts();
      const connectionAccountId = await connectionAccountIdFor(client);

      for (const account of linked) {
        const outcome = await renameToPlexUsername({
          user: account.user,
          account,
          client,
          accounts,
          connectionAccountId,
          targetName: appUsernameFor(account.user),
          keyStillWorks: (renamed) => nobookendsKeyWorks(client, renamed),
        });

        if (outcome.status === 'clash' || outcome.status === 'failed') {
          logger.warn('Could not rename an app account to match Plex', {
            label: 'User Access',
            app,
            userId: account.user.id,
            message: outcome.message,
          });
        }
      }
    } catch (e) {
      logger.warn('Could not check app usernames against Plex', {
        label: 'User Access',
        app,
        errorMessage: (e as Error).message,
      });
    }
  }
};
