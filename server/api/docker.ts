import fs from 'node:fs/promises';
import http from 'node:http';

/**
 * A small client for the Docker Engine API over its unix socket. Allseerr
 * only uses it when the admin mounted the socket into the container, to
 * install companion containers such as NoBookEnds Sync.
 */

export const DEFAULT_DOCKER_SOCKET = '/var/run/docker.sock';

export const getDockerSocketPath = (): string =>
  process.env.DOCKER_SOCKET?.trim() || DEFAULT_DOCKER_SOCKET;

export class DockerError extends Error {
  constructor(
    message: string,
    public status?: number
  ) {
    super(message);
    this.name = 'DockerError';
  }
}

export interface DockerResponse<T> {
  status: number;
  data: T;
}

export interface DockerContainerInfo {
  Id: string;
  Name: string;
  State?: { Status?: string; Running?: boolean };
  Config?: {
    Hostname?: string;
    Image?: string;
    Env?: string[];
    Labels?: Record<string, string>;
  };
  HostConfig?: { NetworkMode?: string };
  NetworkSettings?: {
    Networks?: Record<string, { Gateway?: string; IPAddress?: string }>;
  };
}

export interface DockerInfo {
  Runtimes?: Record<string, unknown>;
  DefaultRuntime?: string;
  OperatingSystem?: string;
  ServerVersion?: string;
}

export interface DockerNetwork {
  Name: string;
  Driver?: string;
}

export interface PullProgress {
  status?: string;
  id?: string;
  progressDetail?: { current?: number; total?: number };
  error?: string;
  errorDetail?: { message?: string };
}

class DockerAPI {
  constructor(
    private socketPath: string = getDockerSocketPath(),
    private timeout = 15000
  ) {}

  /**
   * Whether the socket is mounted and this process may open it. Docker's
   * socket usually belongs to root and a docker group, so a container that
   * does not run as root also needs that group (its id is returned).
   */
  public async socketState(): Promise<{
    state: 'missing' | 'no_permission' | 'ok';
    gid?: number;
  }> {
    let gid: number | undefined;

    try {
      const stat = await fs.stat(this.socketPath);

      if (!stat.isSocket()) {
        return { state: 'missing' };
      }
      gid = stat.gid;
    } catch {
      return { state: 'missing' };
    }

    try {
      await fs.access(this.socketPath, fs.constants.R_OK | fs.constants.W_OK);
      return { state: 'ok', gid };
    } catch {
      return { state: 'no_permission', gid };
    }
  }

  /**
   * True when the path is a unix socket this process can open. Says nothing
   * about whether Docker answers on it.
   */
  public async socketPresent(): Promise<boolean> {
    return (await this.socketState()).state === 'ok';
  }

