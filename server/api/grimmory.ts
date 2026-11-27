import { proxyRequestInterceptor } from '@server/utils/customProxyAgent';
import { userAgentRequestInterceptor } from '@server/utils/userAgent';
import type { AxiosInstance, AxiosRequestConfig } from 'axios';
import axios, { isAxiosError } from 'axios';

/**
 * Grimmory (formerly BookLore) keeps ebooks, comics and audiobooks. Its API
 * signs in with a username and password (POST /api/v1/auth/login) and takes
 * the access token it answers with as a bearer token.
 */

export type GrimmoryFormat = 'ebook' | 'audiobook';

export interface GrimmoryLibrary {
  id: string;
  name: string;
  // The file types the library takes, when Grimmory says
  formats: string[];
}

/**
 * A book in Grimmory, with the metadata used to match it to a work. One
 * book can hold several files, such as an EPUB and an audiobook.
 */
export interface GrimmoryBook {
  id: string;
  libraryId?: string;
  title: string;
  subtitle?: string;
  authors: string[];
  series: string[];
  isbn?: string;
  asin?: string;
  formats: GrimmoryFormat[];
}

interface GrimmoryBookFile {
  bookType?: string | null;
}

interface GrimmoryBookResponse {
  id?: number | string;
  libraryId?: number | string;
  title?: string | null;
  primaryFile?: GrimmoryBookFile | null;
  alternativeFormats?: GrimmoryBookFile[] | null;
  metadata?: {
    title?: string | null;
    subtitle?: string | null;
    authors?: string[] | null;
    seriesName?: string | null;
    isbn13?: string | null;
    isbn10?: string | null;
    asin?: string | null;
  } | null;
}

interface GrimmoryAppBookResponse {
  id?: number | string;
  libraryId?: number | string;
  title?: string | null;
  authors?: string[] | null;
  seriesName?: string | null;
  isbn13?: string | null;
  isbn10?: string | null;
  primaryFileType?: string | null;
}

interface GrimmoryLibraryResponse {
  id?: number | string;
  name?: string;
  allowedFormats?: string[] | null;
  paths?: { allowedFormats?: string[] | null }[] | null;
}

export interface GrimmoryUser {
  id: number | string;
  username: string;
  name?: string | null;
  email?: string | null;
  assignedLibraries?: { id: number | string }[] | null;
  permissions?: Record<string, boolean | undefined> | null;
  // Some versions put the admin flag beside the permissions
  admin?: boolean;
}

/**
 * The format a Grimmory file type is: AUDIOBOOK is the audiobook, PDF,
 * EPUB, MOBI, AZW3 and FB2 are ebooks, comic archives are neither
 */
export const toGrimmoryFormat = (
  bookType?: string | null
): GrimmoryFormat | undefined => {
  const type = (bookType ?? '').toUpperCase();

  if (type === 'AUDIOBOOK') {
    return 'audiobook';
  }

  return ['EPUB', 'PDF', 'MOBI', 'AZW3', 'AZW', 'FB2'].includes(type)
    ? 'ebook'
    : undefined;
};

const text = (value?: string | null): string | undefined =>
  value?.trim() || undefined;

/**
 * A book from the book list, leaving out books without a title
 */
export const mapGrimmoryBook = (
  book: GrimmoryBookResponse
): GrimmoryBook | undefined => {
  const title = text(book.metadata?.title) ?? text(book.title);

  if (book.id === undefined || book.id === null || !title) {
    return undefined;
  }

  const formats = [
    ...new Set(
      [book.primaryFile, ...(book.alternativeFormats ?? [])]
        .map((file) => toGrimmoryFormat(file?.bookType))
        .filter((format): format is GrimmoryFormat => !!format)
    ),
  ];

  return {
    id: String(book.id),
    libraryId:
      book.libraryId !== undefined && book.libraryId !== null
        ? String(book.libraryId)
        : undefined,
    title,
    subtitle: text(book.metadata?.subtitle),
    authors: (book.metadata?.authors ?? []).filter(Boolean),
    series: text(book.metadata?.seriesName)
      ? [text(book.metadata?.seriesName) as string]
      : [],
    isbn: text(book.metadata?.isbn13) ?? text(book.metadata?.isbn10),
    asin: text(book.metadata?.asin),
    formats,
  };
};

/**
 * A book from the app search, which only names the primary file type
 */
export const mapGrimmoryAppBook = (
  book: GrimmoryAppBookResponse
): GrimmoryBook | undefined => {
  const title = text(book.title);

  if (book.id === undefined || book.id === null || !title) {
    return undefined;
  }

  const format = toGrimmoryFormat(book.primaryFileType);

  return {
    id: String(book.id),
    libraryId:
      book.libraryId !== undefined && book.libraryId !== null
        ? String(book.libraryId)
        : undefined,
    title,
    authors: (book.authors ?? []).filter(Boolean),
    series: text(book.seriesName) ? [text(book.seriesName) as string] : [],
    isbn: text(book.isbn13) ?? text(book.isbn10),
    formats: format ? [format] : [],
  };
};

