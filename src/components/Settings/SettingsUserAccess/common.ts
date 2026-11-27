import defineMessages from '@app/utils/defineMessages';
import type { UserAccessApp } from '@server/constants/userAccess';
import type { AgeLimit } from '@server/interfaces/api/userAccessInterfaces';

export const APPS: UserAccessApp[] = [
  'audiobookshelf',
  'kavita',
  'komga',
  'grimmory',
];

export const APP_NAMES: Record<UserAccessApp, string> = {
  audiobookshelf: 'Audiobookshelf',
  kavita: 'Kavita',
  komga: 'Komga',
  grimmory: 'Grimmory',
};

export const AGE_LIMIT_OPTIONS: AgeLimit[] = ['none', 'teen', 'tween', 'kids'];

export const commonMessages = defineMessages(
  'components.Settings.SettingsUserAccess',
  {
    ageLimitnone: 'No limit',
    ageLimitteen: 'Teens: up to 15',
    ageLimittween: 'Tweens: up to 12',
    ageLimitkids: 'Kids: up to 9',
    allLibraries: 'All libraries',
    statusnone: 'No account',
    statusactive: 'Active',
    statusdisabled: 'Locked',
    statuserror: 'Needs attention',
  }
);

export const ageLimitMessage = (limit: AgeLimit | null) =>
  commonMessages[`ageLimit${limit ?? 'none'}` as `ageLimit${AgeLimit}`];
