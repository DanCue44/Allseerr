import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import type {
  ChaptarrBook,
  ChaptarrLibraryPageEvent,
} from '@server/api/servarr/chaptarr';
import ChaptarrAPI, {
  chaptarrRetryDelays,
  createMemoryLibraryProgress,
  describeLibraryBooks,
  isAuthorBusyError,
  isMonitoredFor,
  parseTalearrAddRecording,
  parseTalearrBookGrabPolicy,
  parseTalearrGrabPolicy,
  parseTalearrRecording,
  parseTalearrRecordings,
} from '@server/api/servarr/chaptarr';

type Call = {
  method: string;
  url: string;
  data?: unknown;
  params?: unknown;
};

const lookupResult: ChaptarrBook = {
  id: 7,
  localBookId: '7',
  title: 'Pride and Prejudice',
  foreignBookId: 'gr:3060926',
  monitored: false,
  mediaType: 'audiobook',
  author: { authorName: 'Jane Austen', foreignAuthorId: 'gr:1265' },
  editions: [{ foreignEditionId: 'gr:1', monitored: false }],
  addOptions: { addType: 'automatic', searchForNewBook: false },
};

/**
 * A client whose HTTP calls are recorded and answered by the given handler
 */
const createApi = (
  appName: string,
  respond: (call: Call) => { status?: number; data: unknown } = () => ({
    data: {},
  })
) => {
  const chaptarr = new ChaptarrAPI({
    url: 'http://localhost:8789/api/v1',
    apiKey: 'test-key',
  });
  const calls: Call[] = [];
  const http = (chaptarr as unknown as { axios: Record<string, unknown> })
    .axios;
  const record =
    (method: string) =>
    async (
      url: string,
      dataOrConfig?: unknown,
      config?: { params?: unknown }
    ) => {
      if (url === '/system/status') {
        return { status: 200, data: { appName, version: '1.0' } };
      }

      const call =
        method === 'get' || method === 'delete'
          ? {
              method,
              url,
              params: (dataOrConfig as { params?: unknown })?.params,
              data: (dataOrConfig as { data?: unknown })?.data,
            }
          : { method, url, data: dataOrConfig, params: config?.params };
      calls.push(call);
      const response = respond(call);
      return { status: response.status ?? 200, data: response.data };
    };

  http.get = record('get');
  http.post = record('post');
  http.put = record('put');
  http.delete = record('delete');

  return { chaptarr, calls };
};

const addOptions = {
  mediaType: 'ebook' as const,
  qualityProfileId: 1,
  metadataProfileId: 2,
  rootFolderPath: '/ebooks',
  tags: [3],
  searchForNewBook: true,
};

describe('ChaptarrAPI.addBook', () => {
  it('adds one format with only that book of its author monitored', async () => {
    const { chaptarr, calls } = createApi('Chaptarr', () => ({
      status: 201,
      data: { ...lookupResult, id: 12, mediaType: 'ebook' },
    }));

    const result = await chaptarr.addBook(lookupResult, addOptions);

    assert.strictEqual(result.status, 'added');
    assert.strictEqual(calls.length, 1);
    const [call] = calls;
    assert.strictEqual(call.url, '/book');
    assert.deepStrictEqual(call.params, { mediaType: 'ebook' });

    const payload = call.data as Record<string, unknown> & {
      author: Record<string, unknown>;
    };
    assert.strictEqual(payload.id, 0);
    assert.strictEqual(payload.localBookId, null);
    assert.strictEqual(payload.mediaType, 'ebook');
    assert.strictEqual(payload.monitored, true);
    assert.strictEqual(payload.ebookMonitored, true);
    assert.strictEqual(payload.audiobookMonitored, false);
    assert.deepStrictEqual(payload.addOptions, {
      addType: 'automatic',
      searchForNewBook: true,
    });
    // The first edition is monitored when none is
    assert.deepStrictEqual(payload.editions, [
      { foreignEditionId: 'gr:1', monitored: true },
    ]);
    assert.strictEqual(payload.author.ebookQualityProfileId, 1);
    assert.strictEqual(payload.author.ebookMetadataProfileId, 2);
    assert.strictEqual(payload.author.ebookRootFolderPath, '/ebooks');
    assert.strictEqual(payload.author.ebookMonitorNewItems, 'none');
    assert.deepStrictEqual(payload.author.ebookTags, [3]);
    assert.strictEqual(payload.author.audiobookQualityProfileId, undefined);
    assert.deepStrictEqual(payload.author.addOptions, {
      monitor: 'specificBook',
      booksToMonitor: ['gr:3060926'],
      searchForMissingBooks: false,
    });
  });

  it('returns the pending author import Chaptarr accepted the book with', async () => {
    const { chaptarr } = createApi('Chaptarr', () => ({
      status: 202,
      data: { pendingId: 4, message: 'Author is being prepared' },
    }));

    const result = await chaptarr.addBook(lookupResult, addOptions);

    assert.deepStrictEqual(result, {
      status: 'pending',
      pendingId: 4,
      message: 'Author is being prepared',
    });
  });

  it('adds a book to another Readarr compatible server without format fields', async () => {
    const { chaptarr, calls } = createApi('Readarr', () => ({
      status: 201,
      data: { ...lookupResult, id: 12 },
    }));

    await chaptarr.addBook(lookupResult, addOptions);

    const payload = calls[0].data as Record<string, unknown> & {
      author: Record<string, unknown>;
    };
    assert.strictEqual(calls[0].params, undefined);
    assert.strictEqual(payload.mediaType, 'audiobook');
    assert.strictEqual(payload.ebookMonitored, undefined);
    assert.strictEqual(payload.author.qualityProfileId, 1);
    assert.strictEqual(payload.author.rootFolderPath, '/ebooks');
    assert.strictEqual(payload.author.ebookQualityProfileId, undefined);
    assert.deepStrictEqual(payload.author.addOptions, {
      monitor: 'none',
      searchForMissingBooks: false,
    });
  });
});

