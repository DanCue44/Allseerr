import type {
  BookRecordingAbridged,
  BookRecordingKind,
} from '@server/constants/bookRecording';
import logger from '@server/logger';
import type {
  RootFolder,
  ServarrHistoryRecord,
  ServarrRelease,
  ServarrStatusMessage,
  Tag,
} from './base';
import ServarrBase, { getArrErrorMessage } from './base';

export type ChaptarrMediaType = 'ebook' | 'audiobook';

// Chaptarr root folders hold ebooks, audiobooks or both
export enum ChaptarrFolderType {
  MIXED = 0,
  AUDIOBOOK = 1,
  EBOOK = 2,
}

export interface ChaptarrFormatDefaults {
  qualityProfileId?: number;
  metadataProfileId?: number;
  tags?: number[];
}

export interface ChaptarrRootFolder extends RootFolder {
  name?: string;
  folderType?: ChaptarrFolderType;
  ebook?: ChaptarrFormatDefaults;
  audiobook?: ChaptarrFormatDefaults;
}

export interface ChaptarrQualityProfile {
  id: number;
  name: string;
  // ebook or audiobook, missing on Readarr
  profileType?: string;
}

export interface ChaptarrMetadataProfile {
  id: number;
  name: string;
  // 0 general, 1 audiobook, 2 ebook, missing on Readarr
  profileType?: number;
}

export interface ChaptarrAuthor {
  [key: string]: unknown;
  id?: number;
  authorName: string;
  foreignAuthorId: string;
  monitored?: boolean;
  // Chaptarr tags an author per format, release profiles follow the tags
  // of the format a release is for. Tags combines both, as Readarr has it.
  tags?: number[];
  ebookTags?: number[] | null;
  audiobookTags?: number[] | null;
}

/**
 * A release profile rejects releases missing every required term or having
 * any ignored term. It applies to the authors carrying one of its tags, or
 * to every author when it has none. Chaptarr release profiles have no name.
 */
export interface ChaptarrReleaseProfile {
  [key: string]: unknown;
  id?: number;
  enabled: boolean;
  required: string[];
  ignored: string[];
  indexerId: number;
  tags: number[];
}

export interface ChaptarrEdition {
  [key: string]: unknown;
  foreignEditionId?: string;
  title?: string;
  isbn13?: string;
  isbn?: string;
  // An ISO 639 code or a language name, missing when the metadata has none
  language?: string;
  monitored?: boolean;
}

export interface ChaptarrLocalBook {
  id: number;
  title?: string;
  mediaType?: ChaptarrMediaType;
  monitored?: boolean;
  hasFiles?: boolean;
}

export interface ChaptarrBookStatistics {
  bookFileCount?: number;
  sizeOnDisk?: number;
}

export interface ChaptarrBook {
  [key: string]: unknown;
  id?: number;
  title: string;
  titleSlug?: string;
  foreignBookId: string;
  foreignEditionId?: string;
  openLibraryWorkId?: string | null;
  // Chaptarr keeps the ebook and the audiobook of a book as two books
  mediaType?: ChaptarrMediaType;
  monitored: boolean;
  ebookMonitored?: boolean;
  audiobookMonitored?: boolean;
  anyEditionOk?: boolean;
  authorId?: number;
  author?: ChaptarrAuthor;
  editions?: ChaptarrEdition[];
  statistics?: ChaptarrBookStatistics;
  hasFiles?: boolean;
  added?: string;
  ratings?: { votes?: number; value?: number };
  addOptions?: { searchForNewBook?: boolean; [key: string]: unknown };
  localEbookBooks?: ChaptarrLocalBook[];
  localAudiobookBooks?: ChaptarrLocalBook[];
}

export interface ChaptarrBookFile {
  id: number;
  bookId: number;
  path?: string;
  size?: number;
}

/**
 * Chaptarr answers a release search with the releases its filters let
 * through and the ones they hid. Readarr answers with a plain list.
 */
export interface ChaptarrReleaseSearch {
  releases?: ServarrRelease[];
  hiddenReleases?: ServarrRelease[];
  filterSummary?: { summaryText?: string };
}

export interface ChaptarrPendingImport {
  id: number;
  authorName?: string;
  overallStatus?: string;
  ebookStatus?: string;
  audiobookStatus?: string;
  attemptCount?: number;
  nextAttemptAt?: string;
  lastError?: string;
}

/**
 * A download in Chaptarr's queue. Each Chaptarr book is one format, so the
 * book id tells an ebook download from an audiobook one; the book carries
 * its format too when the queue is read with its books.
 */
export interface ChaptarrQueueItem {
  id: number;
  bookId?: number;
  authorId?: number;
  book?: Pick<ChaptarrBook, 'id' | 'title' | 'mediaType' | 'author'>;
  size: number;
  sizeleft: number;
  timeleft?: string;
  estimatedCompletionTime?: string;
  status: string;
  title: string;
  downloadId?: string;
  trackedDownloadStatus?: string;
  trackedDownloadState?: string;
  // Why a download is stuck, such as an import that found no book files
  statusMessages?: ServarrStatusMessage[];
  errorMessage?: string;
}

// How long a retried import is waited for before the page is told it is
// still running
const RETRY_IMPORT_POLLS = 10;
const RETRY_IMPORT_POLL_MS = 1500;

interface QueuePage {
  records?: ChaptarrQueueItem[];
}

export interface ChaptarrCapabilities {
  appName: string;
  version: string;
  // Chaptarr itself, with per format books, root folders and profiles and
  // pending author imports. Other Readarr compatible servers have none of it.
  isChaptarr: boolean;
}

export type TalearrAbridgedPolicy =
  | 'unabridgedOnly'
  | 'preferUnabridged'
  | 'any'
  | 'abridgedOnly';

/**
 * Talearr's grab policy override for one book. Unsupported when the server
 * has no such route, as stock Chaptarr and older Talearr do not.
 */
export type TalearrBookGrabPolicy =
  | { supported: false }
  | {
      supported: true;
      // The override, null when the book follows the global policy, and
      // undefined when Talearr does not know the book
      abridgedPolicy?: TalearrAbridgedPolicy | null;
    };

/**
 * Talearr's grab policy, from Settings > Indexers > Grab policy
 */
export interface TalearrGrabPolicy {
  abridgedPolicy: TalearrAbridgedPolicy;
  allowBundles: boolean;
  failRejectedImports: boolean;
  maxAutomaticRetries: number;
}

