import { toKavitaAgeRestriction } from '@server/lib/userAccess/ageLimits';
import type { AxiosInstance } from 'axios';
import { isAxiosError } from 'axios';
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

interface KavitaMember {
  id: number;
  username?: string | null;
  email?: string | null;
  isPending?: boolean;
  roles?: string[] | null;
  libraries?: { id: number; name: string }[] | null;
  ageRestriction?: { ageRating: number; includeUnknowns: boolean } | null;
  identityProvider?: number;
}

// Kavita's own role names
export const KAVITA_LOGIN_ROLE = 'Login';
export const KAVITA_DOWNLOAD_ROLE = 'Download';
export const KAVITA_CHANGE_PASSWORD_ROLE = 'Change Password';

/**
 * The roles Allseerr gives a reader: sign in, download and change their
 * own password. Without access there is no sign in role, which keeps the
 * account and its reading progress but locks it.
 */
export const kavitaRoles = (enabled: boolean): string[] =>
  enabled
    ? [KAVITA_LOGIN_ROLE, KAVITA_DOWNLOAD_ROLE, KAVITA_CHANGE_PASSWORD_ROLE]
    : [];

interface KavitaAuthKey {
  id: number;
  key: string;
  name: string;
}

// Auth keys can be 8 to 32 characters, the longest is the hardest to guess
const KAVITA_AUTH_KEY_LENGTH = 32;

/**
 * The token and email of an invite link, which looks like
 * https://kavita/registration/confirm-email?token=...&email=...
 */
export const parseKavitaInviteLink = (
  link: string
): { token: string; email: string } | null => {
  try {
    const url = new URL(link, 'http://kavita.invalid');
    const token = url.searchParams.get('token');
    const email = url.searchParams.get('email');

    return token && email ? { token, email } : null;
  } catch {
    return null;
  }
};

/**
 * Kavita accounts, through an admin's API key or sign in. Kavita has no
 * call that makes an account directly, so Allseerr invites the person and
 * confirms the invite with the password it picked.
 */
export class KavitaAdminAPI implements UserAccessAppClient {
  private axios: AxiosInstance;
  private options: UserAccessClientOptions;
  private token?: string;

  constructor(options: UserAccessClientOptions) {
    this.options = options;
    this.axios = createHttpClient(options);
  }

  private async authenticate(): Promise<string> {
    try {
      if (this.options.apiKey) {
        const response = await this.axios.post<{ token?: string }>(
          '/api/Plugin/authenticate',
          undefined,
          { params: { apiKey: this.options.apiKey, pluginName: 'Allseerr' } }
        );
        if (response.data?.token) {
          return response.data.token;
        }
      } else if (this.options.username && this.options.password) {
        const response = await this.axios.post<{ token?: string }>(
          '/api/Account/login',
          {
            username: this.options.username,
            password: this.options.password,
          }
        );
        if (response.data?.token) {
          return response.data.token;
        }
      }
    } catch (e) {
      throw new UserAccessAppError(describeAppError('Kavita', e));
    }

    throw new UserAccessAppError(
      'Kavita: set an admin API key, or an admin username and password.'
    );
  }