describe('ChaptarrAPI library', () => {
  it('reads the library a page at a time', async () => {
    const { chaptarr, calls } = createApi('Chaptarr', ({ params }) => {
      const { offset } = params as { offset: number };
      const records = Array.from(
        { length: offset === 0 ? 500 : 20 },
        (_, index) => ({ id: offset + index + 1 })
      );
      return { data: { records, totalCount: 520 } };
    });

    const books = await chaptarr.getAllBooks();

    assert.strictEqual(books.length, 520);
    assert.deepStrictEqual(
      calls.map((call) => call.params),
      [
        { pageSize: 500, includeUnmonitored: true, sortKey: 'id', offset: 0 },
        {
          pageSize: 500,
          includeUnmonitored: true,
          sortKey: 'id',
          offset: 500,
        },
      ]
    );
  });

  /**
   * A Chaptarr whose library pages are answered by the handler, which may
   * throw like axios does
   */
  const libraryApi = (
    respond: (params: Record<string, unknown>) => unknown
  ) => {
    const chaptarr = new ChaptarrAPI({
      url: 'http://localhost:8789/api/v1',
      apiKey: 'test-key',
    });
    const asked: Record<string, unknown>[] = [];
    (
      chaptarr as unknown as {
        axios: { get: (url: string, config?: unknown) => Promise<unknown> };
      }
    ).axios.get = async (url, config) => {
      if (url === '/system/status') {
        return { data: { appName: 'Chaptarr', version: '1.0' } };
      }

      const params = (config as { params: Record<string, unknown> }).params;
      asked.push(params);
      return { data: respond(params) };
    };

    return { chaptarr, asked };
  };

  const timeout = () =>
    Object.assign(new Error('timeout of 60000ms exceeded'), {
      code: 'ECONNABORTED',
    });

  it('reads only the monitored and the downloaded books for a scan', async () => {
    const { chaptarr, asked } = libraryApi((params) => ({
      records: params.monitored
        ? [{ id: 1 }, { id: 2 }]
        : [{ id: 2 }, { id: 3 }],
      totalCount: 2,
    }));

    const books = await chaptarr.getActiveBooks();

    assert.deepStrictEqual(
      books.map((book) => book.id),
      [1, 2, 3]
    );
    assert.deepStrictEqual(
      asked.map(({ monitored, downloaded }) => ({ monitored, downloaded })),
      [
        { monitored: true, downloaded: undefined },
        { monitored: undefined, downloaded: true },
      ]
    );
  });

  it('asks again for a page that failed or took too long', async () => {
    const saved = chaptarrRetryDelays.libraryPageMs;
    chaptarrRetryDelays.libraryPageMs = [0, 0, 0];
    const failures = new Map<number, number>([
      [500, 2],
      [1000, 1],
    ]);
    const { chaptarr, asked } = libraryApi((params) => {
      const offset = params.offset as number;
      const left = failures.get(offset) ?? 0;

      if (left > 0) {
        failures.set(offset, left - 1);
        throw offset === 500
          ? timeout()
          : Object.assign(new Error('Request failed with status code 503'), {
              response: { status: 503 },
            });
      }

      return {
        records: Array.from(
          { length: offset < 1000 ? 500 : 100 },
          (_, index) => ({ id: offset + index + 1 })
        ),
        totalCount: 1100,
      };
    });

    try {
      const books = await chaptarr.getAllBooks();

      assert.strictEqual(books.length, 1100);
      assert.strictEqual(asked.length, 6);
    } finally {
      chaptarrRetryDelays.libraryPageMs = saved;
    }
  });

  it('says which books Chaptarr did not send', async () => {
    const saved = chaptarrRetryDelays.libraryPageMs;
    chaptarrRetryDelays.libraryPageMs = [0, 0, 0];
    const { chaptarr } = libraryApi((params) => {
      if (params.offset === 1000) {
        throw timeout();
      }

      return {
        records: Array.from({ length: 500 }, (_, index) => ({
          id: (params.offset as number) + index + 1,
        })),
        totalCount: 60_000,
      };
    });

    try {
      await assert.rejects(
        chaptarr.getAllBooks(),
        new Error(
          'Chaptarr did not send books 1,001 to 1,125 of 60,000 in 5 min, ' +
            'tried 4 times'
        )
      );
    } finally {
      chaptarrRetryDelays.libraryPageMs = saved;
    }
  });

  it('reports each page and what Chaptarr was busy with when one failed', async () => {
    const saved = chaptarrRetryDelays.libraryPageMs;
    chaptarrRetryDelays.libraryPageMs = [0, 0, 0];
    let failures = 1;
    const { chaptarr } = libraryApi((params) => {
      if (params.monitored && failures > 0) {
        failures--;
        throw timeout();
      }

      return { records: [{ id: params.monitored ? 1 : 2 }], totalCount: 1 };
    });
    const api = chaptarr as unknown as {
      axios: { get: (url: string, config?: unknown) => Promise<unknown> };
    };
    const pageGet = api.axios.get;
    api.axios.get = async (url, config) =>
      url === '/command'
        ? {
            data: [
              { commandName: 'Refresh Book', status: 'started' },
              { commandName: 'Rss Sync', status: 'completed' },
              { name: 'RefreshAuthor', status: 'queued' },
            ],
          }
        : pageGet(url, config);
    const events: ChaptarrLibraryPageEvent[] = [];

    try {
      const books = await chaptarr.getActiveBooks((event) =>
        events.push(event)
      );

      assert.deepStrictEqual(
        books.map((book) => book.id),
        [1, 2]
      );
      assert.deepStrictEqual(
        events.map(
          ({
            books,
            firstBook,
            attempt,
            attempts,
            error,
            busyWith,
            retryInMs,
            records,
          }) => ({
            books,
            firstBook,
            attempt,
            attempts,
            error,
            busyWith,
            retryInMs,
            records,
          })
        ),
        [
          {
            books: 'monitored',
            firstBook: 1,
            attempt: 1,
            attempts: 4,
            error: 'no answer in 5 min',
            busyWith: ['Refresh Book (started)', 'RefreshAuthor (queued)'],
            retryInMs: 0,
            records: undefined,
          },
          {
            books: 'monitored',
            firstBook: 1,
            attempt: 2,
            attempts: 4,
            error: undefined,
            busyWith: undefined,
            retryInMs: undefined,
            records: 1,
          },
          {
            books: 'downloaded',
            firstBook: 1,
            attempt: 1,
            attempts: 4,
            error: undefined,
            busyWith: undefined,
            retryInMs: undefined,
            records: 1,
          },
        ]
      );
    } finally {
      chaptarrRetryDelays.libraryPageMs = saved;
    }
  });

  it('says Chaptarr runs nothing when its command list cannot be read', async () => {
    const chaptarr = new ChaptarrAPI({
      url: 'http://localhost:8789/api/v1',
      apiKey: 'test-key',
    });
    (
      chaptarr as unknown as {
        axios: { get: (url: string) => Promise<unknown> };
      }
    ).axios.get = async () => {
      throw new Error('Request failed with status code 404');
    };

    assert.deepStrictEqual(await chaptarr.getRunningCommands(), []);
  });

  it('goes on from where a scan that stopped left off', async () => {
    const saved = chaptarrRetryDelays.libraryPageMs;
    chaptarrRetryDelays.libraryPageMs = [0, 0, 0];
    const progress = createMemoryLibraryProgress();
    let slow = true;
    const { chaptarr, asked } = libraryApi((params) => {
      const offset = params.offset as number;

      if (!params.monitored) {
        return { records: [], totalCount: 0 };
      }

      if (offset === 1000 && slow) {
        throw timeout();
      }

      return {
        records: Array.from(
          { length: offset < 1000 ? 500 : 200 },
          (_, index) => ({ id: offset + index + 1 })
        ),
        totalCount: 1200,
      };
    });
    const events: ChaptarrLibraryPageEvent[] = [];

    try {
      await assert.rejects(
        chaptarr.getActiveBooks(undefined, { progress }),
        /did not send books 1,001 to 1,125 of 1,200 .*The next scan goes on from this page/
      );

      slow = false;
      asked.length = 0;
      const books = await chaptarr.getActiveBooks(
        (event) => events.push(event),
        { progress }
      );

      assert.strictEqual(books.length, 1200);
      assert.strictEqual(new Set(books.map((book) => book.id)).size, 1200);
      // The last page read before is read again, then the rest
      assert.deepStrictEqual(
        asked.filter((params) => params?.monitored).map((p) => p.offset),
        [500, 1000]
      );
      assert.strictEqual(events[0].resumedBooks, 1000);
      assert.strictEqual(events[0].firstBook, 501);
      assert.strictEqual(events[1].resumedBooks, undefined);

      // A scan that finished leaves nothing for the next one
      asked.length = 0;
      await chaptarr.getActiveBooks(undefined, { progress });
      assert.strictEqual(
        asked.filter((params) => params?.monitored)[0].offset,
        0
      );
    } finally {
      chaptarrRetryDelays.libraryPageMs = saved;
    }
  });

  it('starts over without resume', async () => {
    const saved = chaptarrRetryDelays.libraryPageMs;
    chaptarrRetryDelays.libraryPageMs = [0, 0, 0];
    const { chaptarr, asked } = libraryApi((params) => {
      if ((params.offset as number) === 500) {
        throw timeout();
      }

      return {
        records: Array.from({ length: 500 }, (_, index) => ({
          id: (params.offset as number) + index + 1,
        })),
        totalCount: 1000,
      };
    });

    try {
      await assert.rejects(
        chaptarr.getActiveBooks(),
        /did not send books 501 to 625/
      );
      asked.length = 0;
      await assert.rejects(
        chaptarr.getActiveBooks(),
        /did not send books 501 to 625/
      );
      assert.strictEqual(asked[0].offset, 0);
    } finally {
      chaptarrRetryDelays.libraryPageMs = saved;
    }
  });

  it('asks for fewer books after a page took too long', async () => {
    const saved = chaptarrRetryDelays.libraryPageMs;
    chaptarrRetryDelays.libraryPageMs = [0, 0, 0];
    let failures = 3;
    const { chaptarr, asked } = libraryApi((params) => {
      // The list of what Chaptarr is running
      if (!params) {
        return [];
      }

      if (failures > 0) {
        failures--;
        throw timeout();
      }

      return {
        records: Array.from(
          {
            length: Math.min(
              params.pageSize as number,
              300 - (params.offset as number)
            ),
          },
          (_, index) => ({ id: (params.offset as number) + index + 1 })
        ),
        totalCount: 300,
      };
    });
    const events: ChaptarrLibraryPageEvent[] = [];

    try {
      const books = await chaptarr.getActiveBooks((event) =>
        events.push(event)
      );

      assert.strictEqual(books.length, 300);
      // No book is left out or read twice when the size changes
      assert.strictEqual(new Set(books.map((book) => book.id)).size, 300);
      assert.deepStrictEqual(
        asked
          .filter((params) => params?.monitored)
          .map((params) => [params.offset, params.pageSize]),
        [
          [0, 500],
          [0, 250],
          [0, 125],
          [0, 125],
          // The rest of the read keeps the size that worked
          [125, 125],
          [250, 125],
        ]
      );
      assert.deepStrictEqual(
        events.slice(0, 3).map((event) => event.retryPageSize),
        [250, 125, undefined]
      );
    } finally {
      chaptarrRetryDelays.libraryPageMs = saved;
    }
  });

  it('names the books of a page by where they are in the library', () => {
    assert.strictEqual(
      describeLibraryBooks(54_501, 125, 251_902),
      'books 54,501 to 54,625 of 251,902'
    );
    // A last page asked for in full ends at the last book
    assert.strictEqual(
      describeLibraryBooks(1001, 500, 1200),
      'books 1,001 to 1,200 of 1,200'
    );
    assert.strictEqual(describeLibraryBooks(1, 500), 'books 1 to 500');
  });

  it('leaves out the fields a scan does not use', async () => {
    const { chaptarr } = libraryApi(() => ({
      records: [
        {
          id: 1,
          title: 'Kept',
          images: [{ url: 'cover.jpg' }],
          genres: ['Fantasy'],
          overview: 'A long description',
          links: [],
          statistics: { bookFileCount: 1 },
        },
      ],
      totalCount: 1,
    }));

    const [book] = await chaptarr.getAllBooks();

    assert.deepStrictEqual(book, {
      id: 1,
      title: 'Kept',
      statistics: { bookFileCount: 1 },
    });
  });

  it('does not ask again for a page Chaptarr turned down', async () => {
    const { chaptarr, asked } = libraryApi(() => {
      throw Object.assign(new Error('Request failed with status code 401'), {
        response: { status: 401 },
      });
    });

    await assert.rejects(
      chaptarr.getActiveBooks(),
      /failed to send books 1 to 500 /
    );
    assert.strictEqual(asked.length, 1);
  });

  it('only scopes lookups to a format on Chaptarr', async () => {
    const chaptarrApi = createApi('Chaptarr', () => ({ data: [] }));
    const readarrApi = createApi('Readarr', () => ({ data: [] }));

    await chaptarrApi.chaptarr.lookupBooks('gr:3060926', 'ebook');
    await readarrApi.chaptarr.lookupBooks('gr:3060926', 'ebook');

    assert.deepStrictEqual(chaptarrApi.calls[0].params, {
      term: 'gr:3060926',
      mediaType: 'ebook',
    });
    assert.deepStrictEqual(readarrApi.calls[0].params, {
      term: 'gr:3060926',
    });
  });

  it('runs a search for books', async () => {
    const { chaptarr, calls } = createApi('Chaptarr');

    await chaptarr.searchBooks([12]);

    assert.deepStrictEqual(calls, [
      {
        method: 'post',
        url: '/command',
        data: { name: 'BookSearch', bookIds: [12] },
        params: undefined,
      },
    ]);
  });
});

