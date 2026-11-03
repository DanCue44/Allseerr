import { allowsExplicitContent } from '@server/lib/userAccess/ageLimits';
import type { AxiosInstance } from 'axios';
import { isAxiosError } from 'axios';
import semver from 'semver';
import type {
  AppAccess,
  AppAccountSummary,
  AppConnectionInfo,
  AppLibrary,
  AppUserKey,
  CurrentAppAccess,
  NewAppAccount,
  RemoteAccount,
  UserAccessAppClient,
  UserAccessClientOptions,
} from './types';
import {
  UserAccessAppError,
  createHttpClient,
  describeAppError,
  matchAccount,
} from './types';

interface AbsUser {
  id: string;
  username: string;
  email?: string | null;
  type?: string;
  isActive?: boolean;
  permissions?: {
    download?: boolean;
    accessAllLibraries?: boolean;
    librariesAccessible?: string[];
  };
  librariesAccessible?: string[];
}

/**
 * The permissions Allseerr gives a listener: playing and downloading, no
 * changes to the library
 */
export const absPermissions = (access: AppAccess) => ({
  download: access.canDownload ?? true,
  update: false,
  delete: false,
  upload: false,
  createEreader: false,
  accessAllLibraries: access.libraryIds === null,
  accessAllTags: true,
  accessExplicitContent: allowsExplicitContent(access.ageLimit),
  selectedTagsNotAccessible: false,
  librariesAccessible: access.libraryIds ?? [],
  itemTagsSelected: [],
});

// API keys made by an admin for another account came with 2.26
export const ABS_API_KEYS_VERSION = '2.26.0';

/**
 * Audiobookshelf accounts, through an admin's API key
 */
export class AudiobookshelfAdminAPI implements UserAccessAppClient {
  private axios: AxiosInstance;

  constructor(options: UserAccessClientOptions) {
    this.axios = createHttpClient(options);

    if (options.apiKey) {
      this.axios.defaults.headers.common.Authorization = `Bearer ${options.apiKey}`;
    }
  }

  private async call<T>(run: () => Promise<{ data: T }>): Promise<T> {
    try {
      return (await run()).data;
    } catch (e) {
      throw new UserAccessAppError(describeAppError('Audiobookshelf', e));
    }
  }

  public async test(): Promise<AppConnectionInfo> {
    const status = await this.call(() =>
      this.axios.get<{ serverVersion?: string }>('/status')
    );
    const me = await this.call(() =>
      this.axios.get<{ type?: string }>('/api/me')
    );

    if (me?.type !== 'admin' && me?.type !== 'root') {
      throw new UserAccessAppError(
        'Audiobookshelf: the API key does not belong to an admin.'
      );
    }

    return { version: status?.serverVersion };
  }

  public async getLibraries(): Promise<AppLibrary[]> {
    const data = await this.call(() =>
      this.axios.get<{ libraries?: { id: string; name: string }[] }>(
        '/api/libraries'
      )
    );

    return (data.libraries ?? []).map(({ id, name }) => ({ id, name }));
  }

  private async getUsers(): Promise<AbsUser[]> {
    const data = await this.call(() =>
      this.axios.get<{ users?: AbsUser[] }>('/api/users')
    );

    return data.users ?? [];
  }

  public async findAccount(query: {
    remoteUserId?: string | null;
    username?: string | null;
    email?: string | null;
  }): Promise<RemoteAccount | null> {
    const user = matchAccount(await this.getUsers(), query);

    return user
      ? { id: user.id, username: user.username, email: user.email }
      : null;
  }

  public async listAccounts(): Promise<AppAccountSummary[]> {
    return (await this.getUsers()).map((user) => ({
      id: user.id,
      username: user.username,
      email: user.email,
      isAdmin: user.type === 'admin' || user.type === 'root',
    }));
  }

  public async ownAccountId(): Promise<string | null> {
    const me = await this.call(() =>
      this.axios.get<{ id?: string }>('/api/me')
    );

    return me?.id ?? null;
  }

  /**
   * Renames an account. Audiobookshelf signs the account out of its
   * sessions, while API keys, which belong to the account's id, keep
   * working. Only the root user may rename the root user.
   */
  public async renameAccount(
    account: RemoteAccount,
    username: string
  ): Promise<void> {
    await this.call(() =>
      this.axios.patch(`/api/users/${encodeURIComponent(account.id)}`, {
        username,
      })
    );
  }

  public async getAccountAccess(
    account: RemoteAccount
  ): Promise<CurrentAppAccess> {
    const user = (await this.getUsers()).find((u) => u.id === account.id);

    if (!user) {
      throw new UserAccessAppError(
        'Audiobookshelf no longer has this account.'
      );
    }

    const all =
      user.type === 'admin' ||
      user.type === 'root' ||
      user.permissions?.accessAllLibraries !== false;

    return {
      libraryIds: all
        ? null
        : (user.librariesAccessible ??
          user.permissions?.librariesAccessible ??
          []),
      canDownload: user.permissions?.download !== false,
    };
  }

  /**
   * Sets the email of an account. Audiobookshelf matches people signing in
   * with Allseerr by username, so this only keeps the account tidy. Only
   * the root user may change the root user.
   */
  public async setEmail(
    account: RemoteAccount,
    email: string
  ): Promise<boolean> {
    await this.call(() =>
      this.axios.patch(`/api/users/${encodeURIComponent(account.id)}`, {
        email,
      })
    );

    return true;
  }

