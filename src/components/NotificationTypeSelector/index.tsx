import NotificationType from '@app/components/NotificationTypeSelector/NotificationType';
import useSettings from '@app/hooks/useSettings';
import type { User } from '@app/hooks/useUser';
import { Permission, useUser } from '@app/hooks/useUser';
import defineMessages from '@app/utils/defineMessages';
import { sortBy } from 'lodash';
import { useMemo, useState } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.NotificationTypeSelector', {
  notificationTypes: 'Notification Types',
  mediarequested: 'Request Pending Approval',
  mediarequestedDescription:
    'Send notifications when users submit new media requests which require approval.',
  usermediarequestedDescription:
    'Get notified when other users submit new media requests which require approval.',
  mediaapproved: 'Request Approved',
  mediaapprovedDescription:
    'Send notifications when media requests are manually approved.',
  usermediaapprovedDescription:
    'Get notified when your media requests are approved.',
  mediaAutoApproved: 'Request Automatically Approved',
  mediaAutoApprovedDescription:
    'Send notifications when users submit new media requests which are automatically approved.',
  usermediaAutoApprovedDescription:
    'Get notified when other users submit new media requests which are automatically approved.',
  mediaavailable: 'Request Available',
  mediaavailableDescription:
    'Send notifications when media requests become available.',
  usermediaavailableDescription:
    'Get notified when your media requests or watchlisted titles become available, and about new releases from the artists and authors you follow.',
  mediaepisodesavailable: 'New Episodes Available',
  mediaepisodesavailableDescription:
    'Send notifications when new episodes of requested seasons that are still airing become available.',
  usermediaepisodesavailableDescription:
    'Get notified when new episodes of seasons you requested become available.',
  mediafailed: 'Request Processing Failed',
  mediafailedDescription:
    'Send notifications when media requests fail to be added to Radarr or Sonarr.',
  usermediafailedDescription:
    'Get notified when media requests fail to be added to Radarr or Sonarr.',
  mediadeclined: 'Request Declined',
  mediadeclinedDescription:
    'Send notifications when media requests are declined.',
  usermediadeclinedDescription:
    'Get notified when your media requests are declined.',
  issuecreated: 'Issue Reported',
  issuecreatedDescription: 'Send notifications when issues are reported.',
  userissuecreatedDescription: 'Get notified when other users report issues.',
  issuecomment: 'Issue Comment',
  issuecommentDescription:
    'Send notifications when issues receive new comments.',
  userissuecommentDescription:
    'Get notified when issues you reported receive new comments.',
  adminissuecommentDescription:
    'Get notified when other users comment on issues.',
  issueresolved: 'Issue Resolved',
  issueresolvedDescription: 'Send notifications when issues are resolved.',
  userissueresolvedDescription:
    'Get notified when issues you reported are resolved.',
  adminissueresolvedDescription:
    'Get notified when issues are resolved by other users.',
  issuereopened: 'Issue Reopened',
  issuereopenedDescription: 'Send notifications when issues are reopened.',
  userissuereopenedDescription:
    'Get notified when issues you reported are reopened.',
  adminissuereopenedDescription:
    'Get notified when issues are reopened by other users.',
  removalrequested: 'Removal Pending Approval',
  removalrequestedDescription:
    'Send notifications when users ask for media to be removed.',
  userremovalrequestedDescription:
    'Get notified when other users ask for media to be removed.',
  removalapproved: 'Removal Approved',
  removalapprovedDescription:
    'Send notifications when removal requests are approved.',
  userremovalapprovedDescription:
    'Get notified when your removal requests are approved.',
  removaldeclined: 'Removal Declined',
  removaldeclinedDescription:
    'Send notifications when removal requests are declined.',
  userremovaldeclinedDescription:
    'Get notified when your removal requests are declined.',
  seasonrolloverpending: 'Seasons Scheduled for Deletion',
  seasonrolloverpendingDescription:
    'Send notifications when a new season starts and older seasons of a current season request are about to be deleted.',
  userseasonrolloverpendingDescription:
    'Get notified when a new season starts and older seasons of a current season request are about to be deleted.',
  mediaautorequested: 'Request Automatically Submitted',
  mediaautorequestedDescription:
    'Get notified when new media requests are automatically submitted for items on Your Watchlist.',
  scanfailure: 'Scan Failures',
  scanfailureDescription:
    'Send notifications when a library scan fails 3 times in a row, and when it works again.',
  userscanfailureDescription:
    'Get notified when a library scan fails 3 times in a row, and when it works again.',
  downloadneedsattention: 'Download Needs Attention',
  downloadneedsattentionDescription:
    'Send notifications when a book download is stuck in Talearr or Chaptarr for more than 10 minutes, such as when it cannot be imported.',
  userdownloadneedsattentionDescription:
    'Get notified when a book download is stuck in Talearr or Chaptarr for more than 10 minutes, such as when it cannot be imported.',
  accessrequested: 'Reading App Access Requests',
  accessrequestedDescription:
    'Send notifications when someone asks for access to Audiobookshelf, Kavita or Komga from their Reading apps settings.',
  useraccessrequestedDescription:
    'Get notified when someone asks for access to Audiobookshelf, Kavita or Komga from their Reading apps settings.',
  accessgranted: 'Reading App Access Granted',
  accessgrantedDescription:
    'Send notifications to people when an admin gives them access to Audiobookshelf, Kavita or Komga.',
  useraccessgrantedDescription:
    'Get notified when an admin gives you access to Audiobookshelf, Kavita or Komga.',
  appusernamechanged: 'Reading App Username Changed',
  appusernamechangedDescription:
    'Send notifications to people when Allseerr renames their Audiobookshelf or Kavita account to match their Plex username.',
  userappusernamechangedDescription:
    'Get notified when your Audiobookshelf or Kavita username changes to match your Plex username.',
  newsletter: 'Recently Added Newsletter',
  usernewsletterDescription:
    'Receive a periodic email listing the media which recently became available.',
});

