import type { DownloadsLayout } from '@app/components/Allseerr/Downloads/DownloadCard';
import { SEEDING_LIST_GRID } from '@app/components/Allseerr/Downloads/DownloadCard';
import {
  EmptyState,
  ListFrame,
  StatTile,
} from '@app/components/Allseerr/Downloads/DownloadsCommon';
import SeedingCard from '@app/components/Allseerr/Downloads/SeedingCard';
import StickySummary, {
  useScrolledPast,
} from '@app/components/Allseerr/Downloads/StickySummary';
import {
  isNearUnsatisfiedLimit,
  sortSeeding,
} from '@app/components/Allseerr/Downloads/seedingLogic';
import { statusTone } from '@app/components/Allseerr/Title/styles';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import defineMessages from '@app/utils/defineMessages';
import { ArrowUpTrayIcon } from '@heroicons/react/24/outline';
import type {
  SeedingResponse,
  TrackerAccount,
} from '@server/interfaces/api/downloadInterfaces';
import type { ReactNode } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.Allseerr.Downloads.Seeding', {
  seeding: 'Seeding',
  atRiskCount: 'At risk',
  belowMinimum: 'Below minimum',
  trackerAccount: 'Tracker Account',
  userClass: 'Class',
  vip: 'VIP',
  unsatisfied: 'Unsatisfied',
  unsatisfiedOf: '{count} of {limit}',
  wedges: 'Wedges',
  bonusPoints: 'Bonus points',
  checkedAt: 'Checked {time}',
  unknown: 'Unknown',
  summaryLabel: 'Seeding summary',
  compactSeeding: '{count} seeding',
  compactAtRisk: '{count} at risk',
  compactBelowMinimum: '{count} below minimum',
  compactUnsatisfied: '{count} unsatisfied',
  compactWedges: '{count} wedges',
  compactBonus: '{count} bonus',
  emptyTitle: 'Nothing is seeding',
  emptyText: 'Torrents Talearr grabs show up here while they seed.',
  unsupportedTitle: 'Seeding is not available',
  unsupportedText:
    'Seeding shows when Talearr is the book service and supports it. Chaptarr and LazyLibrarian do not report it.',
  loadError: 'Unable to load what Talearr seeds.',
  columnTitle: 'Title',
  columnState: 'State',
  columnSeedTime: 'Progress',
  columnSeeded: 'Seeded',
  columnTimeLeft: 'Time left',
  columnRatio: 'Ratio',
  columnClient: 'Client',
  columnIndexer: 'Indexer',
});

const REFRESH_MS = 30_000;

const TrackerAccountPanel = ({ account }: { account: TrackerAccount }) => {
  const intl = useIntl();
  const unknown = intl.formatMessage(messages.unknown);
  const number = (value: number | null) =>
    value === null ? unknown : intl.formatNumber(value);
  const nearLimit = isNearUnsatisfiedLimit(account);

  return (
    <section className="flex flex-col gap-3 rounded-[22px] bg-as-surface p-4 sm:p-[18px]">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="font-display text-lg font-medium text-as-ink">
          {intl.formatMessage(messages.trackerAccount)}
        </h3>
        {account.checkedAt && (
          <span className="text-xs text-as-ink-muted">
            {intl.formatMessage(messages.checkedAt, {
              time: intl.formatDate(account.checkedAt, {
                month: 'short',
                day: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
              }),
            })}
          </span>
        )}
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 sm:gap-3">
        <StatTile
          label={intl.formatMessage(messages.userClass)}
          value={account.userClass ?? unknown}
          tone="bg-as-raised text-as-ink"
          extra={
            account.isVip && (
              <span
                className={`flex-none rounded-full px-2 py-0.5 font-sans text-[11px] font-bold uppercase tracking-wide ${statusTone.accent}`}
              >
                {intl.formatMessage(messages.vip)}
              </span>
            )
          }
        />
        <StatTile
          label={intl.formatMessage(messages.unsatisfied)}
          value={
            account.unsatisfiedLimit !== null
              ? intl.formatMessage(messages.unsatisfiedOf, {
                  count: number(account.unsatisfied),
                  limit: number(account.unsatisfiedLimit),
                })
              : number(account.unsatisfied)
          }
          tone={nearLimit ? statusTone.warn : 'bg-as-raised text-as-ink'}
        />
        <StatTile
          label={intl.formatMessage(messages.wedges)}
          value={number(account.wedges)}
          tone="bg-as-raised text-as-ink"
        />
        <StatTile
          label={intl.formatMessage(messages.bonusPoints)}
          value={number(account.bonusPoints)}
          tone="bg-as-raised text-as-ink"
        />
      </div>
    </section>
  );
};

/**
 * What Talearr seeds, at risk torrents first, and the tracker account
 * its seeding rules come from
 */
