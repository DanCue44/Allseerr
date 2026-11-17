import {
  assertServiceAvailable,
  getServiceKey,
  getStaleAnswer,
  recordServiceFailure,
  recordServiceSuccess,
  rememberStaleAnswer,
} from '@server/api/externalApiHealth';
import type { CacheStore } from '@server/lib/cache';
import logger from '@server/logger';
import { proxyRequestInterceptor } from '@server/utils/customProxyAgent';
import { userAgentRequestInterceptor } from '@server/utils/userAgent';
import type { AxiosInstance, AxiosRequestConfig } from 'axios';
import axios from 'axios';
import rateLimit from 'axios-rate-limit';

// 5 minute default TTL (in seconds)
const DEFAULT_TTL = 300;

// 10 seconds default rolling buffer (in ms)
const DEFAULT_ROLLING_BUFFER = 10000;

export interface ExternalAPIOptions {
  nodeCache?: CacheStore;
  headers?: Record<string, unknown>;
  timeout?: number;
  rateLimit?: {
    maxRPS?: number;
    maxRequests: number;
    // Window for maxRequests when maxRPS is not set, in milliseconds
    perMilliseconds?: number;
  };
  // For public catalogs (TMDB, OpenLibrary, MusicBrainz and the like): pause
  // requests while the service is down so pages fail at once, and serve the
  // last good answer for up to a week meanwhile. Never for per-user or local
  // services, where a paused connection test would be confusing.
  publicCatalog?: boolean;
}

class ExternalAPI {
  protected axios: AxiosInstance;
  private baseUrl: string;
  private cache?: CacheStore;
  private service: string;
  private publicCatalog: boolean;

  constructor(
    baseUrl: string,
    params: Record<string, unknown>,
    options: ExternalAPIOptions = {}
  ) {
    this.axios = axios.create({
      baseURL: baseUrl,
      params,
      timeout: options.timeout,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...options.headers,
      },
    });
    this.axios.interceptors.request.use(proxyRequestInterceptor);
    this.axios.interceptors.request.use(userAgentRequestInterceptor);
    this.service = getServiceKey(baseUrl);
    this.publicCatalog = options.publicCatalog ?? false;

    if (this.publicCatalog) {
      // Registered before the rate limiter, so it runs after a queued
      // request's wait: requests queued before the service went down fail at
      // once
      this.axios.interceptors.request.use((config) => {
        assertServiceAvailable(this.service);
        return config;
      });
      this.axios.interceptors.response.use(
        (response) => {
          recordServiceSuccess(this.service);
          return response;
        },
        (error) => {
          recordServiceFailure(this.service, error);
          return Promise.reject(error);
        }
      );
    }

    if (options.rateLimit) {
      this.axios = rateLimit(this.axios, {
        maxRequests: options.rateLimit.maxRequests,
        maxRPS: options.rateLimit.maxRPS,
        perMilliseconds: options.rateLimit.perMilliseconds,
      });
    }

    this.baseUrl = baseUrl;
    this.cache = options.nodeCache;
  }

  /**
   * Fetches through the service health check, falling back to the last good
   * answer when the client allows it
   */
  private async fetchWithFallback<T>(
    cacheKey: string,
    request: () => Promise<T>
  ): Promise<T> {
    if (!this.publicCatalog) {
      return request();
    }

    try {
      assertServiceAvailable(this.service);
      const data = await request();
      rememberStaleAnswer(cacheKey, data);

      return data;
    } catch (e) {
      const stale = getStaleAnswer<T>(cacheKey);

      if (stale !== undefined) {
        return stale;
      }

      throw e;
    }
  }

  // transform runs before the cache write.
  protected async get<T>(
    endpoint: string,
    config?: AxiosRequestConfig,
    ttl?: number,
    options?: { cache?: CacheStore; transform?: (data: T) => T }
  ): Promise<T> {
    const cache = options?.cache ?? this.cache;
    const cacheKey = this.serializeCacheKey(endpoint, {
      ...config?.params,
      headers: config?.headers,
    });
    const cachedItem = cache?.get<T>(cacheKey);
    if (cachedItem) {
      return cachedItem;
    }

    const data = await this.fetchWithFallback(cacheKey, async () => {
      const response = await this.axios.get<T>(endpoint, config);
      return options?.transform
        ? options.transform(response.data)
        : response.data;
    });

    if (cache && ttl !== 0) {
      cache.set(cacheKey, data, ttl ?? DEFAULT_TTL);
    }

    return data;
  }

  protected async post<T>(
    endpoint: string,
    data?: Record<string, unknown>,
    config?: AxiosRequestConfig,
    ttl?: number
  ): Promise<T> {
    const cacheKey = this.serializeCacheKey(endpoint, {
      config: config?.params,
      ...(data ? { data } : {}),
    });

    const cachedItem = this.cache?.get<T>(cacheKey);
    if (cachedItem) {
      return cachedItem;
    }

    const responseData = await this.fetchWithFallback(
      cacheKey,
      async () => (await this.axios.post<T>(endpoint, data, config)).data
    );

    if (this.cache && ttl !== 0) {
      this.cache.set(cacheKey, responseData, ttl ?? DEFAULT_TTL);
    }

    return responseData;
  }

  protected async getRolling<T>(
    endpoint: string,
    config?: AxiosRequestConfig,
    ttl?: number
  ): Promise<T> {
    const cacheKey = this.serializeCacheKey(endpoint, {
      ...config?.params,
      headers: config?.headers,
    });
    const cachedItem = this.cache?.get<T>(cacheKey);

    if (cachedItem) {
      const keyTtl = this.cache?.getTtl(cacheKey) ?? 0;

      // If the item has passed our rolling check, fetch again in background
      if (
        keyTtl - (ttl ?? DEFAULT_TTL) * 1000 <
        Date.now() - DEFAULT_ROLLING_BUFFER
      ) {
        this.fetchWithFallback(
          cacheKey,
          async () => (await this.axios.get<T>(endpoint, config)).data
        )
          .then((data) => {
            this.cache?.set(cacheKey, data, ttl ?? DEFAULT_TTL);
          })
          // The cached answer was already returned, a failed refresh keeps it.
          // Only the address is logged: the request config holds credentials
          .catch((e) => {
            logger.warn('Failed to refresh cached response in background', {
              label: 'External API',
              baseUrl: e?.config?.baseURL ?? this.axios.defaults.baseURL,
              endpoint,
              errorMessage: e?.message,
            });
          });
      }
      return cachedItem;
    }

    const data = await this.fetchWithFallback(
      cacheKey,
      async () => (await this.axios.get<T>(endpoint, config)).data
    );

    if (this.cache && ttl !== 0) {
      this.cache.set(cacheKey, data, ttl ?? DEFAULT_TTL);
    }

    return data;
  }

  protected removeCache(endpoint: string, options?: Record<string, unknown>) {
    const cacheKey = this.serializeCacheKey(endpoint, {
      ...options,
    });
    this.cache?.del(cacheKey);
  }

  private serializeCacheKey(
    endpoint: string,
    options?: Record<string, unknown>
  ) {
    if (!options) {
      return `${this.baseUrl}${endpoint}`;
    }

    return `${this.baseUrl}${endpoint}${JSON.stringify(options)}`;
  }
}

export default ExternalAPI;
