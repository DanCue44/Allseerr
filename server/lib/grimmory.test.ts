import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it, mock } from 'node:test';

import type { GrimmoryBook } from '@server/api/grimmory';
import GrimmoryAPI, {
  clearGrimmoryTokens,
  mapGrimmoryBook,
  toGrimmoryFormat,
} from '@server/api/grimmory';
import OpenLibrary from '@server/api/openlibrary';
import type { OlSearchDoc } from '@server/api/openlibrary/interfaces';
import { GrimmoryAdminAPI } from '@server/api/userAccess/grimmoryAdmin';
import { MediaStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import cacheManager from '@server/lib/cache';
import {
  clearGrimmoryLookups,
  findGrimmoryBook,
  getGrimmoryLinks,
  grimmoryServes,
} from '@server/lib/grimmoryItem';
import { grimmoryScanner } from '@server/lib/scanners/grimmory';
import { getSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';
import { startFakeGrimmory } from '@server/test/fakeApps';

const ADMIN = { username: 'admin', password: 'admin-password' };

let grimmory: Awaited<ReturnType<typeof startFakeGrimmory>>;

const epubBook = {
  id: 10,
  libraryId: 1,
  title: 'dune.epub',
  primaryFile: { bookType: 'EPUB' },
  alternativeFormats: [],
  metadata: {
    title: 'Dune',
    authors: ['Frank Herbert'],
    isbn13: '9780441013593',
    seriesName: 'Dune',
  },
};
const audiobook = {
  id: 11,
  libraryId: 2,
  title: 'Project Hail Mary',
  primaryFile: { bookType: 'AUDIOBOOK' },
  metadata: {
    title: 'Project Hail Mary',
    authors: ['Andy Weir'],
    asin: 'B08G9PRS1K',
  },
};

const summaries: Record<string, OlSearchDoc> = {
  OL1W: { key: '/works/OL1W', title: 'Dune', author_name: ['Frank Herbert'] },
  OL2W: {
    key: '/works/OL2W',
    title: 'Project Hail Mary',
    author_name: ['Andy Weir'],
  },
  OL3W: {
    key: '/works/OL3W',
    title: 'The Martian',
    author_name: ['Andy Weir'],
  },
};

mock.method(
  OpenLibrary.prototype,
  'getWorkSummary',
  async (olId: string) => summaries[olId]
);

before(async () => {
  grimmory = await startFakeGrimmory(ADMIN);
});

after(async () => {
  await grimmory.close();
});

setupTestDb();

beforeEach(() => {
  clearGrimmoryTokens();
  clearGrimmoryLookups();
  cacheManager.getCache('audiobookshelf').flush();
  grimmory.books.splice(0, grimmory.books.length, epubBook, audiobook);
  grimmory.users.splice(1);
  grimmory.calls.splice(0);
  const settings = getSettings();
  settings.grimmory = {
    url: grimmory.url,
    publicUrl: 'https://books.example.com',
    ...ADMIN,
    ebooks: true,
    audiobooks: false,
    ebookLibraryId: '',
    audiobookLibraryId: '',
  };
});

describe('Grimmory API', () => {
  it('maps file types to formats', () => {
    assert.strictEqual(toGrimmoryFormat('EPUB'), 'ebook');
    assert.strictEqual(toGrimmoryFormat('AUDIOBOOK'), 'audiobook');
    assert.strictEqual(toGrimmoryFormat('CBX'), undefined);
  });

  it('reads the formats of every file of a book', () => {
    assert.deepStrictEqual(
      mapGrimmoryBook({
        ...epubBook,
        alternativeFormats: [{ bookType: 'AUDIOBOOK' }, { bookType: 'PDF' }],
      })?.formats,
      ['ebook', 'audiobook']
    );
  });

  it('signs in once and tests with the bearer token', async () => {
    const api = new GrimmoryAPI({ url: grimmory.url, ...ADMIN });

    const { version, user } = await api.test();
    const libraries = await api.getLibraries();

    assert.strictEqual(version, 'v1.4.0');
    assert.strictEqual(user.username, 'admin');
    assert.deepStrictEqual(
      libraries.map((library) => [library.id, library.name, library.formats]),
      [
        ['1', 'Ebooks', ['EPUB', 'PDF']],
        ['2', 'Audiobooks', ['AUDIOBOOK']],
      ]
    );
    assert.strictEqual(
      grimmory.calls.filter((call) => call.path === '/api/v1/auth/login')
        .length,
      1
    );
  });

  it('signs in again when Grimmory turns a token down', async () => {
    const api = new GrimmoryAPI({ url: grimmory.url, ...ADMIN });
    await api.getLibraries();
    grimmory.tokens.clear();

    assert.strictEqual((await api.getLibraries()).length, 2);
    assert.strictEqual(
      grimmory.calls.filter((call) => call.path === '/api/v1/auth/login')
        .length,
      2
    );
  });

  it('fails with a wrong password', async () => {
    const api = new GrimmoryAPI({
      url: grimmory.url,
      username: 'admin',
      password: 'wrong',
    });

    await assert.rejects(api.getLibraries());
  });

  it('lists the books with their metadata', async () => {
    const books = await new GrimmoryAPI({
      url: grimmory.url,
      ...ADMIN,
    }).getAllBooks();

    assert.deepStrictEqual(books[0], {
      id: '10',
      libraryId: '1',
      title: 'Dune',
      subtitle: undefined,
      authors: ['Frank Herbert'],
      series: ['Dune'],
      isbn: '9780441013593',
      asin: undefined,
      formats: ['ebook'],
    });
    assert.deepStrictEqual(books[1].formats, ['audiobook']);
  });
});

describe('Grimmory user access', () => {
  const client = () =>
    new GrimmoryAdminAPI({ url: grimmory.url, ...ADMIN, timeout: 5000 });

  it('needs an admin', async () => {
    await client().createAccount({
      username: 'reader',
      password: 'reader-password',
      enabled: true,
      libraryIds: null,
      ageLimit: null,
      includeUnrated: false,
    });

    await assert.rejects(
      new GrimmoryAdminAPI({
        url: grimmory.url,
        username: 'reader',
        password: 'reader-password',
      }).test(),
      /admin/
    );
    assert.deepStrictEqual(await client().test(), { version: 'v1.4.0' });
  });

  it('makes, changes and removes an account', async () => {
    const account = await client().createAccount({
      username: 'reader',
      email: 'reader@example.com',
      password: 'first-password',
      enabled: true,
      libraryIds: ['1'],
      ageLimit: null,
      includeUnrated: false,
    });

    assert.strictEqual(account.username, 'reader');
    const created = grimmory.users.find((user) => user.username === 'reader');
    assert.deepStrictEqual(
      created?.assignedLibraries.map((library) => library.id),
      [1]
    );
    assert.strictEqual(created?.permissions.canDownload, true);
    assert.deepStrictEqual(await client().getAccountAccess(account), {
      libraryIds: ['1'],
    });

    // Every library is all of them
    await client().updateAccount(account, {
      enabled: true,
      libraryIds: null,
      ageLimit: null,
      includeUnrated: false,
    });
    assert.deepStrictEqual(await client().getAccountAccess(account), {
      libraryIds: null,
    });

    // Without access the account keeps nothing to open
    await client().updateAccount(account, {
      enabled: false,
      libraryIds: null,
      ageLimit: null,
      includeUnrated: false,
    });
    assert.deepStrictEqual(created?.assignedLibraries, []);

    await client().setPassword(account, 'second-password');
    assert.strictEqual(created?.password, 'second-password');

    assert.deepStrictEqual(
      (await client().listAccounts()).map((a) => [a.username, a.isAdmin]),
      [
        ['admin', true],
        ['reader', false],
      ]
    );
    assert.strictEqual(
      (await client().findAccount({ email: 'reader@example.com' }))?.id,
      account.id
    );

    await client().deleteAccount(account);
    assert.strictEqual(
      grimmory.users.some((user) => user.username === 'reader'),
      false
    );
  });

  it('leaves an admin account alone', async () => {
    const admin = { id: '1', username: 'admin' };
    await client().updateAccount(admin, {
      enabled: false,
      libraryIds: [],
      ageLimit: null,
      includeUnrated: false,
    });

    assert.strictEqual(grimmory.users[0].assignedLibraries.length, 2);
    assert.strictEqual(await client().isAppAdmin(admin), true);
  });
});

describe('Grimmory book links', () => {
  it('finds a book by title and author', () => {
    const match = findGrimmoryBook(
      { olId: 'OL1W', title: 'Dune', authors: ['Frank Herbert'] },
      [mapGrimmoryBook(audiobook), mapGrimmoryBook(epubBook)].filter(
        (book): book is GrimmoryBook => !!book
      )
    );

    assert.strictEqual(match?.id, '10');
  });

  it('links an available format Grimmory serves to the book', async () => {
    const media = new Media({
      olId: 'OL1W',
      mediaType: MediaType.BOOK,
      status: MediaStatus.AVAILABLE,
      statusAudio: MediaStatus.AVAILABLE,
    });

    assert.deepStrictEqual(
      await getGrimmoryLinks(
        getSettings().grimmory,
        { olId: 'OL1W', title: 'Dune', authors: ['Frank Herbert'] },
        media
      ),
      {
        grimmoryEbookUrl: 'https://books.example.com/book/10',
        // Audiobooks stay with Audiobookshelf
        grimmoryAudiobookUrl: null,
      }
    );
  });

  it('links to Grimmory itself when the book is not found', async () => {
    const links = await getGrimmoryLinks(
      getSettings().grimmory,
      { olId: 'OL9W', title: 'Not There', authors: ['Nobody'] },
      new Media({
        olId: 'OL9W',
        mediaType: MediaType.BOOK,
        status: MediaStatus.AVAILABLE,
      })
    );

    assert.strictEqual(links.grimmoryEbookUrl, 'https://books.example.com');
  });

  it('serves only the formats picked', () => {
    const settings = getSettings().grimmory;

    assert.strictEqual(grimmoryServes(settings, 'ebook'), true);
    assert.strictEqual(grimmoryServes(settings, 'audiobook'), false);
    assert.strictEqual(
      grimmoryServes({ ...settings, password: '' }, 'ebook'),
      false
    );
  });
});

describe('Grimmory scan', () => {
  it('marks requested formats Grimmory has available', async () => {
    const settings = getSettings();
    settings.grimmory = { ...settings.grimmory, audiobooks: true };
    const repository = getRepository(Media);
    await repository.save([
      new Media({
        olId: 'OL1W',
        mediaType: MediaType.BOOK,
        status: MediaStatus.PROCESSING,
        statusAudio: MediaStatus.UNKNOWN,
      }),
      new Media({
        olId: 'OL2W',
        mediaType: MediaType.BOOK,
        status: MediaStatus.UNKNOWN,
        statusAudio: MediaStatus.PENDING,
      }),
      // Not in Grimmory
      new Media({
        olId: 'OL3W',
        mediaType: MediaType.BOOK,
        status: MediaStatus.UNKNOWN,
        statusAudio: MediaStatus.PROCESSING,
      }),
    ]);

    const result = await grimmoryScanner.run();
    const byId = new Map(
      (await repository.find({ where: { mediaType: MediaType.BOOK } })).map(
        (media) => [media.olId, media]
      )
    );

    assert.deepStrictEqual(result, { checked: 3, available: 2 });
    assert.strictEqual(byId.get('OL1W')?.status, MediaStatus.AVAILABLE);
    assert.strictEqual(byId.get('OL2W')?.statusAudio, MediaStatus.AVAILABLE);
    assert.strictEqual(byId.get('OL3W')?.statusAudio, MediaStatus.PROCESSING);
  });

  it('leaves formats Grimmory does not serve alone', async () => {
    await getRepository(Media).save(
      new Media({
        olId: 'OL2W',
        mediaType: MediaType.BOOK,
        status: MediaStatus.UNKNOWN,
        statusAudio: MediaStatus.PROCESSING,
      })
    );

    assert.deepStrictEqual(await grimmoryScanner.run(), {
      checked: 0,
      available: 0,
    });
    assert.ok(
      !grimmory.calls.some((call) => call.path === '/api/v1/books'),
      'Grimmory is not asked when nothing waits'
    );
  });
});
