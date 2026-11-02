import ExternalAPI from '@server/api/externalapi';
import cacheManager from '@server/lib/cache';
import { getContactUserAgent } from '@server/utils/userAgent';
import type {
  OlAuthor,
  OlAuthorSearchResponse,
  OlSearchDoc,
  OlSearchResponse,
  OlSubjectResponse,
  OlSubjectSearchResponse,
  OlText,
  OlTrendingResponse,
  OlWork,
} from './interfaces';

const CACHE_TTL = 43200;
const TRENDING_CACHE_TTL = 3600;
const BASE_URL = 'https://openlibrary.org';
// OpenLibrary allows three requests a second from identified clients
const MAX_RPS = 3;
// Merged works and authors redirect to the record they were merged into
const MAX_REDIRECTS = 3;

const SEARCH_FIELDS = [
  'key',
  'title',
  'subtitle',
  'author_name',
  'author_key',
  'first_publish_year',
  'cover_i',
  'edition_count',
  'number_of_pages_median',
  'ratings_average',
  'ratings_count',
  'subject',
  'language',
].join(',');

export const WORK_ID_REGEX = /^OL\d+W$/;
export const AUTHOR_ID_REGEX = /^OL\d+A$/;

export type OlCoverSize = 'S' | 'M' | 'L';
export type OlTrendingPeriod = 'daily' | 'weekly' | 'monthly' | 'yearly';

// A generic agent that names the project, OpenLibrary asks clients to
// identify themselves
export const getOpenLibraryUserAgent = (): string => getContactUserAgent();

/**
 * Id at the end of an OpenLibrary key such as /works/OL45804W
 */
export const getOlId = (key: string): string =>
  key.split('/').filter(Boolean).pop() ?? key;

export const getOlText = (text?: OlText): string | undefined => {
  const value = typeof text === 'string' ? text : text?.value;

  return value?.trim() || undefined;
};

/**
 * Cover image by cover id. Records without a cover use -1 or leave it out.
 */
export const getCoverUrl = (
  coverId?: number | null,
  size: OlCoverSize = 'L'
): string | null =>
  coverId && coverId > 0
    ? `https://covers.openlibrary.org/b/id/${coverId}-${size}.jpg`
    : null;

export const getAuthorPhotoUrl = (
  photoId?: number | null,
  size: OlCoverSize = 'M'
): string | null =>
  photoId && photoId > 0
    ? `https://covers.openlibrary.org/a/id/${photoId}-${size}.jpg`
    : null;

const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : 'Unknown error';

class OpenLibrary extends ExternalAPI {
  constructor() {
    super(
      BASE_URL,
      {},
      {
        headers: { 'User-Agent': getOpenLibraryUserAgent() },
        nodeCache: cacheManager.getCache('openlibrary').data,
        publicCatalog: true,
        rateLimit: {
          maxRequests: MAX_RPS,
          maxRPS: MAX_RPS,
        },
      }
    );
  }

  public async searchBooks({
    query,
    page = 1,
    limit = 20,
  }: {
    query: string;
    page?: number;
    limit?: number;
  }): Promise<OlSearchResponse> {
    try {
      return await this.get<OlSearchResponse>(
        '/search.json',
        {
          params: {
            q: query,
            fields: SEARCH_FIELDS,
            page: String(page),
            limit: String(limit),
          },
        },
        CACHE_TTL
      );
    } catch (error) {
      throw new Error(
        `[OpenLibrary] Failed to search books: ${getErrorMessage(error)}`,
        { cause: error }
      );
    }
  }

  /**
   * Subjects whose names match a query, used to suggest subjects for the
   * book subject sliders
   */
  public async searchSubjects({
    query,
    limit = 10,
  }: {
    query: string;
    limit?: number;
  }): Promise<OlSubjectSearchResponse> {
    try {
      return await this.get<OlSubjectSearchResponse>(
        '/search/subjects.json',
        {
          params: {
            q: query,
            limit: String(limit),
          },
        },
        CACHE_TTL
      );
    } catch (error) {
      throw new Error(
        `[OpenLibrary] Failed to search subjects: ${getErrorMessage(error)}`
      );
    }
  }

  public async searchAuthors({
    query,
    page = 1,
    limit = 20,
  }: {
    query: string;
    page?: number;
    limit?: number;
  }): Promise<OlAuthorSearchResponse> {
    try {
      return await this.get<OlAuthorSearchResponse>(
        '/search/authors.json',
        {
          params: {
            q: query,
            offset: String((page - 1) * limit),
            limit: String(limit),
          },
        },
        CACHE_TTL
      );
    } catch (error) {
      throw new Error(
        `[OpenLibrary] Failed to search authors: ${getErrorMessage(error)}`
      );
    }
  }

  /**
   * A work by its id, following merges to the work it was merged into
   */
  public async getWork(workId: string): Promise<OlWork> {
    if (!WORK_ID_REGEX.test(workId)) {
      throw new Error('Invalid OpenLibrary work ID format');
    }

    try {
      return await this.getRecord<OlWork>(`/works/${workId}.json`);
    } catch (error) {
      throw new Error(
        `[OpenLibrary] Failed to fetch work: ${getErrorMessage(error)}`
      );
    }
  }

