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
  TalearrAbridgedPolicy,
  TalearrAddRecordingBody,
  TalearrBookGrabPolicy,
  TalearrRecordings,
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
import notificationManager from '@server/lib/notifications';
import { Permission } from '@server/lib/permissions';
import type { ChaptarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { resetReportedUnsupported } from '@server/lib/talearrAudiobookVersions';
import {
  checkAbridgedRecordingsAwaitingScan,
  requestAbridgedRecording,
  resetAbridgedRecordingsAwaitingScan,
  setFactsPendingDelays,
  syncRecordingRequests,
} from '@server/lib/talearrRecordings';
import { checkUser } from '@server/middleware/auth';
import authRoutes from '@server/routes/auth';
import requestRoutes from '@server/routes/request';
import { settleTestBackgroundTasks, setupTestDb } from '@server/test/db';
import type { Express } from 'express';
import express from 'express';
import session from 'express-session';
import request from 'supertest';
import { IsNull } from 'typeorm';

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
  settings.main.bookService = 'talearr';
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
  getSettings().main.bookService = undefined;
  getSettings().main.audiobookVersions = undefined;
});

// Talearr's per book grab policy and recordings route, and what they were
// asked
let policySupported = true;
let bookPolicies: Record<number, TalearrAbridgedPolicy | null> = {};
let policyCalls: [number, TalearrAbridgedPolicy | null][] = [];
let recordingAdds: TalearrAddRecordingBody[] = [];
let recordingsView: TalearrRecordings | undefined;
// Answers given before recordingsView, one per look, such as while Talearr
// is still resolving the book
let recordingsViews: (TalearrRecordings | undefined)[] = [];
let recordingsLooks = 0;

mock.method(
  ChaptarrAPI.prototype,
  'getTalearrBookGrabPolicy',
  async (bookId: number): Promise<TalearrBookGrabPolicy> => {
    chaptarrEvents.push(`get policy ${bookId}`);
    return policySupported
      ? { supported: true, abridgedPolicy: bookPolicies[bookId] ?? null }
      : { supported: false };
  }
);
mock.method(
  ChaptarrAPI.prototype,
  'setTalearrBookGrabPolicy',
  async (bookId: number, policy: TalearrAbridgedPolicy | null) => {
    chaptarrEvents.push(`set policy ${bookId} ${policy}`);
    policyCalls.push([bookId, policy]);
    bookPolicies[bookId] = policy;
    return policySupported;
  }
);
mock.method(ChaptarrAPI.prototype, 'getTalearrRecordings', async () => {
  recordingsLooks++;
  return recordingsViews.length ? recordingsViews.shift() : recordingsView;
});
mock.method(
  ChaptarrAPI.prototype,
  'addTalearrRecording',
  async (body: TalearrAddRecordingBody) => {
    recordingAdds.push(body);
    chaptarrEvents.push(`add recording ${body.kind}`);
    return {
      status: 'created' as const,
      searchQueued: true,
      recording: {
        bookId: 900,
        role: 'additional' as const,
        editionId: 77,
        narrators: ['D.W. Moffett'],
        abridged: 'abridged' as const,
        monitored: true,
        hasFiles: false,
      },
    };
  }
);

// Talearr knows an abridged edition of the book
const withAbridgedEdition = (): TalearrRecordings => ({
  recordings: [],
  candidates: [
    { editionId: 77, narrators: ['D.W. Moffett'], abridged: 'abridged' },
  ],
});

const audiobookBody = {
  mediaType: MediaType.BOOK,
  mediaId: WORK_ID,
  isAudiobook: true,
};

const findRecordingRequests = () =>
  getRepository(MediaRequest).find({
    where: { recording: 'abridged' },
    relations: { requestedBy: true },
  });

const sentAudiobook = async () =>
  waitFor(async () => (await findBookMedia()).externalServiceIdAudio === 100);

beforeEach(() => {
  policySupported = true;
  bookPolicies = {};
  policyCalls = [];
  recordingAdds = [];
  recordingsView = withAbridgedEdition();
  recordingsViews = [];
  recordingsLooks = 0;
  resetReportedUnsupported();
  resetAbridgedRecordingsAwaitingScan();
  // No real waits between the looks at a book Talearr is still resolving
  setFactsPendingDelays([0, 0, 0]);
});

// Talearr 0.15.0 and later, while it has not resolved the book's editions
const factsPending = (): TalearrRecordings => ({
  recordings: [],
  candidates: [],
  factsPending: true,
});

