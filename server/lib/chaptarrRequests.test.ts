import assert from 'node:assert/strict';
import { beforeEach, describe, it, mock } from 'node:test';

import OpenLibrary from '@server/api/openlibrary';
import type { OlSearchDoc } from '@server/api/openlibrary/interfaces';
import type ChaptarrAPI from '@server/api/servarr/chaptarr';
import type {
  ChaptarrAddBookOptions,
  ChaptarrAddBookResult,
  ChaptarrBook,
  ChaptarrEdition,
  ChaptarrMediaType,
  ChaptarrPendingResult,
} from '@server/api/servarr/chaptarr';
import {
  getChaptarrFormatSettings,
  isSameBookTitle,
  matchChaptarrLibraryBook,
  pickChaptarrMatch,
  preferEditionInLanguage,
  prepareChaptarrBookSearch,
  removeBookFromChaptarr,
  sendBookToChaptarr,
} from '@server/lib/chaptarrRequests';
import type { ChaptarrSettings } from '@server/lib/settings';

const WORK_ID = 'OL66554W';

mock.method(
  OpenLibrary.prototype,
  'getWorkSummary',
  async (): Promise<OlSearchDoc> => ({
    key: `/works/${WORK_ID}`,
    title: 'Pride and Prejudice',
    author_name: ['Jane Austen'],
  })
);
let workIsbns: string[] = [];
mock.method(OpenLibrary.prototype, 'getWorkIsbns', async () => workIsbns);

const book = (overrides: Partial<ChaptarrBook>): ChaptarrBook => ({
  title: 'Pride and Prejudice',
  foreignBookId: 'gr:3060926',
  monitored: false,
  author: { authorName: 'Jane Austen', foreignAuthorId: 'gr:1265' },
  editions: [],
  ratings: { votes: 100 },
  ...overrides,
});

/**
 * Chaptarr with a library and a metadata search, recording what is asked
 * of it
 */
class FakeChaptarr {
  public library: ChaptarrBook[] = [];
  public lookupResults: Record<string, ChaptarrBook[]> = {};
  public files: Record<number, number[]> = {};
  public addResult?: (
    book: ChaptarrBook,
    options: ChaptarrAddBookOptions
  ) => ChaptarrAddBookResult;
  public pendingOutcome: ChaptarrPendingResult = 'succeeded';
  public editions: Record<number, ChaptarrEdition[]> = {};
  public editionUpdateError?: Error;

  public lookups: string[] = [];
  public added: { foreignBookId: string; options: ChaptarrAddBookOptions }[] =
    [];
  public monitored: [number[], boolean][] = [];
  public searched: number[][] = [];
  public deletedFiles: number[][] = [];
  public removedAuthors: number[] = [];
  public waited: number[] = [];
  public authorFormats: [number, ChaptarrMediaType, string][] = [];
  public editionUpdates: [number, ChaptarrEdition[]][] = [];
  // Edition updates and searches in the order they were asked for
  public events: string[] = [];

  async lookupBooks(term: string, mediaType?: ChaptarrMediaType) {
    this.lookups.push(mediaType ? `${term}|${mediaType}` : term);
    return this.lookupResults[term] ?? [];
  }

  async getBook(bookId: number) {
    return this.library.find((libraryBook) => libraryBook.id === bookId);
  }

  async getBooksByAuthor(authorId: number) {
    return this.library.filter(
      (libraryBook) => libraryBook.authorId === authorId
    );
  }

  async addBook(
    added: ChaptarrBook,
    options: ChaptarrAddBookOptions
  ): Promise<ChaptarrAddBookResult> {
    this.added.push({ foreignBookId: added.foreignBookId, options });

    if (this.addResult) {
      return this.addResult(added, options);
    }

    const newBook = book({
      ...added,
      id: 100 + this.library.length,
      mediaType: options.mediaType,
      monitored: true,
    });
    this.library.push(newBook);
    return { status: 'added', book: newBook };
  }

  async waitForPendingImport(pendingId: number) {
    this.waited.push(pendingId);
    return this.pendingOutcome;
  }

  async setBooksMonitored(bookIds: number[], monitored: boolean) {
    this.monitored.push([bookIds, monitored]);
  }

  async searchBooks(bookIds: number[]) {
    this.searched.push(bookIds);
    this.events.push(`search:${bookIds.join(',')}`);
  }

  async getEditions(bookId: number) {
    return this.editions[bookId] ?? [];
  }

  async updateBookEditions(bookId: number, editions: ChaptarrEdition[]) {
    this.events.push(`editions:${bookId}`);

    if (this.editionUpdateError) {
      throw this.editionUpdateError;
    }

    this.editionUpdates.push([bookId, editions]);
  }

  async enableAuthorFormat(
    authorId: number,
    mediaType: ChaptarrMediaType,
    format: { rootFolderPath: string }
  ) {
    this.authorFormats.push([authorId, mediaType, format.rootFolderPath]);
    return true;
  }

  async getBookFiles(bookId: number) {
    return (this.files[bookId] ?? []).map((id) => ({ id, bookId }));
  }

  async deleteBookFiles(bookFileIds: number[]) {
    this.deletedFiles.push(bookFileIds);
  }

  async removeAuthor(authorId: number) {
    this.removedAuthors.push(authorId);
  }
}

