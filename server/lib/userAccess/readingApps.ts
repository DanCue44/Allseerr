import type {
  ReadingAppChoices,
  ReadingKind,
  UserAccessApp,
} from '@server/constants/userAccess';
import {
  READING_KINDS,
  READING_KIND_APPS,
  ReadingAppState,
  USER_ACCESS_APPS,
  USER_ACCESS_APP_NAMES,
  UserAppAccountGrant,
  UserAppAccountStatus,
  defaultReadingAppChoices,
} from '@server/constants/userAccess';
import { getRepository } from '@server/datasource';
import type { User } from '@server/entity/User';
import { UserAppAccount } from '@server/entity/UserAppAccount';
import type {
  NewAppPassword,
  ReadingAppStatus,
} from '@server/interfaces/api/userAccessInterfaces';
import notificationManager, { Notification } from '@server/lib/notifications';
import { getSettings } from '@server/lib/settings';
import {
  clearNoBookEndsToken,
  getAppClient,
  getAppPublicUrl,
  isAppConnected,
  remoteOf,
  resetAppPassword,
  syncAppAccount,
} from '@server/lib/userAccess';
import logger from '@server/logger';
import { openSecret, sealSecret } from '@server/utils/secretBox';

export type { ReadingAppStatus };

// The name the key NoBookEnds signs in with has in the app
export const NOBOOKENDS_KEY_NAME = 'NoBookEnds (via Allseerr)';

/**
 * A reason a person cannot set up an app now: 403 when they do not have
 * access, 404 when the app is not connected, 409 when the app could not do
 * it right now
 */
export class ReadingAppError extends Error {
  constructor(
    public status: 403 | 404 | 409,
    message: string,
    // Where the person signs in themselves, when Allseerr cannot
    public signIn?: { serverUrl: string; username: string }
  ) {
    super(message);
    this.name = 'ReadingAppError';
  }
}

/**
 * The app each kind is read or heard in, with any app that cannot serve a
 * kind put back to its default
 */
export const getReadingAppChoices = (): ReadingAppChoices => {
  const saved = getSettings().userAccess.readingApps;
  const defaults = defaultReadingAppChoices();

  return Object.fromEntries(
    READING_KINDS.map((kind) => {
      const app = saved?.[kind];

      return [
        kind,
        app && READING_KIND_APPS[kind].includes(app) ? app : defaults[kind],
      ];
    })
  ) as ReadingAppChoices;
};

// What an app is for, from the kinds it serves
const KIND_PURPOSES: Record<string, string> = {
  audiobook: 'Audiobooks',
  ebook: 'Ebooks',
  'audiobook,ebook': 'Audiobooks and ebooks',
  comic: 'Comics and manga',
  'ebook,comic': 'Ebooks, comics and manga',
};

const DEFAULT_PURPOSES: Record<UserAccessApp, string> = {
  audiobookshelf: 'Audiobooks and ebooks',
  kavita: 'Comics and manga',
  komga: 'Comics and manga',
};

export const kindsServedBy = (
  app: UserAccessApp,
  choices: ReadingAppChoices = getReadingAppChoices()
): ReadingKind[] => READING_KINDS.filter((kind) => choices[kind] === app);

export const purposeOf = (app: UserAccessApp, kinds: ReadingKind[]): string =>
  KIND_PURPOSES[kinds.join(',')] ?? DEFAULT_PURPOSES[app];

/**
 * Whether people can use "Sign in with Allseerr" in the app: the provider
 * is on, has an address and the app is registered with it
 */
const hasSignInWithAllseerr = (app: UserAccessApp): boolean => {
  const settings = getSettings();
  const { oidc } = settings.userAccess;

  return (
    oidc.enabled &&
    !!settings.main.applicationUrl &&
    oidc.clients.some((client) => client.enabled && client.app === app)
  );
};

const MESSAGES: Record<ReadingAppState, (name: string) => string> = {
  [ReadingAppState.READY]: (name) => `Your ${name} account is ready.`,
  [ReadingAppState.AVAILABLE]: (name) =>
    `You have access to ${name}. Set up your account to start.`,
  [ReadingAppState.NOT_GRANTED]: (name) =>
    `You do not have access to ${name} yet. Ask an admin for it.`,
  [ReadingAppState.REQUESTED]: (name) =>
    `You asked for access to ${name}. An admin will look at it.`,
  [ReadingAppState.ERROR]: (name) =>
    `Your ${name} account could not be set up. Try again, or ask an admin.`,
};