/**
 * Whether a Grimmory user is an admin there
 */
export const isGrimmoryAdmin = (user?: GrimmoryUser | null): boolean =>
  !!user && (user.permissions?.admin === true || user.admin === true);

export interface GrimmoryOptions {
  url: string;
  username?: string;
  password?: string;
  timeout?: number;
}

// Access tokens by server and user, so each call does not sign in again.
// Kept a few minutes at most, and dropped when Grimmory turns one down.
const TOKEN_TTL_MS = 5 * 60 * 1000;
const tokens = new Map<string, { token: string; expires: number }>();

export const clearGrimmoryTokens = (): void => tokens.clear();

class GrimmoryAPI {
  private axios: AxiosInstance;
  private tokenKey: string;

  constructor(private options: GrimmoryOptions) {
    this.axios = axios.create({
      baseURL: options.url.replace(/\/+$/, ''),
      timeout: options.timeout ?? 10000,
    });
    this.axios.interceptors.request.use(proxyRequestInterceptor);
    this.axios.interceptors.request.use(userAgentRequestInterceptor);
    this.tokenKey = `${this.axios.defaults.baseURL}|${options.username ?? ''}`;
  }

  private async login(): Promise<string> {
    const cached = tokens.get(this.tokenKey);

    if (cached && cached.expires > Date.now()) {
      return cached.token;
    }

    if (!this.options.username || !this.options.password) {
      throw new Error('[Grimmory] A username and password are needed');
    }

    const response = await this.axios.post<{ accessToken?: string }>(
      '/api/v1/auth/login',
      { username: this.options.username, password: this.options.password }
    );
    const token = response.data?.accessToken;

    if (!token) {
      throw new Error('[Grimmory] Signing in gave no access token');
    }

    tokens.set(this.tokenKey, { token, expires: Date.now() + TOKEN_TTL_MS });

    return token;
  }

  /**
   * A call with the access token, signing in once more when Grimmory turns
   * a remembered token down
   */
  public async request<T>(config: AxiosRequestConfig): Promise<T> {
    const send = async () =>
      (
        await this.axios.request<T>({
          ...config,
          headers: {
            ...(config.headers ?? {}),
            Authorization: `Bearer ${await this.login()}`,
          },
        })
      ).data;

    try {
      return await send();
    } catch (e) {
      if (isAxiosError(e) && e.response?.status === 401) {
        tokens.delete(this.tokenKey);
        return send();
      }

      throw e;
    }
  }

  /**
   * Signs in and reads the version. The version is only shown in the
   * settings, so a server that does not tell it still passes.
   */
  public async test(): Promise<{ version?: string; user: GrimmoryUser }> {
    const user = await this.request<GrimmoryUser>({
      method: 'get',
      url: '/api/v1/users/me',
    });
    let version: string | undefined;

    try {
      const data = await this.request<unknown>({
        method: 'get',
        url: '/api/v1/version',
      });

      if (typeof data === 'string') {
        version = data;
      } else if (data && typeof data === 'object') {
        const record = data as Record<string, unknown>;
        const value = record.current ?? record.version ?? record.appVersion;
        version = typeof value === 'string' ? value : undefined;
      }
    } catch {
      // See above
    }

    return { version, user };
  }

  public async getLibraries(): Promise<GrimmoryLibrary[]> {
    const libraries = await this.request<GrimmoryLibraryResponse[]>({
      method: 'get',
      url: '/api/v1/libraries',
    });

    return (libraries ?? []).flatMap((library) =>
      library.id !== undefined && library.id !== null
        ? [
            {
              id: String(library.id),
              name: library.name ?? String(library.id),
              formats: [
                ...new Set([
                  ...(library.allowedFormats ?? []),
                  ...(library.paths ?? []).flatMap(
                    (path) => path.allowedFormats ?? []
                  ),
                ]),
              ],
            },
          ]
        : []
    );
  }

  /**
   * Books whose title, author or series contain the query
   */
  public async searchBooks(query: string, size = 10): Promise<GrimmoryBook[]> {
    const data = await this.request<{ content?: GrimmoryAppBookResponse[] }>({
      method: 'get',
      url: '/api/v1/app/books/search',
      params: { q: query, page: 0, size },
    });

    return (data?.content ?? []).flatMap((book) => {
      const mapped = mapGrimmoryAppBook(book);
      return mapped ? [mapped] : [];
    });
  }

  /**
   * Every book the account can see, with the formats of its files
   */
  public async getAllBooks(): Promise<GrimmoryBook[]> {
    const books = await this.request<GrimmoryBookResponse[]>({
      method: 'get',
      url: '/api/v1/books',
      params: { withDescription: false, stripForListView: true },
      timeout: 60000,
    });

    return (books ?? []).flatMap((book) => {
      const mapped = mapGrimmoryBook(book);
      return mapped ? [mapped] : [];
    });
  }
}

export default GrimmoryAPI;
