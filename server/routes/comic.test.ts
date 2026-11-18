import assert from 'node:assert/strict';
import { afterEach, before, beforeEach, describe, it, mock } from 'node:test';

import OpenLibrary from '@server/api/openlibrary';
import type {
  TalearrComicAddBody,
  TalearrComicLibraryVolume,
  TalearrComicLookupResponse,
  TalearrComicPreview,
  TalearrComicPreviewAnswer,
  TalearrComicRootFolder,
  TalearrComicSeriesSummary,
  TalearrComicWantAnswer,
} from '@server/api/servarr/talearrComics';
import TalearrComicsAPI from '@server/api/servarr/talearrComics';
import TheMovieDb from '@server/api/themoviedb';
import type { TmdbSearchMultiResponse } from '@server/api/themoviedb/interfaces';
import type { ComicKind } from '@server/constants/media';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import MetadataComic from '@server/entity/MetadataComic';
import { User } from '@server/entity/User';
import { UserAccessProfile } from '@server/entity/UserAccessProfile';
import {
  resetComicsLibraryCache,
  resetComicsLookupCache,
  resetComicsPreviewCache,
  resetComicsStatusCache,
  syncComicAvailability,
} from '@server/lib/comics';
import { Permission } from '@server/lib/permissions';
import type { ChaptarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { checkUser } from '@server/middleware/auth';
import authRoutes from '@server/routes/auth';
import comicRoutes from '@server/routes/comic';
import requestRoutes from '@server/routes/request';
import searchRoutes from '@server/routes/search';
import { settleTestBackgroundTasks, setupTestDb } from '@server/test/db';
import type { Express } from 'express';
import express from 'express';
import session from 'express-session';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import request from 'supertest';

const FRIEREN_ID = 'al-118586';
const SAGA_ID = 'hc-4521';

const sendNotificationMock = mock.method(
  MediaRequest,
  'sendNotification',
  async () => undefined
).mock;

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
// Books join the combined search too
mock.method(OpenLibrary.prototype, 'searchBooks', async () => ({
  numFound: 0,
  start: 0,
  docs: [],
}));
mock.method(OpenLibrary.prototype, 'searchAuthors', async () => ({
  numFound: 0,
  start: 0,
  docs: [],
}));

// What Talearr answers and what it was asked
let statusAnswer: { available: boolean; reason?: string };
let lookups: { term: string; kind: ComicKind }[] = [];
let library: TalearrComicSeriesSummary[] = [];
let rootFolders: TalearrComicRootFolder[] = [];
let addCalls: TalearrComicAddBody[] = [];
let addImpl: (body: TalearrComicAddBody) => Promise<{ id: number }>;
let searchCalls: number[] = [];
let searchesOnAdd = true;

const lookupAnswers: Record<ComicKind, TalearrComicLookupResponse> = {
  manga: {
    results: [
      {
        aniListId: 118586,
        hardcoverSeriesId: 9001,
        kind: 'manga',
        title: 'Frieren: Beyond Journey’s End',
        alternateTitles: ['Sousou no Frieren'],
        year: 2020,
        status: 'Releasing',
        volumes: 13,
        authors: 'Kanehito Yamada, Tsukasa Abe',
        overview: 'An elf mage outlives her party.<br>',
        coverUrl: 'https://s4.anilist.co/file/frieren.jpg',
        ageRating: 'Teen',
        isAdult: false,
      },
      // Hardcover only, so Talearr labels it with the kind it was asked for
      {
        hardcoverSeriesId: 4521,
        kind: 'manga',
        title: 'Saga',
        alternateTitles: [],
        volumes: 11,
        authors: 'Brian K. Vaughan',
        coverUrl: 'https://assets.hardcover.app/saga.jpg',
        ageRating: 'Unknown',
        isAdult: false,
      },
    ],
    notices: ['AniList is slow'],
  },
  comic: {
    results: [
      {
        hardcoverSeriesId: 4521,
        kind: 'comic',
        title: 'Saga',
        alternateTitles: [],
        volumes: 11,
        authors: 'Brian K. Vaughan',
        coverUrl: 'https://assets.hardcover.app/saga.jpg',
        ageRating: 'Mature 17+',
        isAdult: false,
      },
    ],
    notices: [],
  },
};

mock.method(TalearrComicsAPI.prototype, 'getStatus', async () => ({
  ...statusAnswer,
  ageRatings: [],
}));
mock.method(
  TalearrComicsAPI.prototype,
  'lookup',
  async (term: string, kind: ComicKind) => {
    lookups.push({ term, kind });
    return lookupAnswers[kind];
  }
);
let seriesReads = 0;
mock.method(TalearrComicsAPI.prototype, 'getSeries', async () => {
  seriesReads++;
  return library;
});

// Talearr's library changes under a cached copy, as a test sets it
const setLibrary = (series: TalearrComicSeriesSummary[]) => {
  library = series;
  resetComicsLibraryCache();
};
mock.method(
  TalearrComicsAPI.prototype,
  'getRootFolders',
  async () => rootFolders
);
mock.method(
  TalearrComicsAPI.prototype,
  'searchesOnAdd',
  async () => searchesOnAdd
);
mock.method(
  TalearrComicsAPI.prototype,
  'addSeries',
  async (body: TalearrComicAddBody) => {
    addCalls.push(body);
    return addImpl(body);
  }
);
let monitorCalls: number[] = [];
mock.method(
  TalearrComicsAPI.prototype,
  'monitorMissingVolumes',
  async (seriesId: number) => {
    monitorCalls.push(seriesId);
    return 11;
  }
);
// Talearr's want route: undefined plays an older Talearr without it
let wantCalls: { seriesId: number; volumes: number[]; search?: boolean }[] = [];
let wantImpl: (
  seriesId: number,
  volumes: number[]
) => Promise<TalearrComicWantAnswer | undefined>;
mock.method(
  TalearrComicsAPI.prototype,
  'wantVolumes',
  async (
    seriesId: number,
    volumes: number[],
    options?: { search?: boolean }
  ) => {
    wantCalls.push({ seriesId, volumes, search: options?.search });
    return wantImpl(seriesId, volumes);
  }
);
mock.method(
  TalearrComicsAPI.prototype,
  'searchSeries',
  async (seriesId: number) => {
    searchCalls.push(seriesId);
  }
);

// Talearr's preview of a series: what it answers and what it was asked
let previewImpl: () => Promise<TalearrComicPreviewAnswer>;
let previewCalls: {
  aniListId?: number;
  hardcoverSeriesId?: number;
  kind?: ComicKind;
}[] = [];
mock.method(
  TalearrComicsAPI.prototype,
  'preview',
  async (ids: {
    aniListId?: number;
    hardcoverSeriesId?: number;
    kind?: ComicKind;
  }) => {
    previewCalls.push(ids);
    return previewImpl();
  }
);
let libraryVolumes: TalearrComicLibraryVolume[] = [];
let volumeReads: number[] = [];
mock.method(
  TalearrComicsAPI.prototype,
  'getSeriesVolumes',
  async (seriesId: number) => {
    volumeReads.push(seriesId);
    return libraryVolumes;
  }
);

const frierenPreview = (): TalearrComicPreview => ({
  aniListId: 118586,
  hardcoverSeriesId: 9001,
  kind: 'manga',
  title: 'Frieren: Beyond Journey’s End',
  alternateTitles: ['Sousou no Frieren', '葬送のフリーレン'],
  overview: 'After the hero party defeats the Demon King, Frieren wanders on.',
  authors: 'Kanehito Yamada, Tsukasa Abe',
  year: 2020,
  status: 'Releasing',
  genres: ['Adventure', 'Drama', 'Fantasy'],
  format: 'Manga',
  ageRating: 'Everyone',
  isAdult: false,
  coverUrl: 'https://s4.anilist.co/file/frieren-large.jpg',
  bannerUrl: 'https://s4.anilist.co/file/frieren-banner.jpg',
  volumeCount: 3,
  volumes: [
    {
      number: 2,
      title: null,
      releaseDate: '2022-01-11',
      coverUrl: 'https://assets.hardcover.app/frieren-2.jpg',
    },
    {
      number: 1,
      title: 'Volume One',
      releaseDate: '2021-11-09',
      coverUrl: null,
    },
    { number: 3, title: null, releaseDate: null, coverUrl: null },
  ],
  seriesId: null,
  notices: [],
});

const talearrServer: ChaptarrSettings = {
  id: 0,
  name: 'Talearr',
  hostname: 'talearr',
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

function configureBooks(service: 'talearr' | 'chaptarr' = 'talearr') {
  const settings = getSettings();
  settings.chaptarr = [{ ...talearrServer }];
  settings.main.bookService = service;
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
  app.use('/comic', comicRoutes);
  app.use('/request', requestRoutes);
  app.use('/search', searchRoutes);
  app.use(
    (
      err: { status?: number; message?: string },
      _req: express.Request,
      res: express.Response,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _next: express.NextFunction
    ) => {
      res.status(err.status ?? 500).json({ message: err.message });
    }
  );
  return app;
}

async function loginAs(email: string) {
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

async function waitFor(check: () => Promise<boolean> | boolean) {
  await settleTestBackgroundTasks();
  for (let i = 0; i < 100; i++) {
    if (await check()) {
      await settleTestBackgroundTasks();
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail('Condition was not met in time');
}

async function setRequester(permissions: number) {
  const repository = getRepository(User);
  const user = await repository.findOneOrFail({
    where: { email: 'demo@seerr.dev' },
  });
  user.permissions = permissions;
  await repository.save(user);
  return user;
}

// A search saves what Talearr said of each series
async function searchFirst() {
  const agent = await loginAs('demo@seerr.dev');
  const res = await agent.get('/comic/search').query({ query: 'frieren' });
  assert.strictEqual(res.status, 200, res.body.message);
}

const findMedia = (comicId: string) =>
  getRepository(Media).findOneOrFail({
    where: { comicId, mediaType: MediaType.COMIC },
  });

before(() => {
  app = createApp();
});

setupTestDb();

beforeEach(async () => {
  statusAnswer = { available: true };
  lookups = [];
  library = [];
  rootFolders = [
    { id: 1, path: '/comics', kind: 'comic', isKids: false },
    { id: 2, path: '/manga', kind: 'manga', isKids: false },
    { id: 3, path: '/kids', kind: 'any', isKids: true, maxAgeRating: 'Teen' },
  ];
  addCalls = [];
  addImpl = async () => ({ id: 41 });
  searchCalls = [];
  monitorCalls = [];
  wantCalls = [];
  wantImpl = async (seriesId, volumes) => ({
    seriesId,
    wanted: volumes,
    unknown: [],
    alreadyHave: [],
  });
  searchesOnAdd = true;
  sendNotificationMock.resetCalls();
  resetComicsStatusCache();
  resetComicsLibraryCache();
  resetComicsLookupCache();
  resetComicsPreviewCache();
  previewImpl = async () => ({ found: false, unsupported: true });
  previewCalls = [];
  libraryVolumes = [];
  volumeReads = [];
  seriesReads = 0;
  configureBooks();
  await setRequester(Permission.REQUEST_BOOK);
});

afterEach(() => {
  getSettings().chaptarr = [];
  getSettings().main.bookService = undefined;
  resetComicsStatusCache();
});

describe('GET /comic/status', () => {
  it('is on while book requests go to Talearr and its comics answer', async () => {
    const agent = await loginAs('demo@seerr.dev');

    const res = await agent.get('/comic/status');

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body, { enabled: true });
  });

  it('is off for stock Chaptarr', async () => {
    configureBooks('chaptarr');
    const agent = await loginAs('demo@seerr.dev');

    const res = await agent.get('/comic/status');

    assert.deepStrictEqual(res.body, { enabled: false, reason: 'notTalearr' });
  });

  it("is off while Talearr's comics library is", async () => {
    statusAnswer = { available: false, reason: 'database is locked' };
    const agent = await loginAs('demo@seerr.dev');

    const res = await agent.get('/comic/status');

    assert.strictEqual(res.body.enabled, false);
    assert.strictEqual(res.body.reason, 'unavailable');
    assert.strictEqual(res.body.message, 'database is locked');
  });
});

describe('GET /comic/search', () => {
  it('searches both kinds, keeping a Hardcover only series as a comic', async () => {
    const agent = await loginAs('demo@seerr.dev');

    const res = await agent.get('/comic/search').query({ query: 'saga' });

    assert.strictEqual(res.status, 200, res.body.message);
    assert.deepStrictEqual(lookups.map((lookup) => lookup.kind).sort(), [
      'comic',
      'manga',
    ]);
    assert.deepStrictEqual(
      res.body.results.map((result: { id: string; kind: string }) => [
        result.id,
        result.kind,
      ]),
      [
        [FRIEREN_ID, 'manga'],
        [SAGA_ID, 'comic'],
      ]
    );
    assert.deepStrictEqual(res.body.notices, ['AniList is slow']);

    const saved = await getRepository(MetadataComic).findOneOrFail({
      where: { comicId: SAGA_ID },
    });
    assert.strictEqual(saved.ageRating, 'Mature 17+');
  });

  it('drops a Hardcover result that is the same series as an AniList one', async () => {
    const answer = lookupAnswers.manga;
    lookupAnswers.manga = {
      ...answer,
      results: [
        ...answer.results,
        {
          hardcoverSeriesId: 62928,
          kind: 'manga',
          title: 'FRIEREN - Beyond Journey’s End',
          alternateTitles: [],
          authors: 'Tsukasa Abe',
          coverUrl: null,
          isAdult: false,
        },
      ],
    };
    lookupAnswers.manga.results[0] = {
      ...answer.results[0],
      title: 'Frieren: Beyond Journey’s End',
      hardcoverSeriesId: null,
    };
    const agent = await loginAs('demo@seerr.dev');

    try {
      const res = await agent.get('/comic/search').query({ query: 'frieren' });

      assert.strictEqual(res.status, 200, res.body.message);
      assert.deepStrictEqual(
        res.body.results.map((result: { id: string }) => result.id),
        [FRIEREN_ID, SAGA_ID]
      );
      const saved = await getRepository(MetadataComic).findOneOrFail({
        where: { comicId: FRIEREN_ID },
      });
      assert.strictEqual(saved.hardcoverSeriesId, 62928);
    } finally {
      lookupAnswers.manga = answer;
    }
  });

  it('marks series Talearr has already, reading its library once', async () => {
    setLibrary([
      {
        series: {
          id: 7,
          kind: 'comic',
          title: 'Saga',
          hardcoverSeriesId: 4521,
          monitored: true,
        },
        volumeCount: 11,
        downloadedCount: 11,
        missingCount: 0,
        downloadingCount: 0,
      },
    ]);
    const agent = await loginAs('demo@seerr.dev');

    await agent.get('/comic/search').query({ query: 'saga' });
    const res = await agent.get('/comic/search').query({ query: 'saga' });

    const saga = res.body.results.find(
      (result: { id: string }) => result.id === SAGA_ID
    );
    assert.strictEqual(saga.library.status, MediaStatus.AVAILABLE);
    assert.strictEqual(saga.library.seriesId, 7);
    assert.strictEqual(seriesReads, 1);
  });

  it('searches one kind when asked', async () => {
    const agent = await loginAs('demo@seerr.dev');

    const res = await agent
      .get('/comic/search')
      .query({ query: 'saga', kind: 'manga' });

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(lookups, [{ term: 'saga', kind: 'manga' }]);
    assert.strictEqual(res.body.results[1].kind, 'manga');
  });

  it('answers 404 while comics are off', async () => {
    configureBooks('chaptarr');
    const agent = await loginAs('demo@seerr.dev');

    const res = await agent.get('/comic/search').query({ query: 'saga' });

    assert.strictEqual(res.status, 404);
    assert.strictEqual(lookups.length, 0);
  });

  it('joins the combined search and has a search type of its own', async () => {
    const agent = await loginAs('demo@seerr.dev');

    const all = await agent.get('/search').query({ query: 'frieren' });
    const comics = await agent
      .get('/search')
      .query({ query: 'frieren', type: 'comic' });

    assert.strictEqual(all.status, 200, all.body.message);
    assert.ok(
      all.body.results.some(
        (result: { mediaType: string; id: string }) =>
          result.mediaType === 'comic' && result.id === FRIEREN_ID
      )
    );
    assert.strictEqual(comics.status, 200);
    assert.strictEqual(comics.body.results.length, 2);
  });

  it('answers the combined search in two parts when asked', async () => {
    const agent = await loginAs('demo@seerr.dev');

    const media = await agent
      .get('/search')
      .query({ query: 'frieren', sources: 'media' });

    assert.strictEqual(media.status, 200, media.body.message);
    assert.ok(
      !media.body.results.some(
        (result: { mediaType: string }) => result.mediaType === 'comic'
      )
    );
    assert.strictEqual(lookups.length, 0);

    const extras = await agent
      .get('/search')
      .query({ query: 'frieren', sources: 'extras' });

    assert.strictEqual(extras.status, 200, extras.body.message);
    assert.strictEqual(extras.body.totalPages, 1);
    assert.ok(
      extras.body.results.some(
        (result: { mediaType: string; id: string }) =>
          result.mediaType === 'comic' && result.id === FRIEREN_ID
      )
    );
  });

  it('keeps no extras past the first page', async () => {
    const agent = await loginAs('demo@seerr.dev');

    const res = await agent
      .get('/search')
      .query({ query: 'frieren', sources: 'extras', page: 2 });

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.results, []);
    assert.strictEqual(lookups.length, 0);
  });

  it('asks Talearr once for a search typed again', async () => {
    const agent = await loginAs('demo@seerr.dev');

    await agent.get('/search').query({ query: 'frieren' });
    const again = await agent.get('/search').query({ query: ' Frieren ' });

    assert.strictEqual(again.status, 200);
    assert.ok(
      again.body.results.some(
        (result: { mediaType: string }) => result.mediaType === 'comic'
      )
    );
    assert.deepStrictEqual(lookups.map((lookup) => lookup.kind).sort(), [
      'comic',
      'manga',
    ]);
  });

  it('leaves comics out of the combined search while they are off', async () => {
    configureBooks('chaptarr');
    const agent = await loginAs('demo@seerr.dev');

    const res = await agent.get('/search').query({ query: 'frieren' });

    assert.strictEqual(res.status, 200);
    assert.ok(
      !res.body.results.some(
        (result: { mediaType: string }) => result.mediaType === 'comic'
      )
    );
  });
});

describe('GET /comic/:comicId', () => {
  it('answers 404 for a series no search has found', async () => {
    const agent = await loginAs('demo@seerr.dev');

    assert.strictEqual((await agent.get('/comic/al-1')).status, 404);
    assert.strictEqual((await agent.get('/comic/OL45804W')).status, 404);
  });

  it('shows the saved facts and what Talearr holds', async () => {
    await searchFirst();
    setLibrary([
      {
        series: {
          id: 41,
          kind: 'manga',
          title: 'Frieren',
          aniListId: 118586,
          monitored: true,
        },
        volumeCount: 13,
        downloadedCount: 5,
        missingCount: 8,
        downloadingCount: 0,
      },
    ]);
    const agent = await loginAs('demo@seerr.dev');

    const res = await agent.get(`/comic/${FRIEREN_ID}`);

    assert.strictEqual(res.status, 200, res.body.message);
    assert.strictEqual(res.body.title, 'Frieren: Beyond Journey’s End');
    assert.strictEqual(res.body.kindKnown, true);
    assert.deepStrictEqual(res.body.library, {
      seriesId: 41,
      volumeCount: 13,
      downloadedCount: 5,
      missingCount: 8,
      downloadingCount: 0,
      status: MediaStatus.PARTIALLY_AVAILABLE,
    });
  });

  it('moves a requested series on as its volumes arrive', async () => {
    await searchFirst();
    await getRepository(Media).save(
      new Media({
        comicId: FRIEREN_ID,
        comicKind: 'manga',
        mediaType: MediaType.COMIC,
        status: MediaStatus.PROCESSING,
      })
    );
    setLibrary([
      {
        series: {
          id: 41,
          kind: 'manga',
          title: 'Frieren',
          aniListId: 118586,
          monitored: true,
        },
        volumeCount: 13,
        downloadedCount: 13,
        missingCount: 0,
        downloadingCount: 0,
      },
    ]);
    const agent = await loginAs('demo@seerr.dev');

    const res = await agent.get(`/comic/${FRIEREN_ID}`);

    assert.strictEqual(res.body.mediaInfo.status, MediaStatus.AVAILABLE);
    const media = await findMedia(FRIEREN_ID);
    assert.strictEqual(media.status, MediaStatus.AVAILABLE);
    assert.strictEqual(media.externalServiceId, 41);
  });
});

describe('GET /comic/:comicId with a Talearr preview', () => {
  it('adds the preview to the saved facts and keeps them', async () => {
    await searchFirst();
    previewImpl = async () => ({ found: true, preview: frierenPreview() });
    const agent = await loginAs('demo@seerr.dev');

    const res = await agent.get(`/comic/${FRIEREN_ID}`);

    assert.strictEqual(res.status, 200, res.body.message);
    assert.deepStrictEqual(previewCalls, [
      { aniListId: 118586, kind: 'manga' },
    ]);
    assert.strictEqual(
      res.body.overview,
      'After the hero party defeats the Demon King, Frieren wanders on.'
    );
    assert.deepStrictEqual(res.body.genres, ['Adventure', 'Drama', 'Fantasy']);
    assert.strictEqual(res.body.format, 'Manga');
    assert.strictEqual(
      res.body.bannerPath,
      'https://s4.anilist.co/file/frieren-banner.jpg'
    );
    assert.strictEqual(res.body.volumes, 3);
    assert.deepStrictEqual(res.body.alternateTitles, [
      'Sousou no Frieren',
      '葬送のフリーレン',
    ]);
    assert.deepStrictEqual(res.body.volumeList, [
      {
        number: 1,
        title: 'Volume One',
        releaseDate: '2021-11-09',
      },
      {
        number: 2,
        releaseDate: '2022-01-11',
        coverUrl: 'https://assets.hardcover.app/frieren-2.jpg',
      },
      { number: 3 },
    ]);
    // An age rating the search saved is kept, as requests are checked on it
    assert.strictEqual(res.body.ageRating, 'Teen');
    // The search's cover stays
    assert.strictEqual(
      res.body.posterPath,
      'https://s4.anilist.co/file/frieren.jpg'
    );

    const saved = await getRepository(MetadataComic).findOneOrFail({
      where: { comicId: FRIEREN_ID },
    });
    assert.strictEqual(saved.volumes, 3);
    assert.strictEqual(saved.overview, res.body.overview);
    assert.deepStrictEqual(saved.alternateTitles, res.body.alternateTitles);
    assert.strictEqual(saved.ageRating, 'Teen');
  });

  it('asks Talearr once in six hours', async () => {
    await searchFirst();
    previewImpl = async () => ({ found: true, preview: frierenPreview() });
    const agent = await loginAs('demo@seerr.dev');

    await agent.get(`/comic/${FRIEREN_ID}`).expect(200);
    const res = await agent.get(`/comic/${FRIEREN_ID}`).expect(200);

    assert.strictEqual(previewCalls.length, 1);
    assert.strictEqual(res.body.volumeList.length, 3);
  });

  it('asks by Hardcover id with the kind of a Hardcover only series', async () => {
    await searchFirst();
    const agent = await loginAs('demo@seerr.dev');

    const res = await agent.get(`/comic/${SAGA_ID}`);

    assert.strictEqual(res.status, 200, res.body.message);
    assert.deepStrictEqual(previewCalls, [
      { hardcoverSeriesId: 4521, kind: 'comic' },
    ]);
  });

  it('shows the saved facts for a series Talearr does not know', async () => {
    await searchFirst();
    previewImpl = async () => ({ found: false, unsupported: false });
    const agent = await loginAs('demo@seerr.dev');

    const res = await agent.get(`/comic/${FRIEREN_ID}`);

    assert.strictEqual(res.status, 200, res.body.message);
    assert.strictEqual(
      res.body.overview,
      'An elf mage outlives her party.<br>'
    );
    assert.strictEqual(res.body.volumes, 13);
    assert.deepStrictEqual(res.body.volumeList, []);
    assert.deepStrictEqual(res.body.genres, []);
    assert.strictEqual(res.body.bannerPath, undefined);
  });

  it('shows the saved facts on an older Talearr, or one whose sources are down', async () => {
    await searchFirst();
    const agent = await loginAs('demo@seerr.dev');

    const older = await agent.get(`/comic/${FRIEREN_ID}`);
    assert.strictEqual(older.status, 200, older.body.message);
    assert.strictEqual(older.body.title, 'Frieren: Beyond Journey’s End');
    assert.deepStrictEqual(older.body.volumeList, []);

    resetComicsPreviewCache();
    previewImpl = async () => {
      // As for a 503 while Talearr's sources are down
      throw new Error('AniList is down');
    };
    const failed = await agent.get(`/comic/${FRIEREN_ID}`);
    assert.strictEqual(failed.status, 200, failed.body.message);
    assert.strictEqual(failed.body.volumes, 13);

    // A failure is not kept, so the next page load asks again
    await agent.get(`/comic/${FRIEREN_ID}`).expect(200);
    assert.strictEqual(previewCalls.length, 3);
  });

  it('does not keep a preview whose sources were down for long', async () => {
    await searchFirst();
    previewImpl = async () => ({
      found: true,
      preview: { ...frierenPreview(), notices: ['Hardcover is down'] },
    });
    const agent = await loginAs('demo@seerr.dev');
    const realNow = Date.now;

    try {
      await agent.get(`/comic/${FRIEREN_ID}`).expect(200);
      await agent.get(`/comic/${FRIEREN_ID}`).expect(200);
      assert.strictEqual(previewCalls.length, 1);

      // Eleven minutes on, a partial preview is asked for again
      const later = realNow() + 11 * 60_000;
      Date.now = () => later;
      const res = await agent.get(`/comic/${FRIEREN_ID}`).expect(200);
      assert.strictEqual(previewCalls.length, 2);
      assert.deepStrictEqual(res.body.notices, ['Hardcover is down']);
    } finally {
      Date.now = realNow;
    }
  });

  it('marks each volume with what Talearr has of a library series', async () => {
    await searchFirst();
    previewImpl = async () => ({ found: true, preview: frierenPreview() });
    setLibrary([
      {
        series: {
          id: 41,
          kind: 'manga',
          title: 'Frieren',
          aniListId: 118586,
          monitored: true,
        },
        volumeCount: 3,
        downloadedCount: 1,
        missingCount: 1,
        downloadingCount: 1,
      },
    ]);
    libraryVolumes = [
      {
        number: 1,
        title: null,
        releaseDate: null,
        coverUrl: null,
        state: 'downloaded',
      },
      {
        number: 2,
        title: null,
        releaseDate: null,
        coverUrl: null,
        state: 'downloading',
      },
      {
        number: 3,
        title: null,
        releaseDate: null,
        coverUrl: null,
        state: 'missing',
      },
    ];
    const agent = await loginAs('demo@seerr.dev');

    const res = await agent.get(`/comic/${FRIEREN_ID}`);

    assert.strictEqual(res.status, 200, res.body.message);
    assert.deepStrictEqual(volumeReads, [41]);
    assert.deepStrictEqual(
      res.body.volumeList.map((volume: { number: number; state: string }) => [
        volume.number,
        volume.state,
      ]),
      [
        [1, 'downloaded'],
        [2, 'downloading'],
        [3, 'missing'],
      ]
    );
    // What Talearr holds stays as it was
    assert.strictEqual(res.body.library.seriesId, 41);
    assert.strictEqual(res.body.library.downloadedCount, 1);
  });

  it("lists the library's volumes when there is no preview", async () => {
    await searchFirst();
    setLibrary([
      {
        series: {
          id: 41,
          kind: 'manga',
          title: 'Frieren',
          aniListId: 118586,
          monitored: true,
        },
        volumeCount: 1,
        downloadedCount: 1,
        missingCount: 0,
        downloadingCount: 0,
      },
    ]);
    libraryVolumes = [
      {
        number: 1,
        title: 'Volume One',
        releaseDate: '2021-11-09',
        coverUrl: null,
        state: 'downloaded',
      },
    ];
    const agent = await loginAs('demo@seerr.dev');

    const res = await agent.get(`/comic/${FRIEREN_ID}`);

    assert.deepStrictEqual(res.body.volumeList, [
      {
        number: 1,
        title: 'Volume One',
        releaseDate: '2021-11-09',
        state: 'downloaded',
      },
    ]);
  });

  it('does not ask for a preview while comics are off', async () => {
    await searchFirst();
    configureBooks('chaptarr');
    const agent = await loginAs('demo@seerr.dev');

    const res = await agent.get(`/comic/${FRIEREN_ID}`);

    assert.strictEqual(res.status, 200, res.body.message);
    assert.strictEqual(previewCalls.length, 0);
    assert.strictEqual(volumeReads.length, 0);
    assert.strictEqual(res.body.title, 'Frieren: Beyond Journey’s End');
    assert.deepStrictEqual(res.body.volumeList, []);
  });
});

describe('comic requests', () => {
  it('waits for approval, then adds the series to Talearr', async () => {
    await searchFirst();
    const agent = await loginAs('demo@seerr.dev');

    const created = await agent
      .post('/request')
      .send({ mediaType: MediaType.COMIC, mediaId: FRIEREN_ID });

    assert.strictEqual(created.status, 201, created.body.message);
    assert.strictEqual(created.body.status, MediaRequestStatus.PENDING);
    assert.strictEqual(created.body.type, MediaType.COMIC);
    await settleTestBackgroundTasks();
    assert.strictEqual(addCalls.length, 0);
    assert.strictEqual(
      (await findMedia(FRIEREN_ID)).status,
      MediaStatus.PENDING
    );

    const admin = await loginAs('admin@seerr.dev');
    const approved = await admin.post(`/request/${created.body.id}/approve`);
    assert.strictEqual(approved.status, 200, approved.body.message);

    await waitFor(
      async () => (await findMedia(FRIEREN_ID)).externalServiceId === 41
    );
    assert.deepStrictEqual(addCalls, [
      { aniListId: 118586, kind: 'manga', rootFolderId: 2, monitor: 'all' },
    ]);
    // Talearr searches by itself on add
    assert.deepStrictEqual(searchCalls, []);
    const media = await findMedia(FRIEREN_ID);
    assert.strictEqual(media.status, MediaStatus.PROCESSING);
    assert.strictEqual(media.serviceId, 0);
  });

  it('asks Talearr to search when it does not on its own', async () => {
    await searchFirst();
    searchesOnAdd = false;
    await setRequester(Permission.REQUEST_BOOK | Permission.AUTO_APPROVE);
    const agent = await loginAs('demo@seerr.dev');

    const created = await agent
      .post('/request')
      .send({ mediaType: MediaType.COMIC, mediaId: FRIEREN_ID });

    assert.strictEqual(created.status, 201, created.body.message);
    assert.strictEqual(created.body.status, MediaRequestStatus.APPROVED);
    await waitFor(() => searchCalls.length > 0);
    assert.deepStrictEqual(searchCalls, [41]);
  });

  it('files a Hardcover only series as the kind the requester picked', async () => {
    await searchFirst();
    await setRequester(Permission.REQUEST_BOOK | Permission.AUTO_APPROVE);
    const agent = await loginAs('demo@seerr.dev');

    const created = await agent.post('/request').send({
      mediaType: MediaType.COMIC,
      mediaId: SAGA_ID,
      comicKind: 'manga',
    });

    assert.strictEqual(created.status, 201, created.body.message);
    await waitFor(() => addCalls.length > 0);
    assert.deepStrictEqual(addCalls[0], {
      hardcoverSeriesId: 4521,
      kind: 'manga',
      rootFolderId: 2,
      monitor: 'all',
    });
    assert.strictEqual((await findMedia(SAGA_ID)).comicKind, 'manga');
  });

  it('files the series of a person with an age limit in the kids library', async () => {
    await searchFirst();
    const user = await setRequester(
      Permission.REQUEST_BOOK | Permission.AUTO_APPROVE
    );
    await getRepository(UserAccessProfile).save(
      new UserAccessProfile({ user, ageLimit: 'teen' })
    );
    const agent = await loginAs('demo@seerr.dev');

    const created = await agent
      .post('/request')
      .send({ mediaType: MediaType.COMIC, mediaId: FRIEREN_ID });

    // An age limit always waits for someone who manages requests
    assert.strictEqual(created.status, 201, created.body.message);
    assert.strictEqual(created.body.status, MediaRequestStatus.PENDING);

    const admin = await loginAs('admin@seerr.dev');
    await admin.post(`/request/${created.body.id}/approve`);
    await waitFor(() => addCalls.length > 0);
    assert.strictEqual(addCalls[0].rootFolderId, 3);
  });

  it('refuses a series rated above the age limit', async () => {
    await searchFirst();
    const user = await setRequester(Permission.REQUEST_BOOK);
    await getRepository(UserAccessProfile).save(
      new UserAccessProfile({ user, ageLimit: 'teen' })
    );
    const agent = await loginAs('demo@seerr.dev');

    const res = await agent
      .post('/request')
      .send({ mediaType: MediaType.COMIC, mediaId: SAGA_ID });

    assert.strictEqual(res.status, 403);
  });

  const frierenInLibrary = (downloadedCount: number) =>
    setLibrary([
      {
        series: {
          id: 9,
          kind: 'manga',
          title: 'Frieren - Beyond Journey’s End',
          monitored: true,
        },
        volumeCount: 13,
        downloadedCount,
        missingCount: 13 - downloadedCount,
        downloadingCount: 0,
      },
    ]);

  it('refuses a series Talearr has every volume of, matched on its title', async () => {
    await searchFirst();
    frierenInLibrary(13);
    const agent = await loginAs('demo@seerr.dev');

    const detail = await agent.get(`/comic/${FRIEREN_ID}`);
    const res = await agent
      .post('/request')
      .send({ mediaType: MediaType.COMIC, mediaId: FRIEREN_ID });

    assert.strictEqual(detail.body.library.seriesId, 9);
    assert.strictEqual(res.status, 409);
    assert.strictEqual(addCalls.length, 0);
  });

  it('requests the missing volumes of a series Talearr has some of', async () => {
    await searchFirst();
    frierenInLibrary(2);
    const agent = await loginAs('demo@seerr.dev');

    const created = await agent
      .post('/request')
      .send({ mediaType: MediaType.COMIC, mediaId: FRIEREN_ID });

    assert.strictEqual(created.status, 201, created.body.message);
    assert.strictEqual(created.body.status, MediaRequestStatus.PENDING);
    await settleTestBackgroundTasks();
    assert.deepStrictEqual(monitorCalls, []);

    const admin = await loginAs('admin@seerr.dev');
    await admin.post(`/request/${created.body.id}/approve`).expect(200);

    await waitFor(() => searchCalls.length > 0);
    // Monitored and searched in place, not added again
    assert.deepStrictEqual(monitorCalls, [9]);
    assert.deepStrictEqual(searchCalls, [9]);
    assert.strictEqual(addCalls.length, 0);
    assert.strictEqual((await findMedia(FRIEREN_ID)).externalServiceId, 9);
  });

  it('needs the book request permission', async () => {
    await searchFirst();
    await setRequester(Permission.REQUEST_MUSIC);
    const agent = await loginAs('demo@seerr.dev');

    const res = await agent
      .post('/request')
      .send({ mediaType: MediaType.COMIC, mediaId: FRIEREN_ID });

    assert.strictEqual(res.status, 403);
  });

  it('refuses unknown series, a second request and stock Chaptarr', async () => {
    await searchFirst();
    const agent = await loginAs('demo@seerr.dev');

    const unknown = await agent
      .post('/request')
      .send({ mediaType: MediaType.COMIC, mediaId: 'al-1' });
    assert.strictEqual(unknown.status, 400);

    const first = await agent
      .post('/request')
      .send({ mediaType: MediaType.COMIC, mediaId: FRIEREN_ID });
    assert.strictEqual(first.status, 201);
    const second = await agent
      .post('/request')
      .send({ mediaType: MediaType.COMIC, mediaId: FRIEREN_ID });
    assert.strictEqual(second.status, 409);

    configureBooks('chaptarr');
    const chaptarr = await agent
      .post('/request')
      .send({ mediaType: MediaType.COMIC, mediaId: SAGA_ID });
    assert.strictEqual(chaptarr.status, 400);
  });

  it('counts against the book quota', async () => {
    await searchFirst();
    const user = await setRequester(Permission.REQUEST_BOOK);
    user.bookQuotaLimit = 1;
    user.bookQuotaDays = 7;
    await getRepository(User).save(user);
    const agent = await loginAs('demo@seerr.dev');

    const first = await agent
      .post('/request')
      .send({ mediaType: MediaType.COMIC, mediaId: FRIEREN_ID });
    const second = await agent
      .post('/request')
      .send({ mediaType: MediaType.COMIC, mediaId: SAGA_ID });

    assert.strictEqual(first.status, 201, first.body.message);
    assert.strictEqual(second.status, 403);
    assert.match(second.body.message, /Book Quota/);
  });

  it('marks the request failed when Talearr refuses the series', async () => {
    await searchFirst();
    rootFolders = [];
    await setRequester(Permission.REQUEST_BOOK | Permission.AUTO_APPROVE);
    const agent = await loginAs('demo@seerr.dev');

    const created = await agent
      .post('/request')
      .send({ mediaType: MediaType.COMIC, mediaId: FRIEREN_ID });

    assert.strictEqual(created.status, 201, created.body.message);
    await waitFor(
      async () =>
        (
          await getRepository(MediaRequest).findOneOrFail({
            where: { id: created.body.id },
          })
        ).status === MediaRequestStatus.FAILED
    );
    assert.strictEqual(addCalls.length, 0);
  });
});

describe('comic volume requests', () => {
  const frierenSeries = (downloadedCount: number) =>
    setLibrary([
      {
        series: {
          id: 9,
          kind: 'manga',
          title: 'Frieren - Beyond Journey’s End',
          monitored: true,
        },
        volumeCount: 3,
        downloadedCount,
        missingCount: 3 - downloadedCount,
        downloadingCount: 0,
      },
    ]);
  const volume = (
    number: number,
    state: TalearrComicLibraryVolume['state']
  ): TalearrComicLibraryVolume => ({
    number,
    title: null,
    releaseDate: null,
    coverUrl: null,
    state,
  });
  const requestVolumes = (
    agent: Awaited<ReturnType<typeof loginAs>>,
    volumes: unknown
  ) =>
    agent
      .post('/request')
      .send({ mediaType: MediaType.COMIC, mediaId: FRIEREN_ID, volumes });

  it('adds a new series with only the volumes asked for', async () => {
    await searchFirst();
    previewImpl = async () => ({ found: true, preview: frierenPreview() });
    addImpl = async (body) => ({
      id: 41,
      wanted: body.volumes ?? [],
      unknown: [],
    });
    const agent = await loginAs('demo@seerr.dev');

    const created = await requestVolumes(agent, [3, 1, 1]);

    assert.strictEqual(created.status, 201, created.body.message);
    assert.deepStrictEqual(created.body.comicVolumes, [1, 3]);
    assert.strictEqual(created.body.status, MediaRequestStatus.PENDING);

    const admin = await loginAs('admin@seerr.dev');
    await admin.post(`/request/${created.body.id}/approve`).expect(200);

    await waitFor(
      async () => (await findMedia(FRIEREN_ID)).externalServiceId === 41
    );
    assert.deepStrictEqual(addCalls, [
      {
        aniListId: 118586,
        kind: 'manga',
        rootFolderId: 2,
        monitor: 'all',
        volumes: [1, 3],
      },
    ]);
    assert.deepStrictEqual(wantCalls, []);
  });

  it('keeps asking for the whole series without volumes', async () => {
    await searchFirst();
    await setRequester(Permission.REQUEST_BOOK | Permission.AUTO_APPROVE);
    const agent = await loginAs('demo@seerr.dev');

    const created = await requestVolumes(agent, []);

    assert.strictEqual(created.status, 201, created.body.message);
    assert.strictEqual(created.body.comicVolumes, null);
    await waitFor(() => addCalls.length > 0);
    assert.strictEqual(addCalls[0].volumes, undefined);
  });

  it('refuses volumes that are not volume numbers or not of the series', async () => {
    await searchFirst();
    previewImpl = async () => ({ found: true, preview: frierenPreview() });
    const agent = await loginAs('demo@seerr.dev');

    const notNumbers = await requestVolumes(agent, ['1']);
    const negative = await requestVolumes(agent, [-2]);
    const notListed = await requestVolumes(agent, [2, 9]);

    assert.strictEqual(notNumbers.status, 400);
    assert.strictEqual(negative.status, 400);
    assert.strictEqual(notListed.status, 400);
    assert.match(notListed.body.message, /Vol\. 9/);
  });

  it('takes any volume while the volumes of the series are not listed', async () => {
    await searchFirst();
    const agent = await loginAs('demo@seerr.dev');

    const created = await requestVolumes(agent, [9]);

    assert.strictEqual(created.status, 201, created.body.message);
    assert.deepStrictEqual(created.body.comicVolumes, [9]);
  });

  it('asks for more volumes later, but never the same volume twice', async () => {
    await searchFirst();
    previewImpl = async () => ({ found: true, preview: frierenPreview() });
    const agent = await loginAs('demo@seerr.dev');

    const first = await requestVolumes(agent, [1, 2]);
    const overlapping = await requestVolumes(agent, [2, 3]);
    const more = await requestVolumes(agent, [3]);
    const whole = await requestVolumes(agent, undefined);

    assert.strictEqual(first.status, 201, first.body.message);
    assert.strictEqual(overlapping.status, 409);
    assert.match(overlapping.body.message, /Vol\. 2/);
    assert.strictEqual(more.status, 201, more.body.message);
    assert.deepStrictEqual(more.body.comicVolumes, [3]);
    // Volumes asked for already stand in the way of the whole series
    assert.strictEqual(whole.status, 409);

    // A declined request frees its volumes
    const admin = await loginAs('admin@seerr.dev');
    await admin.post(`/request/${first.body.id}/decline`).expect(200);
    const again = await requestVolumes(agent, [2]);
    assert.strictEqual(again.status, 201, again.body.message);

    const media = await getRepository(Media).findOneOrFail({
      where: { comicId: FRIEREN_ID },
      relations: { requests: true },
    });
    assert.strictEqual(media.requests.length, 3);
  });

  it('refuses volumes after a request of the whole series', async () => {
    await searchFirst();
    const agent = await loginAs('demo@seerr.dev');

    const whole = await requestVolumes(agent, undefined);
    const volumes = await requestVolumes(agent, [1]);

    assert.strictEqual(whole.status, 201, whole.body.message);
    assert.strictEqual(volumes.status, 409);
  });

  it('refuses volumes Talearr has or is fetching', async () => {
    await searchFirst();
    frierenSeries(1);
    libraryVolumes = [
      volume(1, 'downloaded'),
      volume(2, 'downloading'),
      volume(3, 'missing'),
    ];
    const agent = await loginAs('demo@seerr.dev');

    const have = await requestVolumes(agent, [1, 3]);
    const fetching = await requestVolumes(agent, [2]);

    assert.strictEqual(have.status, 409);
    assert.match(have.body.message, /Vol\. 1 /);
    assert.strictEqual(fetching.status, 409);
  });

  it('wants only the volumes asked for of a series Talearr has', async () => {
    await searchFirst();
    frierenSeries(1);
    libraryVolumes = [volume(1, 'downloaded'), volume(2, 'missing')];
    await setRequester(Permission.REQUEST_BOOK | Permission.AUTO_APPROVE);
    const agent = await loginAs('demo@seerr.dev');

    const created = await requestVolumes(agent, [2]);

    assert.strictEqual(created.status, 201, created.body.message);
    assert.strictEqual(created.body.status, MediaRequestStatus.APPROVED);
    await waitFor(
      async () => (await findMedia(FRIEREN_ID)).externalServiceId === 9
    );
    assert.deepStrictEqual(wantCalls, [
      { seriesId: 9, volumes: [2], search: true },
    ]);
    // Talearr searches for the wanted volumes itself
    assert.deepStrictEqual(monitorCalls, []);
    assert.deepStrictEqual(searchCalls, []);
    assert.strictEqual(addCalls.length, 0);
  });

  it('wants every missing volume on an older Talearr', async () => {
    await searchFirst();
    frierenSeries(1);
    libraryVolumes = [volume(1, 'downloaded'), volume(2, 'missing')];
    wantImpl = async () => undefined;
    await setRequester(Permission.REQUEST_BOOK | Permission.AUTO_APPROVE);
    const agent = await loginAs('demo@seerr.dev');

    const created = await requestVolumes(agent, [2]);

    assert.strictEqual(created.status, 201, created.body.message);
    await waitFor(() => searchCalls.length > 0);
    assert.strictEqual(wantCalls.length, 1);
    assert.deepStrictEqual(monitorCalls, [9]);
    assert.deepStrictEqual(searchCalls, [9]);
  });

  it('completes a volume request once Talearr has its volumes', async () => {
    await searchFirst();
    frierenSeries(1);
    libraryVolumes = [volume(1, 'downloaded'), volume(2, 'missing')];
    await setRequester(Permission.REQUEST_BOOK | Permission.AUTO_APPROVE);
    const agent = await loginAs('demo@seerr.dev');

    const created = await requestVolumes(agent, [2]);
    assert.strictEqual(created.status, 201, created.body.message);
    await waitFor(() => wantCalls.length > 0);

    const statusOf = async () =>
      (
        await getRepository(MediaRequest).findOneOrFail({
          where: { id: created.body.id },
        })
      ).status;

    await syncComicAvailability();
    assert.strictEqual(await statusOf(), MediaRequestStatus.APPROVED);

    libraryVolumes = [volume(1, 'downloaded'), volume(2, 'downloaded')];
    await syncComicAvailability();
    assert.strictEqual(await statusOf(), MediaRequestStatus.COMPLETED);
  });

  it('has the volume column in the sqlite and postgres migrations', () => {
    for (const db of ['sqlite', 'postgres']) {
      const dir = path.join(__dirname, '../migration', db);
      const file = readdirSync(dir).find((name) =>
        name.endsWith('-AddComicVolumeRequests.ts')
      );

      assert.ok(file, `${db} migration is missing`);
      const source = readFileSync(path.join(dir, file), 'utf8');
      assert.match(source, /"media_request" ADD (COLUMN )?"comicVolumes" text/);
      assert.match(source, /DROP COLUMN "comicVolumes"/);
    }
  });
});