const fixture = (name: string): unknown =>
  JSON.parse(
    readFileSync(path.join(__dirname, 'fixtures/chaptarr', name), 'utf8')
  );

describe('ChaptarrAPI.getBookQueue', () => {
  it('reads the queue with the book of each download', async () => {
    const { chaptarr, calls } = createApi('Chaptarr', () => ({
      data: fixture('queue.json'),
    }));

    const queue = await chaptarr.getBookQueue();

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].url, '/queue');
    assert.deepStrictEqual(calls[0].params, {
      page: 1,
      pageSize: 200,
      includeBook: true,
      includeAuthor: false,
      includeUnknownAuthorItems: false,
    });
    assert.strictEqual(queue.length, 3);
    assert.strictEqual(queue[0].bookId, 3091);
    assert.strictEqual(queue[0].book?.mediaType, 'ebook');
    assert.strictEqual(queue[1].book?.mediaType, 'audiobook');
  });

  it('returns no downloads for an empty queue', async () => {
    const { chaptarr } = createApi('Chaptarr', () => ({
      data: fixture('queue-empty.json'),
    }));

    assert.deepStrictEqual(await chaptarr.getBookQueue(), []);
  });

  it('fails when Chaptarr cannot be reached', async () => {
    const { chaptarr } = createApi('Chaptarr', () => {
      throw new Error('connect ECONNREFUSED');
    });

    await assert.rejects(chaptarr.getBookQueue(), /Failed to retrieve queue/);
  });
});