/**
 * Whether a server is Talearr, the Chaptarr fork, and what it reports.
 * Talearr keeps Chaptarr's app name, so it is told apart by its product
 * name, its own version, its instance name and its grab policy route.
 */
export interface TalearrIdentity {
  isTalearr: boolean;
  // Talearr's own version, apart from the Chaptarr version it is based on
  version?: string;
  instanceName?: string;
  grabPolicy?: TalearrGrabPolicy;
  // A problem with the metadata server that Talearr's health check found
  metadataProblem?: string;
}

/**
 * One edition of an audiobook as Talearr's recordings route describes it
 */
export interface TalearrRecordingEdition {
  editionId: number;
  foreignEditionId?: string | null;
  title?: string | null;
  narrators: string[];
  abridged: BookRecordingAbridged;
  abridgedSource?: string | null;
  runtimeMinutes?: number | null;
  publisher?: string | null;
  releaseDate?: string | null;
  language?: string | null;
  asin?: string | null;
  audibleUrl?: string | null;
}

/**
 * A recording Talearr keeps of an audiobook: the primary one is the book
 * itself, every additional one is its own Chaptarr book entry
 */
export interface TalearrRecording extends TalearrRecordingEdition {
  bookId: number;
  role: 'primary' | 'additional';
  monitored: boolean;
  hasFiles: boolean;
}

/**
 * An audiobook edition that is not a recording yet
 */
export interface TalearrRecordingCandidate extends TalearrRecordingEdition {
  editionIds?: number[];
}

export interface TalearrRecordings {
  baseBookId?: string | null;
  marketplace?: string | null;
  recordings: TalearrRecording[];
  candidates: TalearrRecordingCandidate[];
  // Talearr 0.15.0 and later: the book's editions or Audible facts are not
  // resolved yet, so the candidates may still change. Older servers leave
  // it out.
  factsPending?: boolean;
}

export interface TalearrAddRecordingBody {
  bookId: number;
  kind: BookRecordingKind;
  narrator?: string;
  editionId?: number;
  search?: boolean;
  requestedBy: string;
  externalRef?: string;
}

/**
 * Talearr's answer to a new recording: created or pinned (201) and existing
 * (200) carry the recording, no match (404) and ambiguous (409) the
 * candidates, invalid (400) only a message
 */
export type TalearrAddRecordingResult =
  | {
      status: 'created' | 'pinned' | 'existing';
      searchQueued: boolean;
      recording?: TalearrRecording;
    }
  | {
      status: 'nomatch' | 'ambiguous' | 'invalid';
      message?: string;
      candidates: TalearrRecordingCandidate[];
    };

export interface ChaptarrAddBookOptions {
  mediaType: ChaptarrMediaType;
  qualityProfileId: number;
  metadataProfileId: number;
  rootFolderPath: string;
  tags: number[];
  searchForNewBook: boolean;
}

export type ChaptarrAddBookResult =
  | { status: 'added'; book: ChaptarrBook }
  | { status: 'pending'; pendingId: number; message?: string }
  // Chaptarr was still adding the book when the request timed out
  | { status: 'timeout' };

export type ChaptarrPendingResult = 'succeeded' | 'failed' | 'timeout';

interface PagedBooks {
  records?: ChaptarrBook[];
  totalCount?: number;
}

// Adding a book can import its author and its whole catalog first, which
// takes minutes for prolific authors
const ADD_TIMEOUT_MS = 120_000;
// Changes to books and authors, and listing an author's books, touch the
// whole author in Chaptarr, which can take longer than the usual timeout
const UPDATE_TIMEOUT_MS = 60_000;
const REMOVE_AUTHOR_TIMEOUT_MS = 300_000;
// Lookups ask Chaptarr's metadata server, which slows down a lot while
// Chaptarr is busy refreshing an author
const LOOKUP_TIMEOUT_MS = 30_000;
// Telling Talearr apart is a few small reads, a missing one is not an error
const IDENTITY_TIMEOUT_MS = 10_000;
// Talearr's recordings route reads its own cache of Audible facts
const RECORDINGS_TIMEOUT_MS = 15_000;
// Talearr's seeding route asks the download client and the tracker
const SEEDING_TIMEOUT_MS = 15_000;
// The health check Talearr reports metadata server problems with
const TALEARR_METADATA_CHECK = 'TalearrMetadataServerProbeCheck';

// In Talearr's enum order, for serializers that send numbers
const ABRIDGED_POLICIES: TalearrAbridgedPolicy[] = [
  'unabridgedOnly',
  'preferUnabridged',
  'any',
  'abridgedOnly',
];

const parseAbridgedPolicy = (
  value: unknown
): TalearrAbridgedPolicy | undefined =>
  typeof value === 'number'
    ? ABRIDGED_POLICIES[value]
    : ABRIDGED_POLICIES.find(
        (policy) => policy.toLowerCase() === String(value).toLowerCase()
      );

/**
 * Whether a 404 came from a route Talearr has, about a book it does not
 * know, which answers with a message. A route the server does not have
 * answers 404 without one.
 */
const isKnownRouteNotFound = (data: unknown): boolean =>
  !!data && typeof data === 'object' && !Array.isArray(data);

/**
 * Reads Talearr's answer to the per book grab policy route
 */
export const parseTalearrBookGrabPolicy = (
  status: number,
  data: unknown
): TalearrBookGrabPolicy => {
  if (status === 404) {
    return isKnownRouteNotFound(data)
      ? { supported: true }
      : { supported: false };
  }

  if (status < 200 || status >= 300 || !data || typeof data !== 'object') {
    return { supported: false };
  }

  const raw = (data as Record<string, unknown>).abridgedPolicy;

  return {
    supported: true,
    abridgedPolicy:
      raw === null || raw === undefined
        ? null
        : (parseAbridgedPolicy(raw) ?? null),
  };
};

const mentionsTalearr = (value: unknown): boolean =>
  typeof value === 'string' && value.toLowerCase().includes('talearr');

/**
 * Reads a grab policy as Talearr sends it, or undefined when the answer is
 * not one, such as a stock Chaptarr page for an unknown route
 */
