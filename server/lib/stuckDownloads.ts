import type { ServarrStatusMessage } from '@server/api/servarr/base';
import logger from '@server/logger';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Notices downloads that are stuck in an arr's queue, such as a finished
 * download that could not be imported. Only the queue fields the arrs share
 * are read, so the same check fits Chaptarr, Lidarr, Radarr and Sonarr.
 */

// States an arr leaves a download in when it needs someone to step in
export const STUCK_STATES = [
  'importblocked',
  'importfailed',
  'failedpending',
  'failed',
];

// Statuses that need attention when the arr says why
export const PROBLEM_STATUSES = ['warning', 'error'];

// Downloads pass through warnings while they import normally, so a download
// has to stay stuck this long before anyone is told
export const STUCK_GRACE_MS = 10 * 60 * 1000;

export interface TrackedQueueItem {
  id: number;
  downloadId?: string;
  trackedDownloadStatus?: string;
  trackedDownloadState?: string;
  statusMessages?: ServarrStatusMessage[];
  errorMessage?: string;
}

export interface StuckDownload<T extends TrackedQueueItem> {
  item: T;
  key: string;
  reason: string;
  messages: string[];
}

/**
 * What the arr says is wrong with a download: the messages of each status
 * message, its title when it has none, then the download's error message
 */
export const getStatusMessages = (item: TrackedQueueItem): string[] => {
  const messages = (item.statusMessages ?? []).flatMap((statusMessage) => {
    const lines = (statusMessage.messages ?? [])
      .map((message) => message?.trim())
      .filter((message): message is string => !!message);

    if (lines.length > 0) {
      return lines;
    }

    const title = statusMessage.title?.trim();
    return title ? [title] : [];
  });

  const errorMessage = item.errorMessage?.trim();

  if (errorMessage && !messages.includes(errorMessage)) {
    messages.push(errorMessage);
  }

  // Bare codes such as IMPORT_EXCEPTION say nothing when the arr also sent
  // the reason in words
  const readable = messages
    .filter((message) => !STATUS_CODE.test(message))
    // "ModelNotFoundException: Edition with ID 1 does not exist" reads as
    // the sentence alone
    .map((message) => message.replace(EXCEPTION_PREFIX, ''));

  return readable.length > 0 ? readable : messages;
};

const STATUS_CODE = /^[A-Z][A-Z0-9_]+$/;
const EXCEPTION_PREFIX = /^[A-Za-z.]*Exception:\s*/;

/**
 * Why a download is stuck (its state, or its status when the arr says why),
 * or undefined while it is fine
 */
export const getStuckReason = (item: TrackedQueueItem): string | undefined => {
  const state = item.trackedDownloadState?.toLowerCase();

  if (state && STUCK_STATES.includes(state)) {
    return state;
  }

  const status = item.trackedDownloadStatus?.toLowerCase();

  if (
    status &&
    PROBLEM_STATUSES.includes(status) &&
    getStatusMessages(item).length > 0
  ) {
    return status;
  }

  return undefined;
};

/**
 * The key a stuck download is remembered by: the server scope, such as
 * "chaptarr:0", the download id (or queue id) and why it is stuck
 */
export const getStuckKey = (
  scope: string,
  item: TrackedQueueItem,
  reason: string
): string => `${scope}:${item.downloadId || item.id}:${reason}`;

export interface StuckDownloadEntry {
  // When the download was first seen stuck for this reason, in ms
  firstSeen: number;
  notified?: boolean;
}

export type StuckDownloadEntries = Record<string, StuckDownloadEntry>;

export interface StuckDownloadStore {
  load(): StuckDownloadEntries;
  save(entries: StuckDownloadEntries): void;
}

/**
 * Keeps the stuck downloads in a small JSON file in the config directory,
 * so a restart neither repeats a notification nor restarts the grace period
 */
export const createFileStore = (filePath: string): StuckDownloadStore => ({
  load() {
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return data && typeof data === 'object' && !Array.isArray(data)
        ? data
        : {};
    } catch (e) {
      if (e.code !== 'ENOENT') {
        logger.warn('Unable to read the stuck downloads file', {
          label: 'Stuck Downloads',
          errorMessage: e.message,
        });
      }
      return {};
    }
  },
  save(entries) {
    try {
      fs.writeFileSync(filePath, JSON.stringify(entries));
    } catch (e) {
      logger.warn('Unable to save the stuck downloads file', {
        label: 'Stuck Downloads',
        errorMessage: e.message,
      });
    }
  },
});

export const STUCK_DOWNLOADS_PATH = process.env.CONFIG_DIRECTORY
  ? `${process.env.CONFIG_DIRECTORY}/stuck-downloads.json`
  : path.join(__dirname, '../../config/stuck-downloads.json');

/**
 * Remembers since when each download of each server has been stuck, and
 * hands out each one once it has been stuck past the grace period. A
 * download is keyed on its download id and why it is stuck, so a download
 * that gets stuck in a new way is reported again. Downloads that leave the
 * queue, or are no longer stuck, are forgotten.
 */
export class StuckDownloadMonitor {
  private entries?: StuckDownloadEntries;

  public constructor(
    private store: StuckDownloadStore,
    private graceMs = STUCK_GRACE_MS
  ) {}

  /**
   * Takes the whole queue of one server, such as "chaptarr:0", and returns
   * the downloads to report now. They are marked as reported.
   */
  public update<T extends TrackedQueueItem>(
    scope: string,
    items: T[],
    now = Date.now()
  ): StuckDownload<T>[] {
    const entries = this.load();
    const prefix = `${scope}:`;
    const seen = new Set<string>();
    const due: StuckDownload<T>[] = [];
    let changed = false;

    for (const item of items) {
      const reason = getStuckReason(item);

      if (!reason) {
        continue;
      }

      const key = getStuckKey(scope, item, reason);

      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      let entry = entries[key];

      if (!entry) {
        entry = { firstSeen: now };
        entries[key] = entry;
        changed = true;
      }

      if (!entry.notified && now - entry.firstSeen >= this.graceMs) {
        entry.notified = true;
        changed = true;
        due.push({ item, key, reason, messages: getStatusMessages(item) });
      }
    }

    for (const key of Object.keys(entries)) {
      if (key.startsWith(prefix) && !seen.has(key)) {
        delete entries[key];
        changed = true;
      }
    }

    if (changed) {
      this.store.save(entries);
    }

    return due;
  }

  /**
   * Since when a download has been stuck, or undefined when it is not
   * known to be
   */
  public getEntry(key: string): StuckDownloadEntry | undefined {
    return this.load()[key];
  }

  public reset(): void {
    this.entries = {};
    this.store.save(this.entries);
  }

  private load(): StuckDownloadEntries {
    if (!this.entries) {
      this.entries = this.store.load();
    }

    return this.entries;
  }
}
