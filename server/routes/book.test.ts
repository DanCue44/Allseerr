import assert from 'node:assert/strict';
import { afterEach, before, beforeEach, describe, it, mock } from 'node:test';

import Audible from '@server/api/audible';
import type { AudibleProduct } from '@server/api/audible/interfaces';
import type { AudiobookshelfBookItem } from '@server/api/audiobookshelf';
import AudiobookshelfAPI from '@server/api/audiobookshelf';
import LazyLibrarianAPI from '@server/api/lazylibrarian';
import OpenLibrary from '@server/api/openlibrary';
import type {
  OlAuthor,
  OlAuthorSearchResponse,
  OlSearchDoc,
  OlSearchResponse,
  OlSubjectResponse,
  OlTrendingResponse,
  OlWork,
} from '@server/api/openlibrary/interfaces';
import TheMovieDb from '@server/api/themoviedb';
import type { TmdbSearchMultiResponse } from '@server/api/themoviedb/interfaces';
import { MediaStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import MetadataBookAudio from '@server/entity/MetadataBookAudio';
import cacheManager from '@server/lib/cache';
import { getSettings } from '@server/lib/settings';
import { checkUser } from '@server/middleware/auth';
import { setupTestDb } from '@server/test/db';
import type { Express } from 'express';
import express from 'express';
import session from 'express-session';
import request from 'supertest';
import authRoutes from './auth';
import authorRoutes from './author';
import bookRoutes from './book';
import discoverBooksRoutes from './discoverBooks';
import searchRoutes from './search';
import settingsRoutes from './settings';

const WORK_ID = 'OL45804W';
const MERGED_WORK_ID = 'OL45883W';
const OTHER_WORK_ID = 'OL45890W';
const AUTHOR_ID = 'OL34184A';

const foxSummary: OlSearchDoc = {
  key: `/works/${WORK_ID}`,
  title: 'Fantastic Mr Fox',
  author_name: ['Roald Dahl'],
  author_key: [AUTHOR_ID],
  first_publish_year: 1970,
  cover_i: 6498519,
  edition_count: 161,
  number_of_pages_median: 96,
  ratings_average: 3.95,
  ratings_count: 121,
  language: ['eng', 'fre'],
};

const charlieSummary: OlSearchDoc = {
  key: `/works/${OTHER_WORK_ID}`,
  title: 'Charlie and the Chocolate Factory',
  author_name: ['Roald Dahl'],
  author_key: [AUTHOR_ID],
  first_publish_year: 1964,
  cover_i: -1,
  edition_count: 300,
};

let getWorkCalls: string[] = [];
let workCovers: number[] = [];
let summaryImpl: () => Promise<OlSearchDoc | undefined>;

// Works are fetched through getWork, which follows merges itself
mock.method(
  OpenLibrary.prototype,
  'getWork',
  async (workId: string): Promise<OlWork> => {
    getWorkCalls.push(workId);
    return {
      key: `/works/${WORK_ID}`,
      title: 'Fantastic Mr Fox',
      type: { key: '/type/work' },
      description: {
        type: '/type/text',
        value:
          'A clever fox outwits three farmers.\r\n\r\n([source][1])\r\n\r\n  [1]: https://en.wikipedia.org/wiki/Fantastic_Mr_Fox',
      },
      authors: [{ author: { key: `/authors/${AUTHOR_ID}` } }],
      covers: workCovers,
      subjects: ['Animals', 'Foxes', 'Juvenile fiction'],
      subject_places: ['English countryside'],
      subject_people: ['Mr Fox'],
    };
  }
);
mock.method(OpenLibrary.prototype, 'getWorkSummary', () => summaryImpl());
mock.method(
  OpenLibrary.prototype,
  'getAuthor',
  async (): Promise<OlAuthor> => ({
    key: `/authors/${AUTHOR_ID}`,
    name: 'Roald Dahl',
    type: { key: '/type/author' },
    bio: 'British novelist and short story writer.',
    birth_date: '13 September 1916',
    death_date: '23 November 1990',
    photos: [-1, 9395323],
    links: [{ title: 'Official site', url: 'https://www.roalddahl.com' }],
  })
);
mock.method(
  OpenLibrary.prototype,
  'getAuthorWorks',
  async (): Promise<OlSearchResponse> => ({
    numFound: 544,
    start: 0,
    docs: [charlieSummary, foxSummary],
  })
);
mock.method(
  OpenLibrary.prototype,
  'searchBooks',
  async (): Promise<OlSearchResponse> => ({
    numFound: 45,
    start: 0,
    docs: [foxSummary],
  })
);
mock.method(
  OpenLibrary.prototype,
  'searchAuthors',
  async (): Promise<OlAuthorSearchResponse> => ({
    numFound: 1,
    start: 0,
    docs: [{ key: AUTHOR_ID, name: 'Roald Dahl', work_count: 544 }],
  })
);

let trendingCalls: { period?: string; page?: number }[] = [];

mock.method(
  OpenLibrary.prototype,
  'getTrending',
  async (options: {
    period?: string;
    page?: number;
  }): Promise<OlTrendingResponse> => {
    trendingCalls.push(options);
    return {
      query: '/trending/daily',
      works: [foxSummary, { ...charlieSummary, key: '/books/OL1M' }],
    };
  }
);
mock.method(
  OpenLibrary.prototype,
  'getSubject',
  async (): Promise<OlSubjectResponse> => ({
    key: '/subjects/fantasy',
    name: 'fantasy',
    work_count: 45,
    works: [
      {
        key: `/works/${WORK_ID}`,
        title: 'Fantastic Mr Fox',
        cover_id: 6498519,
        first_publish_year: 1970,
        authors: [{ key: `/authors/${AUTHOR_ID}`, name: 'Roald Dahl' }],
      },
    ],
  })
);

Object.defineProperty(TheMovieDb.prototype, 'searchMulti', {
  set() {},
  get() {
    return async (): Promise<TmdbSearchMultiResponse> => ({
      page: 1,
      total_pages: 1,
      total_results: 0,
      results: [],
    });
  },
  configurable: true,
});

// Settings routes save to the settings file, which tests leave alone
mock.method(getSettings(), 'save', async () => undefined);

// Searches also look for narrators named like the query
let narratorProducts: AudibleProduct[] = [];
mock.method(Audible.prototype, 'searchNarrator', async () => ({
  products: narratorProducts,
  total: narratorProducts.length,
}));

let getVersionImpl: () => Promise<string>;
mock.method(LazyLibrarianAPI.prototype, 'getVersion', () => getVersionImpl());

let absSearchCalls: { libraryId: string; query: string }[] = [];
let absSearchImpl: () => Promise<AudiobookshelfBookItem[]>;
mock.method(
  AudiobookshelfAPI.prototype,
  'searchBooks',
  (libraryId: string, query: string) => {
    absSearchCalls.push({ libraryId, query });
    return absSearchImpl();
  }
);

// The settings setter merges, so earlier values are removed by hand
function resetLazyLibrarian() {
  const lazyLibrarian = getSettings().lazylibrarian as Record<string, unknown>;

  for (const key of Object.keys(lazyLibrarian)) {
    delete lazyLibrarian[key];
  }

  getSettings().audiobookshelf = {
    url: '',
    libraryId: '',
    ebookLibraryId: '',
    apiKey: '',
  };
}

let app: Express;

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(
    session({ secret: 'test-secret', resave: false, saveUninitialized: false })
  );
  app.use(checkUser);
  app.use('/auth', authRoutes);
  app.use('/book', bookRoutes);
  app.use('/author', authorRoutes);
  app.use('/search', searchRoutes);
  app.use('/discover/books', discoverBooksRoutes);
  app.use('/settings', settingsRoutes);
  app.use(
    (
      err: { status?: number; message?: string },
      _req: express.Request,
      res: express.Response,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _next: express.NextFunction
    ) => {
      res
        .status(err.status ?? 500)
        .json({ status: err.status ?? 500, message: err.message });
    }
  );
  return app;
}

