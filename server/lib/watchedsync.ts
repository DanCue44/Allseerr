import type { JellyfinUserItem } from '@server/api/jellyfin';
import JellyfinAPI from '@server/api/jellyfin';
import type { PlexViewItem } from '@server/api/plexapi';
import PlexAPI from '@server/api/plexapi';
import PlexTvAPI from '@server/api/plextv';
import { MediaType } from '@server/constants/media';
import { MediaServerType } from '@server/constants/server';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { User } from '@server/entity/User';
import WatchedEpisode from '@server/entity/WatchedEpisode';
import WatchedItem from '@server/entity/WatchedItem';
import { markPlexTokenInvalid } from '@server/lib/plexTokenHealth';
import { getSettings } from '@server/lib/settings';
import type {
  EpisodeCounts,
  UserWatchedState,
  WatchedCounts,
} from '@server/lib/watchedState';
import {
  hasEpisodeState,
  hasViewState,
  jellyfinCounts,
  jellyfinEpisodeCounts,
  mergeCounts,
  mergeEpisodeCounts,
  plexCounts,
  plexEpisodeCounts,
  sameCounts,
  sameEpisodeCounts,
  watchedState,
} from '@server/lib/watchedState';
import logger from '@server/logger';
import { getHostname } from '@server/utils/getHostname';
import { In } from 'typeorm';

const LABEL = 'Watched Sync';
/** Plex answers in pages of this many titles */
const PAGE_SIZE = 500;
/** Everyone is read in full at least this often, so a title unwatched elsewhere is caught */
const FULL_EVERY_MS = 24 * 60 * 60 * 1000;
/** A quick run reaches back this far past the last run, in case one was slow */
const OVERLAP_MS = 10 * 60 * 1000;
/** How long a person's server token is kept before plex.tv is asked again */
const SERVER_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
/** How long the map of server ids to titles is kept between page loads */
const KEYS_TTL_MS = 5 * 60 * 1000;
/** How long a person's Continue Watching row is kept between page loads */
const ON_DECK_TTL_MS = 60 * 1000;
/** The most titles a Continue Watching row carries */
const ON_DECK_LIMIT = 20;

interface TitleRef {
  mediaType: MediaType;
  tmdbId: number;
}

interface EpisodeRef {
  /** The series on TMDB */
  tmdbId: number;
  seasonNumber: number;
  episodeNumber: number;
}

/** Keyed `<mediaType>:<tmdbId>` */
type CountsByTitle = Map<string, TitleRef & WatchedCounts>;
/** Keyed `<tmdbId>:<season>:<episode>` */
type CountsByEpisode = Map<string, EpisodeRef & EpisodeCounts>;

interface ServerRead {
  titles: CountsByTitle;
  episodes: CountsByEpisode;
}

/** Which part of a series to mark; the whole series when neither is given */
export interface WatchedTarget {
  seasonNumber?: number;
  episodeNumber?: number;
}

/** A movie left part way, or the next episode of a series being watched */
export interface ContinueWatchingEntry {
  mediaType: MediaType;
  tmdbId: number;
  seasonNumber?: number;
  episodeNumber?: number;
  episodeTitle?: string;
  viewOffset: number | null;
  duration: number | null;
  lastViewedAt: Date | null;
}

const titleKey = (ref: TitleRef): string => `${ref.mediaType}:${ref.tmdbId}`;
const episodeKey = (ref: EpisodeRef): string =>
  `${ref.tmdbId}:${ref.seasonNumber}:${ref.episodeNumber}`;
const emptyRead = (): ServerRead => ({
  titles: new Map(),
  episodes: new Map(),
});

export class WatchedError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
    this.name = 'WatchedError';
  }
}

/** The media server cannot be reached: stop the run instead of failing every user */
class ServerDownError extends Error {}

/** The server turned the person's account down, even with a fresh token */
class NoAccessError extends Error {}

const statusOf = (e: { response?: { status?: number } }): number =>
  e.response?.status ?? 0;

const isServerDown = (e: { response?: unknown; code?: string }): boolean =>
  !e.response || e.code === 'ECONNREFUSED' || e.code === 'ETIMEDOUT';