export const hasNotificationType = (
  types: Notification | Notification[],
  value: number
): boolean => {
  let total: number;

  // If we are not checking any notifications, bail out and return true
  if (types === 0) {
    return true;
  }

  if (Array.isArray(types)) {
    // Combine all notification values into one
    total = types.reduce((a, v) => a + v, 0);
  } else {
    total = types;
  }

  // Test notifications don't need to be enabled
  if (!(value & Notification.TEST_NOTIFICATION)) {
    value += Notification.TEST_NOTIFICATION;
  }

  return !!(value & total);
};

export enum Notification {
  NONE = 0,
  MEDIA_PENDING = 2,
  MEDIA_APPROVED = 4,
  MEDIA_AVAILABLE = 8,
  MEDIA_FAILED = 16,
  TEST_NOTIFICATION = 32,
  MEDIA_DECLINED = 64,
  MEDIA_AUTO_APPROVED = 128,
  ISSUE_CREATED = 256,
  ISSUE_COMMENT = 512,
  ISSUE_RESOLVED = 1024,
  ISSUE_REOPENED = 2048,
  MEDIA_AUTO_REQUESTED = 4096,
  MEDIA_EPISODES_AVAILABLE = 8192,
  REMOVAL_PENDING = 16384,
  REMOVAL_APPROVED = 32768,
  REMOVAL_DECLINED = 65536,
  NEWSLETTER = 131072,
  SEASON_ROLLOVER_PENDING = 262144,
  SCAN_FAILURE = 524288,
  DOWNLOAD_NEEDS_ATTENTION = 1048576,
  ACCESS_REQUESTED = 2097152,
  ACCESS_GRANTED = 4194304,
  APP_USERNAME_CHANGED = 8388608,
}

export const ALL_NOTIFICATIONS = Object.values(Notification)
  .filter((v) => !isNaN(Number(v)))
  .reduce((a, v) => a + Number(v), 0);

export interface NotificationItem {
  id: string;
  name: string;
  description: string;
  value: Notification;
  hasNotifyUser: boolean;
  children?: NotificationItem[];
  hidden?: boolean;
}

interface NotificationTypeSelectorProps {
  user?: User;
  enabledTypes?: number;
  currentTypes: number;
  onUpdate: (newTypes: number) => void;
  error?: string;
  showNewsletter?: boolean;
}