const asApi = (fake: FakeChaptarr) => fake as unknown as ChaptarrAPI;

const add = {
  qualityProfileId: 1,
  metadataProfileId: 2,
  rootFolderPath: '/ebooks',
  tags: [],
  searchForNewBook: true,
};

describe('pickChaptarrMatch', () => {
  const wanted = {
    title: 'Pride and Prejudice',
    authorName: 'Jane Austen',
    isbns: [],
  };

  it('prefers a result with a requested ISBN', () => {
    const results = [
      book({ foreignBookId: 'gr:1' }),
      book({
        foreignBookId: 'gr:2',
        title: 'Pride & Prejudice (Penguin Classics)',
        editions: [{ isbn13: '978-0-14-143951-8' }],
      }),
    ];

    assert.strictEqual(
      pickChaptarrMatch(results, { ...wanted, isbns: ['9780141439518'] })
        ?.foreignBookId,
      'gr:2'
    );
  });

  it('matches the same title by the same author', () => {
    const results = [
      book({
        foreignBookId: 'gr:63927267',
        title:
          'The Complete Novels of Jane Austen, Vol 1: Sense & Sensibility/Pride & Prejudice/Mansfield Park',
      }),
      book({
        foreignBookId: 'gr:6072122',
        title: 'Pride and Prejudice and Zombies',
        author: {
          authorName: 'Seth Grahame-Smith',
          foreignAuthorId: 'gr:2',
        },
      }),
      book({ foreignBookId: 'gr:3060926' }),
    ];

    assert.strictEqual(
      pickChaptarrMatch(results, wanted)?.foreignBookId,
      'gr:3060926'
    );
  });

  it('compares authors on their surname', () => {
    const results = [
      book({
        author: { authorName: 'Austen, Jane', foreignAuthorId: 'gr:1265' },
      }),
    ];

    assert.ok(pickChaptarrMatch(results, wanted));
  });

  it('refuses the same title by another author', () => {
    const results = [
      book({
        author: { authorName: 'Someone Else', foreignAuthorId: 'gr:9' },
      }),
    ];

    assert.strictEqual(pickChaptarrMatch(results, wanted), undefined);
  });

  it('matches a title without its subtitle and picks the most rated', () => {
    const results = [
      book({
        foreignBookId: 'gr:few',
        title: 'Pride and Prejudice: A Novel',
        ratings: { votes: 3 },
      }),
      book({
        foreignBookId: 'gr:many',
        title: 'Pride and Prejudice: Annotated',
        ratings: { votes: 3000 },
      }),
    ];

    assert.strictEqual(
      pickChaptarrMatch(results, wanted)?.foreignBookId,
      'gr:many'
    );
  });

  it('prefers a result with an edition in the requested language', () => {
    const results = [
      book({
        foreignBookId: 'gr:danish',
        editions: [{ language: 'dan' }],
        ratings: { votes: 3000 },
      }),
      book({
        foreignBookId: 'gr:english',
        editions: [{ language: 'eng' }],
        ratings: { votes: 3 },
      }),
    ];

    assert.strictEqual(
      pickChaptarrMatch(results, { ...wanted, language: 'en' })?.foreignBookId,
      'gr:english'
    );
    assert.strictEqual(
      pickChaptarrMatch(results, { ...wanted, language: 'any' })?.foreignBookId,
      'gr:danish'
    );
  });
});

describe('isSameBookTitle', () => {
  it('matches a title with or without its subtitle or series', () => {
    assert.ok(
      isSameBookTitle(
        "Carl's Doomsday Scenario",
        "Carl's Doomsday Scenario: Dungeon Crawler Carl Book 2"
      )
    );
    assert.ok(
      isSameBookTitle('Skyshade (The Lightlark, #3)', 'Skyshade: A Novel')
    );
    assert.ok(
      isSameBookTitle(
        'He Who Fights with Monsters 6',
        'He Who Fights with Monsters 6'
      )
    );
  });

  it('refuses books that only share a main title or a series name', () => {
    assert.ok(
      !isSameBookTitle(
        'True Crime Stories: A Prequel',
        'True Crime Stories: 12 Shocking Cases'
      )
    );
    assert.ok(
      !isSameBookTitle(
        'He Who Fights with Monsters 6',
        'He Who Fights with Monsters 7'
      )
    );
    assert.ok(!isSameBookTitle('', ''));
  });
});

describe('preferEditionInLanguage', () => {
  it('monitors the first edition in the requested language', () => {
    const editions = [
      { foreignEditionId: 'gr:1', language: 'dan', monitored: true },
      { foreignEditionId: 'gr:2', language: 'eng', monitored: false },
      { foreignEditionId: 'gr:3', language: 'eng', monitored: false },
    ];

    assert.deepStrictEqual(
      preferEditionInLanguage(book({ editions }), 'en').editions?.map(
        (edition) => [edition.foreignEditionId, edition.monitored]
      ),
      [
        ['gr:1', false],
        ['gr:2', true],
        ['gr:3', false],
      ]
    );
  });

  it('keeps the editions when none names the language', () => {
    const result = book({ editions: [{ foreignEditionId: 'gr:1' }] });

    assert.strictEqual(preferEditionInLanguage(result, 'en'), result);
    assert.strictEqual(preferEditionInLanguage(result, 'any'), result);
  });
});

