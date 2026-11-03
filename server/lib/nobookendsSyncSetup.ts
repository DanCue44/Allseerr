import type { DockerContainerInfo, PullProgress } from '@server/api/docker';
import DockerAPI, { DockerError } from '@server/api/docker';
import NoBookEndsSyncAPI from '@server/api/nobookendsSync';
import { AudiobookshelfAdminAPI } from '@server/api/userAccess/audiobookshelfAdmin';
import type { RemoteAccount } from '@server/api/userAccess/types';
import type {
  NoBookEndsSyncAbsAccount,
  NoBookEndsSyncSettings,
} from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { getAppClient } from '@server/lib/userAccess';
import logger from '@server/logger';
import { randomBytes } from 'node:crypto';
import os from 'node:os';

/**
 * Setting up a NoBookEnds Sync server from Allseerr: a read only
 * Audiobookshelf account and API key made with the admin key Allseerr
 * already has, an admin token, and then either a container Allseerr
 * creates through the Docker socket, or ready to paste instructions.
 */

export const SYNC_IMAGE = 'ghcr.io/dancue44/nobookends-sync';
export const SYNC_PORT = 8000;
export const DEFAULT_CONTAINER_NAME = 'nobookends-sync';
export const DEFAULT_DATA_PATH = '/mnt/user/appdata/nobookends-sync';
export const DEFAULT_ABS_USERNAME = 'nobookends-sync';
export const DEFAULT_AUTO_WINDOW = '01:00-06:00';
export const SYNC_ICON = 'https://nobookends.com/assets/img/icon-256.png';
export const SYNC_PROJECT_URL = 'https://nobookends.com/sync/';
// Containers Allseerr made carry this label, so it only ever removes its own
export const MANAGED_LABEL = 'com.allseerr.managed';
// How long a new Sync server may take to answer its health check
export const HEALTH_WAIT_MS = 3 * 60 * 1000;

export class SyncSetupError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
    this.name = 'SyncSetupError';
  }
}

export const syncImageTag = (gpu: boolean): string => (gpu ? 'latest' : 'cpu');

export const syncImage = (gpu: boolean): string =>
  `${SYNC_IMAGE}:${syncImageTag(gpu)}`;

export interface SyncInstallOptions {
  gpu: boolean;
  containerName: string;
  dataPath: string;
  // Docker network for the container, empty for Docker's default
  network: string;
  // Audiobookshelf as the Sync container reaches it
  absUrl: string;
  timezone: string;
  autoWindow: string;
  // Host port to publish 8000 on, null for none (same Docker network)
  hostPort: number | null;
}

export interface SyncSecrets {
  absApiKey: string;
  adminToken: string;
}

