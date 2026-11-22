import Alert from '@app/components/Common/Alert';
import defineMessages from '@app/utils/defineMessages';
import type { UnwatchedQuotaStatus } from '@server/lib/unwatchedQuota';
import Link from 'next/link';
import { useIntl } from 'react-intl';

const messages = defineMessages(
  'components.RequestModal.UnwatchedQuotaNotice',
  {
    title: 'Watch some of your requests first',
    titleUser: 'This user has too many unwatched requests',
    reason:
      '{used, plural, one {<strong>#</strong> requested title has} other {<strong>#</strong> requested titles have}} been available{days, plural, =0 {} one { for over a day} other { for over # days}} without being watched, more than the limit of <strong>{limit}</strong>. New movie and series requests open again once some of them are watched.',
    andMore: 'and {count} more',
  }
);

interface UnwatchedQuotaNoticeProps {
  quota: UnwatchedQuotaStatus;
  /** Set when a manager requests for someone else */
  userOverride?: number | null;
}

/** Explains why a request is held and names the titles waiting */
const UnwatchedQuotaNotice = ({
  quota,
  userOverride,
}: UnwatchedQuotaNoticeProps) => {
  const intl = useIntl();
  const more = quota.used - quota.titles.length;

  return (
    <div className="mt-6">
      <Alert
        type="warning"
        title={intl.formatMessage(
          userOverride ? messages.titleUser : messages.title
        )}
      >
        <p>
          {intl.formatMessage(messages.reason, {
            used: quota.used,
            days: quota.days ?? 0,
            limit: quota.limit,
            strong: (msg: React.ReactNode) => <strong>{msg}</strong>,
          })}
        </p>
        {quota.titles.length > 0 && (
          <ul className="mt-2 list-inside list-disc">
            {quota.titles.map((title) => (
              <li key={title.mediaId}>
                <Link
                  href={`/${title.mediaType === 'movie' ? 'movie' : 'tv'}/${
                    title.tmdbId
                  }`}
                  className="hover:underline"
                >
                  {title.title ?? `TMDB ${title.tmdbId}`}
                </Link>
              </li>
            ))}
            {more > 0 && (
              <li>{intl.formatMessage(messages.andMore, { count: more })}</li>
            )}
          </ul>
        )}
      </Alert>
    </div>
  );
};

export default UnwatchedQuotaNotice;