const SeedingView = ({
  layout = 'cards',
  summaryActions,
}: {
  layout?: DownloadsLayout;
  summaryActions?: ReactNode;
}) => {
  const intl = useIntl();
  const [statsRef, statsHidden] = useScrolledPast();
  const { data, error } = useSWR<SeedingResponse>('/api/v1/downloads/seeding', {
    refreshInterval: REFRESH_MS,
    refreshWhenHidden: false,
    revalidateOnFocus: true,
  });

  if (!data && !error) {
    return <LoadingSpinner />;
  }

  if (!data) {
    return (
      <EmptyState
        icon={ArrowUpTrayIcon}
        title={intl.formatMessage(messages.loadError)}
      />
    );
  }

  if (!data.supported) {
    return (
      <EmptyState
        icon={ArrowUpTrayIcon}
        title={intl.formatMessage(messages.unsupportedTitle)}
        text={intl.formatMessage(messages.unsupportedText)}
      />
    );
  }

  const torrents = sortSeeding(data.torrents);
  const { summary } = data;

  const account = data.trackerAccount;
  const number = (value: number | null) =>
    value === null
      ? intl.formatMessage(messages.unknown)
      : intl.formatNumber(value);

  return (
    <div className="flex flex-col gap-6">
      <StickySummary
        actions={summaryActions}
        show={statsHidden}
        label={intl.formatMessage(messages.summaryLabel)}
        groups={[
          [
            {
              key: 'seeding',
              text: intl.formatMessage(messages.compactSeeding, {
                count: summary.seeding,
              }),
            },
            {
              key: 'atRisk',
              text: intl.formatMessage(messages.compactAtRisk, {
                count: summary.atRisk,
              }),
              tone: summary.atRisk ? 'text-[#f2b0aa]' : undefined,
            },
            {
              key: 'belowMinimum',
              text: intl.formatMessage(messages.compactBelowMinimum, {
                count: summary.privateUnsatisfied,
              }),
            },
          ],
          account
            ? [
                {
                  key: 'class',
                  text: [
                    account.userClass ?? intl.formatMessage(messages.unknown),
                    account.isVip ? intl.formatMessage(messages.vip) : '',
                  ]
                    .filter(Boolean)
                    .join(' '),
                },
                {
                  key: 'unsatisfied',
                  text: intl.formatMessage(messages.compactUnsatisfied, {
                    count:
                      account.unsatisfiedLimit !== null
                        ? intl.formatMessage(messages.unsatisfiedOf, {
                            count: number(account.unsatisfied),
                            limit: number(account.unsatisfiedLimit),
                          })
                        : number(account.unsatisfied),
                  }),
                  tone: isNearUnsatisfiedLimit(account)
                    ? 'text-[#f0d9a8]'
                    : undefined,
                },
                {
                  key: 'wedges',
                  text: intl.formatMessage(messages.compactWedges, {
                    count: number(account.wedges),
                  }),
                },
                {
                  key: 'bonus',
                  text: intl.formatMessage(messages.compactBonus, {
                    count: number(account.bonusPoints),
                  }),
                },
              ]
            : [],
        ]}
      />
      <div ref={statsRef} className="flex flex-col gap-6">
        <div className="grid grid-cols-3 gap-2 sm:flex sm:gap-3">
          <StatTile
            label={intl.formatMessage(messages.seeding)}
            value={summary.seeding}
          />
          <StatTile
            label={intl.formatMessage(messages.atRiskCount)}
            value={summary.atRisk}
            tone={summary.atRisk ? statusTone.bad : undefined}
          />
          <StatTile
            label={intl.formatMessage(messages.belowMinimum)}
            value={summary.privateUnsatisfied}
          />
        </div>

        {data.trackerAccount && (
          <TrackerAccountPanel account={data.trackerAccount} />
        )}
      </div>

      {torrents.length === 0 ? (
        <EmptyState
          icon={ArrowUpTrayIcon}
          title={intl.formatMessage(messages.emptyTitle)}
          text={intl.formatMessage(messages.emptyText)}
        />
      ) : layout === 'list' ? (
        <ListFrame
          gridClassName={SEEDING_LIST_GRID}
          columns={[
            intl.formatMessage(messages.columnTitle),
            intl.formatMessage(messages.columnState),
            intl.formatMessage(messages.columnSeedTime),
            intl.formatMessage(messages.columnSeeded),
            intl.formatMessage(messages.columnTimeLeft),
            intl.formatMessage(messages.columnRatio),
            {
              label: intl.formatMessage(messages.columnClient),
              className: 'hidden xl:block',
            },
            {
              label: intl.formatMessage(messages.columnIndexer),
              className: 'hidden xl:block',
            },
          ]}
        >
          {torrents.map((torrent) => (
            <SeedingCard
              key={torrent.downloadId}
              torrent={torrent}
              talearrUrl={data.talearrUrl}
              layout="list"
            />
          ))}
        </ListFrame>
      ) : (
        <div className="grid grid-cols-1 gap-x-4 gap-y-6 lg:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {torrents.map((torrent) => (
            <SeedingCard
              key={torrent.downloadId}
              torrent={torrent}
              talearrUrl={data.talearrUrl}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export default SeedingView;