/**
 * Keeps what each person has watched on the media server, read with their
 * own account, so Allseerr can show it and hide it: every movie and series
 * touched, and each episode played or started. Plex is asked only for what
 * was viewed since the last run, and for everything once a day; Jellyfin
 * and Emby are read in full each time, since their listing is small.
 *
 * A Plex account token only opens the owner's own server. Anyone the server
 * is shared with reaches it with the server token plex.tv hands out for
 * them, so that is looked up (and kept for a while) per person.
 */
class WatchedSync {
  private running = false;
  private lastRunAt = 0;
  private lastFullAt = 0;
  private serverTokens = new Map<
    number,
    { account: string; token: string | null; at: number }
  >();
  private keysCache?: { at: number; keys: Map<string, TitleRef> };
  private onDeckCache = new Map<
    number,
    { at: number; entries: ContinueWatchingEntry[] }
  >();

  public status(): { running: boolean } {
    return { running: this.running };
  }

  public async sync({ full = false }: { full?: boolean } = {}): Promise<void> {
    if (this.running) {
      logger.debug('Watched sync already running', { label: LABEL });
      return;
    }

    const mediaServer = getSettings().main.mediaServerType;
    if (
      mediaServer !== MediaServerType.PLEX &&
      mediaServer !== MediaServerType.JELLYFIN &&
      mediaServer !== MediaServerType.EMBY
    ) {
      return;
    }

    this.running = true;
    const startedAt = Date.now();

    try {
      const fullRun = full || startedAt - this.lastFullAt > FULL_EVERY_MS;
      const since = fullRun
        ? undefined
        : Math.floor((this.lastRunAt - OVERLAP_MS) / 1000);
      const keys = await this.mediaKeys(true);
      const users = await this.usersWithAccounts(mediaServer);
      let synced = 0;
      let noAccess = 0;

      for (const user of users) {
        try {
          const read =
            mediaServer === MediaServerType.PLEX
              ? await this.readPlex(user, keys, since)
              : await this.readJellyfin(user, keys);
          // A quick Plex run only sees what was viewed since, so it never prunes
          await this.store(
            user,
            read,
            fullRun || mediaServer !== MediaServerType.PLEX
          );
          synced += 1;
        } catch (e) {
          if (e instanceof ServerDownError) {
            throw e;
          }
          if (e instanceof NoAccessError) {
            noAccess += 1;
            logger.debug('The media server turned down a user account', {
              label: LABEL,
              user: user.displayName,
              errorMessage: e.message,
            });
            continue;
          }
          logger.warn('Could not read what a user has watched', {
            label: LABEL,
            user: user.displayName,
            errorMessage: e.message,
          });
        }
      }

      this.lastRunAt = startedAt;
      if (fullRun) {
        this.lastFullAt = startedAt;
      }

      logger.info(
        `Watched state ${fullRun ? 'read in full' : 'updated'} for ${synced} of ${
          users.length
        } users${noAccess > 0 ? ` (${noAccess} without server access)` : ''}`,
        { label: LABEL }
      );
    } catch (e) {
      logger.error('Watched sync stopped', {
        label: LABEL,
        errorMessage: e.message,
      });
    } finally {
      this.running = false;
    }
  }