const NAME_RULE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/;
const TZ_RULE = /^[A-Za-z0-9_+\-/]{1,64}$/;
const WINDOW_RULE =
  /^(always|([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d)$/;

const isHttpUrl = (value: string): boolean => {
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
};

const text = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : '';

/**
 * Checks what the settings page sent. Everything ends up in a container
 * definition or in commands an admin pastes into a shell, so only plain
 * values are accepted.
 */
export const parseInstallOptions = (
  body: Record<string, unknown>
): SyncInstallOptions => {
  const containerName = text(body.containerName) || DEFAULT_CONTAINER_NAME;
  const dataPath = text(body.dataPath).replace(/\/+$/, '') || DEFAULT_DATA_PATH;
  const network = text(body.network);
  const absUrl = text(body.absUrl).replace(/\/+$/, '');
  const timezone = text(body.timezone) || 'UTC';
  const autoWindow = text(body.autoWindow) || DEFAULT_AUTO_WINDOW;
  const port =
    body.hostPort === null ||
    body.hostPort === undefined ||
    body.hostPort === ''
      ? null
      : Number(body.hostPort);

  if (!NAME_RULE.test(containerName)) {
    throw new SyncSetupError(
      400,
      'The container name may only use letters, digits, dots, dashes and underscores.'
    );
  }

  if (!/^\/[A-Za-z0-9 _./+@-]*$/.test(dataPath) || dataPath.includes('..')) {
    throw new SyncSetupError(
      400,
      'The data folder must be an absolute path on the server.'
    );
  }

  if (network && !NAME_RULE.test(network)) {
    throw new SyncSetupError(400, 'Invalid Docker network name.');
  }

  if (!absUrl || !isHttpUrl(absUrl) || /['"\s\\`$]/.test(absUrl)) {
    throw new SyncSetupError(400, 'Invalid Audiobookshelf address.');
  }

  if (!TZ_RULE.test(timezone)) {
    throw new SyncSetupError(400, 'Invalid time zone.');
  }

  if (!WINDOW_RULE.test(autoWindow)) {
    throw new SyncSetupError(
      400,
      'The overnight window must look like 01:00-06:00, or be always.'
    );
  }

  if (port !== null && !(Number.isInteger(port) && port > 0 && port < 65536)) {
    throw new SyncSetupError(400, 'Invalid host port.');
  }

  return {
    gpu: body.gpu === true,
    containerName,
    dataPath,
    network,
    absUrl,
    timezone,
    autoWindow,
    hostPort: port,
  };
};

const isDefaultNetwork = (network: string): boolean =>
  !network || network === 'bridge' || network === 'default';

/**
 * The environment of the Sync container, in a fixed order
 */
export const buildSyncEnv = (
  options: SyncInstallOptions,
  secrets: SyncSecrets
): [string, string][] => [
  ['ABS_URL', options.absUrl],
  ['ABS_API_KEY', secrets.absApiKey],
  ['ADMIN_TOKEN', secrets.adminToken],
  ['TZ', options.timezone],
  ['AUTO_WINDOW', options.autoWindow],
  ...(options.gpu
    ? ([
        ['NVIDIA_VISIBLE_DEVICES', 'all'],
        ['NVIDIA_DRIVER_CAPABILITIES', 'compute,utility'],
      ] as [string, string][])
    : []),
];

// A YAML double quoted string takes JSON escapes
const yamlString = (value: string): string => JSON.stringify(value);

const shellQuote = (value: string): string =>
  /^[A-Za-z0-9_./:@%+=,-]+$/.test(value)
    ? value
    : `'${value.replace(/'/g, `'\\''`)}'`;

const xmlEscape = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

export const buildCompose = (
  options: SyncInstallOptions,
  secrets: SyncSecrets
): string => {
  const sharedNetwork = !isDefaultNetwork(options.network);
  const lines = [
    'services:',
    `  ${options.containerName}:`,
    `    image: ${syncImage(options.gpu)}`,
    `    container_name: ${options.containerName}`,
    '    restart: unless-stopped',
  ];

  if (options.hostPort) {
    lines.push('    ports:', `      - "${options.hostPort}:${SYNC_PORT}"`);
  }

  lines.push('    environment:');
  for (const [name, value] of buildSyncEnv(options, secrets)) {
    lines.push(`      ${name}: ${yamlString(value)}`);
  }
  lines.push(
    '    volumes:',
    `      - ${yamlString(`${options.dataPath}:/data`)}`
  );

  if (options.gpu) {
    lines.push(
      '    deploy:',
      '      resources:',
      '        reservations:',
      '          devices:',
      '            - driver: nvidia',
      '              count: all',
      '              capabilities: [gpu]'
    );
  }

  if (sharedNetwork) {
    lines.push(
      '    networks:',
      `      - ${options.network}`,
      'networks:',
      `  ${options.network}:`,
      '    external: true'
    );
  }

  return `${lines.join('\n')}\n`;
};

export const buildDockerRun = (
  options: SyncInstallOptions,
  secrets: SyncSecrets
): string => {
  const args = [
    'docker run -d',
    `--name ${shellQuote(options.containerName)}`,
    '--restart unless-stopped',
  ];

  if (!isDefaultNetwork(options.network)) {
    args.push(`--network ${shellQuote(options.network)}`);
  }

  if (options.hostPort) {
    args.push(`-p ${options.hostPort}:${SYNC_PORT}`);
  }

  if (options.gpu) {
    args.push('--gpus all');
  }

  for (const [name, value] of buildSyncEnv(options, secrets)) {
    args.push(`-e ${shellQuote(`${name}=${value}`)}`);
  }

  args.push(`-v ${shellQuote(`${options.dataPath}:/data`)}`);
  args.push(syncImage(options.gpu));

  return `${args.join(' \\\n  ')}\n`;
};

/**
 * An Unraid template with every value filled in, to save as
 * /boot/config/plugins/dockerMan/templates-user/my-<name>.xml
 */
export const buildUnraidTemplate = (
  options: SyncInstallOptions,
  secrets: SyncSecrets
): string => {
  const network = isDefaultNetwork(options.network)
    ? 'bridge'
    : options.network;
  const variable = (
    name: string,
    target: string,
    value: string,
    description: string,
    mask = false
  ) =>
    `  <Config Name="${xmlEscape(name)}" Target="${target}" Default="" Mode="" Description="${xmlEscape(
      description
    )}" Type="Variable" Display="always" Required="false" Mask="${mask}">${xmlEscape(
      value
    )}</Config>`;

  const lines = [
    '<?xml version="1.0"?>',
    '<Container version="2">',
    `  <Name>${xmlEscape(options.containerName)}</Name>`,
    `  <Repository>${syncImage(options.gpu)}</Repository>`,
    `  <Network>${xmlEscape(network)}</Network>`,
    '  <Shell>bash</Shell>',
    '  <Privileged>false</Privileged>',
    '  <Support>https://nobookends.com/support/</Support>',
    `  <Project>${SYNC_PROJECT_URL}</Project>`,
    '  <Overview>NoBookEnds Sync, set up from Allseerr: Listen and Read alignment and synced reader data for the NoBookEnds app.</Overview>',
    '  <Category>MediaServer:Books Tools:</Category>',
    '  <WebUI/>',
    `  <Icon>${SYNC_ICON}</Icon>`,
    `  <ExtraParams>${options.gpu ? '--runtime=nvidia' : ''}</ExtraParams>`,
    '  <PostArgs/>',
  ];

  if (options.hostPort) {
    lines.push(
      `  <Config Name="API port" Target="${SYNC_PORT}" Default="${SYNC_PORT}" Mode="tcp" Description="HTTP API port." Type="Port" Display="always" Required="true" Mask="false">${options.hostPort}</Config>`
    );
  }

  lines.push(
    `  <Config Name="Data" Target="/data" Default="${DEFAULT_DATA_PATH}" Mode="rw" Description="Database, alignment results, cached transcripts and whisper models." Type="Path" Display="always" Required="true" Mask="false">${xmlEscape(
      options.dataPath
    )}</Config>`
  );

  const descriptions: Record<string, [string, boolean]> = {
    ABS_URL: ['Audiobookshelf as seen from this container.', false],
    ABS_API_KEY: ['API key of the read only account Allseerr made.', true],
    ADMIN_TOKEN: ['Lets Allseerr queue books and read the status.', true],
    TZ: ['Time zone for the overnight window.', false],
    AUTO_WINDOW: ['Local time window for automatic alignments.', false],
    NVIDIA_VISIBLE_DEVICES: ['all, or the UUID of one GPU.', false],
    NVIDIA_DRIVER_CAPABILITIES: ['Leave as compute,utility.', false],
  };

  for (const [name, value] of buildSyncEnv(options, secrets)) {
    const [description, mask] = descriptions[name] ?? ['', false];
    lines.push(variable(name, name, value, description, mask));
  }

  lines.push('</Container>');

  return `${lines.join('\n')}\n`;
};

/**
 * The address Allseerr reaches a container it installed at: its name on a
 * shared network, or the published port through the Docker host otherwise
 */
export const internalUrlFor = (
  options: SyncInstallOptions,
  hostAddress?: string | null
): string => {
  if (options.network === 'host') {
    return `http://127.0.0.1:${options.hostPort ?? SYNC_PORT}`;
  }

  if (isDefaultNetwork(options.network)) {
    return `http://${hostAddress || '172.17.0.1'}:${options.hostPort ?? SYNC_PORT}`;
  }

  return `http://${options.containerName}:${SYNC_PORT}`;
};