describe('getChaptarrFormatSettings', () => {
  const server = {
    name: 'Chaptarr',
    activeProfileId: 1,
    activeMetadataProfileId: 2,
    activeDirectory: '/ebooks',
    activeAudiobookProfileId: 2,
    activeAudiobookMetadataProfileId: 1,
    activeAudiobookDirectory: '/audiobooks',
  } as ChaptarrSettings;

  it('uses the settings of the requested format', () => {
    assert.deepStrictEqual(getChaptarrFormatSettings(server, 'audiobook'), {
      qualityProfileId: 2,
      metadataProfileId: 1,
      rootFolderPath: '/audiobooks',
    });
  });

  it('refuses a format the server is not set up for', () => {
    assert.throws(() =>
      getChaptarrFormatSettings(
        { ...server, activeAudiobookDirectory: undefined },
        'audiobook'
      )
    );
  });
});

describe('sendBookToChaptarr', () => {
  let chaptarr: FakeChaptarr;

  beforeEach(() => {
    chaptarr = new FakeChaptarr();
    workIsbns = [];
  });

  it('adds a new ebook found by title and author', async () => {
    chaptarr.lookupResults['Pride and Prejudice'] = [book({})];

    const result = await sendBookToChaptarr(asApi(chaptarr), {
      olId: WORK_ID,
      mediaType: 'ebook',
      add,
    });

    assert.deepStrictEqual(chaptarr.lookups, [
      'Pride and Prejudice Jane Austen',
      'Pride and Prejudice',
      'gr:3060926|ebook',
    ]);
    assert.deepStrictEqual(chaptarr.added, [
      {
        foreignBookId: 'gr:3060926',
        options: { ...add, mediaType: 'ebook' },
      },
    ]);
    assert.deepStrictEqual(result, {
      bookId: 100,
      foreignBookId: 'gr:3060926',
    });
    // Chaptarr does not search for a book added with its author on its own
    assert.deepStrictEqual(chaptarr.searched, [[100]]);
  });

  it('uses an existing entry when Chaptarr has the book twice', async () => {
    const author = {
      id: 7,
      authorName: 'Jane Austen',
      foreignAuthorId: 'gr:1265',
    };
    chaptarr.lookupResults['Pride and Prejudice'] = [book({ author })];
    chaptarr.library = [
      book({ id: 50, authorId: 7, mediaType: 'audiobook', author }),
      book({ id: 51, authorId: 7, mediaType: 'audiobook', author }),
      book({ id: 52, authorId: 7, mediaType: 'ebook', author }),
    ];
    chaptarr.addResult = () => {
      throw Object.assign(
        new Error('[Chaptarr] Failed to add book: status code 500'),
        {
          cause: {
            response: {
              status: 500,
              data: {
                message:
                  'Requested work gr:3060926 resolves to multiple local Audiobook books.',
              },
            },
          },
        }
      );
    };

    const result = await sendBookToChaptarr(asApi(chaptarr), {
      olId: WORK_ID,
      mediaType: 'audiobook',
      add,
    });

    assert.strictEqual(result.bookId, 50);
    assert.deepStrictEqual(chaptarr.monitored.at(-1), [[50], true]);
  });

  it('finds the duplicates of a new author whose lookup had no id yet', async () => {
    const seriesTitle = 'Pride and Prejudice (Austen, #2)';
    // First lookup, before Chaptarr knew the author
    chaptarr.lookupResults['Pride and Prejudice'] = [
      book({ title: seriesTitle }),
    ];
    // The lookup after the failed add carries the new author's id
    chaptarr.lookupResults['gr:3060926'] = [
      book({
        author: { id: 9, authorName: 'Jane Austen', foreignAuthorId: 'hc:1' },
      }),
    ];
    chaptarr.library = [
      book({ id: 60, authorId: 9, mediaType: 'audiobook' }),
      book({ id: 61, authorId: 9, mediaType: 'audiobook' }),
    ];
    let failed = false;
    chaptarr.addResult = () => {
      failed = true;
      throw Object.assign(new Error('[Chaptarr] Failed to add book'), {
        cause: {
          response: {
            status: 500,
            data: {
              message:
                'Requested work gr:3060926 resolves to multiple local Audiobook books.',
            },
          },
        },
      });
    };

    const result = await sendBookToChaptarr(asApi(chaptarr), {
      olId: WORK_ID,
      mediaType: 'audiobook',
      add,
    });

    assert.ok(failed);
    assert.strictEqual(result.bookId, 60);
  });

  it('picks the duplicate of the same work, not a book sharing the main title', async () => {
    const author = {
      id: 15,
      authorName: 'Jack Rosewood',
      foreignAuthorId: 'gr:9',
    };
    const wanted = 'True Crime Stories: 12 Shocking True Crime Murder Cases';
    chaptarr.lookupResults['hc:1348108'] = [
      book({ title: wanted, foreignBookId: 'hc:1348108', author }),
    ];
    chaptarr.library = [
      // Older, shares "True Crime Stories" but is another book
      book({
        id: 7323,
        authorId: 15,
        mediaType: 'audiobook',
        title: 'True Crime Stories: A Prequel',
        foreignBookId: 'hc:999',
        author,
      }),
      book({
        id: 7325,
        authorId: 15,
        mediaType: 'audiobook',
        title: wanted,
        foreignBookId: 'hc:1348108',
        author,
      }),
      book({
        id: 7408,
        authorId: 15,
        mediaType: 'audiobook',
        title: wanted,
        foreignBookId: 'hc:1348108',
        author,
      }),
    ];
    chaptarr.addResult = () => {
      throw Object.assign(new Error('[Chaptarr] Failed to add book'), {
        cause: {
          response: {
            status: 500,
            data: {
              message:
                'Requested work hc:1348108 resolves to multiple local Audiobook books.',
            },
          },
        },
      });
    };

    const result = await sendBookToChaptarr(asApi(chaptarr), {
      olId: WORK_ID,
      foreignBookId: 'hc:1348108',
      mediaType: 'audiobook',
      add,
    });

    assert.strictEqual(result.bookId, 7325);
  });

  it('still fails on other add errors', async () => {
    chaptarr.lookupResults['Pride and Prejudice'] = [book({})];
    chaptarr.addResult = () => {
      throw Object.assign(
        new Error('[Chaptarr] Failed to add book: status code 500'),
        { cause: { response: { status: 500, data: { message: 'Boom' } } } }
      );
    };

    await assert.rejects(
      sendBookToChaptarr(asApi(chaptarr), {
        olId: WORK_ID,
        mediaType: 'audiobook',
        add,
      }),
      /Failed to add book/
    );
  });

  it('adds a new book with the language tag', async () => {
    chaptarr.lookupResults['Pride and Prejudice'] = [book({})];

    await sendBookToChaptarr(asApi(chaptarr), {
      olId: WORK_ID,
      mediaType: 'ebook',
      add: { ...add, tags: [3] },
      language: { code: 'en', tags: { tagId: 4, managedTagIds: [4] } },
    });

    assert.deepStrictEqual(chaptarr.added[0].options.tags, [3, 4]);
  });

  it('looks the book up by its ISBNs first', async () => {
    workIsbns = ['9780141439518'];
    chaptarr.lookupResults['isbn:9780141439518'] = [book({})];

    await sendBookToChaptarr(asApi(chaptarr), {
      olId: WORK_ID,
      mediaType: 'ebook',
      add,
    });

    assert.deepStrictEqual(chaptarr.lookups, [
      'isbn:9780141439518',
      'gr:3060926|ebook',
    ]);
    assert.strictEqual(chaptarr.added.length, 1);
  });

  it('monitors and searches the audiobook Chaptarr already has', async () => {
    chaptarr.library = [
      book({ id: 7, mediaType: 'audiobook', monitored: false }),
    ];
    chaptarr.lookupResults['Pride and Prejudice Jane Austen'] = [
      book({
        mediaType: 'audiobook',
        localAudiobookBooks: [{ id: 7, mediaType: 'audiobook' }],
      }),
    ];

    const result = await sendBookToChaptarr(asApi(chaptarr), {
      olId: WORK_ID,
      mediaType: 'audiobook',
      add,
    });

    assert.strictEqual(chaptarr.added.length, 0);
    assert.deepStrictEqual(chaptarr.monitored, [[[7], true]]);
    assert.deepStrictEqual(chaptarr.searched, [[7]]);
    assert.strictEqual(result.bookId, 7);
  });

  it('turns on the format for an author first added for the other one', async () => {
    chaptarr.library = [
      book({ id: 7, mediaType: 'audiobook', monitored: false, authorId: 3 }),
    ];
    chaptarr.lookupResults['Pride and Prejudice Jane Austen'] = [
      book({
        mediaType: 'audiobook',
        localAudiobookBooks: [{ id: 7, mediaType: 'audiobook' }],
      }),
    ];

    await sendBookToChaptarr(asApi(chaptarr), {
      olId: WORK_ID,
      mediaType: 'audiobook',
      add,
    });

    // Chaptarr refuses automatic grabs for an author whose format is off
    assert.deepStrictEqual(chaptarr.authorFormats, [
      [3, 'audiobook', add.rootFolderPath],
    ]);
    assert.deepStrictEqual(chaptarr.searched, [[7]]);
  });

  it('finds a book Chaptarr keeps under another provider by its work id', async () => {
    chaptarr.library = [
      book({ id: 212, mediaType: 'ebook', foreignBookId: 'hc:194793' }),
    ];
    // The metadata search does not list the library book
    chaptarr.lookupResults['Pride and Prejudice Jane Austen'] = [book({})];
    chaptarr.lookupResults['gr:3060926'] = [
      book({
        foreignBookId: 'hc:194793',
        localEbookBooks: [{ id: 212, mediaType: 'ebook' }],
      }),
    ];

    const result = await sendBookToChaptarr(asApi(chaptarr), {
      olId: WORK_ID,
      mediaType: 'ebook',
      add,
    });

    assert.strictEqual(chaptarr.added.length, 0);
    assert.ok(chaptarr.lookups.includes('gr:3060926|ebook'));
    assert.deepStrictEqual(result, { bookId: 212, foreignBookId: 'hc:194793' });
  });

  it('adds the ebook of a book Chaptarr only has as an audiobook', async () => {
    chaptarr.lookupResults['Pride and Prejudice Jane Austen'] = [
      book({
        mediaType: 'audiobook',
        localAudiobookBooks: [{ id: 7, mediaType: 'audiobook' }],
      }),
    ];

    await sendBookToChaptarr(asApi(chaptarr), {
      olId: WORK_ID,
      mediaType: 'ebook',
      add,
    });

    assert.deepStrictEqual(
      chaptarr.added.map(({ options }) => options.mediaType),
      ['ebook']
    );
  });

  it('uses the book id remembered from an earlier request', async () => {
    chaptarr.library = [book({ id: 12, mediaType: 'ebook', monitored: true })];

    const result = await sendBookToChaptarr(asApi(chaptarr), {
      olId: WORK_ID,
      mediaType: 'ebook',
      bookId: 12,
      add,
    });

    assert.deepStrictEqual(chaptarr.lookups, []);
    assert.deepStrictEqual(chaptarr.monitored, []);
    assert.deepStrictEqual(chaptarr.searched, [[12]]);
    assert.strictEqual(result.bookId, 12);
  });

  describe('when Chaptarr holds the book twice under its author', () => {
    // The lookup points at an empty duplicate from another metadata source
    const lookupDuplicate = () => {
      chaptarr.lookupResults['Pride and Prejudice Jane Austen'] = [
        book({
          foreignBookId: 'hc:2',
          localEbookBooks: [{ id: 21, mediaType: 'ebook' }],
        }),
      ];
    };
    const duplicate = book({
      id: 21,
      authorId: 7,
      mediaType: 'ebook',
      foreignBookId: 'hc:2',
      title: 'Pride and Prejudice: Annotated Edition',
      statistics: { bookFileCount: 0 },
    });

    it('uses the entry that has the file', async () => {
      lookupDuplicate();
      chaptarr.library = [
        duplicate,
        book({
          id: 19,
          authorId: 7,
          mediaType: 'ebook',
          ebookMonitored: true,
          statistics: { bookFileCount: 1 },
        }),
      ];

      const result = await sendBookToChaptarr(asApi(chaptarr), {
        olId: WORK_ID,
        mediaType: 'ebook',
        add,
      });

      assert.strictEqual(result.bookId, 19);
      assert.strictEqual(chaptarr.added.length, 0);
      assert.deepStrictEqual(chaptarr.monitored, []);
      assert.deepStrictEqual(chaptarr.searched, []);
    });

    it('uses the entry already monitored for the format', async () => {
      lookupDuplicate();
      chaptarr.library = [
        duplicate,
        book({
          id: 19,
          authorId: 7,
          mediaType: 'ebook',
          ebookMonitored: true,
          statistics: { bookFileCount: 0 },
        }),
      ];

      const result = await sendBookToChaptarr(asApi(chaptarr), {
        olId: WORK_ID,
        mediaType: 'ebook',
        add,
      });

      assert.strictEqual(result.bookId, 19);
      assert.deepStrictEqual(chaptarr.monitored, []);
      assert.deepStrictEqual(chaptarr.searched, [[19]]);
    });

    it('ignores the other format and books that only share a main title', async () => {
      lookupDuplicate();
      chaptarr.library = [
        duplicate,
        book({
          id: 19,
          authorId: 7,
          mediaType: 'audiobook',
          audiobookMonitored: true,
          statistics: { bookFileCount: 1 },
        }),
        book({
          id: 20,
          authorId: 7,
          mediaType: 'ebook',
          title: 'Pride and Prejudice: A Sequel',
          ebookMonitored: true,
          statistics: { bookFileCount: 1 },
        }),
      ];

      const result = await sendBookToChaptarr(asApi(chaptarr), {
        olId: WORK_ID,
        mediaType: 'ebook',
        add,
      });

      assert.strictEqual(result.bookId, 21);
      assert.deepStrictEqual(chaptarr.monitored, [[[21], true]]);
      assert.deepStrictEqual(chaptarr.searched, [[21]]);
    });

    it('links an unlinked book to the entry that has the file', async () => {
      lookupDuplicate();
      chaptarr.library = [
        duplicate,
        book({
          id: 19,
          authorId: 7,
          mediaType: 'ebook',
          statistics: { bookFileCount: 1 },
        }),
      ];

      const found = await matchChaptarrLibraryBook(
        asApi(chaptarr),
        WORK_ID,
        'ebook'
      );

      assert.strictEqual(found?.id, 19);
    });
  });

  it('does not search when automatic search is off', async () => {
    chaptarr.library = [book({ id: 12, mediaType: 'ebook' })];

    await sendBookToChaptarr(asApi(chaptarr), {
      olId: WORK_ID,
      mediaType: 'ebook',
      bookId: 12,
      add: { ...add, searchForNewBook: false },
    });

    assert.deepStrictEqual(chaptarr.monitored, [[[12], true]]);
    assert.deepStrictEqual(chaptarr.searched, []);
  });

  it('waits for a pending author import, then monitors and searches', async () => {
    chaptarr.lookupResults['Pride and Prejudice Jane Austen'] = [book({})];
    chaptarr.addResult = () => {
      // The author import adds the author's books, unmonitored
      chaptarr.library.push(book({ id: 40, mediaType: 'ebook' }));
      chaptarr.lookupResults['gr:3060926'] = [
        book({ id: 40, mediaType: 'ebook' }),
      ];
      return { status: 'pending', pendingId: 5 };
    };

    const result = await sendBookToChaptarr(asApi(chaptarr), {
      olId: WORK_ID,
      mediaType: 'ebook',
      add,
    });

    assert.deepStrictEqual(chaptarr.waited, [5]);
    assert.ok(chaptarr.lookups.includes('gr:3060926|ebook'));
    assert.deepStrictEqual(chaptarr.monitored, [[[40], true]]);
    assert.deepStrictEqual(chaptarr.searched, [[40]]);
    assert.deepStrictEqual(result, { bookId: 40, foreignBookId: 'gr:3060926' });
  });

  it('leaves a slow author import to Chaptarr', async () => {
    chaptarr.lookupResults['Pride and Prejudice Jane Austen'] = [book({})];
    chaptarr.addResult = () => ({ status: 'pending', pendingId: 6 });
    chaptarr.pendingOutcome = 'timeout';

    const result = await sendBookToChaptarr(asApi(chaptarr), {
      olId: WORK_ID,
      mediaType: 'audiobook',
      add,
    });

    assert.deepStrictEqual(result, {
      foreignBookId: 'gr:3060926',
      pendingId: 6,
    });

    // A second book of the same author does not wait for it again
    await sendBookToChaptarr(asApi(chaptarr), {
      olId: WORK_ID,
      mediaType: 'audiobook',
      add,
    });
    assert.deepStrictEqual(chaptarr.waited, [6]);
  });

  it('waits for a book Chaptarr was still adding when the add timed out', async () => {
    chaptarr.lookupResults['Pride and Prejudice Jane Austen'] = [book({})];
    chaptarr.addResult = () => {
      // Chaptarr keeps the book under another provider's id, and finds it
      // by the work id of the lookup result
      chaptarr.library.push(
        book({ id: 212, mediaType: 'ebook', foreignBookId: 'hc:194793' })
      );
      chaptarr.lookupResults['gr:3060926'] = [
        book({
          foreignBookId: 'hc:194793',
          localEbookBooks: [{ id: 212, mediaType: 'ebook' }],
        }),
      ];
      return { status: 'timeout' };
    };

    const result = await sendBookToChaptarr(asApi(chaptarr), {
      olId: WORK_ID,
      mediaType: 'ebook',
      add,
    });

    assert.deepStrictEqual(result, { bookId: 212, foreignBookId: 'hc:194793' });
    assert.deepStrictEqual(chaptarr.monitored, [[[212], true]]);
    assert.deepStrictEqual(chaptarr.searched, [[212]]);
  });

  it('fails when the author import fails', async () => {
    chaptarr.lookupResults['Pride and Prejudice Jane Austen'] = [book({})];
    chaptarr.addResult = () => ({ status: 'pending', pendingId: 8 });
    chaptarr.pendingOutcome = 'failed';

    await assert.rejects(
      sendBookToChaptarr(asApi(chaptarr), {
        olId: WORK_ID,
        mediaType: 'ebook',
        add,
      })
    );
  });

  it('fails when Chaptarr has no match', async () => {
    await assert.rejects(
      sendBookToChaptarr(asApi(chaptarr), {
        olId: WORK_ID,
        mediaType: 'ebook',
        add,
      }),
      /no match for Pride and Prejudice by Jane Austen/
    );
  });

  describe('the edition in the requested language', () => {
    const english = {
      code: 'en' as const,
    };
    const request = (
      mediaType: ChaptarrMediaType,
      language: { code: 'en' | 'any' } | null = english
    ) => ({
      olId: WORK_ID,
      mediaType,
      bookId: 30,
      add,
      language: language ?? undefined,
    });
    const monitoredEditions = (bookId = 30) =>
      chaptarr.editionUpdates
        .filter(([id]) => id === bookId)
        .at(-1)?.[1]
        .filter((edition) => edition.monitored)
        .map((edition) => edition.foreignEditionId);

    it('monitors an English audiobook edition before searching', async () => {
      chaptarr.library = [
        book({ id: 30, mediaType: 'audiobook', title: 'Juego de dos' }),
      ];
      chaptarr.editions[30] = [
        {
          foreignEditionId: 'e:spa',
          title: 'Juego de dos',
          language: 'spa',
          format: 'Audible Audio',
          monitored: true,
        },
        {
          foreignEditionId: 'e:eng-ebook',
          title: 'Two Can Play',
          language: 'eng',
          format: 'Kindle Edition',
          monitored: false,
        },
        {
          foreignEditionId: 'e:eng-audio',
          title: 'Two Can Play',
          language: 'eng',
          format: 'Audiobook',
          monitored: false,
        },
      ];

      const result = await sendBookToChaptarr(
        asApi(chaptarr),
        request('audiobook')
      );

      assert.strictEqual(result.bookId, 30);
      assert.deepStrictEqual(monitoredEditions(), ['e:eng-audio']);
      assert.deepStrictEqual(chaptarr.events, ['editions:30', 'search:30']);
    });

    it('falls back to the language in another format', async () => {
      chaptarr.library = [book({ id: 30, mediaType: 'audiobook' })];
      chaptarr.editions[30] = [
        {
          foreignEditionId: 'e:deu',
          language: 'deu',
          format: 'Audio CD',
          monitored: true,
        },
        {
          foreignEditionId: 'e:eng-ebook',
          language: 'eng',
          format: 'ebook',
          monitored: false,
        },
      ];

      await sendBookToChaptarr(asApi(chaptarr), request('audiobook'));

      assert.deepStrictEqual(monitoredEditions(), ['e:eng-ebook']);
    });

    it('picks an undetermined edition under the English title', async () => {
      chaptarr.library = [book({ id: 30, mediaType: 'audiobook' })];
      chaptarr.editions[30] = [
        {
          foreignEditionId: 'e:por',
          title: 'Orgulho e Preconceito',
          language: 'por',
          monitored: true,
        },
        {
          foreignEditionId: 'e:und-other',
          title: 'Orgueil et Préjugés',
          language: 'und',
          monitored: false,
        },
        {
          foreignEditionId: 'e:und',
          title: 'Pride and Prejudice',
          language: 'und',
          monitored: false,
        },
      ];

      await sendBookToChaptarr(asApi(chaptarr), request('audiobook'));

      assert.deepStrictEqual(monitoredEditions(), ['e:und']);
    });

    it('leaves the editions when none fits', async () => {
      chaptarr.library = [book({ id: 30, mediaType: 'audiobook' })];
      chaptarr.editions[30] = [
        {
          foreignEditionId: 'e:por',
          title: 'Orgulho e Preconceito',
          language: 'por',
          monitored: true,
        },
      ];

      await sendBookToChaptarr(asApi(chaptarr), request('audiobook'));

      assert.deepStrictEqual(chaptarr.editionUpdates, []);
      assert.deepStrictEqual(chaptarr.searched, [[30]]);
    });

    it('does not save editions that are right already', async () => {
      chaptarr.library = [book({ id: 30, mediaType: 'ebook' })];
      chaptarr.editions[30] = [
        { foreignEditionId: 'e:spa', language: 'spa', monitored: false },
        { foreignEditionId: 'e:eng', language: 'eng', monitored: true },
      ];

      await sendBookToChaptarr(asApi(chaptarr), request('ebook'));

      assert.deepStrictEqual(chaptarr.editionUpdates, []);
    });

    it('saves repeated editions only once', async () => {
      chaptarr.library = [book({ id: 30, mediaType: 'ebook' })];
      chaptarr.editions[30] = [
        { foreignEditionId: 'e:por', language: 'por', monitored: true },
        { foreignEditionId: 'e:eng', language: 'eng', monitored: false },
        { foreignEditionId: 'e:eng', language: 'eng', monitored: false },
        { foreignEditionId: 'e:por', language: 'por', monitored: true },
      ];

      await sendBookToChaptarr(asApi(chaptarr), request('ebook'));

      assert.deepStrictEqual(
        chaptarr.editionUpdates[0][1].map((edition) => [
          edition.foreignEditionId,
          edition.monitored,
        ]),
        [
          ['e:por', false],
          ['e:eng', true],
        ]
      );
    });

    it('still monitors and searches when saving the edition fails', async () => {
      chaptarr.library = [book({ id: 30, mediaType: 'ebook' })];
      chaptarr.editions[30] = [
        { foreignEditionId: 'e:por', language: 'por', monitored: true },
        { foreignEditionId: 'e:eng', language: 'eng', monitored: false },
      ];
      chaptarr.editionUpdateError = new Error(
        '[Chaptarr] Failed to update book editions: Sequence contains more than one matching element'
      );

      const result = await sendBookToChaptarr(
        asApi(chaptarr),
        request('ebook')
      );

      assert.strictEqual(result.bookId, 30);
      assert.deepStrictEqual(chaptarr.monitored, [[[30], true]]);
      assert.deepStrictEqual(chaptarr.searched, [[30]]);
    });

    it('leaves the editions alone without a language', async () => {
      chaptarr.library = [book({ id: 30, mediaType: 'ebook' })];
      chaptarr.editions[30] = [
        { foreignEditionId: 'e:por', language: 'por', monitored: true },
        { foreignEditionId: 'e:eng', language: 'eng', monitored: false },
      ];

      await sendBookToChaptarr(asApi(chaptarr), request('ebook', null));
      await sendBookToChaptarr(
        asApi(chaptarr),
        request('ebook', { code: 'any' })
      );

      assert.deepStrictEqual(chaptarr.editionUpdates, []);
      assert.deepStrictEqual(chaptarr.events, ['search:30', 'search:30']);
    });

    it('fixes the edition of a duplicate entry', async () => {
      const author = {
        id: 7,
        authorName: 'Jane Austen',
        foreignAuthorId: 'gr:1265',
      };
      chaptarr.lookupResults['Pride and Prejudice'] = [book({ author })];
      chaptarr.library = [
        book({ id: 50, authorId: 7, mediaType: 'ebook', author }),
        book({ id: 51, authorId: 7, mediaType: 'ebook', author }),
      ];
      chaptarr.editions[50] = [
        { foreignEditionId: 'e:spa', language: 'spa', monitored: true },
        { foreignEditionId: 'e:eng', language: 'eng', monitored: false },
      ];
      chaptarr.addResult = () => {
        throw Object.assign(new Error('[Chaptarr] Failed to add book'), {
          cause: {
            response: {
              status: 500,
              data: {
                message:
                  'Requested work gr:3060926 resolves to multiple local Ebook books.',
              },
            },
          },
        });
      };

      const result = await sendBookToChaptarr(asApi(chaptarr), {
        olId: WORK_ID,
        mediaType: 'ebook',
        add,
        language: english,
      });

      assert.strictEqual(result.bookId, 50);
      assert.deepStrictEqual(monitoredEditions(50), ['e:eng']);
      assert.deepStrictEqual(chaptarr.events, ['editions:50', 'search:50']);
    });

    it('adds a new book with the edition in the language and format', async () => {
      chaptarr.lookupResults['Pride and Prejudice'] = [
        book({
          editions: [
            { foreignEditionId: 'e:spa', language: 'spa', monitored: true },
            { foreignEditionId: 'e:eng', language: 'eng', format: 'Paperback' },
            {
              foreignEditionId: 'e:eng-audio',
              language: 'eng',
              format: 'Audible Audio',
            },
          ],
        }),
      ];
      let addedEditions: ChaptarrEdition[] | undefined;
      chaptarr.addResult = (added) => {
        addedEditions = added.editions;
        return { status: 'pending', pendingId: 903 };
      };
      chaptarr.pendingOutcome = 'timeout';

      await sendBookToChaptarr(asApi(chaptarr), {
        olId: WORK_ID,
        mediaType: 'audiobook',
        add,
        language: english,
      });

      assert.deepStrictEqual(
        addedEditions
          ?.filter((edition) => edition.monitored)
          .map((edition) => edition.foreignEditionId),
        ['e:eng-audio']
      );
    });
  });
});