  /**
   * Marks a title, or one season or episode of a series, watched or
   * unwatched on the media server with the person's own account, then keeps
   * what the server says about the title and its episodes
   */
  public async setWatched(
    user: User,
    media: Media,
    watched: boolean,
    target: WatchedTarget = {}
  ): Promise<UserWatchedState> {
    if (
      (media.mediaType !== MediaType.MOVIE &&
        media.mediaType !== MediaType.TV) ||
      media.tmdbId == null
    ) {
      throw new WatchedError(
        400,
        'Only movies and series can be marked watched'
      );
    }

    const tmdbId = media.tmdbId;
    const isSeries = media.mediaType === MediaType.TV;
    const mediaServer = getSettings().main.mediaServerType;
    const account = await this.accountOf(user.id);
    let counts: WatchedCounts | undefined;
    const episodes: CountsByEpisode = new Map();

    if (mediaServer === MediaServerType.PLEX) {
      if (!account?.plexToken) {
        throw new WatchedError(400, 'Sign in with Plex to mark titles watched');
      }

      const keys = [media.ratingKey, media.ratingKey4k].filter(
        (key): key is string => !!key
      );

      if (keys.length === 0) {
        throw new WatchedError(400, 'This title is not on the Plex server');
      }

      const mark = async (plex: PlexAPI) => {
        for (const key of keys) {
          await plex.setWatched(
            isSeries ? await this.plexTargetKey(plex, key, target) : key,
            watched
          );
        }
        for (const key of keys) {
          counts = mergeCounts(counts, plexCounts(await plex.getMetadata(key)));
          if (isSeries) {
            for (const leaf of await plex.getAllLeaves(key)) {
              this.addPlexEpisode(episodes, tmdbId, leaf);
            }
          }
        }
      };

      const refused = new WatchedError(
        403,
        'Plex did not accept your account for this server. Sign in with Plex again and retry.'
      );

      try {
        await mark(
          new PlexAPI({ plexToken: await this.plexServerToken(account) })
        );
      } catch (e) {
        if (e instanceof NoAccessError) {
          throw refused;
        }
        if (statusOf(e) !== 401) {
          throw e;
        }
        // The kept server token may be stale: ask plex.tv for a new one
        try {
          await mark(
            new PlexAPI({
              plexToken: await this.plexServerToken(account, true),
            })
          );
        } catch (e2) {
          if (e2 instanceof NoAccessError || statusOf(e2) === 401) {
            throw refused;
          }
          throw e2;
        }
      }
    } else if (
      mediaServer === MediaServerType.JELLYFIN ||
      mediaServer === MediaServerType.EMBY
    ) {
      const serverName =
        mediaServer === MediaServerType.EMBY ? 'Emby' : 'Jellyfin';

      if (!account?.jellyfinAuthToken || !account.jellyfinUserId) {
        throw new WatchedError(
          400,
          `Sign in with ${serverName} to mark titles watched`
        );
      }

      const ids = [media.jellyfinMediaId, media.jellyfinMediaId4k].filter(
        (id): id is string => !!id
      );

      if (ids.length === 0) {
        throw new WatchedError(
          400,
          `This title is not on the ${serverName} server`
        );
      }

      const jellyfin = new JellyfinAPI(
        getHostname(),
        account.jellyfinAuthToken,
        account.jellyfinDeviceId
      );
      jellyfin.setUserId(account.jellyfinUserId);

      for (const id of ids) {
        await jellyfin.setPlayed(
          isSeries ? await this.jellyfinTargetId(jellyfin, id, target) : id,
          watched
        );
      }
      for (const id of ids) {
        const item = await jellyfin.getUserItem(id);
        if (item) {
          counts = mergeCounts(counts, jellyfinCounts(item));
        }
        if (isSeries) {
          for (const episode of await jellyfin.getUserEpisodes(id)) {
            this.addJellyfinEpisode(episodes, tmdbId, episode);
          }
        }
      }
    } else {
      throw new WatchedError(400, 'No media server is set up');
    }

    this.onDeckCache.delete(user.id);

    if (isSeries) {
      await this.saveEpisodes(user, tmdbId, episodes);
    }

    return this.saveTitle(user, { mediaType: media.mediaType, tmdbId }, counts);
  }

  /**
   * What the person should pick up next, straight from the media server:
   * Plex's On Deck, or Jellyfin's resumable items and Next Up. Kept a
   * minute per person. Empty for anyone the server will not answer for.
   */
  public async continueWatching(user: User): Promise<ContinueWatchingEntry[]> {
    const kept = this.onDeckCache.get(user.id);
    if (kept && Date.now() - kept.at < ON_DECK_TTL_MS) {
      return kept.entries;
    }

    const mediaServer = getSettings().main.mediaServerType;
    const account = await this.accountOf(user.id);
    let entries: ContinueWatchingEntry[] = [];

    try {
      if (mediaServer === MediaServerType.PLEX) {
        if (account?.plexToken && !account.plexTokenInvalidAt) {
          entries = await this.plexOnDeck(account);
        }
      } else if (
        mediaServer === MediaServerType.JELLYFIN ||
        mediaServer === MediaServerType.EMBY
      ) {
        if (account?.jellyfinAuthToken && account.jellyfinUserId) {
          entries = await this.jellyfinNextUp(account);
        }
      }
    } catch (e) {
      if (!(e instanceof NoAccessError)) {
        logger.debug('Could not read what a user is watching', {
          label: LABEL,
          user: user.displayName,
          errorMessage: e.message,
        });
      }
    }

    this.onDeckCache.set(user.id, { at: Date.now(), entries });

    return entries;
  }

