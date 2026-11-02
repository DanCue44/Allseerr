import type {
  StuckDownloadEntries,
  StuckDownloadStore,
  TrackedQueueItem,
} from '@server/lib/stuckDownloads';
import {
  STUCK_GRACE_MS,
  StuckDownloadMonitor,
  createFileStore,
  getStatusMessages,
  getStuckReason,
} from '@server/lib/stuckDownloads';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

const MINUTE = 60 * 1000;
const START = Date.parse('2026-10-11T09:00:00Z');

const blocked = (init: Partial<TrackedQueueItem> = {}): TrackedQueueItem => ({
  id: 1,
  downloadId: 'download-1',
  trackedDownloadStatus: 'warning',
  trackedDownloadState: 'importBlocked',
  statusMessages: [
    {
      title: 'Some.Release.Name',
      messages: ['No supported audio or ebook files were found in /books'],
    },
  ],
  ...init,
});

const downloading: TrackedQueueItem = {
  id: 2,
  downloadId: 'download-2',
  trackedDownloadStatus: 'ok',
  trackedDownloadState: 'downloading',
  statusMessages: [],
};

// Keeps what would be written to the file, to restart with
const memoryStore = (initial: StuckDownloadEntries = {}) => {
  let saved: StuckDownloadEntries = structuredClone(initial);
  let saves = 0;
  const store: StuckDownloadStore = {
    load: () => structuredClone(saved),
    save: (entries) => {
      saved = structuredClone(entries);
      saves++;
    },
  };

  return {
    store,
    saved: () => saved,
    saves: () => saves,
  };
};

describe('getStuckReason', () => {
  it('treats blocked and failed imports and failed downloads as stuck', () => {
    for (const state of [
      'importBlocked',
      'importFailed',
      'failedPending',
      'failed',
    ]) {
      assert.equal(
        getStuckReason(blocked({ trackedDownloadState: state })),
        state.toLowerCase()
      );
    }
  });

  it('treats a warning or error with a reason as stuck', () => {
    assert.equal(
      getStuckReason(blocked({ trackedDownloadState: 'importPending' })),
      'warning'
    );
    assert.equal(
      getStuckReason(
        blocked({
          trackedDownloadState: 'downloading',
          trackedDownloadStatus: 'error',
        })
      ),
      'error'
    );
  });

  it('leaves healthy downloads and warnings without a reason alone', () => {
    assert.equal(getStuckReason(downloading), undefined);
    assert.equal(
      getStuckReason(
        blocked({ trackedDownloadState: 'importing', statusMessages: [] })
      ),
      undefined
    );
    assert.equal(getStuckReason({ id: 3 }), undefined);
  });
});

describe('getStatusMessages', () => {
  it('lists the messages, falling back to titles and the error message', () => {
    assert.deepEqual(
      getStatusMessages({
        id: 1,
        statusMessages: [
          { title: 'Release', messages: [' First reason ', ''] },
          { title: 'Only a title', messages: [] },
          { messages: ['Second reason'] },
        ],
        errorMessage: 'Download client said no',
      }),
      [
        'First reason',
        'Only a title',
        'Second reason',
        'Download client said no',
      ]
    );
    assert.deepEqual(getStatusMessages({ id: 1 }), []);
  });
});