describe('ChaptarrAPI.waitForPendingImport', () => {
  it('waits until the import succeeds', async () => {
    const statuses = ['Pending', 'InProgress', 'Succeeded'];
    const { chaptarr } = createApi('Chaptarr', () => ({
      data: { id: 4, overallStatus: statuses.shift() },
    }));

    assert.strictEqual(
      await chaptarr.waitForPendingImport(4, { intervalMs: 1 }),
      'succeeded'
    );
    assert.deepStrictEqual(statuses, []);
  });

  it('treats an import that is gone as finished', async () => {
    const { chaptarr } = createApi('Chaptarr', () => {
      throw Object.assign(new Error('Not found'), {
        response: { status: 404 },
      });
    });

    assert.strictEqual(await chaptarr.waitForPendingImport(4), 'succeeded');
  });

  it('gives up after the timeout', async () => {
    const { chaptarr } = createApi('Chaptarr', () => ({
      data: { id: 4, overallStatus: 'Retrying' },
    }));

    assert.strictEqual(
      await chaptarr.waitForPendingImport(4, { timeoutMs: 5, intervalMs: 2 }),
      'timeout'
    );
  });

  it('reports a failed import', async () => {
    const { chaptarr } = createApi('Chaptarr', () => ({
      data: { id: 4, overallStatus: 'Failed' },
    }));

    assert.strictEqual(await chaptarr.waitForPendingImport(4), 'failed');
  });
});

