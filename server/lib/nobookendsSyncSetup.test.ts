import assert from 'node:assert/strict';
import { beforeEach, describe, it, mock } from 'node:test';

import type DockerAPI from '@server/api/docker';
import type { DockerContainerInfo } from '@server/api/docker';
import NoBookEndsSyncAPI from '@server/api/nobookendsSync';
import { AudiobookshelfAdminAPI } from '@server/api/userAccess/audiobookshelfAdmin';
import type { RemoteAccount } from '@server/api/userAccess/types';
import type { SyncInstallOptions } from '@server/lib/nobookendsSyncSetup';
import {
  MANAGED_LABEL,
  buildCompose,
  buildContainerBody,
  buildDockerRun,
  buildUnraidTemplate,
  connectSyncServer,
  dismissNotice,
  ensureAbsAccount,
  getDockerStatus,
  getInstallState,
  internalUrlFor,
  isNoticeDismissed,
  parseInstallOptions,
  removeAbsAccount,
  removeInstalledContainer,
  resetInstallState,
  restartPolicyFor,
  startInstall,
} from '@server/lib/nobookendsSyncSetup';
import { getSettings } from '@server/lib/settings';

const secrets = { absApiKey: "abs'key", adminToken: 'admin-token' };

const options = (
  changes: Partial<SyncInstallOptions> = {}
): SyncInstallOptions => ({
  gpu: false,
  containerName: 'nobookends-sync',
  dataPath: '/mnt/user/appdata/nobookends-sync',
  network: 'proxynet',
  absUrl: 'http://audiobookshelf:80',
  timezone: 'America/New_York',
  autoWindow: '01:00-06:00',
  hostPort: null,
  ...changes,
});

// Audiobookshelf, as the admin key sees it
let absUsers: { id: string; username: string; type: string }[] = [];
let absKeys: { id: string; userId: string; key: string }[] = [];
let absVersion = '2.30.0';

mock.method(AudiobookshelfAdminAPI.prototype, 'listAccounts', async () =>
  absUsers.map((u) => ({
    id: u.id,
    username: u.username,
    isAdmin: u.type === 'admin' || u.type === 'root',
  }))
);
mock.method(
  AudiobookshelfAdminAPI.prototype,
  'createServiceAccount',
  async (username: string) => {
    const user = { id: `u${absUsers.length + 1}`, username, type: 'user' };
    absUsers.push(user);
    return { id: user.id, username };
  }
);
mock.method(
  AudiobookshelfAdminAPI.prototype,
  'createUserKey',
  async (account: RemoteAccount) => {
    if (absVersion < '2.26.0') {
      return null;
    }
    const key = {
      id: `k${absKeys.length + 1}`,
      userId: account.id,
      key: `key-${absKeys.length + 1}`,
    };
    absKeys.push(key);
    return { id: key.id, key: key.key };
  }
);
mock.method(
  AudiobookshelfAdminAPI.prototype,
  'getLegacyUserToken',
  async () => 'legacy-token'
);
mock.method(
  AudiobookshelfAdminAPI.prototype,
  'isUserKeyValid',
  async (account: RemoteAccount, key: string) =>
    absKeys.some((k) => k.userId === account.id && k.key === key)
);
mock.method(
  AudiobookshelfAdminAPI.prototype,
  'deleteUserKey',
  async (id: string) => {
    absKeys = absKeys.filter((k) => k.id !== id);
  }
);
mock.method(
  AudiobookshelfAdminAPI.prototype,
  'deleteAccount',
  async (account: RemoteAccount) => {
    absUsers = absUsers.filter((u) => u.id !== account.id);
  }
);

let healthy = true;
mock.method(NoBookEndsSyncAPI.prototype, 'getHealth', async () => {
  if (!healthy) {
    throw new Error('connect ECONNREFUSED');
  }
  return { ok: true, version: '1.6.0', gpu: false };
});