  private async plexOnDeck(account: User): Promise<ContinueWatchingEntry[]> {
    const keys = await this.mediaKeys();
    const read = async (plex: PlexAPI) => plex.getOnDeck();
    let items: PlexViewItem[];

    try {
      items = await read(
        new PlexAPI({ plexToken: await this.plexServerToken(account) })
      );
    } catch (e) {
      if (e instanceof NoAccessError || statusOf(e) !== 401) {
        throw e;
      }
      items = await read(
        new PlexAPI({ plexToken: await this.plexServerToken(account, true) })
      );
    }

    const entries: ContinueWatchingEntry[] = [];

    for (const item of items) {
      const entry = this.plexEntry(keys, item);
      if (entry && !entries.some((e) => e.tmdbId === entry.tmdbId)) {
        entries.push(entry);
      }
      if (entries.length >= ON_DECK_LIMIT) {
        break;
      }
    }

    return entries;
  }

  private plexEntry(
    keys: Map<string, TitleRef>,
    item: PlexViewItem
  ): ContinueWatchingEntry | undefined {
    const counts = plexEpisodeCounts(item);

    if (item.type === 'episode') {
      const ref = item.grandparentRatingKey
        ? keys.get(item.grandparentRatingKey)
        : undefined;
      if (
        !ref ||
        ref.mediaType !== MediaType.TV ||
        item.parentIndex == null ||
        item.index == null
      ) {
        return undefined;
      }

      return {
        mediaType: MediaType.TV,
        tmdbId: ref.tmdbId,
        seasonNumber: item.parentIndex,
        episodeNumber: item.index,
        episodeTitle: item.title,
        ...counts,
      };
    }

    const ref = keys.get(item.ratingKey);
    if (!ref || ref.mediaType !== MediaType.MOVIE) {
      return undefined;
    }

    return { mediaType: MediaType.MOVIE, tmdbId: ref.tmdbId, ...counts };
  }

  private async jellyfinNextUp(
    account: User
  ): Promise<ContinueWatchingEntry[]> {
    const keys = await this.mediaKeys();
    const jellyfin = new JellyfinAPI(
      getHostname(),
      account.jellyfinAuthToken,
      account.jellyfinDeviceId
    );
    jellyfin.setUserId(account.jellyfinUserId ?? '');

    let items: JellyfinUserItem[];
    try {
      items = [
        ...(await jellyfin.getResumeItems()),
        ...(await jellyfin.getNextUp()),
      ];
    } catch (e) {
      if (statusOf(e) === 401) {
        throw new NoAccessError('The server answered 401');
      }
      throw e;
    }

    const entries: ContinueWatchingEntry[] = [];

    for (const item of items) {
      const counts = jellyfinEpisodeCounts(item);
      let entry: ContinueWatchingEntry | undefined;

      if (item.Type === 'Episode') {
        const ref = item.SeriesId ? keys.get(item.SeriesId) : undefined;
        if (
          ref?.mediaType === MediaType.TV &&
          item.ParentIndexNumber != null &&
          item.IndexNumber != null
        ) {
          entry = {
            mediaType: MediaType.TV,
            tmdbId: ref.tmdbId,
            seasonNumber: item.ParentIndexNumber,
            episodeNumber: item.IndexNumber,
            episodeTitle: item.Name,
            ...counts,
          };
        }
      } else {
        const ref = keys.get(item.Id);
        if (ref?.mediaType === MediaType.MOVIE) {
          entry = { mediaType: MediaType.MOVIE, tmdbId: ref.tmdbId, ...counts };
        }
      }

      if (entry && !entries.some((e) => e.tmdbId === entry?.tmdbId)) {
        entries.push(entry);
      }
      if (entries.length >= ON_DECK_LIMIT) {
        break;
      }
    }

    return entries;
  }