export const parseTalearrGrabPolicy = (
  data: unknown
): TalearrGrabPolicy | undefined => {
  if (!data || typeof data !== 'object') {
    return undefined;
  }

  const raw = data as Record<string, unknown>;

  if (
    typeof raw.allowBundles !== 'boolean' ||
    typeof raw.maxAutomaticRetries !== 'number'
  ) {
    return undefined;
  }

  // Enums come as camelCase names, or as numbers on some serializers
  const abridgedPolicy = parseAbridgedPolicy(raw.abridgedPolicy);

  return {
    abridgedPolicy: abridgedPolicy ?? 'unabridgedOnly',
    allowBundles: raw.allowBundles,
    failRejectedImports: raw.failRejectedImports !== false,
    maxAutomaticRetries: raw.maxAutomaticRetries,
  };
};

const ABRIDGED_VALUES: BookRecordingAbridged[] = [
  'abridged',
  'unabridged',
  'unknown',
];

const asText = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

const asNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const parseRecordingEdition = (
  raw: Record<string, unknown>
): TalearrRecordingEdition => ({
  editionId: asNumber(raw.editionId) ?? 0,
  foreignEditionId: asText(raw.foreignEditionId),
  title: asText(raw.title),
  narrators: Array.isArray(raw.narrators)
    ? raw.narrators.filter(
        (narrator): narrator is string =>
          typeof narrator === 'string' && !!narrator.trim()
      )
    : [],
  abridged:
    ABRIDGED_VALUES.find(
      (value) => value === String(raw.abridged ?? '').toLowerCase()
    ) ?? 'unknown',
  abridgedSource: asText(raw.abridgedSource),
  runtimeMinutes: asNumber(raw.runtimeMinutes),
  publisher: asText(raw.publisher),
  releaseDate: asText(raw.releaseDate),
  language: asText(raw.language),
  asin: asText(raw.asin),
  audibleUrl: asText(raw.audibleUrl),
});

const asRecords = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          !!item && typeof item === 'object'
      )
    : [];

export const parseTalearrRecording = (
  raw: Record<string, unknown>
): TalearrRecording => ({
  ...parseRecordingEdition(raw),
  bookId: asNumber(raw.bookId) ?? 0,
  role: raw.role === 'primary' ? 'primary' : 'additional',
  monitored: raw.monitored === true,
  hasFiles: raw.hasFiles === true,
});

const parseTalearrCandidate = (
  raw: Record<string, unknown>
): TalearrRecordingCandidate => ({
  ...parseRecordingEdition(raw),
  editionIds: Array.isArray(raw.editionIds)
    ? raw.editionIds.filter((id): id is number => typeof id === 'number')
    : undefined,
});

/**
 * Reads Talearr's recordings of a book, or undefined when the answer is not
 * one, such as the page stock Chaptarr sends for a route it does not have
 */
export const parseTalearrRecordings = (
  data: unknown
): TalearrRecordings | undefined => {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return undefined;
  }

  const raw = data as Record<string, unknown>;

  if (!Array.isArray(raw.recordings)) {
    return undefined;
  }

  return {
    baseBookId: asText(raw.baseBookId),
    marketplace: asText(raw.marketplace),
    recordings: asRecords(raw.recordings).map(parseTalearrRecording),
    candidates: asRecords(raw.candidates).map(parseTalearrCandidate),
    ...(raw.factsPending === true ? { factsPending: true } : {}),
  };
};

/**
 * Reads Talearr's answer to a new recording by its status code
 */
export const parseTalearrAddRecording = (
  status: number,
  data: unknown
): TalearrAddRecordingResult => {
  const raw =
    data && typeof data === 'object' && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : {};

  if (status === 200 || status === 201) {
    const action = String(raw.action ?? '').toLowerCase();
    const recording =
      raw.recording && typeof raw.recording === 'object'
        ? parseTalearrRecording(raw.recording as Record<string, unknown>)
        : undefined;

    return {
      status:
        action === 'pinned'
          ? 'pinned'
          : status === 201
            ? 'created'
            : 'existing',
      searchQueued: raw.searchQueued === true,
      recording,
    };
  }

  return {
    status:
      status === 404 ? 'nomatch' : status === 409 ? 'ambiguous' : 'invalid',
    message: asText(raw.message) ?? undefined,
    candidates: asRecords(raw.candidates).map(parseTalearrCandidate),
  };
};

/**
 * Waits used when Chaptarr is briefly unable to answer. Exported so tests
 * can shorten them.
 */
export const chaptarrRetryDelays = {
  // Before a lookup that timed out is tried again
  lookupMs: 2_000,
  // Before adding again a book Chaptarr refused while it was still setting
  // up the author from an earlier request
  authorBusyMs: 30_000,
  // Before each new try of a page of the library that failed
  libraryPageMs: [2_000, 10_000, 30_000],
};

const isTimeout = (e: { code?: string }): boolean =>
  e?.code === 'ECONNABORTED' || e?.code === 'ETIMEDOUT';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Chaptarr finishes setting up a new author in the background after it
 * accepts a book. A second request for that author arriving meanwhile is
 * refused with a root folder validation error, which goes away once the
 * author is ready.
 */
export const isDuplicateBooksError = (e: {
  cause?: { response?: { status?: number; data?: unknown } };
}): boolean =>
  e?.cause?.response?.status === 500 &&
  /resolves to multiple local/i.test(
    JSON.stringify(e.cause.response.data ?? '')
  );

export const isAuthorBusyError = (e: {
  response?: { status?: number; data?: unknown };
}): boolean =>
  e?.response?.status === 400 &&
  /root folder/i.test(JSON.stringify(e.response.data ?? ''));
const LIBRARY_PAGE_SIZE = 500;
// Downloads read from the queue at once, more than a queue holds
const QUEUE_PAGE_SIZE = 200;
// A library larger than this is not read further
const MAX_LIBRARY_BOOKS = 100_000;
// A page of a large library can take Chaptarr a while to build, and it is
// slower still while Chaptarr refreshes books at the same time. A page that
// fails is asked for again (chaptarrRetryDelays) before the read gives up.
const LIBRARY_PAGE_TIMEOUT_MS = 60_000;

// Says which page of the library could not be read, as it is
class ChaptarrLibraryError extends Error {}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Whether a book is monitored for a format. Chaptarr books are one format
 * each; Readarr books only have the monitored flag.
 */
export const isMonitoredFor = (
  book: ChaptarrBook,
  mediaType: ChaptarrMediaType
): boolean =>
  (mediaType === 'ebook' ? book.ebookMonitored : book.audiobookMonitored) ??
  book.monitored;

export const getBookFileCount = (book: ChaptarrBook): number =>
  book.statistics?.bookFileCount ?? (book.hasFiles ? 1 : 0);