  /**
   * The search document of a work, which carries the first publish year,
   * edition count and median page count the work record leaves out
   */
  public async getWorkSummary(
    workId: string
  ): Promise<OlSearchDoc | undefined> {
    if (!WORK_ID_REGEX.test(workId)) {
      throw new Error('Invalid OpenLibrary work ID format');
    }

    try {
      const data = await this.get<OlSearchResponse>(
        '/search.json',
        {
          params: {
            q: `key:/works/${workId}`,
            fields: SEARCH_FIELDS,
            limit: '1',
          },
        },
        CACHE_TTL
      );

      return data.docs[0];
    } catch (error) {
      throw new Error(
        `[OpenLibrary] Failed to fetch work summary: ${getErrorMessage(error)}`
      );
    }
  }

  /**
   * ISBNs of a work's editions, ISBN-13 first, for matching the work in
   * services with other book sources
   */
  public async getWorkIsbns(workId: string, limit = 50): Promise<string[]> {
    if (!WORK_ID_REGEX.test(workId)) {
      throw new Error('Invalid OpenLibrary work ID format');
    }

    try {
      const data = await this.get<{
        entries?: { isbn_13?: string[]; isbn_10?: string[] }[];
      }>(
        `/works/${workId}/editions.json`,
        { params: { limit: String(limit) } },
        CACHE_TTL
      );
      const entries = data.entries ?? [];

      return [
        ...new Set([
          ...entries.flatMap((entry) => entry.isbn_13 ?? []),
          ...entries.flatMap((entry) => entry.isbn_10 ?? []),
        ]),
      ];
    } catch (error) {
      throw new Error(
        `[OpenLibrary] Failed to fetch work editions: ${getErrorMessage(error)}`
      );
    }
  }

  public async getAuthor(authorId: string): Promise<OlAuthor> {
    if (!AUTHOR_ID_REGEX.test(authorId)) {
      throw new Error('Invalid OpenLibrary author ID format');
    }

    try {
      return await this.getRecord<OlAuthor>(`/authors/${authorId}.json`);
    } catch (error) {
      throw new Error(
        `[OpenLibrary] Failed to fetch author: ${getErrorMessage(error)}`
      );
    }
  }

  /**
   * An author's works, most published first
   */
  public async getAuthorWorks({
    authorId,
    page = 1,
    limit = 100,
  }: {
    authorId: string;
    page?: number;
    limit?: number;
  }): Promise<OlSearchResponse> {
    if (!AUTHOR_ID_REGEX.test(authorId)) {
      throw new Error('Invalid OpenLibrary author ID format');
    }

    try {
      return await this.get<OlSearchResponse>(
        '/search.json',
        {
          params: {
            q: `author_key:${authorId}`,
            sort: 'editions',
            fields: SEARCH_FIELDS,
            page: String(page),
            limit: String(limit),
          },
        },
        CACHE_TTL
      );
    } catch (error) {
      throw new Error(
        `[OpenLibrary] Failed to fetch author works: ${getErrorMessage(error)}`
      );
    }
  }

  public async getTrending({
    period = 'daily',
    page = 1,
    limit = 20,
  }: {
    period?: OlTrendingPeriod;
    page?: number;
    limit?: number;
  } = {}): Promise<OlTrendingResponse> {
    try {
      return await this.get<OlTrendingResponse>(
        `/trending/${period}.json`,
        {
          params: {
            page: String(page),
            limit: String(limit),
          },
        },
        TRENDING_CACHE_TTL
      );
    } catch (error) {
      throw new Error(
        `[OpenLibrary] Failed to fetch trending books: ${getErrorMessage(
          error
        )}`
      );
    }
  }

  public async getSubject({
    subject,
    page = 1,
    limit = 20,
  }: {
    subject: string;
    page?: number;
    limit?: number;
  }): Promise<OlSubjectResponse> {
    try {
      return await this.get<OlSubjectResponse>(
        `/subjects/${encodeURIComponent(subject)}.json`,
        {
          params: {
            offset: String((page - 1) * limit),
            limit: String(limit),
          },
        },
        CACHE_TTL
      );
    } catch (error) {
      throw new Error(
        `[OpenLibrary] Failed to fetch subject: ${getErrorMessage(error)}`
      );
    }
  }

  private async getRecord<
    T extends { type: { key: string }; location?: string },
  >(path: string): Promise<T> {
    let currentPath = path;

    for (let i = 0; i <= MAX_REDIRECTS; i++) {
      const record = await this.get<T>(currentPath, undefined, CACHE_TTL);

      if (record.type?.key !== '/type/redirect' || !record.location) {
        return record;
      }

      currentPath = `${record.location}.json`;
    }

    throw new Error('Too many redirects');
  }
}

export default OpenLibrary;