describe('audiobook versions with Talearr', () => {
  it('defaults to both: adds the unabridged reading and asks for the abridged one', async () => {
    // Settings saved before the setting existed have no value
    getSettings().main.audiobookVersions = undefined;
    const agent = await loginAs('admin@seerr.dev');

    const res = await agent.post('/request').send(audiobookBody);
    assert.strictEqual(res.status, 201, res.body.message);
    await sentAudiobook();
    await waitFor(() => recordingAdds.length === 1);

    // The book follows the global policy, unabridged by default
    assert.deepStrictEqual(policyCalls, []);
    assert.deepStrictEqual(searchCalls, [[100]]);

    const [linked] = await findRecordingRequests();
    assert.ok(linked, 'the abridged recording request was made');
    assert.strictEqual(linked.status, MediaRequestStatus.APPROVED);
    assert.strictEqual(linked.isAudiobook, true);
    assert.strictEqual(linked.ignoreQuota, true);
    assert.strictEqual(linked.requestedBy.email, 'admin@seerr.dev');
    assert.deepStrictEqual(recordingAdds, [
      {
        bookId: 100,
        kind: 'abridged',
        search: true,
        requestedBy: 'allseerr',
        externalRef: String(linked.id),
      },
    ]);
    await waitFor(
      async () =>
        (await getRepository(MediaRequest).findOneByOrFail({ id: linked.id }))
          .recordingBookId === 900
    );

    // The audiobook request itself stays as it was
    const parent = await getRepository(MediaRequest).findOneByOrFail({
      id: res.body.id,
    });
    assert.strictEqual(parent.recording, null);
    assert.strictEqual(parent.status, MediaRequestStatus.APPROVED);

    // The scan completes the abridged recording on its own
    assert.strictEqual(
      await syncRecordingRequests(
        [0],
        [
          {
            id: 900,
            title: 'Pride and Prejudice',
            foreignBookId: FOREIGN_ID,
            monitored: true,
            mediaType: 'audiobook',
            statistics: { bookFileCount: 1 },
          },
        ]
      ),
      1
    );
  });

  it('clears an abridged only override for both', async () => {
    getSettings().main.audiobookVersions = 'both';
    bookPolicies[100] = 'abridgedOnly';
    const agent = await loginAs('admin@seerr.dev');

    await agent.post('/request').send(audiobookBody);
    await sentAudiobook();
    await waitFor(() => recordingAdds.length === 1);

    assert.deepStrictEqual(policyCalls, [[100, null]]);
  });

  it('asks for nothing more when Talearr knows no abridged edition', async () => {
    getSettings().main.audiobookVersions = 'both';
    recordingsView = { recordings: [], candidates: [] };
    const agent = await loginAs('admin@seerr.dev');

    await agent.post('/request').send(audiobookBody);
    await sentAudiobook();
    await settleTestBackgroundTasks();

    assert.deepStrictEqual(recordingAdds, []);
    assert.deepStrictEqual(await findRecordingRequests(), []);
  });

  it('unabridged leaves the global policy and asks for no other recording', async () => {
    getSettings().main.audiobookVersions = 'unabridged';
    const agent = await loginAs('admin@seerr.dev');

    await agent.post('/request').send(audiobookBody);
    await sentAudiobook();
    await settleTestBackgroundTasks();

    assert.deepStrictEqual(policyCalls, []);
    assert.deepStrictEqual(recordingAdds, []);
    assert.deepStrictEqual(searchCalls, [[100]]);
  });

  it('abridged sets the abridged only policy before the search', async () => {
    getSettings().main.audiobookVersions = 'abridged';
    const agent = await loginAs('admin@seerr.dev');

    await agent.post('/request').send(audiobookBody);
    await sentAudiobook();
    await settleTestBackgroundTasks();

    assert.deepStrictEqual(policyCalls, [[100, 'abridgedOnly']]);
    const policyAt = chaptarrEvents.indexOf('set policy 100 abridgedOnly');
    const searchAt = chaptarrEvents.indexOf('search 100');
    assert.ok(policyAt >= 0 && policyAt < searchAt, chaptarrEvents.join(' | '));
    assert.deepStrictEqual(recordingAdds, []);
  });

  it('abridged falls back to the recordings route without a per book policy', async () => {
    getSettings().main.audiobookVersions = 'abridged';
    policySupported = false;
    const agent = await loginAs('admin@seerr.dev');

    await agent.post('/request').send(audiobookBody);
    await sentAudiobook();
    await waitFor(() => recordingAdds.length === 1);

    assert.deepStrictEqual(policyCalls, []);
    assert.strictEqual(recordingAdds[0].kind, 'abridged');
    assert.strictEqual((await findRecordingRequests()).length, 1);
  });

  it('requester: keeps the pick and acts on it', async () => {
    getSettings().main.audiobookVersions = 'requester';
    const agent = await loginAs('admin@seerr.dev');

    const res = await agent
      .post('/request')
      .send({ ...audiobookBody, audiobookVersion: 'abridged' });
    assert.strictEqual(res.status, 201, res.body.message);
    assert.strictEqual(res.body.audiobookVersion, 'abridged');
    await sentAudiobook();
    await settleTestBackgroundTasks();

    assert.deepStrictEqual(policyCalls, [[100, 'abridgedOnly']]);
    assert.deepStrictEqual(recordingAdds, []);
  });

  it('requester: unabridged when picked, both when nothing is picked', async () => {
    getSettings().main.audiobookVersions = 'requester';
    const agent = await loginAs('admin@seerr.dev');

    const unabridged = await agent
      .post('/request')
      .send({ ...audiobookBody, audiobookVersion: 'unabridged' });
    assert.strictEqual(unabridged.body.audiobookVersion, 'unabridged');
    await sentAudiobook();
    await settleTestBackgroundTasks();
    assert.deepStrictEqual(recordingAdds, []);

    // A second book, requested by an older client without a pick
    await getRepository(MediaRequest).delete({ id: unabridged.body.id });
    await getRepository(Media).update(
      { olId: WORK_ID },
      { externalServiceIdAudio: null, statusAudio: MediaStatus.UNKNOWN }
    );
    library = [];
    const unpicked = await agent.post('/request').send(audiobookBody);
    assert.strictEqual(unpicked.status, 201, unpicked.body.message);
    assert.strictEqual(unpicked.body.audiobookVersion, null);
    await sentAudiobook();
    await waitFor(() => recordingAdds.length === 1);
  });

  it('ignores the pick unless the requester may choose', async () => {
    getSettings().main.audiobookVersions = 'unabridged';
    const agent = await loginAs('admin@seerr.dev');

    const res = await agent
      .post('/request')
      .send({ ...audiobookBody, audiobookVersion: 'both' });
    assert.strictEqual(res.status, 201, res.body.message);
    assert.strictEqual(res.body.audiobookVersion, null);
    await sentAudiobook();
    await settleTestBackgroundTasks();
    assert.deepStrictEqual(recordingAdds, []);
  });

  it('refuses an unknown version', async () => {
    getSettings().main.audiobookVersions = 'requester';
    const agent = await loginAs('admin@seerr.dev');

    const res = await agent
      .post('/request')
      .send({ ...audiobookBody, audiobookVersion: 'dramatized' });
    assert.strictEqual(res.status, 400);
  });

  it('leaves ebooks and other book services alone', async () => {
    const agent = await loginAs('admin@seerr.dev');

    await agent
      .post('/request')
      .send({ mediaType: MediaType.BOOK, mediaId: WORK_ID });
    await waitFor(
      async () => (await findBookMedia()).externalServiceId === 100
    );
    await settleTestBackgroundTasks();
    assert.deepStrictEqual(policyCalls, []);
    assert.deepStrictEqual(recordingAdds, []);
    assert.ok(!chaptarrEvents.some((event) => event.startsWith('get policy')));

    getSettings().main.bookService = 'chaptarr';
    await agent.post('/request').send(audiobookBody);
    await waitFor(
      async () => (await findBookMedia()).externalServiceIdAudio === 101
    );
    await settleTestBackgroundTasks();
    assert.deepStrictEqual(recordingAdds, []);
    assert.ok(!chaptarrEvents.some((event) => event.startsWith('get policy')));
  });

  it('keeps the linked recording to requesters who may only request', async () => {
    getSettings().main.audiobookVersions = 'both';
    const repository = getRepository(User);
    const user = await repository.findOneOrFail({
      where: { email: 'demo@seerr.dev' },
    });
    user.permissions = Permission.REQUEST;
    await repository.save(user);
    const requester = await loginAs('demo@seerr.dev');

    const res = await requester.post('/request').send(audiobookBody);
    assert.strictEqual(res.body.status, MediaRequestStatus.PENDING);
    await settleTestBackgroundTasks();
    // Nothing goes to Talearr before approval
    assert.deepStrictEqual(recordingAdds, []);

    const admin = await loginAs('admin@seerr.dev');
    await admin.post(`/request/${res.body.id}/approve`);
    await sentAudiobook();
    await waitFor(() => recordingAdds.length === 1);

    const [linked] = await findRecordingRequests();
    assert.strictEqual(linked.requestedBy.email, 'demo@seerr.dev');
    assert.strictEqual(linked.status, MediaRequestStatus.APPROVED);
  });

  it('looks again while Talearr resolves the book, then asks for the abridged recording', async () => {
    getSettings().main.audiobookVersions = 'both';
    recordingsViews = [factsPending(), factsPending()];
    const agent = await loginAs('admin@seerr.dev');

    const res = await agent.post('/request').send(audiobookBody);
    // The request is answered without waiting for Talearr's facts
    assert.strictEqual(res.status, 201, res.body.message);
    await sentAudiobook();
    await waitFor(() => recordingAdds.length === 1);

    // The first look and the two retries that followed
    assert.strictEqual(recordingsLooks, 3);
    assert.strictEqual(recordingAdds[0].kind, 'abridged');
    assert.strictEqual((await findRecordingRequests()).length, 1);

    // Nothing waits for the next scan, so it asks for nothing more
    await checkAbridgedRecordingsAwaitingScan([0]);
    await settleTestBackgroundTasks();
    assert.strictEqual(recordingsLooks, 3);
    assert.strictEqual(recordingAdds.length, 1);
  });

  it('waits for the next scan when Talearr is still resolving the book, and looks only once more', async () => {
    getSettings().main.audiobookVersions = 'both';
    recordingsView = factsPending();
    const agent = await loginAs('admin@seerr.dev');

    const res = await agent.post('/request').send(audiobookBody);
    assert.strictEqual(res.status, 201, res.body.message);
    await sentAudiobook();
    await settleTestBackgroundTasks();

    // The first look and three retries, without asking for anything
    assert.strictEqual(recordingsLooks, 4);
    assert.deepStrictEqual(recordingAdds, []);
    assert.deepStrictEqual(await findRecordingRequests(), []);

    // A scan of another server leaves it waiting
    await checkAbridgedRecordingsAwaitingScan([5]);
    assert.strictEqual(recordingsLooks, 4);

    // Still pending on the scan, it is dropped
    await checkAbridgedRecordingsAwaitingScan([0]);
    await settleTestBackgroundTasks();
    assert.strictEqual(recordingsLooks, 5);
    assert.deepStrictEqual(recordingAdds, []);

    await checkAbridgedRecordingsAwaitingScan([0]);
    assert.strictEqual(recordingsLooks, 5);
    assert.deepStrictEqual(await findRecordingRequests(), []);
  });

  it('asks for the abridged recording on the scan once Talearr has resolved the book', async () => {
    getSettings().main.audiobookVersions = 'both';
    recordingsViews = [
      factsPending(),
      factsPending(),
      factsPending(),
      factsPending(),
    ];
    const agent = await loginAs('admin@seerr.dev');

    await agent.post('/request').send(audiobookBody);
    await sentAudiobook();
    await settleTestBackgroundTasks();
    assert.deepStrictEqual(recordingAdds, []);

    await checkAbridgedRecordingsAwaitingScan([0]);
    await waitFor(() => recordingAdds.length === 1);
    assert.strictEqual(recordingsLooks, 5);
    assert.strictEqual((await findRecordingRequests()).length, 1);
  });

  it('asks for nothing once Talearr resolves the book without an abridged edition', async () => {
    getSettings().main.audiobookVersions = 'both';
    recordingsViews = [factsPending()];
    recordingsView = { recordings: [], candidates: [] };
    const agent = await loginAs('admin@seerr.dev');

    await agent.post('/request').send(audiobookBody);
    await sentAudiobook();
    await settleTestBackgroundTasks();

    assert.strictEqual(recordingsLooks, 2);
    assert.deepStrictEqual(recordingAdds, []);
    assert.deepStrictEqual(await findRecordingRequests(), []);
  });

  it('does not ask twice when an abridged recording was requested meanwhile', async () => {
    getSettings().main.audiobookVersions = 'both';
    recordingsViews = [factsPending()];
    const agent = await loginAs('admin@seerr.dev');

    await agent.post('/request').send(audiobookBody);
    await sentAudiobook();
    await waitFor(() => recordingAdds.length === 1);

    // A later look, such as from a scan, finds the open request
    const [parent] = await getRepository(MediaRequest).find({
      where: { recording: IsNull() },
    });
    await requestAbridgedRecording(parent, {
      server: getSettings().chaptarr[0],
      bookId: 100,
    });
    await settleTestBackgroundTasks();
    assert.strictEqual(recordingAdds.length, 1);
    assert.strictEqual((await findRecordingRequests()).length, 1);
  });

  it('looks only once when Talearr does not tell whether facts are pending', async () => {
    getSettings().main.audiobookVersions = 'both';
    // An older Talearr: no factsPending field at all
    recordingsView = withAbridgedEdition();
    assert.ok(!('factsPending' in recordingsView));
    const agent = await loginAs('admin@seerr.dev');

    await agent.post('/request').send(audiobookBody);
    await sentAudiobook();
    await waitFor(() => recordingAdds.length === 1);

    assert.strictEqual(recordingsLooks, 1);
    await checkAbridgedRecordingsAwaitingScan([0]);
    assert.strictEqual(recordingsLooks, 1);
  });
});
