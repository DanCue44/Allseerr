import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Stand-ins for Audiobookshelf, Kavita and Komga that keep their accounts
 * in memory and answer the admin calls Allseerr makes, shaped like the real
 * apps' answers, and for the NoBookEnds directory
 */

export interface FakeApp {
  url: string;
  close(): Promise<void>;
  calls: { method: string; path: string; body: unknown }[];
}

const readBody = async (req: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString();
  if (!text) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

const send = (res: ServerResponse, status: number, body?: unknown) => {
  res.statusCode = status;
  if (body !== undefined) {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(body));
  } else {
    res.end();
  }
};

const startFake = async (
  handle: (
    req: IncomingMessage,
    url: URL,
    body: unknown
  ) =>
    | { status: number; body?: unknown }
    | Promise<{ status: number; body?: unknown }>
): Promise<FakeApp> => {
  const calls: FakeApp['calls'] = [];
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const body = await readBody(req);
    calls.push({ method: req.method ?? 'GET', path: url.pathname, body });
    const { status, body: responseBody } = await handle(req, url, body);
    send(res, status, responseBody);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
};

export interface FakeAbsUser {
  id: string;
  username: string;
  email: string | null;
  type: string;
  isActive: boolean;
  password?: string;
  permissions: Record<string, unknown>;
}

export const startFakeAudiobookshelf = async (apiKey: string) => {
  const users: FakeAbsUser[] = [
    {
      id: 'root',
      username: 'root',
      email: null,
      type: 'root',
      isActive: true,
      permissions: {},
    },
  ];
  // API keys made for accounts, which sign in as them
  const apiKeys: { id: string; key: string; userId: string; name: string }[] =
    [];
  const server = { version: '2.37.1' };
  let next = 1;
  const app = await startFake((req, url, body) => {
    if (url.pathname === '/status') {
      return { status: 200, body: { serverVersion: server.version } };
    }

    const userKey = apiKeys.find(
      (k) => req.headers.authorization === `Bearer ${k.key}`
    );
    if (userKey && url.pathname === '/api/me') {
      const user = users.find((u) => u.id === userKey.userId);
      return user?.isActive
        ? { status: 200, body: { id: user.id, type: user.type } }
        : { status: 401 };
    }

    if (req.headers.authorization !== `Bearer ${apiKey}`) {
      return { status: 401 };
    }

    const b = body as Record<string, unknown>;
    const userMatch = url.pathname.match(/^\/api\/users\/([^/]+)$/);

    if (url.pathname === '/api/me') {
      return { status: 200, body: { id: 'root', type: 'root' } };
    }
    if (url.pathname === '/api/libraries') {
      return {
        status: 200,
        body: {
          libraries: [
            { id: 'lib-audio', name: 'Audiobooks' },
            { id: 'lib-ebooks', name: 'Ebooks' },
          ],
        },
      };
    }
    if (url.pathname === '/api/users' && req.method === 'GET') {
      return { status: 200, body: { users } };
    }
    if (url.pathname === '/api/api-keys' && req.method === 'POST') {
      const user = users.find((u) => u.id === b.userId);
      if (!user || typeof b.name !== 'string') {
        return { status: 400 };
      }
      const created = {
        id: `key-${next}`,
        key: `abs-user-key-${next++}`,
        userId: user.id,
        name: b.name,
      };
      apiKeys.push(created);
      return {
        status: 200,
        body: {
          apiKey: {
            apiKey: created.key,
            id: created.id,
            name: created.name,
            userId: created.userId,
            isActive: !!b.isActive,
          },
        },
      };
    }
    const keyMatch = url.pathname.match(/^\/api\/api-keys\/([^/]+)$/);
    if (keyMatch && req.method === 'DELETE') {
      const index = apiKeys.findIndex((k) => k.id === keyMatch[1]);
      if (index < 0) {
        return { status: 404 };
      }
      apiKeys.splice(index, 1);
      return { status: 200 };
    }
    if (url.pathname === '/api/users' && req.method === 'POST') {
      if (users.some((u) => u.username === b.username)) {
        return { status: 400, body: 'Username already taken' };
      }
      const user: FakeAbsUser = {
        id: `abs-${next++}`,
        username: String(b.username),
        email: (b.email as string) ?? null,
        type: String(b.type ?? 'user'),
        isActive: !!b.isActive,
        password: String(b.password),
        permissions: {
          ...(b.permissions as Record<string, unknown>),
          librariesAccessible: b.librariesAccessible,
        },
      };
      users.push(user);
      return { status: 200, body: { user } };
    }
    if (userMatch && req.method === 'PATCH') {
      const user = users.find((u) => u.id === userMatch[1]);
      if (!user) {
        return { status: 404 };
      }
      // The key belongs to root, who may change itself but not its type
      // or permissions
      if (user.type === 'root' && (b.permissions || b.isActive !== undefined)) {
        return { status: 403 };
      }
      if (typeof b.username === 'string' && b.username !== user.username) {
        if (users.some((u) => u.username === b.username)) {
          return { status: 400, body: 'Username already taken' };
        }
        user.username = b.username;
      }
      if (b.isActive !== undefined) {
        user.isActive = !!b.isActive;
      }
      if (typeof b.password === 'string') {
        user.password = b.password;
      }
      if (typeof b.email === 'string') {
        user.email = b.email;
      }
      if (b.permissions) {
        user.permissions = b.permissions as Record<string, unknown>;
      }
      return { status: 200, body: { success: true } };
    }
    if (userMatch && req.method === 'DELETE') {
      const index = users.findIndex((u) => u.id === userMatch[1]);
      if (index < 0) {
        return { status: 404 };
      }
      users.splice(index, 1);
      return { status: 200, body: { success: true } };
    }

    return { status: 404 };
  });

  return { ...app, users, apiKeys, server };
};