/**
 * The Docker Engine request body for the Sync container
 */
export const buildContainerBody = (
  options: SyncInstallOptions,
  secrets: SyncSecrets,
  {
    nvidiaRuntime,
    restartPolicy,
  }: { nvidiaRuntime: boolean; restartPolicy: string }
): Record<string, unknown> => {
  const network = isDefaultNetwork(options.network)
    ? 'bridge'
    : options.network;
  const port = `${SYNC_PORT}/tcp`;
  const publish = options.hostPort && network !== 'host';

  return {
    Image: syncImage(options.gpu),
    Env: buildSyncEnv(options, secrets).map(
      ([name, value]) => `${name}=${value}`
    ),
    Labels: {
      [MANAGED_LABEL]: 'nobookends-sync',
      'net.unraid.docker.icon': SYNC_ICON,
    },
    ...(publish ? { ExposedPorts: { [port]: {} } } : {}),
    HostConfig: {
      Binds: [`${options.dataPath}:/data`],
      RestartPolicy: { Name: restartPolicy },
      NetworkMode: network,
      ...(publish
        ? { PortBindings: { [port]: [{ HostPort: String(options.hostPort) }] } }
        : {}),
      ...(options.gpu
        ? nvidiaRuntime
          ? { Runtime: 'nvidia' }
          : {
              DeviceRequests: [
                { Driver: 'nvidia', Count: -1, Capabilities: [['gpu']] },
              ],
            }
        : {}),
    },
  };
};

