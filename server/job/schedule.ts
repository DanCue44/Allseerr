import { usesChaptarr } from '@server/constants/bookService';
import { MediaServerType } from '@server/constants/server';
import blocklistedTagsProcessor from '@server/job/blocklistedTagsProcessor';
import followedReleases from '@server/job/followedReleases';
import recentlyAddedNewsletter from '@server/job/newsletter';
import availabilitySync from '@server/lib/availabilitySync';
import downloadTracker from '@server/lib/downloadtracker';
import ImageProxy from '@server/lib/imageproxy';
import {
  isDirectoryJobRunning,
  runDirectoryJob,
} from '@server/lib/nobookendsDirectory';
import { cleanUpOidcPayloads } from '@server/lib/oidc/adapter';
import refreshToken from '@server/lib/refreshToken';
import {
  chaptarrRecentScanner,
  chaptarrScanner,
} from '@server/lib/scanners/chaptarr';
import {
  jellyfinFullScanner,
  jellyfinRecentScanner,
} from '@server/lib/scanners/jellyfin';
import { lazyLibrarianScanner } from '@server/lib/scanners/lazylibrarian';
import { lidarrScanner } from '@server/lib/scanners/lidarr';
import { plexFullScanner, plexRecentScanner } from '@server/lib/scanners/plex';
import { radarrScanner } from '@server/lib/scanners/radarr';
import { sonarrScanner } from '@server/lib/scanners/sonarr';
import type { JobId } from '@server/lib/settings';
import { getSettings, resolveBookService } from '@server/lib/settings';
import { isSyncRunning, syncEveryone } from '@server/lib/userAccess';
import watchedSync from '@server/lib/watchedsync';
import watchlistSync from '@server/lib/watchlistsync';
import logger from '@server/logger';
import schedule from 'node-schedule';

interface ScheduledJob {
  id: JobId;
  job: schedule.Job;
  name: string;
  type: 'process' | 'command';
  interval: 'seconds' | 'minutes' | 'hours' | 'days' | 'fixed';
  cronSchedule: string;
  running?: () => boolean;
  cancelFn?: () => void;
  // Whether the service the job works with is set up. Jobs for services that
  // are not (a LazyLibrarian scan with Chaptarr as the book service, say) do
  // nothing, so the Jobs page leaves them out. Checked each time the list is
  // read, so a service set up later shows its jobs without a restart.
  inUse?: () => boolean;
  // What a running job is doing, for the Jobs page
  progress?: () => JobProgress | undefined;
}

export interface JobProgress {
  step: string;
  done?: number;
  total?: number;
}

const hasArr = () => {
  const settings = getSettings();
  return (
    settings.radarr.length > 0 ||
    settings.sonarr.length > 0 ||
    settings.lidarr.length > 0 ||
    usesChaptarr(resolveBookService(settings))
  );
};

export const scheduledJobs: ScheduledJob[] = [];