  /** The Plex item to mark for a series: the show, a season or an episode */
  private async plexTargetKey(
    plex: PlexAPI,
    showKey: string,
    target: WatchedTarget
  ): Promise<string> {
    if (target.episodeNumber != null) {
      const leaf = (await plex.getAllLeaves(showKey)).find(
        (item) =>
          item.parentIndex === target.seasonNumber &&
          item.index === target.episodeNumber
      );
      if (!leaf) {
        throw new WatchedError(404, 'This episode is not on the Plex server');
      }
      return leaf.ratingKey;
    }

    if (target.seasonNumber != null) {
      const season = (await plex.getChildrenMetadata(showKey)).find(
        (item) => item.index === target.seasonNumber
      );
      if (!season) {
        throw new WatchedError(404, 'This season is not on the Plex server');
      }
      return season.ratingKey;
    }

    return showKey;
  }

  /** The Jellyfin item to mark for a series: the series, a season or an episode */
  private async jellyfinTargetId(
    jellyfin: JellyfinAPI,
    seriesId: string,
    target: WatchedTarget
  ): Promise<string> {
    if (target.episodeNumber != null) {
      const episode = (await jellyfin.getUserEpisodes(seriesId)).find(
        (item) =>
          item.ParentIndexNumber === target.seasonNumber &&
          item.IndexNumber === target.episodeNumber
      );
      if (!episode) {
        throw new WatchedError(404, 'This episode is not on the server');
      }
      return episode.Id;
    }

    if (target.seasonNumber != null) {
      const season = (await jellyfin.getUserSeasons(seriesId)).find(
        (item) => item.IndexNumber === target.seasonNumber
      );
      if (!season) {
        throw new WatchedError(404, 'This season is not on the server');
      }
      return season.Id;
    }

    return seriesId;
  }

  /** The person's row for one title, saved or removed to match the server */
  private async saveTitle(
    user: User,
    ref: TitleRef,
    counts: WatchedCounts | undefined
  ): Promise<UserWatchedState> {
    const repository = getRepository(WatchedItem);
    const row = await repository.findOne({
      where: {
        user: { id: user.id },
        mediaType: ref.mediaType,
        tmdbId: ref.tmdbId,
      },
    });

    if (!counts || !hasViewState(counts)) {
      if (row) {
        await repository.remove(row);
      }

      return watchedState(undefined, ref.mediaType);
    }

    const saved =
      row ?? new WatchedItem({ user: { id: user.id } as User, ...ref });
    saved.assign(counts);
    await repository.save(saved);

    return watchedState(saved, ref.mediaType);
  }

  /** The person's episode rows for one series, made to match the server */
  private async saveEpisodes(
    user: User,
    tmdbId: number,
    episodes: CountsByEpisode
  ): Promise<void> {
    const repository = getRepository(WatchedEpisode);
    const existing = await repository.find({
      where: { user: { id: user.id }, tmdbId },
    });

    await this.storeEpisodes(user, episodes, existing, true);
  }

  /** The person with the media server fields the API leaves out by default */
  private async accountOf(userId: number): Promise<User | null> {
    return getRepository(User)
      .createQueryBuilder('user')
      .addSelect([
        'user.plexToken',
        'user.jellyfinAuthToken',
        'user.jellyfinDeviceId',
      ])
      .where('user.id = :userId', { userId })
      .getOne();
  }

