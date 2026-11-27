import CopyButton from '@app/components/Settings/CopyButton';
import defineMessages from '@app/utils/defineMessages';
import type { ReadingKind } from '@server/constants/userAccess';
import type {
  NewAppPassword,
  ReadingAppStatus,
} from '@server/interfaces/api/userAccessInterfaces';
import { useIntl } from 'react-intl';

export type { ReadingKind };

export const readingAppMessages = defineMessages('components.ReadingApps', {
  purposeaudiobook: 'Audiobooks',
  purposeebook: 'Ebooks',
  purposeaudiobookebook: 'Audiobooks and ebooks',
  purposecomic: 'Comics and manga',
  purposeebookcomic: 'Ebooks, comics and manga',
  purposeaudiobookshelf: 'Audiobooks and ebooks',
  purposekavita: 'Comics and manga',
  purposekomga: 'Comics and manga',
  purposegrimmory: 'Ebooks and audiobooks',
  username: 'Username',
  password: 'Password',
  shownOnce:
    'This password is shown only now. Copy it or note it somewhere safe.',
  emailed: 'We also emailed it to you.',
});

/**
 * What an app is for, in plain words, from the kinds the admin picked it for
 */
export const purposeMessage = (status: ReadingAppStatus) => {
  const key = `purpose${status.kinds.join('')}`;

  return (
    readingAppMessages[key as keyof typeof readingAppMessages] ??
    readingAppMessages[`purpose${status.app}`]
  );
};

// How long "Not now" keeps a nudge away
export const DISMISS_DAYS = 30;

// Stored for a prompt the person asked never to see again
const NEVER = 'never';

const dismissKey = (name: string, userId: number) =>
  `allseerr-reading-apps-${name}-${userId}`;

/**
 * Whether the person said "Not now" to this in the last 30 days, or asked
 * never to see it again. Browsers that block storage just show it again.
 */
export const isDismissed = (name: string, userId: number): boolean => {
  try {
    const stored = window.localStorage.getItem(dismissKey(name, userId));

    if (stored === NEVER) {
      return true;
    }

    const at = Number(stored);

    return !!at && Date.now() - at < DISMISS_DAYS * 24 * 60 * 60 * 1000;
  } catch {
    return false;
  }
};

export const dismiss = (name: string, userId: number): void => {
  try {
    window.localStorage.setItem(dismissKey(name, userId), String(Date.now()));
  } catch {
    // Storage is blocked, so it is asked again next time
  }
};

export const dismissForever = (name: string, userId: number): void => {
  try {
    window.localStorage.setItem(dismissKey(name, userId), NEVER);
  } catch {
    // Storage is blocked, so it is asked again next time
  }
};

/**
 * A new username and password, with copy buttons, shown once
 */
export const NewPasswordBox = ({ password }: { password: NewAppPassword }) => {
  const intl = useIntl();

  return (
    <div
      className="mt-4 rounded-xl p-4 ring-1 ring-as-line"
      data-testid="reading-app-password"
    >
      <div className="grid grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-2 text-sm">
        <span className="text-as-ink-muted">
          {intl.formatMessage(readingAppMessages.username)}
        </span>
        <code className="truncate">{password.username}</code>
        <CopyButton textToCopy={password.username} />
        <span className="text-as-ink-muted">
          {intl.formatMessage(readingAppMessages.password)}
        </span>
        <code className="truncate">{password.password}</code>
        <CopyButton textToCopy={password.password} />
      </div>
      <p className="mt-3 text-xs text-as-ink-muted">
        {intl.formatMessage(readingAppMessages.shownOnce)}
        {password.emailed &&
          ` ${intl.formatMessage(readingAppMessages.emailed)}`}
      </p>
    </div>
  );
};