  private request<T>(
    method: string,
    path: string,
    body?: unknown,
    { timeout = this.timeout }: { timeout?: number } = {}
  ): Promise<DockerResponse<T>> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = http.request(
        {
          socketPath: this.socketPath,
          path,
          method,
          headers: {
            Host: 'docker',
            ...(payload
              ? {
                  'Content-Type': 'application/json',
                  'Content-Length': Buffer.byteLength(payload),
                }
              : {}),
          },
          timeout,
        },
        (res) => {
          const chunks: Buffer[] = [];

          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let data: unknown = text;

            if ((res.headers['content-type'] ?? '').includes('json') && text) {
              try {
                data = JSON.parse(text);
              } catch {
                data = text;
              }
            }

            resolve({ status: res.statusCode ?? 0, data: data as T });
          });
          res.on('error', reject);
        }
      );

      req.on('timeout', () => {
        req.destroy(new DockerError('Docker did not answer in time.'));
      });
      req.on('error', (e) =>
        reject(e instanceof DockerError ? e : new DockerError(e.message))
      );

      if (payload) {
        req.write(payload);
      }
      req.end();
    });
  }

  private static errorMessage(data: unknown, fallback: string): string {
    if (data && typeof data === 'object' && 'message' in data) {
      const message = (data as { message?: unknown }).message;

      if (typeof message === 'string' && message) {
        return message;
      }
    }

    return fallback;
  }

  private async call<T>(
    method: string,
    path: string,
    body?: unknown,
    options?: { timeout?: number }
  ): Promise<T> {
    const response = await this.request<T>(method, path, body, options);

    if (response.status >= 400) {
      throw new DockerError(
        DockerAPI.errorMessage(
          response.data,
          `Docker answered ${response.status} to ${method} ${path.split('?')[0]}`
        ),
        response.status
      );
    }

    return response.data;
  }

  public async ping(): Promise<boolean> {
    try {
      const response = await this.request<string>('GET', '/_ping', undefined, {
        timeout: 5000,
      });

      return response.status === 200;
    } catch {
      return false;
    }
  }

  public info(): Promise<DockerInfo> {
    return this.call<DockerInfo>('GET', '/info');
  }

  public async listNetworks(): Promise<DockerNetwork[]> {
    const networks = await this.call<DockerNetwork[]>('GET', '/networks');

    return Array.isArray(networks) ? networks : [];
  }

  /**
   * A container by name or id, or null when there is none
   */
  public async inspectContainer(
    nameOrId: string
  ): Promise<DockerContainerInfo | null> {
    const response = await this.request<DockerContainerInfo>(
      'GET',
      `/containers/${encodeURIComponent(nameOrId)}/json`
    );

    if (response.status === 404) {
      return null;
    }

    if (response.status >= 400) {
      throw new DockerError(
        DockerAPI.errorMessage(response.data, 'Docker could not be asked.'),
        response.status
      );
    }

    return response.data;
  }

  /**
   * Pulls an image and resolves once Docker has it. Docker streams one JSON
   * object per line, and reports a failure as an error line with status 200.
   */
  public pullImage(
    image: string,
    tag: string,
    onProgress?: (progress: PullProgress) => void
  ): Promise<void> {
    const path = `/images/create?fromImage=${encodeURIComponent(
      image
    )}&tag=${encodeURIComponent(tag)}`;

    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          socketPath: this.socketPath,
          path,
          method: 'POST',
          headers: { Host: 'docker' },
        },
        (res) => {
          let buffer = '';
          let failure: string | undefined;

          const handleLine = (line: string) => {
            if (!line.trim()) {
              return;
            }

            try {
              const progress = JSON.parse(line) as PullProgress;

              if (progress.error || progress.errorDetail?.message) {
                failure = progress.errorDetail?.message ?? progress.error;
              }
              onProgress?.(progress);
            } catch {
              // A partial or odd line, the next one carries on
            }
          };

          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            buffer += chunk;
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            lines.forEach(handleLine);
          });
          res.on('end', () => {
            handleLine(buffer);

            if ((res.statusCode ?? 0) >= 400 || failure) {
              reject(
                new DockerError(
                  failure ?? `Docker answered ${res.statusCode} to the pull.`,
                  res.statusCode
                )
              );
              return;
            }

            resolve();
          });
          res.on('error', reject);
        }
      );

      req.on('error', (e) => reject(new DockerError(e.message)));
      req.end();
    });
  }

  public async createContainer(
    name: string,
    body: Record<string, unknown>
  ): Promise<string> {
    const data = await this.call<{ Id?: string }>(
      'POST',
      `/containers/create?name=${encodeURIComponent(name)}`,
      body
    );

    if (!data?.Id) {
      throw new DockerError('Docker did not return the new container.');
    }

    return data.Id;
  }

  public async startContainer(id: string): Promise<void> {
    await this.call(
      'POST',
      `/containers/${encodeURIComponent(id)}/start`,
      undefined,
      // Starting with a GPU runtime can take a while
      { timeout: 60000 }
    );
  }

  public async removeContainer(id: string): Promise<void> {
    await this.call(
      'DELETE',
      `/containers/${encodeURIComponent(id)}?force=true`,
      undefined,
      { timeout: 60000 }
    );
  }
}

export default DockerAPI;