// Unraid stops every container when the array stops, and Docker does not
// bring back an unless-stopped container that was stopped
export const restartPolicyFor = (hostOs?: string): string =>
  hostOs?.toLowerCase() === 'unraid' ? 'always' : 'unless-stopped';

export const generateToken = (): string =>
  randomBytes(32).toString('base64url');

/**
 * The admin token for the Sync server being set up, made once and kept
 * until that server is connected
 */
export const ensureSetupAdminToken = async (): Promise<string> => {
  const settings = getSettings();
  const current = settings.nobookendsSync.setupAdminToken?.trim();

  if (current) {
    return current;
  }

  const token = generateToken();
  settings.nobookendsSync = { setupAdminToken: token };
  await settings.save();

  return token;
};

const getAbsAdmin = (): AudiobookshelfAdminAPI => {
  const client = getAppClient('audiobookshelf');

  if (!(client instanceof AudiobookshelfAdminAPI)) {
    throw new SyncSetupError(
      400,
      'Connect Audiobookshelf with an admin API key in Settings > User Access first.'
    );
  }

  return client;
};

export const isAbsAdminConnected = (): boolean =>
  getAppClient('audiobookshelf') instanceof AudiobookshelfAdminAPI;

const markServiceAccount = (userId: string) => {
  const settings = getSettings();
  const ids = settings.userAccess.serviceAccounts?.audiobookshelf ?? [];

  if (!ids.includes(userId)) {
    settings.userAccess = {
      ...settings.userAccess,
      serviceAccounts: {
        ...settings.userAccess.serviceAccounts,
        audiobookshelf: [...ids, userId],
      },
    };
  }
};