describe('StuckDownloadMonitor', () => {
  it('reports a download once it has been stuck past the grace period', () => {
    const { store } = memoryStore();
    const monitor = new StuckDownloadMonitor(store);

    assert.deepEqual(monitor.update('chaptarr:0', [blocked()], START), []);
    assert.deepEqual(
      monitor.update(
        'chaptarr:0',
        [blocked()],
        START + STUCK_GRACE_MS - MINUTE
      ),
      []
    );

    const due = monitor.update(
      'chaptarr:0',
      [blocked(), downloading],
      START + STUCK_GRACE_MS
    );
    assert.equal(due.length, 1);
    assert.equal(due[0].key, 'chaptarr:0:download-1:importblocked');
    assert.equal(due[0].reason, 'importblocked');
    assert.deepEqual(due[0].messages, [
      'No supported audio or ebook files were found in /books',
    ]);

    // Never twice for the same download and reason
    assert.deepEqual(
      monitor.update('chaptarr:0', [blocked()], START + 60 * MINUTE),
      []
    );
  });

  it('does not report a download that recovers within the grace period', () => {
    const { store } = memoryStore();
    const monitor = new StuckDownloadMonitor(store);

    monitor.update('chaptarr:0', [blocked()], START);
    monitor.update(
      'chaptarr:0',
      [{ ...downloading, downloadId: 'download-1' }],
      START + 5 * MINUTE
    );

    // Stuck again, the grace period starts over
    assert.deepEqual(
      monitor.update('chaptarr:0', [blocked()], START + STUCK_GRACE_MS),
      []
    );
    assert.equal(
      monitor.update('chaptarr:0', [blocked()], START + 2 * STUCK_GRACE_MS)
        .length,
      1
    );
  });

  it('forgets a download that leaves the queue', () => {
    const { store, saved } = memoryStore();
    const monitor = new StuckDownloadMonitor(store);

    monitor.update('chaptarr:0', [blocked()], START);
    monitor.update('chaptarr:0', [blocked()], START + STUCK_GRACE_MS);
    assert.deepEqual(Object.keys(saved()), [
      'chaptarr:0:download-1:importblocked',
    ]);

    monitor.update('chaptarr:0', [], START + STUCK_GRACE_MS + MINUTE);
    assert.deepEqual(saved(), {});

    // Grabbed again and stuck again, it is a new problem
    monitor.update('chaptarr:0', [blocked()], START + 30 * MINUTE);
    assert.equal(
      monitor.update(
        'chaptarr:0',
        [blocked()],
        START + 30 * MINUTE + STUCK_GRACE_MS
      ).length,
      1
    );
  });

  it('reports a download again when it gets stuck in a new way', () => {
    const { store } = memoryStore();
    const monitor = new StuckDownloadMonitor(store);

    monitor.update('chaptarr:0', [blocked()], START);
    assert.equal(
      monitor.update('chaptarr:0', [blocked()], START + STUCK_GRACE_MS).length,
      1
    );

    const failed = blocked({ trackedDownloadState: 'importFailed' });
    monitor.update('chaptarr:0', [failed], START + 20 * MINUTE);
    const due = monitor.update(
      'chaptarr:0',
      [failed],
      START + 20 * MINUTE + STUCK_GRACE_MS
    );
    assert.equal(due.length, 1);
    assert.equal(due[0].reason, 'importfailed');
  });

  it('keeps the queues of different servers apart', () => {
    const { store, saved } = memoryStore();
    const monitor = new StuckDownloadMonitor(store);

    monitor.update('chaptarr:0', [blocked()], START);
    monitor.update('chaptarr:1', [blocked()], START);

    // An empty queue on one server leaves the other's downloads alone
    monitor.update('chaptarr:1', [], START + MINUTE);
    assert.deepEqual(Object.keys(saved()), [
      'chaptarr:0:download-1:importblocked',
    ]);
  });

  it('remembers what it reported across restarts', () => {
    const memory = memoryStore();

    new StuckDownloadMonitor(memory.store).update(
      'chaptarr:0',
      [blocked()],
      START
    );

    // The grace period carries over a restart
    const restarted = new StuckDownloadMonitor(memory.store);
    assert.equal(
      restarted.update('chaptarr:0', [blocked()], START + STUCK_GRACE_MS)
        .length,
      1
    );

    // And so does having told the admins
    const again = new StuckDownloadMonitor(memory.store);
    assert.deepEqual(
      again.update('chaptarr:0', [blocked()], START + 60 * MINUTE),
      []
    );
  });

  it('only saves when something changed', () => {
    const memory = memoryStore();
    const monitor = new StuckDownloadMonitor(memory.store);

    monitor.update('chaptarr:0', [downloading], START);
    assert.equal(memory.saves(), 0);

    monitor.update('chaptarr:0', [blocked()], START);
    monitor.update('chaptarr:0', [blocked()], START + MINUTE);
    assert.equal(memory.saves(), 1);
  });
});

describe('createFileStore', () => {
  it('saves and loads the entries, and starts empty without a file', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'stuck-downloads-'));
    const file = path.join(dir, 'stuck-downloads.json');
    const store = createFileStore(file);

    assert.deepEqual(store.load(), {});

    store.save({ 'chaptarr:0:a:failed': { firstSeen: START, notified: true } });
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {
      'chaptarr:0:a:failed': { firstSeen: START, notified: true },
    });
    assert.deepEqual(store.load(), {
      'chaptarr:0:a:failed': { firstSeen: START, notified: true },
    });

    writeFileSync(file, 'not json');
    assert.deepEqual(store.load(), {});
  });
});

describe('getStatusMessages without bare codes', () => {
  it('drops a code when the reason is also in words', () => {
    assert.deepStrictEqual(
      getStatusMessages({
        statusMessages: [
          {
            title: 'Not Quite Dead Yet - Holly Jackson.epub',
            messages: ['IMPORT_EXCEPTION'],
          },
          {
            title: 'Not Quite Dead Yet - Holly Jackson.epub',
            messages: [
              'ModelNotFoundException: Edition with ID 46124 does not exist',
            ],
          },
        ],
      } as TrackedQueueItem),
      ['Edition with ID 46124 does not exist']
    );
  });

  it('keeps a code that is all there is', () => {
    assert.deepStrictEqual(
      getStatusMessages({
        statusMessages: [{ title: 'x', messages: ['IMPORT_EXCEPTION'] }],
      } as TrackedQueueItem),
      ['IMPORT_EXCEPTION']
    );
  });
});