/**
 * The editions without repeats of the same metadata edition, keeping the
 * first of each. The kept one is monitored when any of its repeats is.
 */
export const uniqueEditions = (
  editions: ChaptarrEdition[]
): ChaptarrEdition[] => {
  const byKey = new Map<string, ChaptarrEdition>();
  const unique: ChaptarrEdition[] = [];

  editions.forEach((edition, index) => {
    const key =
      edition.foreignEditionId ??
      (edition.id !== undefined ? `id:${edition.id}` : `index:${index}`);
    const kept = byKey.get(key);

    if (!kept) {
      const copy = { ...edition };
      byKey.set(key, copy);
      unique.push(copy);
    } else if (edition.monitored) {
      kept.monitored = true;
    }
  });

  return unique;
};

/**
 * Format specific fields of an author, such as ebookQualityProfileId
 */
const formatFields = (
  mediaType: ChaptarrMediaType,
  fields: Record<string, unknown>
): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [
      `${mediaType}${key[0].toUpperCase()}${key.slice(1)}`,
      value,
    ])
  );

class ChaptarrAPI extends ServarrBase<{ bookId: number }> {
  private capabilities?: Promise<ChaptarrCapabilities>;

  constructor({ url, apiKey }: { url: string; apiKey: string }) {
    super({ url, apiKey, cacheName: 'chaptarr', apiName: 'Chaptarr' });
  }

  /**
   * Tells Chaptarr apart from other Readarr compatible servers by the app
   * name of its status
   */
  public getCapabilities(): Promise<ChaptarrCapabilities> {
    if (!this.capabilities) {
      this.capabilities = this.getSystemStatus()
        .then((status) => {
          const appName =
            (status as unknown as { appName?: string }).appName ?? 'Readarr';

          return {
            appName,
            version: status.version,
            isChaptarr: appName.trim().toLowerCase() === 'chaptarr',
          };
        })
        .catch((e) => {
          this.capabilities = undefined;
          throw e;
        });
    }

    return this.capabilities;
  }

  /**
   * Tells Talearr apart from stock Chaptarr. Each sign is read on its own
   * and one that cannot be read counts as missing, so stock Chaptarr and
   * other Readarr compatible servers are reported as not Talearr.
   */
  public async getTalearrIdentity(): Promise<TalearrIdentity> {
    const baseUrl = (this.axios.defaults.baseURL ?? '').replace(
      /\/api\/v1\/?$/,
      ''
    );
    const optional = <T>(read: () => Promise<T>) =>
      read().catch(() => undefined);

    const [status, initialize, grabPolicy] = await Promise.all([
      optional(() => this.getSystemStatus()),
      optional(async () => {
        const response = await this.axios.get<unknown>(
          `${baseUrl}/initialize.json`,
          { timeout: IDENTITY_TIMEOUT_MS }
        );
        return response.data && typeof response.data === 'object'
          ? (response.data as Record<string, unknown>)
          : undefined;
      }),
      optional(async () =>
        parseTalearrGrabPolicy(
          (
            await this.axios.get<unknown>('/config/talearrgrabpolicy', {
              timeout: IDENTITY_TIMEOUT_MS,
            })
          ).data
        )
      ),
    ]);
    const instanceName = (status as { instanceName?: unknown } | undefined)
      ?.instanceName;
    const version =
      typeof initialize?.talearrVersion === 'string' &&
      initialize.talearrVersion.trim()
        ? initialize.talearrVersion.trim()
        : undefined;
    const isTalearr =
      !!version ||
      mentionsTalearr(initialize?.productName) ||
      mentionsTalearr(instanceName) ||
      !!grabPolicy;

    if (!isTalearr) {
      return {
        isTalearr,
        instanceName:
          typeof instanceName === 'string' ? instanceName : undefined,
      };
    }

    const health = await optional(
      async () =>
        (
          await this.axios.get<unknown>('/health', {
            timeout: IDENTITY_TIMEOUT_MS,
          })
        ).data
    );
    const metadataCheck = Array.isArray(health)
      ? (health as { source?: unknown; message?: unknown }[]).find(
          (check) => check?.source === TALEARR_METADATA_CHECK
        )
      : undefined;

    return {
      isTalearr,
      version,
      instanceName: typeof instanceName === 'string' ? instanceName : undefined,
      grabPolicy,
      metadataProblem:
        typeof metadataCheck?.message === 'string' && metadataCheck.message
          ? metadataCheck.message
          : undefined,
    };
  }

  /**
   * Talearr's recordings of the work a book belongs to, and the audiobook
   * editions that could become one. Undefined when the server has no such
   * route, as stock Chaptarr and Talearr before recordings do not.
   */
  public async getTalearrRecordings(
    bookId: number,
    { timeoutMs = RECORDINGS_TIMEOUT_MS }: { timeoutMs?: number } = {}
  ): Promise<TalearrRecordings | undefined> {
    const response = await this.axios.get<unknown>('/talearr/recordings', {
      params: { bookId },
      timeout: timeoutMs,
      validateStatus: (status) => status < 500,
    });

    return response.status === 200
      ? parseTalearrRecordings(response.data)
      : undefined;
  }

  /**
   * What Talearr's download client seeds and whether the trackers' seeding
   * rules are kept, as Talearr sends it. Undefined when the server has no
   * such route, as stock Chaptarr and older Talearr do not.
   */
  public async getTalearrSeeding(): Promise<unknown> {
    const response = await this.axios.get<unknown>('/talearr/seeding', {
      timeout: SEEDING_TIMEOUT_MS,
      validateStatus: (status) => status < 500 && status !== 401,
    });

    if (response.status === 404) {
      return undefined;
    }

    if (response.status !== 200) {
      throw new Error(
        `Talearr answered the seeding request with status ${response.status}`
      );
    }

    return response.data;
  }

  /**
   * Asks Talearr for another recording of a book. Refusals are answered,
   * not thrown, so the caller can tell a missing edition from a server that
   * could not be reached.
   */
  public async addTalearrRecording(
    body: TalearrAddRecordingBody
  ): Promise<TalearrAddRecordingResult> {
    const response = await this.axios.post<unknown>(
      '/talearr/recordings',
      body,
      {
        timeout: UPDATE_TIMEOUT_MS,
        validateStatus: (status) => status < 500 && status !== 401,
      }
    );

    if (
      response.status !== 200 &&
      response.status !== 201 &&
      response.status !== 400 &&
      response.status !== 404 &&
      response.status !== 409
    ) {
      throw new Error(
        `Talearr answered the recording request with status ${response.status}`
      );
    }

    return parseTalearrAddRecording(response.status, response.data);
  }