async function login(email = 'demo@seerr.dev') {
  const settings = getSettings();
  const priorLocalLogin = settings.main.localLogin;
  settings.main.localLogin = true;

  try {
    const agent = request.agent(app);
    const res = await agent
      .post('/auth/local')
      .send({ email, password: 'test1234' });
    assert.strictEqual(res.status, 200);
    return agent;
  } finally {
    settings.main.localLogin = priorLocalLogin;
  }
}

before(() => {
  app = createApp();
});

setupTestDb();

beforeEach(() => {
  narratorProducts = [];
  getWorkCalls = [];
  workCovers = [-1, 6498519, 8904777];
  absSearchCalls = [];
  absSearchImpl = async () => [];
  cacheManager.getCache('audiobookshelf').flush();
  trendingCalls = [];
  summaryImpl = async () => foxSummary;
  getVersionImpl = async () => '1.2.3';
  resetLazyLibrarian();
});

afterEach(() => {
  resetLazyLibrarian();
});

describe('GET /book/:id', () => {
  it('returns the book with its facts, cover and both format statuses', async () => {
    await getRepository(Media).save(
      new Media({
        olId: WORK_ID,
        mediaType: MediaType.BOOK,
        status: MediaStatus.AVAILABLE,
        statusAudio: MediaStatus.PROCESSING,
      })
    );

    const agent = await login();
    const res = await agent.get(`/book/${WORK_ID}`);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.id, WORK_ID);
    assert.strictEqual(res.body.mediaType, 'book');
    assert.strictEqual(res.body.title, 'Fantastic Mr Fox');
    // The source note OpenLibrary appends is dropped
    assert.strictEqual(
      res.body.description,
      'A clever fox outwits three farmers.'
    );
    assert.deepStrictEqual(res.body.authors, [
      { id: AUTHOR_ID, name: 'Roald Dahl' },
    ]);
    assert.strictEqual(res.body.firstPublishYear, 1970);
    assert.strictEqual(res.body.pageCount, 96);
    assert.strictEqual(res.body.editionCount, 161);
    // Placeholder covers (-1) are skipped
    assert.strictEqual(
      res.body.posterPath,
      'https://covers.openlibrary.org/b/id/6498519-L.jpg'
    );
    assert.deepStrictEqual(res.body.subjects, [
      'Animals',
      'Foxes',
      'Juvenile fiction',
    ]);
    assert.strictEqual(res.body.mediaInfo.status, MediaStatus.AVAILABLE);
    assert.strictEqual(res.body.mediaInfo.statusAudio, MediaStatus.PROCESSING);
    // No Audiobookshelf address is configured
    assert.strictEqual(res.body.audiobookshelfUrl, null);
  });

  it('keys a merged work on the work it was merged into', async () => {
    const agent = await login();
    const res = await agent.get(`/book/${MERGED_WORK_ID}`);

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(getWorkCalls, [MERGED_WORK_ID]);
    assert.strictEqual(res.body.id, WORK_ID);
  });

  it('names the authors from their records without a summary', async () => {
    summaryImpl = async () => undefined;

    const agent = await login();
    const res = await agent.get(`/book/${WORK_ID}`);

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.authors, [
      { id: AUTHOR_ID, name: 'Roald Dahl' },
    ]);
    assert.strictEqual(res.body.firstPublishYear, undefined);
  });

  it('links an available book to an Audiobookshelf title search', async () => {
    getSettings().audiobookshelf = {
      url: 'https://books.example.com/',
      libraryId: 'lib_1',
    };
    await getRepository(Media).save(
      new Media({
        olId: WORK_ID,
        mediaType: MediaType.BOOK,
        statusAudio: MediaStatus.AVAILABLE,
      })
    );

    const agent = await login();
    const res = await agent.get(`/book/${WORK_ID}`);

    assert.strictEqual(
      res.body.audiobookshelfUrl,
      'https://books.example.com/library/lib_1/search?q=Fantastic%20Mr%20Fox'
    );
  });

  it('opens each format in its own Audiobookshelf library', async () => {
    getSettings().audiobookshelf = {
      url: 'https://books.example.com',
      libraryId: 'lib_audio',
      ebookLibraryId: 'lib_ebook',
    };
    await getRepository(Media).save(
      new Media({
        olId: WORK_ID,
        mediaType: MediaType.BOOK,
        status: MediaStatus.AVAILABLE,
        statusAudio: MediaStatus.AVAILABLE,
      })
    );

    const agent = await login();
    const res = await agent.get(`/book/${WORK_ID}`);

    assert.strictEqual(
      res.body.audiobookshelfEbookUrl,
      'https://books.example.com/library/lib_ebook/search?q=Fantastic%20Mr%20Fox'
    );
    assert.strictEqual(
      res.body.audiobookshelfAudiobookUrl,
      'https://books.example.com/library/lib_audio/search?q=Fantastic%20Mr%20Fox'
    );
  });

  it('links only the format that is available', async () => {
    getSettings().audiobookshelf = {
      url: 'https://books.example.com',
      libraryId: 'lib_audio',
      ebookLibraryId: 'lib_ebook',
    };
    await getRepository(Media).save(
      new Media({
        olId: WORK_ID,
        mediaType: MediaType.BOOK,
        status: MediaStatus.AVAILABLE,
        statusAudio: MediaStatus.PROCESSING,
      })
    );

    const agent = await login();
    const res = await agent.get(`/book/${WORK_ID}`);

    assert.strictEqual(res.body.audiobookshelfAudiobookUrl, null);
    // The general link follows the format that is there
    assert.strictEqual(
      res.body.audiobookshelfUrl,
      'https://books.example.com/library/lib_ebook/search?q=Fantastic%20Mr%20Fox'
    );
  });

  it('links straight to the book in Audiobookshelf with an API key', async () => {
    getSettings().audiobookshelf = {
      url: 'https://books.example.com',
      libraryId: 'lib_audio',
      ebookLibraryId: 'lib_ebook',
      apiKey: 'secret',
    };
    absSearchImpl = async () => [
      {
        id: 'item_fox',
        title: 'Fantastic Mr. Fox',
        authors: ['Roald Dahl'],
        series: [],
      },
    ];
    await getRepository(Media).save(
      new Media({
        olId: WORK_ID,
        mediaType: MediaType.BOOK,
        status: MediaStatus.AVAILABLE,
        statusAudio: MediaStatus.AVAILABLE,
      })
    );

    const agent = await login();
    const res = await agent.get(`/book/${WORK_ID}`);

    assert.strictEqual(
      res.body.audiobookshelfEbookUrl,
      'https://books.example.com/item/item_fox'
    );
    assert.strictEqual(
      res.body.audiobookshelfAudiobookUrl,
      'https://books.example.com/item/item_fox'
    );
    assert.deepStrictEqual(
      absSearchCalls.map((call) => call.libraryId).sort(),
      ['lib_audio', 'lib_ebook']
    );
    // The key stays on the server
    assert.ok(!JSON.stringify(res.body).includes('secret'));
  });

  it('keeps the title search when Audiobookshelf cannot be asked', async () => {
    getSettings().audiobookshelf = {
      url: 'https://books.example.com',
      libraryId: 'lib_audio',
      apiKey: 'secret',
    };
    absSearchImpl = async () => {
      throw new Error('connect ECONNREFUSED');
    };
    await getRepository(Media).save(
      new Media({
        olId: WORK_ID,
        mediaType: MediaType.BOOK,
        statusAudio: MediaStatus.AVAILABLE,
      })
    );

    const agent = await login();
    const res = await agent.get(`/book/${WORK_ID}`);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(
      res.body.audiobookshelfAudiobookUrl,
      'https://books.example.com/library/lib_audio/search?q=Fantastic%20Mr%20Fox'
    );
  });

  it('includes the saved audiobook edition, its cover only without another', async () => {
    workCovers = [];
    summaryImpl = async () => ({ ...foxSummary, cover_i: undefined });
    await getRepository(MetadataBookAudio).save(
      new MetadataBookAudio({
        olId: WORK_ID,
        region: 'us',
        hasAudiobook: true,
        asin: 'B0BB3F6HKX',
        narrators: ["Chris O'Dowd"],
        runtimeMinutes: 82,
        coverUrl: 'https://m.media-amazon.com/images/I/fox._SL500_.jpg',
        checkedAt: new Date(),
      })
    );

    const agent = await login();
    const res = await agent.get(`/book/${WORK_ID}`);

    assert.deepStrictEqual(res.body.audiobookEdition, {
      asin: 'B0BB3F6HKX',
      narrators: ["Chris O'Dowd"],
      runtimeMinutes: 82,
      coverUrl: 'https://m.media-amazon.com/images/I/fox._SL500_.jpg',
    });
    assert.strictEqual(
      res.body.posterPath,
      'https://m.media-amazon.com/images/I/fox._SL500_.jpg'
    );

    workCovers = [6498519];
    const withCover = await agent.get(`/book/${WORK_ID}`);

    assert.strictEqual(
      withCover.body.posterPath,
      'https://covers.openlibrary.org/b/id/6498519-L.jpg'
    );
  });

  it('has no audiobook edition when Audible lists none', async () => {
    await getRepository(MetadataBookAudio).save(
      new MetadataBookAudio({
        olId: WORK_ID,
        region: 'us',
        hasAudiobook: false,
        checkedAt: new Date(),
      })
    );

    const agent = await login();
    const res = await agent.get(`/book/${WORK_ID}`);

    assert.strictEqual(res.body.audiobookEdition, null);
  });

  it('still reads the Audiobookshelf link from the LazyLibrarian settings', async () => {
    getSettings().lazylibrarian = {
      audiobookshelfUrl: 'https://books.example.com',
    };
    await getRepository(Media).save(
      new Media({
        olId: WORK_ID,
        mediaType: MediaType.BOOK,
        status: MediaStatus.AVAILABLE,
      })
    );

    const agent = await login();
    const res = await agent.get(`/book/${WORK_ID}`);

    assert.strictEqual(res.body.audiobookshelfUrl, 'https://books.example.com');
  });

  it('answers 404 for an id that is not an OpenLibrary work id', async () => {
    const agent = await login();
    const res = await agent.get('/book/550');

    assert.strictEqual(res.status, 404);
  });
});