describe('isMonitoredFor', () => {
  it('reads the monitoring of the format, then the monitored flag', () => {
    assert.strictEqual(
      isMonitoredFor({ ...lookupResult, ebookMonitored: true }, 'ebook'),
      true
    );
    assert.strictEqual(
      isMonitoredFor(
        { ...lookupResult, monitored: true, audiobookMonitored: false },
        'audiobook'
      ),
      false
    );
    assert.strictEqual(
      isMonitoredFor(
        {
          title: 'Emma',
          foreignBookId: 'gr:6969',
          monitored: true,
        },
        'audiobook'
      ),
      true
    );
  });
});

describe('ChaptarrAPI language calls', () => {
  it('saves an author whole without moving its files', async () => {
    const { chaptarr, calls } = createApi('Chaptarr');
    const author = {
      id: 4,
      authorName: 'Jo Nesbo',
      foreignAuthorId: 'gr:4',
      ebookTags: [1],
      audiobookTags: [],
      tags: [1],
    };

    await chaptarr.updateAuthor(author);

    assert.deepStrictEqual(calls, [
      {
        method: 'put',
        url: '/author/4',
        data: author,
        params: { moveFiles: false },
      },
    ]);
  });

  it('creates and updates release profiles', async () => {
    const { chaptarr, calls } = createApi('Chaptarr', (call) => ({
      data: call.method === 'post' ? { ...(call.data as object), id: 2 } : [],
    }));
    const profile = {
      enabled: true,
      required: [],
      ignored: ['/\\b(dansk)\\b/i'],
      indexerId: 0,
      tags: [1],
    };

    const created = await chaptarr.createReleaseProfile(profile);
    await chaptarr.updateReleaseProfile(created);

    assert.strictEqual(created.id, 2);
    assert.deepStrictEqual(
      calls.map((call) => [call.method, call.url]),
      [
        ['post', '/releaseprofile'],
        ['put', '/releaseprofile/2'],
      ]
    );
  });
});