  /**
   * Talearr's grab policy override for one book, such as abridged only.
   * Answers unsupported, rather than throwing, when the server has no such
   * route.
   */
  public async getTalearrBookGrabPolicy(
    bookId: number
  ): Promise<TalearrBookGrabPolicy> {
    const response = await this.axios.get<unknown>(
      `/talearr/grabpolicy/book/${bookId}`,
      {
        timeout: IDENTITY_TIMEOUT_MS,
        validateStatus: (status) => status < 500 && status !== 401,
      }
    );

    return parseTalearrBookGrabPolicy(response.status, response.data);
  }

  /**
   * Sets Talearr's grab policy override for one book, or clears it with
   * null so the book follows the global policy. False when the server has
   * no such route.
   */
  public async setTalearrBookGrabPolicy(
    bookId: number,
    abridgedPolicy: TalearrAbridgedPolicy | null
  ): Promise<boolean> {
    const response = await this.axios.put<unknown>(
      `/talearr/grabpolicy/book/${bookId}`,
      { abridgedPolicy },
      {
        timeout: UPDATE_TIMEOUT_MS,
        validateStatus: (status) => status < 500 && status !== 401,
      }
    );

    if (response.status >= 200 && response.status < 300) {
      return true;
    }

    if (response.status === 404 && !isKnownRouteNotFound(response.data)) {
      return false;
    }

    throw new Error(
      `Talearr answered the grab policy of book ${bookId} with status ${response.status}`
    );
  }

  public async getChaptarrRootFolders(): Promise<ChaptarrRootFolder[]> {
    return (await this.getRootFolders()) as ChaptarrRootFolder[];
  }

  public async getChaptarrProfiles(): Promise<ChaptarrQualityProfile[]> {
    return (await this.getProfiles()) as ChaptarrQualityProfile[];
  }

  // The base class has its tag calls as instance functions, these are
  // methods of the class so they can be stubbed like the others
  public async getChaptarrTags(): Promise<Tag[]> {
    return this.getTags();
  }

  public async createChaptarrTag(label: string): Promise<Tag> {
    return this.createTag({ label });
  }

  public async getMetadataProfiles(): Promise<ChaptarrMetadataProfile[]> {
    try {
      return await this.getRolling<ChaptarrMetadataProfile[]>(
        '/metadataprofile',
        undefined,
        3600
      );
    } catch (e) {
      throw new Error(
        `[Chaptarr] Failed to retrieve metadata profiles: ${e.message}`,
        { cause: e }
      );
    }
  }

  /**
   * Searches Chaptarr's metadata for books. The term can be a title and
   * author, or an id such as isbn:9780141439518. Chaptarr also lists the
   * books of each format it already has with every result.
   */
  public async lookupBooks(
    term: string,
    mediaType?: ChaptarrMediaType
  ): Promise<ChaptarrBook[]> {
    try {
      const { isChaptarr } = await this.getCapabilities();
      const params = {
        term,
        ...(isChaptarr && mediaType ? { mediaType } : {}),
      };
      const get = () =>
        this.axios.get<ChaptarrBook[]>('/book/lookup', {
          params,
          timeout: LOOKUP_TIMEOUT_MS,
        });
      let response;

      try {
        response = await get();
      } catch (e) {
        if (!isTimeout(e)) {
          throw e;
        }
        // Usually a busy moment in Chaptarr; one more try
        await wait(chaptarrRetryDelays.lookupMs);
        response = await get();
      }

      return Array.isArray(response.data) ? response.data : [];
    } catch (e) {
      throw new Error(`[Chaptarr] Failed to look up books: ${e.message}`, {
        cause: e,
      });
    }
  }

  public async lookupAuthors(term: string): Promise<ChaptarrAuthor[]> {
    try {
      const response = await this.axios.get<ChaptarrAuthor[]>(
        '/author/lookup',
        { params: { term } }
      );

      return Array.isArray(response.data) ? response.data : [];
    } catch (e) {
      throw new Error(`[Chaptarr] Failed to look up authors: ${e.message}`, {
        cause: e,
      });
    }
  }

  /**
   * The cover of each book, by book id, for books that have a web cover.
   * Asked in one request.
   */
  public async getBookCovers(bookIds: number[]): Promise<Map<number, string>> {
    const covers = new Map<number, string>();

    if (!bookIds.length) {
      return covers;
    }

    const query = bookIds.map((id) => `bookIds=${id}`).join('&');
    const response = await this.axios.get<
      {
        id: number;
        images?: { coverType?: string; remoteUrl?: string }[];
      }[]
    >(`/book?${query}`);

    for (const book of response.data) {
      const cover = book.images?.find(
        (image) =>
          ['cover', 'poster'].includes(image.coverType?.toLowerCase() ?? '') &&
          /^https?:\/\//.test(image.remoteUrl ?? '')
      )?.remoteUrl;

      if (cover) {
        covers.set(book.id, cover);
      }
    }

    return covers;
  }

  /**
   * A book in the library, or undefined when Chaptarr does not have it
   */
  public async getBook(bookId: number): Promise<ChaptarrBook | undefined> {
    try {
      const response = await this.axios.get<ChaptarrBook>(`/book/${bookId}`);

      return response.data;
    } catch (e) {
      if (e.response?.status === 404) {
        return undefined;
      }

      throw new Error(`[Chaptarr] Failed to retrieve book: ${e.message}`, {
        cause: e,
      });
    }
  }

  /**
   * The editions of a library book. The monitored one decides the title
   * Chaptarr shows and searches for.
   */
  public async getEditions(bookId: number): Promise<ChaptarrEdition[]> {
    try {
      const response = await this.axios.get<ChaptarrEdition[]>('/edition', {
        params: { bookId },
        timeout: UPDATE_TIMEOUT_MS,
      });

      return Array.isArray(response.data) ? response.data : [];
    } catch (e) {
      throw new Error(`[Chaptarr] Failed to retrieve editions: ${e.message}`, {
        cause: e,
      });
    }
  }

