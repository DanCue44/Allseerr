import type {
  AudiobookVersion,
  AudiobookVersionsMode,
} from '@server/constants/audiobookVersion';
import {
  DEFAULT_AUDIOBOOK_VERSION,
  getAudiobookVersionsMode,
} from '@server/constants/audiobookVersion';
import type { BookService } from '@server/constants/bookService';
import { isTalearrService, usesChaptarr } from '@server/constants/bookService';
import type { User } from '@server/entity/User';
import { getNoBookEndsSyncAppInfo } from '@server/lib/nobookendsSync';
import { Permission } from '@server/lib/permissions';
import type { AudiobookshelfSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { getAppVersion, getCommitTag } from '@server/utils/appVersion';
import { isIP } from 'net';

/**
 * NoBookEnds is a companion app for listening to audiobooks and reading
 * ebooks from Audiobookshelf. Its universal links open the app when it is
 * installed, and otherwise a page on its site with the store links.
 */
export const NOBOOKENDS_OPEN_URL = 'https://nobookends.com/open';

export type NoBookEndsFormat = 'ebook' | 'audiobook';

const trimUrl = (url?: string | null): string | undefined =>
  url?.trim().replace(/\/+$/, '') || undefined;

/**
 * Whether book pages offer to open available books in NoBookEnds. It needs
 * Audiobookshelf's address and its API key, which finds the book's item.
 */
export const isNoBookEndsLinkEnabled = (
  settings: AudiobookshelfSettings
): boolean =>
  !!trimUrl(settings.url) &&
  !!settings.apiKey &&
  settings.showNoBookEnds !== false;

/**
 * Opens an Audiobookshelf library item in NoBookEnds
 */
export const getNoBookEndsItemUrl = (
  audiobookshelfUrl: string,
  itemId: string,
  format: NoBookEndsFormat
): string => {
  const params = new URLSearchParams({
    server: trimUrl(audiobookshelfUrl) ?? audiobookshelfUrl,
    format,
  });

  return `${NOBOOKENDS_OPEN_URL}/item/${encodeURIComponent(
    itemId
  )}?${params.toString()}`;
};

/**
 * The app's own scheme, which the easy connect page hands the key back to
 * from the sign in window the app opened
 */
export const NOBOOKENDS_APP_CONNECT_URL = 'nobookends://connect';

interface NoBookEndsConnectParams {
  audiobookshelfUrl: string;
  allseerrUrl: string;
  apiKey: string;
}

const getNoBookEndsConnectFragment = ({
  audiobookshelfUrl,
  allseerrUrl,
  apiKey,
}: NoBookEndsConnectParams): string =>
  new URLSearchParams({
    abs: trimUrl(audiobookshelfUrl) ?? audiobookshelfUrl,
    allseerr: trimUrl(allseerrUrl) ?? allseerrUrl,
    key: apiKey,
  }).toString();

/**
 * Sets NoBookEnds up in one tap: the Audiobookshelf server to sign in to,
 * and the Allseerr server with the personal key it requests books with. The
 * values go in the fragment, which browsers never send, so the key does not
 * reach the NoBookEnds site or its logs when the app is not installed.
 */
export const getNoBookEndsConnectUrl = (
  params: NoBookEndsConnectParams
): string =>
  `${NOBOOKENDS_OPEN_URL}/connect#${getNoBookEndsConnectFragment(params)}`;

/**
 * The same values as the connect link, for the app's own scheme. The app
 * opens Allseerr in a sign in window that closes when it reaches this URL.
 */
export const getNoBookEndsAppConnectUrl = (
  params: NoBookEndsConnectParams
): string =>
  `${NOBOOKENDS_APP_CONNECT_URL}#${getNoBookEndsConnectFragment(params)}`;

const PRIVATE_IPV4 = [
  /^0\./,
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // Carrier-grade NAT, Tailscale
];
const PRIVATE_SUFFIXES = ['.local', '.lan', '.home', '.internal', '.home.arpa'];

/**
 * Whether a host can only be reached at home: localhost, a private address,
 * a single label name or a local domain. A phone away from home cannot.
 */
export const isPrivateHost = (hostname: string): boolean => {
  const host = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');

  if (!host || host === 'localhost' || host.endsWith('.localhost')) {
    return true;
  }

  const ipVersion = isIP(host);

  if (ipVersion === 4) {
    return PRIVATE_IPV4.some((range) => range.test(host));
  }

  if (ipVersion === 6) {
    const mappedV4 = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);

    return mappedV4
      ? isPrivateHost(mappedV4[1])
      : host === '::1' ||
          host === '::' ||
          /^f[cd]/.test(host) ||
          /^fe[89ab]/.test(host);
  }

  return (
    !host.includes('.') ||
    PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix))
  );
};