/**
 * The read only Audiobookshelf account the Sync server reads the library
 * with, and its API key. A saved key that still works is kept. An account
 * with that name that already exists gets a new key, and is otherwise left
 * as it is. The key is never logged.
 */
export const ensureAbsAccount = async (
  username: string = DEFAULT_ABS_USERNAME
): Promise<{ account: NoBookEndsSyncAbsAccount; created: boolean }> => {
  const name = username.trim() || DEFAULT_ABS_USERNAME;

  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name)) {
    throw new SyncSetupError(400, 'Invalid Audiobookshelf username.');
  }

  const client = getAbsAdmin();
  const settings = getSettings();
  const saved = settings.nobookendsSync.absAccount;

  if (saved?.apiKey && saved.username.toLowerCase() === name.toLowerCase()) {
    const remote: RemoteAccount = {
      id: saved.userId,
      username: saved.username,
    };

    if (await client.isUserKeyValid(remote, saved.apiKey)) {
      return { account: saved, created: false };
    }
  }

  const existing = (await client.listAccounts()).find(
    (account) => account.username.toLowerCase() === name.toLowerCase()
  );

  if (existing?.isAdmin) {
    throw new SyncSetupError(
      409,
      `The Audiobookshelf account ${existing.username} is an admin. Pick another name.`
    );
  }

  let remote: RemoteAccount;
  let created = false;

  if (existing) {
    remote = { id: existing.id, username: existing.username };
  } else {
    remote = await client.createServiceAccount(name, generateToken());
    created = true;
  }

  const key = await client.createUserKey(remote, 'nobookends-sync');
  const apiKey = key?.key ?? (await client.getLegacyUserToken(remote));

  if (!apiKey) {
    throw new SyncSetupError(
      502,
      'Audiobookshelf did not hand out a key for the account. Update Audiobookshelf to 2.26 or newer.'
    );
  }

  // A key replaced here is not needed any more
  if (saved?.keyId && saved.userId === remote.id && saved.keyId !== key?.id) {
    await client.deleteUserKey(saved.keyId).catch(() => undefined);
  }

  const account: NoBookEndsSyncAbsAccount = {
    userId: remote.id,
    username: remote.username,
    keyId: key?.id ?? '',
    apiKey,
    created: created || (saved?.userId === remote.id && !!saved.created),
  };

  settings.nobookendsSync = { absAccount: account };
  markServiceAccount(remote.id);
  await settings.save();

  logger.info('Prepared the Audiobookshelf account for NoBookEnds Sync', {
    label: 'NoBookEnds Sync',
    username: remote.username,
    created,
  });

  return { account, created };
};

/**
 * Removes the API key Allseerr made and, when Allseerr also made the
 * account, the account itself
 */
export const removeAbsAccount = async (): Promise<void> => {
  const settings = getSettings();
  const saved = settings.nobookendsSync.absAccount;

  if (!saved) {
    return;
  }

  const client = getAbsAdmin();

  if (saved.keyId) {
    await client.deleteUserKey(saved.keyId);
  }

  if (saved.created) {
    try {
      await client.deleteAccount({
        id: saved.userId,
        username: saved.username,
      });
    } catch (e) {
      // Already removed in Audiobookshelf
      if (!/404|not found/i.test(e.message)) {
        throw e;
      }
    }
  }

  delete settings.nobookendsSync.absAccount;
  const ids = settings.userAccess.serviceAccounts?.audiobookshelf;

  if (ids?.includes(saved.userId)) {
    // The getter hands out a copy, and the setter replaces arrays
    settings.userAccess = {
      ...settings.userAccess,
      serviceAccounts: {
        ...settings.userAccess.serviceAccounts,
        audiobookshelf: ids.filter((id) => id !== saved.userId),
      },
    };
  }

  await settings.save();
};