  /**
   * Saves a library book with these editions, which is how Chaptarr changes
   * the monitored edition (it has no edition monitor endpoint). The book is
   * read again so only its editions change. Chaptarr refuses a book listing
   * the same edition twice ("Sequence contains more than one matching
   * element"), so pass the editions through uniqueEditions first.
   */
  public async updateBookEditions(
    bookId: number,
    editions: ChaptarrEdition[]
  ): Promise<void> {
    const book = await this.getBook(bookId);

    if (!book) {
      throw new Error(`[Chaptarr] Book ${bookId} not found`);
    }

    try {
      await this.axios.put(
        `/book/${bookId}`,
        { ...book, editions },
        { timeout: UPDATE_TIMEOUT_MS }
      );
    } catch (e) {
      throw new Error(
        `[Chaptarr] Failed to update book editions: ${getArrErrorMessage(e)}`,
        { cause: e }
      );
    }
  }

  /** The library author with this metadata id, if Chaptarr has them. */
  public async getAuthorByForeignId(
    foreignAuthorId: string
  ): Promise<ChaptarrAuthor | undefined> {
    const response = await this.axios.get<ChaptarrAuthor[]>('/author', {
      timeout: UPDATE_TIMEOUT_MS,
    });

    return (response.data ?? []).find(
      (author) => author.foreignAuthorId === foreignAuthorId
    );
  }

  public async getBooksByAuthor(authorId: number): Promise<ChaptarrBook[]> {
    // Authors come with their whole catalog, which Chaptarr is slow to list
    const response = await this.axios.get<ChaptarrBook[]>('/book', {
      params: { authorId },
      timeout: UPDATE_TIMEOUT_MS,
    });

    return response.data;
  }

  /**
   * Every book in the library, monitored or not. Chaptarr is read a page
   * at a time, other servers list the library at once.
   */
  public async getAllBooks(): Promise<ChaptarrBook[]> {
    try {
      const { isChaptarr } = await this.getCapabilities();

      if (!isChaptarr) {
        const response = await this.axios.get<ChaptarrBook[]>('/book', {
          timeout: LIBRARY_PAGE_TIMEOUT_MS,
        });
        return response.data;
      }

      return await this.readLibrary({});
    } catch (e) {
      if (e instanceof ChaptarrLibraryError) {
        throw e;
      }

      throw new Error(`[Chaptarr] Failed to retrieve books: ${e.message}`, {
        cause: e,
      });
    }
  }

  /**
   * The books that are monitored or have files, all a library scan needs.
   * Most of a large library is the catalogs of its authors, which Chaptarr
   * leaves out here, so far fewer pages are read. Servers that cannot
   * filter the library list all of it.
   */
  public async getActiveBooks(): Promise<ChaptarrBook[]> {
    try {
      const { isChaptarr } = await this.getCapabilities();

      if (!isChaptarr) {
        return await this.getAllBooks();
      }

      const books = new Map<number, ChaptarrBook>();

      const filters: Record<string, boolean>[] = [
        { monitored: true },
        { downloaded: true },
      ];

      for (const filter of filters) {
        for (const book of await this.readLibrary(filter)) {
          if (book.id) {
            books.set(book.id, book);
          }
        }
      }

      return [...books.values()];
    } catch (e) {
      if (e instanceof ChaptarrLibraryError) {
        throw e;
      }

      throw new Error(`[Chaptarr] Failed to retrieve books: ${e.message}`, {
        cause: e,
      });
    }
  }

  /**
   * Reads the library a page at a time, in the order books were added so
   * a book added meanwhile does not shift the pages still to read
   */
  private async readLibrary(
    filter: Record<string, boolean>
  ): Promise<ChaptarrBook[]> {
    const books: ChaptarrBook[] = [];
    let pages: number | undefined;

    for (let page = 1; books.length < MAX_LIBRARY_BOOKS; page++) {
      const data = await this.getLibraryPage(
        { offset: books.length, ...filter },
        page,
        pages
      );
      const records = data.records ?? [];
      books.push(...records);
      pages = Math.max(
        1,
        Math.ceil((data.totalCount ?? 0) / LIBRARY_PAGE_SIZE)
      );

      if (records.length === 0 || books.length >= (data.totalCount ?? 0)) {
        break;
      }
    }

    return books;
  }

  private async getLibraryPage(
    params: Record<string, unknown>,
    page: number,
    pages?: number
  ): Promise<PagedBooks> {
    const which = `page ${page}${pages ? ` of ${pages}` : ''}`;

    for (let attempt = 0; ; attempt++) {
      try {
        const response = await this.axios.get<PagedBooks>('/book/paged', {
          params: {
            pageSize: LIBRARY_PAGE_SIZE,
            includeUnmonitored: true,
            sortKey: 'id',
            ...params,
          },
          timeout: LIBRARY_PAGE_TIMEOUT_MS,
        });

        return response.data;
      } catch (e) {
        const status: number | undefined = e.response?.status;
        // A request Chaptarr turned down fails the same way every time
        const final =
          attempt >= chaptarrRetryDelays.libraryPageMs.length ||
          (status !== undefined && status < 500 && status !== 429);

        if (final) {
          const tries = attempt + 1;
          const reason =
            e.code === 'ECONNABORTED' || /timeout/i.test(e.message ?? '')
              ? `did not answer ${which} of the library in ` +
                `${LIBRARY_PAGE_TIMEOUT_MS / 1000} s`
              : `failed to send ${which} of the library (${e.message})`;

          throw new ChaptarrLibraryError(
            `Chaptarr ${reason}${tries > 1 ? `, tried ${tries} times` : ''}`,
            { cause: e }
          );
        }

        await sleep(chaptarrRetryDelays.libraryPageMs[attempt]);
      }
    }
  }

