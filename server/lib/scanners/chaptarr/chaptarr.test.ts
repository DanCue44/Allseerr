import AudiobookshelfAPI from '@server/api/audiobookshelf';
import OpenLibrary from '@server/api/openlibrary';
import type { OlWork } from '@server/api/openlibrary/interfaces';
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
import {
  chaptarrRecentScanner,
  chaptarrScanner,
  getChaptarrBookState,
} from '@server/lib/scanners/chaptarr';
import type { ChaptarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';
import { runWithMockTimers } from '@server/test/runWithMockTimers';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

const PRIDE_ID = 'OL66554W';
const EMMA_ID = 'OL66512W';
const PERSUASION_ID = 'OL66513W';

let books: ChaptarrBook[] = [];
let getAllBooksCalls = 0;
mock.method(ChaptarrAPI.prototype, 'getAllBooks', async () => {
  getAllBooksCalls++;
  return books;
});
// The availability check reads books it cannot confirm from the listing,
// which these tests never need
mock.method(ChaptarrAPI.prototype, 'getBook', async () => {
  throw new Error('getBook is not expected in these tests');
});
mock.method(MediaRequest, 'sendNotification', async () => undefined);
// Completed requests are announced with the work's details
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
mock.method(OpenLibrary.prototype, 'getWorkIsbns', async () => []);
mock.method(
  AudiobookshelfAPI.prototype,
  'searchBooks',
  async (libraryId: string) => [
    {
      id: libraryId === 'ebooks' ? 'li_ebook0001' : 'li_audio0001',
      title: 'Pride and Prejudice',
      authors: ['Jane Austen'],
      series: [],
    },
  ]
);

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

function configureChaptarr(settings?: Partial<ChaptarrSettings>): void {
  getSettings().chaptarr = settings ? [{ ...server, ...settings }] : [];
}

function fakeBook(overrides: Partial<ChaptarrBook>): ChaptarrBook {
  return {
    id: 1,
    title: 'Pride and Prejudice',
    foreignBookId: 'gr:3060926',
    mediaType: 'ebook',
    monitored: false,
    statistics: { bookFileCount: 0 },
    ...overrides,
  };
}

describe('getChaptarrBookState', () => {
  it('is available once a format has a file', () => {
    assert.strictEqual(
      getChaptarrBookState(
        fakeBook({ statistics: { bookFileCount: 1 } }),
        'ebook'
      ),
      'available'
    );
  });

  it('is processing while a format is monitored without files', () => {
    assert.strictEqual(
      getChaptarrBookState(
        fakeBook({ mediaType: 'audiobook', audiobookMonitored: true }),
        'audiobook'
      ),
      'processing'
    );
  });

  it('skips a format that is neither', () => {
    assert.strictEqual(getChaptarrBookState(fakeBook({}), 'ebook'), 'skip');
  });
});

describe('Chaptarr Scanner', () => {
  beforeEach(() => {
    books = [];
    getAllBooksCalls = 0;
    configureChaptarr({});
  });

  afterEach(() => {
    configureChaptarr();
  });

  it('updates each format of a requested book from its Chaptarr book', async () => {
    const mediaRepository = getRepository(Media);
    await mediaRepository.save(
      new Media({
        olId: PRIDE_ID,
        mediaType: MediaType.BOOK,
        status: MediaStatus.PROCESSING,
        statusAudio: MediaStatus.PENDING,
        serviceId: 0,
        externalServiceId: 10,
        externalServiceIdAudio: 11,
        foreignBookId: 'gr:3060926',
      })
    );
    books = [
      fakeBook({
        id: 10,
        monitored: true,
        statistics: { bookFileCount: 1 },
      }),
      fakeBook({ id: 11, mediaType: 'audiobook', monitored: true }),
    ];

    await runWithMockTimers(() => chaptarrScanner.run());

    const pride = await mediaRepository.findOneOrFail({
      where: { olId: PRIDE_ID },
    });
    assert.strictEqual(pride.status, MediaStatus.AVAILABLE);
    assert.strictEqual(pride.statusAudio, MediaStatus.PROCESSING);
    assert.ok(pride.mediaAddedAt);
  });

  it('links a book requested while its author was importing', async () => {
    const mediaRepository = getRepository(Media);
    await mediaRepository.save(
      new Media({
        olId: PRIDE_ID,
        mediaType: MediaType.BOOK,
        statusAudio: MediaStatus.PROCESSING,
        serviceId: 0,
        foreignBookId: 'gr:3060926',
      })
    );
    books = [
      fakeBook({
        id: 31,
        mediaType: 'audiobook',
        monitored: true,
        statistics: { bookFileCount: 2 },
      }),
      // The ebook of the work, part of the author's catalog only
      fakeBook({ id: 30 }),
    ];

    await runWithMockTimers(() => chaptarrScanner.run());

    const pride = await mediaRepository.findOneOrFail({
      where: { olId: PRIDE_ID },
    });
    assert.strictEqual(pride.externalServiceIdAudio, 31);
    assert.strictEqual(pride.externalServiceId, null);
    assert.strictEqual(pride.statusAudio, MediaStatus.AVAILABLE);
    assert.strictEqual(pride.status, MediaStatus.UNKNOWN);
  });

  it('keeps a linked book when Chaptarr holds another copy of it', async () => {
    const mediaRepository = getRepository(Media);
    await mediaRepository.save(
      new Media({
        olId: PRIDE_ID,
        mediaType: MediaType.BOOK,
        status: MediaStatus.AVAILABLE,
        serviceId: 0,
        externalServiceId: 10,
        foreignBookId: 'gr:3060926',
      })
    );
    books = [
      fakeBook({ id: 10, monitored: true, statistics: { bookFileCount: 1 } }),
      fakeBook({ id: 12, monitored: true }),
    ];

    await runWithMockTimers(() => chaptarrScanner.run());

    const pride = await mediaRepository.findOneOrFail({
      where: { olId: PRIDE_ID },
    });
    assert.strictEqual(pride.externalServiceId, 10);
    assert.strictEqual(pride.status, MediaStatus.AVAILABLE);
  });

  it('saves books added in Chaptarr by their OpenLibrary work id', async () => {
    books = [
      fakeBook({
        id: 40,
        title: 'Emma',
        foreignBookId: 'ol:OL66512W',
        openLibraryWorkId: `ol:${EMMA_ID}`,
        statistics: { bookFileCount: 1 },
      }),
      // Nothing to key a book without an OpenLibrary work id on
      fakeBook({
        id: 41,
        title: 'Persuasion',
        foreignBookId: 'gr:2',
        monitored: true,
      }),
      // Part of an author's catalog, never asked for
      fakeBook({
        id: 42,
        title: 'Persuasion',
        foreignBookId: 'ol:OL66513W',
        openLibraryWorkId: `ol:${PERSUASION_ID}`,
      }),
    ];

    await runWithMockTimers(() => chaptarrScanner.run());

    const mediaRepository = getRepository(Media);
    const emma = await mediaRepository.findOneOrFail({
      where: { olId: EMMA_ID },
    });
    assert.strictEqual(emma.status, MediaStatus.AVAILABLE);
    assert.strictEqual(emma.statusAudio, MediaStatus.UNKNOWN);
    assert.strictEqual(emma.externalServiceId, 40);
    assert.strictEqual(emma.serviceId, 0);

    assert.strictEqual(await mediaRepository.count(), 1);
  });

  it('completes the request of a format once its file arrives', async () => {
    // Requests are saved before Chaptarr is set up, so they are not sent
    configureChaptarr();
    const mediaRepository = getRepository(Media);
    const requestRepository = getRepository(MediaRequest);
    const requestedBy = await getRepository(User).findOneOrFail({
      where: { email: 'demo@seerr.dev' },
    });
    const media = await mediaRepository.save(
      new Media({
        olId: PRIDE_ID,
        mediaType: MediaType.BOOK,
        status: MediaStatus.PROCESSING,
        statusAudio: MediaStatus.PROCESSING,
        serviceId: 0,
        externalServiceId: 10,
        externalServiceIdAudio: 11,
      })
    );
    const ebookRequest = await requestRepository.save(
      new MediaRequest({
        type: MediaType.BOOK,
        status: MediaRequestStatus.APPROVED,
        media,
        requestedBy,
        isAudiobook: false,
      })
    );
    const audiobookRequest = await requestRepository.save(
      new MediaRequest({
        type: MediaType.BOOK,
        status: MediaRequestStatus.APPROVED,
        media,
        requestedBy,
        isAudiobook: true,
      })
    );
    configureChaptarr({});
    books = [
      fakeBook({ id: 10, monitored: true }),
      fakeBook({
        id: 11,
        mediaType: 'audiobook',
        monitored: true,
        statistics: { bookFileCount: 3 },
      }),
    ];

    await runWithMockTimers(() => chaptarrScanner.run());

    const audiobook = await requestRepository.findOneOrFail({
      where: { id: audiobookRequest.id },
    });
    assert.strictEqual(audiobook.status, MediaRequestStatus.COMPLETED);

    const ebook = await requestRepository.findOneOrFail({
      where: { id: ebookRequest.id },
    });
    assert.strictEqual(ebook.status, MediaRequestStatus.APPROVED);
  });

  it('remembers the Audiobookshelf items of available books', async () => {
    const mediaRepository = getRepository(Media);
    await mediaRepository.save(
      new Media({
        olId: PRIDE_ID,
        mediaType: MediaType.BOOK,
        status: MediaStatus.AVAILABLE,
        statusAudio: MediaStatus.PROCESSING,
        serviceId: 0,
        externalServiceId: 10,
        externalServiceIdAudio: 11,
        foreignBookId: 'gr:3060926',
      })
    );
    books = [
      fakeBook({
        id: 10,
        monitored: true,
        statistics: { bookFileCount: 1 },
        author: { authorName: 'Jane Austen', foreignAuthorId: 'gr:1265' },
      }),
      fakeBook({ id: 11, mediaType: 'audiobook', monitored: true }),
    ];
    getSettings().audiobookshelf = {
      url: 'https://books.example.com',
      libraryId: 'audiobooks',
      ebookLibraryId: 'ebooks',
      apiKey: 'abs-key',
    };

    try {
      await runWithMockTimers(() => chaptarrScanner.run());
    } finally {
      getSettings().audiobookshelf = { url: '', apiKey: '' };
    }

    const pride = await mediaRepository.findOneOrFail({
      where: { olId: PRIDE_ID },
    });
    assert.strictEqual(pride.absEbookItemId, 'li_ebook0001');
    // The audiobook is not available yet
    assert.strictEqual(pride.absAudiobookItemId, null);
  });

  it('skips servers without scanning enabled', async () => {
    configureChaptarr({ syncEnabled: false });
    books = [fakeBook({ statistics: { bookFileCount: 1 } })];

    await runWithMockTimers(() => chaptarrScanner.run());

    assert.strictEqual(getAllBooksCalls, 0);
    assert.strictEqual(chaptarrScanner.status().running, false);
  });

  it('the recent scan reads only the books Allseerr waits on', async () => {
    const mediaRepository = getRepository(Media);
    await mediaRepository.save([
      new Media({
        olId: PRIDE_ID,
        mediaType: MediaType.BOOK,
        status: MediaStatus.PROCESSING,
        serviceId: 0,
        externalServiceId: 10,
        foreignBookId: 'gr:3060926',
      }),
      // Available already: only the full scan notices its file is gone
      new Media({
        olId: EMMA_ID,
        mediaType: MediaType.BOOK,
        status: MediaStatus.AVAILABLE,
        serviceId: 0,
        externalServiceId: 20,
        foreignBookId: 'gr:6969',
      }),
    ]);
    const fetched: number[] = [];
    const getBook = mock.method(
      ChaptarrAPI.prototype,
      'getBook',
      async (bookId: number) => {
        fetched.push(bookId);
        return fakeBook({
          id: bookId,
          monitored: true,
          statistics: { bookFileCount: 1 },
        });
      }
    );

    try {
      await runWithMockTimers(() => chaptarrRecentScanner.run());
    } finally {
      getBook.mock.restore();
    }

    assert.deepStrictEqual(fetched, [10]);
    assert.strictEqual(getAllBooksCalls, 0);
    const pride = await mediaRepository.findOneOrFail({
      where: { olId: PRIDE_ID },
    });
    assert.strictEqual(pride.status, MediaStatus.AVAILABLE);
    const emma = await mediaRepository.findOneOrFail({
      where: { olId: EMMA_ID },
    });
    assert.strictEqual(emma.status, MediaStatus.AVAILABLE);
  });

  it('the recent scan fails instead of losing books it could not read', async () => {
    const mediaRepository = getRepository(Media);
    await mediaRepository.save(
      new Media({
        olId: PRIDE_ID,
        mediaType: MediaType.BOOK,
        status: MediaStatus.PROCESSING,
        serviceId: 0,
        externalServiceId: 10,
        foreignBookId: 'gr:3060926',
      })
    );
    const getBook = mock.method(ChaptarrAPI.prototype, 'getBook', async () => {
      throw new Error('Chaptarr is down');
    });

    try {
      await runWithMockTimers(() => chaptarrRecentScanner.run());
    } finally {
      getBook.mock.restore();
    }

    const pride = await mediaRepository.findOneOrFail({
      where: { olId: PRIDE_ID },
    });
    assert.strictEqual(pride.status, MediaStatus.PROCESSING);
    assert.strictEqual(chaptarrRecentScanner.status().running, false);
  });
});