/**
 * The Allseerr address the app connects to: the Application URL, or the
 * address Allseerr was opened at when that is reachable from anywhere.
 * Undefined when neither is, and the Application URL must be set first.
 */
export const getNoBookEndsAllseerrUrl = (request: {
  protocol: string;
  hostname: string;
  host?: string;
}): string | undefined => {
  const applicationUrl = trimUrl(getSettings().main.applicationUrl);

  if (applicationUrl) {
    return applicationUrl;
  }

  if (!request.host || isPrivateHost(request.hostname)) {
    return undefined;
  }

  return `${request.protocol}://${request.host}`;
};

/**
 * Whether a user can connect NoBookEnds: books must be requestable and
 * Audiobookshelf linked, since the app reads and listens through it
 */
export const isNoBookEndsAvailable = (): boolean => {
  const settings = getSettings();

  return !!settings.bookService && !!trimUrl(settings.audiobookshelf.url);
};

export type NoBookEndsConnectTarget =
  | { allseerrUrl: string; error?: undefined }
  | { error: 'unavailable' | 'no_app_url'; message: string };

/**
 * The Allseerr address a device connects NoBookEnds to, or why it cannot
 * connect: books or Audiobookshelf are not set up, or there is no address
 * that works away from home. The connect page checks the same.
 */
export const getNoBookEndsConnectTarget = (request: {
  protocol: string;
  hostname: string;
  host?: string;
}): NoBookEndsConnectTarget => {
  if (!isNoBookEndsAvailable()) {
    return {
      error: 'unavailable',
      message: 'Books and Audiobookshelf must be set up first.',
    };
  }

  const allseerrUrl = getNoBookEndsAllseerrUrl(request);

  if (!allseerrUrl) {
    return {
      error: 'no_app_url',
      message:
        'Set the Application URL in the General settings first, so the app can reach Allseerr away from home.',
    };
  }

  return { allseerrUrl };
};

/**
 * Opens NoBookEnds at its sign in with this Allseerr's address filled in,
 * or the NoBookEnds site when the app is not installed
 */
export const getNoBookEndsSignInUrl = (allseerrUrl: string): string =>
  `${NOBOOKENDS_OPEN_URL}/signin?allseerr=${encodeURIComponent(
    trimUrl(allseerrUrl) ?? allseerrUrl
  )}`;

/**
 * A request quota as the app shows it: how many requests are allowed in
 * how many days (null days counts every request ever made)
 */
export interface NoBookEndsQuota {
  limit: number;
  days: number | null;
  used: number;
  remaining: number;
  restricted: boolean;
}

/**
 * The user's book quota, from the same count the request endpoint enforces.
 * Null when the user may request without a limit. Ebook and audiobook
 * requests share the quota, a book requested in both formats counts twice.
 */
export const getNoBookEndsQuota = async (
  user: User
): Promise<NoBookEndsQuota | null> => {
  const { book } = await user.getQuota();

  if (!book.limit) {
    return null;
  }

  return {
    limit: book.limit,
    days: book.days || null,
    used: book.used,
    remaining: book.remaining ?? Math.max(0, book.limit - book.used),
    restricted: book.restricted,
  };
};