  /**
   * Adds a book found by a lookup in one format, monitored and with only
   * that book of its author monitored. A new author is imported first: when
   * that takes a while Chaptarr accepts the request and returns the id of a
   * pending author import, and adds the book once the author is ready.
   */
  public async addBook(
    book: ChaptarrBook,
    options: ChaptarrAddBookOptions
  ): Promise<ChaptarrAddBookResult> {
    const { isChaptarr } = await this.getCapabilities();
    const { mediaType } = options;
    const editions = book.editions?.length
      ? book.editions.some((edition) => edition.monitored)
        ? book.editions
        : book.editions.map((edition, index) => ({
            ...edition,
            monitored: index === 0,
          }))
      : undefined;

    const payload: ChaptarrBook = {
      ...book,
      // A lookup result can carry the id of the other format's book
      id: 0,
      localBookId: null,
      monitored: true,
      anyEditionOk: true,
      editions,
      addOptions: {
        ...book.addOptions,
        searchForNewBook: options.searchForNewBook,
      },
      author: {
        ...(book.author as ChaptarrAuthor),
        monitored: true,
        monitorNewItems: 'none',
        qualityProfileId: options.qualityProfileId,
        metadataProfileId: options.metadataProfileId,
        rootFolderPath: options.rootFolderPath,
        tags: options.tags,
        addOptions: isChaptarr
          ? {
              monitor: 'specificBook',
              booksToMonitor: [book.foreignBookId],
              searchForMissingBooks: false,
            }
          : { monitor: 'none', searchForMissingBooks: false },
        ...(isChaptarr
          ? formatFields(mediaType, {
              qualityProfileId: options.qualityProfileId,
              metadataProfileId: options.metadataProfileId,
              rootFolderPath: options.rootFolderPath,
              monitored: true,
              monitorNewItems: 'none',
              tags: options.tags,
            })
          : {}),
      },
      ...(isChaptarr
        ? {
            mediaType,
            ebookMonitored: mediaType === 'ebook',
            audiobookMonitored: mediaType === 'audiobook',
          }
        : {}),
    };

    try {
      const post = () =>
        this.axios.post<
          ChaptarrBook | { pendingId?: number; message?: string }
        >('/book', payload, {
          params: isChaptarr ? { mediaType } : undefined,
          timeout: ADD_TIMEOUT_MS,
        });
      let response;

      try {
        response = await post();
      } catch (e) {
        if (!isAuthorBusyError(e)) {
          throw e;
        }
        logger.info(
          'Chaptarr is still setting up the author, adding the book again shortly',
          { label: 'Chaptarr', title: book.title, mediaType }
        );
        await wait(chaptarrRetryDelays.authorBusyMs);
        response = await post();
      }
      const data = response.data as ChaptarrBook & {
        pendingId?: number;
        message?: string;
      };

      if (response.status === 202 && data.pendingId) {
        logger.info('Chaptarr is importing the author before adding the book', {
          label: 'Chaptarr',
          title: book.title,
          mediaType,
          pendingId: data.pendingId,
        });

        return {
          status: 'pending',
          pendingId: data.pendingId,
          message: data.message,
        };
      }

      if (!data.id) {
        throw new Error('Chaptarr did not return the added book');
      }

      logger.info('Chaptarr accepted request', {
        label: 'Chaptarr',
        bookId: data.id,
        title: data.title,
        mediaType,
      });

      return { status: 'added', book: data };
    } catch (e) {
      if (isTimeout(e)) {
        logger.info('Chaptarr is taking a while to add the book', {
          label: 'Chaptarr',
          title: book.title,
          mediaType,
        });
        return { status: 'timeout' };
      }

      logger.error('Something went wrong while adding a book to Chaptarr.', {
        label: 'Chaptarr API',
        errorMessage: e.message,
        title: book.title,
        foreignBookId: book.foreignBookId,
        mediaType,
        response: e?.response?.data,
      });
      throw new Error(`[Chaptarr] Failed to add book: ${e.message}`, {
        cause: e,
      });
    }
  }

  /**
   * A pending author import, or undefined once Chaptarr has finished and
   * cleared it
   */
  public async getPendingImport(
    pendingId: number
  ): Promise<ChaptarrPendingImport | undefined> {
    try {
      const response = await this.axios.get<ChaptarrPendingImport | null>(
        `/pendingauthorimport/${pendingId}`
      );

      return response.data ?? undefined;
    } catch (e) {
      if (e.response?.status === 404) {
        return undefined;
      }

      throw new Error(
        `[Chaptarr] Failed to retrieve pending import: ${e.message}`,
        { cause: e }
      );
    }
  }

  /**
   * Waits for a pending author import to finish. An import that is gone
   * has finished, Chaptarr clears them once they succeed.
   */
  public async waitForPendingImport(
    pendingId: number,
    {
      timeoutMs = 120_000,
      intervalMs = 5_000,
    }: { timeoutMs?: number; intervalMs?: number } = {}
  ): Promise<ChaptarrPendingResult> {
    const deadline = Date.now() + timeoutMs;

    for (;;) {
      const pending = await this.getPendingImport(pendingId);
      const status = pending?.overallStatus?.toLowerCase();

      if (!pending || status === 'succeeded' || status === 'partialsuccess') {
        return 'succeeded';
      }

      if (status === 'failed') {
        return 'failed';
      }

      if (Date.now() + intervalMs > deadline) {
        return 'timeout';
      }

      await sleep(intervalMs);
    }
  }

  public async getAuthor(authorId: number): Promise<ChaptarrAuthor> {
    try {
      const response = await this.axios.get<ChaptarrAuthor>(
        `/author/${authorId}`,
        { timeout: UPDATE_TIMEOUT_MS }
      );

      return response.data;
    } catch (e) {
      throw new Error(`[Chaptarr] Failed to retrieve author: ${e.message}`, {
        cause: e,
      });
    }
  }

  /**
   * Saves an author as read from getAuthor with some of its fields changed
   */
  public async updateAuthor(author: ChaptarrAuthor): Promise<void> {
    try {
      await this.axios.put(`/author/${author.id}`, author, {
        params: { moveFiles: false },
        timeout: UPDATE_TIMEOUT_MS,
      });
    } catch (e) {
      throw new Error(`[Chaptarr] Failed to update author: ${e.message}`, {
        cause: e,
      });
    }
  }

  public async getReleaseProfiles(): Promise<ChaptarrReleaseProfile[]> {
    try {
      const response =
        await this.axios.get<ChaptarrReleaseProfile[]>('/releaseprofile');

      return Array.isArray(response.data) ? response.data : [];
    } catch (e) {
      throw new Error(
        `[Chaptarr] Failed to retrieve release profiles: ${e.message}`,
        { cause: e }
      );
    }
  }

  public async createReleaseProfile(
    profile: ChaptarrReleaseProfile
  ): Promise<ChaptarrReleaseProfile> {
    try {
      const response = await this.axios.post<ChaptarrReleaseProfile>(
        '/releaseprofile',
        profile
      );

      return response.data;
    } catch (e) {
      throw new Error(
        `[Chaptarr] Failed to create release profile: ${e.message}`,
        { cause: e }
      );
    }
  }

