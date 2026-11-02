import {
  getAuthorLastNames,
  isAuthorMatch,
  isEditionMatch,
  normalizeTitle,
} from '@server/api/audible/match';
import { WORK_ID_REGEX, getOlId } from '@server/api/openlibrary';
import type { OlSearchDoc } from '@server/api/openlibrary/interfaces';

// Lookups in flight at once. The OpenLibrary client keeps to its rate
// limit on top of this, this only keeps a slow answer from idling it.
export const MATCH_CONCURRENCY = 3;
// Failed lookups in a row before the matching stops for this scan, so an
// OpenLibrary outage is not hammered. The next scan carries on.
export const MAX_LOOKUP_ERRORS = 5;
// ISBNs of a book's editions tried at once when the title finds nothing
const MAX_ISBNS = 5;
// A book that could not be matched is tried again later, less often each
// time, in case OpenLibrary or the book's metadata changed
const RETRY_DAYS = [7, 30, 90];
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A Chaptarr work with no OpenLibrary id: the ebook and the audiobook of a
 * book share the work id and can carry different titles
 */
export interface UnmatchedBook {
  foreignBookId: string;
  titles: string[];
  authorId?: number;
  author?: string;
  // Chaptarr book ids, for reading the editions' ISBNs
  bookIds: number[];
  // A Goodreads edition id, when the book's metadata comes from Goodreads
  goodreadsId?: string;
}

/**
 * What an earlier scan found out about a book: the work it matched, or
 * when to look again
 */
export interface MatchMemory {
  foreignBookId: string;
  title: string;
  author?: string | null;
  olId?: string | null;
  attempts: number;
  retryAfter?: Date | null;
}

/**
 * When a book that could not be matched is looked up again, after the
 * given number of failed lookups
 */
export const getRetryAfter = (attempts: number, now: Date): Date => {
  const days =
    RETRY_DAYS[Math.min(Math.max(attempts, 1), RETRY_DAYS.length) - 1];

  return new Date(now.getTime() + days * DAY_MS);
};

/**
 * The titles of a book as one string, to notice a renamed book
 */
export const getTitleKey = (book: Pick<UnmatchedBook, 'titles'>): string =>
  [...new Set(book.titles)].sort().join(' / ');

