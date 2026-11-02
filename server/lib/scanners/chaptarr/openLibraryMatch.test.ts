import type { OlSearchDoc } from '@server/api/openlibrary/interfaces';
import type {
  MatchDeps,
  MatchMemory,
  UnmatchedBook,
} from '@server/lib/scanners/chaptarr/openLibraryMatch';
import {
  MAX_LOOKUP_ERRORS,
  getIdentifierQuery,
  getMatchQuery,
  getRetryAfter,
  getTitleKey,
  matchBooks,
  planMatches,
  rankIdentifierMatches,
  rankTitleMatches,
} from '@server/lib/scanners/chaptarr/openLibraryMatch';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const doc = (
  key: string,
  title: string,
  authors: string[],
  extra: Partial<OlSearchDoc> = {}
): OlSearchDoc => ({
  key: `/works/${key}`,
  title,
  author_name: authors,
  ...extra,
});

const book = (
  foreignBookId: string,
  title: string,
  author = 'Jane Austen',
  extra: Partial<UnmatchedBook> = {}
): UnmatchedBook => ({
  foreignBookId,
  titles: [title],
  author,
  bookIds: [1],
  ...extra,
});

const NOW = new Date('2026-11-02T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

describe('getMatchQuery', () => {
  it('searches the main title as a phrase and the last name', () => {
    assert.equal(
      getMatchQuery('The Poppy War (The Poppy War, #1)', 'R.F. Kuang'),
      'title:"The Poppy War" author:"kuang"'
    );
    assert.equal(
      getMatchQuery('Men Who Hate Women: The Extremism', 'Laura Bates'),
      'title:"Men Who Hate Women" author:"bates"'
    );
  });

  it('keeps quotes out of the phrase', () => {
    assert.equal(
      getMatchQuery('The "Real" Story', undefined),
      'title:"The Real Story"'
    );
  });
});

describe('getIdentifierQuery', () => {
  it('asks for a few ISBNs and the Goodreads edition', () => {
    assert.equal(
      getIdentifierQuery(['978-0-547-24964-3', '9780547249643', 'bad'], '5470'),
      'isbn:9780547249643 OR id_goodreads:5470'
    );
  });

  it('has nothing to ask without identifiers', () => {
    assert.equal(getIdentifierQuery([], undefined), undefined);
  });
});

describe('rankTitleMatches', () => {
  it('needs the title and the leading author', () => {
    const docs = [
      doc('OL1W', 'Emma', ['Somebody Else']),
      doc('OL2W', '1984', ['Xavier Coste', 'George Orwell']),
      doc('OL3W', 'Emma', ['Jane Austen']),
    ];

    assert.deepEqual(rankTitleMatches('Emma', 'Jane Austen', docs), ['OL3W']);
    assert.deepEqual(rankTitleMatches('1984', 'George Orwell', docs), []);
  });

  it('skips adaptations marked by a bracketed note', () => {
    assert.deepEqual(
      rankTitleMatches('1984', 'George Orwell', [
        doc('OL11326416W', '1984 (adaptation)', ['George Orwell']),
      ]),
      []
    );
  });

  it('prefers the exact title, then the work with most editions', () => {
    assert.deepEqual(
      rankTitleMatches('True Crime Stories', 'Jack Rosewood', [
        doc('OL4W', 'True Crime Stories Volume 4', ['Jack Rosewood'], {
          edition_count: 9,
        }),
        doc('OL5W', 'True Crime Stories', ['Jack Rosewood'], {
          edition_count: 1,
        }),
        doc('OL6W', 'True Crime Stories', ['Jack Rosewood'], {
          edition_count: 3,
        }),
      ]),
      ['OL6W', 'OL5W', 'OL4W']
    );
  });

  it('tells volumes apart by their subtitles', () => {
    assert.deepEqual(
      rankTitleMatches('Stories: Book Two', 'Jane Austen', [
        doc('OL7W', 'Stories', ['Jane Austen'], { subtitle: 'Book One' }),
        doc('OL8W', 'Stories', ['Jane Austen']),
      ]),
      ['OL8W']
    );
  });

  it('matches nothing without an author', () => {
    assert.deepEqual(
      rankTitleMatches('Emma', undefined, [doc('OL3W', 'Emma', ['A'])]),
      []
    );
  });
});

describe('rankIdentifierMatches', () => {
  it('takes the one work the identifiers name', () => {
    assert.deepEqual(
      rankIdentifierMatches('George Orwell', [
        doc('OL1168083W', 'Nineteen Eighty-Four', ['George Orwell']),
      ]),
      ['OL1168083W']
    );
  });

  it('does not trust identifiers that name several works', () => {
    assert.deepEqual(
      rankIdentifierMatches('George Orwell', [
        doc('OL1W', 'Nineteen Eighty-Four', ['George Orwell']),
        doc('OL2W', 'Animal Farm / Nineteen Eighty-Four', ['George Orwell']),
      ]),
      []
    );
  });
});

describe('getRetryAfter', () => {
  it('waits longer after each failed lookup', () => {
    const days = (attempts: number) =>
      (getRetryAfter(attempts, NOW).getTime() - NOW.getTime()) / DAY;

    assert.deepEqual([1, 2, 3, 9].map(days), [7, 30, 90, 90]);
  });
});

describe('planMatches', () => {
  it('splits books into known, due and waiting ones', () => {
    const memory = (
      foreignBookId: string,
      title: string,
      extra: Partial<MatchMemory>
    ): [string, MatchMemory] => [
      foreignBookId,
      { foreignBookId, title, attempts: 0, ...extra },
    ];
    const memories = new Map([
      memory('known', 'Emma', { olId: 'OL3W' }),
      memory('waiting', 'Persuasion', {
        attempts: 1,
        retryAfter: new Date(NOW.getTime() + DAY),
      }),
      memory('old', 'Sanditon', {
        attempts: 1,
        retryAfter: new Date(NOW.getTime() - 2 * DAY),
      }),
      memory('older', 'Lady Susan', {
        attempts: 2,
        retryAfter: new Date(NOW.getTime() - 9 * DAY),
      }),
      memory('renamed', 'Old Title', { olId: 'OL9W' }),
    ]);

    const plan = planMatches(
      [
        book('known', 'Emma'),
        book('waiting', 'Persuasion'),
        book('old', 'Sanditon'),
        book('older', 'Lady Susan'),
        book('renamed', 'New Title'),
        book('new', 'Mansfield Park'),
      ],
      memories,
      NOW
    );

    assert.deepEqual(
      plan.known.map(({ book, olId }) => [book.foreignBookId, olId]),
      [['known', 'OL3W']]
    );
    assert.deepEqual(
      plan.due.map((b) => b.foreignBookId),
      ['renamed', 'new', 'older', 'old']
    );
    assert.equal(plan.waiting, 1);
  });
});

/**
 * Deps backed by an in-memory store, with searches answered from a map
 */
const fakeDeps = (
  answers: Record<string, OlSearchDoc[]>,
  overrides: Partial<MatchDeps> = {}
) => {
  const store = new Map<string, MatchMemory>();
  const applied: [string, string][] = [];
  const searches: string[] = [];
  const unmatched: string[] = [];
  const deps: MatchDeps = {
    memories: async (ids) =>
      new Map(
        ids
          .filter((id) => store.has(id))
          .map((id) => [id, store.get(id) as MatchMemory])
      ),
    remember: async (memory) => {
      store.set(memory.foreignBookId, { ...memory });
    },
    authorName: async () => undefined,
    isbns: async () => [],
    search: async (query) => {
      searches.push(query);
      return answers[query] ?? [];
    },
    existing: async () => undefined,
    apply: async (b, olId) => {
      applied.push([b.foreignBookId, olId]);
    },
    shouldContinue: () => true,
    onUnmatched: (b) => unmatched.push(b.foreignBookId),
    now: () => NOW,
    ...overrides,
  };

  return { deps, store, applied, searches, unmatched };
};

describe('matchBooks', () => {
  const emma = book('gr:1', 'Emma');
  const persuasion = book('gr:2', 'Persuasion');
  const answers = {
    [getMatchQuery('Emma', 'Jane Austen')]: [
      doc('OL3W', 'Emma', ['Jane Austen']),
    ],
  };

  it('matches, remembers and applies books', async () => {
    const { deps, store, applied, unmatched } = fakeDeps(answers);

    const result = await matchBooks([emma, persuasion], deps);

    assert.deepEqual(applied, [['gr:1', 'OL3W']]);
    assert.equal(store.get('gr:1')?.olId, 'OL3W');
    assert.equal(store.get('gr:2')?.attempts, 1);
    assert.deepEqual(unmatched, ['gr:2']);
    assert.equal(result.matched, 1);
    assert.equal(result.notFound, 1);
  });

  it('does not look matched or waiting books up again', async () => {
    const { deps, applied, searches, unmatched } = fakeDeps(answers);
    await matchBooks([emma, persuasion], deps);
    searches.length = 0;
    applied.length = 0;

    const result = await matchBooks([emma, persuasion], deps);

    assert.deepEqual(searches, []);
    assert.deepEqual(applied, [['gr:1', 'OL3W']]);
    assert.equal(result.known, 1);
    assert.equal(result.waiting, 1);
    // A book that was not found is reported once
    assert.deepEqual(unmatched, ['gr:2']);
  });

  it('carries on where a stopped run left off', async () => {
    const books = Array.from({ length: 50 }, (_, i) =>
      book(`gr:${i}`, `Book ${i}`)
    );
    let lookups = 0;
    const { deps, searches } = fakeDeps(
      {},
      { shouldContinue: () => lookups < 20 }
    );
    deps.search = async (query) => {
      lookups++;
      searches.push(query);
      return [];
    };

    const first = await matchBooks(books, deps);
    assert.ok(first.remaining > 0);
    const looked = new Set(searches);

    lookups = 0;
    deps.shouldContinue = () => true;
    searches.length = 0;
    const second = await matchBooks(books, deps);

    assert.equal(second.remaining, 0);
    assert.equal(first.notFound + second.notFound, 50);
    // Books tried in the first run wait for their retry
    assert.ok(searches.every((query) => !looked.has(query)));
  });

  it('stops after OpenLibrary fails several times in a row', async () => {
    const books = Array.from({ length: 30 }, (_, i) =>
      book(`gr:${i}`, `Book ${i}`)
    );
    const { deps, store } = fakeDeps(
      {},
      {
        search: async () => {
          throw new Error('503');
        },
      }
    );

    const result = await matchBooks(books, deps);

    assert.ok(result.errors >= MAX_LOOKUP_ERRORS);
    assert.ok(result.errors < books.length);
    assert.equal(result.remaining, books.length);
    // Failed lookups are not remembered, they are tried again next scan
    assert.equal(store.size, 0);
  });

  it('falls back to the ISBNs of the editions', async () => {
    const orwell = book('hc:1', '1984', 'George Orwell');
    const { deps, applied } = fakeDeps(
      {
        'isbn:9780547249643': [
          doc('OL1168083W', 'Nineteen Eighty-Four', ['George Orwell']),
        ],
      },
      { isbns: async () => ['9780547249643'] }
    );

    await matchBooks([orwell], deps);

    assert.deepEqual(applied, [['hc:1', 'OL1168083W']]);
  });

  it('tries every title of a work and asks Chaptarr for the author', async () => {
    const orwell = book('hc:2', '1984', '', {
      titles: ['1984', 'Nineteen eighty four'],
      author: undefined,
      authorId: 7,
    });
    const { deps, applied } = fakeDeps(
      {
        [getMatchQuery('Nineteen eighty four', 'George Orwell')]: [
          doc('OL1168083W', 'Nineteen Eighty-Four', ['George Orwell']),
        ],
      },
      { authorName: async () => 'George Orwell' }
    );

    await matchBooks([orwell], deps);

    assert.deepEqual(applied, [['hc:2', 'OL1168083W']]);
  });

  it('prefers a work Allseerr already has', async () => {
    const { deps, applied } = fakeDeps(
      {
        [getMatchQuery('Emma', 'Jane Austen')]: [
          doc('OL3W', 'Emma', ['Jane Austen'], { edition_count: 9 }),
          doc('OL4W', 'Emma', ['Jane Austen'], { edition_count: 1 }),
        ],
      },
      { existing: async (olIds) => olIds.find((id) => id === 'OL4W') }
    );

    await matchBooks([emma], deps);

    assert.deepEqual(applied, [['gr:1', 'OL4W']]);
  });

  it('looks a renamed book up again', async () => {
    const { deps, store, searches } = fakeDeps(answers);
    await matchBooks([persuasion], deps);
    assert.equal(store.get('gr:2')?.title, getTitleKey(persuasion));
    searches.length = 0;

    await matchBooks(
      [{ ...persuasion, titles: ['Persuasion (Annotated)'] }],
      deps
    );

    assert.equal(searches.length, 1);
  });
});