  public async updateReleaseProfile(
    profile: ChaptarrReleaseProfile
  ): Promise<void> {
    try {
      await this.axios.put(`/releaseprofile/${profile.id}`, profile);
    } catch (e) {
      throw new Error(
        `[Chaptarr] Failed to update release profile: ${e.message}`,
        { cause: e }
      );
    }
  }

  public async setBooksMonitored(
    bookIds: number[],
    monitored: boolean
  ): Promise<void> {
    if (bookIds.length === 0) {
      return;
    }

    try {
      await this.axios.put(
        '/book/monitor',
        { bookIds, monitored },
        { timeout: UPDATE_TIMEOUT_MS }
      );
    } catch (e) {
      throw new Error(
        `[Chaptarr] Failed to change book monitoring: ${e.message}`,
        { cause: e }
      );
    }
  }

  /**
   * Turns on a format for an author. Chaptarr only grabs a monitored book
   * automatically when its author is monitored for that format too, and an
   * author first added for the other format has it off. New books by the
   * author stay unmonitored. Returns true when something changed.
   */
  public async enableAuthorFormat(
    authorId: number,
    mediaType: ChaptarrMediaType,
    format: {
      qualityProfileId: number;
      metadataProfileId: number;
      rootFolderPath: string;
    }
  ): Promise<boolean> {
    const author = await this.getAuthor(authorId);

    if (!author) {
      return false;
    }

    const side = mediaType === 'audiobook' ? 'audiobook' : 'ebook';
    const hasRoot = !!author[`${side}RootFolderPath`];

    if (author[`${side}Monitored`] === true && hasRoot) {
      return false;
    }

    try {
      await this.axios.put(
        '/author/editor',
        {
          authorIds: [authorId],
          [`${side}Monitored`]: true,
          [`${side}MonitorNewItems`]: 'none',
          moveFiles: false,
          ...(hasRoot
            ? {}
            : {
                [`${side}RootFolderPath`]: format.rootFolderPath,
                [`${side}QualityProfileId`]: format.qualityProfileId,
                [`${side}MetadataProfileId`]: format.metadataProfileId,
              }),
        },
        { timeout: UPDATE_TIMEOUT_MS }
      );
    } catch (e) {
      throw new Error(
        `[Chaptarr] Failed to turn on ${side}s for the author: ${e.message}`,
        { cause: e }
      );
    }

    return true;
  }

  public async searchBooks(bookIds: number[]): Promise<void> {
    logger.info('Executing book search command.', {
      label: 'Chaptarr API',
      bookIds,
    });

    await this.runCommand('BookSearch', { bookIds });
  }

  /**
   * Searches the indexers for releases of a book. Releases Chaptarr's
   * filters hid are returned apart.
   */
  public async getReleases(
    bookId: number
  ): Promise<{ releases: ServarrRelease[]; hidden: ServarrRelease[] }> {
    const data = await this.fetchReleases<
      ServarrRelease[] | ChaptarrReleaseSearch
    >({ bookId });

    if (Array.isArray(data)) {
      return { releases: data, hidden: [] };
    }

    return {
      releases: data?.releases ?? [],
      hidden: data?.hiddenReleases ?? [],
    };
  }

  /**
   * The downloads in the queue with their books, so each tells its format
   */
  public async getBookQueue(): Promise<ChaptarrQueueItem[]> {
    try {
      const response = await this.axios.get<QueuePage>('/queue', {
        params: {
          page: 1,
          pageSize: QUEUE_PAGE_SIZE,
          includeBook: true,
          includeAuthor: false,
          includeUnknownAuthorItems: false,
        },
      });

      return Array.isArray(response.data?.records) ? response.data.records : [];
    } catch (e) {
      throw new Error(`[Chaptarr] Failed to retrieve queue: ${e.message}`, {
        cause: e,
      });
    }
  }

  /**
   * Has Chaptarr try the import of a finished download again, the way its
   * queue's retry does, and waits briefly for the result. Returns the
   * command's error when it failed, and whether it finished in time.
   */
  public async retryImport(
    downloadId: string
  ): Promise<{ finished: boolean; error?: string }> {
    let commandId: number | undefined;

    try {
      const response = await this.axios.post<{ id?: number }>('/command', {
        name: 'RetryFailedImport',
        downloadId,
      });
      commandId = response.data?.id;
    } catch (e) {
      throw new Error(`[Chaptarr] Failed to retry the import: ${e.message}`, {
        cause: e,
      });
    }

    if (!commandId) {
      return { finished: false };
    }

    for (let attempt = 0; attempt < RETRY_IMPORT_POLLS; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, RETRY_IMPORT_POLL_MS));
      const { data } = await this.axios.get<{
        status?: string;
        exception?: string;
        message?: string;
      }>(`/command/${commandId}`);
      const status = data?.status?.toLowerCase();

      if (status === 'completed') {
        return { finished: true };
      }

      if (
        status === 'failed' ||
        status === 'aborted' ||
        status === 'orphaned'
      ) {
        return {
          finished: true,
          error: data.exception || data.message || 'The import failed.',
        };
      }
    }

    return { finished: false };
  }

  public async getBookHistory(
    authorId: number,
    bookId: number
  ): Promise<ServarrHistoryRecord[]> {
    return this.fetchHistory('/history/author', { authorId, bookId });
  }

  public async getBookFiles(bookId: number): Promise<ChaptarrBookFile[]> {
    try {
      const response = await this.axios.get<ChaptarrBookFile[]>('/bookfile', {
        params: { bookId },
      });

      return response.data;
    } catch (e) {
      throw new Error(
        `[Chaptarr] Failed to retrieve book files: ${e.message}`,
        { cause: e }
      );
    }
  }

  public async deleteBookFiles(bookFileIds: number[]): Promise<void> {
    if (bookFileIds.length === 0) {
      return;
    }

    try {
      await this.axios.delete('/bookfile/bulk', {
        data: { bookFileIds },
        timeout: UPDATE_TIMEOUT_MS,
      });
    } catch (e) {
      throw new Error(`[Chaptarr] Failed to delete book files: ${e.message}`, {
        cause: e,
      });
    }
  }

  public async removeAuthor(
    authorId: number,
    { deleteFiles }: { deleteFiles: boolean }
  ): Promise<void> {
    await this.axios.delete(`/author/${authorId}`, {
      params: { deleteFiles, addImportListExclusion: false },
      // Chaptarr deletes the author's whole catalog with it
      timeout: REMOVE_AUTHOR_TIMEOUT_MS,
    });
  }
}

export default ChaptarrAPI;
