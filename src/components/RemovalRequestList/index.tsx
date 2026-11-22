import Button from '@app/components/Common/Button';
import Header from '@app/components/Common/Header';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import RemovalRequestItem from '@app/components/RemovalRequestList/RemovalRequestItem';
import { Permission, useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  FunnelIcon,
} from '@heroicons/react/24/solid';
import type { RemovalRequestResultsResponse } from '@server/interfaces/api/removalInterfaces';
import type { MainSettings } from '@server/lib/settings';
import Link from 'next/link';
import { useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.RemovalRequestList', {
  removalrequests: 'Removal Requests',
  mediarequests: 'Media Requests',
  noremovals: 'No removal requests.',
  failed: 'Removal Failed',
  removed: 'Removed',
  watchedCleanup: 'Watched Cleanup',
});

type Filter = 'pending' | 'all' | 'approved' | 'declined' | 'failed';

const PAGE_SIZE = 10;

const RemovalRequestList = () => {
  const intl = useIntl();
  const [currentFilter, setCurrentFilter] = useState<Filter>('pending');
  const [pageIndex, setPageIndex] = useState(0);

  const { data, mutate: revalidate } = useSWR<RemovalRequestResultsResponse>(
    `/api/v1/removal?take=${PAGE_SIZE}&skip=${
      pageIndex * PAGE_SIZE
    }&filter=${currentFilter}`
  );

  const { hasPermission } = useUser();
  const isAdmin = hasPermission(Permission.ADMIN);
  // Only admins can read the main settings, and only they see the cleanup
  const { data: mainSettings } = useSWR<MainSettings>(
    isAdmin ? '/api/v1/settings/main' : null
  );

  const hasNextPage = data ? data.pageInfo.pages > pageIndex + 1 : false;
  const hasPrevPage = pageIndex > 0;

  return (
    <>
      <PageTitle title={intl.formatMessage(messages.removalrequests)} />
      <div className="mb-4 flex flex-col justify-between lg:flex-row lg:items-end">
        <Header
          subtext={
            <>
              <Link href="/requests" className="hover:underline">
                {intl.formatMessage(messages.mediarequests)}
              </Link>
              {isAdmin && mainSettings?.watchedCleanup?.enabled && (
                <>
                  {' · '}
                  <Link href="/requests/cleanup" className="hover:underline">
                    {intl.formatMessage(messages.watchedCleanup)}
                  </Link>
                </>
              )}
            </>
          }
        >
          {intl.formatMessage(messages.removalrequests)}
        </Header>
        <div className="mt-2 flex flex-grow sm:mb-0 lg:flex-grow-0">
          <span className="inline-flex cursor-default items-center rounded-l-md border border-r-0 border-gray-500 bg-gray-800 px-3 text-sm text-gray-100">
            <FunnelIcon className="h-6 w-6" />
          </span>
          <select
            id="filter"
            name="filter"
            onChange={(e) => {
              setCurrentFilter(e.target.value as Filter);
              setPageIndex(0);
            }}
            value={currentFilter}
            className="rounded-r-only"
          >
            <option value="pending">
              {intl.formatMessage(globalMessages.pending)}
            </option>
            <option value="all">
              {intl.formatMessage(globalMessages.all)}
            </option>
            <option value="approved">
              {intl.formatMessage(messages.removed)}
            </option>
            <option value="declined">
              {intl.formatMessage(globalMessages.declined)}
            </option>
            <option value="failed">
              {intl.formatMessage(messages.failed)}
            </option>
          </select>
        </div>
      </div>
      {!data ? (
        <LoadingSpinner />
      ) : data.results.length === 0 ? (
        <div className="flex w-full flex-col items-center justify-center py-24 text-white">
          <span className="text-2xl text-gray-400">
            {intl.formatMessage(messages.noremovals)}
          </span>
        </div>
      ) : (
        <>
          {data.results.map((removal) => (
            <div className="py-2" key={`removal-request-${removal.id}`}>
              <RemovalRequestItem
                removal={removal}
                revalidateList={() => revalidate()}
              />
            </div>
          ))}
          <div className="actions">
            <nav
              className="mb-3 flex flex-col items-center space-x-4 space-y-3 sm:space-y-0 md:flex-row"
              aria-label="Pagination"
            >
              <div className="flex flex-auto justify-center space-x-2 md:justify-end">
                <Button
                  disabled={!hasPrevPage}
                  onClick={() => setPageIndex(pageIndex - 1)}
                >
                  <ChevronLeftIcon />
                  <span>{intl.formatMessage(globalMessages.previous)}</span>
                </Button>
                <Button
                  disabled={!hasNextPage}
                  onClick={() => setPageIndex(pageIndex + 1)}
                >
                  <span>{intl.formatMessage(globalMessages.next)}</span>
                  <ChevronRightIcon />
                </Button>
              </div>
            </nav>
          </div>
        </>
      )}
    </>
  );
};

export default RemovalRequestList;