  /**
   * The token that opens this Plex server for the person: the one plex.tv
   * lists for the server among their resources (for the owner it is their
   * own account token). Kept for a while per person.
   */
  private async plexServerToken(user: User, fresh = false): Promise<string> {
    const accountToken = user.plexToken ?? '';
    const kept = this.serverTokens.get(user.id);

    if (
      !fresh &&
      kept &&
      kept.account === accountToken &&
      Date.now() - kept.at < SERVER_TOKEN_TTL_MS
    ) {
      if (kept.token === null) {
        throw new NoAccessError('plex.tv turned the account token down lately');
      }

      return kept.token;
    }

    const machineId = getSettings().plex.machineId ?? '';
    let serverToken: string | null;

    try {
      serverToken = await new PlexTvAPI(accountToken).getServerAccessToken(
        machineId
      );
    } catch (e) {
      // A token plex.tv no longer knows: the person has to sign in again
      if (statusOf(e) === 401 || statusOf(e) === 422) {
        this.serverTokens.set(user.id, {
          account: accountToken,
          token: null,
          at: Date.now(),
        });
        await markPlexTokenInvalid(user.id);
        throw new NoAccessError('plex.tv turned the account token down');
      }
      throw e;
    }

    // Not listed: the owner's own token still opens a server plex.tv has
    // not caught up on
    const token = serverToken ?? accountToken;
    this.serverTokens.set(user.id, {
      account: accountToken,
      token,
      at: Date.now(),
    });

    return token;
  }

  /**
   * Every media server item id Allseerr knows, mapped to its title. Kept a
   * few minutes for the pages; a sync run always reads it fresh.
   */
  private async mediaKeys(fresh = false): Promise<Map<string, TitleRef>> {
    if (
      !fresh &&
      this.keysCache &&
      Date.now() - this.keysCache.at < KEYS_TTL_MS
    ) {
      return this.keysCache.keys;
    }

    const rows = await getRepository(Media)
      .createQueryBuilder('media')
      .select([
        'media.id',
        'media.tmdbId',
        'media.mediaType',
        'media.ratingKey',
        'media.ratingKey4k',
        'media.jellyfinMediaId',
        'media.jellyfinMediaId4k',
      ])
      .where('media.mediaType IN (:...types)', {
        types: [MediaType.MOVIE, MediaType.TV],
      })
      .andWhere('media.tmdbId IS NOT NULL')
      .getMany();

    const keys = new Map<string, TitleRef>();

    for (const media of rows) {
      const ref = {
        mediaType: media.mediaType,
        tmdbId: media.tmdbId as number,
      };
      for (const key of [
        media.ratingKey,
        media.ratingKey4k,
        media.jellyfinMediaId,
        media.jellyfinMediaId4k,
      ]) {
        if (key) {
          keys.set(key, ref);
        }
      }
    }

    this.keysCache = { at: Date.now(), keys };

    return keys;
  }

  private async usersWithAccounts(
    mediaServer: MediaServerType
  ): Promise<User[]> {
    const query = getRepository(User).createQueryBuilder('user');

    if (mediaServer === MediaServerType.PLEX) {
      return (
        query
          .addSelect('user.plexToken')
          .where("user.plexToken != ''")
          // An expired sign in is left alone until the person signs in again
          .andWhere('user.plexTokenInvalidAt IS NULL')
          .getMany()
      );
    }

    return query
      .addSelect(['user.jellyfinAuthToken', 'user.jellyfinDeviceId'])
      .where("user.jellyfinAuthToken != ''")
      .andWhere('user.jellyfinUserId IS NOT NULL')
      .getMany();
  }

  private addTitle(
    counts: CountsByTitle,
    ref: TitleRef | undefined,
    seen: WatchedCounts
  ): void {
    if (!ref || !hasViewState(seen)) {
      return;
    }

    const key = titleKey(ref);
    counts.set(key, { ...ref, ...mergeCounts(counts.get(key), seen) });
  }

  private addEpisode(
    counts: CountsByEpisode,
    ref: EpisodeRef,
    seen: EpisodeCounts
  ): void {
    if (!hasEpisodeState(seen)) {
      return;
    }

    const key = episodeKey(ref);
    counts.set(key, { ...ref, ...mergeEpisodeCounts(counts.get(key), seen) });
  }

  private addPlexEpisode(
    counts: CountsByEpisode,
    tmdbId: number,
    item: PlexViewItem
  ): void {
    if (item.parentIndex == null || item.index == null) {
      return;
    }

    this.addEpisode(
      counts,
      { tmdbId, seasonNumber: item.parentIndex, episodeNumber: item.index },
      plexEpisodeCounts(item)
    );
  }