export interface DockerStatus {
  available: boolean;
  // Why Docker cannot be used: no socket mounted, mounted but Allseerr's
  // user may not open it, or Docker does not answer
  reason?: 'no_socket' | 'no_permission' | 'no_answer';
  // The group that owns the socket, which Allseerr's user needs to be in
  socketGroup: number | null;
  // The user and group Allseerr runs as
  processUser: { uid: number; gid: number } | null;
  // The NVIDIA container runtime is installed
  nvidiaRuntime: boolean;
  networks: string[];
  // The network Allseerr itself is on, when it could be found
  ownNetwork: string | null;
  // Where the Docker host is reached from Allseerr's network
  ownGateway: string | null;
  hostOs: string | null;
}

/**
 * The container Allseerr runs in, from its hostname (Docker sets it to the
 * short container id unless told otherwise)
 */
const findOwnContainer = async (
  docker: DockerAPI
): Promise<DockerContainerInfo | null> => {
  const name = process.env.HOST_CONTAINERNAME?.trim();

  for (const candidate of [os.hostname(), name].filter(Boolean) as string[]) {
    try {
      const info = await docker.inspectContainer(candidate);

      if (info) {
        return info;
      }
    } catch {
      // Try the next one
    }
  }

  return null;
};

export const getDockerStatus = async (
  docker: DockerAPI = new DockerAPI()
): Promise<DockerStatus> => {
  const hostOs = process.env.HOST_OS?.trim() || null;
  const socket = await docker.socketState();
  const empty = {
    nvidiaRuntime: false,
    networks: [],
    ownNetwork: null,
    ownGateway: null,
    hostOs,
    socketGroup: socket.gid ?? null,
    processUser:
      typeof process.getuid === 'function' &&
      typeof process.getgid === 'function'
        ? { uid: process.getuid(), gid: process.getgid() }
        : null,
  };

  if (socket.state === 'missing') {
    return { available: false, reason: 'no_socket', ...empty };
  }

  if (socket.state === 'no_permission') {
    return { available: false, reason: 'no_permission', ...empty };
  }

  if (!(await docker.ping())) {
    return { available: false, reason: 'no_answer', ...empty };
  }

  const [info, networks, own] = await Promise.all([
    docker.info().catch(() => ({}) as { Runtimes?: Record<string, unknown> }),
    docker.listNetworks().catch(() => []),
    findOwnContainer(docker),
  ]);
  const ownNetworks = Object.entries(own?.NetworkSettings?.Networks ?? {});
  // A network of its own (proxynet, say) lets containers find each other
  // by name, so it is preferred over Docker's default bridge
  const preferred =
    ownNetworks.find(([name]) => !isDefaultNetwork(name)) ?? ownNetworks[0];

  return {
    ...empty,
    available: true,
    nvidiaRuntime: Object.keys(info.Runtimes ?? {}).includes('nvidia'),
    networks: networks
      .filter((n) => n.Driver !== 'null')
      .map((n) => n.Name)
      .sort(),
    ownNetwork: preferred?.[0] ?? own?.HostConfig?.NetworkMode ?? null,
    ownGateway: preferred?.[1]?.Gateway || null,
    hostOs,
  };
};

export type InstallStep = 'pull' | 'create' | 'start' | 'health' | 'connect';

export interface InstallState {
  state: 'idle' | 'running' | 'done' | 'failed';
  step?: InstallStep;
  // 0 to 1 while the image downloads, when Docker reports sizes
  progress?: number;
  error?: string;
  containerName?: string;
  image?: string;
  startedAt?: number;
  finishedAt?: number;
}

let installState: InstallState = { state: 'idle' };

export const getInstallState = (): InstallState => ({ ...installState });

export const resetInstallState = (): void => {
  installState = { state: 'idle' };
};

const setInstallState = (changes: Partial<InstallState>) => {
  installState = { ...installState, ...changes };
};