describe('removeBookFromChaptarr', () => {
  let chaptarr: FakeChaptarr;

  beforeEach(() => {
    chaptarr = new FakeChaptarr();
    chaptarr.library = [
      book({ id: 1, authorId: 3, mediaType: 'ebook', monitored: true }),
      book({ id: 2, authorId: 3, mediaType: 'audiobook', monitored: true }),
      // Another book of the author from its catalog, never requested
      book({ id: 9, authorId: 3, mediaType: 'ebook', title: 'Emma' }),
    ];
    chaptarr.files = { 1: [11, 12], 2: [21] };
  });

  it('deletes the files of the requested format and unmonitors it', async () => {
    const result = await removeBookFromChaptarr(
      asApi(chaptarr),
      { externalServiceId: 1, externalServiceIdAudio: 2 },
      ['audiobook']
    );

    assert.deepStrictEqual(chaptarr.deletedFiles, [[21]]);
    assert.deepStrictEqual(chaptarr.monitored, [[[2], false]]);
    // The ebook is still monitored, so the author stays
    assert.deepStrictEqual(result, {
      removedBookIds: [2],
      removedAuthorIds: [],
    });
  });

  it('removes the author once nothing of theirs is left', async () => {
    const result = await removeBookFromChaptarr(
      asApi(chaptarr),
      { externalServiceId: 1, externalServiceIdAudio: 2 },
      ['ebook', 'audiobook']
    );

    assert.deepStrictEqual(chaptarr.deletedFiles, [[11, 12], [21]]);
    assert.deepStrictEqual(result.removedAuthorIds, [3]);
  });

  it('finds a book without a remembered id by its work id', async () => {
    chaptarr.lookupResults['gr:3060926'] = [
      book({
        id: 2,
        mediaType: 'audiobook',
        localEbookBooks: [{ id: 1, mediaType: 'ebook' }],
      }),
    ];

    const result = await removeBookFromChaptarr(
      asApi(chaptarr),
      { foreignBookId: 'gr:3060926' },
      ['ebook']
    );

    assert.deepStrictEqual(result.removedBookIds, [1]);
    assert.deepStrictEqual(chaptarr.deletedFiles, [[11, 12]]);
  });
});

