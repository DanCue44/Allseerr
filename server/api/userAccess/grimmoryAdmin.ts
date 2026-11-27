import type { GrimmoryUser } from '@server/api/grimmory';
import GrimmoryAPI, { isGrimmoryAdmin } from '@server/api/grimmory';
import type { AxiosRequestConfig } from 'axios';
import type {
  AppAccess,
  AppAccountSummary,
  AppConnectionInfo,
  AppLibrary,
  CurrentAppAccess,
  NewAppAccount,
  RemoteAccount,
  UserAccessAppClient,
  UserAccessClientOptions,
} from './types';
import { UserAccessAppError, describeAppError, matchAccount } from './types';

/**
 * The permissions Allseerr gives a reader: downloading and syncing their
 * e-reader. Everything else stays with Grimmory's defaults (off).
 */
export const GRIMMORY_READER_PERMISSIONS = {
  permissionDownload: true,
  permissionSyncKoreader: true,
  permissionSyncKobo: true,
};

/**
 * The libraries a person gets: every library for all (null), none without
 * access. Grimmory has no "all libraries" setting, so all means each
 * library there now.
 */
export const grimmoryLibraryIds = (
  access: Pick<AppAccess, 'enabled' | 'libraryIds'>,
  allLibraryIds: string[]
): number[] =>
  (access.enabled ? (access.libraryIds ?? allLibraryIds) : [])
    .map(Number)
    .filter((id) => Number.isFinite(id));

const toAccount = (user: GrimmoryUser): RemoteAccount => ({
  id: String(user.id),
  username: user.username,
  email: user.email ?? null,
});

/**
 * Grimmory accounts, through an admin's username and password. Grimmory has
 * no API keys. Age limits are not passed on, Grimmory's content
 * restrictions work by category and tag rather than by rating.
 */
export class GrimmoryAdminAPI implements UserAccessAppClient {
  private api: GrimmoryAPI;

  constructor(options: UserAccessClientOptions) {
    this.api = new GrimmoryAPI({
      url: options.url,
      username: options.username,
      password: options.password,
      timeout: options.timeout ?? 15000,
    });
  }

  private async call<T>(config: AxiosRequestConfig): Promise<T> {
    try {
      return await this.api.request<T>(config);
    } catch (e) {
      throw new UserAccessAppError(describeAppError('Grimmory', e));
    }
  }

  public async test(): Promise<AppConnectionInfo> {
    let result: Awaited<ReturnType<GrimmoryAPI['test']>>;

    try {
      result = await this.api.test();
    } catch (e) {
      throw new UserAccessAppError(describeAppError('Grimmory', e));
    }

    if (!isGrimmoryAdmin(result.user)) {
      throw new UserAccessAppError(
        'Grimmory: the sign in does not belong to an admin.'
      );
    }

    return { version: result.version };
  }

  public async getLibraries(): Promise<AppLibrary[]> {
    try {
      return (await this.api.getLibraries()).map(({ id, name }) => ({
        id,
        name,
      }));
    } catch (e) {
      throw new UserAccessAppError(describeAppError('Grimmory', e));
    }
  }

  private async getUsers(): Promise<GrimmoryUser[]> {
    return (
      (await this.call<GrimmoryUser[]>({
        method: 'get',
        url: '/api/v1/users',
      })) ?? []
    );
  }

  private async getUser(account: RemoteAccount): Promise<GrimmoryUser> {
    const user = (await this.getUsers()).find(
      (u) => String(u.id) === account.id
    );

    if (!user) {
      throw new UserAccessAppError('Grimmory no longer has this account.');
    }

    return user;
  }

  public async findAccount(query: {
    remoteUserId?: string | null;
    username?: string | null;
    email?: string | null;
  }): Promise<RemoteAccount | null> {
    return matchAccount((await this.getUsers()).map(toAccount), query);
  }

  public async listAccounts(): Promise<AppAccountSummary[]> {
    return (await this.getUsers()).map((user) => ({
      ...toAccount(user),
      isAdmin: isGrimmoryAdmin(user),
    }));
  }

  public async ownAccountId(): Promise<string | null> {
    const me = await this.call<GrimmoryUser>({
      method: 'get',
      url: '/api/v1/users/me',
    });

    return me?.id !== undefined ? String(me.id) : null;
  }

  private async allLibraryIds(): Promise<string[]> {
    return (await this.getLibraries()).map((library) => library.id);
  }

  public async getAccountAccess(
    account: RemoteAccount
  ): Promise<CurrentAppAccess> {
    const user = await this.getUser(account);

    if (isGrimmoryAdmin(user)) {
      return { libraryIds: null };
    }

    const assigned = (user.assignedLibraries ?? []).map((library) =>
      String(library.id)
    );
    const all = await this.allLibraryIds();

    // Every library there now counts as all of them
    return {
      libraryIds:
        all.length > 0 && all.every((id) => assigned.includes(id))
          ? null
          : assigned,
    };
  }

  public async createAccount(account: NewAppAccount): Promise<RemoteAccount> {
    const email = account.email || `${account.username}@allseerr.invalid`;

    // Answers 204 without the account, which is then found by its username
    await this.call({
      method: 'post',
      url: '/api/v1/auth/register',
      data: {
        username: account.username,
        password: account.password,
        name: account.username,
        email,
        selectedLibraries: grimmoryLibraryIds(
          account,
          await this.allLibraryIds()
        ),
        ...GRIMMORY_READER_PERMISSIONS,
      },
    });

    const created = (await this.getUsers()).find(
      (user) => user.username.toLowerCase() === account.username.toLowerCase()
    );

    if (!created) {
      throw new UserAccessAppError('Grimmory did not make the new account.');
    }

    return toAccount(created);
  }

  public async updateAccount(
    account: RemoteAccount,
    access: AppAccess
  ): Promise<void> {
    const user = await this.getUser(account);

    // An admin keeps every library
    if (isGrimmoryAdmin(user)) {
      return;
    }

    await this.call({
      method: 'put',
      url: `/api/v1/users/${encodeURIComponent(account.id)}`,
      data: {
        name: user.name ?? user.username,
        email: user.email ?? undefined,
        // Sent back as they are, the update replaces them
        permissions: user.permissions ?? undefined,
        assignedLibraries: grimmoryLibraryIds(
          access,
          await this.allLibraryIds()
        ),
      },
    });
  }

  public async isAppAdmin(account: RemoteAccount): Promise<boolean> {
    return isGrimmoryAdmin(await this.getUser(account));
  }

  public async setPassword(
    account: RemoteAccount,
    password: string
  ): Promise<void> {
    await this.call({
      method: 'put',
      url: '/api/v1/users/change-user-password',
      data: { userId: Number(account.id), newPassword: password },
    });
  }

  public async deleteAccount(account: RemoteAccount): Promise<void> {
    await this.call({
      method: 'delete',
      url: `/api/v1/users/${encodeURIComponent(account.id)}`,
    });
  }
}