  public async createAccount(account: NewAppAccount): Promise<RemoteAccount> {
    const { librariesAccessible, itemTagsSelected, ...permissions } =
      absPermissions(account);
    const data = await this.call(() =>
      this.axios.post<{ user?: AbsUser }>('/api/users', {
        username: account.username,
        email: account.email || undefined,
        password: account.password,
        type: 'user',
        isActive: account.enabled,
        permissions,
        librariesAccessible,
        itemTagsSelected,
      })
    );

    if (!data.user?.id) {
      throw new UserAccessAppError(
        'Audiobookshelf did not return the new account.'
      );
    }

    return {
      id: data.user.id,
      username: data.user.username,
      email: data.user.email,
    };
  }

  public async updateAccount(
    account: RemoteAccount,
    access: AppAccess
  ): Promise<void> {
    const user = (await this.getUsers()).find((u) => u.id === account.id);

    if (!user) {
      throw new UserAccessAppError(
        'Audiobookshelf no longer has this account.'
      );
    }

    // Admins keep their own permissions, and the root user cannot be changed
    if (user.type === 'admin' || user.type === 'root') {
      return;
    }

    await this.call(() =>
      this.axios.patch(`/api/users/${encodeURIComponent(account.id)}`, {
        isActive: access.enabled,
        permissions: absPermissions(access),
      })
    );
  }

  public async isAppAdmin(account: RemoteAccount): Promise<boolean> {
    const user = (await this.getUsers()).find((u) => u.id === account.id);

    return user?.type === 'admin' || user?.type === 'root';
  }

  public async setPassword(
    account: RemoteAccount,
    password: string
  ): Promise<void> {
    await this.call(() =>
      this.axios.patch(`/api/users/${encodeURIComponent(account.id)}`, {
        password,
      })
    );
  }

  public async deleteAccount(account: RemoteAccount): Promise<void> {
    await this.call(() =>
      this.axios.delete(`/api/users/${encodeURIComponent(account.id)}`)
    );
  }

  private async serverVersion(): Promise<string | undefined> {
    const status = await this.call(() =>
      this.axios.get<{ serverVersion?: string }>('/status')
    );

    return status?.serverVersion;
  }

  /**
   * An API key that acts as the person, made with the admin's key. Older
   * Audiobookshelf has no API keys.
   */
  public async createUserKey(
    account: RemoteAccount,
    name: string
  ): Promise<AppUserKey | null> {
    const version = semver.coerce(await this.serverVersion());

    if (!version || semver.lt(version, ABS_API_KEYS_VERSION)) {
      return null;
    }

    const data = await this.call(() =>
      this.axios.post<{ apiKey?: { id?: string; apiKey?: string } }>(
        '/api/api-keys',
        { name, userId: account.id, isActive: true }
      )
    );

    if (!data.apiKey?.id || !data.apiKey.apiKey) {
      throw new UserAccessAppError(
        'Audiobookshelf did not return the new API key.'
      );
    }

    return { id: data.apiKey.id, key: data.apiKey.apiKey };
  }

  public async isUserKeyValid(
    account: RemoteAccount,
    key: string
  ): Promise<boolean> {
    try {
      const response = await this.axios.get<{ id?: string }>('/api/me', {
        headers: { Authorization: `Bearer ${key}` },
      });

      return response.data?.id === account.id;
    } catch (e) {
      const status = isAxiosError(e) ? e.response?.status : undefined;

      if (status === 401 || status === 403 || status === 404) {
        return false;
      }
      throw new UserAccessAppError(describeAppError('Audiobookshelf', e));
    }
  }

  /**
   * A read only account for a companion service such as NoBookEnds Sync:
   * it may download from every library, including explicit content, and
   * change nothing
   */
  public async createServiceAccount(
    username: string,
    password: string
  ): Promise<RemoteAccount> {
    const data = await this.call(() =>
      this.axios.post<{ user?: AbsUser }>('/api/users', {
        username,
        password,
        type: 'user',
        isActive: true,
        permissions: {
          download: true,
          update: false,
          delete: false,
          upload: false,
          createEreader: false,
          accessAllLibraries: true,
          accessAllTags: true,
          accessExplicitContent: true,
          selectedTagsNotAccessible: false,
        },
        librariesAccessible: [],
        itemTagsSelected: [],
      })
    );

    if (!data.user?.id) {
      throw new UserAccessAppError(
        'Audiobookshelf did not return the new account.'
      );
    }

    return { id: data.user.id, username: data.user.username };
  }

  /**
   * The account's own token, which Audiobookshelf before 2.26 uses in place
   * of API keys, or null when the server does not show it
   */
  public async getLegacyUserToken(
    account: RemoteAccount
  ): Promise<string | null> {
    const data = await this.call(() =>
      this.axios.get<{ token?: string }>(
        `/api/users/${encodeURIComponent(account.id)}`
      )
    );

    return typeof data?.token === 'string' && data.token ? data.token : null;
  }

  public async deleteUserKey(keyId: string): Promise<void> {
    try {
      await this.axios.delete(`/api/api-keys/${encodeURIComponent(keyId)}`);
    } catch (e) {
      // A key removed in Audiobookshelf is already gone
      if (isAxiosError(e) && e.response?.status === 404) {
        return;
      }
      throw new UserAccessAppError(describeAppError('Audiobookshelf', e));
    }
  }
}
