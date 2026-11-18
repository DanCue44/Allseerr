import ChaptarrAPI from '@server/api/servarr/chaptarr';
import type {
  TalearrComicDiscoverList,
  TalearrComicLibraryVolume,
  TalearrComicLookupResponse,
  TalearrComicLookupResult,
  TalearrComicPreview,
  TalearrComicPreviewVolume,
  TalearrComicRootFolder,
  TalearrComicSeriesSummary,
} from '@server/api/servarr/talearrComics';
import TalearrComicsAPI from '@server/api/servarr/talearrComics';
import { isTalearrService } from '@server/constants/bookService';
import type { ComicKind } from '@server/constants/media';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import MediaRequest from '@server/entity/MediaRequest';
import MetadataComic from '@server/entity/MetadataComic';
import type { ChaptarrSettings } from '@server/lib/settings';
import { getDefaultChaptarr, getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import type {
  ComicLibraryInfo,
  ComicVolumeInfo,
  ComicVolumeState,
} from '@server/models/Comic';
import { COMIC_VOLUME_STATES } from '@server/models/Comic';
import type { ComicResult } from '@server/models/Search';
import { truncate } from 'lodash';
import { In } from 'typeorm';

// How long the answer to whether comics are on is kept. The comics pages
// and the search ask on every load.
const STATUS_TTL_MS = 60_000;
// A failed answer is asked again sooner, so a restarted Talearr shows up
const STATUS_ERROR_TTL_MS = 15_000;

/**
 * Whether comics can be requested, and why not when they cannot
 */
export interface ComicsStatus {
  enabled: boolean;
  reason?: 'notTalearr' | 'noServer' | 'unavailable';
  message?: string;
}

/**
 * Comic ids: al-<AniList id> for series AniList knows, as most manga, and
 * hc-<Hardcover series id> for the rest. AniList wins when a series has both,
 * as Talearr matches series on it first.
 */
export const comicIdOf = (series: {
  aniListId?: number | null;
  hardcoverSeriesId?: number | null;
}): string | undefined =>
  series.aniListId
    ? `al-${series.aniListId}`
    : series.hardcoverSeriesId
      ? `hc-${series.hardcoverSeriesId}`
      : undefined;

const COMIC_ID_REGEX = /^(al|hc)-([1-9][0-9]{0,9})$/;

export const isComicId = (value: unknown): value is string =>
  typeof value === 'string' && COMIC_ID_REGEX.test(value);

export const parseComicId = (
  comicId: string
): { aniListId?: number; hardcoverSeriesId?: number } | undefined => {
  const match = COMIC_ID_REGEX.exec(comicId);

  if (!match) {
    return undefined;
  }

  const id = Number(match[2]);
  return match[1] === 'al' ? { aniListId: id } : { hardcoverSeriesId: id };
};

/**
 * The Talearr server comics go to: the default book server, only while book
 * requests go to Talearr
 */
export const getComicsServer = (): ChaptarrSettings | undefined => {
  const settings = getSettings();

  return isTalearrService(settings.bookService)
    ? getDefaultChaptarr(settings.chaptarr)
    : undefined;
};

export const getComicsApi = (server: ChaptarrSettings): TalearrComicsAPI =>
  new TalearrComicsAPI({
    apiKey: server.apiKey,
    url: ChaptarrAPI.buildUrl(server, '/api/v1'),
  });

let cachedStatus: { status: ComicsStatus; until: number; key: string } | null =
  null;

export const resetComicsStatusCache = (): void => {
  cachedStatus = null;
};

/**
 * Whether comics are on: book requests go to Talearr and Talearr's comics
 * library answers. Kept for a minute, see STATUS_TTL_MS.
 */
export const getComicsStatus = async (): Promise<ComicsStatus> => {
  const settings = getSettings();

  if (!isTalearrService(settings.bookService)) {
    return { enabled: false, reason: 'notTalearr' };
  }

  const server = getComicsServer();

  if (!server) {
    return { enabled: false, reason: 'noServer' };
  }

  // A changed server is asked again at once
  const key = `${server.id}:${server.hostname}:${server.port}`;
  if (
    cachedStatus &&
    cachedStatus.key === key &&
    cachedStatus.until > Date.now()
  ) {
    return cachedStatus.status;
  }

  let status: ComicsStatus;
  try {
    const answer = await getComicsApi(server).getStatus();
    status = answer.available
      ? { enabled: true }
      : { enabled: false, reason: 'unavailable', message: answer.reason };
  } catch (e) {
    status = {
      enabled: false,
      reason: 'unavailable',
      message: e instanceof Error ? e.message : String(e),
    };
  }

  cachedStatus = {
    status,
    key,
    until: Date.now() + (status.enabled ? STATUS_TTL_MS : STATUS_ERROR_TTL_MS),
  };

  return status;
};

const toMetadata = (
  comicId: string,
  result: TalearrComicLookupResult
): MetadataComic =>
  new MetadataComic({
    comicId,
    kind: result.kind,
    title: result.title,
    alternateTitles: result.alternateTitles.length
      ? result.alternateTitles
      : null,
    year: result.year ?? null,
    status: result.status ?? null,
    volumes: result.volumes ?? null,
    authors: result.authors ?? null,
    overview: result.overview ?? null,
    coverUrl: result.coverUrl ?? null,
    ageRating: result.ageRating ?? null,
    isAdult: result.isAdult,
    aniListId: result.aniListId ?? null,
    hardcoverSeriesId: result.hardcoverSeriesId ?? null,
  });

/**
 * Keeps what the lookup said about each series, so its page can be shown
 * later. Talearr has no lookup by id.
 */
export const saveComicMetadata = async (
  results: TalearrComicLookupResult[]
): Promise<MetadataComic[]> => {
  const repository = getRepository(MetadataComic);
  const byId = new Map<string, TalearrComicLookupResult>();

  results.forEach((result) => {
    const comicId = comicIdOf(result);
    if (comicId && !byId.has(comicId)) {
      byId.set(comicId, result);
    }
  });

  if (byId.size === 0) {
    return [];
  }

  const existing = await repository.find({
    where: { comicId: In([...byId.keys()]) },
  });
  const existingById = new Map(existing.map((row) => [row.comicId, row]));

  const rows = [...byId.entries()].map(([comicId, result]) => {
    const row = toMetadata(comicId, result);
    const saved = existingById.get(comicId);

    if (saved) {
      row.id = saved.id;
      row.createdAt = saved.createdAt;
    }

    return row;
  });

  return repository.save(rows);
};

export const mapComicResult = (
  metadata: MetadataComic,
  media?: Media,
  library?: TalearrComicSeriesSummary
): ComicResult => ({
  id: metadata.comicId,
  mediaType: 'comic',
  kind: metadata.kind,
  title: metadata.title,
  authors: metadata.authors ?? undefined,
  year: metadata.year ?? undefined,
  volumes: metadata.volumes ?? undefined,
  ageRating: metadata.ageRating ?? undefined,
  isAdult: metadata.isAdult,
  posterPath: metadata.coverUrl,
  mediaInfo: media,
  library: library ? toLibraryInfo(library) : undefined,
});

/**
 * Finds a series in Talearr's library, matched on the ids it was added with
 */
// Titles and names compared without case, accents or punctuation
export const normalizeComicTitle = (title: string): string =>
  title
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const nameTokens = (names?: string | null): Set<string> =>
  new Set(
    normalizeComicTitle(names ?? '')
      .split(' ')
      .filter((token) => token.length > 1)
  );

// Authors agree when they share a name, or when one side names nobody
const authorsAgree = (a?: string | null, b?: string | null): boolean => {
  const first = nameTokens(a);
  const second = nameTokens(b);

  return (
    first.size === 0 ||
    second.size === 0 ||
    [...first].some((token) => second.has(token))
  );
};

/**
 * Talearr's lookup can find a series twice: from AniList as manga and from
 * Hardcover on its own. A Hardcover only result with the title and authors
 * of an AniList result is the same series, so it is dropped, and its
 * Hardcover id and cover go to the AniList result when that has none.
 */
export const dropHardcoverDuplicates = (
  results: TalearrComicLookupResult[]
): TalearrComicLookupResult[] => {
  const aniList = results
    .filter((result) => !!result.aniListId)
    .map((result) => ({ ...result }));

  const titlesOf = (result: TalearrComicLookupResult) =>
    new Set(
      [result.title, ...result.alternateTitles]
        .map(normalizeComicTitle)
        .filter(Boolean)
    );
  const aniListTitles = aniList.map(titlesOf);

  const rest = results.filter((result) => {
    if (result.aniListId) {
      return false;
    }

    const title = normalizeComicTitle(result.title);
    const index = aniList.findIndex(
      (candidate, i) =>
        aniListTitles[i].has(title) &&
        authorsAgree(candidate.authors, result.authors)
    );

    if (index < 0) {
      return true;
    }

    const match = aniList[index];
    match.hardcoverSeriesId =
      match.hardcoverSeriesId ?? result.hardcoverSeriesId;
    match.coverUrl = match.coverUrl ?? result.coverUrl;
    return false;
  });

  // AniList results keep their place among the others
  const merged = new Map(aniList.map((result) => [result.aniListId, result]));
  return results
    .filter((result) => !!result.aniListId || rest.includes(result))
    .map((result) =>
      result.aniListId ? (merged.get(result.aniListId) ?? result) : result
    );
};

/**
 * Finds a series in Talearr's library: on the ids it was added with, the
 * AniList or Hardcover id the facts know, and failing those its title
 */
export const findLibrarySeries = (
  library: TalearrComicSeriesSummary[],
  comicId: string,
  metadata?: Pick<
    MetadataComic,
    'title' | 'aniListId' | 'hardcoverSeriesId'
  > | null
): TalearrComicSeriesSummary | undefined => {
  const ids = parseComicId(comicId);

  if (!ids) {
    return undefined;
  }

  const aniListId = ids.aniListId ?? metadata?.aniListId ?? undefined;
  const hardcoverSeriesId =
    ids.hardcoverSeriesId ?? metadata?.hardcoverSeriesId ?? undefined;
  const title = metadata?.title ? normalizeComicTitle(metadata.title) : '';

  return (
    library.find(
      (summary) =>
        (!!aniListId && summary.series.aniListId === aniListId) ||
        (!!hardcoverSeriesId &&
          summary.series.hardcoverSeriesId === hardcoverSeriesId)
    ) ??
    (title
      ? library.find(
          (summary) =>
            !!summary.series.title &&
            normalizeComicTitle(summary.series.title) === title
        )
      : undefined)
  );
};

export const toLibraryInfo = (
  summary: TalearrComicSeriesSummary
): ComicLibraryInfo => ({
  seriesId: summary.series.id,
  volumeCount: summary.volumeCount,
  downloadedCount: summary.downloadedCount,
  missingCount: summary.missingCount,
  downloadingCount: summary.downloadingCount,
  status: getLibraryStatus(summary),
});

/**
 * Search results for saved series, with their request status and what
 * Talearr's library holds of them
 */
export const mapComicResults = async (
  rows: MetadataComic[],
  mediaFor?: (media: Media) => Media
): Promise<ComicResult[]> => {
  const [media, library] = await Promise.all([
    Media.getRelatedComics(rows.map((row) => row.comicId)),
    getLibrarySeries(),
  ]);
  const mediaById = new Map(media.map((m) => [m.comicId, m]));

  return rows.map((row) => {
    const item = mediaById.get(row.comicId);

    return mapComicResult(
      row,
      item && mediaFor ? mediaFor(item) : item,
      findLibrarySeries(library, row.comicId, row)
    );
  });
};

// How long Talearr's series list is kept for the search and the pages
const LIBRARY_TTL_MS = 30_000;

let cachedLibrary: {
  series: Promise<TalearrComicSeriesSummary[]>;
  until: number;
  key: string;
} | null = null;

export const resetComicsLibraryCache = (): void => {
  cachedLibrary = null;
};

/**
 * Talearr's comics library, kept for half a minute so searches and pages
 * do not ask for it each time. Empty when it cannot be read.
 */
export const getLibrarySeries = async (): Promise<
  TalearrComicSeriesSummary[]
> => {
  const server = getComicsServer();

  if (!server) {
    return [];
  }

  const key = `${server.id}:${server.hostname}:${server.port}`;
  if (
    !cachedLibrary ||
    cachedLibrary.key !== key ||
    cachedLibrary.until <= Date.now()
  ) {
    cachedLibrary = {
      key,
      until: Date.now() + LIBRARY_TTL_MS,
      series: getComicsApi(server)
        .getSeries()
        .catch((e) => {
          logger.debug('Could not read the Talearr comics library', {
            label: 'Comics',
            errorMessage: e instanceof Error ? e.message : String(e),
          });
          // A failed read is tried again on the next call
          cachedLibrary = null;
          return [];
        }),
    };
  }

  return cachedLibrary.series;
};

/**
 * Whether Talearr has every volume of a series, which then needs no request
 */
export const hasEveryVolume = (summary: TalearrComicSeriesSummary): boolean =>
  summary.volumeCount > 0 && summary.downloadedCount >= summary.volumeCount;

export const getLibraryStatus = (
  summary: TalearrComicSeriesSummary
): MediaStatus =>
  summary.volumeCount > 0 && summary.downloadedCount >= summary.volumeCount
    ? MediaStatus.AVAILABLE
    : summary.downloadedCount > 0
      ? MediaStatus.PARTIALLY_AVAILABLE
      : MediaStatus.PROCESSING;

// Statuses a requested series is followed in, until every volume is in
const FOLLOWED_STATUSES = [
  MediaStatus.PENDING,
  MediaStatus.PROCESSING,
  MediaStatus.PARTIALLY_AVAILABLE,
];

/**
 * Moves a requested series on to partly or fully available once Talearr
 * has its volumes, never back. Answers whether the media changed. The media
 * subscriber completes the requests once every volume is in.
 */
export const applyLibraryStatus = async (
  media: Media,
  summary: TalearrComicSeriesSummary
): Promise<boolean> => {
  const status = getLibraryStatus(summary);

  if (
    !FOLLOWED_STATUSES.includes(media.status) ||
    status === media.status ||
    status === MediaStatus.PROCESSING
  ) {
    return false;
  }

  // Saved without its requests, so the save does not cascade into them
  const repository = getRepository(Media);
  const plain = await repository.findOneOrFail({ where: { id: media.id } });
  plain.status = status;
  plain.externalServiceId = plain.externalServiceId ?? summary.series.id;
  await repository.save(plain);

  return true;
};

/**
 * Follows the requested series in Talearr's library, as part of the
 * Chaptarr scan. Answers how many changed.
 */
export const syncComicAvailability = async (): Promise<number> => {
  const server = getComicsServer();

  if (!server) {
    return 0;
  }

  const media = await getRepository(Media).find({
    where: { mediaType: MediaType.COMIC, status: In(FOLLOWED_STATUSES) },
  });

  if (media.length === 0) {
    return 0;
  }

  const library = await getComicsApi(server).getSeries();
  const metadata = await getRepository(MetadataComic).find({
    where: {
      comicId: In(
        media.map((item) => item.comicId).filter((id): id is string => !!id)
      ),
    },
  });
  const metadataById = new Map(metadata.map((row) => [row.comicId, row]));
  let changed = 0;

  for (const item of media) {
    const summary = item.comicId
      ? findLibrarySeries(library, item.comicId, metadataById.get(item.comicId))
      : undefined;

    if (summary && (await applyLibraryStatus(item, summary))) {
      changed++;
    }

    if (summary) {
      changed += await completeVolumeRequests(item, summary);
    }
  }

  return changed;
};

/**
 * Completes the requests of some volumes of a series once Talearr has every
 * volume they asked for. A request of the whole series completes with the
 * series. Answers how many it completed.
 */
export const completeVolumeRequests = async (
  media: Media,
  summary: TalearrComicSeriesSummary
): Promise<number> => {
  const repository = getRepository(MediaRequest);
  const requests = (
    await repository.find({
      where: {
        media: { id: media.id },
        type: MediaType.COMIC,
        status: MediaRequestStatus.APPROVED,
      },
    })
  ).filter((request) => !!request.comicVolumes?.length);

  if (requests.length === 0) {
    return 0;
  }

  const downloaded = new Set(
    (await getLibraryVolumes(summary.series.id))
      .filter((volume) => volume.state === 'downloaded')
      .map((volume) => volume.number)
  );
  let completed = 0;

  for (const request of requests) {
    if (
      (request.comicVolumes ?? []).every((number) => downloaded.has(number))
    ) {
      request.status = MediaRequestStatus.COMPLETED;
      await repository.save(request);
      completed++;
    }
  }

  return completed;
};

const kindMatches = (folder: TalearrComicRootFolder, kind: ComicKind) =>
  folder.kind?.toLowerCase() === kind || folder.kind?.toLowerCase() === 'any';

/**
 * The comics root folder a series is filed in. A folder of the series' kind
 * beats one for any kind. A person with an age limit gets the kids library
 * when there is one, everyone else the main library.
 */
export const pickComicRootFolder = (
  folders: TalearrComicRootFolder[],
  kind: ComicKind,
  { preferKids = false }: { preferKids?: boolean } = {}
): TalearrComicRootFolder | undefined => {
  const candidates = folders.filter((folder) => kindMatches(folder, kind));
  const rank = (folder: TalearrComicRootFolder) =>
    (folder.isKids === preferKids ? 0 : 2) +
    (folder.kind?.toLowerCase() === kind ? 0 : 1);

  return [...candidates].sort((a, b) => rank(a) - rank(b))[0];
};

// How long a comics lookup answer is kept: Talearr asks AniList and
// Hardcover, which take seconds and whose series change slowly. Whether a
// series is in the library is read separately, so it is never stale here.
const LOOKUP_TTL_MS = 15 * 60_000;
// An answer with notices (a metadata source down or rate limited) is asked
// again sooner
const LOOKUP_NOTICE_TTL_MS = 60_000;
// Lookups kept at most; the oldest is dropped first
const LOOKUP_CACHE_SIZE = 200;

const lookupCache = new Map<
  string,
  { until: number; answer: Promise<TalearrComicLookupResponse> }
>();

export const resetComicsLookupCache = (): void => {
  lookupCache.clear();
};

/**
 * One Talearr comics lookup, kept for a while so the same search typed again
 * (or the page reloaded) does not wait on AniList and Hardcover again. A
 * failed lookup is not kept.
 */
const cachedLookup = (
  server: ChaptarrSettings,
  query: string,
  kind: ComicKind
): Promise<TalearrComicLookupResponse> => {
  const key = `${server.id}:${server.hostname}:${server.port}:${kind}:${query
    .trim()
    .toLowerCase()}`;
  const cached = lookupCache.get(key);

  if (cached && cached.until > Date.now()) {
    return cached.answer;
  }

  const entry = {
    until: Date.now() + LOOKUP_TTL_MS,
    answer: Promise.resolve<TalearrComicLookupResponse>({
      results: [],
      notices: [],
    }),
  };

  entry.answer = getComicsApi(server)
    .lookup(query, kind)
    .then((answer) => {
      if (answer.notices.length > 0) {
        entry.until = Date.now() + LOOKUP_NOTICE_TTL_MS;
      }

      return answer;
    })
    .catch((e) => {
      lookupCache.delete(key);
      throw e;
    });

  lookupCache.delete(key);
  lookupCache.set(key, entry);

  if (lookupCache.size > LOOKUP_CACHE_SIZE) {
    const oldest = lookupCache.keys().next().value;

    if (oldest !== undefined) {
      lookupCache.delete(oldest);
    }
  }

  return entry.answer;
};

/**
 * Searches Talearr for comic or manga series. Without a kind both are
 * searched and mixed. Talearr searches Hardcover the same way for both
 * kinds, so a series only Hardcover knows comes back twice; it is kept as a
 * comic, and the person requesting it can file it as manga instead. Series
 * from AniList are manga.
 */
export const searchComics = async ({
  query,
  kind,
}: {
  query: string;
  kind?: ComicKind;
}): Promise<{ results: MetadataComic[]; notices: string[] }> => {
  const server = getComicsServer();

  if (!server) {
    return { results: [], notices: [] };
  }

  const kinds: ComicKind[] = kind ? [kind] : ['manga', 'comic'];
  const answers = await Promise.all(
    kinds.map((each) =>
      cachedLookup(server, query, each).catch((e) => {
        logger.debug('Talearr comics lookup failed', {
          label: 'Comics',
          kind: each,
          errorMessage: e instanceof Error ? e.message : String(e),
        });
        return { results: [], notices: [] };
      })
    )
  );

  const results = dropHardcoverDuplicates(
    answers.flatMap((answer) => answer.results)
  );
  const ordered = kind
    ? results
    : [
        ...results.filter((result) => !!result.aniListId),
        ...results.filter(
          (result) => !result.aniListId && result.kind === 'comic'
        ),
        ...results.filter(
          (result) => !result.aniListId && result.kind !== 'comic'
        ),
      ];
  const saved = await saveComicMetadata(ordered);

  return {
    results: saved,
    notices: [...new Set(answers.flatMap((answer) => answer.notices))],
  };
};

// How long a discover list is kept: Talearr builds it from AniList and
// Hardcover, whose lists change through the day at most
const DISCOVER_TTL_MS = 60 * 60_000;
// An empty or incomplete list (a Talearr without discover lists, or one cut
// short by a rate limit) is asked again sooner
const DISCOVER_EMPTY_TTL_MS = 10 * 60_000;

export interface ComicDiscoverPage {
  results: MetadataComic[];
  notices: string[];
}

const discoverCache = new Map<
  string,
  { until: number; page: Promise<ComicDiscoverPage> }
>();

export const resetComicsDiscoverCache = (): void => {
  discoverCache.clear();
};

/**
 * One page of a Talearr discover list, its series saved like search
 * results so their pages can be shown. Kept for an hour, see
 * DISCOVER_TTL_MS. Empty when Talearr has no discover lists.
 */
export const discoverComics = async (
  list: TalearrComicDiscoverList,
  page = 1
): Promise<ComicDiscoverPage> => {
  const server = getComicsServer();

  if (!server) {
    return { results: [], notices: [] };
  }

  const key = `${server.id}:${server.hostname}:${server.port}:${list}:${page}`;
  const cached = discoverCache.get(key);

  if (cached && cached.until > Date.now()) {
    return cached.page;
  }

  const entry = {
    until: Date.now() + DISCOVER_TTL_MS,
    page: Promise.resolve<ComicDiscoverPage>({ results: [], notices: [] }),
  };

  entry.page = getComicsApi(server)
    .discover(list, page)
    .then(async (answer) => {
      const saved = await saveComicMetadata(
        dropHardcoverDuplicates(answer?.results ?? [])
      );

      // An empty list, or one Talearr says is incomplete (a rate limit cut it
      // short, say), is asked again sooner
      if (saved.length === 0 || (answer?.notices ?? []).length > 0) {
        entry.until = Date.now() + DISCOVER_EMPTY_TTL_MS;
      }

      return { results: saved, notices: answer?.notices ?? [] };
    })
    .catch((e) => {
      // A failed list is asked again on the next call
      discoverCache.delete(key);
      throw e;
    });
  discoverCache.set(key, entry);

  return entry.page;
};

/**
 * Takes turns between lists, so a row mixing manga and comics shows both
 * from the start. A series in more than one list is kept once.
 */
export const interleaveComics = (lists: MetadataComic[][]): MetadataComic[] => {
  const seen = new Set<string>();
  const mixed: MetadataComic[] = [];
  const longest = Math.max(0, ...lists.map((list) => list.length));

  for (let i = 0; i < longest; i++) {
    for (const list of lists) {
      const row = list[i];

      if (row && !seen.has(row.comicId)) {
        seen.add(row.comicId);
        mixed.push(row);
      }
    }
  }

  return mixed;
};

// How long a series preview is kept: its facts and volume list change a
// few times a month at most
const PREVIEW_TTL_MS = 6 * 60 * 60_000;
// An id Talearr does not know, or a Talearr without previews, is asked
// again sooner, so an updated Talearr shows them
const PREVIEW_MISS_TTL_MS = 30 * 60_000;
// A partial preview, from a source that was down, is asked again soon
const PREVIEW_PARTIAL_TTL_MS = 10 * 60_000;

const previewCache = new Map<
  string,
  { until: number; preview: Promise<TalearrComicPreview | undefined> }
>();

export const resetComicsPreviewCache = (): void => {
  previewCache.clear();
};

/**
 * What the metadata sources say of a series and its volumes, through
 * Talearr's preview. Kept for six hours, see PREVIEW_TTL_MS. Undefined when
 * Talearr does not know the id, has no previews, as older Talearr does
 * not, cannot reach its sources (503) or cannot be reached: the page then
 * shows the saved facts. Only a failure is not kept.
 */
export const getComicPreview = async (
  comicId: string,
  kind?: ComicKind
): Promise<TalearrComicPreview | undefined> => {
  const server = getComicsServer();
  const ids = parseComicId(comicId);

  if (!server || !ids) {
    return undefined;
  }

  const key = `${server.id}:${server.hostname}:${server.port}:${comicId}:${
    kind ?? ''
  }`;
  const cached = previewCache.get(key);

  if (cached && cached.until > Date.now()) {
    return cached.preview;
  }

  const entry = {
    until: Date.now() + PREVIEW_TTL_MS,
    preview: Promise.resolve<TalearrComicPreview | undefined>(undefined),
  };

  entry.preview = getComicsApi(server)
    .preview({ ...ids, kind })
    .then((answer) => {
      if (answer.found) {
        if (answer.preview.notices.length > 0) {
          entry.until = Date.now() + PREVIEW_PARTIAL_TTL_MS;
        }
        return answer.preview;
      }

      entry.until = Date.now() + PREVIEW_MISS_TTL_MS;
      logger.debug(
        answer.unsupported
          ? 'This Talearr has no comics preview'
          : 'Talearr does not know this series',
        { label: 'Comics', comicId }
      );
      return undefined;
    })
    .catch((e) => {
      // A failed preview is asked again on the next call
      if (previewCache.get(key) === entry) {
        previewCache.delete(key);
      }
      logger.debug('Talearr comics preview failed', {
        label: 'Comics',
        comicId,
        errorMessage: e instanceof Error ? e.message : String(e),
      });
      return undefined;
    });
  previewCache.set(key, entry);

  return entry.preview;
};

/**
 * Keeps what a preview adds to the saved facts of a series, so lists,
 * requests and notifications show it too. Answers the facts, changed or
 * not; they are only saved when something changed. The kind and ids stay as
 * the search saved them, and an age rating already known is kept, as the
 * requests are checked against it.
 */
export const applyComicPreview = async (
  metadata: MetadataComic,
  preview: TalearrComicPreview
): Promise<MetadataComic> => {
  const changes: Partial<MetadataComic> = {};
  const keep = <K extends keyof MetadataComic>(
    key: K,
    value: MetadataComic[K] | null | undefined
  ) => {
    if (value !== null && value !== undefined && metadata[key] !== value) {
      changes[key] = value;
    }
  };

  keep('overview', preview.overview);
  keep('year', preview.year);
  keep('status', preview.status);
  keep('authors', preview.authors);
  keep('volumes', preview.volumeCount);

  if (!metadata.coverUrl) {
    keep('coverUrl', preview.coverUrl);
  }

  if (
    preview.alternateTitles.length > 0 &&
    JSON.stringify(preview.alternateTitles) !==
      JSON.stringify(metadata.alternateTitles ?? [])
  ) {
    changes.alternateTitles = preview.alternateTitles;
  }

  if (
    (!metadata.ageRating || metadata.ageRating === 'Unknown') &&
    preview.ageRating &&
    preview.ageRating !== 'Unknown'
  ) {
    changes.ageRating = preview.ageRating;
  }

  if (preview.isAdult && !metadata.isAdult) {
    changes.isAdult = true;
  }

  if (Object.keys(changes).length === 0) {
    return metadata;
  }

  Object.assign(metadata, changes);

  return getRepository(MetadataComic).save(metadata);
};

/**
 * The volumes of a series in Talearr's library, with what Talearr has of
 * each. Empty when they cannot be read.
 */
export const getLibraryVolumes = async (
  seriesId: number
): Promise<TalearrComicLibraryVolume[]> => {
  const server = getComicsServer();

  if (!server) {
    return [];
  }

  return getComicsApi(server)
    .getSeriesVolumes(seriesId)
    .catch((e) => {
      logger.debug('Could not read the volumes of a Talearr series', {
        label: 'Comics',
        seriesId,
        errorMessage: e instanceof Error ? e.message : String(e),
      });
      return [];
    });
};

const asVolumeState = (state?: string | null): ComicVolumeState | undefined =>
  COMIC_VOLUME_STATES.find((known) => known === state);

/**
 * The volume list of a series page: the volumes the metadata sources list,
 * each marked with what Talearr has of it when the series is in the
 * library. Without a preview, the volumes Talearr's library lists.
 */
export const buildComicVolumeList = (
  previewVolumes: TalearrComicPreviewVolume[],
  libraryVolumes: TalearrComicLibraryVolume[] = []
): ComicVolumeInfo[] => {
  const libraryByNumber = new Map(
    libraryVolumes.map((volume) => [volume.number, volume])
  );
  const source = previewVolumes.length > 0 ? previewVolumes : libraryVolumes;
  const seen = new Set<number>();

  return source
    .filter((volume) => {
      if (seen.has(volume.number)) {
        return false;
      }
      seen.add(volume.number);
      return true;
    })
    .map((volume) => {
      const inLibrary = libraryByNumber.get(volume.number);

      return {
        number: volume.number,
        title: volume.title ?? inLibrary?.title ?? undefined,
        releaseDate: volume.releaseDate ?? inLibrary?.releaseDate ?? undefined,
        coverUrl: volume.coverUrl ?? inLibrary?.coverUrl ?? undefined,
        ...('pages' in volume
          ? {
              pages: volume.pages ?? undefined,
              description: volume.description ?? undefined,
              hardcoverUrl: volume.hardcoverUrl ?? undefined,
            }
          : {}),
        state: asVolumeState(inLibrary?.state),
      };
    })
    .sort((a, b) => a.number - b.number);
};

export interface ComicNotificationDetails {
  subject: string;
  message?: string;
  image?: string;
  ageRating?: string;
}

// AniList descriptions carry simple markup, such as <br> and <i>
export const comicPlainText = (text: string): string =>
  text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

/**
 * Builds the subject, message and cover of a comic notification from what
 * the lookup saved of the series
 */
export const getComicNotificationDetails = async (
  comicId: string
): Promise<ComicNotificationDetails> => {
  const metadata = await getRepository(MetadataComic).findOne({
    where: { comicId },
  });

  if (!metadata) {
    return { subject: comicId };
  }

  const overview = metadata.overview ? comicPlainText(metadata.overview) : '';

  return {
    subject: `${metadata.title}${
      metadata.authors ? ` by ${metadata.authors}` : ''
    }${metadata.year ? ` (${metadata.year})` : ''}`,
    message: overview
      ? truncate(overview, { length: 500, separator: /\s/, omission: '…' })
      : undefined,
    image: metadata.coverUrl ?? undefined,
    ageRating:
      metadata.ageRating && metadata.ageRating !== 'Unknown'
        ? metadata.ageRating
        : undefined,
  };
};

/**
 * Adds a requested series to Talearr's comics library and has Talearr
 * search for its volumes: every volume, or only the volumes asked for.
 * Talearr searches by itself when its comics settings say so, so it is only
 * asked to when they do not. A series Talearr has already gets the volumes
 * asked for, or every missing volume. Answers Talearr's id of the series.
 */
export const sendComicToTalearr = async (
  server: ChaptarrSettings,
  {
    comicId,
    kind,
    preferKids = false,
    volumes,
  }: {
    comicId: string;
    kind: ComicKind;
    preferKids?: boolean;
    // The volume numbers asked for. None asks for the whole series.
    volumes?: number[] | null;
  }
): Promise<{ seriesId: number; alreadyInLibrary: boolean }> => {
  const ids = parseComicId(comicId);

  if (!ids) {
    throw new Error(`Unknown comic id ${comicId}`);
  }

  const api = getComicsApi(server);
  const library = await api.getSeries();
  const metadata = await getRepository(MetadataComic).findOne({
    where: { comicId },
  });
  const existing = findLibrarySeries(library, comicId, metadata);
  const someVolumes = volumes && volumes.length > 0 ? volumes : undefined;

  if (existing) {
    resetComicsLibraryCache();
    const seriesId = existing.series.id;

    // Only the volumes asked for are wanted and searched for
    if (someVolumes) {
      const answer = await api.wantVolumes(seriesId, someVolumes, {
        search: true,
      });

      if (answer) {
        if (answer.unknown.length > 0) {
          logger.warn('Talearr does not know some requested volumes', {
            label: 'Comics',
            comicId,
            seriesId,
            unknown: answer.unknown,
          });
        }
        return { seriesId, alreadyInLibrary: true };
      }

      logger.info(
        'This Talearr cannot want single volumes, so every missing volume of the series is wanted',
        { label: 'Comics', comicId, seriesId, volumes: someVolumes }
      );
    }

    // Every volume is monitored and searched for
    await api.monitorMissingVolumes(seriesId);
    await api.searchSeries(seriesId);
    return { seriesId, alreadyInLibrary: true };
  }

  const folder = pickComicRootFolder(await api.getRootFolders(), kind, {
    preferKids,
  });

  if (!folder) {
    throw new Error(
      `Talearr has no comics root folder for ${kind}. Add one in Talearr under Comics > Settings.`
    );
  }

  resetComicsLibraryCache();
  const series = await api.addSeries({
    ...ids,
    kind,
    rootFolderId: folder.id,
    monitor: 'all',
    ...(someVolumes ? { volumes: someVolumes } : {}),
  });

  if (someVolumes) {
    if (!Array.isArray(series.wanted)) {
      logger.info(
        'This Talearr cannot want single volumes, so it monitors every volume of the series',
        { label: 'Comics', comicId, seriesId: series.id, volumes: someVolumes }
      );
    } else if (series.unknown && series.unknown.length > 0) {
      logger.warn('Talearr does not know some requested volumes', {
        label: 'Comics',
        comicId,
        seriesId: series.id,
        unknown: series.unknown,
      });
    }
  }

  if (!(await api.searchesOnAdd().catch(() => true))) {
    await api.searchSeries(series.id);
  }

  return { seriesId: series.id, alreadyInLibrary: false };
};

/**
 * The volumes of a series as its page lists them: from Talearr's preview,
 * marked with what Talearr's library has of each. Empty when neither the
 * preview nor the library lists them.
 */
export const getComicVolumeList = async (
  comicId: string,
  metadata: MetadataComic,
  kind?: ComicKind
): Promise<ComicVolumeInfo[]> => {
  const [preview, librarySeries] = await Promise.all([
    getComicPreview(comicId, kind ?? metadata.kind),
    getLibrarySeries(),
  ]);
  const summary =
    findLibrarySeries(librarySeries, comicId, metadata) ??
    (preview?.seriesId
      ? librarySeries.find((series) => series.series.id === preview.seriesId)
      : undefined);
  const libraryVolumes = summary
    ? await getLibraryVolumes(summary.series.id)
    : [];

  return buildComicVolumeList(preview?.volumes ?? [], libraryVolumes);
};

/**
 * Whether Talearr has a volume or is fetching it, so it needs no request
 */
export const isVolumeInLibrary = (volume: ComicVolumeInfo): boolean =>
  volume.state === 'downloaded' || volume.state === 'downloading';