const pullTracker = () => {
  const layers = new Map<string, { current: number; total: number }>();

  return (progress: PullProgress) => {
    const { id, progressDetail, status } = progress;

    if (!id) {
      return;
    }

    if (progressDetail?.total) {
      layers.set(id, {
        current: progressDetail.current ?? 0,
        total: progressDetail.total,
      });
    } else if (/complete|already exists/i.test(status ?? '')) {
      const layer = layers.get(id);
      if (layer) {
        layers.set(id, { ...layer, current: layer.total });
      }
    }

    let current = 0;
    let total = 0;
    layers.forEach((layer) => {
      current += Math.min(layer.current, layer.total);
      total += layer.total;
    });

    // Docker reports layers as it finds them, so the share can drop; the
    // bar only moves forward, and stays short of full until the pull ends
    if (total > 0) {
      setInstallState({
        progress: Math.max(
          installState.progress ?? 0,
          Math.min(0.99, current / total)
        ),
      });
    }
  };
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const waitForHealth = async (
  url: string,
  {
    timeoutMs = HEALTH_WAIT_MS,
    intervalMs = 2000,
  }: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<void> => {
  const client = new NoBookEndsSyncAPI({ url, timeout: 5000 });
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      await client.getHealth();
      return;
    } catch {
      await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
    }
  }

  throw new SyncSetupError(
    504,
    'The Sync container started, but did not answer its health check in time.'
  );
};

/**
 * Saves a working Sync server as the one Allseerr uses: queueing on, the
 * reader API served through Allseerr, and the new admin token in place
 */
export const connectSyncServer = async ({
  internalUrl,
  adminToken,
  container,
}: {
  internalUrl: string;
  adminToken: string;
  container?: NoBookEndsSyncSettings['container'];
}): Promise<void> => {
  const settings = getSettings();
  const installed = settings.nobookendsSync.container;

  settings.nobookendsSync = {
    enabled: true,
    internalUrl,
    adminToken,
    proxy: true,
    ...(container ? { container } : {}),
  };
  delete settings.nobookendsSync.setupAdminToken;

  // Another server was connected: the container Allseerr installed is no
  // longer the one in use, so it is not offered for removal here any more
  if (!container && installed && !isInstalledAt(installed, internalUrl)) {
    delete settings.nobookendsSync.container;
  }

  await settings.save();
};

const isInstalledAt = (
  container: NonNullable<NoBookEndsSyncSettings['container']>,
  url?: string
): boolean =>
  (url ?? '').replace(/\/+$/, '') ===
  (container.internalUrl ?? `http://${container.name}:${SYNC_PORT}`);

/**
 * Starts the automatic install and answers once it is under way. Docker,
 * the name and the Audiobookshelf account are checked first, so those
 * problems come back right away. The rest runs in the background and is
 * read with getInstallState.
 */