// A Docker engine in memory
const makeDocker = ({
  socket = true,
  runtimes = ['runc'],
}: { socket?: boolean; runtimes?: string[] } = {}) => {
  const containers = new Map<string, DockerContainerInfo>();
  const created: { name: string; body: Record<string, unknown> }[] = [];
  const pulled: string[] = [];
  const removed: string[] = [];

  containers.set('allseerr', {
    Id: 'allseerr',
    Name: '/Allseerr',
    NetworkSettings: { Networks: { proxynet: { Gateway: '172.18.0.1' } } },
  });

  const docker = {
    socketState: async () =>
      socket ? { state: 'ok', gid: 281 } : { state: 'missing' },
    ping: async () => true,
    info: async () => ({
      Runtimes: Object.fromEntries(runtimes.map((r) => [r, {}])),
    }),
    listNetworks: async () => [
      { Name: 'bridge', Driver: 'bridge' },
      { Name: 'proxynet', Driver: 'bridge' },
      { Name: 'none', Driver: 'null' },
    ],
    inspectContainer: async (name: string) =>
      containers.get(name) ??
      [...containers.values()].find((c) => c.Name === `/${name}`) ??
      null,
    pullImage: async (image: string, tag: string) => {
      pulled.push(`${image}:${tag}`);
    },
    createContainer: async (name: string, body: Record<string, unknown>) => {
      created.push({ name, body });
      const id = `c${created.length}`;
      containers.set(id, {
        Id: id,
        Name: `/${name}`,
        Config: { Labels: body.Labels as Record<string, string> },
      });
      return id;
    },
    startContainer: async () => undefined,
    removeContainer: async (id: string) => {
      removed.push(id);
      containers.delete(id);
    },
  };

  return {
    docker: docker as unknown as DockerAPI,
    containers,
    created,
    pulled,
    removed,
  };
};

