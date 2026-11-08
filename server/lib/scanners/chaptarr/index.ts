import OpenLibrary, { WORK_ID_REGEX } from '@server/api/openlibrary';
import type { OlSearchDoc } from '@server/api/openlibrary/interfaces';
import type {
  ChaptarrBook,
  ChaptarrLibraryPageEvent,
  ChaptarrMediaType,
} from '@server/api/servarr/chaptarr';
import ChaptarrAPI, {
  describeLibraryBooks,
  getBookFileCount,
  isMonitoredFor,
} from '@server/api/servarr/chaptarr';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import ChaptarrBookMatch from '@server/entity/ChaptarrBookMatch';
import Media from '@server/entity/Media';
import MediaRequest from '@server/entity/MediaRequest';
import type { AudiobookshelfBackfillBook } from '@server/lib/audiobookshelfItem';
import { backfillAudiobookshelfItemIds } from '@server/lib/audiobookshelfItem';
import {
  linkChaptarrBook,
  matchChaptarrLibraryBook,
} from '@server/lib/chaptarrRequests';
import { syncComicAvailability } from '@server/lib/comics';
import type {
  RunnableScanner,
  StatusBase,
} from '@server/lib/scanners/baseScanner';
import BaseScanner from '@server/lib/scanners/baseScanner';
import { syncChaptarrAvailability } from '@server/lib/scanners/chaptarr/availability';
import { createDiskLibraryProgress } from '@server/lib/scanners/chaptarr/libraryProgress';
import type {
  MatchMemory,
  MatchProgress,
  UnmatchedBook,
} from '@server/lib/scanners/chaptarr/openLibraryMatch';
import { matchBooks } from '@server/lib/scanners/chaptarr/openLibraryMatch';
import { applyLazyLibrarianState } from '@server/lib/scanners/lazylibrarian';
import type { ChaptarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import {
  checkAbridgedRecordingsAwaitingScan,
  syncRecordingRequests,
} from '@server/lib/talearrRecordings';
import logger from '@server/logger';
import { requestErrorLogFields } from '@server/utils/requestError';
import { uniqWith } from 'lodash';
import { In, IsNull, Not } from 'typeorm';

// The step of a full scan, for the Jobs page
export type ChaptarrScanStep = 'library' | 'openlibrary';

type SyncStatus = StatusBase & {
  currentServer: ChaptarrSettings;
  servers: ChaptarrSettings[];
  step?: ChaptarrScanStep;
  matching?: MatchProgress;
};

export type ChaptarrBookState = 'available' | 'processing' | 'skip';

// Unlinked books matched per scan, and how long a failed match waits
const LINK_BATCH = 10;
const LINK_RETRY_MS = 24 * 60 * 60 * 1000;
const linkAttempts = new Map<number, number>();

const STATUS_KEYS = {
  ebook: 'status',
  audiobook: 'statusAudio',
} as const;

const BOOK_ID_KEYS = {
  ebook: 'externalServiceId',
  audiobook: 'externalServiceIdAudio',
} as const;

/**
 * A format of a book is available once Chaptarr has a file for it.
 * Monitored formats without files are processing, and formats that are
 * neither are left alone.
 */
export const getChaptarrBookState = (
  book: ChaptarrBook,
  mediaType: ChaptarrMediaType
): ChaptarrBookState => {
  if (getBookFileCount(book) > 0) {
    return 'available';
  }

  return isMonitoredFor(book, mediaType) ? 'processing' : 'skip';
};

/**
 * The OpenLibrary work id of a Chaptarr book, when its metadata has one
 */
const isAvailable = (media: Media): boolean =>
  media.status === MediaStatus.AVAILABLE ||
  media.statusAudio === MediaStatus.AVAILABLE;

const getOpenLibraryId = (book: ChaptarrBook): string | undefined => {
  const olId = book.openLibraryWorkId?.replace(/^ol:/i, '');

  return olId && WORK_ID_REGEX.test(olId) ? olId : undefined;
};

// The earliest year a copy of a book came out, for telling a co-written book
// from a later adaptation in the OpenLibrary match
export const getReleaseYear = (copies: ChaptarrBook[]): number | undefined => {
  const years = copies
    .map((copy) => Number(copy.releaseDate?.slice(0, 4)))
    .filter((year) => Number.isInteger(year) && year > 0);

  return years.length ? Math.min(...years) : undefined;
};

/**
 * Applies a Chaptarr book to the formats of a book it holds, dating the
 * book as added to the library the first time a format becomes available.
 * Returns whether the media changed.
 */
export const applyChaptarrBook = (
  media: Media,
  book: ChaptarrBook,
  formats: ChaptarrMediaType[]
): boolean => {
  const wasAvailable = isAvailable(media);
  let changed = false;

  for (const format of formats) {
    changed =
      applyLazyLibrarianState(
        media,
        STATUS_KEYS[format],
        getChaptarrBookState(book, format)
      ) || changed;
  }

  if (!wasAvailable && isAvailable(media)) {
    media.mediaAddedAt = new Date();
  }

  return changed;
};

// Books fetched from Chaptarr at once by the recent scan
const RECENT_FETCH_BATCH = 10;
// Match memories read from the database at once
const MEMORY_CHUNK = 500;
// An OpenLibrary search that takes longer counts as failed
const SEARCH_TIMEOUT_MS = 30_000;
// Retries of a search OpenLibrary throttled or failed, and the first wait
const SEARCH_RETRIES = 3;
const SEARCH_BACKOFF_MS = 5_000;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const isRetryable = (e: unknown): boolean => {
  const status = (e as { response?: { status?: number } })?.response?.status;

  return status === 429 || (status !== undefined && status >= 500);
};

// How long OpenLibrary asked to wait, when it said
const getRetryAfterMs = (e: unknown): number | undefined => {
  const header = (
    e as { response?: { headers?: Record<string, string | undefined> } }
  )?.response?.headers?.['retry-after'];
  const seconds = header ? Number(header) : NaN;

  return Number.isFinite(seconds) ? seconds * 1000 : undefined;
};

class ChaptarrScanner
  extends BaseScanner<ChaptarrBook>
  implements RunnableScanner<SyncStatus>
{
  private servers: ChaptarrSettings[];
  private currentServer: ChaptarrSettings;
  // The recent scan only looks at the books Allseerr is waiting on, so it
  // stays quick on a large library. The full scan reads the whole library.
  private isRecentOnly: boolean;
  // Library books the full scan found no book for and that have no
  // OpenLibrary id, by Chaptarr work id, matched once the library is read
  private unmatched = new Map<string, ChaptarrBook[]>();
  private step?: ChaptarrScanStep;
  private matching?: MatchProgress;

  constructor(isRecentOnly = false) {
    // Most books are idle catalog books that are skipped without a lookup
    super(isRecentOnly ? 'Chaptarr Recent Scan' : 'Chaptarr Full Scan', {
      bundleSize: 500,
      jobId: isRecentOnly ? 'chaptarr-scan' : 'chaptarr-full-scan',
      service: 'chaptarr',
    });
    this.isRecentOnly = isRecentOnly;
  }

  public status(): SyncStatus {
    return {
      running: this.running,
      progress: this.progress,
      total: this.items.length,
      currentServer: this.currentServer,
      servers: this.servers,
      step: this.running ? this.step : undefined,
      matching: this.running ? this.matching : undefined,
    };
  }

  public async run(): Promise<void> {
    const settings = getSettings();
    const sessionId = this.startRun();
    this.step = 'library';
    this.matching = undefined;

    try {
      this.servers = uniqWith(
        settings.chaptarr,
        (a, b) =>
          a.hostname === b.hostname &&
          a.port === b.port &&
          a.baseUrl === b.baseUrl
      );

      for (const server of this.servers) {
        this.currentServer = server;

        if (!server.syncEnabled) {
          this.log(
            `Sync not enabled. Skipping Chaptarr server: ${server.name}`
          );
          continue;
        }

        this.log(
          `Beginning to process Chaptarr server: ${server.name}`,
          'info'
        );

        const chaptarr = new ChaptarrAPI({
          apiKey: server.apiKey,
          url: ChaptarrAPI.buildUrl(server, '/api/v1'),
        });

        const serverIds = settings.chaptarr
          .filter(
            (other) =>
              other.hostname === server.hostname &&
              other.port === server.port &&
              other.baseUrl === server.baseUrl
          )
          .map((other) => other.id);

        this.step = 'library';
        this.unmatched = new Map();
        const readStarted = Date.now();
        this.items = this.isRecentOnly
          ? await this.getAwaitedBooks(chaptarr, serverIds)
          : await chaptarr.getActiveBooks(
              (event) => this.logLibraryPage(event),
              { progress: createDiskLibraryProgress() }
            );

        if (!this.isRecentOnly) {
          this.log(
            `Read ${this.items.length} monitored or downloaded books from ` +
              `${server.name} in ${Math.round((Date.now() - readStarted) / 1000)} s`,
            'info'
          );
        }
        await this.loop((book) => this.processChaptarrBook(server, book), {
          sessionId,
        });

        this.checkSession(sessionId);
        const isCurrent = () => this.running && this.sessionId === sessionId;

        if (!this.isRecentOnly) {
          await this.matchOpenLibrary(chaptarr, server, isCurrent);
          this.checkSession(sessionId);
          this.step = 'library';
        }

        if (!this.isRecentOnly) {
          // Resets formats whose files are gone, for books linked to any
          // entry of this server
          await syncChaptarrAvailability(
            chaptarr,
            serverIds,
            this.items,
            isCurrent
          );
        }

        await this.syncRecordings(chaptarr, serverIds);

        if (!this.isRecentOnly) {
          await this.backfillAudiobookshelfItems(serverIds, isCurrent);
        }

        if (server.isDefault) {
          await this.linkUnlinkedBooks(chaptarr, server);
          await this.syncComics();
        }
      }

      this.log('Chaptarr scan complete', 'info');
      this.scanSucceeded();
    } catch (e) {
      this.scanFailed(e);
    } finally {
      this.endRun(sessionId);
    }
  }

  /**
   * The books of a server that Allseerr is waiting on: requested formats
   * still processing, and the recordings asked for by recording requests.
   * Any other book only changes on the full scan.
   */
  /**
   * One line per page of the library read for a full scan, so a slow
   * Chaptarr shows where the time goes: how long each page took and, for a
   * try that failed, what Chaptarr was busy with
   */
  private logLibraryPage(event: ChaptarrLibraryPageEvent): void {
    const asked = describeLibraryBooks(
      event.firstBook,
      event.pageSize,
      event.totalBooks
    );
    const seconds = Math.round(event.ms / 1000);

    if (event.resumedBooks && event.attempt === 1) {
      this.log(
        `Going on from book ${event.firstBook.toLocaleString('en-US')} of ` +
          `the ${event.books} books, where the last ` +
          `scan stopped (${event.resumedBooks} books already read)`,
        'info'
      );
    }

    if (!event.error) {
      this.log(
        `Read ${event.books} ${describeLibraryBooks(
          event.firstBook,
          event.records ?? 0,
          event.totalBooks
        )} (${event.records} books) in ${seconds} s` +
          (event.attempt > 1
            ? `, try ${event.attempt} of ${event.attempts}`
            : ''),
        'info'
      );
      return;
    }

    const busy = event.busyWith?.length
      ? `Chaptarr was running: ${event.busyWith.join(', ')}`
      : 'Chaptarr was not running any task it reports';
    const next =
      event.retryInMs !== undefined
        ? `trying again in ${Math.round(event.retryInMs / 1000)} s` +
          (event.retryPageSize
            ? ` with ${event.retryPageSize} books at a time`
            : '')
        : 'no tries left';

    this.log(
      `Chaptarr did not send ${event.books} ${asked} ` +
        `(try ${event.attempt} of ${event.attempts}, ${event.error}, ` +
        `after ${seconds} s). ${busy}; ${next}`,
      'warn'
    );
  }

  private async getAwaitedBooks(
    chaptarr: ChaptarrAPI,
    serverIds: number[]
  ): Promise<ChaptarrBook[]> {
    if (!serverIds.length) {
      return [];
    }

    const processing = MediaStatus.PROCESSING;
    const waiting = await getRepository(Media)
      .createQueryBuilder('media')
      .where('media.mediaType = :type', { type: MediaType.BOOK })
      .andWhere('media.serviceId IN (:...serverIds)', { serverIds })
      .andWhere(
        '((media.status = :processing AND media.externalServiceId IS NOT NULL) OR ' +
          '(media.statusAudio = :processing AND ' +
          'media.externalServiceIdAudio IS NOT NULL))',
        { processing }
      )
      .getMany();
    const recordings = await getRepository(MediaRequest).find({
      where: {
        status: MediaRequestStatus.APPROVED,
        recording: Not(IsNull()),
        recordingBookId: Not(IsNull()),
        serverId: In(serverIds),
      },
    });

    const bookIds = new Set<number>();
    for (const media of waiting) {
      if (media.status === processing && media.externalServiceId) {
        bookIds.add(media.externalServiceId);
      }
      if (media.statusAudio === processing && media.externalServiceIdAudio) {
        bookIds.add(media.externalServiceIdAudio);
      }
    }
    for (const request of recordings) {
      bookIds.add(request.recordingBookId as number);
    }

    // A failed lookup fails the scan rather than reading as a deleted book
    const ids = [...bookIds];
    const books: ChaptarrBook[] = [];
    for (let i = 0; i < ids.length; i += RECENT_FETCH_BATCH) {
      const batch = await Promise.all(
        ids
          .slice(i, i + RECENT_FETCH_BATCH)
          .map((bookId) => chaptarr.getBook(bookId))
      );
      books.push(...batch.filter((book): book is ChaptarrBook => !!book));
    }

    return books;
  }

  /**
   * Follows the requested comic and manga series in Talearr's comics
   * library, while book requests go to Talearr
   */
  private async syncComics(): Promise<void> {
    try {
      const changed = await syncComicAvailability();

      if (changed) {
        this.log(`Updated ${changed} comic series`, 'info');
      }
    } catch (e) {
      this.log('Failed to check the requested comics', 'error', {
        ...requestErrorLogFields(e),
      });
    }
  }

  /**
   * The scanned books plus the recordings asked for that the library
   * listing left out (an unmonitored recording without files, say), read
   * by their ids, so a recording is only failed when Talearr no longer has
   * it. A recording that cannot be read stops the check for this scan.
   */
  private async withRecordingBooks(
    chaptarr: ChaptarrAPI,
    serverIds: number[]
  ): Promise<ChaptarrBook[]> {
    if (this.isRecentOnly || !serverIds.length) {
      return this.items;
    }

    const listed = new Set(this.items.map((book) => book.id));
    const requests = await getRepository(MediaRequest).find({
      where: {
        status: MediaRequestStatus.APPROVED,
        recording: Not(IsNull()),
        recordingBookId: Not(IsNull()),
        serverId: In(serverIds),
      },
    });
    const missing = [
      ...new Set(
        requests
          .map((request) => request.recordingBookId as number)
          .filter((bookId) => !listed.has(bookId))
      ),
    ];
    const books = [...this.items];

    for (const bookId of missing) {
      const book = await chaptarr.getBook(bookId);

      if (book) {
        books.push(book);
      }
    }

    return books;
  }

  /**
   * Completes the requests for other recordings of audiobooks whose
   * recordings Talearr has files for now, and asks for the abridged
   * recordings that waited for Talearr to resolve their books
   */
  private async syncRecordings(
    chaptarr: ChaptarrAPI,
    serverIds: number[]
  ): Promise<void> {
    try {
      const books = await this.withRecordingBooks(chaptarr, serverIds);
      const completed = await syncRecordingRequests(serverIds, books);

      if (completed) {
        this.log(`Completed ${completed} recording requests`, 'info');
      }
    } catch (e) {
      this.log('Failed to check the recording requests', 'error', {
        ...requestErrorLogFields(e),
      });
    }

    // The abridged recordings that waited for Talearr to resolve a book
    await checkAbridgedRecordingsAwaitingScan(serverIds);
  }

  /**
   * Remembers the Audiobookshelf items of a few available books each scan,
   * so NoBookEnds can trace an item back to its book. The titles and
   * authors come from Chaptarr, which has the files Audiobookshelf reads.
   */
  private async backfillAudiobookshelfItems(
    serverIds: number[],
    shouldContinue: () => boolean
  ): Promise<void> {
    const audiobookshelf = getSettings().audiobookshelf;

    if (!serverIds.length || !audiobookshelf.url || !audiobookshelf.apiKey) {
      return;
    }

    try {
      const available = MediaStatus.AVAILABLE;
      const missing = await getRepository(Media)
        .createQueryBuilder('media')
        .where('media.mediaType = :type', { type: MediaType.BOOK })
        .andWhere('media.serviceId IN (:...serverIds)', { serverIds })
        .andWhere('media.olId IS NOT NULL')
        .andWhere(
          '((media.status = :available AND media.absEbookItemId IS NULL ' +
            'AND media.externalServiceId IS NOT NULL) OR ' +
            '(media.statusAudio = :available AND ' +
            'media.absAudiobookItemId IS NULL AND ' +
            'media.externalServiceIdAudio IS NOT NULL))',
          { available }
        )
        .take(200)
        .getMany();

      if (!missing.length) {
        return;
      }

      const booksById = new Map(
        this.items
          .filter((book) => book.id)
          .map((book) => [book.id as number, book])
      );
      const books: AudiobookshelfBackfillBook[] = [];

      for (const media of missing) {
        for (const format of ['ebook', 'audiobook'] as const) {
          const book = booksById.get(
            (format === 'ebook'
              ? media.externalServiceId
              : media.externalServiceIdAudio) ?? -1
          );
          const status = format === 'ebook' ? media.status : media.statusAudio;

          if (book && status === available) {
            books.push({
              media,
              format,
              title: book.title,
              authors: book.author?.authorName ? [book.author.authorName] : [],
            });
          }
        }
      }

      const found = await backfillAudiobookshelfItemIds(books, shouldContinue);

      if (found) {
        this.log(`Found ${found} books in Audiobookshelf`, 'info');
      }
    } catch (e) {
      this.log('Failed to look books up in Audiobookshelf', 'debug', {
        ...requestErrorLogFields(e),
      });
    }
  }

  /**
   * Books available from before Chaptarr (downloaded through LazyLibrarian,
   * say) have no Chaptarr ids, and Chaptarr's metadata has no OpenLibrary
   * work id to find them by. A few of them are matched by title and author
   * each scan, so their files can be managed from Allseerr. A book that
   * cannot be matched is tried again a day later.
   */
  private async linkUnlinkedBooks(
    chaptarr: ChaptarrAPI,
    server: ChaptarrSettings
  ): Promise<void> {
    const live = [MediaStatus.AVAILABLE, MediaStatus.PARTIALLY_AVAILABLE];
    const unlinked = await getRepository(Media)
      .createQueryBuilder('media')
      .where('media.mediaType = :type', { type: MediaType.BOOK })
      .andWhere('media.olId IS NOT NULL')
      .andWhere(
        '((media.status IN (:...live) AND media.externalServiceId IS NULL) OR ' +
          '(media.statusAudio IN (:...live) AND media.externalServiceIdAudio IS NULL))',
        { live }
      )
      .orderBy('media.updatedAt', 'ASC')
      .take(200)
      .getMany();

    const now = Date.now();
    const due = unlinked
      .filter(
        (media) => now - (linkAttempts.get(media.id) ?? 0) > LINK_RETRY_MS
      )
      .slice(0, LINK_BATCH);

    for (const media of due) {
      linkAttempts.set(media.id, now);
      const formats = (['ebook', 'audiobook'] as const).filter((format) =>
        format === 'ebook'
          ? live.includes(media.status) && !media.externalServiceId
          : live.includes(media.statusAudio) && !media.externalServiceIdAudio
      );

      for (const format of formats) {
        try {
          const book = await matchChaptarrLibraryBook(
            chaptarr,
            media.olId as string,
            format
          );

          if (book?.id) {
            await linkChaptarrBook(media, server.id, format, book);
            this.log(`Linked ${format} to Chaptarr: ${book.title}`, 'info');
          }
        } catch (e) {
          this.log('Could not match a book in Chaptarr', 'debug', {
            mediaId: media.id,
            format,
            ...requestErrorLogFields(e),
          });
        }
      }
    }
  }

  /**
   * Finds the OpenLibrary works of the library books Chaptarr has no
   * OpenLibrary id for, so books added in Chaptarr directly show in
   * Allseerr. Runs until every book was tried, as fast as OpenLibrary
   * allows; what it finds is kept, so a stopped scan carries on next time.
   */
  private async matchOpenLibrary(
    chaptarr: ChaptarrAPI,
    server: ChaptarrSettings,
    shouldContinue: () => boolean
  ): Promise<void> {
    const copies = this.unmatched;
    this.unmatched = new Map();
    const books: UnmatchedBook[] = [...copies.entries()].map(
      ([foreignBookId, work]) => {
        const edition = work
          .map((copy) => copy.foreignEditionId?.match(/^gr:(\d+)/)?.[1])
          .find(Boolean);

        return {
          foreignBookId,
          titles: [...new Set(work.map((copy) => copy.title))],
          authorId: work.find((copy) => copy.authorId)?.authorId,
          author: work.find((copy) => copy.author?.authorName)?.author
            ?.authorName,
          bookIds: work
            .map((copy) => copy.id)
            .filter((id): id is number => !!id),
          goodreadsId: edition,
          year: getReleaseYear(work),
        };
      }
    );

    if (!books.length) {
      return;
    }

    this.step = 'openlibrary';
    const openLibrary = new OpenLibrary();
    const repository = getRepository(ChaptarrBookMatch);
    const authors = new Map<number, Promise<string | undefined>>();
    const started = Date.now();

    const search = async (query: string): Promise<OlSearchDoc[]> => {
      for (let attempt = 0; ; attempt++) {
        try {
          let timer: NodeJS.Timeout | undefined;
          const response = await Promise.race([
            openLibrary.searchBooks({ query, limit: 10 }),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error('OpenLibrary did not answer in time')),
                SEARCH_TIMEOUT_MS
              );
            }),
          ]).finally(() => clearTimeout(timer));

          return response.docs ?? [];
        } catch (e) {
          if (attempt >= SEARCH_RETRIES || !isRetryable(e?.cause ?? e)) {
            throw e;
          }

          await wait(
            getRetryAfterMs(e?.cause ?? e) ?? SEARCH_BACKOFF_MS * 2 ** attempt
          );
        }
      }
    };

    const result = await matchBooks(books, {
      memories: async (ids) => {
        const found = new Map<string, MatchMemory>();

        for (let i = 0; i < ids.length; i += MEMORY_CHUNK) {
          const rows = await repository.find({
            where: { foreignBookId: In(ids.slice(i, i + MEMORY_CHUNK)) },
          });
          rows.forEach((row) => found.set(row.foreignBookId, row));
        }

        return found;
      },
      remember: async (memory) => {
        await repository.upsert(new ChaptarrBookMatch(memory), [
          'foreignBookId',
        ]);
      },
      authorName: (book) => {
        if (!book.authorId) {
          return Promise.resolve(undefined);
        }

        if (!authors.has(book.authorId)) {
          authors.set(
            book.authorId,
            chaptarr
              .getAuthor(book.authorId)
              .then((author) => author.authorName)
              .catch(() => undefined)
          );
        }

        return authors.get(book.authorId) as Promise<string | undefined>;
      },
      isbns: async (book) => {
        const isbns: string[] = [];

        for (const bookId of book.bookIds) {
          const editions = await chaptarr.getEditions(bookId).catch(() => []);
          // The edition Chaptarr follows first
          editions.sort(
            (a, b) => Number(!!b.monitored) - Number(!!a.monitored)
          );
          isbns.push(
            ...editions
              .map((edition) => edition.isbn13 ?? edition.isbn)
              .filter((isbn): isbn is string => !!isbn)
          );
        }

        return isbns;
      },
      search,
      existing: async (olIds) => {
        const known = await getRepository(Media).find({
          select: { id: true, olId: true },
          where: { olId: In(olIds), mediaType: MediaType.BOOK },
        });

        return olIds.find((olId) => known.some((m) => m.olId === olId));
      },
      apply: async (book, olId) => {
        for (const copy of copies.get(book.foreignBookId) ?? []) {
          await this.processChaptarrBook(server, copy, olId);
        }
      },
      shouldContinue,
      onProgress: (progress) => {
        this.matching = progress;
      },
      onUnmatched: (book) => {
        this.log(
          `Could not match a book to OpenLibrary: ${book.titles[0]}` +
            (book.author ? ` by ${book.author}` : ''),
          'info',
          { foreignBookId: book.foreignBookId }
        );
      },
    });

    const minutes = (Date.now() - started) / 60_000;
    const looked = result.matched + result.notFound;
    this.log(
      `OpenLibrary matching: ${result.matched} matched, ${result.notFound} not found, ` +
        `${result.known} matched before, ${result.remaining} left for the next scan, ` +
        `${result.waiting} waiting to be tried again`,
      'info',
      {
        lookups: looked,
        errors: result.errors,
        minutes: Math.round(minutes * 10) / 10,
        booksPerMinute: minutes > 0 ? Math.round(looked / minutes) : looked,
      }
    );
  }

  private async processChaptarrBook(
    server: ChaptarrSettings,
    book: ChaptarrBook,
    // The work an OpenLibrary lookup found for a book without an id
    matchedOlId?: string
  ): Promise<void> {
    try {
      // Readarr books have no format, they count as ebooks unless an
      // audiobook was requested as that book
      const format: ChaptarrMediaType = book.mediaType ?? 'ebook';
      const bookId = book.id;

      // Books that are neither monitored nor downloaded change nothing.
      // Most of a library is the catalogs of its authors, so these are
      // left out before looking anything up.
      if (!bookId || getChaptarrBookState(book, format) === 'skip') {
        return;
      }

      // Both formats of a work are processed one after the other
      await this.asyncLock.dispatch(book.foreignBookId, async () => {
        const mediaRepository = getRepository(Media);

        // Requested books remember their Chaptarr book ids
        const byBookId = await mediaRepository.findOne({
          where: [
            {
              serviceId: server.id,
              externalServiceId: bookId,
              mediaType: MediaType.BOOK,
            },
            {
              serviceId: server.id,
              externalServiceIdAudio: bookId,
              mediaType: MediaType.BOOK,
            },
          ],
        });

        if (byBookId) {
          const formats = (['ebook', 'audiobook'] as const).filter(
            (key) => byBookId[BOOK_ID_KEYS[key]] === bookId
          );

          if (applyChaptarrBook(byBookId, book, formats)) {
            await this.saveMedia(byBookId, book);
          } else {
            this.log(`Book already exists: ${book.title}`);
          }
          return;
        }

        // A book that was still being imported when it was requested is
        // found by its work id, a book added in Chaptarr by the OpenLibrary
        // work id of its metadata
        const olId = matchedOlId ?? getOpenLibraryId(book);
        const media =
          (await mediaRepository.findOne({
            where: {
              foreignBookId: book.foreignBookId,
              mediaType: MediaType.BOOK,
            },
          })) ??
          (olId
            ? await mediaRepository.findOne({
                where: { olId, mediaType: MediaType.BOOK },
              })
            : null);

        if (!media) {
          if (!olId) {
            // Looked up on OpenLibrary by title and author once the whole
            // library is read
            if (!this.isRecentOnly) {
              this.unmatched.set(book.foreignBookId, [
                ...(this.unmatched.get(book.foreignBookId) ?? []),
                book,
              ]);
            }
            return;
          }

          const newMedia = new Media({
            olId,
            mediaType: MediaType.BOOK,
            status: MediaStatus.UNKNOWN,
            statusAudio: MediaStatus.UNKNOWN,
            serviceId: server.id,
            foreignBookId: book.foreignBookId,
            [BOOK_ID_KEYS[format]]: bookId,
          });
          applyChaptarrBook(newMedia, book, [format]);
          await this.saveMedia(newMedia, book);
          this.log(`Saved new book: ${book.title}`);
          return;
        }

        if (
          media.serviceId === server.id &&
          media[BOOK_ID_KEYS[format]] &&
          media[BOOK_ID_KEYS[format]] !== bookId
        ) {
          // Another copy of a book that is linked already
          return;
        }

        let changed = false;

        // Links the book to the media, unless the media is kept on another
        // Chaptarr server or already has a book of this format there
        if (
          (media.serviceId === null ||
            media.serviceId === undefined ||
            media.serviceId === server.id) &&
          !media[BOOK_ID_KEYS[format]]
        ) {
          media.serviceId = server.id;
          media[BOOK_ID_KEYS[format]] = bookId;
          media.foreignBookId ??= book.foreignBookId;
          changed = true;
        }

        changed = applyChaptarrBook(media, book, [format]) || changed;

        if (changed) {
          await this.saveMedia(media, book);
        } else {
          this.log(`Book already exists: ${book.title}`);
        }
      });
    } catch (e) {
      this.log('Failed to process Chaptarr book', 'error', {
        ...requestErrorLogFields(e),
        title: book.title,
      });
    }
  }

  private async saveMedia(media: Media, book: ChaptarrBook): Promise<void> {
    await getRepository(Media).save(media);
    this.log(`Media for ${book.title} exists. Changes were detected.`, 'info');
  }
}

export const chaptarrScanner = new ChaptarrScanner();
export const chaptarrRecentScanner = new ChaptarrScanner(true);

/**
 * Starts a full scan now unless one is running, such as when a server is
 * added or its sync turned on, so its library shows without waiting for
 * the nightly scan
 */
export const startChaptarrFullScan = (reason: string): boolean => {
  if (chaptarrScanner.status().running) {
    return false;
  }

  logger.info(`Starting Chaptarr Full Scan: ${reason}`, { label: 'Jobs' });
  chaptarrScanner.run().catch(() => undefined);

  return true;
};
