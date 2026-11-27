import assert from 'node:assert/strict';
import { beforeEach, describe, it, mock } from 'node:test';

import Audible from '@server/api/audible';
import type { AudibleProduct } from '@server/api/audible/interfaces';
import OpenLibrary from '@server/api/openlibrary';
import type { OlSearchResponse } from '@server/api/openlibrary/interfaces';
import { MediaStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import MetadataBookAudio from '@server/entity/MetadataBookAudio';
import cacheManager from '@server/lib/cache';
import { setupTestDb } from '@server/test/db';
import {
  findNarratorNames,
  getNarratorDetails,
  groupNarratorBooks,
  isNarratorNameMatch,
  narratorBooksFrom,
  searchNarrators,
} from './narrators';

const product = (
  asin: string,
  title: string,
  author: string,
  extra: Partial<AudibleProduct> = {}
): AudibleProduct => ({
  asin,
  title,
  authors: [{ name: author }],
  narrators: [{ name: 'Kate Reading' }],
  ...extra,
});

const catalog: AudibleProduct[] = [
  product('A3', 'The Shadow Rising', 'Robert Jordan', {
    series: [{ title: 'The Wheel of Time', sequence: '4' }],
    release_date: '2004-07-01',
  }),
  product('A1', 'The Eye of the World', 'Robert Jordan', {
    series: [{ title: 'The Wheel of Time', sequence: '1' }],
    release_date: '2004-01-01',
  }),
  product('A2', 'The Great Hunt', 'Robert Jordan', {
    series: [{ title: 'The Wheel of Time', sequence: '2' }],
    release_date: '2004-03-01',
  }),
  product('B1', 'Warbreaker', 'Brandon Sanderson', {
    release_date: '2009-06-09',
  }),
  product('B2', 'The Way of Kings', 'Brandon Sanderson', {
    series: [{ title: 'The Stormlight Archive', sequence: '1' }],
    release_date: '2010-08-31',
  }),
  // A re-release of a book already listed
  product('A1X', 'The Eye of the World (Unabridged)', 'Robert Jordan', {
    series: [{ title: 'The Wheel of Time', sequence: '1' }],
    release_date: '2016-01-01',
  }),
  // Read by someone else, the catalog matches names loosely
  product('C1', 'Other Book', 'Someone', {
    narrators: [{ name: 'Kate Mulgrew' }],
  }),
];

let narratorCalls: { name: string; page: number }[] = [];
let olQueries: string[] = [];

mock.method(
  Audible.prototype,
  'searchNarrator',
  async (name: string, page = 0) => {
    narratorCalls.push({ name, page });
    return page === 0
      ? { products: catalog, total: catalog.length }
      : { products: [], total: catalog.length };
  }
);
mock.method(
  OpenLibrary.prototype,
  'searchBooks',
  async ({ query }: { query: string }): Promise<OlSearchResponse> => {
    olQueries.push(query);
    if (query.startsWith('The Eye of the World')) {
      return {
        numFound: 1,
        start: 0,
        docs: [
          {
            key: '/works/OL1W',
            title: 'The Eye of the World',
            author_name: ['Robert Jordan'],
          },
        ],
      } as OlSearchResponse;
    }
    return { numFound: 0, start: 0, docs: [] } as OlSearchResponse;
  }
);

setupTestDb();

beforeEach(() => {
  narratorCalls = [];
  olQueries = [];
  cacheManager.getCache('audible').flush();
});

describe('isNarratorNameMatch', () => {
  it('matches the same name in any spelling', () => {
    assert.ok(isNarratorNameMatch('kate reading', 'Kate Reading'));
    assert.ok(isNarratorNameMatch('RC Bray', 'R.C. Bray'));
    assert.ok(
      isNarratorNameMatch('Kate Reading', 'Kate Reading - introduction')
    );
  });

  it('does not match other names', () => {
    assert.ok(!isNarratorNameMatch('Kate Reading', 'Kate Mulgrew'));
    assert.ok(!isNarratorNameMatch('Kate', 'Kate Mulgrew'));
    assert.ok(!isNarratorNameMatch('', 'Kate Mulgrew'));
  });
});

describe('findNarratorNames', () => {
  it('puts the exact name first and leaves other narrators out', () => {
    assert.deepStrictEqual(findNarratorNames('kate reading', catalog), [
      { name: 'Kate Reading', count: 6, exact: true },
    ]);
  });
});

describe('groupNarratorBooks', () => {
  it('groups by author, then series in series order, then other books', () => {
    const groups = groupNarratorBooks(
      narratorBooksFrom('Kate Reading', catalog)
    );

    assert.deepStrictEqual(
      groups.map((author) => ({
        name: author.name,
        series: author.series.map((series) => ({
          name: series.name,
          books: series.books.map((book) => book.title),
        })),
        standalone: author.standalone.map((book) => book.title),
      })),
      [
        {
          name: 'Robert Jordan',
          series: [
            {
              name: 'The Wheel of Time',
              // The re-release is folded into the first listing
              books: [
                'The Eye of the World',
                'The Great Hunt',
                'The Shadow Rising',
              ],
            },
          ],
          standalone: [],
        },
        {
          name: 'Brandon Sanderson',
          series: [
            { name: 'The Stormlight Archive', books: ['The Way of Kings'] },
          ],
          standalone: ['Warbreaker'],
        },
      ]
    );
  });
});

describe('getNarratorDetails', () => {
  it('matches books to works and adds their request status', async () => {
    await getRepository(Media).save(
      new Media({
        olId: 'OL1W',
        mediaType: MediaType.BOOK,
        status: MediaStatus.UNKNOWN,
        statusAudio: MediaStatus.AVAILABLE,
      })
    );
    // A book matched to its audiobook edition before needs no search
    await getRepository(MetadataBookAudio).save(
      new MetadataBookAudio({
        olId: 'OL2W',
        region: 'us',
        hasAudiobook: true,
        asin: 'A2',
        narrators: ['Kate Reading'],
        checkedAt: new Date(),
      })
    );

    const details = await getNarratorDetails('kate reading', {
      budget: 5000,
    });

    assert.ok(details);
    assert.strictEqual(details.name, 'Kate Reading');
    assert.strictEqual(details.totalBooks, 5);
    assert.strictEqual(details.pending, 0);
    assert.strictEqual(details.truncated, false);

    const wheel = details.authors[0].series[0].books;
    assert.strictEqual(wheel[0].olId, 'OL1W');
    assert.strictEqual(wheel[0].mediaInfo?.statusAudio, MediaStatus.AVAILABLE);
    assert.strictEqual(wheel[1].olId, 'OL2W');
    assert.strictEqual(wheel[2].olId, null);
    assert.ok(!olQueries.some((query) => query.startsWith('The Great Hunt')));
    assert.deepStrictEqual(narratorCalls, [{ name: 'kate reading', page: 0 }]);
  });

  it('answers null when no narrator has the name', async () => {
    assert.strictEqual(await getNarratorDetails('Nobody Atall'), null);
  });
});

describe('searchNarrators', () => {
  it('offers the narrator for a name search', async () => {
    const results = await searchNarrators('Kate Reading');

    assert.deepStrictEqual(results, [
      {
        id: 'Kate Reading',
        mediaType: 'narrator',
        name: 'Kate Reading',
        bookCount: 6,
        topWork: 'The Shadow Rising',
        profilePath: null,
      },
    ]);
  });

  it('skips single word queries without asking Audible', async () => {
    assert.deepStrictEqual(await searchNarrators('Dune'), []);
    assert.deepStrictEqual(narratorCalls, []);
  });
});