describe('ChaptarrAPI when Chaptarr is busy', () => {
  const timeout = Object.assign(new Error('timeout of 30000ms exceeded'), {
    code: 'ECONNABORTED',
  });
  const authorBusy = Object.assign(
    new Error('Request failed with status code 400'),
    {
      response: {
        status: 400,
        data: [
          {
            propertyName: 'EbookRootFolderPath',
            errorMessage: 'Selected root folder is not configured for ebooks.',
          },
        ],
      },
    }
  );

  const withoutWaits = async (fn: () => Promise<void>) => {
    const saved = { ...chaptarrRetryDelays };
    chaptarrRetryDelays.lookupMs = 0;
    chaptarrRetryDelays.authorBusyMs = 0;
    try {
      await fn();
    } finally {
      Object.assign(chaptarrRetryDelays, saved);
    }
  };

  it('tries a lookup again once after a timeout', () =>
    withoutWaits(async () => {
      let attempts = 0;
      const { chaptarr } = createApi('Chaptarr', () => {
        attempts++;
        if (attempts === 1) {
          throw timeout;
        }
        return { data: [lookupResult] };
      });

      const books = await chaptarr.lookupBooks('Nineteen Eighty-Four');

      assert.strictEqual(attempts, 2);
      assert.deepStrictEqual(books, [lookupResult]);
    }));

  it('gives up on a lookup that times out twice', () =>
    withoutWaits(async () => {
      let attempts = 0;
      const { chaptarr } = createApi('Chaptarr', () => {
        attempts++;
        throw timeout;
      });

      await assert.rejects(
        chaptarr.lookupBooks('Nineteen Eighty-Four'),
        /Failed to look up books/
      );
      assert.strictEqual(attempts, 2);
    }));

  it('does not retry a lookup that failed for another reason', () =>
    withoutWaits(async () => {
      let attempts = 0;
      const { chaptarr } = createApi('Chaptarr', () => {
        attempts++;
        throw Object.assign(new Error('Request failed with status code 500'), {
          response: { status: 500 },
        });
      });

      await assert.rejects(chaptarr.lookupBooks('x'), /Failed to look up/);
      assert.strictEqual(attempts, 1);
    }));

  it('adds the book again once the author is ready', () =>
    withoutWaits(async () => {
      let posts = 0;
      const { chaptarr } = createApi('Chaptarr', (call) => {
        if (call.method === 'post' && call.url === '/book') {
          posts++;
          if (posts === 1) {
            throw authorBusy;
          }
          return { data: { ...lookupResult, id: 42 } };
        }
        return { data: [] };
      });

      const result = await chaptarr.addBook(lookupResult, addOptions);

      assert.strictEqual(posts, 2);
      assert.strictEqual(result.status, 'added');
    }));

  it('only treats root folder refusals as the author being busy', () => {
    assert.strictEqual(isAuthorBusyError(authorBusy), true);
    assert.strictEqual(
      isAuthorBusyError({
        response: { status: 400, data: [{ errorMessage: 'Invalid profile' }] },
      }),
      false
    );
    assert.strictEqual(
      isAuthorBusyError({ response: { status: 500, data: 'root folder' } }),
      false
    );
  });
});

/**
 * A client answering GETs by URL, failing with a 404 for anything else
 */
const createIdentityApi = (answers: Record<string, unknown>) => {
  const chaptarr = new ChaptarrAPI({
    url: 'http://localhost:8789/api/v1',
    apiKey: 'test-key',
  });
  const urls: string[] = [];
  const http = (chaptarr as unknown as { axios: Record<string, unknown> })
    .axios;

  http.get = async (url: string) => {
    urls.push(url);
    if (url in answers) {
      return { status: 200, data: answers[url] };
    }
    throw Object.assign(new Error('Request failed with status code 404'), {
      response: { status: 404 },
    });
  };

  return { chaptarr, urls };
};

const grabPolicy = {
  id: 1,
  abridgedPolicy: 'preferUnabridged',
  allowBundles: false,
  failRejectedImports: true,
  maxAutomaticRetries: 3,
};