const NotificationTypeSelector = ({
  user,
  enabledTypes = ALL_NOTIFICATIONS,
  currentTypes,
  onUpdate,
  error,
  showNewsletter = false,
}: NotificationTypeSelectorProps) => {
  const intl = useIntl();
  const settings = useSettings();
  const { hasPermission } = useUser({ id: user?.id });
  const [allowedTypes, setAllowedTypes] = useState(enabledTypes);

  const availableTypes = useMemo(() => {
    const allRequestsAutoApproved =
      user &&
      // Has Manage Requests perm, which grants all Auto-Approve perms
      (hasPermission(Permission.MANAGE_REQUESTS) ||
        // Cannot submit requests of any type
        !hasPermission(
          [
            Permission.REQUEST,
            Permission.REQUEST_MOVIE,
            Permission.REQUEST_TV,
            Permission.REQUEST_4K,
            Permission.REQUEST_4K_MOVIE,
            Permission.REQUEST_4K_TV,
          ],
          { type: 'or' }
        ) ||
        // Cannot submit non-4K movie requests OR has Auto-Approve perms for non-4K movies
        ((!hasPermission([Permission.REQUEST, Permission.REQUEST_MOVIE], {
          type: 'or',
        }) ||
          hasPermission(
            [Permission.AUTO_APPROVE, Permission.AUTO_APPROVE_MOVIE],
            { type: 'or' }
          )) &&
          // Cannot submit non-4K series requests OR has Auto-Approve perms for non-4K series
          (!hasPermission([Permission.REQUEST, Permission.REQUEST_TV], {
            type: 'or',
          }) ||
            hasPermission(
              [Permission.AUTO_APPROVE, Permission.AUTO_APPROVE_TV],
              { type: 'or' }
            )) &&
          // Cannot submit 4K movie requests OR has Auto-Approve perms for 4K movies
          (!settings.currentSettings.movie4kEnabled ||
            !hasPermission(
              [Permission.REQUEST_4K, Permission.REQUEST_4K_MOVIE],
              { type: 'or' }
            ) ||
            hasPermission(
              [Permission.AUTO_APPROVE_4K, Permission.AUTO_APPROVE_4K_MOVIE],
              { type: 'or' }
            )) &&
          // Cannot submit 4K series requests OR has Auto-Approve perms for 4K series
          (!settings.currentSettings.series4kEnabled ||
            !hasPermission([Permission.REQUEST_4K, Permission.REQUEST_4K_TV], {
              type: 'or',
            }) ||
            hasPermission(
              [Permission.AUTO_APPROVE_4K, Permission.AUTO_APPROVE_4K_TV],
              { type: 'or' }
            ))));

    const types: NotificationItem[] = [
      {
        id: 'media-auto-requested',
        name: intl.formatMessage(messages.mediaautorequested),
        description: intl.formatMessage(messages.mediaautorequestedDescription),
        value: Notification.MEDIA_AUTO_REQUESTED,
        hidden:
          !user ||
          (!user.settings?.watchlistSyncMovies &&
            !user.settings?.watchlistSyncTv) ||
          !hasPermission(
            [
              Permission.AUTO_REQUEST,
              Permission.AUTO_REQUEST_MOVIE,
              Permission.AUTO_REQUEST_TV,
            ],
            { type: 'or' }
          ),
        hasNotifyUser: true,
      },
      {
        id: 'media-requested',
        name: intl.formatMessage(messages.mediarequested),
        description: intl.formatMessage(
          user
            ? messages.usermediarequestedDescription
            : messages.mediarequestedDescription
        ),
        value: Notification.MEDIA_PENDING,
        hasNotifyUser: false,
        hidden: user && !hasPermission(Permission.MANAGE_REQUESTS),
      },
      {
        id: 'media-auto-approved',
        name: intl.formatMessage(messages.mediaAutoApproved),
        description: intl.formatMessage(
          user
            ? messages.usermediaAutoApprovedDescription
            : messages.mediaAutoApprovedDescription
        ),
        value: Notification.MEDIA_AUTO_APPROVED,
        hasNotifyUser: false,
        hidden: user && !hasPermission(Permission.MANAGE_REQUESTS),
      },
      {
        id: 'media-approved',
        name: intl.formatMessage(messages.mediaapproved),
        description: intl.formatMessage(
          user
            ? messages.usermediaapprovedDescription
            : messages.mediaapprovedDescription
        ),
        value: Notification.MEDIA_APPROVED,
        hasNotifyUser: true,
        hidden: allRequestsAutoApproved,
      },
      {
        id: 'media-declined',
        name: intl.formatMessage(messages.mediadeclined),
        description: intl.formatMessage(
          user
            ? messages.usermediadeclinedDescription
            : messages.mediadeclinedDescription
        ),
        value: Notification.MEDIA_DECLINED,
        hasNotifyUser: true,
        hidden: allRequestsAutoApproved,
      },
      {
        id: 'media-available',
        name: intl.formatMessage(messages.mediaavailable),
        description: intl.formatMessage(
          user
            ? messages.usermediaavailableDescription
            : messages.mediaavailableDescription
        ),
        value: Notification.MEDIA_AVAILABLE,
        hasNotifyUser: true,
      },
      {
        id: 'media-episodes-available',
        name: intl.formatMessage(messages.mediaepisodesavailable),
        description: intl.formatMessage(
          user
            ? messages.usermediaepisodesavailableDescription
            : messages.mediaepisodesavailableDescription
        ),
        value: Notification.MEDIA_EPISODES_AVAILABLE,
        hasNotifyUser: true,
      },
      {
        id: 'media-failed',
        name: intl.formatMessage(messages.mediafailed),
        description: intl.formatMessage(
          user
            ? messages.usermediafailedDescription
            : messages.mediafailedDescription
        ),
        value: Notification.MEDIA_FAILED,
        hidden: user && !hasPermission(Permission.MANAGE_REQUESTS),
        hasNotifyUser: false,
      },
      {
        id: 'issue-created',
        name: intl.formatMessage(messages.issuecreated),
        description: intl.formatMessage(
          user
            ? messages.userissuecreatedDescription
            : messages.issuecreatedDescription
        ),
        value: Notification.ISSUE_CREATED,
        hidden: user && !hasPermission(Permission.MANAGE_ISSUES),
        hasNotifyUser: false,
      },
      {
        id: 'issue-comment',
        name: intl.formatMessage(messages.issuecomment),
        description: intl.formatMessage(
          user
            ? hasPermission(Permission.MANAGE_ISSUES)
              ? messages.adminissuecommentDescription
              : messages.userissuecommentDescription
            : messages.issuecommentDescription
        ),
        value: Notification.ISSUE_COMMENT,
        hidden:
          user &&
          !hasPermission([Permission.MANAGE_ISSUES, Permission.CREATE_ISSUES], {
            type: 'or',
          }),
        hasNotifyUser:
          !user || hasPermission(Permission.MANAGE_ISSUES) ? false : true,
      },
      {
        id: 'issue-resolved',
        name: intl.formatMessage(messages.issueresolved),
        description: intl.formatMessage(
          user
            ? hasPermission(Permission.MANAGE_ISSUES)
              ? messages.adminissueresolvedDescription
              : messages.userissueresolvedDescription
            : messages.issueresolvedDescription
        ),
        value: Notification.ISSUE_RESOLVED,
        hidden:
          user &&
          !hasPermission([Permission.MANAGE_ISSUES, Permission.CREATE_ISSUES], {
            type: 'or',
          }),
        hasNotifyUser:
          !user || hasPermission(Permission.MANAGE_ISSUES) ? false : true,
      },
      {
        id: 'removal-requested',
        name: intl.formatMessage(messages.removalrequested),
        description: intl.formatMessage(
          user
            ? messages.userremovalrequestedDescription
            : messages.removalrequestedDescription
        ),
        value: Notification.REMOVAL_PENDING,
        hasNotifyUser: false,
        hidden: user && !hasPermission(Permission.MANAGE_REQUESTS),
      },
      {
        id: 'removal-approved',
        name: intl.formatMessage(messages.removalapproved),
        description: intl.formatMessage(
          user
            ? messages.userremovalapprovedDescription
            : messages.removalapprovedDescription
        ),
        value: Notification.REMOVAL_APPROVED,
        hasNotifyUser: true,
      },
      {
        id: 'removal-declined',
        name: intl.formatMessage(messages.removaldeclined),
        description: intl.formatMessage(
          user
            ? messages.userremovaldeclinedDescription
            : messages.removaldeclinedDescription
        ),
        value: Notification.REMOVAL_DECLINED,
        hasNotifyUser: true,
      },
      {
        id: 'season-rollover-pending',
        name: intl.formatMessage(messages.seasonrolloverpending),
        description: intl.formatMessage(
          user
            ? messages.userseasonrolloverpendingDescription
            : messages.seasonrolloverpendingDescription
        ),
        value: Notification.SEASON_ROLLOVER_PENDING,
        hasNotifyUser: false,
        hidden: user && !hasPermission(Permission.MANAGE_REQUESTS),
      },
      {
        id: 'issue-reopened',
        name: intl.formatMessage(messages.issuereopened),
        description: intl.formatMessage(
          user
            ? hasPermission(Permission.MANAGE_ISSUES)
              ? messages.adminissuereopenedDescription
              : messages.userissuereopenedDescription
            : messages.issuereopenedDescription
        ),
        value: Notification.ISSUE_REOPENED,
        hidden:
          user &&
          !hasPermission([Permission.MANAGE_ISSUES, Permission.CREATE_ISSUES], {
            type: 'or',
          }),
        hasNotifyUser:
          !user || hasPermission(Permission.MANAGE_ISSUES) ? false : true,
      },
      {
        id: 'scan-failure',
        name: intl.formatMessage(messages.scanfailure),
        description: intl.formatMessage(
          user
            ? messages.userscanfailureDescription
            : messages.scanfailureDescription
        ),
        value: Notification.SCAN_FAILURE,
        hasNotifyUser: false,
        hidden: user && !hasPermission(Permission.ADMIN),
      },
      {
        id: 'download-needs-attention',
        name: intl.formatMessage(messages.downloadneedsattention),
        description: intl.formatMessage(
          user
            ? messages.userdownloadneedsattentionDescription
            : messages.downloadneedsattentionDescription
        ),
        value: Notification.DOWNLOAD_NEEDS_ATTENTION,
        hasNotifyUser: false,
        hidden: user && !hasPermission(Permission.ADMIN),
      },
      {
        id: 'access-requested',
        name: intl.formatMessage(messages.accessrequested),
        description: intl.formatMessage(
          user
            ? messages.useraccessrequestedDescription
            : messages.accessrequestedDescription
        ),
        value: Notification.ACCESS_REQUESTED,
        hasNotifyUser: false,
        hidden: user && !hasPermission(Permission.MANAGE_USERS),
      },
      {
        id: 'access-granted',
        name: intl.formatMessage(messages.accessgranted),
        description: intl.formatMessage(
          user
            ? messages.useraccessgrantedDescription
            : messages.accessgrantedDescription
        ),
        value: Notification.ACCESS_GRANTED,
        hasNotifyUser: true,
      },
      {
        id: 'app-username-changed',
        name: intl.formatMessage(messages.appusernamechanged),
        description: intl.formatMessage(
          user
            ? messages.userappusernamechangedDescription
            : messages.appusernamechangedDescription
        ),
        value: Notification.APP_USERNAME_CHANGED,
        hasNotifyUser: true,
      },
      {
        id: 'newsletter',
        name: intl.formatMessage(messages.newsletter),
        description: intl.formatMessage(messages.usernewsletterDescription),
        value: Notification.NEWSLETTER,
        hidden: !user || !showNewsletter,
        hasNotifyUser: true,
      },
    ];

    const filteredTypes = types.filter(
      (type) => !type.hidden && hasNotificationType(type.value, enabledTypes)
    );

    const newAllowedTypes = filteredTypes.reduce((a, v) => a + v.value, 0);
    if (newAllowedTypes !== allowedTypes) {
      setAllowedTypes(newAllowedTypes);
    }

    return user
      ? sortBy(filteredTypes, 'hasNotifyUser', 'DESC')
      : filteredTypes;
  }, [
    user,
    hasPermission,
    settings,
    intl,
    allowedTypes,
    enabledTypes,
    showNewsletter,
  ]);

  if (!availableTypes.length) {
    return null;
  }

  return (
    <div role="group" aria-labelledby="group-label" className="form-group">
      <div className="form-row">
        <span id="group-label" className="group-label">
          {intl.formatMessage(messages.notificationTypes)}
          {!user && <span className="label-required">*</span>}
        </span>
        <div className="form-input-area">
          <div className="max-w-lg">
            {availableTypes.map((type) => (
              <NotificationType
                key={`notification-type-${type.id}`}
                option={type}
                currentTypes={currentTypes}
                onUpdate={onUpdate}
              />
            ))}
          </div>
          {error && <div className="error">{error}</div>}
        </div>
      </div>
    </div>
  );
};

export default NotificationTypeSelector;