export const startJobs = (): void => {
  const jobs = getSettings().jobs;
  const mediaServerType = getSettings().main.mediaServerType;

  if (mediaServerType === MediaServerType.PLEX) {
    // Run recently added plex scan every 5 minutes
    scheduledJobs.push({
      id: 'plex-recently-added-scan',
      name: 'Plex Recently Added Scan',
      type: 'process',
      interval: 'minutes',
      cronSchedule: jobs['plex-recently-added-scan'].schedule,
      job: schedule.scheduleJob(
        jobs['plex-recently-added-scan'].schedule,
        () => {
          logger.info('Starting scheduled job: Plex Recently Added Scan', {
            label: 'Jobs',
          });
          plexRecentScanner.run();
        }
      ),
      running: () => plexRecentScanner.status().running,
      cancelFn: () => plexRecentScanner.cancel(),
    });

    // Run full plex scan every 24 hours
    scheduledJobs.push({
      id: 'plex-full-scan',
      name: 'Plex Full Library Scan',
      type: 'process',
      interval: 'hours',
      cronSchedule: jobs['plex-full-scan'].schedule,
      job: schedule.scheduleJob(jobs['plex-full-scan'].schedule, () => {
        logger.info('Starting scheduled job: Plex Full Library Scan', {
          label: 'Jobs',
        });
        plexFullScanner.run();
      }),
      running: () => plexFullScanner.status().running,
      cancelFn: () => plexFullScanner.cancel(),
    });

    scheduledJobs.push({
      id: 'plex-refresh-token',
      name: 'Plex Refresh Token',
      type: 'process',
      interval: 'fixed',
      cronSchedule: jobs['plex-refresh-token'].schedule,
      job: schedule.scheduleJob(jobs['plex-refresh-token'].schedule, () => {
        logger.info('Starting scheduled job: Plex Refresh Token', {
          label: 'Jobs',
        });
        refreshToken.run();
      }),
    });

    // Watchlist Sync
    scheduledJobs.push({
      id: 'plex-watchlist-sync',
      name: 'Plex Watchlist Sync',
      type: 'process',
      interval: 'minutes',
      cronSchedule: jobs['plex-watchlist-sync'].schedule,
      job: schedule.scheduleJob(jobs['plex-watchlist-sync'].schedule, () => {
        logger.info('Starting scheduled job: Plex Watchlist Sync', {
          label: 'Jobs',
        });
        watchlistSync.syncWatchlist().catch((e) => {
          logger.error('Failed to sync watchlists', {
            label: 'Plex Watchlist Sync',
            errorMessage: e.message,
          });
        });
      }),
    });

    // What each person has watched on Plex
    scheduledJobs.push({
      id: 'plex-watched-sync',
      name: 'Plex Watched Sync',
      type: 'process',
      interval: 'minutes',
      cronSchedule: jobs['plex-watched-sync'].schedule,
      job: schedule.scheduleJob(jobs['plex-watched-sync'].schedule, () => {
        logger.info('Starting scheduled job: Plex Watched Sync', {
          label: 'Jobs',
        });
        watchedSync.sync().catch((e) => {
          logger.error('Failed to sync watched state', {
            label: 'Watched Sync',
            errorMessage: e.message,
          });
        });
      }),
      running: () => watchedSync.status().running,
    });
  } else if (
    mediaServerType === MediaServerType.JELLYFIN ||
    mediaServerType === MediaServerType.EMBY
  ) {
    // Run recently added jellyfin sync every 5 minutes
    scheduledJobs.push({
      id: 'jellyfin-recently-added-scan',
      name: 'Jellyfin Recently Added Scan',
      type: 'process',
      interval: 'minutes',
      cronSchedule: jobs['jellyfin-recently-added-scan'].schedule,
      job: schedule.scheduleJob(
        jobs['jellyfin-recently-added-scan'].schedule,
        () => {
          logger.info('Starting scheduled job: Jellyfin Recently Added Scan', {
            label: 'Jobs',
          });
          jellyfinRecentScanner.run();
        }
      ),
      running: () => jellyfinRecentScanner.status().running,
      cancelFn: () => jellyfinRecentScanner.cancel(),
    });

    // Run full jellyfin sync every 24 hours
    scheduledJobs.push({
      id: 'jellyfin-full-scan',
      name: 'Jellyfin Full Library Scan',
      type: 'process',
      interval: 'hours',
      cronSchedule: jobs['jellyfin-full-scan'].schedule,
      job: schedule.scheduleJob(jobs['jellyfin-full-scan'].schedule, () => {
        logger.info('Starting scheduled job: Jellyfin Full Scan', {
          label: 'Jobs',
        });
        jellyfinFullScanner.run();
      }),
      running: () => jellyfinFullScanner.status().running,
      cancelFn: () => jellyfinFullScanner.cancel(),
    });

    // What each person has watched on Jellyfin or Emby
    scheduledJobs.push({
      id: 'jellyfin-watched-sync',
      name: 'Jellyfin Watched Sync',
      type: 'process',
      interval: 'minutes',
      cronSchedule: jobs['jellyfin-watched-sync'].schedule,
      job: schedule.scheduleJob(jobs['jellyfin-watched-sync'].schedule, () => {
        logger.info('Starting scheduled job: Jellyfin Watched Sync', {
          label: 'Jobs',
        });
        watchedSync.sync().catch((e) => {
          logger.error('Failed to sync watched state', {
            label: 'Watched Sync',
            errorMessage: e.message,
          });
        });
      }),
      running: () => watchedSync.status().running,
    });
  }

  // Run full radarr scan every 24 hours
  scheduledJobs.push({
    id: 'radarr-scan',
    name: 'Radarr Scan',
    type: 'process',
    interval: 'hours',
    cronSchedule: jobs['radarr-scan'].schedule,
    job: schedule.scheduleJob(jobs['radarr-scan'].schedule, () => {
      logger.info('Starting scheduled job: Radarr Scan', { label: 'Jobs' });
      radarrScanner.run();
    }),
    running: () => radarrScanner.status().running,
    cancelFn: () => radarrScanner.cancel(),
    inUse: () => getSettings().radarr.length > 0,
  });

  // Run full sonarr scan every 24 hours
  scheduledJobs.push({
    id: 'sonarr-scan',
    name: 'Sonarr Scan',
    type: 'process',
    interval: 'hours',
    cronSchedule: jobs['sonarr-scan'].schedule,
    job: schedule.scheduleJob(jobs['sonarr-scan'].schedule, () => {
      logger.info('Starting scheduled job: Sonarr Scan', { label: 'Jobs' });
      sonarrScanner.run();
    }),
    running: () => sonarrScanner.status().running,
    cancelFn: () => sonarrScanner.cancel(),
    inUse: () => getSettings().sonarr.length > 0,
  });

  // Run full lidarr scan every 24 hours
  scheduledJobs.push({
    id: 'lidarr-scan',
    name: 'Lidarr Scan',
    type: 'process',
    interval: 'hours',
    cronSchedule: jobs['lidarr-scan'].schedule,
    job: schedule.scheduleJob(jobs['lidarr-scan'].schedule, () => {
      logger.info('Starting scheduled job: Lidarr Scan', { label: 'Jobs' });
      lidarrScanner.run();
    }),
    running: () => lidarrScanner.status().running,
    cancelFn: () => lidarrScanner.cancel(),
    inUse: () => getSettings().lidarr.length > 0,
  });

  // Run LazyLibrarian scan every 30 minutes
  scheduledJobs.push({
    id: 'lazylibrarian-scan',
    name: 'LazyLibrarian Scan',
    type: 'process',
    interval: 'minutes',
    cronSchedule: jobs['lazylibrarian-scan'].schedule,
    job: schedule.scheduleJob(jobs['lazylibrarian-scan'].schedule, () => {
      // A new run would abort the one still going, so a library that takes
      // longer than the interval to scan would never finish
      if (lazyLibrarianScanner.status().running) {
        logger.info(
          'Skipping scheduled job: LazyLibrarian Scan is still running',
          {
            label: 'Jobs',
          }
        );
        return;
      }
      logger.info('Starting scheduled job: LazyLibrarian Scan', {
        label: 'Jobs',
      });
      lazyLibrarianScanner.run();
    }),
    running: () => lazyLibrarianScanner.status().running,
    cancelFn: () => lazyLibrarianScanner.cancel(),
    inUse: () => resolveBookService(getSettings()) === 'lazylibrarian',
  });

  // Checks the books Allseerr is waiting on every 15 minutes
  scheduledJobs.push({
    id: 'chaptarr-scan',
    name: 'Chaptarr Recent Scan',
    type: 'process',
    interval: 'minutes',
    cronSchedule: jobs['chaptarr-scan'].schedule,
    job: schedule.scheduleJob(jobs['chaptarr-scan'].schedule, () => {
      // A new run would abort the one still going, and both scans write the
      // same books. A full scan that has moved on to matching books with
      // OpenLibrary, which can take an hour on a large library, only adds
      // books Allseerr did not have, so the books waited on are still checked.
      const fullScan = chaptarrScanner.status();
      if (
        chaptarrRecentScanner.status().running ||
        (fullScan.running && fullScan.step !== 'openlibrary')
      ) {
        logger.info('Skipping scheduled job: a Chaptarr scan is running', {
          label: 'Jobs',
        });
        return;
      }
      logger.info('Starting scheduled job: Chaptarr Recent Scan', {
        label: 'Jobs',
      });
      chaptarrRecentScanner.run();
    }),
    running: () => chaptarrRecentScanner.status().running,
    cancelFn: () => chaptarrRecentScanner.cancel(),
    inUse: () => usesChaptarr(resolveBookService(getSettings())),
  });

  // Reads the whole Chaptarr library once a day
  scheduledJobs.push({
    id: 'chaptarr-full-scan',
    name: 'Chaptarr Full Scan',
    type: 'process',
    interval: 'hours',
    cronSchedule: jobs['chaptarr-full-scan'].schedule,
    job: schedule.scheduleJob(jobs['chaptarr-full-scan'].schedule, () => {
      // A new run would abort the one still going, so a library that takes
      // longer than the interval to scan would never finish
      if (chaptarrScanner.status().running) {
        logger.info(
          'Skipping scheduled job: Chaptarr Full Scan is still running',
          { label: 'Jobs' }
        );
        return;
      }
      logger.info('Starting scheduled job: Chaptarr Full Scan', {
        label: 'Jobs',
      });
      chaptarrScanner.run();
    }),
    running: () => chaptarrScanner.status().running,
    cancelFn: () => chaptarrScanner.cancel(),
    inUse: () => usesChaptarr(resolveBookService(getSettings())),
    progress: () => {
      const status = chaptarrScanner.status();

      if (!status.running || !status.step) {
        return undefined;
      }

      return status.step === 'openlibrary'
        ? { step: 'openlibrary', ...status.matching }
        : { step: 'library', done: status.progress, total: status.total };
    },
  });

  scheduledJobs.push({
    id: 'availability-sync',
    name: 'Media Availability Sync',
    type: 'process',
    interval: 'hours',
    cronSchedule: jobs['availability-sync'].schedule,
    job: schedule.scheduleJob(jobs['availability-sync'].schedule, () => {
      logger.info('Starting scheduled job: Media Availability Sync', {
        label: 'Jobs',
      });
      availabilitySync.run();
    }),
    running: () => availabilitySync.running,
    cancelFn: () => availabilitySync.cancel(),
  });

  // Run download sync every minute
  scheduledJobs.push({
    id: 'download-sync',
    name: 'Download Sync',
    type: 'command',
    interval: 'seconds',
    cronSchedule: jobs['download-sync'].schedule,
    job: schedule.scheduleJob(jobs['download-sync'].schedule, () => {
      logger.debug('Starting scheduled job: Download Sync', {
        label: 'Jobs',
      });
      downloadTracker.updateDownloads();
    }),
    inUse: hasArr,
  });

  // Reset download sync everyday at 01:00 am
  scheduledJobs.push({
    id: 'download-sync-reset',
    name: 'Download Sync Reset',
    type: 'command',
    interval: 'hours',
    cronSchedule: jobs['download-sync-reset'].schedule,
    job: schedule.scheduleJob(jobs['download-sync-reset'].schedule, () => {
      logger.info('Starting scheduled job: Download Sync Reset', {
        label: 'Jobs',
      });
      downloadTracker.resetDownloadTracker();
    }),
    inUse: hasArr,
  });

  // Run image cache cleanup every 24 hours
  scheduledJobs.push({
    id: 'image-cache-cleanup',
    name: 'Image Cache Cleanup',
    type: 'process',
    interval: 'hours',
    cronSchedule: jobs['image-cache-cleanup'].schedule,
    job: schedule.scheduleJob(jobs['image-cache-cleanup'].schedule, () => {
      logger.info('Starting scheduled job: Image Cache Cleanup', {
        label: 'Jobs',
      });
      // Clean TMDB image cache
      ImageProxy.clearCache('tmdb');

      // Clean users avatar image cache
      ImageProxy.clearCache('avatar');
    }),
  });

  scheduledJobs.push({
    id: 'process-blocklisted-tags',
    name: 'Process Blocklisted Tags',
    type: 'process',
    interval: 'days',
    cronSchedule: jobs['process-blocklisted-tags'].schedule,
    job: schedule.scheduleJob(jobs['process-blocklisted-tags'].schedule, () => {
      logger.info('Starting scheduled job: Process Blocklisted Tags', {
        label: 'Jobs',
      });
      blocklistedTagsProcessor.run();
    }),
    running: () => blocklistedTagsProcessor.status().running,
    cancelFn: () => blocklistedTagsProcessor.cancel(),
  });

  // Send the recently added newsletter on the day and hour set in the email settings
  scheduledJobs.push({
    id: 'recently-added-newsletter',
    name: 'Recently Added Newsletter',
    type: 'process',
    interval: 'fixed',
    cronSchedule: jobs['recently-added-newsletter'].schedule,
    job: schedule.scheduleJob(
      jobs['recently-added-newsletter'].schedule,
      () => {
        logger.info('Starting scheduled job: Recently Added Newsletter', {
          label: 'Jobs',
        });
        recentlyAddedNewsletter.run();
      }
    ),
    running: () => recentlyAddedNewsletter.running,
  });

  // Look up new releases of followed artists and authors once a day
  scheduledJobs.push({
    id: 'followed-releases',
    name: 'Followed Artist and Author Releases',
    type: 'process',
    interval: 'days',
    cronSchedule: jobs['followed-releases'].schedule,
    job: schedule.scheduleJob(jobs['followed-releases'].schedule, () => {
      logger.info(
        'Starting scheduled job: Followed Artist and Author Releases',
        {
          label: 'Jobs',
        }
      );
      followedReleases.run().catch((e) => {
        logger.error('Failed to check followed releases', {
          label: 'Jobs',
          errorMessage: e.message,
        });
      });
    }),
    running: () => followedReleases.running,
    cancelFn: () => followedReleases.cancel(),
  });

  // Keeps the accounts Allseerr manages in other apps in line with each
  // person's access, and links accounts made by signing in with Allseerr
  scheduledJobs.push({
    id: 'user-access-sync',
    name: 'User Access Sync',
    type: 'process',
    interval: 'minutes',
    cronSchedule: jobs['user-access-sync'].schedule,
    job: schedule.scheduleJob(jobs['user-access-sync'].schedule, () => {
      logger.debug('Starting scheduled job: User Access Sync', {
        label: 'Jobs',
      });
      syncEveryone()
        .then(() => cleanUpOidcPayloads())
        .catch((e) => {
          logger.error('Failed to sync user access', {
            label: 'Jobs',
            errorMessage: e.message,
          });
        });
    }),
    running: () => isSyncRunning(),
  });

  // Lists this server in the NoBookEnds directory again once a day while
  // that is on, as the directory drops servers it has not heard from
  scheduledJobs.push({
    id: 'nobookends-directory',
    name: 'NoBookEnds Directory',
    type: 'process',
    interval: 'days',
    cronSchedule: jobs['nobookends-directory'].schedule,
    job: schedule.scheduleJob(jobs['nobookends-directory'].schedule, () => {
      logger.debug('Starting scheduled job: NoBookEnds Directory', {
        label: 'Jobs',
      });
      runDirectoryJob().catch((e) => {
        logger.error('Failed to update the NoBookEnds directory', {
          label: 'Jobs',
          errorMessage: e.message,
        });
      });
    }),
    running: () => isDirectoryJobRunning(),
    inUse: () => !!getSettings().userAccess.nobookendsDirectory,
  });

  logger.info('Scheduled jobs loaded', { label: 'Jobs' });
};
