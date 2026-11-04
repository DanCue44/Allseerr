import type {
  ChaptarrBook,
  LibraryProgress,
  LibraryProgressStore,
} from '@server/api/servarr/chaptarr';
import logger from '@server/logger';
import { appDataPath } from '@server/utils/appDataVolume';
import { createHash } from 'crypto';
import { createReadStream } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { createInterface } from 'readline';
import { createGunzip, gzipSync } from 'zlib';

type ProgressLine =
  | { key: string; savedAt: number }
  | { books: ChaptarrBook[] }
  | { done: true };

/**
 * Keeps the library a full scan has read so far in the config folder, one
 * file per server and part of the library. Each page is added to the end of
 * the file as its own gzip piece, so a scan that stops, or Allseerr
 * restarting in the middle of one, loses at most the page being read.
 */
export const createDiskLibraryProgress = (
  directory = path.join(appDataPath(), 'chaptarr-scan-progress')
): LibraryProgressStore => {
  const fileFor = (key: string) =>
    path.join(
      directory,
      `${createHash('sha1').update(key).digest('hex').slice(0, 16)}.jsonl.gz`
    );

  const append = async (key: string, line: ProgressLine) => {
    try {
      await fs.mkdir(directory, { recursive: true });
      await fs.appendFile(fileFor(key), gzipSync(`${JSON.stringify(line)}\n`));
    } catch (e) {
      logger.warn('Could not save how far the Chaptarr scan got', {
        label: 'Chaptarr Scan',
        errorMessage: e.message,
      });
    }
  };

  return {
    load: async (key) => {
      const lines = await readLines(fileFor(key));
      const header = lines[0];

      if (!header || !('key' in header) || header.key !== key) {
        return undefined;
      }

      const progress: LibraryProgress = {
        books: [],
        done: false,
        savedAt: header.savedAt,
      };

      for (const line of lines.slice(1)) {
        if ('books' in line) {
          progress.books.push(...line.books);
        } else if ('done' in line) {
          progress.done = true;
        }
      }

      return progress;
    },
    start: async (key, savedAt) => {
      await fs.rm(fileFor(key), { force: true });
      await append(key, { key, savedAt });
    },
    add: (key, books) => append(key, { books }),
    finish: (key) => append(key, { done: true }),
    clear: async (key) => {
      await fs.rm(fileFor(key), { force: true });
    },
  };
};

/**
 * The lines of a progress file. A file cut short by a restart gives the
 * lines before the cut.
 */
const readLines = (file: string): Promise<ProgressLine[]> =>
  new Promise((resolve) => {
    const lines: ProgressLine[] = [];
    const input = createReadStream(file);
    const gunzip = createGunzip();
    const done = () => resolve(lines);

    input.on('error', done);
    gunzip.on('error', done);
    createInterface({ input: input.pipe(gunzip) })
      .on('line', (text) => {
        try {
          lines.push(JSON.parse(text));
        } catch {
          // A line written halfway
        }
      })
      .on('error', done)
      .on('close', done);
  });