export interface FakeKavitaMember {
  id: number;
  username: string;
  email: string;
  isPending: boolean;
  roles: string[];
  libraries: { id: number; name: string }[];
  ageRestriction: { ageRating: number; includeUnknowns: boolean };
  identityProvider: number;
  password?: string;
  inviteToken?: string;
  authKeys?: { id: number; key: string; name: string }[];
}

export const startFakeKavita = async (apiKey: string) => {
  const libraries = [
    { id: 1, name: 'Comics' },
    { id: 2, name: 'Manga' },
  ];
  const members: FakeKavitaMember[] = [
    {
      id: 1,
      username: 'admin',
      email: 'admin@example.com',
      isPending: false,
      roles: ['Admin'],
      libraries,
      ageRestriction: { ageRating: -1, includeUnknowns: true },
      identityProvider: 0,
    },
  ];
  let next = 2;
  let tokens = 0;
  let keys = 0;
  const validTokens = new Set<string>();
  // Tokens of people signed in as themselves, which only reach their own
  // calls
  const memberTokens = new Map<string, FakeKavitaMember>();
  // The API key belongs to the first member, the admin
  const tokenOwner = (authorization?: string) => {
    const token = authorization?.replace('Bearer ', '') ?? '';
    return (
      memberTokens.get(token) ??
      (validTokens.has(token) ? members[0] : undefined)
    );
  };

  const app = await startFake((req, url, body) => {
    const b = body as Record<string, unknown>;

    if (url.pathname === '/api/Plugin/authenticate' && req.method === 'POST') {
      const key = url.searchParams.get('apiKey');
      const owner = members.find((m) =>
        m.authKeys?.some((authKey) => authKey.key === key)
      );
      if (owner) {
        return { status: 200, body: { username: owner.username } };
      }
      if (key !== apiKey) {
        return { status: 401 };
      }
      const token = `token-${++tokens}`;
      validTokens.add(token);
      return { status: 200, body: { username: members[0].username, token } };
    }
    if (url.pathname === '/api/Account/login' && req.method === 'POST') {
      const member = members.find(
        (m) =>
          m.username.toLowerCase() === String(b.username).toLowerCase() &&
          m.password === b.password
      );
      if (!member || !member.roles.includes('Login')) {
        return { status: 401 };
      }
      const token = `member-token-${++tokens}`;
      memberTokens.set(token, member);
      return {
        status: 200,
        body: {
          username: member.username,
          token,
          authKeys: member.authKeys ?? [],
        },
      };
    }
    if (url.pathname === '/api/Account/auth-keys' && req.method === 'GET') {
      const member = tokenOwner(req.headers.authorization);
      if (!member) {
        return { status: 401 };
      }
      return { status: 200, body: member.authKeys ?? [] };
    }
    if (url.pathname === '/api/Account/create-auth-key') {
      const member = tokenOwner(req.headers.authorization);
      if (!member) {
        return { status: 401 };
      }
      member.authKeys ??= [];
      if (
        member.authKeys.some(
          (k) => k.name.toLowerCase() === String(b.name).toLowerCase()
        )
      ) {
        return { status: 400, body: 'auth-key-unique' };
      }
      const created = {
        id: ++keys,
        key: `kavita-user-key-${keys}`.slice(0, Number(b.keyLength)),
        name: String(b.name),
      };
      member.authKeys.push(created);
      return { status: 200, body: created };
    }
    if (url.pathname === '/api/Account/confirm-email') {
      const member = members.find((m) => m.email === b.email);
      if (!member || member.inviteToken !== b.token) {
        return { status: 400, body: 'invalid-email-confirmation' };
      }
      member.username = String(b.username);
      member.password = String(b.password);
      member.isPending = false;
      member.inviteToken = undefined;
      return { status: 200, body: { username: member.username } };
    }

    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token || !validTokens.has(token)) {
      return { status: 401 };
    }

    if (url.pathname === '/api/Server/server-info-slim') {
      return { status: 200, body: { kavitaVersion: '0.9.1.4' } };
    }
    if (url.pathname === '/api/Library/libraries') {
      return { status: 200, body: libraries };
    }
    if (url.pathname === '/api/Users' && req.method === 'GET') {
      return { status: 200, body: members };
    }
    if (url.pathname === '/api/Account/invite') {
      if (members.some((m) => m.email === b.email)) {
        return { status: 400, body: 'user-already-invited' };
      }
      const inviteToken = `invite-${next}`;
      members.push({
        id: next++,
        username: String(b.email),
        email: String(b.email),
        isPending: true,
        roles: [...(b.roles as string[]), 'Pleb'],
        libraries: [],
        ageRestriction: b.ageRestriction as FakeKavitaMember['ageRestriction'],
        identityProvider: 0,
        inviteToken,
      });
      return {
        status: 200,
        body: {
          emailLink: `http://kavita/registration/confirm-email?token=${encodeURIComponent(inviteToken)}&email=${encodeURIComponent(String(b.email))}`,
          emailSent: false,
        },
      };
    }
    if (url.pathname === '/api/Account/update') {
      const member = members.find((m) => m.id === b.userId);
      if (!member) {
        return { status: 400 };
      }
      // Kavita takes an email for any account but the admin's own, the one
      // signed in here
      if (
        typeof b.email === 'string' &&
        b.email &&
        b.email !== member.email &&
        member.id !== 1
      ) {
        if (members.some((m) => m.email === b.email)) {
          return { status: 400, body: 'email-taken' };
        }
        member.email = b.email;
      }
      if (
        typeof b.username === 'string' &&
        b.username &&
        b.username !== member.username
      ) {
        if (
          members.some(
            (m) => m.username.toLowerCase() === String(b.username).toLowerCase()
          )
        ) {
          return { status: 400, body: 'username-taken' };
        }
        member.username = b.username;
      }
      member.roles = [
        ...new Set([
          ...(b.roles as string[]),
          ...(member.roles.includes('Admin') ? [] : ['Pleb']),
        ]),
      ];
      member.libraries = libraries.filter((l) =>
        (b.libraries as number[]).includes(l.id)
      );
      member.ageRestriction =
        b.ageRestriction as FakeKavitaMember['ageRestriction'];
      member.identityProvider = b.identityProvider as number;
      return { status: 200 };
    }
    if (url.pathname === '/api/Account/reset-password') {
      const member = members.find((m) => m.username === b.userName);
      if (member) {
        member.password = String(b.password);
      }
      return { status: 200 };
    }
    if (url.pathname === '/api/Users/delete-user' && req.method === 'DELETE') {
      const index = members.findIndex(
        (m) => m.username === url.searchParams.get('username')
      );
      if (index < 0) {
        return { status: 400 };
      }
      members.splice(index, 1);
      return { status: 200 };
    }

    return { status: 404 };
  });

  return {
    ...app,
    members,
    expireTokens: () => validTokens.clear(),
  };
};