  private addJellyfinEpisode(
    counts: CountsByEpisode,
    tmdbId: number,
    item: JellyfinUserItem
  ): void {
    if (item.ParentIndexNumber == null || item.IndexNumber == null) {
      return;
    }

    this.addEpisode(
      counts,
      {
        tmdbId,
        seasonNumber: item.ParentIndexNumber,
        episodeNumber: item.IndexNumber,
      },
      jellyfinEpisodeCounts(item)
    );
  }

  /**
   * What the person has watched on Plex. A 401 means the kept server token
   * went stale (or the account lost access): plex.tv is asked once more, and
   * a second 401 gives the account up for this run.
   */
  private async readPlex(
    user: User,
    keys: Map<string, TitleRef>,
    since?: number
  ): Promise<ServerRead> {
    try {
      return await this.readPlexWith(
        new PlexAPI({ plexToken: await this.plexServerToken(user) }),
        user,
        keys,
        since
      );
    } catch (e) {
      if (statusOf(e) !== 401) {
        throw e;
      }
    }

    try {
      return await this.readPlexWith(
        new PlexAPI({ plexToken: await this.plexServerToken(user, true) }),
        user,
        keys,
        since
      );
    } catch (e) {
      if (statusOf(e) === 401) {
        throw new NoAccessError('Plex answered 401 with a fresh server token');
      }
      throw e;
    }
  }

  private async readPlexWith(
    plex: PlexAPI,
    user: User,
    keys: Map<string, TitleRef>,
    since?: number
  ): Promise<ServerRead> {
    const libraries = getSettings().plex.libraries.filter(
      (library) =>
        library.enabled && (library.type === 'movie' || library.type === 'show')
    );
    const read = emptyRead();

    for (const library of libraries) {
      const isShows = library.type === 'show';
      const listings: ('movie' | 'show' | 'episode')[] = isShows
        ? ['show', 'episode']
        : ['movie'];

      for (const listing of listings) {
        let offset = 0;

        for (;;) {
          let page: Awaited<ReturnType<PlexAPI['getViewState']>>;

          try {
            page = await plex.getViewState(library.id, listing, {
              offset,
              size: PAGE_SIZE,
              // Only episodes ever viewed are wanted, even on a full run
              since: listing === 'episode' ? (since ?? 1) : since,
            });
          } catch (e) {
            if (isServerDown(e)) {
              throw new ServerDownError(`Plex cannot be reached: ${e.message}`);
            }
            if (statusOf(e) === 401) {
              throw e;
            }
            // A library not shared with this person answers 403 or 404
            if (statusOf(e) !== 403 && statusOf(e) !== 404) {
              logger.warn('Could not read a Plex library for a user', {
                label: LABEL,
                user: user.displayName,
                library: library.name,
                errorMessage: e.message,
              });
            }
            break;
          }

          for (const item of page.items) {
            if (listing === 'episode') {
              const ref = item.grandparentRatingKey
                ? keys.get(item.grandparentRatingKey)
                : undefined;
              if (ref?.mediaType === MediaType.TV) {
                this.addPlexEpisode(read.episodes, ref.tmdbId, item);
              }
            } else {
              this.addTitle(
                read.titles,
                keys.get(item.ratingKey),
                plexCounts(item)
              );
            }
          }

          offset += page.items.length;
          if (page.items.length === 0 || offset >= page.totalSize) {
            break;
          }
        }
      }
    }

    return read;
  }

