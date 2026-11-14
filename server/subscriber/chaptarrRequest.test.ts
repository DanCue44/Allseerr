import assert from 'node:assert/strict';
import { afterEach, before, beforeEach, describe, it, mock } from 'node:test';

import LazyLibrarianAPI from '@server/api/lazylibrarian';
import OpenLibrary from '@server/api/openlibrary';
import type {
  OlAuthor,
  OlSearchDoc,
  OlSearchResponse,
  OlWork,
} from '@server/api/openlibrary/interfaces';
import type { Tag } from '@server/api/servarr/base';
import type {
  ChaptarrAddBookOptions,
  ChaptarrAddBookResult,
  ChaptarrAuthor,
  ChaptarrBook,
  ChaptarrMediaType,
  ChaptarrPendingResult,
  ChaptarrReleaseProfile,
} from '@server/api/servarr/chaptarr';
import ChaptarrAPI from '@server/api/servarr/chaptarr';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import { UserSettings } from '@server/entity/UserSettings';
import { requestAuthorCatalog } from '@server/lib/bulkRequests';
import notificationManager, { Notification } from '@server/lib/notifications';
import type { ChaptarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { checkUser } from '@server/middleware/auth';
import authRoutes from '@server/routes/auth';
import requestRoutes from '@server/routes/request';
import { settleTestBackgroundTasks, setupTestDb } from '@server/test/db';
import type { Express } from 'express';
import express from 'express';
import session from 'express-session';
import request from 'supertest';

const WORK_ID = 'OL66554W';
const AUTHOR_ID = 'OL21594A';
const FOREIGN_ID = 'gr:3060926';
const AUTHOR_CHAPTARR_ID = 1;

const sendNotificationMock = mock.method(
  MediaRequest,
  'sendNotification',
  async () => undefined
).mock;
mock.method(notificationManager, 'sendNotification', () => undefined);

mock.method(
  OpenLibrary.prototype,
  'getWork',
  async (workId: string): Promise<OlWork> => ({
    key: `/works/${workId}`,
    title: 'Pride and Prejudice',
    type: { key: '/type/work' },
    authors: [{ author: { key: `/authors/${AUTHOR_ID}` } }],
  })
);
mock.method(
  OpenLibrary.prototype,
  'getWorkSummary',
  async (workId: string): Promise<OlSearchDoc> => ({
    key: `/works/${workId}`,
    title: workId === WORK_ID ? 'Pride and Prejudice' : `Book ${workId}`,
    author_name: ['Jane Austen'],
  })
);
mock.method(OpenLibrary.prototype, 'getWorkIsbns', async () => []);
mock.method(
  OpenLibrary.prototype,
  'getAuthor',
  async (authorId: string): Promise<OlAuthor> => ({
    key: `/authors/${authorId}`,
    name: 'Jane Austen',
    type: { key: '/type/author' },
  })
);
mock.method(
  OpenLibrary.prototype,
  'getAuthorWorks',
  async (): Promise<OlSearchResponse> => ({
    numFound: 3,
    start: 0,
    docs: ['OL1W', 'OL2W', 'OL3W'].map((olId) => ({
      key: `/works/${olId}`,
      title: `Book ${olId}`,
    })),
  })
);

// Chaptarr's library, its metadata search and what it is asked to do
let library: ChaptarrBook[] = [];
let addCalls: { title: string; options: ChaptarrAddBookOptions }[] = [];
let monitorCalls: [number[], boolean][] = [];
let searchCalls: number[][] = [];
// Chaptarr's tags, release profiles and authors, and what changed them
let chaptarrTags: Tag[] = [];
let releaseProfiles: ChaptarrReleaseProfile[] = [];
let authors: Record<number, ChaptarrAuthor> = {};
// Calls in order, to check that an author is tagged before the search
let chaptarrEvents: string[] = [];
let addImpl: (
  book: ChaptarrBook,
  options: ChaptarrAddBookOptions
) => Promise<ChaptarrAddBookResult>;
let pendingOutcome: ChaptarrPendingResult = 'succeeded';
let runningAdds = 0;
let maxRunningAdds = 0;

const lookupResult = (title: string, foreignBookId: string): ChaptarrBook => ({
  title,
  foreignBookId,
  monitored: false,
  mediaType: 'audiobook',
  authorId: AUTHOR_CHAPTARR_ID,
  author: { authorName: 'Jane Austen', foreignAuthorId: 'gr:1265' },
  editions: [{ foreignEditionId: 'gr:1', monitored: true }],
});

const localBooks = (foreignBookId: string, mediaType: ChaptarrMediaType) =>
  library
    .filter(
      (book) =>
        book.foreignBookId === foreignBookId && book.mediaType === mediaType
    )
    .map((book) => ({ id: book.id as number, mediaType }));

mock.method(ChaptarrAPI.prototype, 'getCapabilities', async () => ({
  appName: 'Chaptarr',
  version: '0.9.911.0',
  isChaptarr: true,
}));
mock.method(
  ChaptarrAPI.prototype,
  'lookupBooks',
  async (term: string, mediaType?: ChaptarrMediaType) => {
    if (term.startsWith('gr:')) {
      // Chaptarr lists the books it has of an id, with both formats
      return library
        .filter(
          (book) =>
            book.foreignBookId === term &&
            (!mediaType || book.mediaType === mediaType)
        )
        .map((book) => ({
          ...book,
          localEbookBooks: localBooks(term, 'ebook'),
          localAudiobookBooks: localBooks(term, 'audiobook'),
        }));
    }

    const [title, foreignBookId] = term.startsWith('Pride and Prejudice')
      ? ['Pride and Prejudice', FOREIGN_ID]
      : [term.replace(/ Jane Austen$/, ''), `gr:${term.split(' ')[1]}`];

    return [
      {
        ...lookupResult(title, foreignBookId),
        localEbookBooks: localBooks(foreignBookId, 'ebook'),
        localAudiobookBooks: localBooks(foreignBookId, 'audiobook'),
      },
    ];
  }
);
mock.method(ChaptarrAPI.prototype, 'getBook', async (bookId: number) =>
  library.find((book) => book.id === bookId)
);
// Duplicates of a book are looked for among its author's books
mock.method(
  ChaptarrAPI.prototype,
  'getBooksByAuthor',
  async (authorId: number) =>
    library.filter((book) => book.authorId === authorId)
);
// The library books here list no editions, so none is switched
mock.method(ChaptarrAPI.prototype, 'getEditions', async () => []);
mock.method(
  ChaptarrAPI.prototype,
  'addBook',
  async (book: ChaptarrBook, options: ChaptarrAddBookOptions) => {
    runningAdds++;
    maxRunningAdds = Math.max(maxRunningAdds, runningAdds);
    addCalls.push({ title: book.title, options });

    try {
      // Long enough for a second add to start if adds were not queued
      await new Promise((resolve) => setTimeout(resolve, 5));
      return await addImpl(book, options);
    } finally {
      runningAdds--;
    }
  }
);
mock.method(
  ChaptarrAPI.prototype,
  'waitForPendingImport',
  async () => pendingOutcome
);
mock.method(
  ChaptarrAPI.prototype,
  'setBooksMonitored',
  async (bookIds: number[], monitored: boolean) => {
    monitorCalls.push([bookIds, monitored]);
  }
);
mock.method(ChaptarrAPI.prototype, 'searchBooks', async (bookIds: number[]) => {
  searchCalls.push(bookIds);
  chaptarrEvents.push(`search ${bookIds.join(',')}`);
});
mock.method(ChaptarrAPI.prototype, 'getChaptarrTags', async () =>
  chaptarrTags.map((tag) => ({ ...tag }))
);
mock.method(
  ChaptarrAPI.prototype,
  'createChaptarrTag',
  async (label: string) => {
    const tag = { id: chaptarrTags.length + 1, label };
    chaptarrTags.push(tag);
    chaptarrEvents.push(`create tag ${label}`);
    return tag;
  }
);
mock.method(ChaptarrAPI.prototype, 'getReleaseProfiles', async () =>
  releaseProfiles.map((profile) => ({ ...profile }))
);
mock.method(
  ChaptarrAPI.prototype,
  'createReleaseProfile',
  async (profile: ChaptarrReleaseProfile) => {
    const created = { ...profile, id: releaseProfiles.length + 1 };
    releaseProfiles.push(created);
    chaptarrEvents.push(`create profile ${profile.tags.join(',')}`);
    return created;
  }
);
mock.method(
  ChaptarrAPI.prototype,
  'updateReleaseProfile',
  async (profile: ChaptarrReleaseProfile) => {
    releaseProfiles = releaseProfiles.map((existing) =>
      existing.id === profile.id ? { ...profile } : existing
    );
    chaptarrEvents.push(`update profile ${profile.id}`);
  }
);
mock.method(ChaptarrAPI.prototype, 'getAuthor', async (authorId: number) => ({
  ...authors[authorId],
}));
// The author's format switch is covered in chaptarrRequests.test.ts
mock.method(ChaptarrAPI.prototype, 'enableAuthorFormat', async () => false);
mock.method(
  ChaptarrAPI.prototype,
  'updateAuthor',
  async (author: ChaptarrAuthor) => {
    authors[author.id as number] = { ...author };
    chaptarrEvents.push(`tag author ${author.id}`);
  }
);

const addToLibrary = (
  book: ChaptarrBook,
  mediaType: ChaptarrMediaType
): ChaptarrBook => {
  const added = {
    ...book,
    id: 100 + library.length,
    mediaType,
    monitored: true,
  };
  library.push(added);
  return added;
};

const lazyLibrarianAdds = mock.method(
  LazyLibrarianAPI.prototype,
  'getAllBooks',
  async () => []
).mock;
mock.method(LazyLibrarianAPI.prototype, 'getBook', async () => ({
  bookId: WORK_ID,
  title: 'Pride and Prejudice',
  status: 'Skipped',
  audioStatus: 'Skipped',
}));
mock.method(LazyLibrarianAPI.prototype, 'addBook', async () => undefined);
mock.method(LazyLibrarianAPI.prototype, 'queueBook', async () => undefined);
mock.method(LazyLibrarianAPI.prototype, 'searchBook', async () => undefined);

const chaptarrServer: ChaptarrSettings = {
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
  activeAudiobookProfileId: 2,
  activeAudiobookProfileName: 'Audiobook',
  activeAudiobookMetadataProfileId: 1,
  activeAudiobookMetadataProfileName: 'Audiobook Default',
  activeAudiobookDirectory: '/audiobooks',
  tags: [],
  is4k: false,
  isDefault: true,
  syncEnabled: true,
  preventSearch: false,
  tagRequests: false,
  overrideRule: [],
};

function configureServices({
  chaptarr = true,
  lazyLibrarian = false,
}: { chaptarr?: boolean; lazyLibrarian?: boolean } = {}): void {
  const settings = getSettings();
  settings.chaptarr = chaptarr ? [{ ...chaptarrServer }] : [];

  const lazyLibrarianSettings = settings.lazylibrarian as Record<
    string,
    unknown
  >;
  for (const key of Object.keys(lazyLibrarianSettings)) {
    delete lazyLibrarianSettings[key];
  }
  if (lazyLibrarian) {
    Object.assign(lazyLibrarianSettings, {
      hostname: 'LazyLibrarian',
      port: 5299,
      apiKey: 'test-key',
    });
  }
  settings.main.bookService = undefined;
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
  app.use('/request', requestRoutes);
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

// The Chaptarr request runs detached from the request, like Radarr's
async function waitFor(check: () => Promise<boolean> | boolean) {
  // The detached work usually settles the check, polling covers the rest
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

const findBookMedia = (olId = WORK_ID) =>
  getRepository(Media).findOneOrFail({
    where: { olId, mediaType: MediaType.BOOK },
  });

before(() => {
  app = createApp();
});

setupTestDb();

beforeEach(() => {
  library = [];
  addCalls = [];
  monitorCalls = [];
  searchCalls = [];
  chaptarrTags = [];
  releaseProfiles = [];
  authors = {
    [AUTHOR_CHAPTARR_ID]: {
      id: AUTHOR_CHAPTARR_ID,
      authorName: 'Jane Austen',
      foreignAuthorId: 'gr:1265',
      tags: [50],
      ebookTags: [50],
      audiobookTags: [],
    },
  };
  chaptarrEvents = [];
  getSettings().main.bookLanguage = 'en';
  pendingOutcome = 'succeeded';
  runningAdds = 0;
  maxRunningAdds = 0;
  addImpl = async (book, options) => ({
    status: 'added',
    book: addToLibrary(book, options.mediaType),
  });
  sendNotificationMock.resetCalls();
  lazyLibrarianAdds.resetCalls();
  configureServices();
});

afterEach(() => {
  configureServices({ chaptarr: false });
});

describe('book requests sent to Chaptarr', () => {
  it('adds an ebook with the ebook settings and keeps its Chaptarr ids', async () => {
    const agent = await loginAs('admin@seerr.dev');
    const res = await agent
      .post('/request')
      .send({ mediaType: MediaType.BOOK, mediaId: WORK_ID });

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.status, MediaRequestStatus.APPROVED);

    await waitFor(
      async () => (await findBookMedia()).externalServiceId === 100
    );

    assert.deepStrictEqual(addCalls, [
      {
        title: 'Pride and Prejudice',
        options: {
          qualityProfileId: 1,
          metadataProfileId: 2,
          rootFolderPath: '/ebooks',
          // The English language tag
          tags: [1],
          searchForNewBook: true,
          mediaType: 'ebook',
        },
      },
    ]);

    const media = await findBookMedia();
    assert.strictEqual(media.serviceId, 0);
    assert.strictEqual(media.foreignBookId, FOREIGN_ID);
    assert.strictEqual(media.externalServiceIdAudio, null);
    assert.strictEqual(media.status, MediaStatus.PROCESSING);
    assert.strictEqual(media.statusAudio, MediaStatus.UNKNOWN);
    assert.strictEqual(lazyLibrarianAdds.callCount(), 0);
  });

  it('requests the audiobook on its own with the audiobook settings', async () => {
    const agent = await loginAs('admin@seerr.dev');
    await agent
      .post('/request')
      .send({ mediaType: MediaType.BOOK, mediaId: WORK_ID });
    await waitFor(
      async () => (await findBookMedia()).externalServiceId === 100
    );

    const audiobook = await agent
      .post('/request')
      .send({ mediaType: MediaType.BOOK, mediaId: WORK_ID, isAudiobook: true });
    assert.strictEqual(audiobook.status, 201);

    await waitFor(
      async () => (await findBookMedia()).externalServiceIdAudio === 101
    );

    assert.deepStrictEqual(
      addCalls.map(({ options }) => [
        options.mediaType,
        options.rootFolderPath,
        options.qualityProfileId,
        options.metadataProfileId,
      ]),
      [
        ['ebook', '/ebooks', 1, 2],
        ['audiobook', '/audiobooks', 2, 1],
      ]
    );

    const media = await findBookMedia();
    assert.strictEqual(media.externalServiceId, 100);
    assert.strictEqual(media.status, MediaStatus.PROCESSING);
    assert.strictEqual(media.statusAudio, MediaStatus.PROCESSING);
  });

  it('monitors and searches a book Chaptarr already has in that format', async () => {
    library = [
      {
        ...lookupResult('Pride and Prejudice', FOREIGN_ID),
        id: 55,
        mediaType: 'audiobook',
        monitored: false,
      },
    ];

    const agent = await loginAs('admin@seerr.dev');
    await agent
      .post('/request')
      .send({ mediaType: MediaType.BOOK, mediaId: WORK_ID, isAudiobook: true });

    await waitFor(
      async () => (await findBookMedia()).externalServiceIdAudio === 55
    );
    assert.strictEqual(addCalls.length, 0);
    assert.deepStrictEqual(monitorCalls, [[[55], true]]);
    assert.deepStrictEqual(searchCalls, [[55]]);
  });

  it('finishes the request once a pending author import is ready', async () => {
    addImpl = async (book, options) => {
      // The author import adds the author's books, unmonitored
      library.push({
        ...book,
        id: 77,
        mediaType: options.mediaType,
        monitored: false,
      });
      return { status: 'pending', pendingId: 9 };
    };

    const agent = await loginAs('admin@seerr.dev');
    await agent
      .post('/request')
      .send({ mediaType: MediaType.BOOK, mediaId: WORK_ID });

    await waitFor(async () => (await findBookMedia()).externalServiceId === 77);
    assert.deepStrictEqual(monitorCalls, [[[77], true]]);
    assert.deepStrictEqual(searchCalls, [[77]]);
  });

  it('keeps the work id of a book whose author is still importing', async () => {
    addImpl = async () => ({ status: 'pending', pendingId: 10 });
    pendingOutcome = 'timeout';

    const agent = await loginAs('admin@seerr.dev');
    const res = await agent
      .post('/request')
      .send({ mediaType: MediaType.BOOK, mediaId: WORK_ID });

    await waitFor(
      async () => (await findBookMedia()).foreignBookId === FOREIGN_ID
    );
    const media = await findBookMedia();
    assert.strictEqual(media.externalServiceId, null);

    const saved = await getRepository(MediaRequest).findOneOrFail({
      where: { id: res.body.id },
    });
    assert.strictEqual(saved.status, MediaRequestStatus.APPROVED);
  });

  it('marks the request failed when Chaptarr cannot add the book', async () => {
    addImpl = async () => {
      throw new Error('Chaptarr is down');
    };

    const agent = await loginAs('admin@seerr.dev');
    const res = await agent
      .post('/request')
      .send({ mediaType: MediaType.BOOK, mediaId: WORK_ID });

    await waitFor(async () => {
      const saved = await getRepository(MediaRequest).findOneOrFail({
        where: { id: res.body.id },
      });
      return saved.status === MediaRequestStatus.FAILED;
    });
    assert.ok(
      sendNotificationMock.calls.some(
        (call) => call.arguments[2] === Notification.MEDIA_FAILED
      )
    );
  });

  it('sends the books of an author catalog request one at a time', async () => {
    const admin = await getRepository(User).findOneOrFail({
      where: { email: 'admin@seerr.dev' },
    });

    const result = await requestAuthorCatalog(admin, {
      authorId: AUTHOR_ID,
      olIds: ['OL1W', 'OL2W', 'OL3W'],
      format: 'both',
    });
    assert.strictEqual(result.created.length, 6);

    await waitFor(() => addCalls.length === 6);
    assert.strictEqual(maxRunningAdds, 1);
    assert.deepStrictEqual(
      addCalls.map(({ title, options }) => [title, options.mediaType]),
      [
        ['Book OL1W', 'ebook'],
        ['Book OL1W', 'audiobook'],
        ['Book OL2W', 'ebook'],
        ['Book OL2W', 'audiobook'],
        ['Book OL3W', 'ebook'],
        ['Book OL3W', 'audiobook'],
      ]
    );

    await waitFor(
      async () => (await findBookMedia('OL3W')).externalServiceIdAudio === 105
    );
  });
});

describe('book request languages', () => {
  const findRequest = (id: number) =>
    getRepository(MediaRequest).findOneOrFail({ where: { id } });

  const setUserBookLanguage = async (email: string, language: string) => {
    const user = await getRepository(User).findOneOrFail({
      where: { email },
    });
    user.settings = user.settings ?? new UserSettings({ user });
    user.settings.bookLanguage = language;
    await getRepository(User).save(user);
  };

  it('sets up the language in Chaptarr and tags the author before the search', async () => {
    library = [
      {
        ...lookupResult('Pride and Prejudice', FOREIGN_ID),
        id: 55,
        mediaType: 'ebook',
        monitored: false,
      },
    ];

    const agent = await loginAs('admin@seerr.dev');
    const res = await agent
      .post('/request')
      .send({ mediaType: MediaType.BOOK, mediaId: WORK_ID, language: 'es' });

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.language, 'es');

    await waitFor(async () => (await findBookMedia()).externalServiceId === 55);
    assert.deepStrictEqual(chaptarrEvents, [
      'create tag allseerr-lang-es',
      'create profile 1',
      `tag author ${AUTHOR_CHAPTARR_ID}`,
      'search 55',
    ]);
    assert.deepStrictEqual(chaptarrTags, [
      { id: 1, label: 'allseerr-lang-es' },
    ]);
    assert.ok(releaseProfiles[0].required.length > 0);

    const author = authors[AUTHOR_CHAPTARR_ID];
    assert.deepStrictEqual(author.ebookTags, [50, 1]);
    assert.deepStrictEqual(author.audiobookTags, []);
    assert.deepStrictEqual(author.tags, [50, 1]);
  });

  it('replaces an earlier language on the audiobook tags only', async () => {
    chaptarrTags = [
      { id: 1, label: 'allseerr-lang-en' },
      { id: 2, label: 'kids' },
    ];
    authors[AUTHOR_CHAPTARR_ID].ebookTags = [1];
    authors[AUTHOR_CHAPTARR_ID].audiobookTags = [1, 2];
    library = [
      {
        ...lookupResult('Pride and Prejudice', FOREIGN_ID),
        id: 56,
        mediaType: 'audiobook',
        monitored: false,
      },
    ];

    const agent = await loginAs('admin@seerr.dev');
    await agent.post('/request').send({
      mediaType: MediaType.BOOK,
      mediaId: WORK_ID,
      isAudiobook: true,
      language: 'de',
    });

    await waitFor(
      async () => (await findBookMedia()).externalServiceIdAudio === 56
    );
    const author = authors[AUTHOR_CHAPTARR_ID];
    assert.deepStrictEqual(author.audiobookTags, [2, 3]);
    assert.deepStrictEqual(author.ebookTags, [1]);
  });

  it('adds a new author with the language tag', async () => {
    getSettings().main.bookLanguage = 'fr';

    const agent = await loginAs('admin@seerr.dev');
    await agent
      .post('/request')
      .send({ mediaType: MediaType.BOOK, mediaId: WORK_ID });

    await waitFor(
      async () => (await findBookMedia()).externalServiceId === 100
    );
    assert.deepStrictEqual(addCalls[0].options.tags, [1]);
    assert.deepStrictEqual(chaptarrTags, [
      { id: 1, label: 'allseerr-lang-fr' },
    ]);
  });

  it('takes the language tags off the author for any language', async () => {
    chaptarrTags = [{ id: 1, label: 'allseerr-lang-en' }];
    authors[AUTHOR_CHAPTARR_ID].ebookTags = [50, 1];
    library = [
      {
        ...lookupResult('Pride and Prejudice', FOREIGN_ID),
        id: 57,
        mediaType: 'ebook',
        monitored: false,
      },
    ];

    const agent = await loginAs('admin@seerr.dev');
    await agent
      .post('/request')
      .send({ mediaType: MediaType.BOOK, mediaId: WORK_ID, language: 'any' });

    await waitFor(async () => (await findBookMedia()).externalServiceId === 57);
    assert.deepStrictEqual(releaseProfiles, []);
    assert.deepStrictEqual(authors[AUTHOR_CHAPTARR_ID].ebookTags, [50]);
  });

  it('ignores the language of a user who does not manage requests', async () => {
    getSettings().main.bookLanguage = 'es';

    const agent = await loginAs('demo@seerr.dev');
    const res = await agent
      .post('/request')
      .send({ mediaType: MediaType.BOOK, mediaId: WORK_ID, language: 'fr' });

    assert.strictEqual(res.status, 201);
    assert.strictEqual((await findRequest(res.body.id)).language, 'es');
  });

  it("requests in the user's own language", async () => {
    await setUserBookLanguage('demo@seerr.dev', 'de');

    const agent = await loginAs('demo@seerr.dev');
    const res = await agent
      .post('/request')
      .send({ mediaType: MediaType.BOOK, mediaId: WORK_ID, isAudiobook: true });

    assert.strictEqual((await findRequest(res.body.id)).language, 'de');
  });

  it('exposes the server language in the public settings', () => {
    getSettings().main.bookLanguage = 'de';
    assert.strictEqual(getSettings().fullPublicSettings.bookLanguage, 'de');

    // A language that is no longer supported falls back to English
    (getSettings().main as { bookLanguage: string }).bookLanguage = 'xx';
    assert.strictEqual(getSettings().fullPublicSettings.bookLanguage, 'en');
  });

  it('refuses an unknown language', async () => {
    const agent = await loginAs('admin@seerr.dev');
    const res = await agent
      .post('/request')
      .send({ mediaType: MediaType.BOOK, mediaId: WORK_ID, language: 'xx' });

    assert.strictEqual(res.status, 400);
  });

  it('lets a manager change the language of a pending request', async () => {
    const demo = await loginAs('demo@seerr.dev');
    const created = await demo
      .post('/request')
      .send({ mediaType: MediaType.BOOK, mediaId: WORK_ID });
    assert.strictEqual((await findRequest(created.body.id)).language, 'en');

    // The requester cannot change it
    await demo
      .put(`/request/${created.body.id}`)
      .send({ mediaType: MediaType.BOOK, language: 'it' });
    assert.strictEqual((await findRequest(created.body.id)).language, 'en');

    const admin = await loginAs('admin@seerr.dev');
    const updated = await admin
      .put(`/request/${created.body.id}`)
      .send({ mediaType: MediaType.BOOK, language: 'fr' });

    assert.strictEqual(updated.status, 200);
    assert.strictEqual((await findRequest(created.body.id)).language, 'fr');
  });

  it('requests an author catalog in the chosen language', async () => {
    const [admin, demo] = await Promise.all(
      ['admin@seerr.dev', 'demo@seerr.dev'].map((email) =>
        getRepository(User).findOneOrFail({ where: { email } })
      )
    );

    const byAdmin = await requestAuthorCatalog(admin, {
      authorId: AUTHOR_ID,
      olIds: ['OL1W'],
      format: 'ebook',
      language: 'es',
    });
    const byDemo = await requestAuthorCatalog(demo, {
      authorId: AUTHOR_ID,
      olIds: ['OL2W'],
      format: 'ebook',
      language: 'es',
    });

    assert.strictEqual(
      (await findRequest(byAdmin.created[0].requestId as number)).language,
      'es'
    );
    assert.strictEqual(
      (await findRequest(byDemo.created[0].requestId as number)).language,
      'en'
    );
    await assert.rejects(
      requestAuthorCatalog(admin, {
        authorId: AUTHOR_ID,
        olIds: ['OL3W'],
        format: 'ebook',
        language: 'xx',
      }),
      /Unknown book language/
    );
    // The admin's request is sent, the demo user's waits for approval
    await waitFor(
      async () => (await findBookMedia('OL1W')).externalServiceId === 100
    );
  });
});

describe('book service', () => {
  it('uses Chaptarr when both services are configured', async () => {
    configureServices({ lazyLibrarian: true });
    assert.strictEqual(getSettings().bookService, 'chaptarr');
    assert.strictEqual(getSettings().fullPublicSettings.booksEnabled, true);
    assert.strictEqual(
      getSettings().fullPublicSettings.bookService,
      'chaptarr'
    );
  });

  it('keeps sending books to LazyLibrarian when it is picked', async () => {
    configureServices({ lazyLibrarian: true });
    getSettings().main.bookService = 'lazylibrarian';

    const agent = await loginAs('admin@seerr.dev');
    await agent
      .post('/request')
      .send({ mediaType: MediaType.BOOK, mediaId: WORK_ID });

    await waitFor(() => lazyLibrarianAdds.callCount() > 0);
    assert.strictEqual(addCalls.length, 0);
  });

  it('falls back to LazyLibrarian when Chaptarr is not configured', () => {
    configureServices({ chaptarr: false, lazyLibrarian: true });
    getSettings().main.bookService = 'chaptarr';

    assert.strictEqual(getSettings().bookService, 'lazylibrarian');
  });

  it('turns books off when neither is configured', () => {
    configureServices({ chaptarr: false });

    assert.strictEqual(getSettings().bookService, undefined);
    assert.strictEqual(getSettings().fullPublicSettings.booksEnabled, false);
  });
});