export interface FakeKomgaUser {
  id: string;
  email: string;
  roles: string[];
  sharedAllLibraries: boolean;
  sharedLibrariesIds: string[];
  ageRestriction?: { age: number; restriction: string };
  password?: string;
}

export const startFakeKomga = async (apiKey: string) => {
  const users: FakeKomgaUser[] = [
    {
      id: 'admin',
      email: 'admin@example.com',
      roles: ['ADMIN', 'FILE_DOWNLOAD', 'PAGE_STREAMING'],
      sharedAllLibraries: true,
      sharedLibrariesIds: [],
    },
  ];
  let next = 1;

  const app = await startFake((req, url, body) => {
    if (req.headers['x-api-key'] !== apiKey) {
      return { status: 401 };
    }

    const b = body as Record<string, unknown>;
    const userMatch = url.pathname.match(/^\/api\/v2\/users\/([^/]+)$/);
    const passwordMatch = url.pathname.match(
      /^\/api\/v2\/users\/([^/]+)\/password$/
    );

    if (url.pathname === '/api/v2/users/me') {
      return { status: 200, body: users[0] };
    }
    if (url.pathname === '/actuator/info') {
      return { status: 200, body: { build: { version: '1.29.1' } } };
    }
    if (url.pathname === '/api/v1/libraries') {
      return {
        status: 200,
        body: [
          { id: 'kc', name: 'Comics' },
          { id: 'km', name: 'Manga' },
        ],
      };
    }
    if (url.pathname === '/api/v2/users' && req.method === 'GET') {
      return { status: 200, body: users };
    }
    if (url.pathname === '/api/v2/users' && req.method === 'POST') {
      if (users.some((u) => u.email === b.email)) {
        return { status: 400 };
      }
      const shared = b.sharedLibraries as {
        all: boolean;
        libraryIds: string[];
      };
      const user: FakeKomgaUser = {
        id: `komga-${next++}`,
        email: String(b.email),
        roles: b.roles as string[],
        sharedAllLibraries: shared.all,
        sharedLibrariesIds: shared.libraryIds,
        ageRestriction: b.ageRestriction as FakeKomgaUser['ageRestriction'],
        password: String(b.password),
      };
      users.push(user);
      return { status: 201, body: user };
    }
    if (passwordMatch && req.method === 'PATCH') {
      const user = users.find((u) => u.id === passwordMatch[1]);
      if (!user) {
        return { status: 404 };
      }
      user.password = String(b.password);
      return { status: 204 };
    }
    if (userMatch && req.method === 'PATCH') {
      const user = users.find((u) => u.id === userMatch[1]);
      if (!user) {
        return { status: 404 };
      }
      const shared = b.sharedLibraries as {
        all: boolean;
        libraryIds: string[];
      };
      user.roles = b.roles as string[];
      user.sharedAllLibraries = shared.all;
      user.sharedLibrariesIds = shared.libraryIds;
      user.ageRestriction = b.ageRestriction as FakeKomgaUser['ageRestriction'];
      return { status: 204 };
    }
    if (userMatch && req.method === 'DELETE') {
      const index = users.findIndex((u) => u.id === userMatch[1]);
      if (index < 0) {
        return { status: 404 };
      }
      users.splice(index, 1);
      return { status: 204 };
    }

    return { status: 404 };
  });

  return { ...app, users };
};