  /**
   * Runs a call with a valid token, signing in again once when it expired
   */
  private async call<T>(
    run: (headers: Record<string, string>) => Promise<{ data: T }>
  ): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!this.token) {
        this.token = await this.authenticate();
      }

      try {
        return (await run({ Authorization: `Bearer ${this.token}` })).data;
      } catch (e) {
        if (attempt === 0 && isAxiosError(e) && e.response?.status === 401) {
          this.token = undefined;
          continue;
        }
        throw new UserAccessAppError(describeAppError('Kavita', e));
      }
    }

    throw new UserAccessAppError('Kavita refused the admin sign in.');
  }

  public async test(): Promise<AppConnectionInfo> {
    const info = await this.call((headers) =>
      this.axios.get<{ kavitaVersion?: string }>(
        '/api/Server/server-info-slim',
        { headers }
      )
    );
    // Only admins may list the users
    await this.getMembers();

    return { version: info?.kavitaVersion };
  }

  public async getLibraries(): Promise<AppLibrary[]> {
    const libraries = await this.call((headers) =>
      this.axios.get<{ id: number; name: string }[]>('/api/Library/libraries', {
        headers,
      })
    );

    return (libraries ?? []).map(({ id, name }) => ({ id: String(id), name }));
  }

  private async getMembers(): Promise<KavitaMember[]> {
    return (
      (await this.call((headers) =>
        this.axios.get<KavitaMember[]>('/api/Users', {
          headers,
          params: { includePending: true },
        })
      )) ?? []
    );
  }

  private async findMember(query: {
    remoteUserId?: string | null;
    username?: string | null;
    email?: string | null;
  }): Promise<KavitaMember | null> {
    const members = await this.getMembers();
    const match = matchAccount(
      members.map((member) => ({
        id: String(member.id),
        username: member.username ?? '',
        email: member.email,
        member,
      })),
      query
    );

    return match?.member ?? null;
  }

  public async findAccount(query: {
    remoteUserId?: string | null;
    username?: string | null;
    email?: string | null;
  }): Promise<RemoteAccount | null> {
    const member = await this.findMember(query);

    return member
      ? {
          id: String(member.id),
          username: member.username ?? '',
          email: member.email,
        }
      : null;
  }

  public async listAccounts(): Promise<AppAccountSummary[]> {
    return (await this.getMembers()).map((member) => ({
      id: String(member.id),
      username: member.username ?? '',
      email: member.email,
      isAdmin: !!member.roles?.includes('Admin'),
    }));
  }

  /**
   * The libraries the account sees. Kavita has no "all libraries", so an
   * account with every library it has now counts as all of them, as do
   * admins.
   */
  public async getAccountAccess(
    account: RemoteAccount
  ): Promise<CurrentAppAccess> {
    const member = await this.findMember({ remoteUserId: account.id });

    if (!member) {
      throw new UserAccessAppError('Kavita no longer has this account.');
    }

    const ids = (member.libraries ?? []).map((library) => String(library.id));
    const all = (await this.getLibraries()).map((library) => library.id);

    return {
      libraryIds:
        member.roles?.includes('Admin') ||
        (ids.length > 0 && all.every((id) => ids.includes(id)))
          ? null
          : ids,
    };
  }

  /**
   * Changes the username or email of an account through Kavita's admin
   * update, sending everything else back as it is
   */
  private async updateMember(
    member: KavitaMember,
    changes: { username?: string; email?: string }
  ): Promise<void> {
    await this.call((headers) =>
      this.axios.post(
        '/api/Account/update',
        {
          userId: member.id,
          username: changes.username ?? member.username,
          email: changes.email ?? member.email,
          // The same roles, or Kavita would sign the account out of its
          // auth keys
          roles: member.roles ?? [],
          libraries: (member.libraries ?? []).map((library) => library.id),
          ageRestriction: member.ageRestriction ?? {
            ageRating: -1,
            includeUnknowns: true,
          },
          identityProvider: member.identityProvider ?? 0,
        },
        { headers }
      )
    );
  }

  /**
   * The account the API key belongs to, as Kavita names it when the key
   * signs in
   */
  public async ownAccountId(): Promise<string | null> {
    if (!this.options.apiKey && !this.options.username) {
      return null;
    }

    let username = this.options.username;

    if (this.options.apiKey) {
      try {
        const response = await this.axios.post<{ username?: string }>(
          '/api/Plugin/authenticate',
          undefined,
          {
            params: { apiKey: this.options.apiKey, pluginName: 'Allseerr' },
          }
        );
        username = response.data?.username;
      } catch (e) {
        throw new UserAccessAppError(describeAppError('Kavita', e));
      }
    }

    const member = username ? await this.findMember({ username }) : null;

    return member ? String(member.id) : null;
  }

  /**
   * Renames an account, the API key's own included. Auth keys keep working.
   */
  public async renameAccount(
    account: RemoteAccount,
    username: string
  ): Promise<void> {
    const member = await this.findMember({ remoteUserId: account.id });

    if (!member) {
      throw new UserAccessAppError('Kavita no longer has this account.');
    }

    await this.updateMember(member, { username });
  }

  /**
   * Sets the email of an account, which Kavita's sign in with Allseerr
   * links existing accounts by. Kavita's admin update takes it as confirmed,
   * and keeps everything else as it is here. Kavita ignores the email of
   * the account the admin key belongs to, which only its owner can change
   * (with a confirmation email), so this answers false for it.
   */
  public async setEmail(
    account: RemoteAccount,
    email: string
  ): Promise<boolean> {
    const member = await this.findMember({ remoteUserId: account.id });

    if (!member) {
      throw new UserAccessAppError('Kavita no longer has this account.');
    }

    if (member.email?.toLowerCase() === email.toLowerCase()) {
      return true;
    }

    await this.updateMember(member, { email });

    const updated = await this.findMember({ remoteUserId: account.id });

    return updated?.email?.toLowerCase() === email.toLowerCase();
  }

  /**
   * The library ids to send: Kavita has no "all libraries", so all means
   * every library it has now
   */
  private async libraryIds(libraryIds: string[] | null): Promise<number[]> {
    const ids =
      libraryIds ?? (await this.getLibraries()).map((library) => library.id);

    return ids.map(Number).filter((id) => Number.isInteger(id));
  }

  public async createAccount(account: NewAppAccount): Promise<RemoteAccount> {
    const email = account.email || `${account.username}@allseerr.invalid`;
    const invite = await this.call((headers) =>
      this.axios.post<{ emailLink?: string }>(
        '/api/Account/invite',
        {
          email,
          roles: kavitaRoles(account.enabled),
          libraries: [],
          ageRestriction: toKavitaAgeRestriction(
            account.ageLimit,
            account.includeUnrated
          ),
        },
        { headers }
      )
    );
    const link = invite?.emailLink
      ? parseKavitaInviteLink(invite.emailLink)
      : null;

    if (!link) {
      throw new UserAccessAppError(
        'Kavita did not return an invite link for the new account.'
      );
    }

    try {
      await this.axios.post('/api/Account/confirm-email', {
        email: link.email,
        token: link.token,
        username: account.username,
        password: account.password,
      });
    } catch (e) {
      throw new UserAccessAppError(describeAppError('Kavita', e));
    }

    const created = await this.findAccount({
      username: account.username,
      email: link.email,
    });

    if (!created) {
      throw new UserAccessAppError(
        'Kavita made the account but it could not be found afterwards.'
      );
    }

    // The invite leaves out libraries, the update sets them with the rest
    await this.updateAccount(created, account);

    return created;
  }

  public async updateAccount(
    account: RemoteAccount,
    access: AppAccess
  ): Promise<void> {
    const member = await this.findMember({ remoteUserId: account.id });

    if (!member) {
      throw new UserAccessAppError('Kavita no longer has this account.');
    }

    // An admin keeps every role and library Kavita gives admins
    if (member.roles?.includes('Admin')) {
      return;
    }

    const libraries = access.enabled
      ? await this.libraryIds(access.libraryIds)
      : [];

    await this.call((headers) =>
      this.axios.post(
        '/api/Account/update',
        {
          userId: member.id,
          username: member.username,
          email: member.email,
          roles: kavitaRoles(access.enabled),
          libraries,
          ageRestriction: toKavitaAgeRestriction(
            access.ageLimit,
            access.includeUnrated
          ),
          // Keeps how the person signs in, so an account made by signing in
          // with Allseerr stays one
          identityProvider: member.identityProvider ?? 0,
        },
        { headers }
      )
    );
  }

  public async isAppAdmin(account: RemoteAccount): Promise<boolean> {
    const member = await this.findMember({ remoteUserId: account.id });

    return !!member?.roles?.includes('Admin');
  }

  public async setPassword(
    account: RemoteAccount,
    password: string
  ): Promise<void> {
    await this.call((headers) =>
      this.axios.post(
        '/api/Account/reset-password',
        { userName: account.username, password, oldPassword: '' },
        { headers }
      )
    );
  }

  public async deleteAccount(account: RemoteAccount): Promise<void> {
    await this.call((headers) =>
      this.axios.delete('/api/Users/delete-user', {
        headers,
        params: { username: account.username },
      })
    );
  }

  /**
   * An auth key the person signs in with. Kavita only lets people make
   * their own keys, so Allseerr signs in as them with their password and
   * makes it, or finds the one it made before. The account the API key
   * belongs to needs no password, since Allseerr already signs in as it.
   */
  public async createUserKey(
    account: RemoteAccount,
    name: string,
    password?: string
  ): Promise<AppUserKey | null> {
    if (!password) {
      if ((await this.ownAccountId()) !== account.id) {
        return null;
      }

      const keys = await this.call((headers) =>
        this.axios.get<KavitaAuthKey[]>('/api/Account/auth-keys', { headers })
      );

      return this.findOrCreateKey(name, keys, (run) => this.call(run));
    }

    try {
      const login = await this.axios.post<{
        token?: string;
        authKeys?: KavitaAuthKey[] | null;
      }>('/api/Account/login', { username: account.username, password });
      const token = login.data?.token;

      if (!token) {
        throw new UserAccessAppError('Kavita did not sign the person in.');
      }

      return await this.findOrCreateKey(name, login.data.authKeys, (run) =>
        run({ Authorization: `Bearer ${token}` }).then(
          (response) => response.data
        )
      );
    } catch (e) {
      if (e instanceof UserAccessAppError) {
        throw e;
      }
      throw new UserAccessAppError(describeAppError('Kavita', e));
    }
  }

  private async findOrCreateKey(
    name: string,
    keys: KavitaAuthKey[] | null | undefined,
    send: <T>(
      run: (headers: Record<string, string>) => Promise<{ data: T }>
    ) => Promise<T>
  ): Promise<AppUserKey> {
    const existing = keys?.find(
      (authKey) => authKey.name.toLowerCase() === name.toLowerCase()
    );

    if (existing) {
      return { id: String(existing.id), key: existing.key };
    }

    const created = await send((headers) =>
      this.axios.post<KavitaAuthKey>(
        '/api/Account/create-auth-key',
        { keyLength: KAVITA_AUTH_KEY_LENGTH, name },
        { headers }
      )
    );

    if (!created?.key) {
      throw new UserAccessAppError('Kavita did not return the new key.');
    }

    return { id: String(created.id), key: created.key };
  }

  public async isUserKeyValid(
    account: RemoteAccount,
    key: string
  ): Promise<boolean> {
    try {
      const response = await this.axios.post<{ username?: string }>(
        '/api/Plugin/authenticate',
        undefined,
        { params: { apiKey: key, pluginName: 'NoBookEnds' } }
      );

      return (
        response.data?.username?.toLowerCase() ===
        account.username.toLowerCase()
      );
    } catch (e) {
      const status = isAxiosError(e) ? e.response?.status : undefined;

      if (status === 400 || status === 401 || status === 403) {
        return false;
      }
      throw new UserAccessAppError(describeAppError('Kavita', e));
    }
  }
}
