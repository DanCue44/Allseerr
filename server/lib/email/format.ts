import type { IntlShape } from '@formatjs/intl';
import { defineMessages } from '@server/i18n';
import globalMessages from '@server/i18n/globalMessages';

const messages = defineMessages('notifications.email', {
  greeting: 'Hi {name},',
  greetingNoName: 'Hi there,',
  timestamp: '{date} at {time}',
  viewInApp: 'View in {applicationTitle}',
  byline: 'by {name}',
  openApp: 'Open {applicationTitle}',
  sentBy: 'Sent by {applicationTitle}',
  manageNotifications: 'Manage notifications',
  accountCreated: 'An account has been created for you at {applicationTitle}.',
  yourPassword: 'Your password',
  appAccountCreated:
    '{applicationTitle} made you an account in {appName}. Sign in with these details, then change the password if you like.',
  yourUsername: 'Your username',
  resetRequested:
    'A request has been received to change the password for your {applicationTitle} account.',
  resetPassword: 'Reset Password',
  resetExpires: 'This link will expire in 24 hours.',
  resetIgnore:
    'If you did not initiate this request, you may safely disregard this message.',
  plexSignInNeeded:
    '{applicationTitle} can no longer reach Plex with your account, so your watchlist and watched history have stopped syncing. Sign in with Plex again to reconnect them.',
  signInWithPlex: 'Sign in with Plex',
});

type EmailIntl = Pick<
  IntlShape<string>,
  'formatMessage' | 'formatDate' | 'formatTime' | 'locale'
>;

// Mail apps turn anything that looks like a domain or address into a link,
// a zero width no-break space after each dot and at sign stops that
export const breakAutoLinks = (value: string): string =>
  value.replace(/\.|@/g, (x) => `${x}\ufeff`);

/**
 * Name to greet a recipient by. Users without a display name fall back to
 * their email address, which reads badly in a greeting, so those get none.
 */
export const getGreetingName = (
  name?: string | null,
  email?: string | null
): string | undefined => {
  const trimmed = name?.trim();

  if (!trimmed) {
    return undefined;
  }

  if (
    (email && trimmed.toLowerCase() === email.trim().toLowerCase()) ||
    /^[^\s@]+@[^\s@]+$/.test(trimmed)
  ) {
    return undefined;
  }

  return trimmed;
};

/**
 * Short, readable date and time such as "Oct 12, 2026 at 3:04 PM", in the
 * recipient's language and the server's time zone (TZ) unless one is given.
 */
export const formatEmailTimestamp = (
  date: Date,
  intl: EmailIntl,
  timeZone?: string
): string => {
  const zone = timeZone ? { timeZone } : {};

  return intl.formatMessage(messages.timestamp, {
    date: intl.formatDate(date, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      ...zone,
    }),
    time: intl.formatTime(date, {
      hour: 'numeric',
      minute: '2-digit',
      ...zone,
    }),
  });
};

/** The author or artist line under a book or album title, "by Name". */
export const formatEmailByline = (intl: EmailIntl, name: string): string =>
  intl.formatMessage(messages.byline, { name });

interface EmailLayoutOptions {
  intl: EmailIntl;
  applicationTitle: string;
  applicationUrl?: string;
  recipientName?: string | null;
  recipientEmail?: string | null;
  /** Links the footer to the recipient's notification settings. */
  manageNotifications?: boolean;
}

/** Locals shared by every email template: greeting, labels and footer. */
export const getEmailLayoutLocals = ({
  intl,
  applicationTitle,
  applicationUrl,
  recipientName,
  recipientEmail,
  manageNotifications = true,
}: EmailLayoutOptions) => {
  const name = getGreetingName(recipientName, recipientEmail);

  return {
    locale: intl.locale,
    greeting: name
      ? intl.formatMessage(messages.greeting, { name: breakAutoLinks(name) })
      : intl.formatMessage(messages.greetingNoName),
    manageNotificationsUrl:
      manageNotifications && applicationUrl
        ? `${applicationUrl}/profile/settings/notifications/email`
        : undefined,
    labels: {
      requestedBy: intl.formatMessage(globalMessages.requestedBy),
      requestStatus: intl.formatMessage(globalMessages.requestStatus),
      viewInApp: intl.formatMessage(messages.viewInApp, { applicationTitle }),
      viewIssue: intl.formatMessage(globalMessages.viewIssue, {
        applicationTitle,
      }),
      openApp: intl.formatMessage(messages.openApp, { applicationTitle }),
      sentBy: intl.formatMessage(messages.sentBy, { applicationTitle }),
      manageNotifications: intl.formatMessage(messages.manageNotifications),
      accountCreated: intl.formatMessage(messages.accountCreated, {
        applicationTitle,
      }),
      yourPassword: intl.formatMessage(messages.yourPassword),
      yourUsername: intl.formatMessage(messages.yourUsername),
      resetRequested: intl.formatMessage(messages.resetRequested, {
        applicationTitle,
      }),
      resetPassword: intl.formatMessage(messages.resetPassword),
      resetExpires: intl.formatMessage(messages.resetExpires),
      resetIgnore: intl.formatMessage(messages.resetIgnore),
      plexSignInNeeded: intl.formatMessage(messages.plexSignInNeeded, {
        applicationTitle,
      }),
      signInWithPlex: intl.formatMessage(messages.signInWithPlex),
    },
  };
};

// The labels, for emails that word their own sentences
export { messages as emailMessages };