const waitForInstall = async () => {
  for (let i = 0; i < 200 && getInstallState().state === 'running'; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return getInstallState();
};

beforeEach(() => {
  absUsers = [{ id: 'root', username: 'root', type: 'root' }];
  absKeys = [];
  absVersion = '2.30.0';
  healthy = true;
  resetInstallState();
  process.env.HOST_CONTAINERNAME = 'allseerr';
  const settings = getSettings();
  settings.userAccess = {
    ...settings.userAccess,
    audiobookshelf: { url: 'http://audiobookshelf:80', apiKey: 'admin-key' },
    serviceAccounts: { audiobookshelf: [] },
  };
  const sync = settings.nobookendsSync;
  for (const key of Object.keys(sync)) {
    delete (sync as Record<string, unknown>)[key];
  }
  Object.assign(sync, {
    enabled: false,
    url: '',
    internalUrl: '',
    adminToken: '',
  });
});

describe('install options', () => {
  it('fills in defaults and accepts plain values', () => {
    const parsed = parseInstallOptions({
      absUrl: 'http://audiobookshelf:80/',
      gpu: true,
      hostPort: '8001',
    });

    assert.strictEqual(parsed.containerName, 'nobookends-sync');
    assert.strictEqual(parsed.dataPath, '/mnt/user/appdata/nobookends-sync');
    assert.strictEqual(parsed.absUrl, 'http://audiobookshelf:80');
    assert.strictEqual(parsed.gpu, true);
    assert.strictEqual(parsed.hostPort, 8001);
    assert.strictEqual(parsed.autoWindow, '01:00-06:00');
  });

  it('refuses values that could break out of a command or a path', () => {
    const base = { absUrl: 'http://audiobookshelf:80' };

    for (const body of [
      { ...base, containerName: 'sync; rm -rf /' },
      { ...base, dataPath: 'relative/path' },
      { ...base, dataPath: '/mnt/../etc' },
      { ...base, dataPath: '/mnt/data:/etc' },
      { ...base, network: 'net work' },
      { absUrl: 'ftp://audiobookshelf' },
      { absUrl: "http://abs/'$(id)'" },
      { ...base, timezone: 'Europe/Paris; id' },
      { ...base, autoWindow: '1am-6am' },
      { ...base, hostPort: 70000 },
    ]) {
      assert.throws(() => parseInstallOptions(body), JSON.stringify(body));
    }
  });
});

describe('install instructions', () => {
  it('writes a compose file with every value and the shared network', () => {
    const compose = buildCompose(options(), secrets);

    assert.match(compose, /image: ghcr\.io\/dancue44\/nobookends-sync:cpu/);
    assert.match(compose, /ABS_URL: "http:\/\/audiobookshelf:80"/);
    assert.match(compose, /ABS_API_KEY: "abs'key"/);
    assert.match(compose, /ADMIN_TOKEN: "admin-token"/);
    assert.match(compose, /TZ: "America\/New_York"/);
    assert.match(compose, /- "\/mnt\/user\/appdata\/nobookends-sync:\/data"/);
    assert.match(compose, /networks:\n {2}proxynet:\n {4}external: true/);
    assert.doesNotMatch(compose, /ports:/);
    assert.doesNotMatch(compose, /nvidia/);
  });

  it('adds the GPU and a port when asked', () => {
    const compose = buildCompose(
      options({ gpu: true, network: '', hostPort: 8000 }),
      secrets
    );

    assert.match(compose, /nobookends-sync:latest/);
    assert.match(compose, /capabilities: \[gpu\]/);
    assert.match(compose, /- "8000:8000"/);
    assert.doesNotMatch(compose, /external: true/);
  });

  it('quotes values in docker run', () => {
    const run = buildDockerRun(options({ gpu: true }), secrets);

    assert.match(run, /--network proxynet/);
    assert.match(run, /--gpus all/);
    assert.match(run, /--restart unless-stopped/);
    assert.match(run, /-e 'ABS_API_KEY=abs'\\''key'/);
    assert.match(run, /-v \/mnt\/user\/appdata\/nobookends-sync:\/data/);
    assert.match(run, /ghcr\.io\/dancue44\/nobookends-sync:latest\n$/);
  });

  it('escapes the Unraid template and masks the secrets', () => {
    const xml = buildUnraidTemplate(
      options({ gpu: true, hostPort: 8000 }),
      secrets
    );

    assert.match(xml, /<Name>nobookends-sync<\/Name>/);
    assert.match(xml, /<Network>proxynet<\/Network>/);
    assert.match(xml, /<ExtraParams>--runtime=nvidia<\/ExtraParams>/);
    assert.match(xml, /Target="ABS_API_KEY"[^>]*Mask="true">abs&apos;key</);
    assert.match(xml, /Target="ADMIN_TOKEN"[^>]*Mask="true">admin-token</);
    assert.match(xml, /Target="8000"[^>]*>8000</);
  });
});

describe('container definition', () => {
  it('uses the NVIDIA runtime when Docker has it, a device request otherwise', () => {
    const runtime = buildContainerBody(options({ gpu: true }), secrets, {
      nvidiaRuntime: true,
      restartPolicy: 'always',
    });
    const request = buildContainerBody(options({ gpu: true }), secrets, {
      nvidiaRuntime: false,
      restartPolicy: 'unless-stopped',
    });
    const cpu = buildContainerBody(options(), secrets, {
      nvidiaRuntime: true,
      restartPolicy: 'unless-stopped',
    });

    const host = (body: Record<string, unknown>) =>
      body.HostConfig as Record<string, unknown>;

    assert.strictEqual(host(runtime).Runtime, 'nvidia');
    assert.deepStrictEqual(host(runtime).RestartPolicy, { Name: 'always' });
    assert.ok(Array.isArray(host(request).DeviceRequests));
    assert.strictEqual(host(cpu).Runtime, undefined);
    assert.strictEqual(host(cpu).NetworkMode, 'proxynet');
    assert.deepStrictEqual(host(cpu).Binds, [
      '/mnt/user/appdata/nobookends-sync:/data',
    ]);
    assert.strictEqual(
      (cpu.Labels as Record<string, string>)[MANAGED_LABEL],
      'nobookends-sync'
    );
    assert.ok((cpu.Env as string[]).includes('ADMIN_TOKEN=admin-token'));
  });

  it('publishes the port on the default bridge', () => {
    const body = buildContainerBody(
      options({ network: '', hostPort: 8001 }),
      secrets,
      { nvidiaRuntime: false, restartPolicy: 'unless-stopped' }
    );
    const host = body.HostConfig as Record<string, unknown>;

    assert.strictEqual(host.NetworkMode, 'bridge');
    assert.deepStrictEqual(host.PortBindings, {
      '8000/tcp': [{ HostPort: '8001' }],
    });
  });

  it('finds the container by name on a shared network, by port otherwise', () => {
    assert.strictEqual(
      internalUrlFor(options()),
      'http://nobookends-sync:8000'
    );
    assert.strictEqual(
      internalUrlFor(
        options({ network: 'bridge', hostPort: 8001 }),
        '172.17.0.1'
      ),
      'http://172.17.0.1:8001'
    );
    assert.strictEqual(
      internalUrlFor(options({ network: 'host' })),
      'http://127.0.0.1:8000'
    );
  });

  it('brings the container back after an Unraid reboot', () => {
    assert.strictEqual(restartPolicyFor('Unraid'), 'always');
    assert.strictEqual(restartPolicyFor(undefined), 'unless-stopped');
  });
});

describe('Audiobookshelf account', () => {
  it('makes a read only account and a key once, then keeps them', async () => {
    const first = await ensureAbsAccount('nobookends-sync');

    assert.strictEqual(first.created, true);
    assert.strictEqual(first.account.username, 'nobookends-sync');
    assert.strictEqual(first.account.apiKey, 'key-1');
    assert.strictEqual(absUsers.length, 2);
    assert.deepStrictEqual(
      getSettings().userAccess.serviceAccounts?.audiobookshelf,
      [first.account.userId]
    );

    const second = await ensureAbsAccount('nobookends-sync');

    assert.strictEqual(second.created, false);
    assert.strictEqual(second.account.apiKey, 'key-1');
    assert.strictEqual(absKeys.length, 1);
  });

  it('gives an existing account a new key without making another', async () => {
    absUsers.push({ id: 'u9', username: 'NoBookEnds-Sync', type: 'user' });

    const { account, created } = await ensureAbsAccount('nobookends-sync');

    assert.strictEqual(created, false);
    assert.strictEqual(account.userId, 'u9');
    assert.strictEqual(account.created, false);
    assert.strictEqual(absUsers.length, 2);
  });

  it('refuses an admin account and needs the admin key', async () => {
    await assert.rejects(ensureAbsAccount('root'), /is an admin/);

    getSettings().userAccess = {
      ...getSettings().userAccess,
      audiobookshelf: { url: '', apiKey: '' },
    };
    await assert.rejects(ensureAbsAccount('nobookends-sync'), /User Access/);
  });

  it('uses the account token on Audiobookshelf before API keys', async () => {
    absVersion = '2.20.0';

    const { account } = await ensureAbsAccount('nobookends-sync');

    assert.strictEqual(account.apiKey, 'legacy-token');
    assert.strictEqual(account.keyId, '');
  });

  it('removes the key, and the account only when Allseerr made it', async () => {
    await ensureAbsAccount('nobookends-sync');
    await removeAbsAccount();

    assert.strictEqual(absKeys.length, 0);
    assert.deepStrictEqual(
      absUsers.map((u) => u.username),
      ['root']
    );
    assert.strictEqual(getSettings().nobookendsSync.absAccount, undefined);
    assert.deepStrictEqual(
      getSettings().userAccess.serviceAccounts?.audiobookshelf,
      []
    );

    absUsers.push({ id: 'u7', username: 'nobookends-sync', type: 'user' });
    await ensureAbsAccount('nobookends-sync');
    await removeAbsAccount();

    assert.ok(absUsers.some((u) => u.id === 'u7'));
  });
});

describe('Docker', () => {
  it('reports no socket without touching Docker', async () => {
    const { docker } = makeDocker({ socket: false });
    const status = await getDockerStatus(docker);

    assert.strictEqual(status.available, false);
    assert.strictEqual(status.reason, 'no_socket');
  });

  it('tells a mounted socket Allseerr may not open apart from a missing one', async () => {
    const { docker } = makeDocker();
    (docker as unknown as { socketState: () => Promise<unknown> }).socketState =
      async () => ({ state: 'no_permission', gid: 281 });
    const status = await getDockerStatus(docker);

    assert.strictEqual(status.available, false);
    assert.strictEqual(status.reason, 'no_permission');
    assert.strictEqual(status.socketGroup, 281);
    await assert.rejects(
      startInstall(options(), { docker }),
      /--group-add 281/
    );
  });

  it('finds the NVIDIA runtime and its own network', async () => {
    const { docker } = makeDocker({ runtimes: ['runc', 'nvidia'] });
    const status = await getDockerStatus(docker);

    assert.strictEqual(status.available, true);
    assert.strictEqual(status.nvidiaRuntime, true);
    assert.strictEqual(status.ownNetwork, 'proxynet');
    assert.deepStrictEqual(status.networks, ['bridge', 'proxynet']);
  });
});

describe('automatic install', () => {
  it('pulls, creates, starts and connects the Sync server', async () => {
    const { docker, created, pulled } = makeDocker();

    const started = await startInstall(options(), { docker });
    assert.strictEqual(started.state, 'running');

    const state = await waitForInstall();
    assert.strictEqual(state.state, 'done', state.error);
    assert.deepStrictEqual(pulled, ['ghcr.io/dancue44/nobookends-sync:cpu']);
    assert.strictEqual(created[0].name, 'nobookends-sync');

    const sync = getSettings().nobookendsSync;
    assert.strictEqual(sync.enabled, true);
    assert.strictEqual(sync.proxy, true);
    assert.strictEqual(sync.internalUrl, 'http://nobookends-sync:8000');
    assert.ok(sync.adminToken && sync.adminToken.length > 30);
    assert.strictEqual(sync.setupAdminToken, undefined);
    assert.strictEqual(sync.container?.id, 'c1');
    assert.ok(
      (created[0].body.Env as string[]).includes(
        `ADMIN_TOKEN=${sync.adminToken}`
      )
    );
  });

  it('refuses a name that is taken and leaves that container alone', async () => {
    const { docker, created, containers } = makeDocker();
    containers.set('other', { Id: 'other', Name: '/nobookends-sync' });

    await assert.rejects(startInstall(options(), { docker }), /already exists/);
    assert.strictEqual(created.length, 0);
  });

  it('removes a container that never answered', async () => {
    healthy = false;
    const { docker, removed } = makeDocker();

    await startInstall(options(), { docker, healthTimeoutMs: 20 });
    const state = await waitForInstall();

    assert.strictEqual(state.state, 'failed');
    assert.match(state.error ?? '', /health check/);
    assert.deepStrictEqual(removed, ['c1']);
    assert.strictEqual(getSettings().nobookendsSync.enabled, false);
  });

  it('removes only a container Allseerr made', async () => {
    const { docker, containers } = makeDocker();
    await startInstall(options(), { docker });
    await waitForInstall();

    containers.set('c1', { Id: 'c1', Name: '/nobookends-sync', Config: {} });
    await assert.rejects(
      removeInstalledContainer(docker),
      /not made by Allseerr/
    );

    containers.set('c1', {
      Id: 'c1',
      Name: '/nobookends-sync',
      Config: { Labels: { [MANAGED_LABEL]: 'nobookends-sync' } },
    });
    await removeInstalledContainer(docker);
    assert.strictEqual(containers.has('c1'), false);
    assert.strictEqual(getSettings().nobookendsSync.enabled, false);
  });
});

describe('connecting another server', () => {
  it('forgets the installed container and leaves it running', async () => {
    const { docker, containers, removed } = makeDocker();
    await startInstall(options(), { docker });
    await waitForInstall();
    assert.strictEqual(
      getSettings().nobookendsSync.container?.internalUrl,
      'http://nobookends-sync:8000'
    );

    // Connecting the same container again keeps it
    await connectSyncServer({
      internalUrl: 'http://nobookends-sync:8000/',
      adminToken: 'token',
    });
    assert.strictEqual(getSettings().nobookendsSync.container?.id, 'c1');

    await connectSyncServer({
      internalUrl: 'http://nobookends-sync-manual:8000',
      adminToken: 'token',
    });
    assert.strictEqual(getSettings().nobookendsSync.container, undefined);
    assert.ok(containers.has('c1'));
    assert.deepStrictEqual(removed, []);
  });

  it('keeps a manually connected server on when the old container goes', async () => {
    const { docker } = makeDocker();
    await startInstall(options(), { docker });
    await waitForInstall();

    getSettings().nobookendsSync = { internalUrl: 'http://other-sync:8000' };
    await removeInstalledContainer(docker);

    assert.strictEqual(getSettings().nobookendsSync.enabled, true);
    assert.strictEqual(getSettings().nobookendsSync.container, undefined);
  });
});

describe('notice', () => {
  it('is shown to each admin until that admin closes it', async () => {
    assert.strictEqual(isNoticeDismissed(1), false);

    await dismissNotice(1);

    assert.strictEqual(isNoticeDismissed(1), true);
    assert.strictEqual(isNoticeDismissed(2), false);
  });
});