describe('ChaptarrAPI.getTalearrIdentity', () => {
  it('recognizes Talearr with its version, grab policy and metadata health', async () => {
    const { chaptarr, urls } = createIdentityApi({
      '/system/status': {
        appName: 'Chaptarr',
        instanceName: 'Talearr',
        version: '0.4.2.1',
      },
      'http://localhost:8789/initialize.json': {
        productName: 'Talearr',
        talearrVersion: '0.11.0',
        instanceName: 'Talearr',
      },
      '/config/talearrgrabpolicy': grabPolicy,
      '/health': [
        { source: 'IndexerStatusCheck', message: 'Indexers unavailable' },
        {
          source: 'TalearrMetadataServerProbeCheck',
          type: 'warning',
          message: 'Metadata server api2.chaptarr.com is responding slowly',
        },
      ],
    });

    assert.deepStrictEqual(await chaptarr.getTalearrIdentity(), {
      isTalearr: true,
      version: '0.11.0',
      instanceName: 'Talearr',
      grabPolicy: {
        abridgedPolicy: 'preferUnabridged',
        allowBundles: false,
        failRejectedImports: true,
        maxAutomaticRetries: 3,
      },
      metadataProblem: 'Metadata server api2.chaptarr.com is responding slowly',
    });
    // initialize.json lives next to the API, not under it
    assert.ok(urls.includes('http://localhost:8789/initialize.json'));
  });

  it('reports stock Chaptarr as not Talearr', async () => {
    const { chaptarr, urls } = createIdentityApi({
      '/system/status': {
        appName: 'Chaptarr',
        instanceName: 'Chaptarr',
        version: '0.4.2.1',
      },
      'http://localhost:8789/initialize.json': {
        apiRoot: '/api/v1',
        version: '0.4.2.1',
        instanceName: 'Chaptarr',
      },
    });

    assert.deepStrictEqual(await chaptarr.getTalearrIdentity(), {
      isTalearr: false,
      instanceName: 'Chaptarr',
    });
    // Health is only read from Talearr
    assert.ok(!urls.includes('/health'));
  });

  it('recognizes Talearr by its grab policy when nothing else says so', async () => {
    // A renamed instance, and an initialize.json the API key cannot read
    const { chaptarr } = createIdentityApi({
      '/system/status': { appName: 'Chaptarr', instanceName: 'Chaptarr Home' },
      'http://localhost:8789/initialize.json': '<html>login</html>',
      '/config/talearrgrabpolicy': grabPolicy,
      '/health': [],
    });

    const identity = await chaptarr.getTalearrIdentity();

    assert.strictEqual(identity.isTalearr, true);
    assert.strictEqual(identity.version, undefined);
    assert.strictEqual(identity.metadataProblem, undefined);
  });

  it('recognizes Talearr by its instance name alone', async () => {
    const { chaptarr } = createIdentityApi({
      '/system/status': { appName: 'Chaptarr', instanceName: 'Talearr' },
    });

    assert.strictEqual((await chaptarr.getTalearrIdentity()).isTalearr, true);
  });

  it('is not Talearr when the server cannot be read at all', async () => {
    const { chaptarr } = createIdentityApi({});

    assert.deepStrictEqual(await chaptarr.getTalearrIdentity(), {
      isTalearr: false,
      instanceName: undefined,
    });
  });
});

describe('parseTalearrGrabPolicy', () => {
  it('reads named and numbered abridged policies', () => {
    assert.strictEqual(
      parseTalearrGrabPolicy({ ...grabPolicy, abridgedPolicy: 'any' })
        ?.abridgedPolicy,
      'any'
    );
    assert.strictEqual(
      parseTalearrGrabPolicy({ ...grabPolicy, abridgedPolicy: 1 })
        ?.abridgedPolicy,
      'preferUnabridged'
    );
    assert.strictEqual(
      parseTalearrGrabPolicy({
        ...grabPolicy,
        abridgedPolicy: 'UnabridgedOnly',
      })?.abridgedPolicy,
      'unabridgedOnly'
    );
  });

  it('ignores answers that are not a grab policy', () => {
    assert.strictEqual(parseTalearrGrabPolicy(undefined), undefined);
    assert.strictEqual(parseTalearrGrabPolicy('<html></html>'), undefined);
    assert.strictEqual(
      parseTalearrGrabPolicy({ message: 'NotFound' }),
      undefined
    );
  });
});

describe('parseTalearrBookGrabPolicy', () => {
  it('reads the override of a book, or none', () => {
    assert.deepStrictEqual(
      parseTalearrBookGrabPolicy(200, { abridgedPolicy: 'abridgedOnly' }),
      { supported: true, abridgedPolicy: 'abridgedOnly' }
    );
    assert.deepStrictEqual(
      parseTalearrBookGrabPolicy(200, { abridgedPolicy: 3 }),
      { supported: true, abridgedPolicy: 'abridgedOnly' }
    );
    assert.deepStrictEqual(
      parseTalearrBookGrabPolicy(200, { abridgedPolicy: null }),
      { supported: true, abridgedPolicy: null }
    );
  });

  it('tells a book Talearr does not know from a route it does not have', () => {
    assert.deepStrictEqual(
      parseTalearrBookGrabPolicy(404, { message: 'Book not found' }),
      { supported: true }
    );
    assert.deepStrictEqual(parseTalearrBookGrabPolicy(404, ''), {
      supported: false,
    });
    assert.deepStrictEqual(parseTalearrBookGrabPolicy(200, '<html></html>'), {
      supported: false,
    });
    assert.deepStrictEqual(parseTalearrBookGrabPolicy(405, undefined), {
      supported: false,
    });
  });

  it('reads the abridged only global policy', () => {
    assert.strictEqual(
      parseTalearrGrabPolicy({ ...grabPolicy, abridgedPolicy: 'abridgedOnly' })
        ?.abridgedPolicy,
      'abridgedOnly'
    );
  });
});

