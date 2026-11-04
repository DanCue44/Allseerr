import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { createDiskLibraryProgress } from '@server/lib/scanners/chaptarr/libraryProgress';

const book = (id: number) => ({
  id,
  title: `Book ${id}`,
  foreignBookId: `${id}`,
  monitored: true,
});

describe('createDiskLibraryProgress', () => {
  it('keeps the pages read so far across a restart', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'chaptarr-progress-'));
    const store = createDiskLibraryProgress(dir);

    await store.start('server|monitored', 1000);
    await store.add('server|monitored', [book(1), book(2)]);
    await store.add('server|monitored', [book(3)]);

    // A new store reads the same file, as Allseerr does after a restart
    const progress =
      await createDiskLibraryProgress(dir).load('server|monitored');

    assert.deepStrictEqual(progress, {
      books: [book(1), book(2), book(3)],
      done: false,
      savedAt: 1000,
    });

    await store.finish('server|monitored');
    assert.strictEqual((await store.load('server|monitored'))?.done, true);
  });

  it('starts over and forgets', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'chaptarr-progress-'));
    const store = createDiskLibraryProgress(dir);

    await store.start('server|monitored', 1000);
    await store.add('server|monitored', [book(1)]);
    await store.start('server|monitored', 2000);

    assert.deepStrictEqual(await store.load('server|monitored'), {
      books: [],
      done: false,
      savedAt: 2000,
    });
    assert.strictEqual(await store.load('server|downloaded'), undefined);

    await store.clear('server|monitored');
    assert.strictEqual(await store.load('server|monitored'), undefined);
  });

  it('reads the pages before a page written halfway', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'chaptarr-progress-'));
    const store = createDiskLibraryProgress(dir);

    await store.start('server|monitored', 1000);
    await store.add('server|monitored', [book(1)]);
    await store.add('server|monitored', [book(2)]);
    const [file] = readdirSync(dir);
    const full = readFileSync(path.join(dir, file));
    writeFileSync(path.join(dir, file), full.subarray(0, full.length - 10));

    assert.deepStrictEqual((await store.load('server|monitored'))?.books, [
      book(1),
    ]);
  });
});