export interface FakeDirectoryEntry {
  url: string;
  title: string;
}

/**
 * The NoBookEnds directory: takes registrations with the admin's Plex token,
 * checks the address answers with the code it was sent, like the real one,
 * and removes them again
 */
export const startFakeDirectory = async (plexToken: string) => {
  const servers = new Map<string, FakeDirectoryEntry>();
  // The answers the address check got, in order
  const checks: { status: number; body: unknown }[] = [];
  let refuse: string | null = null;

  const app = await startFake(async (req, url, body) => {
    const b = (body ?? {}) as Record<string, string>;

    if (url.pathname !== '/v1/servers') {
      return { status: 404 };
    }
    if (b.plexToken !== plexToken) {
      return {
        status: 401,
        body: {
          error: 'plex_unauthorized',
          message: 'Plex refused the token.',
        },
      };
    }
    if (req.method === 'DELETE') {
      const removed = servers.size;
      servers.clear();
      return { status: 200, body: { removed } };
    }
    if (req.method !== 'POST') {
      return { status: 404 };
    }
    if (refuse) {
      return { status: 422, body: { error: 'no_servers', message: refuse } };
    }

    const response = await fetch(
      `${b.url}/api/v1/nobookends/directory?nonce=${encodeURIComponent(
        b.nonce
      )}`
    );
    const answer = response.ok ? await response.json() : null;
    checks.push({ status: response.status, body: answer });

    if (!answer || answer.nonce !== b.nonce) {
      return {
        status: 422,
        body: {
          error: 'url_check_failed',
          message: 'The address did not answer with the code.',
        },
      };
    }

    servers.set('plex-server-hash', { url: b.url, title: answer.title });
    return { status: 200, body: { registered: servers.size } };
  });

  return {
    ...app,
    servers,
    checks,
    // Makes the next registrations fail with this message, or work again
    refuseWith: (message: string | null) => {
      refuse = message;
    },
  };
};