/**
 * Where a person stands in an app, from their access and account
 */
export const readingAppStateOf = (
  account: UserAppAccount | undefined | null
): ReadingAppState => {
  if (!account?.enabled) {
    return account?.accessRequestedAt
      ? ReadingAppState.REQUESTED
      : ReadingAppState.NOT_GRANTED;
  }

  if (account.status === UserAppAccountStatus.ERROR) {
    return ReadingAppState.ERROR;
  }

  return account.status === UserAppAccountStatus.ACTIVE && account.remoteUserId
    ? ReadingAppState.READY
    : ReadingAppState.AVAILABLE;
};

const toStatus = (
  app: UserAccessApp,
  account: UserAppAccount | undefined | null,
  choices: ReadingAppChoices
): ReadingAppStatus => {
  const name = USER_ACCESS_APP_NAMES[app];
  const kinds = kindsServedBy(app, choices);
  const state = readingAppStateOf(account);
  const publicUrl = getAppPublicUrl(app);
  // An account the person had before keeps the password they chose
  const ownAccount =
    state === ReadingAppState.READY && !account?.madeByAllseerr;

  return {
    app,
    name,
    purpose: purposeOf(app, kinds),
    kinds,
    state,
    ...(state === ReadingAppState.READY && account?.remoteUsername
      ? { username: account.remoteUsername }
      : {}),
    ...(publicUrl ? { publicUrl } : {}),
    message: ownAccount
      ? `Your own ${name} account is linked. Sign in with your own password.`
      : MESSAGES[state](name),
    signInWithAllseerr: hasSignInWithAllseerr(app),
    ownAccount,
    canResetPassword: state === ReadingAppState.READY && !ownAccount,
  };
};

const findAccount = async (
  user: User,
  app: UserAccessApp
): Promise<UserAppAccount | null> =>
  getRepository(UserAppAccount).findOne({
    where: { user: { id: user.id }, app },
    relations: { user: true },
  });

/**
 * The connected reading apps that serve a kind of book, or that the person
 * was given, and where they stand in each. Only the person's own accounts
 * are read.
 */
export const getReadingApps = async (
  user: User
): Promise<ReadingAppStatus[]> => {
  const choices = getReadingAppChoices();
  const accounts = await getRepository(UserAppAccount).find({
    where: { user: { id: user.id } },
  });

  return USER_ACCESS_APPS.flatMap((app) => {
    const account = accounts.find((a) => a.app === app);

    // An app the admin picked for no kind, such as a Komga kept for testing,
    // is only shown to people who were given it
    if (
      !isAppConnected(app) ||
      (!kindsServedBy(app, choices).length && !account?.enabled)
    ) {
      return [];
    }

    return [toStatus(app, account, choices)];
  });
};

export const getReadingApp = async (
  user: User,
  app: UserAccessApp
): Promise<ReadingAppStatus> => {
  if (!isAppConnected(app)) {
    throw new ReadingAppError(
      404,
      `${USER_ACCESS_APP_NAMES[app]} is not set up.`
    );
  }

  return toStatus(app, await findAccount(user, app), getReadingAppChoices());
};

/**
 * Makes or links the person's account in one app, when an admin or the
 * default for Plex users gave them access. Never gives access. The new
 * password comes back once, and is emailed when that is on.
 */
export const setUpReadingApp = async (
  user: User,
  app: UserAccessApp
): Promise<{ status: ReadingAppStatus; password?: NewAppPassword }> => {
  if (!isAppConnected(app)) {
    throw new ReadingAppError(
      404,
      `${USER_ACCESS_APP_NAMES[app]} is not set up.`
    );
  }

  const account = await findAccount(user, app);

  if (!account?.enabled) {
    throw new ReadingAppError(
      403,
      `You do not have access to ${USER_ACCESS_APP_NAMES[app]}.`
    );
  }

  const created =
    readingAppStateOf(account) === ReadingAppState.READY
      ? null
      : await syncAppAccount(user, account, { create: true });
  const choices = getReadingAppChoices();

  return {
    status: toStatus(app, account, choices),
    ...(created ? { password: created } : {}),
  };
};

/**
 * A new password for the person's own account. An app admin's password is
 * left to its owner, so the root account of an app is never changed here.
 */