describe('Talearr recordings', () => {
  const primary = {
    bookId: 3401,
    role: 'primary',
    editionId: 28701,
    narrators: ['Scott Brick'],
    abridged: 'Unabridged',
    runtimeMinutes: 1030,
    asin: 'B002V5BSLC',
    monitored: true,
    hasFiles: true,
    files: { count: 1, quality: 'M4B' },
  };

  it('reads the recordings and candidates of a book', () => {
    const view = parseTalearrRecordings({
      baseBookId: 'hc:149559',
      marketplace: 'us',
      recordings: [primary],
      candidates: [
        {
          editionId: 28705,
          editionIds: [28705, 28709],
          narrators: ['D.W. Moffett', ''],
          abridged: 'abridged',
          runtimeMinutes: null,
        },
      ],
    });

    assert.ok(view);
    assert.strictEqual(view.recordings[0].role, 'primary');
    assert.strictEqual(view.recordings[0].abridged, 'unabridged');
    assert.strictEqual(view.recordings[0].hasFiles, true);
    assert.deepStrictEqual(view.candidates[0].narrators, ['D.W. Moffett']);
    assert.deepStrictEqual(view.candidates[0].editionIds, [28705, 28709]);
    assert.strictEqual(view.candidates[0].runtimeMinutes, null);
  });

  it('reads whether Talearr is still resolving the facts of a book', () => {
    assert.strictEqual(
      parseTalearrRecordings({
        recordings: [],
        candidates: [],
        factsPending: true,
      })?.factsPending,
      true
    );

    // Older servers leave it out, and anything but true is not pending
    for (const factsPending of [undefined, false, 'true']) {
      const view = parseTalearrRecordings({
        recordings: [],
        candidates: [],
        ...(factsPending === undefined ? {} : { factsPending }),
      });

      assert.ok(view);
      assert.ok(!('factsPending' in view));
    }
  });

  it('does not read a page that is not a recordings answer', () => {
    assert.strictEqual(parseTalearrRecordings('<html></html>'), undefined);
    assert.strictEqual(parseTalearrRecordings({ message: 'x' }), undefined);
    assert.strictEqual(parseTalearrRecordings([]), undefined);
  });

  it('reads the answer to a new recording by its status code', () => {
    assert.deepStrictEqual(
      parseTalearrAddRecording(201, {
        action: 'created',
        searchQueued: true,
        recording: { ...primary, role: 'additional', bookId: 4100 },
      }),
      {
        status: 'created',
        searchQueued: true,
        recording: parseTalearrRecording({
          ...primary,
          role: 'additional',
          bookId: 4100,
        }),
      }
    );
    assert.strictEqual(
      parseTalearrAddRecording(201, { action: 'pinned' }).status,
      'pinned'
    );
    assert.strictEqual(
      parseTalearrAddRecording(200, { action: 'existing' }).status,
      'existing'
    );

    const ambiguous = parseTalearrAddRecording(409, {
      message: 'Several editions fit equally well',
      candidates: [{ editionId: 31, narrators: ['A'], abridged: 'unabridged' }],
    });
    assert.strictEqual(ambiguous.status, 'ambiguous');
    assert.ok('candidates' in ambiguous);
    assert.strictEqual(ambiguous.candidates[0].editionId, 31);

    assert.strictEqual(parseTalearrAddRecording(404, {}).status, 'nomatch');
    assert.strictEqual(parseTalearrAddRecording(400, null).status, 'invalid');
  });

  it('posts a recording and answers refusals without throwing', async () => {
    const api = new ChaptarrAPI({
      url: 'http://talearr:8789/api/v1',
      apiKey: 'key',
    });
    const calls: { url?: string; data?: unknown }[] = [];
    (
      api as unknown as {
        axios: { post: (...args: unknown[]) => Promise<unknown> };
      }
    ).axios.post = async (url: unknown, data: unknown) => {
      calls.push({ url: url as string, data });
      return {
        status: 404,
        data: { message: 'No unabridged edition', candidates: [] },
      };
    };

    const result = await api.addTalearrRecording({
      bookId: 3401,
      kind: 'unabridged',
      requestedBy: 'allseerr',
      externalRef: '12',
    });

    assert.strictEqual(result.status, 'nomatch');
    assert.deepStrictEqual(calls, [
      {
        url: '/talearr/recordings',
        data: {
          bookId: 3401,
          kind: 'unabridged',
          requestedBy: 'allseerr',
          externalRef: '12',
        },
      },
    ]);
  });
});
