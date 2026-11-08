import AudiobookshelfAPI from '@server/api/audiobookshelf';
import OpenLibrary from '@server/api/openlibrary';
import type {
  OlSearchDoc,
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
import ChaptarrBookMatch from '@server/entity/ChaptarrBookMatch';
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
// The full scan reads only the monitored and downloaded books
mock.method(ChaptarrAPI.prototype, 'getActiveBooks', async () => {
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
// Books without an OpenLibrary work id are looked up by title and author.
// The answers are set per test, every search is counted.
let searchAnswers: Record<string, OlSearchDoc[]> = {};
let searches: string[] = [];
let searchGate: Promise<void> | undefined;
mock.method(
  OpenLibrary.prototype,
  'searchBooks',
  async ({ query }: { query: string }): Promise<OlSearchResponse> => {
    searches.push(query);
    await searchGate;
    const docs = searchAnswers[query] ?? [];
    return { numFound: docs.length, start: 0, docs };
  }
);
mock.method(ChaptarrAPI.prototype, 'getEditions', async () => []);
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
    searchAnswers = {};
    searches = [];
    searchGate = undefined;
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
      // No OpenLibrary work id, and OpenLibrary has nothing for its title
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

  it('the recent scan links a book requested while its author was importing', async () => {
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
    const lookups: string[] = [];
    const lookupBooks = mock.method(
      ChaptarrAPI.prototype,
      'lookupBooks',
      async (term: string, mediaType?: string) => {
        lookups.push(`${term} ${mediaType}`);
        return [fakeBook({ id: 31, mediaType: 'audiobook' })];
      }
    );
    const getBook = mock.method(
      ChaptarrAPI.prototype,
      'getBook',
      async (bookId: number) =>
        fakeBook({
          id: bookId,
          mediaType: 'audiobook',
          monitored: true,
          statistics: { bookFileCount: 1 },
        })
    );

    try {
      await runWithMockTimers(() => chaptarrRecentScanner.run());
    } finally {
      lookupBooks.mock.restore();
      getBook.mock.restore();
    }

    assert.deepStrictEqual(lookups, ['gr:3060926 audiobook']);
    assert.strictEqual(getAllBooksCalls, 0);
    const pride = await mediaRepository.findOneOrFail({
      where: { olId: PRIDE_ID },
    });
    assert.strictEqual(pride.externalServiceIdAudio, 31);
    assert.strictEqual(pride.statusAudio, MediaStatus.AVAILABLE);
  });

  it('the recent scan waits for a book Chaptarr is still importing', async () => {
    const mediaRepository = getRepository(Media);
    await mediaRepository.save(
      new Media({
        olId: PRIDE_ID,
        mediaType: MediaType.BOOK,
        status: MediaStatus.PROCESSING,
        serviceId: 0,
        foreignBookId: 'gr:3060926',
      })
    );
    const lookupBooks = mock.method(
      ChaptarrAPI.prototype,
      'lookupBooks',
      async () => [fakeBook({ id: undefined })]
    );

    try {
      await runWithMockTimers(() => chaptarrRecentScanner.run());
    } finally {
      lookupBooks.mock.restore();
    }

    const pride = await mediaRepository.findOneOrFail({
      where: { olId: PRIDE_ID },
    });
    assert.strictEqual(pride.externalServiceId, null);
    assert.strictEqual(pride.status, MediaStatus.PROCESSING);
    assert.strictEqual(chaptarrRecentScanner.status().running, false);
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

  describe('books without an OpenLibrary work id', () => {
    const austen = { authorName: 'Jane Austen' } as ChaptarrBook['author'];
    const emmaQuery = 'title:"Emma" author:"austen"';
    const emmaDoc: OlSearchDoc = {
      key: `/works/${EMMA_ID}`,
      title: 'Emma',
      author_name: ['Jane Austen'],
      edition_count: 900,
    };

    it('finds them on OpenLibrary and merges both formats', async () => {
      searchAnswers = { [emmaQuery]: [emmaDoc] };
      books = [
        fakeBook({
          id: 50,
          title: 'Emma',
          foreignBookId: 'hc:50',
          author: austen,
          statistics: { bookFileCount: 1 },
        }),
        fakeBook({
          id: 51,
          title: 'Emma',
          foreignBookId: 'hc:50',
          mediaType: 'audiobook',
          author: austen,
          audiobookMonitored: true,
        }),
      ];

      await runWithMockTimers(() => chaptarrScanner.run());

      const mediaRepository = getRepository(Media);
      assert.strictEqual(await mediaRepository.count(), 1);
      const emma = await mediaRepository.findOneOrFail({
        where: { olId: EMMA_ID },
      });
      assert.strictEqual(emma.status, MediaStatus.AVAILABLE);
      assert.strictEqual(emma.statusAudio, MediaStatus.PROCESSING);
      assert.strictEqual(emma.externalServiceId, 50);
      assert.strictEqual(emma.externalServiceIdAudio, 51);
      assert.deepStrictEqual(searches, [emmaQuery]);
    });

    it('matches a co-written book OpenLibrary lists under the other author', async () => {
      const reaperQuery = 'title:"Descent of the Reaper" author:"chaney"';
      searchAnswers = {
        [reaperQuery]: [
          {
            key: '/works/OL21898543W',
            title: 'Descent of the Reaper',
            author_name: ['Scott Moon', 'J. N. Chaney'],
            first_publish_year: 2019,
          },
        ],
      };
      books = [
        fakeBook({
          id: 60,
          title: 'Descent of the Reaper',
          foreignBookId: 'hc:60',
          author: { authorName: 'J.N. Chaney' } as ChaptarrBook['author'],
          releaseDate: '2019-03-12T00:00:00Z',
          statistics: { bookFileCount: 1 },
        }),
      ];

      await runWithMockTimers(() => chaptarrScanner.run());

      const reaper = await getRepository(Media).findOne({
        where: { olId: 'OL21898543W' },
      });
      assert.ok(reaper, 'the book is matched to the co-written work');
      assert.strictEqual(reaper.externalServiceId, 60);
    });

    it('links a book requested before instead of adding another', async () => {
      const mediaRepository = getRepository(Media);
      await mediaRepository.save(
        new Media({
          olId: EMMA_ID,
          mediaType: MediaType.BOOK,
          status: MediaStatus.PROCESSING,
        })
      );
      searchAnswers = { [emmaQuery]: [emmaDoc] };
      books = [
        fakeBook({
          id: 52,
          title: 'Emma',
          foreignBookId: 'hc:52',
          author: austen,
          statistics: { bookFileCount: 1 },
        }),
      ];

      await runWithMockTimers(() => chaptarrScanner.run());

      assert.strictEqual(await mediaRepository.count(), 1);
      const emma = await mediaRepository.findOneOrFail({
        where: { olId: EMMA_ID },
      });
      assert.strictEqual(emma.externalServiceId, 52);
      assert.strictEqual(emma.status, MediaStatus.AVAILABLE);
    });

    it('does not look books up again on the next scan', async () => {
      searchAnswers = { [emmaQuery]: [emmaDoc] };
      books = [
        fakeBook({
          id: 53,
          title: 'Emma',
          foreignBookId: 'hc:53',
          author: austen,
          statistics: { bookFileCount: 1 },
        }),
        fakeBook({
          id: 54,
          title: 'Not On OpenLibrary',
          foreignBookId: 'hc:54',
          author: austen,
          statistics: { bookFileCount: 1 },
        }),
      ];

      await runWithMockTimers(() => chaptarrScanner.run());
      assert.strictEqual(searches.length, 2);
      const memories = await getRepository(ChaptarrBookMatch).find({
        order: { foreignBookId: 'ASC' },
      });
      assert.deepStrictEqual(
        memories.map((m) => [m.foreignBookId, m.olId, m.attempts]),
        [
          ['hc:53', EMMA_ID, 0],
          ['hc:54', null, 1],
        ]
      );

      searches = [];
      await runWithMockTimers(() => chaptarrScanner.run());

      assert.deepStrictEqual(searches, []);
      assert.strictEqual(await getRepository(Media).count(), 1);
    });

    it('carries on after a stopped scan and keeps other jobs running', async () => {
      const total = 3000;
      books = Array.from({ length: total }, (_, i) =>
        fakeBook({
          id: 1000 + i,
          title: `Book ${i}`,
          foreignBookId: `hc:${1000 + i}`,
          author: austen,
          statistics: { bookFileCount: 1 },
        })
      );
      for (let i = 0; i < total; i += 3) {
        searchAnswers[`title:"Book ${i}" author:"austen"`] = [
          {
            key: `/works/OL${9000 + i}W`,
            title: `Book ${i}`,
            author_name: ['Jane Austen'],
          },
        ];
      }

      let release: () => void = () => undefined;
      searchGate = new Promise((resolve) => {
        release = resolve;
      });
      const tick = () => new Promise((resolve) => setImmediate(resolve));

      await runWithMockTimers(async () => {
        const first = chaptarrScanner.run();
        while (chaptarrScanner.status().step !== 'openlibrary') {
          await tick();
        }

        // Another job runs while the full scan waits on OpenLibrary
        await chaptarrRecentScanner.run();
        assert.strictEqual(chaptarrRecentScanner.status().running, false);
        assert.strictEqual(chaptarrScanner.status().running, true);

        release();
        while ((chaptarrScanner.status().matching?.done ?? 0) < 900) {
          await tick();
        }
        const progress = chaptarrScanner.status().matching;
        assert.strictEqual(progress?.total, total);
        chaptarrScanner.cancel();
        await first;
      });

      const stoppedAt = await getRepository(ChaptarrBookMatch).count();
      assert.ok(stoppedAt >= 900 && stoppedAt < total, String(stoppedAt));

      searches = [];
      await runWithMockTimers(() => chaptarrScanner.run());

      // Only the books the stopped scan did not get to are looked up
      assert.strictEqual(searches.length, total - stoppedAt);
      assert.strictEqual(await getRepository(ChaptarrBookMatch).count(), total);
      assert.strictEqual(await getRepository(Media).count(), total / 3);
    });
  });
});