export interface NoBookEndsStatus {
  version: string;
  commitTag: string;
  applicationTitle: string;
  user: { id: number; displayName: string };
  books: {
    enabled: boolean;
    // Where book requests go, null while books are off
    service: BookService | null;
    canRequest: boolean;
    autoApprove: boolean;
    defaultFormat: 'ebook' | 'audiobook' | 'both';
    quota: NoBookEndsQuota | null;
    // Whether other recordings of an audiobook can be requested, which
    // only Talearr offers
    recordings: boolean;
    // Talearr only: the Audiobook Versions setting, and the version an
    // audiobook request picks first when the requester may choose one
    audiobookVersions?: AudiobookVersionsMode;
    defaultAudiobookVersion?: AudiobookVersion;
  };
  issues: { canCreate: boolean };
  // Whether the user may approve, decline and edit everyone's requests
  requests: { canManage: boolean };
  // Whether the user may see and fix book downloads Chaptarr is stuck on
  downloads: { canManage: boolean };
  audiobookshelf: {
    configured: boolean;
    url: string | null;
    itemLinks: boolean;
  };
  openInNoBookEnds: boolean;
  // The NoBookEnds Sync server the apps fetch Listen and Read alignments
  // from, only while it is enabled and reachable. proxyPath is set when
  // Allseerr serves it: the app joins it to the Allseerr address it uses.
  nobookendsSync?: { url?: string; proxyPath?: string };
}

/**
 * What the app may offer this user, so it can hide what is turned off
 */
export const getNoBookEndsStatus = async (
  user: User
): Promise<NoBookEndsStatus> => {
  const settings = getSettings();
  const audiobookshelf = settings.audiobookshelf;
  const audiobookshelfUrl = trimUrl(audiobookshelf.url) ?? null;
  const booksEnabled = !!settings.bookService;
  const canManageRequests = user.hasPermission(Permission.MANAGE_REQUESTS);
  const syncInfo = getNoBookEndsSyncAppInfo(
    settings.nobookendsSync,
    settings.main.applicationUrl
  );
  const audiobookVersions = getAudiobookVersionsMode(
    settings.bookService,
    settings.main.audiobookVersions
  );

  return {
    version: getAppVersion(),
    commitTag: getCommitTag(),
    applicationTitle: settings.main.applicationTitle,
    user: { id: user.id, displayName: user.displayName },
    books: {
      enabled: booksEnabled,
      service: settings.bookService ?? null,
      canRequest:
        booksEnabled &&
        user.hasPermission([Permission.REQUEST, Permission.REQUEST_BOOK], {
          type: 'or',
        }),
      autoApprove:
        booksEnabled &&
        user.hasPermission(
          [Permission.AUTO_APPROVE, Permission.MANAGE_REQUESTS],
          {
            type: 'or',
          }
        ),
      defaultFormat: settings.main.defaultBookFormat ?? 'both',
      quota: booksEnabled ? await getNoBookEndsQuota(user) : null,
      recordings: isTalearrService(settings.bookService),
      ...(audiobookVersions
        ? {
            audiobookVersions,
            defaultAudiobookVersion: DEFAULT_AUDIOBOOK_VERSION,
          }
        : {}),
    },
    issues: {
      canCreate: user.hasPermission(
        [Permission.CREATE_ISSUES, Permission.MANAGE_ISSUES],
        { type: 'or' }
      ),
    },
    requests: {
      canManage: canManageRequests,
    },
    downloads: {
      // Only a Chaptarr or Talearr queue can be read for stuck downloads
      canManage: canManageRequests && usesChaptarr(settings.bookService),
    },
    audiobookshelf: {
      configured: !!audiobookshelfUrl,
      url: audiobookshelfUrl,
      itemLinks: !!audiobookshelfUrl && !!audiobookshelf.apiKey,
    },
    openInNoBookEnds: isNoBookEndsLinkEnabled(audiobookshelf),
    ...(syncInfo ? { nobookendsSync: syncInfo } : {}),
  };
};
