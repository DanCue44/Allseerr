import type { TracearrSettings } from '@server/lib/settings';
import { proxyRequestInterceptor } from '@server/utils/customProxyAgent';
import { userAgentRequestInterceptor } from '@server/utils/userAgent';
import type { AxiosInstance } from 'axios';
import axios from 'axios';

/*
 * Tracearr's public API, version 2 (Tracearr 3.x). Every call carries the
 * key made under Settings > Data & API > API as a Bearer token. Shapes
 * follow the published OpenAPI document (GET /api/v2/public/docs).
 */

interface CursorMeta {
  nextCursor: string | null;
  pageSize: number;
}

export interface TracearrServersResponse {
  data: {
    server_id: string;
    server_name: string;
    status: string;
  }[];
  tracearr_version: string;
}

export interface TracearrAccount {
  server_id: string;
  server_type: string;
  server_user_id: string;
  /** Plex numeric account id, or the Jellyfin / Emby user GUID */
  external_user_id: string;
  username: string;
  removed_at: string | null;
}

export interface TracearrIdentity {
  id: string;
  username: string;
  identity_name: string | null;
  email: string | null;
  plex_account_id: string | null;
  accounts: TracearrAccount[];
}

interface StatWindow {
  plays: number;
  watch_time_ms: number;
}

export interface TracearrUserStats {
  user_id: string;
  windows: {
    all_time: StatWindow;
    last_30: StatWindow;
    last_7: StatWindow;
  };
}

export interface TracearrHistoryRecord {
  id: string;
  media_type: string;
  media_title: string;
  show_title: string | null;
  started_at: string;
  watched: boolean;
  media_id: string | null;
  show_media_id: string | null;
  imdb_id: string | null;
  tmdb_id: number | null;
  tvdb_id: number | null;
  rating_key: string | null;
  parent_rating_key: string | null;
  grandparent_rating_key: string | null;
}

interface MediaStatWindow {
  combined: StatWindow & { unique_users: number };
}

export interface TracearrMediaStats {
  media_id: string;
  media_type: string;
  windows: {
    all_time: MediaStatWindow;
    last_30: MediaStatWindow;
    last_7: MediaStatWindow;
  };
}

export interface TracearrWatcher {
  user: {
    server_user_id: string;
    /** Tracearr identity id */
    user_id: string;
    username: string | null;
    identity_name: string | null;
  };
  plays: number;
  watch_time_ms: number;
}

interface TracearrWatchersResponse {
  media_id: string;
  media_type: string;
  window: string;
  watchers: TracearrWatcher[];
}

/** Pages read at most when looking a person up, 100 identities each */
const MAX_USER_PAGES = 50;

/** Jellyfin and Emby write the same GUID with and without dashes */
export const normalizeExternalId = (id: string | number): string =>
  String(id).replace(/-/g, '').toLowerCase();

/** The `ref` Tracearr resolves a TMDB title by */
export const tracearrMediaRef = (
  mediaType: 'movie' | 'tv',
  tmdbId: number
): string => `${mediaType === 'movie' ? 'movie' : 'show'}:tmdb:${tmdbId}`;

export const isTracearrConfigured = (settings?: TracearrSettings): boolean =>
  !!settings?.url && !!settings.apiKey;

class TracearrAPI {
  private axios: AxiosInstance;

  constructor(settings: TracearrSettings) {
    this.axios = axios.create({
      baseURL: (settings.url ?? '').replace(/\/+$/, ''),
      headers: { Authorization: `Bearer ${settings.apiKey}` },
      timeout: 10000,
    });
    this.axios.interceptors.request.use(proxyRequestInterceptor);
    this.axios.interceptors.request.use(userAgentRequestInterceptor);
  }

  /** Answers with the Tracearr version; used to test the connection */
  public async getServers(): Promise<TracearrServersResponse> {
    return (
      await this.axios.get<TracearrServersResponse>('/api/v2/public/servers')
    ).data;
  }

  public async getIdentity(id: string): Promise<TracearrIdentity> {
    return (
      await this.axios.get<TracearrIdentity>(
        `/api/v2/public/users/${encodeURIComponent(id)}`
      )
    ).data;
  }

  /**
   * The Tracearr identity that owns a media server account, matched on the
   * server's own user id (the stable key Tracearr documents for this)
   */
  public async findIdentity(
    externalIds: (string | number | null | undefined)[]
  ): Promise<TracearrIdentity | undefined> {
    const wanted = new Set(
      externalIds
        .filter((id): id is string | number => id != null && id !== '')
        .map(normalizeExternalId)
    );

    if (wanted.size === 0) {
      return undefined;
    }

    let cursor: string | undefined;

    for (let page = 0; page < MAX_USER_PAGES; page++) {
      const response = (
        await this.axios.get<{ data: TracearrIdentity[]; meta: CursorMeta }>(
          '/api/v2/public/users',
          { params: { pageSize: 100, ...(cursor ? { cursor } : {}) } }
        )
      ).data;

      const match = response.data.find((identity) =>
        identity.accounts.some((account) =>
          wanted.has(normalizeExternalId(account.external_user_id))
        )
      );

      if (match) {
        return match;
      }

      if (!response.meta?.nextCursor) {
        return undefined;
      }
      cursor = response.meta.nextCursor;
    }

    return undefined;
  }

  public async getUserStats(identityId: string): Promise<TracearrUserStats> {
    return (
      await this.axios.get<TracearrUserStats>(
        `/api/v2/public/users/${encodeURIComponent(identityId)}/stats`
      )
    ).data;
  }

  public async getUserHistory(
    identityId: string,
    pageSize = 100
  ): Promise<TracearrHistoryRecord[]> {
    return (
      await this.axios.get<{ data: TracearrHistoryRecord[] }>(
        `/api/v2/public/users/${encodeURIComponent(identityId)}/history`,
        { params: { pageSize } }
      )
    ).data.data;
  }

  /** Undefined when Tracearr has never seen the title */
  public async getMediaStats(
    ref: string
  ): Promise<TracearrMediaStats | undefined> {
    try {
      return (
        await this.axios.get<TracearrMediaStats>(
          `/api/v2/public/media/${ref}/stats`
        )
      ).data;
    } catch (e) {
      if (e.response?.status === 404) {
        return undefined;
      }
      throw e;
    }
  }

  public async getMediaWatchers(ref: string): Promise<TracearrWatcher[]> {
    try {
      return (
        await this.axios.get<TracearrWatchersResponse>(
          `/api/v2/public/media/${ref}/watchers`
        )
      ).data.watchers;
    } catch (e) {
      if (e.response?.status === 404) {
        return [];
      }
      throw e;
    }
  }
}

export default TracearrAPI;