const cleanPhrase = (value: string): string =>
  value.replace(/["\\]/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * The search for a book: the title without its subtitle or series note as
 * a phrase, and the author's last name. A plain text search misses books
 * whose author is written with initials ("R.F. Kuang").
 */
export const getMatchQuery = (title: string, author?: string): string => {
  const main =
    cleanPhrase(title.split(':')[0].replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')) ||
    cleanPhrase(title);
  const lastName = [...getAuthorLastNames(author ? [author] : [])][0];

  return [`title:"${main}"`, lastName ? `author:"${lastName}"` : '']
    .filter(Boolean)
    .join(' ');
};

/**
 * The search for a book by its editions' ISBNs and its Goodreads id, for
 * books whose title OpenLibrary knows differently
 */
export const getIdentifierQuery = (
  isbns: string[],
  goodreadsId?: string
): string | undefined => {
  const terms = [
    ...[...new Set(isbns.map((isbn) => isbn.replace(/[^0-9X]/gi, '')))]
      .filter((isbn) => isbn.length === 10 || isbn.length === 13)
      .slice(0, MAX_ISBNS)
      .map((isbn) => `isbn:${isbn}`),
    ...(goodreadsId && /^\d+$/.test(goodreadsId)
      ? [`id_goodreads:${goodreadsId}`]
      : []),
  ];

  return terms.length ? terms.join(' OR ') : undefined;
};

// A note in brackets, such as "(adaptation)" or "(Graphic Novel)"
const BRACKET_NOTE = /\([^)]*\)|\[[^\]]*\]/;

// The part of a title after the colon, comparable
const getSubtitle = (title: string, subtitle?: string): string => {
  const rest = subtitle ?? title.split(':').slice(1).join(':');

  return rest ? normalizeTitle(rest) : '';
};

const isWork = (doc: OlSearchDoc): boolean =>
  WORK_ID_REGEX.test(getOlId(doc.key));

/**
 * The OpenLibrary works a title search found for a book, best first. The
 * title and the leading author have to match; the exact title comes first,
 * then the work with the most editions (OpenLibrary keeps stray duplicates
 * of popular books). When both have a subtitle it has to match too, and a
 * bracketed note such as "(adaptation)" marks another version. Returns
 * nothing rather than a guess.
 */
export const rankTitleMatches = (
  title: string,
  author: string | undefined,
  docs: OlSearchDoc[]
): string[] => {
  if (!author) {
    return [];
  }

  const normalized = normalizeTitle(title);
  const subtitle = getSubtitle(title);
  const matches = docs.filter(
    (doc) =>
      isWork(doc) &&
      (BRACKET_NOTE.test(title) || !BRACKET_NOTE.test(doc.title)) &&
      // The book's author has to lead, so a graphic novel adapted from it
      // by someone else does not count
      isEditionMatch(title, [author], {
        title: doc.title,
        subtitle: doc.subtitle,
        authors: (doc.author_name ?? []).slice(0, 1),
      }) &&
      // Volumes of a series often share a title and differ in the subtitle
      !(
        subtitle &&
        getSubtitle(doc.title, doc.subtitle) &&
        getSubtitle(doc.title, doc.subtitle) !== subtitle
      )
  );

  return matches
    .sort((a, b) => {
      const exact =
        Number(normalizeTitle(b.title) === normalized) -
        Number(normalizeTitle(a.title) === normalized);

      return exact || (b.edition_count ?? 0) - (a.edition_count ?? 0);
    })
    .map((doc) => getOlId(doc.key));
};

/**
 * The works an identifier search found for a book. An ISBN names one
 * edition, so the title may be a translation; the author still has to
 * match, and a search that lands on several works is not trusted.
 */
export const rankIdentifierMatches = (
  author: string | undefined,
  docs: OlSearchDoc[]
): string[] => {
  if (!author) {
    return [];
  }

  const works = [
    ...new Set(
      docs
        .filter(
          (doc) =>
            isWork(doc) &&
            isAuthorMatch([author], (doc.author_name ?? []).slice(0, 1))
        )
        .map((doc) => getOlId(doc.key))
    ),
  ];

  return works.length === 1 ? works : [];
};

export interface MatchPlan {
  // Books matched before, applied without a lookup
  known: { book: UnmatchedBook; olId: string }[];
  // Books to look up now, never tried first, then the longest waiting
  due: UnmatchedBook[];
  // Books that could not be matched and wait for their retry
  waiting: number;
}

/**
 * Splits the unmatched books of a scan into the ones matched before, the
 * ones to look up now and the ones that wait. A renamed book is looked up
 * again.
 */
export const planMatches = (
  books: UnmatchedBook[],
  memories: Map<string, MatchMemory>,
  now: Date
): MatchPlan => {
  const known: MatchPlan['known'] = [];
  const fresh: UnmatchedBook[] = [];
  const retries: { book: UnmatchedBook; since: number }[] = [];
  let waiting = 0;

  for (const book of books) {
    const memory = memories.get(book.foreignBookId);

    if (!memory || memory.title !== getTitleKey(book)) {
      fresh.push(book);
    } else if (memory.olId) {
      known.push({ book, olId: memory.olId });
    } else if (!memory.retryAfter || memory.retryAfter <= now) {
      retries.push({ book, since: memory.retryAfter?.getTime() ?? 0 });
    } else {
      waiting++;
    }
  }

  return {
    known,
    due: [
      ...fresh,
      ...retries.sort((a, b) => a.since - b.since).map(({ book }) => book),
    ],
    waiting,
  };
};

export interface MatchProgress {
  done: number;
  total: number;
}

export interface MatchDeps {
  memories: (foreignBookIds: string[]) => Promise<Map<string, MatchMemory>>;
  remember: (memory: MatchMemory) => Promise<void>;
  authorName: (book: UnmatchedBook) => Promise<string | undefined>;
  isbns: (book: UnmatchedBook) => Promise<string[]>;
  search: (query: string) => Promise<OlSearchDoc[]>;
  // Of the given works, the first Allseerr already has a book for
  existing: (olIds: string[]) => Promise<string | undefined>;
  apply: (book: UnmatchedBook, olId: string) => Promise<void>;
  shouldContinue: () => boolean;
  onProgress?: (progress: MatchProgress) => void;
  onUnmatched?: (book: UnmatchedBook) => void;
  now?: () => Date;
}

export interface MatchResult {
  known: number;
  matched: number;
  notFound: number;
  errors: number;
  // Due books not looked up, because the scan stopped or OpenLibrary failed
  remaining: number;
  waiting: number;
}

/**
 * Finds the OpenLibrary works of library books Chaptarr has no OpenLibrary
 * id for: by title and author first, which takes one search, then by the
 * ISBNs of the book's editions. Every answer is remembered as it comes, so
 * a stopped or restarted scan carries on where it left off, and books that
 * found nothing wait before they are tried again.
 */
export const matchBooks = async (
  books: UnmatchedBook[],
  deps: MatchDeps
): Promise<MatchResult> => {
  const now = deps.now?.() ?? new Date();
  const memories = await deps.memories(books.map((b) => b.foreignBookId));
  const plan = planMatches(books, memories, now);
  const result: MatchResult = {
    known: 0,
    matched: 0,
    notFound: 0,
    errors: 0,
    remaining: 0,
    waiting: plan.waiting,
  };

  for (const { book, olId } of plan.known) {
    if (!deps.shouldContinue()) {
      break;
    }
    await deps.apply(book, olId);
    result.known++;
  }

  let done = 0;
  let errorsInRow = 0;
  const total = plan.due.length;
  deps.onProgress?.({ done, total });

  const lookUp = async (book: UnmatchedBook): Promise<void> => {
    const author = book.author ?? (await deps.authorName(book));
    const found = { ...book, author };
    let olIds: string[] = [];

    for (const title of found.titles) {
      olIds = rankTitleMatches(
        title,
        author,
        await deps.search(getMatchQuery(title, author))
      );

      if (olIds.length) {
        break;
      }
    }

    if (!olIds.length && author) {
      const query = getIdentifierQuery(
        await deps.isbns(found),
        found.goodreadsId
      );

      if (query) {
        olIds = rankIdentifierMatches(author, await deps.search(query));
      }
    }

    const memory = memories.get(book.foreignBookId);
    const title = getTitleKey(book);

    if (olIds.length) {
      const olId = (await deps.existing(olIds)) ?? olIds[0];
      await deps.remember({
        foreignBookId: book.foreignBookId,
        title,
        author,
        olId,
        attempts: 0,
        retryAfter: null,
      });
      await deps.apply(found, olId);
      result.matched++;
      return;
    }

    const attempts =
      (memory && memory.title === title ? memory.attempts : 0) + 1;
    await deps.remember({
      foreignBookId: book.foreignBookId,
      title,
      author,
      olId: null,
      attempts,
      retryAfter: getRetryAfter(attempts, now),
    });
    result.notFound++;

    // Said once per book, not every time it is tried again
    if (attempts === 1) {
      deps.onUnmatched?.(found);
    }
  };

  const queue = [...plan.due];
  const worker = async (): Promise<void> => {
    while (
      queue.length &&
      deps.shouldContinue() &&
      errorsInRow < MAX_LOOKUP_ERRORS
    ) {
      const book = queue.shift() as UnmatchedBook;

      try {
        await lookUp(book);
        errorsInRow = 0;
      } catch {
        // Not remembered, so the book is looked up again next scan
        result.errors++;
        errorsInRow++;
      }

      done++;
      deps.onProgress?.({ done, total });
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(MATCH_CONCURRENCY, queue.length) }, worker)
  );

  result.remaining = queue.length + result.errors;

  return result;
};