  private async readJellyfin(
    user: User,
    keys: Map<string, TitleRef>
  ): Promise<ServerRead> {
    const jellyfin = new JellyfinAPI(
      getHostname(),
      user.jellyfinAuthToken,
      user.jellyfinDeviceId
    );
    jellyfin.setUserId(user.jellyfinUserId ?? '');
    const libraries = getSettings().jellyfin.libraries.filter(
      (library) =>
        library.enabled && (library.type === 'movie' || library.type === 'show')
    );
    const read = emptyRead();

    for (const library of libraries) {
      let items: JellyfinUserItem[];
      let episodes: JellyfinUserItem[] = [];

      try {
        items = await jellyfin.getUserItems(library.id);
        if (library.type === 'show') {
          episodes = [
            ...(await jellyfin.getUserEpisodes(library.id, 'IsPlayed')),
            ...(await jellyfin.getUserEpisodes(library.id, 'IsResumable')),
          ];
        }
      } catch (e) {
        if (isServerDown(e)) {
          throw new ServerDownError(
            `The server cannot be reached: ${e.message}`
          );
        }
        if (statusOf(e) === 401) {
          throw new NoAccessError('The server answered 401');
        }
        if (statusOf(e) !== 403 && statusOf(e) !== 404) {
          logger.warn('Could not read a library for a user', {
            label: LABEL,
            user: user.displayName,
            library: library.name,
            errorMessage: e.message,
          });
        }
        continue;
      }

      for (const item of items) {
        this.addTitle(read.titles, keys.get(item.Id), jellyfinCounts(item));
      }
      for (const episode of episodes) {
        const ref = episode.SeriesId ? keys.get(episode.SeriesId) : undefined;
        if (ref?.mediaType === MediaType.TV) {
          this.addJellyfinEpisode(read.episodes, ref.tmdbId, episode);
        }
      }
    }

    return read;
  }

  /**
   * Saves what changed for the person. With `prune` the rows the server no
   * longer reports go too (a title unwatched there, or removed).
   */
  private async store(
    user: User,
    read: ServerRead,
    prune: boolean
  ): Promise<void> {
    const repository = getRepository(WatchedItem);
    const existing = await repository.find({
      where: { user: { id: user.id } },
    });
    const left = new Map(existing.map((row) => [titleKey(row), row]));
    const toSave: WatchedItem[] = [];

    for (const [key, seen] of read.titles) {
      const row = left.get(key);
      left.delete(key);

      if (row) {
        if (!sameCounts(row, seen)) {
          row.assign(seen);
          toSave.push(row);
        }
      } else {
        const fresh = new WatchedItem({
          user: { id: user.id } as User,
          mediaType: seen.mediaType,
          tmdbId: seen.tmdbId,
        });
        fresh.assign(seen);
        toSave.push(fresh);
      }
    }

    if (toSave.length > 0) {
      await repository.save(toSave, { chunk: 200 });
    }

    if (prune && left.size > 0) {
      await repository.remove([...left.values()], { chunk: 200 });
    }

    // A quick run only compares the series it saw something for
    const seenShows = [
      ...new Set([...read.episodes.values()].map((e) => e.tmdbId)),
    ];
    const episodeRepository = getRepository(WatchedEpisode);
    const existingEpisodes = prune
      ? await episodeRepository.find({ where: { user: { id: user.id } } })
      : seenShows.length > 0
        ? await episodeRepository.find({
            where: { user: { id: user.id }, tmdbId: In(seenShows) },
          })
        : [];

    await this.storeEpisodes(user, read.episodes, existingEpisodes, prune);
  }

  private async storeEpisodes(
    user: User,
    episodes: CountsByEpisode,
    existing: WatchedEpisode[],
    prune: boolean
  ): Promise<void> {
    const repository = getRepository(WatchedEpisode);
    const left = new Map(existing.map((row) => [episodeKey(row), row]));
    const toSave: WatchedEpisode[] = [];

    for (const [key, seen] of episodes) {
      const row = left.get(key);
      left.delete(key);

      if (row) {
        if (!sameEpisodeCounts(row, seen)) {
          row.assign(seen);
          toSave.push(row);
        }
      } else {
        const fresh = new WatchedEpisode({
          user: { id: user.id } as User,
          tmdbId: seen.tmdbId,
          seasonNumber: seen.seasonNumber,
          episodeNumber: seen.episodeNumber,
        });
        fresh.assign(seen);
        toSave.push(fresh);
      }
    }

    if (toSave.length > 0) {
      await repository.save(toSave, { chunk: 200 });
    }

    if (prune && left.size > 0) {
      await repository.remove([...left.values()], { chunk: 200 });
    }
  }
}

const watchedSync = new WatchedSync();

export default watchedSync;
