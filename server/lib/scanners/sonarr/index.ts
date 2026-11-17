import { getMetadataProvider } from '@server/api/metadata';
import type { SonarrSeries } from '@server/api/servarr/sonarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import TheMovieDb from '@server/api/themoviedb';
import { ANIME_KEYWORD_ID } from '@server/api/themoviedb/constants';
import type {
  TmdbKeyword,
  TmdbTvDetails,
  TmdbTvScanDetails,
} from '@server/api/themoviedb/interfaces';
import {
  MediaRequestMonitorMode,
  MediaRequestStatus,
  MediaStatus,
  MediaType,
  SeasonRolloverStatus,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import Season from '@server/entity/Season';
import SeasonRequest from '@server/entity/SeasonRequest';
import SeasonRollover from '@server/entity/SeasonRollover';
import { planCurrentSeasonRollover } from '@server/lib/currentSeasonRollover';
import { isPartialSeriesRequest } from '@server/lib/episodeRequests';
import type {
  ProcessableSeason,
  RunnableScanner,
  StatusBase,
} from '@server/lib/scanners/baseScanner';
import BaseScanner from '@server/lib/scanners/baseScanner';
import {
  decideRolloverAction,
  getHeldSeasons,
  getPreexistingSeasons,
  getRollOffSeasons,
  getStatusAfterRollOff,
  limitRollOff,
  splitRolloverSeasons,
} from '@server/lib/seasonRollover';
import { sendSeasonRolloverNotification } from '@server/lib/seasonRolloverActions';
import type { SonarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { requestErrorLogFields } from '@server/utils/requestError';
import { uniqWith } from 'lodash';
import { In } from 'typeorm';

type SyncStatus = StatusBase & {
  currentServer: SonarrSettings;
  servers: SonarrSettings[];
};

class SonarrScanner
  extends BaseScanner<SonarrSeries>
  implements RunnableScanner<SyncStatus>
{
  protected declineRequestsOnStatusReset = true;
  private servers: SonarrSettings[];
  private currentServer: SonarrSettings;
  private sonarrApi: SonarrAPI;
  private scannedTvdbIds: Set<number> = new Set();
  private scanned4kTvdbIds: Set<number> = new Set();
  // Season numbers keyed on tmdbId, as media.tvdbId can be null. Excludes unmonitored seasons.
  private processingTmdbIds: Map<number, Set<number>> = new Map();
  private processing4kTmdbIds: Map<number, Set<number>> = new Map();
  // A lookup can fail before its tmdbId is known, so failures are matched through other servers' lookups.
  private failedTvdbIds: Set<number> = new Set();
  private failed4kTvdbIds: Set<number> = new Set();
  private tmdbIdsByTvdbId: Map<number, number> = new Map();
  private didScanStandard = false;
  private didScan4k = false;
  private serverReturnedEmpty = false;
  private server4kReturnedEmpty = false;

  constructor() {
    super('Sonarr Scan', {
      bundleSize: 50,
      jobId: 'sonarr-scan',
      service: 'sonarr',
    });
  }

  public status(): SyncStatus {
    return {
      running: this.running,
      progress: this.progress,
      total: this.items.length,
      currentServer: this.currentServer,
      servers: this.servers,
    };
  }

  public async run(): Promise<void> {
    const settings = getSettings();
    const sessionId = this.startRun();
    this.scannedTvdbIds.clear();
    this.scanned4kTvdbIds.clear();
    this.processingTmdbIds.clear();
    this.processing4kTmdbIds.clear();
    this.failedTvdbIds.clear();
    this.failed4kTvdbIds.clear();
    this.tmdbIdsByTvdbId.clear();
    this.didScanStandard = false;
    this.didScan4k = false;
    this.serverReturnedEmpty = false;
    this.server4kReturnedEmpty = false;

    try {
      this.servers = uniqWith(settings.sonarr, (sonarrA, sonarrB) => {
        return (
          sonarrA.hostname === sonarrB.hostname &&
          sonarrA.port === sonarrB.port &&
          sonarrA.baseUrl === sonarrB.baseUrl
        );
      });

      for (const server of this.servers) {
        this.currentServer = server;
        if (server.syncEnabled) {
          this.log(
            `Beginning to process Sonarr server: ${server.name}`,
            'info'
          );

          this.sonarrApi = new SonarrAPI({
            apiKey: server.apiKey,
            url: SonarrAPI.buildUrl(server, '/api/v3'),
          });

          this.items = await this.sonarrApi.getSeries();

          const server4k = this.enable4kShow && server.is4k;
          if (server4k) {
            this.didScan4k = true;
          } else {
            this.didScanStandard = true;
          }

          if (this.items.length === 0) {
            if (server4k) {
              this.server4kReturnedEmpty = true;
            } else {
              this.serverReturnedEmpty = true;
            }
            this.log(
              `Sonarr server ${server.name} returned no series. Orphan cleanup for this profile type will be skipped.`,
              'warn'
            );
          }

          await this.loop(this.processSonarrSeries.bind(this), { sessionId });
        } else {
          this.log(`Sync not enabled. Skipping Sonarr server: ${server.name}`);
        }
      }

      // Only run cleanup if all servers of this profile type have sync enabled.
      // If any server is skipped, we can't distinguish truly orphaned media from
      // media that exists on an unscanned server (e.g. separate instances for
      // anime, regional content, or different languages).
      const allStandardScanned = this.servers
        .filter((s) => !this.enable4kShow || !s.is4k)
        .every((s) => s.syncEnabled);
      const all4kScanned = this.servers
        .filter((s) => this.enable4kShow && s.is4k)
        .every((s) => s.syncEnabled);

      if (!allStandardScanned) {
        this.didScanStandard = false;
      }
      if (!all4kScanned) {
        this.didScan4k = false;
      }

      if (this.serverReturnedEmpty) {
        this.didScanStandard = false;
      }
      if (this.server4kReturnedEmpty) {
        this.didScan4k = false;
      }

      await this.resolveStatusResets((media, is4k, seasonNumber) => {
        const scanComplete = is4k ? this.didScan4k : this.didScanStandard;
        const failedToScan = [
          ...(is4k ? this.failed4kTvdbIds : this.failedTvdbIds),
        ].some((tvdbId) => this.tmdbIdsByTvdbId.get(tvdbId) === media.tmdbId);
        const processingIds = is4k
          ? this.processing4kTmdbIds
          : this.processingTmdbIds;

        return (
          scanComplete &&
          !failedToScan &&
          (seasonNumber === undefined
            ? !processingIds.has(media.tmdbId)
            : !processingIds.get(media.tmdbId)?.has(seasonNumber))
        );
      });

      await this.cleanupOrphanedShows();
      this.log('Sonarr scan complete', 'info');
      this.scanSucceeded();
    } catch (e) {
      this.scanFailed(e);
    } finally {
      this.endRun(sessionId);
    }
  }

  private async processSonarrSeries(sonarrSeries: SonarrSeries) {
    const server4k = this.enable4kShow && this.currentServer.is4k;
    if (server4k) {
      this.scanned4kTvdbIds.add(sonarrSeries.tvdbId);
    } else {
      this.scannedTvdbIds.add(sonarrSeries.tvdbId);
    }

    try {
      const mediaRepository = getRepository(Media);
      const processableSeasons: ProcessableSeason[] = [];
      let tvShow: TmdbTvScanDetails | TmdbTvDetails;

      const media = await mediaRepository.findOne({
        where: { tvdbId: sonarrSeries.tvdbId },
      });

      if (!media || !media.tmdbId) {
        tvShow = await this.tmdb.getShowByTvdbIdForScan({
          tvdbId: sonarrSeries.tvdbId,
        });
      } else {
        tvShow = await this.tmdb.getTvShowForScan({ tvId: media.tmdbId });
      }

      const tmdbId = tvShow.id;
      this.tmdbIdsByTvdbId.set(sonarrSeries.tvdbId, tmdbId);
      const metadataProvider = tvShow.keywords.results.some(
        (keyword: TmdbKeyword) => keyword.id === ANIME_KEYWORD_ID
      )
        ? await getMetadataProvider('anime')
        : await getMetadataProvider('tv');

      if (!(metadataProvider instanceof TheMovieDb)) {
        tvShow = await metadataProvider.getTvShow({ tvId: tmdbId });
      }

      const settings = getSettings();

      // Seasons of episode and future only requests leave the Sonarr season
      // unmonitored, so they count as processing until the files arrive
      const partialRequests = await this.getPartialRequests(tmdbId, server4k);
      const partialSeasons = new Set(
        partialRequests.flatMap((request) =>
          request.seasons.map((season) => season.seasonNumber)
        )
      );

      const filteredSeasons = tvShow.seasons
        .filter(
          (sn) => settings.main.enableSpecialEpisodes || sn.season_number !== 0
        )
        .map((season) => {
          const sonarrSeason = sonarrSeries.seasons.find(
            (s) => s.seasonNumber === season.season_number
          );
          if (!sonarrSeason) {
            return {
              seasonNumber: season.season_number,
              episodeCount: season.episode_count,
              monitored: false,
              statistics: {
                episodeFileCount: 0,
                totalEpisodeCount: season.episode_count,
              },
            };
          } else {
            return sonarrSeason;
          }
        });

      for (const season of filteredSeasons) {
        const totalAvailableEpisodes = season.statistics?.episodeFileCount ?? 0;

        processableSeasons.push({
          seasonNumber: season.seasonNumber,
          episodes: !server4k ? totalAvailableEpisodes : 0,
          episodes4k: server4k ? totalAvailableEpisodes : 0,
          totalEpisodes: season.statistics?.totalEpisodeCount ?? 0,
          processing:
            (season.monitored || partialSeasons.has(season.seasonNumber)) &&
            totalAvailableEpisodes === 0,
          is4kOverride: server4k,
        });
      }

      const processing = server4k
        ? this.processing4kTmdbIds
        : this.processingTmdbIds;

      for (const season of processableSeasons) {
        if (season.processing) {
          processing.set(
            tmdbId,
            (processing.get(tmdbId) ?? new Set<number>()).add(
              season.seasonNumber
            )
          );
        }
      }

      await this.processShow(tmdbId, sonarrSeries.tvdbId, processableSeasons, {
        serviceId: this.currentServer.id,
        externalServiceId: sonarrSeries.id,
        externalServiceSlug: sonarrSeries.titleSlug,
        title: sonarrSeries.title,
        is4k: server4k,
      });

      let hasMovedRequests = false;

      if (sonarrSeries.id) {
        try {
          hasMovedRequests = await this.rollCurrentSeason(
            tmdbId,
            sonarrSeries,
            server4k
          );
        } catch (e) {
          this.log('Failed to roll over the current season', 'error', {
            ...requestErrorLogFields(e),
            title: sonarrSeries.title,
          });
        }
      }

      if ((partialRequests.length > 0 || hasMovedRequests) && sonarrSeries.id) {
        // Read again, as moving a request to a new season reopens it
        await this.completePartialRequests(
          await this.getPartialRequests(tmdbId, server4k),
          sonarrSeries.id
        );
      }
    } catch (e) {
      (server4k ? this.failed4kTvdbIds : this.failedTvdbIds).add(
        sonarrSeries.tvdbId
      );
      this.log('Failed to process Sonarr media', 'error', {
        ...requestErrorLogFields(e),
        title: sonarrSeries.title,
      });
    }
  }

  private async getPartialRequests(
    tmdbId: number,
    is4k: boolean
  ): Promise<MediaRequest[]> {
    const requests = await getRepository(MediaRequest).find({
      where: {
        media: { tmdbId, mediaType: MediaType.TV },
        is4k,
        status: MediaRequestStatus.APPROVED,
      },
    });

    return requests.filter((request) => isPartialSeriesRequest(request));
  }

  /**
   * Seasons only fill up for whole season requests, so episode and future only
   * requests are completed here from the episode files Sonarr reports.
   *
   * - An episode request is done once every requested episode has a file.
   * - A season of a future only or current season request is done once it
   *   has finished airing and every monitored episode has a file.
   */
  private async completePartialRequests(
    requests: MediaRequest[],
    seriesId: number
  ): Promise<void> {
    const requestRepository = getRepository(MediaRequest);
    const seasonRequestRepository = getRepository(SeasonRequest);
    const episodes = await this.sonarrApi.getEpisodes(seriesId);
    const now = new Date();

    for (const { id } of requests) {
      // Read it again, the scan may have completed whole seasons already
      const request = await requestRepository.findOne({ where: { id } });

      if (!request || request.status !== MediaRequestStatus.APPROVED) {
        continue;
      }

      for (const season of request.seasons) {
        if (season.status === MediaRequestStatus.COMPLETED) {
          continue;
        }

        const seasonEpisodes = episodes.filter(
          (episode) => episode.seasonNumber === season.seasonNumber
        );

        const isDone = season.episodes?.length
          ? season.episodes.every((episodeNumber) =>
              seasonEpisodes.some(
                (episode) =>
                  episode.episodeNumber === episodeNumber && episode.hasFile
              )
            )
          : (request.monitorMode === MediaRequestMonitorMode.FUTURE ||
              request.monitorMode === MediaRequestMonitorMode.CURRENT) &&
            seasonEpisodes.length > 0 &&
            seasonEpisodes.every(
              (episode) =>
                !!episode.airDateUtc && new Date(episode.airDateUtc) <= now
            ) &&
            seasonEpisodes.every(
              (episode) => !episode.monitored || episode.hasFile
            );

        if (isDone) {
          // Saved on its own, as saving an approved request sends it to Sonarr again
          season.status = MediaRequestStatus.COMPLETED;
          await seasonRequestRepository.save(season);
        }
      }

      if (
        request.seasons.every(
          (season) => season.status === MediaRequestStatus.COMPLETED
        )
      ) {
        request.status = MediaRequestStatus.COMPLETED;
        await requestRepository.save(request);
        this.log(
          `Completed request ${request.id} from Sonarr episode files`,
          'debug'
        );
      }
    }
  }

  /**
   * Keeps only the current season of a series that is requested that way:
   * Sonarr follows the current and later seasons, and once a newer season has
   * an aired episode with a file, the older seasons are unmonitored and their
   * files deleted. See planCurrentSeasonRollover for the safety rules.
   *
   * Deleting waits for a notice period, during which admins can keep the
   * seasons, and seasons that were already there before the request are only
   * deleted once an admin approves it. See decideRolloverAction.
   *
   * Returns true when requests were moved to the new season.
   */
  private async rollCurrentSeason(
    tmdbId: number,
    sonarrSeries: SonarrSeries,
    is4k: boolean
  ): Promise<boolean> {
    const seriesId = sonarrSeries.id;
    const title = sonarrSeries.title;

    if (!seriesId) {
      return false;
    }

    const media = await getRepository(Media).findOne({
      where: { tmdbId, mediaType: MediaType.TV },
    });

    if (!media) {
      return false;
    }

    const requests = await getRepository(MediaRequest).find({
      where: { media: { id: media.id }, is4k },
    });

    if (
      !requests.some(
        (request) => request.monitorMode === MediaRequestMonitorMode.CURRENT
      )
    ) {
      return false;
    }

    const episodes = await this.sonarrApi.getEpisodes(seriesId);
    const plan = planCurrentSeasonRollover({
      requests,
      episodes,
      sonarrSeasons: sonarrSeries.seasons,
      mediaSeasons: media.seasons,
      is4k,
    });

    if (plan.currentSeason === null) {
      this.log(`Not following the current season of ${title}`, 'debug', {
        reason: plan.skipReason,
      });
      return false;
    }

    if (
      plan.seasonsToMonitor.length > 0 ||
      plan.seasonsToUnmonitor.length > 0 ||
      sonarrSeries.monitorNewItems !== 'all'
    ) {
      await this.sonarrApi.updateSeasonMonitoring(seriesId, {
        monitor: plan.seasonsToMonitor,
        unmonitor: plan.seasonsToUnmonitor,
        monitorNewSeasons: true,
      });
    }

    if (plan.episodeIdsToMonitor.length > 0) {
      await this.sonarrApi.monitorEpisodes(plan.episodeIdsToMonitor);
    }

    if (
      plan.episodeIdsToSearch.length > 0 &&
      !this.currentServer.preventSearch
    ) {
      await this.sonarrApi.searchEpisodes(plan.episodeIdsToSearch);
    }

    const { rollOff } = plan;

    if (!rollOff) {
      if (plan.skipReason) {
        this.log(
          `Keeping the older seasons of ${title} for now (season ${plan.currentSeason})`,
          'debug',
          { reason: plan.skipReason }
        );
      }
      return false;
    }

    // Unmonitored right away, so Sonarr does not search again for the older
    // seasons. Deleting them waits for the notice period.
    if (rollOff.episodeIdsToUnmonitor.length > 0) {
      await this.sonarrApi.unmonitorEpisodes(rollOff.episodeIdsToUnmonitor);
    }

    const currentSeason = plan.currentSeason;
    const rolloverRepository = getRepository(SeasonRollover);
    const seasons = getRollOffSeasons(rollOff, episodes);
    let rollover = await rolloverRepository.findOne({
      where: { media: { id: media.id }, is4k, currentSeason },
      order: { id: 'DESC' },
    });
    let decision = decideRolloverAction({
      existing: rollover,
      now: new Date(),
      seasons,
    });

    if (decision.action === 'notify') {
      rollover = await this.createSeasonRollover(
        media,
        is4k,
        currentSeason,
        seasons,
        requests
      );
      sendSeasonRolloverNotification(rollover, title);
      this.log(
        `Season ${currentSeason} of ${title} has started. Season(s) ${seasons.join(', ')} are scheduled for deletion`,
        'info',
        {
          seasons: rollover.seasons,
          preexistingSeasons: rollover.preexistingSeasons,
          deleteAfter: rollover.deleteAfter,
        }
      );
      // A notice period of zero days deletes right away
      decision = decideRolloverAction({
        existing: rollover,
        now: new Date(),
        seasons,
      });
    }

    if (decision.action === 'wait' || decision.action === 'notify') {
      this.log(
        `Waiting for the notice period before rolling off the older seasons of ${title}`,
        'debug',
        { deleteAfter: rollover?.deleteAfter }
      );
      return false;
    }

    const approved = limitRollOff(rollOff, episodes, decision.deleteSeasons);

    if (approved.episodeFileIds.length > 0) {
      this.log(
        `Season ${currentSeason} of ${title} has started. Deleting ${approved.episodeFileIds.length} episode file(s) of season(s) ${decision.deleteSeasons.join(', ')}`,
        'info',
        {
          seriesId,
          is4k,
          seasons: decision.deleteSeasons,
          episodeFileIds: approved.episodeFileIds,
        }
      );
      await this.sonarrApi.deleteEpisodeFiles(approved.episodeFileIds);
    }

    if (approved.seasonsToMarkDeleted.length > 0) {
      const statusKey = is4k ? 'status4k' : 'status';
      const markedSeasons = media.seasons.filter((season) =>
        approved.seasonsToMarkDeleted.includes(season.seasonNumber)
      );

      for (const season of markedSeasons) {
        season[statusKey] = MediaStatus.DELETED;
      }

      await getRepository(Season).save(markedSeasons);
      this.log(
        `Marked ${is4k ? '4K ' : ''}season(s) ${approved.seasonsToMarkDeleted.join(', ')} of ${title} as deleted`,
        'info'
      );
    }

    for (const requestId of rollOff.requestIdsToMove) {
      await this.moveCurrentSeasonRequest(requestId, currentSeason);
      this.log(
        `Moved current season request ${requestId} of ${title} to season ${currentSeason}`,
        'info'
      );
    }

    if (rollover?.status === SeasonRolloverStatus.PENDING) {
      rollover.status = getStatusAfterRollOff(rollover);
      await rolloverRepository.save(rollover);
    }

    return rollOff.requestIdsToMove.length > 0;
  }

  /**
   * Records a new roll off and when it may go ahead. Seasons that were there
   * before the request, or that an admin kept on an earlier roll off, are
   * held for review. An open notice for an earlier season is replaced, as
   * this one covers its seasons too.
   */
  private async createSeasonRollover(
    media: Media,
    is4k: boolean,
    currentSeason: number,
    seasons: number[],
    requests: MediaRequest[]
  ): Promise<SeasonRollover> {
    const rolloverRepository = getRepository(SeasonRollover);
    const delayDays = Math.max(
      0,
      getSettings().main.currentSeasonRolloverDelayDays ?? 3
    );
    const keptRollovers = await rolloverRepository.find({
      where: {
        media: { id: media.id },
        is4k,
        status: SeasonRolloverStatus.KEPT,
      },
    });

    await rolloverRepository.remove(
      await rolloverRepository.find({
        where: {
          media: { id: media.id },
          is4k,
          status: In([
            SeasonRolloverStatus.PENDING,
            SeasonRolloverStatus.REVIEW,
          ]),
        },
      })
    );

    return rolloverRepository.save(
      new SeasonRollover({
        media,
        is4k,
        currentSeason,
        ...splitRolloverSeasons(
          seasons,
          getHeldSeasons(getPreexistingSeasons(requests, is4k), keptRollovers)
        ),
        deletePreexisting: false,
        deleteAfter: new Date(Date.now() + delayDays * 24 * 60 * 60 * 1000),
        status: SeasonRolloverStatus.PENDING,
      })
    );
  }

  /**
   * Points a current season request at the new season. A completed request is
   * reopened until the new season is in. Saved without the request
   * subscribers, as the scan already did what sending it to Sonarr would do.
   */
  private async moveCurrentSeasonRequest(
    requestId: number,
    seasonNumber: number
  ): Promise<void> {
    const requestRepository = getRepository(MediaRequest);
    const seasonRequestRepository = getRepository(SeasonRequest);
    const request = await requestRepository.findOne({
      where: { id: requestId },
    });

    if (!request) {
      return;
    }

    const staleSeasons = request.seasons.filter(
      (season) => season.seasonNumber !== seasonNumber
    );

    if (staleSeasons.length > 0) {
      await seasonRequestRepository.remove(staleSeasons);
    }

    if (
      !request.seasons.some((season) => season.seasonNumber === seasonNumber)
    ) {
      await seasonRequestRepository.save(
        new SeasonRequest({
          seasonNumber,
          episodes: null,
          status:
            request.status === MediaRequestStatus.PENDING
              ? MediaRequestStatus.PENDING
              : MediaRequestStatus.APPROVED,
          request: { id: request.id } as MediaRequest,
        })
      );
    }

    if (request.status === MediaRequestStatus.COMPLETED) {
      await requestRepository
        .createQueryBuilder()
        .update(MediaRequest)
        .set({ status: MediaRequestStatus.APPROVED })
        .where('id = :id', { id: request.id })
        .callListeners(false)
        .execute();
    }
  }

  private async existsInAnyServer(
    tvdbId: number,
    is4k: boolean
  ): Promise<boolean> {
    const servers = this.servers.filter(
      (server) =>
        server.syncEnabled && (this.enable4kShow && server.is4k) === is4k
    );

    for (const server of servers) {
      try {
        const api = new SonarrAPI({
          apiKey: server.apiKey,
          url: SonarrAPI.buildUrl(server, '/api/v3'),
        });
        const series = await api.getLibrarySeriesByTvdbId(tvdbId);

        if (series.some((show) => show.tvdbId === tvdbId)) {
          return true;
        }
      } catch (e) {
        this.log(
          `Could not confirm series ${tvdbId} against Sonarr server ${server.name}. Skipping cleanup for it.`,
          'warn',
          requestErrorLogFields(e)
        );
        return true;
      }
    }

    return false;
  }

  private async cleanupOrphanedShows(): Promise<void> {
    const mediaRepository = getRepository(Media);

    if (this.didScanStandard) {
      const processingShows = await mediaRepository.find({
        where: { mediaType: MediaType.TV, status: MediaStatus.PROCESSING },
        relations: { seasons: true, requests: true },
      });

      for (const media of processingShows) {
        if (media.tvdbId && !this.scannedTvdbIds.has(media.tvdbId)) {
          if (await this.existsInAnyServer(media.tvdbId, false)) {
            continue;
          }

          media.status = MediaStatus.UNKNOWN;
          for (const season of media.seasons) {
            if (season.status === MediaStatus.PROCESSING) {
              season.status = MediaStatus.UNKNOWN;
            }
          }
          await mediaRepository.save(media);
          await this.declineOrphanedRequests(media, false);
          this.log(
            `Show ${media.tmdbId} (tvdb: ${media.tvdbId}) not found in any Sonarr server. Status reset to UNKNOWN.`,
            'info'
          );
        }
      }
    } else {
      this.log(
        'Skipping orphaned show cleanup: no standard Sonarr servers were scanned.',
        'info'
      );
    }

    if (this.didScan4k) {
      const processing4kShows = await mediaRepository.find({
        where: { mediaType: MediaType.TV, status4k: MediaStatus.PROCESSING },
        relations: { seasons: true, requests: true },
      });

      for (const media of processing4kShows) {
        if (media.tvdbId && !this.scanned4kTvdbIds.has(media.tvdbId)) {
          if (await this.existsInAnyServer(media.tvdbId, true)) {
            continue;
          }

          media.status4k = MediaStatus.UNKNOWN;
          for (const season of media.seasons) {
            if (season.status4k === MediaStatus.PROCESSING) {
              season.status4k = MediaStatus.UNKNOWN;
            }
          }
          await mediaRepository.save(media);
          await this.declineOrphanedRequests(media, true);
          this.log(
            `Show ${media.tmdbId} (tvdb: ${media.tvdbId}) not found in any 4K Sonarr server. 4K status reset to UNKNOWN.`,
            'info'
          );
        }
      }
    } else if (this.enable4kShow) {
      this.log(
        'Skipping orphaned 4K show cleanup: no 4K Sonarr servers were scanned.',
        'info'
      );
    }
  }
}

export const sonarrScanner = new SonarrScanner();
