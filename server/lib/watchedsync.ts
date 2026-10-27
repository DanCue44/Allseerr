import JellyfinAPI from '@server/api/jellyfin';
import PlexAPI from '@server/api/plexapi';
import PlexTvAPI from '@server/api/plextv';
import { MediaType } from '@server/constants/media';
import { MediaServerType } from '@server/constants/server';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { User } from '@server/entity/User';
import WatchedItem from '@server/entity/WatchedItem';
import { getSettings } from '@server/lib/settings';
import type { UserWatchedState, WatchedCounts } from '@server/lib/watchedState';
import {
  hasViewState,
  jellyfinCounts,
  mergeCounts,
  plexCounts,
  sameCounts,
  watchedState,
} from '@server/lib/watchedState';
import logger from '@server/logger';
import { getHostname } from '@server/utils/getHostname';

const LABEL = 'Watched Sync';
/** Plex answers in pages of this many titles */
const PAGE_SIZE = 500;
/** Everyone is read in full at least this often, so a title unwatched elsewhere is caught */
const FULL_EVERY_MS = 24 * 60 * 60 * 1000;
/** A quick run reaches back this far past the last run, in case one was slow */
const OVERLAP_MS = 10 * 60 * 1000;
/** How long a person's server token is kept before plex.tv is asked again */
const SERVER_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

interface TitleRef {
  mediaType: MediaType;
  tmdbId: number;
}

/** Keyed `<mediaType>:<tmdbId>` */
type CountsByTitle = Map<string, TitleRef & WatchedCounts>;

const titleKey = (ref: TitleRef): string => `${ref.mediaType}:${ref.tmdbId}`;

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
 * own account, so Allseerr can show it and hide it. Plex is asked only for
 * titles viewed since the last run, and for everything once a day; Jellyfin
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
  private serverTokens = new Map<number, { token: string; at: number }>();

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
      const keys = await this.mediaKeys();
      const users = await this.usersWithAccounts(mediaServer);
      let synced = 0;
      let noAccess = 0;

      for (const user of users) {
        try {
          const counts =
            mediaServer === MediaServerType.PLEX
              ? await this.readPlex(user, keys, since)
              : await this.readJellyfin(user, keys);
          // A quick Plex run only sees what was viewed since, so it never prunes
          await this.store(
            user,
            counts,
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
   * Marks a title watched or unwatched on the media server with the person's
   * own account, then keeps what the server says about it
   */
  public async setWatched(
    user: User,
    media: Media,
    watched: boolean
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

    const mediaServer = getSettings().main.mediaServerType;
    const account = await this.accountOf(user.id);
    let counts: WatchedCounts | undefined;

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
          await plex.setWatched(key, watched);
        }
        for (const key of keys) {
          counts = mergeCounts(counts, plexCounts(await plex.getMetadata(key)));
        }
      };

      try {
        await mark(
          new PlexAPI({ plexToken: await this.plexServerToken(account) })
        );
      } catch (e) {
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
          if (statusOf(e2) === 401) {
            throw new WatchedError(
              403,
              'Plex did not accept your account for this server. Sign in with Plex again and retry.'
            );
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
        await jellyfin.setPlayed(id, watched);
      }
      for (const id of ids) {
        const item = await jellyfin.getUserItem(id);
        if (item) {
          counts = mergeCounts(counts, jellyfinCounts(item));
        }
      }
    } else {
      throw new WatchedError(400, 'No media server is set up');
    }

    return this.saveTitle(
      user,
      { mediaType: media.mediaType, tmdbId: media.tmdbId },
      counts
    );
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

    if (!fresh && kept && Date.now() - kept.at < SERVER_TOKEN_TTL_MS) {
      return kept.token;
    }

    const machineId = getSettings().plex.machineId;
    const devices = await new PlexTvAPI(accountToken).getDevices();
    const server = devices.find(
      (device) => device.clientIdentifier === machineId
    );
    const token = server?.accessToken ?? accountToken;

    this.serverTokens.set(user.id, { token, at: Date.now() });

    return token;
  }

  /** Every media server item id Allseerr knows, mapped to its title */
  private async mediaKeys(): Promise<Map<string, TitleRef>> {
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

    return keys;
  }

  private async usersWithAccounts(
    mediaServer: MediaServerType
  ): Promise<User[]> {
    const query = getRepository(User).createQueryBuilder('user');

    if (mediaServer === MediaServerType.PLEX) {
      return query
        .addSelect('user.plexToken')
        .where("user.plexToken != ''")
        .getMany();
    }

    return query
      .addSelect(['user.jellyfinAuthToken', 'user.jellyfinDeviceId'])
      .where("user.jellyfinAuthToken != ''")
      .andWhere('user.jellyfinUserId IS NOT NULL')
      .getMany();
  }

  private add(
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

  /**
   * What the person has watched on Plex. A 401 means the kept server token
   * went stale (or the account lost access): plex.tv is asked once more, and
   * a second 401 gives the account up for this run.
   */
  private async readPlex(
    user: User,
    keys: Map<string, TitleRef>,
    since?: number
  ): Promise<CountsByTitle> {
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
  ): Promise<CountsByTitle> {
    const libraries = getSettings().plex.libraries.filter(
      (library) =>
        library.enabled && (library.type === 'movie' || library.type === 'show')
    );
    const counts: CountsByTitle = new Map();

    for (const library of libraries) {
      let offset = 0;

      for (;;) {
        let page: Awaited<ReturnType<PlexAPI['getViewState']>>;

        try {
          page = await plex.getViewState(
            library.id,
            library.type === 'show' ? 'show' : 'movie',
            { offset, size: PAGE_SIZE, since }
          );
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
          this.add(counts, keys.get(item.ratingKey), plexCounts(item));
        }

        offset += page.items.length;
        if (page.items.length === 0 || offset >= page.totalSize) {
          break;
        }
      }
    }

    return counts;
  }

  private async readJellyfin(
    user: User,
    keys: Map<string, TitleRef>
  ): Promise<CountsByTitle> {
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
    const counts: CountsByTitle = new Map();

    for (const library of libraries) {
      let items: Awaited<ReturnType<JellyfinAPI['getUserItems']>>;

      try {
        items = await jellyfin.getUserItems(library.id);
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
        this.add(counts, keys.get(item.Id), jellyfinCounts(item));
      }
    }

    return counts;
  }

  /**
   * Saves what changed for the person. With `prune` the rows the server no
   * longer reports go too (a title unwatched there, or removed).
   */
  private async store(
    user: User,
    counts: CountsByTitle,
    prune: boolean
  ): Promise<void> {
    const repository = getRepository(WatchedItem);
    const existing = await repository.find({
      where: { user: { id: user.id } },
    });
    const left = new Map(existing.map((row) => [titleKey(row), row]));
    const toSave: WatchedItem[] = [];

    for (const [key, seen] of counts) {
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
  }
}

const watchedSync = new WatchedSync();

export default watchedSync;
