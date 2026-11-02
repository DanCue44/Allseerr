import OpenLibrary from '@server/api/openlibrary';
import type {
  OlSearchResponse,
  OlWork,
} from '@server/api/openlibrary/interfaces';
import type { ChaptarrBook } from '@server/api/servarr/chaptarr';
import ChaptarrAPI from '@server/api/servarr/chaptarr';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import MediaRequest from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import { chaptarrScanner } from '@server/lib/scanners/chaptarr';
import { getChaptarrFileState } from '@server/lib/scanners/chaptarr/availability';
import type { ChaptarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';
import { runWithMockTimers } from '@server/test/runWithMockTimers';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

const PRIDE_ID = 'OL66554W';
const WORK = 'gr:3060926';

// In Cold Blood's audiobook after its file was deleted in Chaptarr
const deletedFileBook: ChaptarrBook = JSON.parse(
  readFileSync(
    path.join(
      __dirname,
      '../../../api/servarr/fixtures/chaptarr/book-file-deleted.json'
    ),
    'utf8'
  )
);

let books: ChaptarrBook[] = [];
let libraryError: Error | undefined;
// Books read one at a time, by id. Missing ids are a 404.
let bookById: Record<number, ChaptarrBook> = {};
let bookError: Error | undefined;
const getBookCalls: number[] = [];

mock.method(ChaptarrAPI.prototype, 'getAllBooks', async () => {
  if (libraryError) {
    throw libraryError;
  }
  return books;
});
// The full scan reads only the monitored and downloaded books
mock.method(ChaptarrAPI.prototype, 'getActiveBooks', async () => {
  if (libraryError) {
    throw libraryError;
  }
  return books;
});
mock.method(ChaptarrAPI.prototype, 'getBook', async (bookId: number) => {
  getBookCalls.push(bookId);
  if (bookError) {
    throw bookError;
  }
  return bookById[bookId];
});
mock.method(MediaRequest, 'sendNotification', async () => undefined);
// Library books without an OpenLibrary work id are looked up, these
// tests have nothing to find
mock.method(
  OpenLibrary.prototype,
  'searchBooks',
  async (): Promise<OlSearchResponse> => ({ numFound: 0, start: 0, docs: [] })
);
mock.method(
  OpenLibrary.prototype,
  'getWork',
  async (): Promise<OlWork> => ({
    key: `/works/${PRIDE_ID}`,
    title: 'Pride and Prejudice',
    type: { key: '/type/work' },
  })
);
mock.method(OpenLibrary.prototype, 'getWorkSummary', async () => undefined);

setupTestDb();

const server: ChaptarrSettings = {
  id: 0,
  name: 'Chaptarr',
  hostname: 'chaptarr',
  port: 8789,
  apiKey: 'test-key',
  useSsl: false,
  activeProfileId: 1,
  activeProfileName: 'E-Book',
  activeDirectory: '/ebooks',
  activeMetadataProfileId: 2,
  activeMetadataProfileName: 'Ebook Default',
  tags: [],
  is4k: false,
  isDefault: true,
  syncEnabled: true,
  preventSearch: false,
  tagRequests: false,
  overrideRule: [],
};

const fakeBook = (overrides: Partial<ChaptarrBook>): ChaptarrBook => ({
  id: 10,
  title: 'Pride and Prejudice',
  foreignBookId: WORK,
  mediaType: 'ebook',
  monitored: true,
  statistics: { bookFileCount: 1 },
  ...overrides,
});

// Both formats available, the ebook as book 10 and the audiobook as 11
const saveAvailableBook = (init: Partial<Media> = {}): Promise<Media> =>
  getRepository(Media).save(
    new Media({
      olId: PRIDE_ID,
      mediaType: MediaType.BOOK,
      status: MediaStatus.AVAILABLE,
      statusAudio: MediaStatus.AVAILABLE,
      serviceId: 0,
      externalServiceId: 10,
      externalServiceIdAudio: 11,
      foreignBookId: WORK,
      ...init,
    })
  );

const reload = () =>
  getRepository(Media).findOneOrFail({ where: { olId: PRIDE_ID } });

const scan = () => runWithMockTimers(() => chaptarrScanner.run());

describe('getChaptarrFileState', () => {
  it('reads the file count first', () => {
    assert.strictEqual(getChaptarrFileState(deletedFileBook), 'gone');
    assert.strictEqual(
      getChaptarrFileState(fakeBook({ statistics: { bookFileCount: 2 } })),
      'present'
    );
  });

  it('falls back to hasFiles', () => {
    assert.strictEqual(
      getChaptarrFileState(fakeBook({ statistics: undefined, hasFiles: true })),
      'present'
    );
    assert.strictEqual(
      getChaptarrFileState(
        fakeBook({ statistics: undefined, hasFiles: false })
      ),
      'gone'
    );
  });

  it('is unknown when Chaptarr does not say', () => {
    assert.strictEqual(
      getChaptarrFileState(fakeBook({ statistics: undefined })),
      'unknown'
    );
  });
});

describe('Chaptarr availability sync', () => {
  beforeEach(() => {
    books = [];
    bookById = {};
    libraryError = undefined;
    bookError = undefined;
    getBookCalls.length = 0;
    getSettings().chaptarr = [server];
  });

  afterEach(() => {
    getSettings().chaptarr = [];
  });

  it('resets a format whose file was deleted and keeps the other', async () => {
    await saveAvailableBook();
    const audiobook = { ...deletedFileBook, id: 11, foreignBookId: WORK };
    books = [fakeBook({}), audiobook];
    bookById = { 11: audiobook };

    await scan();

    const pride = await reload();
    assert.strictEqual(pride.status, MediaStatus.AVAILABLE);
    assert.strictEqual(pride.externalServiceId, 10);
    assert.strictEqual(pride.statusAudio, MediaStatus.DELETED);
    assert.strictEqual(pride.externalServiceIdAudio, null);
    // Still needed by the ebook
    assert.strictEqual(pride.serviceId, 0);
    // Confirmed by reading the book again, the listed ebook was not
    assert.deepStrictEqual(getBookCalls, [11]);
  });

  it('resets both formats of a book removed from Chaptarr', async () => {
    await saveAvailableBook();
    // Chaptarr still lists other books, but neither of these
    books = [fakeBook({ id: 50, foreignBookId: 'gr:1' })];

    await scan();

    const pride = await reload();
    assert.strictEqual(pride.status, MediaStatus.DELETED);
    assert.strictEqual(pride.statusAudio, MediaStatus.DELETED);
    assert.strictEqual(pride.externalServiceId, null);
    assert.strictEqual(pride.externalServiceIdAudio, null);
    assert.strictEqual(pride.serviceId, null);
    // The work id stays, so the book is found again if it is added back
    assert.strictEqual(pride.foreignBookId, WORK);
  });

  it('keeps the service data of a format with a request in flight', async () => {
    const media = await saveAvailableBook({ status: MediaStatus.UNKNOWN });
    const requestedBy = await getRepository(User).findOneOrFail({
      where: { email: 'demo@seerr.dev' },
    });
    // Saved without Chaptarr set up, so it is not sent there
    getSettings().chaptarr = [];
    const request = await getRepository(MediaRequest).save(
      new MediaRequest({
        type: MediaType.BOOK,
        status: MediaRequestStatus.APPROVED,
        media,
        requestedBy,
        isAudiobook: true,
      })
    );
    getSettings().chaptarr = [server];
    books = [fakeBook({ id: 50, foreignBookId: 'gr:1' })];

    await scan();

    const pride = await reload();
    assert.strictEqual(pride.statusAudio, MediaStatus.DELETED);
    assert.strictEqual(pride.externalServiceIdAudio, 11);
    assert.strictEqual(pride.serviceId, 0);
    // As for movies and shows, the request is completed
    const after = await getRepository(MediaRequest).findOneOrFail({
      where: { id: request.id },
    });
    assert.strictEqual(after.status, MediaRequestStatus.COMPLETED);
  });

  it('resets nothing when Chaptarr cannot list its books', async () => {
    await saveAvailableBook();
    libraryError = new Error('connect ECONNREFUSED');

    await scan();

    const pride = await reload();
    assert.strictEqual(pride.status, MediaStatus.AVAILABLE);
    assert.strictEqual(pride.statusAudio, MediaStatus.AVAILABLE);
    assert.deepStrictEqual(getBookCalls, []);
  });

  it('resets nothing when Chaptarr lists no books', async () => {
    await saveAvailableBook();
    books = [];

    await scan();

    const pride = await reload();
    assert.strictEqual(pride.status, MediaStatus.AVAILABLE);
    assert.strictEqual(pride.statusAudio, MediaStatus.AVAILABLE);
    assert.deepStrictEqual(getBookCalls, []);
  });

  it('keeps a format when Chaptarr fails to read its book', async () => {
    await saveAvailableBook();
    books = [fakeBook({ id: 50, foreignBookId: 'gr:1' })];
    bookError = new Error('[Chaptarr] Failed to retrieve book: timeout');

    await scan();

    const pride = await reload();
    assert.strictEqual(pride.status, MediaStatus.AVAILABLE);
    assert.strictEqual(pride.statusAudio, MediaStatus.AVAILABLE);
    assert.strictEqual(pride.externalServiceIdAudio, 11);
  });

  it('keeps a format the listing has no file count for', async () => {
    await saveAvailableBook({ statusAudio: MediaStatus.UNKNOWN });
    books = [fakeBook({ statistics: undefined })];

    await scan();

    const pride = await reload();
    assert.strictEqual(pride.status, MediaStatus.AVAILABLE);
    assert.deepStrictEqual(getBookCalls, []);
  });

  it('keeps a format whose file arrived after the listing', async () => {
    await saveAvailableBook({ statusAudio: MediaStatus.UNKNOWN });
    books = [fakeBook({ statistics: { bookFileCount: 0 } })];
    bookById = { 10: fakeBook({}) };

    await scan();

    assert.strictEqual((await reload()).status, MediaStatus.AVAILABLE);
  });

  it('keeps a format when its id now holds the other format', async () => {
    await saveAvailableBook({ statusAudio: MediaStatus.UNKNOWN });
    books = [fakeBook({ id: 50, foreignBookId: 'gr:1' })];
    bookById = {
      10: fakeBook({
        mediaType: 'audiobook',
        statistics: { bookFileCount: 0 },
      }),
    };

    await scan();

    assert.strictEqual((await reload()).status, MediaStatus.AVAILABLE);
  });

  it('moves the link to another copy of the work that has the file', async () => {
    await saveAvailableBook({ statusAudio: MediaStatus.UNKNOWN });
    books = [
      fakeBook({ statistics: { bookFileCount: 0 } }),
      fakeBook({ id: 12 }),
    ];
    bookById = { 10: fakeBook({ statistics: { bookFileCount: 0 } }) };

    await scan();

    const pride = await reload();
    assert.strictEqual(pride.status, MediaStatus.AVAILABLE);
    assert.strictEqual(pride.externalServiceId, 12);
  });

  it('leaves books of other servers alone', async () => {
    await saveAvailableBook({ serviceId: 7 });
    books = [fakeBook({ id: 50, foreignBookId: 'gr:1' })];

    await scan();

    const pride = await reload();
    assert.strictEqual(pride.status, MediaStatus.AVAILABLE);
    assert.strictEqual(pride.statusAudio, MediaStatus.AVAILABLE);
    assert.deepStrictEqual(getBookCalls, []);
  });
});