describe('GET /author/:id', () => {
  it('returns the author with their works and request status', async () => {
    await getRepository(Media).save(
      new Media({
        olId: WORK_ID,
        mediaType: MediaType.BOOK,
        status: MediaStatus.PENDING,
      })
    );

    const agent = await login();
    const res = await agent.get(`/author/${AUTHOR_ID}`);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.name, 'Roald Dahl');
    assert.strictEqual(
      res.body.bio,
      'British novelist and short story writer.'
    );
    assert.strictEqual(
      res.body.profilePath,
      'https://covers.openlibrary.org/a/id/9395323-L.jpg'
    );
    assert.strictEqual(res.body.totalWorks, 544);
    assert.deepStrictEqual(
      res.body.works.map((work: { id: string }) => work.id),
      [OTHER_WORK_ID, WORK_ID]
    );
    assert.strictEqual(res.body.works[0].posterPath, null);
    assert.strictEqual(res.body.works[1].mediaInfo.status, MediaStatus.PENDING);
  });

  it('answers 404 for an id that is not an OpenLibrary author id', async () => {
    const agent = await login();
    const res = await agent.get(`/author/${WORK_ID}`);

    assert.strictEqual(res.status, 404);
  });
});

describe('GET /search (books)', () => {
  it('returns books and authors with type=book', async () => {
    const agent = await login();
    const res = await agent.get('/search').query({
      query: 'fantastic mr fox',
      type: 'book',
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.totalPages, 3);
    assert.deepStrictEqual(
      res.body.results.map((result: { mediaType: string; id: string }) => [
        result.mediaType,
        result.id,
      ]),
      [
        ['book', WORK_ID],
        ['author', AUTHOR_ID],
      ]
    );
  });

  it('leads the book search with a narrator named like the query', async () => {
    narratorProducts = [
      {
        asin: 'B0BB3F6HKX',
        title: 'Fantastic Mr. Fox',
        authors: [{ name: 'Roald Dahl' }],
        narrators: [{ name: 'Chris ODowd' }],
      },
    ];
    const agent = await login();
    const res = await agent.get('/search').query({
      query: 'chris odowd',
      type: 'book',
    });

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.results[0], {
      id: 'Chris ODowd',
      mediaType: 'narrator',
      name: 'Chris ODowd',
      bookCount: 1,
      topWork: 'Fantastic Mr. Fox',
      profilePath: null,
    });
  });

  it('adds books to the regular search only once LazyLibrarian is configured', async () => {
    const agent = await login();

    const without = await agent.get('/search').query({ query: 'fox' });
    assert.deepStrictEqual(without.body.results, []);

    getSettings().lazylibrarian = {
      hostname: 'LazyLibrarian',
      apiKey: 'key',
    };
    const withBooks = await agent.get('/search').query({ query: 'fox' });
    assert.deepStrictEqual(
      withBooks.body.results.map(
        (result: { mediaType: string }) => result.mediaType
      ),
      ['book', 'author']
    );
  });
});