const resetOwnPassword = async (
  user: User,
  account: UserAppAccount
): Promise<NewAppPassword> => {
  const name = USER_ACCESS_APP_NAMES[account.app];
  const client = getAppClient(account.app);
  const remote = remoteOf(account);

  // Only an admin changes the password of an account Allseerr did not make
  if (!account.madeByAllseerr) {
    throw new ReadingAppError(
      409,
      `You already have a ${name} account. Sign in to ${name} with your own password.`
    );
  }

  if (client?.isAppAdmin && remote && (await client.isAppAdmin(remote))) {
    throw new ReadingAppError(
      409,
      `Your ${name} account is an admin account. Sign in to ${name} with your own password.`
    );
  }

  return resetAppPassword(user.id, account.app);
};

/**
 * A new password for the person's account, shown once
 */
export const newReadingAppPassword = async (
  user: User,
  app: UserAccessApp
): Promise<NewAppPassword> => {
  const account = await findAccount(user, app);

  if (!account?.enabled) {
    throw new ReadingAppError(
      403,
      `You do not have access to ${USER_ACCESS_APP_NAMES[app]}.`
    );
  }
  if (readingAppStateOf(account) !== ReadingAppState.READY) {
    throw new ReadingAppError(
      409,
      `Set up your ${USER_ACCESS_APP_NAMES[app]} account first.`
    );
  }

  try {
    return await resetOwnPassword(user, account);
  } catch (e) {
    if (e instanceof ReadingAppError) {
      throw e;
    }
    logger.warn('Failed to give a reading app account a new password', {
      label: 'User Access',
      app,
      userId: user.id,
      message: (e as Error).message,
    });
    throw new ReadingAppError(
      409,
      `${USER_ACCESS_APP_NAMES[app]} could not change the password right now. Try again later.`
    );
  }
};

/**
 * Tells the admins a person would like to use an app. Asking again does not
 * tell them again. A person who already has access gets their state back.
 */
export const requestReadingAppAccess = async (
  user: User,
  app: UserAccessApp
): Promise<ReadingAppStatus> => {
  if (!isAppConnected(app)) {
    throw new ReadingAppError(
      404,
      `${USER_ACCESS_APP_NAMES[app]} is not set up.`
    );
  }

  const repository = getRepository(UserAppAccount);
  const account =
    (await findAccount(user, app)) ??
    // A row made only to hold the ask stays under the default for Plex
    // users, so the default can still give the app later
    new UserAppAccount({
      user,
      app,
      enabled: false,
      libraryIds: null,
      status: UserAppAccountStatus.NONE,
      grantedBy: UserAppAccountGrant.PLEX,
    });

  if (!account.enabled && !account.accessRequestedAt) {
    account.accessRequestedAt = new Date();
    await repository.save(account);

    const appName = USER_ACCESS_APP_NAMES[app];

    notificationManager.sendNotification(Notification.ACCESS_REQUESTED, {
      event: 'Reading App Access Requested',
      subject: `${user.displayName} asked for ${appName}`,
      message: `${user.displayName} would like to use ${appName}. Turn it on for them in User Access.`,
      notifyAdmin: true,
      notifySystem: true,
      isAdmin: true,
      actionPath: '/settings/user-access',
    });

    logger.info('A person asked for access to a reading app', {
      label: 'User Access',
      app,
      userId: user.id,
    });
  }

  return toStatus(app, account, getReadingAppChoices());
};

export interface NoBookEndsConnection {
  app: UserAccessApp;
  serverUrl: string;
  username: string;
  token?: string;
  apiKey?: string;
  password?: string;
}

/**
 * The key Allseerr made for NoBookEnds before, while it still signs in
 */
export const savedKey = async (
  account: UserAppAccount
): Promise<{ id: string | null; key: string } | null> => {
  const repository = getRepository(UserAppAccount);
  const saved = await repository
    .createQueryBuilder('account')
    .addSelect('account.nobookendsToken')
    .where('account.id = :id', { id: account.id })
    .getOne();

  if (!saved?.nobookendsToken) {
    return null;
  }

  const opened = openSecret(saved.nobookendsToken);

  // A key sealed under another secret cannot be used, so a new one is made
  if (!opened) {
    return null;
  }

  // Keys saved before they were sealed are sealed now
  if (opened.legacy) {
    await repository.update(account.id, {
      nobookendsToken: sealSecret(opened.plain),
    });
  }

  return { id: saved.nobookendsTokenId ?? null, key: opened.plain };
};

/**
 * Signs NoBookEnds in to an app as the person, without a password where the
 * app allows it: sets the account up when they have access, then hands back
 * an Audiobookshelf API key or a Kavita auth key made for them. Apps that
 * cannot make one get a new password instead, shown once.
 */