describe('matchChaptarrLibraryBook', () => {
  let chaptarr: FakeChaptarr;

  beforeEach(() => {
    chaptarr = new FakeChaptarr();
    workIsbns = [];
  });

  it('finds the audiobook Chaptarr has for an unlinked book', async () => {
    chaptarr.library = [book({ id: 9, mediaType: 'audiobook' })];
    chaptarr.lookupResults['Pride and Prejudice Jane Austen'] = [
      book({
        mediaType: 'audiobook',
        localAudiobookBooks: [{ id: 9, mediaType: 'audiobook' }],
      }),
    ];

    const found = await matchChaptarrLibraryBook(
      asApi(chaptarr),
      WORK_ID,
      'audiobook'
    );

    assert.strictEqual(found?.id, 9);
    assert.strictEqual(chaptarr.added.length, 0);
  });

  it('finds nothing when Chaptarr does not have that format', async () => {
    chaptarr.lookupResults['Pride and Prejudice Jane Austen'] = [
      book({ mediaType: 'ebook' }),
    ];

    const found = await matchChaptarrLibraryBook(
      asApi(chaptarr),
      WORK_ID,
      'audiobook'
    );

    assert.strictEqual(found, undefined);
  });
});

describe('prepareChaptarrBookSearch', () => {
  it('monitors the book and turns the format on for its author', async () => {
    const chaptarr = new FakeChaptarr();
    const audiobook = book({
      id: 2,
      mediaType: 'audiobook',
      monitored: false,
      authorId: 1,
    });

    await prepareChaptarrBookSearch(
      asApi(chaptarr),
      audiobook,
      'audiobook',
      add,
      'any'
    );

    assert.deepStrictEqual(chaptarr.monitored, [[[2], true]]);
    assert.deepStrictEqual(chaptarr.authorFormats, [
      [1, 'audiobook', add.rootFolderPath],
    ]);
  });
});
