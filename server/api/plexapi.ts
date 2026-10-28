import ExternalAPI from '@server/api/externalapi';
import { ApiErrorCode } from '@server/constants/error';
import type { PlexProbe } from '@server/lib/plexConnection';
import { plexAddressUrl } from '@server/lib/plexConnection';
import type { LibraryReconcileResult } from '@server/lib/plexLibraries';
import { reconcileLibraries } from '@server/lib/plexLibraries';
import type { Library, PlexSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import type { PlexViewFields } from '@server/lib/watchedState';
import logger from '@server/logger';
import { ApiError } from '@server/types/error';
import { requestErrorLogFields } from '@server/utils/requestError';

interface PlexStatusResponse {
  MediaContainer: {
    machineIdentifier: string;
    friendlyName: string;
  };
}

export interface PlexLibraryItem {
  ratingKey: string;
  parentRatingKey?: string;
  grandparentRatingKey?: string;
  title: string;
  guid: string;
  parentGuid?: string;
  grandparentGuid?: string;
  addedAt: number;
  updatedAt: number;
  Guid?: {
    id: string;
  }[];
  type: 'movie' | 'show' | 'season' | 'episode' | 'artist' | 'album';
  Media: Media[];
}

interface PlexLibraryResponse {
  MediaContainer: {
    totalSize: number;
    Metadata: PlexLibraryItem[];
  };
}

export interface PlexLibrary {
  type: 'show' | 'movie' | 'artist';
  key: string;
  title: string;
  agent: string;
}

interface PlexLibrariesResponse {
  MediaContainer: {
    Directory: PlexLibrary[];
  };
}

export interface PlexMetadata {
  ratingKey: string;
  parentRatingKey?: string;
  guid: string;
  type: 'movie' | 'show' | 'season';
  title: string;
  Guid: {
    id: string;
  }[];
  Children?: {
    size: 12;
    Metadata: PlexMetadata[];
  };
  index: number;
  parentIndex?: number;
  leafCount: number;
  viewedLeafCount: number;
  viewCount?: number;
  viewOffset?: number;
  lastViewedAt?: number;
  addedAt: number;
  updatedAt: number;
  Media: Media[];
}

interface Media {
  id: number;
  duration: number;
  bitrate: number;
  width: number;
  height: number;
  aspectRatio: number;
  audioChannels: number;
  audioCodec: string;
  videoCodec: string;
  videoResolution: string;
  container: string;
  videoFrameRate: string;
  videoProfile: string;
}

interface PlexMetadataResponse {
  MediaContainer: {
    Metadata: PlexMetadata[];
  };
}

/** A library item with the view fields the token's own account sees */
export interface PlexViewItem extends PlexViewFields {
  ratingKey: string;
  type: 'movie' | 'show' | 'episode';
  title?: string;
  /** For an episode: its show, and the season and episode numbers */
  grandparentRatingKey?: string;
  grandparentTitle?: string;
  parentIndex?: number;
  index?: number;
}

interface PlexViewResponse {
  MediaContainer: {
    totalSize?: number;
    Metadata?: PlexViewItem[];
  };
}

// Only the counts are wanted from a view state listing, not the files,
// people and art
const VIEW_STATE_SLIM =
  '&excludeElements=Media,Genre,Director,Writer,Producer,Country,Role,Collection,Field,Guid,Image,Label,Rating,UltraBlurColors' +
  '&excludeFields=summary,tagline';

class PlexAPI extends ExternalAPI {
  constructor({
    plexToken,
    plexSettings,
    timeout,
  }: {
    plexToken?: string | null;
    plexSettings?: PlexSettings;
    timeout?: number;
  }) {
    const settings = getSettings();
    const settingsPlex = plexSettings ?? settings.plex;

    const baseUrl = plexAddressUrl({
      ip: settingsPlex.ip,
      port: settingsPlex.port,
      useSsl: !!settingsPlex.useSsl,
    });

    super(
      baseUrl,
      {},
      {
        timeout,
        headers: {
          'X-Plex-Token': plexToken ?? '',
          'X-Plex-Client-Identifier': settings.clientId,
          'X-Plex-Product': 'Allseerr',
          'X-Plex-Device-Name': 'Allseerr',
          'X-Plex-Platform': 'Allseerr',
        },
      }
    );
  }

  public async getStatus(): Promise<PlexStatusResponse> {
    return await this.get('/');
  }

  public async getLibraries(): Promise<PlexLibrary[]> {
    const response = await this.get<PlexLibrariesResponse>('/library/sections');

    return response.MediaContainer.Directory;
  }

  /**
   * Reloads the library list from Plex. Enabled libraries follow their name
   * when Plex has renumbered its sections (see reconcileLibraries).
   */
  public async syncLibraries({
    keepBroken = false,
  }: { keepBroken?: boolean } = {}): Promise<LibraryReconcileResult> {
    const settings = getSettings();
    let result: LibraryReconcileResult;

    try {
      const libraries = await this.getLibraries();

      const plexLibraries = libraries
        // Remove libraries that are not movie, show or music
        .filter(
          (library) =>
            library.type === 'movie' ||
            library.type === 'show' ||
            library.type === 'artist'
        )
        // Remove libraries that do not have a metadata agent set (usually personal video libraries)
        .filter((library) => library.agent !== 'com.plexapp.agents.none')
        .map(
          (library): Pick<Library, 'id' | 'name' | 'type'> => ({
            id: library.key,
            name: library.title,
            type: library.type === 'artist' ? 'music' : library.type,
          })
        );

      result = reconcileLibraries(settings.plex.libraries, plexLibraries, {
        keepBroken,
      });

      settings.plex.libraries = result.libraries;
    } catch (e) {
      logger.error('Failed to fetch Plex libraries', {
        label: 'Plex API',
        ...requestErrorLogFields(e, { service: 'Plex' }),
      });

      if (!e.response) {
        throw new ApiError(502, ApiErrorCode.ConnectionError);
      }

      throw new ApiError(e.response.status, ApiErrorCode.Unknown);
    }

    result.remapped.forEach(({ from, to, match }) => {
      logger.info(
        `Plex library "${from.name}" moved from id ${from.id} to "${to.name}" (id ${to.id})`,
        { label: 'Plex API', match }
      );
    });

    result.broken.forEach((library) => {
      logger.warn(
        `Enabled Plex library "${library.name}" (id ${library.id}) was not found in Plex and has no clear match. Choose it again in the Plex settings.`,
        { label: 'Plex API' }
      );
    });

    await settings.save();

    return result;
  }

  public async getLibraryContents(
    id: string,
    {
      offset = 0,
      size = 50,
      type,
    }: { offset?: number; size?: number; type?: 'album' } = {}
  ): Promise<{ totalSize: number; items: PlexLibraryItem[] }> {
    // Music libraries list artists by default, albums are asked for by type
    const response = await this.get<PlexLibraryResponse>(
      `/library/sections/${id}/all?includeGuids=1${type === 'album' ? '&type=9' : ''}`,
      {
        headers: {
          'X-Plex-Container-Start': `${offset}`,
          'X-Plex-Container-Size': `${size}`,
        },
      }
    );

    return {
      totalSize: response.MediaContainer.totalSize,
      items: response.MediaContainer.Metadata ?? [],
    };
  }

  public async getMetadata(
    key: string,
    options: { includeChildren?: boolean } = {}
  ): Promise<PlexMetadata> {
    const response = await this.get<PlexMetadataResponse>(
      `/library/metadata/${key}${
        options.includeChildren ? '?includeChildren=1' : ''
      }`
    );

    return response.MediaContainer.Metadata[0];
  }

  public async getChildrenMetadata(key: string): Promise<PlexMetadata[]> {
    const response = await this.get<PlexMetadataResponse>(
      `/library/metadata/${key}/children`
    );

    return response.MediaContainer.Metadata;
  }

  public async getRecentlyAdded(
    id: string,
    options: { addedAt: number } = {
      addedAt: Date.now() - 1000 * 60 * 60,
    },
    mediaType: 'movie' | 'show' | 'music'
  ): Promise<PlexLibraryItem[]> {
    // Music is queried as albums, whose guids hold the MusicBrainz id
    const typeCode =
      mediaType === 'show' ? '4' : mediaType === 'music' ? '9' : '1';
    const response = await this.get<PlexLibraryResponse>(
      `/library/sections/${id}/all?type=${typeCode}${
        // Shows are queried as episodes, whose guids the scanner never reads.
        mediaType !== 'show' ? '&includeGuids=1' : ''
      }&sort=addedAt%3Adesc&addedAt>>=${Math.floor(options.addedAt / 1000)}`,
      {
        headers: {
          'X-Plex-Container-Start': '0',
          'X-Plex-Container-Size': '500',
        },
      }
    );

    return response.MediaContainer.Metadata;
  }

  /**
   * A library's movies or shows with the view state the token's own account
   * has (play counts, episodes seen, where a movie was left). `since` (unix
   * seconds) keeps it to titles viewed from then on.
   */
  public async getViewState(
    sectionId: string,
    type: 'movie' | 'show' | 'episode',
    {
      offset = 0,
      size = 500,
      since,
    }: { offset?: number; size?: number; since?: number } = {}
  ): Promise<{ totalSize: number; items: PlexViewItem[] }> {
    const typeCode = type === 'show' ? 2 : type === 'episode' ? 4 : 1;
    const response = await this.get<PlexViewResponse>(
      `/library/sections/${sectionId}/all?type=${typeCode}` +
        VIEW_STATE_SLIM +
        (since ? `&lastViewedAt>>=${since}` : ''),
      {
        headers: {
          'X-Plex-Container-Start': `${offset}`,
          'X-Plex-Container-Size': `${size}`,
        },
      }
    );

    return {
      totalSize: response.MediaContainer.totalSize ?? 0,
      items: response.MediaContainer.Metadata ?? [],
    };
  }

  /** Every episode of a show with the token's own view fields */
  public async getAllLeaves(showRatingKey: string): Promise<PlexViewItem[]> {
    const response = await this.get<PlexViewResponse>(
      `/library/metadata/${showRatingKey}/allLeaves?${VIEW_STATE_SLIM.slice(1)}`
    );

    return response.MediaContainer.Metadata ?? [];
  }

  /**
   * Plex's own Continue Watching for the token's account: movies left part
   * way and the next episode of each show in progress
   */
  public async getOnDeck(): Promise<PlexViewItem[]> {
    const response = await this.get<PlexViewResponse>(
      `/library/onDeck?${VIEW_STATE_SLIM.slice(1)}`
    );

    return response.MediaContainer.Metadata ?? [];
  }

  /**
   * Marks an item (a movie, show, season or episode) watched or unwatched
   * for the token's own account. Marking a show marks every episode.
   */
  public async setWatched(ratingKey: string, watched: boolean): Promise<void> {
    await this.axios.get(watched ? '/:/scrobble' : '/:/unscrobble', {
      params: { identifier: 'com.plexapp.plugins.library', key: ratingKey },
    });
  }
}

/**
 * Asks a Plex address who it is, for testing a connection before it is
 * saved
 */
export const plexStatusProbe =
  (plexToken?: string | null): PlexProbe =>
  async (address, { timeout }) => {
    const settings = getSettings();
    const client = new PlexAPI({
      plexToken,
      plexSettings: { ...settings.plex, ...address },
      timeout,
    });
    const status = await client.getStatus();

    if (!status?.MediaContainer?.machineIdentifier) {
      throw new Error(
        `${plexAddressUrl(address)} answered, but it is not a Plex server`
      );
    }

    return {
      machineId: status.MediaContainer.machineIdentifier,
      name: status.MediaContainer.friendlyName,
    };
  };

export default PlexAPI;