export const connectNoBookEnds = async (
  user: User,
  app: UserAccessApp
): Promise<NoBookEndsConnection> => {
  const name = USER_ACCESS_APP_NAMES[app];
  const { password: createdPassword } = await setUpReadingApp(user, app);
  const account = await findAccount(user, app);
  const remote = account ? remoteOf(account) : null;
  const client = getAppClient(app);
  const serverUrl = getAppPublicUrl(app);

  if (
    !account ||
    !remote ||
    !client ||
    !serverUrl ||
    readingAppStateOf(account) !== ReadingAppState.READY
  ) {
    throw new ReadingAppError(
      409,
      `Your ${name} account could not be set up right now. Try again later.`
    );
  }

  const connection: NoBookEndsConnection = {
    app,
    serverUrl,
    username: remote.username,
  };
  let password = createdPassword?.password;

  try {
    if (client.createUserKey) {
      const saved = await savedKey(account);

      if (
        saved &&
        client.isUserKeyValid &&
        (await client.isUserKeyValid(remote, saved.key))
      ) {
        return withKey(connection, app, saved.key, password);
      }

      // A key that stopped working is removed, where the app allows it
      if (saved?.id && client.deleteUserKey) {
        await client.deleteUserKey(saved.id).catch(() => undefined);
      }

      let key = await client.createUserKey(
        remote,
        NOBOOKENDS_KEY_NAME,
        password
      );

      // Kavita only makes a key for someone signed in as them, which needs
      // their password. One Allseerr made itself is changed first; a
      // person's own account keeps theirs.
      if (!key && app === 'kavita' && !password) {
        password = (await resetForNoBookEnds(user, account, connection))
          .password;
        key = await client.createUserKey(remote, NOBOOKENDS_KEY_NAME, password);
      }

      if (key) {
        account.nobookendsToken = sealSecret(key.key);
        account.nobookendsTokenId = key.id;
        await getRepository(UserAppAccount).save(account);

        return withKey(connection, app, key.key, password);
      }

      clearNoBookEndsToken(account);
      await getRepository(UserAppAccount).save(account);
    }

    // No key to sign in with, so a password shown once does it
    return {
      ...connection,
      password:
        password ??
        (await resetForNoBookEnds(user, account, connection)).password,
    };
  } catch (e) {
    if (e instanceof ReadingAppError) {
      throw e;
    }
    logger.warn('Failed to sign NoBookEnds in to a reading app', {
      label: 'NoBookEnds',
      app,
      userId: user.id,
      message: (e as Error).message,
    });
    throw new ReadingAppError(
      409,
      `${name} could not sign NoBookEnds in right now. Try again later.`
    );
  }
};

const resetForNoBookEnds = (
  user: User,
  account: UserAppAccount,
  connection: NoBookEndsConnection
): Promise<NewAppPassword> => {
  const name = USER_ACCESS_APP_NAMES[account.app];

  // NoBookEnds opens its sign in with the address and name filled in, so
  // only the password is left to type
  if (!account.madeByAllseerr) {
    throw new ReadingAppError(
      409,
      `You already have a ${name} account. Sign in to ${name} in NoBookEnds with your own password.`,
      { serverUrl: connection.serverUrl, username: connection.username }
    );
  }

  return resetOwnPassword(user, account);
};

const withKey = (
  connection: NoBookEndsConnection,
  app: UserAccessApp,
  key: string,
  password: string | undefined
): NoBookEndsConnection => ({
  ...connection,
  ...(app === 'audiobookshelf' ? { token: key } : { apiKey: key }),
  // A password Allseerr just made is shown once, so the person can sign in
  // to the app on the web too
  ...(password ? { password } : {}),
});

/**
 * Lets a person try at most a few setups and new passwords in a while, per
 * app, so a script cannot keep an app busy or keep changing a password
 */
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;
const attempts = new Map<string, number[]>();

export const isTooManyAttempts = (
  key: string,
  now: number = Date.now()
): boolean => {
  const recent = (attempts.get(key) ?? []).filter(
    (at) => now - at < ATTEMPT_WINDOW_MS
  );

  if (recent.length >= MAX_ATTEMPTS) {
    attempts.set(key, recent);
    return true;
  }

  recent.push(now);
  attempts.set(key, recent);
  return false;
};

// Lets tests start each case with no attempts
export const resetReadingAppAttempts = (): void => {
  attempts.clear();
};
