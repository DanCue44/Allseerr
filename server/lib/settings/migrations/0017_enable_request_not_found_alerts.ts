import type { AllSettings } from '@server/lib/settings';

const MIGRATION = '0017_enable_request_not_found_alerts';

// Notification bits, spelled out so later changes to the enum cannot change
// what this migration did
const MEDIA_DECLINED = 64;
const MEDIA_NOT_FOUND = 16777216;

/**
 * Turns on the new Request Not Found notifications for the agents that
 * already tell requesters their request was declined, so a requester hears
 * when nothing was found once an admin turns the check on. Runs once, so an
 * admin who turns them off again keeps them off.
 */
const enableRequestNotFoundAlerts = (settings: any): AllSettings => {
  if (
    Array.isArray(settings.migrations) &&
    settings.migrations.includes(MIGRATION)
  ) {
    return settings;
  }

  const agents = settings.notifications?.agents ?? {};

  for (const agent of Object.values(agents) as { types?: unknown }[]) {
    if (
      agent &&
      typeof agent.types === 'number' &&
      agent.types & MEDIA_DECLINED
    ) {
      agent.types |= MEDIA_NOT_FOUND;
    }
  }

  if (!Array.isArray(settings.migrations)) {
    settings.migrations = [];
  }

  settings.migrations.push(MIGRATION);

  return settings;
};

export default enableRequestNotFoundAlerts;