describe('GET /discover/books', () => {
  it('lists trending works and skips edition records', async () => {
    await getRepository(Media).save(
      new Media({
        olId: WORK_ID,
        mediaType: MediaType.BOOK,
        statusAudio: MediaStatus.AVAILABLE,
      })
    );

    const agent = await login();
    const res = await agent.get('/discover/books').query({ page: 2 });

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(trendingCalls, [
      { period: 'daily', page: 2, limit: 20 },
    ]);
    assert.strictEqual(res.body.results.length, 1);
    assert.strictEqual(res.body.results[0].id, WORK_ID);
    assert.strictEqual(
      res.body.results[0].mediaInfo.statusAudio,
      MediaStatus.AVAILABLE
    );
    // A short page is the last one
    assert.strictEqual(res.body.totalPages, 2);
  });

  it('lists popular books from the yearly trending list', async () => {
    const agent = await login();
    await agent.get('/discover/books/popular');

    assert.strictEqual(trendingCalls[0].period, 'yearly');
  });

  it('lists the books on a subject', async () => {
    const agent = await login();
    const res = await agent.get('/discover/books/subject/fantasy');

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.totalPages, 3);
    assert.strictEqual(res.body.results[0].authorName, 'Roald Dahl');
    assert.strictEqual(res.body.results[0].authorId, AUTHOR_ID);

    const invalid = await agent.get('/discover/books/subject/..%2Fadmin');
    assert.strictEqual(invalid.status, 404);
  });
});

describe('LazyLibrarian settings', () => {
  it('saves the settings after a successful connection test', async () => {
    const agent = await login('admin@seerr.dev');
    const res = await agent.post('/settings/lazylibrarian').send({
      hostname: 'LazyLibrarian',
      port: 5299,
      urlBase: '/request',
      apiKey: 'key',
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(getSettings().lazylibrarian.urlBase, '/request');
    assert.strictEqual(getSettings().fullPublicSettings.booksEnabled, true);
  });

  it('refuses settings it cannot connect with', async () => {
    getVersionImpl = async () => {
      throw new Error('connect ECONNREFUSED');
    };

    const agent = await login('admin@seerr.dev');
    const res = await agent
      .post('/settings/lazylibrarian')
      .send({ hostname: 'LazyLibrarian', port: 5299, apiKey: 'key' });

    assert.strictEqual(res.status, 500);
  });

  it('tests a connection without saving it', async () => {
    const agent = await login('admin@seerr.dev');
    const res = await agent
      .post('/settings/lazylibrarian/test')
      .send({ hostname: 'LazyLibrarian', port: 5299, apiKey: 'key' });

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body, { version: '1.2.3' });
    assert.strictEqual(getSettings().lazylibrarian.hostname, undefined);
  });
});
