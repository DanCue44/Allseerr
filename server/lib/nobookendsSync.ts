import type { NoBookEndsSyncPriority } from '@server/api/nobookendsSync';
import NoBookEndsSyncAPI, {
  MAX_BULK_PAIRS,
  getNoBookEndsSyncReason,
} from '@server/api/nobookendsSync';
import { MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import type { NoBookEndsSyncSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { runInBackground } from '@server/utils/backgroundTasks';
import { isAxiosError } from 'axios';
import { IsNull, Not } from 'typeorm';

/**
 * NoBookEnds Sync is a separate server that aligns an Audiobookshelf
 * audiobook to the EPUB of the same book, so the NoBookEnds app can
 * highlight the words being read. Allseerr knows when both formats of a
 * book are in the library, and queues the pair there right away instead
 * of waiting for the Sync server's own library poll.
 */

const trimUrl = (url?: string | null): string | undefined =>
  url?.trim().replace(/\/+$/, '') || undefined;

export interface NoBookEndsSyncTarget {
  url: string;
  adminToken: string;
}

/**
 * Where this server reaches the Sync server and the token it queues with,
 * or null while the integration is off or not set up
 */
export const getNoBookEndsSyncTarget = (
  settings: NoBookEndsSyncSettings = getSettings().nobookendsSync
): NoBookEndsSyncTarget | null => {
  const url = trimUrl(settings.internalUrl) ?? trimUrl(settings.url);
  const adminToken = settings.adminToken?.trim();

  if (!settings.enabled || !url || !adminToken) {
    return null;
  }

  return { url, adminToken };
};

// Where Allseerr serves the Sync server's reader API when it proxies it
export const NOBOOKENDS_SYNC_PROXY_PATH = '/api/v1/nbe-sync';

/**
 * Where Allseerr forwards the proxied reader API, or null while the
 * integration is off, does not proxy, or has no address
 */
export const getNoBookEndsSyncProxyTarget = (
  settings: NoBookEndsSyncSettings = getSettings().nobookendsSync
): string | null => {
  if (!settings.enabled || !settings.proxy) {
    return null;
  }

  return trimUrl(settings.internalUrl) ?? trimUrl(settings.url) ?? null;
};

/**
 * The proxied address under Allseerr's application URL, or undefined while
 * Allseerr does not proxy the Sync server or has no application URL
 */
export const getNoBookEndsSyncProxyUrl = (
  settings: NoBookEndsSyncSettings = getSettings().nobookendsSync,
  applicationUrl: string | undefined = getSettings().main.applicationUrl
): string | undefined => {
  const base = trimUrl(applicationUrl);

  return getNoBookEndsSyncProxyTarget(settings) && base
    ? `${base}${NOBOOKENDS_SYNC_PROXY_PATH}`
    : undefined;
};

/**
 * The public address the apps open, or undefined while the integration is
 * off or has no address. When Allseerr proxies the Sync server, that is the
 * proxied address.
 */
export const getNoBookEndsSyncPublicUrl = (
  settings: NoBookEndsSyncSettings = getSettings().nobookendsSync,
  applicationUrl: string | undefined = getSettings().main.applicationUrl
): string | undefined => {
  if (!settings.enabled) {
    return undefined;
  }

  if (getNoBookEndsSyncProxyTarget(settings)) {
    return getNoBookEndsSyncProxyUrl(settings, applicationUrl);
  }

  return trimUrl(settings.url);
};

/**
 * What the apps are told about the Sync server: its address when there is
 * one, and the proxy path when Allseerr serves it, which the app joins to
 * the Allseerr address it already uses (one without an application URL
 * set still works that way)
 */
export const getNoBookEndsSyncAppInfo = (
  settings: NoBookEndsSyncSettings = getSettings().nobookendsSync,
  applicationUrl: string | undefined = getSettings().main.applicationUrl
): { url?: string; proxyPath?: string } | undefined => {
  const url = getNoBookEndsSyncPublicUrl(settings, applicationUrl);
  const proxied = !!getNoBookEndsSyncProxyTarget(settings);

  if (!url && !proxied) {
    return undefined;
  }

  return {
    ...(url ? { url } : {}),
    ...(proxied ? { proxyPath: NOBOOKENDS_SYNC_PROXY_PATH } : {}),
  };
};

export interface NoBookEndsSyncPair {
  audioItemId: string;
  ebookItemId: string;
}

/**
 * The pair to align, once a book has both an audiobook and an ebook item
 */
export const getNoBookEndsSyncPair = (
  media: Pick<Media, 'absAudiobookItemId' | 'absEbookItemId'>
): NoBookEndsSyncPair | null =>
  media.absAudiobookItemId && media.absEbookItemId
    ? {
        audioItemId: media.absAudiobookItemId,
        ebookItemId: media.absEbookItemId,
      }
    : null;

// Waits before trying a pair again after the Sync server did not take it.
// After the last one the pair waits for the next change or a backfill.
export const RETRY_DELAYS_MS = [
  5 * 60 * 1000,
  30 * 60 * 1000,
  2 * 60 * 60 * 1000,
  6 * 60 * 60 * 1000,
  24 * 60 * 60 * 1000,
];

// Reasons the Sync server refuses a pair that a retry cannot change: an
// item is gone, or has no audio or no EPUB
export const PERMANENT_REASONS = ['not_found', 'no_audio', 'no_epub'];

interface QueueOptions {
  priority: NoBookEndsSyncPriority;
  source: string;
}

// Pairs found on import are queued like a reader's request, so they are
// aligned soon. The backfill is background work for the overnight window.
const IMPORT_OPTIONS: QueueOptions = { priority: 'user', source: 'allseerr' };
const BACKFILL_OPTIONS: QueueOptions = {
  priority: 'auto',
  source: 'allseerr-backfill',
};

const pairKey = ({ audioItemId, ebookItemId }: NoBookEndsSyncPair) =>
  `${audioItemId}:${ebookItemId}`;

// Pairs the Sync server took, and ones it refused for good, since this
// server started
const queuedPairs = new Set<string>();
const rejectedPairs = new Set<string>();
const inFlight = new Map<string, Promise<NoBookEndsSyncQueueResult>>();
const retries = new Map<
  string,
  { attempts: number; timer: ReturnType<typeof setTimeout> }
>();

/**
 * Forgets what was queued and stops the retries, for tests
 */
export const resetNoBookEndsSyncState = (): void => {
  queuedPairs.clear();
  rejectedPairs.clear();
  inFlight.clear();

  for (const { timer } of retries.values()) {
    clearTimeout(timer);
  }

  retries.clear();
};

export type NoBookEndsSyncQueueResult =
  | 'queued'
  | 'skipped'
  | 'rejected'
  | 'failed';

const clearRetry = (key: string) => {
  const retry = retries.get(key);

  if (retry) {
    clearTimeout(retry.timer);
    retries.delete(key);
  }
};

const scheduleRetry = (pair: NoBookEndsSyncPair, options: QueueOptions) => {
  const key = pairKey(pair);
  const attempts = (retries.get(key)?.attempts ?? 0) + 1;
  const delay = RETRY_DELAYS_MS[attempts - 1];

  clearRetry(key);

  if (delay === undefined) {
    logger.info('Gave up queueing a book on NoBookEnds Sync for now', {
      label: 'NoBookEnds Sync',
      ...pair,
    });
    return;
  }

  const timer = setTimeout(() => {
    runInBackground(queuePair(pair, { ...options, retry: true }));
  }, delay);
  // A pending retry never keeps the process alive
  timer.unref?.();
  retries.set(key, { attempts, timer });
};

const markQueued = (key: string) => {
  queuedPairs.add(key);
  rejectedPairs.delete(key);
  clearRetry(key);
};

const markRejected = (pair: NoBookEndsSyncPair, reason: string | undefined) => {
  const key = pairKey(pair);
  rejectedPairs.add(key);
  clearRetry(key);
  logger.info('NoBookEnds Sync cannot align a book', {
    label: 'NoBookEnds Sync',
    ...pair,
    reason,
  });
};

const queuePair = async (
  pair: NoBookEndsSyncPair,
  {
    force = false,
    retry = false,
    ...options
  }: QueueOptions & { force?: boolean; retry?: boolean }
): Promise<NoBookEndsSyncQueueResult> => {
  const target = getNoBookEndsSyncTarget();
  const key = pairKey(pair);

  if (!target) {
    // Turned off meanwhile, a later change or a backfill queues the pair
    clearRetry(key);
    return 'skipped';
  }

  if (!force && (queuedPairs.has(key) || rejectedPairs.has(key))) {
    return 'skipped';
  }

  try {
    const client = new NoBookEndsSyncAPI(target);
    const job = await client.queueAlignment(pair, options);

    markQueued(key);
    logger.info('Queued a book on NoBookEnds Sync', {
      label: 'NoBookEnds Sync',
      ...pair,
      priority: options.priority,
      status: job?.status,
    });

    return 'queued';
  } catch (e) {
    const reason = getNoBookEndsSyncReason(e);
    const status = isAxiosError(e) ? e.response?.status : undefined;

    if (
      (status === 404 || status === 422) &&
      reason &&
      PERMANENT_REASONS.includes(reason)
    ) {
      markRejected(pair, reason);
      return 'rejected';
    }

    // Everything else, Audiobookshelf being down (502 abs_unavailable) or
    // refusing the service key (502 abs_auth) included, may pass
    logger.debug('Failed to queue a book on NoBookEnds Sync', {
      label: 'NoBookEnds Sync',
      ...pair,
      retry,
      status,
      reason,
      errorMessage: e.message,
    });

    if (!retry || retries.has(key)) {
      scheduleRetry(pair, options);
    }

    return 'failed';
  }
};

/**
 * Queues a pair on the Sync server unless it was queued or refused before.
 * Calls for a pair already on its way share the one request. A pair the
 * server could not take is tried again later, one it refused for good
 * (an item gone, or without audio or EPUB) is not. With force the pair is
 * sent anyway, the Sync server ignoring pairs it already has.
 */
export const queueNoBookEndsSyncPair = (
  pair: NoBookEndsSyncPair,
  options: { force?: boolean } & Partial<QueueOptions> = {}
): Promise<NoBookEndsSyncQueueResult> => {
  const key = pairKey(pair);
  const running = inFlight.get(key);

  if (running) {
    return running;
  }

  const task = queuePair(pair, { ...IMPORT_OPTIONS, ...options }).finally(
    () => {
      inFlight.delete(key);
    }
  );
  inFlight.set(key, task);

  return task;
};

/**
 * Called when the Audiobookshelf items of a book changed. Once it has both
 * an audiobook and an ebook, the pair is queued without waiting for it.
 */
export const onAudiobookshelfItemIdsChanged = (
  media: Pick<Media, 'id' | 'absAudiobookItemId' | 'absEbookItemId'>
): void => {
  const pair = getNoBookEndsSyncPair(media);

  if (!pair || !getNoBookEndsSyncTarget()) {
    return;
  }

  logger.debug('A book has an audiobook and an ebook, queueing it for sync', {
    label: 'NoBookEnds Sync',
    mediaId: media.id,
    ...pair,
  });
  runInBackground(queueNoBookEndsSyncPair(pair));
};

export interface NoBookEndsSyncBackfillResult {
  // Books with both items
  total: number;
  // Taken by the Sync server (new, or already queued or aligned)
  accepted: number;
  // Refused for good: an item gone, or without audio or EPUB
  rejected: number;
  // Not taken this time, tried again later
  failed: number;
}

/**
 * Sends a chunk of pairs in one bulk call. A Sync server from before bulk
 * calls refuses the body without a reason, then the pairs go one by one.
 */
const backfillChunk = async (
  client: NoBookEndsSyncAPI,
  chunk: NoBookEndsSyncPair[],
  result: NoBookEndsSyncBackfillResult
): Promise<void> => {
  try {
    const response = await client.queueAlignments(chunk, BACKFILL_OPTIONS);

    response.results.forEach((item, index) => {
      const pair = chunk[index];

      if (!pair) {
        return;
      }

      if (item.ok) {
        markQueued(pairKey(pair));
        result.accepted++;
      } else if (item.reason && PERMANENT_REASONS.includes(item.reason)) {
        markRejected(pair, item.reason);
        result.rejected++;
      } else {
        result.failed++;
        scheduleRetry(pair, BACKFILL_OPTIONS);
      }
    });
  } catch (e) {
    const status = isAxiosError(e) ? e.response?.status : undefined;

    if (status === 422 && !getNoBookEndsSyncReason(e)) {
      for (const pair of chunk) {
        const outcome = await queueNoBookEndsSyncPair(pair, {
          ...BACKFILL_OPTIONS,
          force: true,
        });

        if (outcome === 'queued') {
          result.accepted++;
        } else if (outcome === 'rejected') {
          result.rejected++;
        } else if (outcome === 'failed') {
          result.failed++;
        }
      }
      return;
    }

    logger.debug('Failed to queue a chunk of books on NoBookEnds Sync', {
      label: 'NoBookEnds Sync',
      pairs: chunk.length,
      status,
      reason: getNoBookEndsSyncReason(e),
      errorMessage: e.message,
    });

    for (const pair of chunk) {
      result.failed++;
      scheduleRetry(pair, BACKFILL_OPTIONS);
    }
  }
};

/**
 * Queues every book that has both an audiobook and an ebook item as
 * background work, which the Sync server runs in its overnight window.
 * Pairs queued before are sent again, the Sync server leaving alone what it
 * has, in bulk calls of at most MAX_BULK_PAIRS pairs.
 */
export const backfillNoBookEndsSync =
  async (): Promise<NoBookEndsSyncBackfillResult> => {
    const result: NoBookEndsSyncBackfillResult = {
      total: 0,
      accepted: 0,
      rejected: 0,
      failed: 0,
    };
    const target = getNoBookEndsSyncTarget();

    if (!target) {
      return result;
    }

    const media = await getRepository(Media).find({
      select: ['id', 'absAudiobookItemId', 'absEbookItemId'],
      where: {
        mediaType: MediaType.BOOK,
        absAudiobookItemId: Not(IsNull()),
        absEbookItemId: Not(IsNull()),
      },
      order: { id: 'ASC' },
    });
    const pairs = new Map<string, NoBookEndsSyncPair>();

    for (const item of media) {
      const pair = getNoBookEndsSyncPair(item);

      if (pair) {
        pairs.set(pairKey(pair), pair);
      }
    }

    const queue = [...pairs.values()];
    const client = new NoBookEndsSyncAPI(target);
    result.total = queue.length;

    for (let start = 0; start < queue.length; start += MAX_BULK_PAIRS) {
      await backfillChunk(
        client,
        queue.slice(start, start + MAX_BULK_PAIRS),
        result
      );
    }

    logger.info('Queued the books with both formats on NoBookEnds Sync', {
      label: 'NoBookEnds Sync',
      ...result,
    });

    return result;
  };
