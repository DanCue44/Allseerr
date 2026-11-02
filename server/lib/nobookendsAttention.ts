import type {
  ChaptarrMediaType,
  ChaptarrQueueItem,
} from '@server/api/servarr/chaptarr';
import ChaptarrAPI from '@server/api/servarr/chaptarr';
import { usesChaptarr } from '@server/constants/bookService';
import type { User } from '@server/entity/User';
import { ArrActionError, searchAgain } from '@server/lib/arrActions';
import type { ChaptarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import {
  findStuckBookMedia,
  getStuckBookDetails,
  stuckDownloadMonitor,
} from '@server/lib/stuckBookDownloads';
import {
  STUCK_GRACE_MS,
  getStatusMessages,
  getStuckKey,
  getStuckReason,
} from '@server/lib/stuckDownloads';
import logger from '@server/logger';
import { uniqWith } from 'lodash';

const LOG_LABEL = 'NoBookEnds';

// The list reads Chaptarr's queue, so a screen that refreshes often does not
// ask Chaptarr each time
export const ATTENTION_CACHE_MS = 15 * 1000;

/**
 * A book download Chaptarr cannot finish by itself, as the "Download Needs
 * Attention" notification reports it
 */
export interface NoBookEndsAttentionItem {
  // Identifies the download for the dismiss endpoint
  key: string;
  mediaId: number | null;
  olId: string | null;
  title: string;
  author: string | null;
  format: ChaptarrMediaType | null;
  // What Chaptarr says is wrong, its first status message
  reason: string | null;
  // Why it counts as stuck, such as importblocked or warning
  state: string;
  // When Allseerr first saw it stuck
  since: string;
  // The release in the download client
  downloadTitle: string;
  requesters: string[];
  // The download finished but its import is stuck: retrying the import
  // brings the book in without downloading it again
  canRetryImport: boolean;
}

interface ChaptarrServerGroup {
  server: ChaptarrSettings;
  serverIds: number[];
}

/**
 * The Chaptarr servers the download tracker watches, one per address, with
 * the ids of every server setting that points at it
 */
const getChaptarrServers = (): ChaptarrServerGroup[] => {
  const settings = getSettings();

  if (!usesChaptarr(settings.bookService)) {
    return [];
  }

  const sameAddress = (a: ChaptarrSettings, b: ChaptarrSettings) =>
    a.hostname === b.hostname && a.port === b.port && a.baseUrl === b.baseUrl;

  return uniqWith(settings.chaptarr, sameAddress)
    .filter((server) => server.syncEnabled)
    .map((server) => ({
      server,
      serverIds: settings.chaptarr
        .filter((other) => sameAddress(other, server))
        .map((other) => other.id),
    }));
};

const getChaptarr = (server: ChaptarrSettings) =>
  new ChaptarrAPI({
    apiKey: server.apiKey,
    url: ChaptarrAPI.buildUrl(server, '/api/v1'),
  });

/**
 * The stuck downloads in one server's queue, keyed like the notification.
 * Downloads stuck for less than the grace period are left out, as they may
 * still import by themselves.
 */
const findStuck = (
  server: ChaptarrSettings,
  queue: ChaptarrQueueItem[],
  now: number
) =>
  queue.flatMap((item) => {
    const reason = getStuckReason(item);

    if (!reason) {
      return [];
    }

    const key = getStuckKey(`chaptarr:${server.id}`, item, reason);
    const entry = stuckDownloadMonitor.getEntry(key);

    if (!entry || now - entry.firstSeen < STUCK_GRACE_MS) {
      return [];
    }

    return [{ item, key, reason, since: entry.firstSeen }];
  });

const canRetryImport = (item: ChaptarrQueueItem) =>
  !!item.downloadId &&
  /importblocked|importfailed/i.test(item.trackedDownloadState ?? '');

let cache: { at: number; items: NoBookEndsAttentionItem[] } | undefined;

export const clearAttentionCache = (): void => {
  cache = undefined;
};

/**
 * The book downloads that need an admin, newest first. Each Chaptarr queue
 * is read live and the books are looked up in the app; a server that does
 * not answer is left out.
 */
export const getAttentionItems = async (
  now = Date.now()
): Promise<NoBookEndsAttentionItem[]> => {
  if (cache && now - cache.at < ATTENTION_CACHE_MS) {
    return cache.items;
  }

  const groups = await Promise.all(
    getChaptarrServers().map(async ({ server, serverIds }) => {
      const chaptarr = getChaptarr(server);

      try {
        const stuck = findStuck(server, await chaptarr.getBookQueue(), now);

        return await Promise.all(
          stuck.map(async ({ item, key, reason, since }) => {
            const details = await getStuckBookDetails(
              server,
              serverIds,
              chaptarr,
              { item, key, reason, messages: getStatusMessages(item) }
            );

            return {
              key,
              mediaId: details.media?.id ?? null,
              olId: details.media?.olId ?? null,
              title: details.title,
              author: details.authorName ?? null,
              format: details.format ?? null,
              reason: details.statusMessage ?? null,
              state: reason,
              since: new Date(since).toISOString(),
              downloadTitle: item.title,
              requesters: details.requesters,
              canRetryImport: canRetryImport(item),
            };
          })
        );
      } catch (e) {
        logger.warn('Unable to list the stuck downloads of a Chaptarr server', {
          label: LOG_LABEL,
          server: server.name,
          errorMessage: e.message,
        });
        return [];
      }
    })
  );

  const items = groups
    .flat()
    .sort(
      (a, b) => b.since.localeCompare(a.since) || a.key.localeCompare(b.key)
    );

  cache = { at: now, items };
  return items;
};

export interface NoBookEndsRetryImportResult {
  // The book came in and the download left the queue
  imported: boolean;
  // Still importing when Allseerr stopped waiting
  pending?: boolean;
  // Why the import is still stuck
  message?: string;
}

/**
 * The stuck download a key names, from its server's live queue
 */
const findAttentionDownload = async (key: string) => {
  const serverId = Number(key.match(/^chaptarr:(\d+):/)?.[1]);
  const group = getChaptarrServers().find(({ serverIds }) =>
    serverIds.includes(serverId)
  );

  if (!group) {
    throw new ArrActionError(404, 'This download is not in Chaptarr.');
  }

  const chaptarr = getChaptarr(group.server);
  const scope = `chaptarr:${serverId}`;
  const found = (await chaptarr.getBookQueue()).find((item) => {
    const reason = getStuckReason(item);

    return !!reason && getStuckKey(scope, item, reason) === key;
  });

  if (!found) {
    throw new ArrActionError(404, 'This download is no longer stuck.');
  }

  return { group, chaptarr, found };
};

/**
 * Has Chaptarr or Talearr try a stuck import again, for a download that
 * finished but could not be imported (such as one whose book changed after
 * the grab). Nothing is downloaded again.
 */
export const retryAttentionImport = async (
  key: string,
  user: User
): Promise<NoBookEndsRetryImportResult> => {
  const { chaptarr, found } = await findAttentionDownload(key);

  if (!canRetryImport(found) || !found.downloadId) {
    throw new ArrActionError(
      409,
      'This download has no stuck import to retry. Remove it and search again instead.'
    );
  }

  const downloadId = found.downloadId;
  const result = await chaptarr.retryImport(downloadId);
  clearAttentionCache();

  logger.info('Retried the import of a stuck book download', {
    label: LOG_LABEL,
    title: found.title,
    userId: user.id,
    finished: result.finished,
    error: result.error,
  });

  if (!result.finished) {
    return { imported: false, pending: true };
  }

  const after = (await chaptarr.getBookQueue()).find(
    (item) => item.downloadId === downloadId
  );

  if (!after) {
    return { imported: true };
  }

  return {
    imported: false,
    message: result.error || getStatusMessages(after)[0] || undefined,
  };
};

export interface NoBookEndsDismissResult {
  removed: boolean;
  blocklisted: boolean;
  searched: boolean;
  // Why the new search could not be started, the download is gone anyway
  searchError?: string;
}

/**
 * Removes a stuck download from Chaptarr's queue and its download client,
 * blocklisting its release unless told not to, then searches for the
 * book's format again the way the admin search action does
 */
export const dismissAttentionItem = async (
  key: string,
  user: User,
  { blocklist = true }: { blocklist?: boolean } = {}
): Promise<NoBookEndsDismissResult> => {
  const { group, chaptarr, found } = await findAttentionDownload(key);
  const { serverIds } = group;

  await chaptarr.removeQueueItem(found.id, { blocklist });
  clearAttentionCache();

  logger.info('Removed a stuck book download', {
    label: LOG_LABEL,
    title: found.title,
    blocklist,
    userId: user.id,
  });

  const result: NoBookEndsDismissResult = {
    removed: true,
    blocklisted: blocklist,
    searched: false,
  };

  if (!found.bookId) {
    result.searchError = 'Chaptarr does not say which book this was.';
    return result;
  }

  try {
    const book = await findStuckBookMedia(serverIds, found.bookId);
    const format = found.book?.mediaType ?? book?.format;

    if (book && format) {
      // Readies books monitored only for a request before searching
      await searchAgain(book.media, { bookFormat: format }, user);
    } else {
      await chaptarr.searchBooks([found.bookId]);
    }

    result.searched = true;
  } catch (e) {
    logger.warn('Removed a stuck book download but could not search again', {
      label: LOG_LABEL,
      title: found.title,
      errorMessage: e.message,
    });
    result.searchError = e.message;
  }

  return result;
};