export const startInstall = async (
  options: SyncInstallOptions,
  {
    docker = new DockerAPI(),
    absUsername,
    healthTimeoutMs,
  }: { docker?: DockerAPI; absUsername?: string; healthTimeoutMs?: number } = {}
): Promise<InstallState> => {
  if (installState.state === 'running') {
    throw new SyncSetupError(409, 'An install is already running.');
  }

  const status = await getDockerStatus(docker);

  if (!status.available) {
    throw new SyncSetupError(
      400,
      status.reason === 'no_socket'
        ? 'Allseerr cannot reach Docker: the Docker socket is not mounted.'
        : status.reason === 'no_permission'
          ? `The Docker socket is mounted, but Allseerr may not open it. Add --group-add ${
              status.socketGroup ?? '<docker group id>'
            } to the Allseerr container.`
          : 'The Docker socket is mounted, but Docker does not answer.'
    );
  }

  if (await docker.inspectContainer(options.containerName)) {
    throw new SyncSetupError(
      409,
      `A container named ${options.containerName} already exists. Pick another name, or connect to it.`
    );
  }

  if (
    (isDefaultNetwork(options.network) || options.network === 'host') &&
    !options.hostPort
  ) {
    options = { ...options, hostPort: SYNC_PORT };
  }

  const { account } = await ensureAbsAccount(absUsername);
  const adminToken = await ensureSetupAdminToken();
  const secrets: SyncSecrets = { absApiKey: account.apiKey, adminToken };
  const image = syncImage(options.gpu);

  installState = {
    state: 'running',
    step: 'pull',
    containerName: options.containerName,
    image,
    startedAt: Date.now(),
  };

  const run = async () => {
    let containerId: string | undefined;

    try {
      await docker.pullImage(
        SYNC_IMAGE,
        syncImageTag(options.gpu),
        pullTracker()
      );

      setInstallState({ step: 'create', progress: 1 });
      containerId = await docker.createContainer(
        options.containerName,
        buildContainerBody(options, secrets, {
          nvidiaRuntime: status.nvidiaRuntime,
          restartPolicy: restartPolicyFor(status.hostOs ?? undefined),
        })
      );

      setInstallState({ step: 'start' });
      await docker.startContainer(containerId);

      setInstallState({ step: 'health' });
      const internalUrl = internalUrlFor(options, status.ownGateway);
      await waitForHealth(internalUrl, { timeoutMs: healthTimeoutMs });

      setInstallState({ step: 'connect' });
      await connectSyncServer({
        internalUrl,
        adminToken,
        container: {
          id: containerId,
          name: options.containerName,
          image,
          dataPath: options.dataPath,
          network: options.network || 'bridge',
          internalUrl,
        },
      });

      setInstallState({ state: 'done', finishedAt: Date.now() });
      logger.info('Installed NoBookEnds Sync', {
        label: 'NoBookEnds Sync',
        container: options.containerName,
        image,
      });
    } catch (e) {
      const message =
        e instanceof DockerError || e instanceof SyncSetupError
          ? e.message
          : 'The install stopped unexpectedly.';

      logger.error('Failed to install NoBookEnds Sync', {
        label: 'NoBookEnds Sync',
        step: installState.step,
        errorMessage: e.message,
      });
      setInstallState({
        state: 'failed',
        error: message,
        finishedAt: Date.now(),
      });

      // A container that never answered is not left behind
      if (containerId && installState.step !== 'connect') {
        await docker.removeContainer(containerId).catch(() => undefined);
      }
    }
  };

  void run();

  return getInstallState();
};

/**
 * Removes the container Allseerr installed. Its data folder is kept.
 */
export const removeInstalledContainer = async (
  docker: DockerAPI = new DockerAPI()
): Promise<void> => {
  const settings = getSettings();
  const container = settings.nobookendsSync.container;

  if (!container) {
    throw new SyncSetupError(404, 'Allseerr did not install a Sync container.');
  }

  const info = await docker.inspectContainer(container.id);
  const labels = info?.Config?.Labels;

  if (info && labels?.[MANAGED_LABEL] !== 'nobookends-sync') {
    throw new SyncSetupError(
      409,
      'That container was not made by Allseerr, so it is left alone.'
    );
  }

  if (info) {
    await docker.removeContainer(container.id);
  }

  // Turn the integration off only when it used this container
  const inUse = isInstalledAt(container, settings.nobookendsSync.internalUrl);
  delete settings.nobookendsSync.container;
  if (inUse) {
    settings.nobookendsSync = { enabled: false };
  }
  await settings.save();
};

export const isNoticeDismissed = (userId: number): boolean =>
  !!getSettings().nobookendsSync.noticeDismissedBy?.includes(userId);

export const dismissNotice = async (userId: number): Promise<void> => {
  const settings = getSettings();
  const ids = settings.nobookendsSync.noticeDismissedBy ?? [];

  if (!ids.includes(userId)) {
    settings.nobookendsSync = { noticeDismissedBy: [...ids, userId] };
    await settings.save();
  }
};
