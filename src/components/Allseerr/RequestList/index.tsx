import type { DownloadsLayout } from '@app/components/Allseerr/Downloads/DownloadCard';
import { DOWNLOADS_LAYOUTS } from '@app/components/Allseerr/Downloads/DownloadCard';
import {
  LayoutToggle,
  ListFrame,
} from '@app/components/Allseerr/Downloads/DownloadsCommon';
import RequestCard, {
  REQUEST_LIST_GRID,
} from '@app/components/Allseerr/RequestList/RequestCard';
import RequesterSelect from '@app/components/Allseerr/RequestList/RequesterSelect';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import Tooltip from '@app/components/Common/Tooltip';
import useComicsEnabled from '@app/hooks/useComicsEnabled';
import { useUpdateQueryParams } from '@app/hooks/useUpdateQueryParams';
import { Permission, useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
} from '@heroicons/react/24/solid';
import type { RequestResultsResponse } from '@server/interfaces/api/requestInterfaces';
import type { UserResultsResponse } from '@server/interfaces/api/userInterfaces';
import Link from 'next/link';
import { useRouter } from 'next/router';
import type { ChangeEvent, ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.Allseerr.RequestList', {
  requests: 'Requests',
  everyone: 'Everyone',
  requesterFilter: 'Requested By',
  searchPeople: 'Search people',
  noPeopleFound: 'No one matches that name',
  showingAll: 'Showing all {count} requests',
  showingUser: "Showing {name}'s {count} requests",
  showingYours: 'Showing your {count} requests',
  showAllRequests: 'Show All Requests',
  sortAdded: 'Most Recent',
  sortModified: 'Last Modified',
  sortDirection: 'Toggle Sort Direction',
  statusFilter: 'Status',
  mediaTypeFilter: 'Media type',
  sortFilter: 'Sort',
  pageSize: 'Results per page',
  removalRequests: 'Removal Requests',
  columnTitle: 'Title',
  columnStatus: 'Status',
  columnRequested: 'Requested',
  columnDetails: 'Details',
  unableToConnect:
    'Unable to connect to {services}. Some information may be unavailable.',
});

enum Filter {
  ALL = 'all',
  PENDING = 'pending',
  APPROVED = 'approved',
  PROCESSING = 'processing',
  AVAILABLE = 'available',
  UNAVAILABLE = 'unavailable',
  FAILED = 'failed',
  DELETED = 'deleted',
  COMPLETED = 'completed',
}

type Sort = 'added' | 'modified';

type SortDirection = 'asc' | 'desc';

type MediaType = 'all' | 'movie' | 'tv' | 'music' | 'book' | 'comic';

const pillControl =
  'inline-flex h-10 flex-none items-center justify-center rounded-full border border-as-line bg-transparent text-sm font-semibold text-as-ink transition hover:border-as-line-strong hover:bg-as-surface disabled:cursor-not-allowed disabled:opacity-40';

/** Compact rounded select used for the header filters. */
const PillSelect = ({
  id,
  label,
  value,
  onChange,
  children,
}: {
  id: string;
  label: string;
  value: string | number;
  onChange: (e: ChangeEvent<HTMLSelectElement>) => void;
  children: ReactNode;
}) => (
  <select
    id={id}
    name={id}
    aria-label={label}
    value={value}
    onChange={onChange}
    className="block h-10 !w-auto !flex-none cursor-pointer rounded-full border border-as-line bg-transparent py-0 pl-4 pr-9 text-sm font-semibold leading-none text-as-ink transition hover:border-as-line-strong focus:border-as-accent focus:ring-0 sm:text-sm sm:leading-none [&>option]:bg-as-surface"
  >
    {children}
  </select>
);

/**
 * Ambient version of the request list: requester avatars, filters as pills
 * and the requests as a card grid. Same data and actions as the classic list.
 */
const AmbientRequestList = () => {
  const router = useRouter();
  const intl = useIntl();
  const comicsEnabled = useComicsEnabled();
  const { user } = useUser({ id: Number(router.query.userId) });
  const { user: currentUser, hasPermission } = useUser();
  const [currentFilter, setCurrentFilter] = useState<Filter>(Filter.PENDING);
  const [currentSort, setCurrentSort] = useState<Sort>('added');
  const [currentMediaType, setCurrentMediaType] = useState<string>('all');
  const [currentSortDirection, setCurrentSortDirection] =
    useState<SortDirection>('desc');
  const [currentPageSize, setCurrentPageSize] = useState<number>(10);
  const [layout, setLayout] = useState<DownloadsLayout>('cards');

  const page = router.query.page ? Number(router.query.page) : 1;
  const pageIndex = page - 1;
  const updateQueryParams = useUpdateQueryParams({ page: page.toString() });
  const onProfile = router.pathname.startsWith('/profile');
  const onUserPage = router.pathname.startsWith('/users/');
  const selectedUserId = router.query.userId
    ? Number(router.query.userId)
    : undefined;

  const {
    data,
    error,
    mutate: revalidate,
  } = useSWR<RequestResultsResponse>(
    `/api/v1/request?take=${currentPageSize}&skip=${
      pageIndex * currentPageSize
    }&filter=${currentFilter}&mediaType=${currentMediaType}&sort=${currentSort}&sortDirection=${currentSortDirection}${
      onProfile
        ? `&requestedBy=${currentUser?.id}`
        : selectedUserId
          ? `&requestedBy=${selectedUserId}`
          : ''
    }`
  );

  const isManager = hasPermission(Permission.MANAGE_REQUESTS);
  const { data: removalCount } = useSWR<{ pending: number }>(
    isManager ? '/api/v1/removal/count' : null
  );

  // Only users who can see everyone's requests get the requester filter
  const canViewAll = hasPermission(
    [Permission.MANAGE_REQUESTS, Permission.REQUEST_VIEW],
    { type: 'or' }
  );
  const canFilterByRequester = !onProfile && canViewAll;
  const { data: requesters } = useSWR<UserResultsResponse>(
    canFilterByRequester ? '/api/v1/user?take=1000&sort=displayname' : null
  );

  // Restore last set filter values on component mount
  useEffect(() => {
    const filterString = window.localStorage.getItem('rl-filter-settings');

    if (filterString) {
      const filterSettings = JSON.parse(filterString);

      setCurrentFilter(filterSettings.currentFilter);
      setCurrentSort(filterSettings.currentSort);
      if (
        ['all', 'movie', 'tv', 'music', 'book', 'comic'].includes(
          filterSettings.currentMediaType
        )
      ) {
        setCurrentMediaType(filterSettings.currentMediaType);
      }
      setCurrentPageSize(filterSettings.currentPageSize);
      if (['asc', 'desc'].includes(filterSettings.currentSortDirection)) {
        setCurrentSortDirection(filterSettings.currentSortDirection);
      }
      if (DOWNLOADS_LAYOUTS.includes(filterSettings.layout)) {
        setLayout(filterSettings.layout);
      }
    }

    // If filter value is provided in query, use that instead
    if (Object.values(Filter).includes(router.query.filter as Filter)) {
      setCurrentFilter(router.query.filter as Filter);
    }
  }, [router.query.filter]);

  // Set filter values to local storage any time they are changed
  useEffect(() => {
    window.localStorage.setItem(
      'rl-filter-settings',
      JSON.stringify({
        currentFilter,
        currentMediaType,
        currentSort,
        currentSortDirection,
        currentPageSize,
        layout,
      })
    );
  }, [
    currentFilter,
    currentMediaType,
    currentSort,
    currentSortDirection,
    currentPageSize,
    layout,
  ]);

  // Back to the first page, keeping the selected requester
  const resetPage = () =>
    router.push({
      pathname: router.pathname,
      query: router.query.userId ? { userId: router.query.userId } : {},
    });

  const selectRequester = (userId?: number) => {
    if (!userId) {
      router.push('/requests');
    } else if (onUserPage) {
      router.push(`/users/${userId}/requests`);
    } else {
      router.push({ pathname: '/requests', query: { userId } });
    }
  };

  if (!data && !error) {
    return <LoadingSpinner />;
  }

  if (!data) {
    return <LoadingSpinner />;
  }

  const hasNextPage = data.pageInfo.pages > pageIndex + 1;
  const hasPrevPage = pageIndex > 0;
  const selectedName =
    user?.displayName ??
    requesters?.results.find((requester) => requester.id === selectedUserId)
      ?.displayName;
  const showRequester = canViewAll && !selectedUserId && !onProfile;
  const serviceErrors = data.serviceErrors
    ? [
        ...data.serviceErrors.radarr,
        ...data.serviceErrors.sonarr,
        ...(data.serviceErrors.lidarr ?? []),
      ]
    : [];

  return (
    <div className="flex flex-col gap-6 pb-6">
      <PageTitle
        title={[
          intl.formatMessage(messages.requests),
          router.query.userId ? user?.displayName : '',
        ]}
      />

      <div className="flex flex-col gap-4">
        <div className="flex min-w-0 flex-col gap-3 md:flex-row md:items-center md:gap-4">
          <h2 className="flex-none font-display text-[22px] font-medium text-as-ink">
            {intl.formatMessage(messages.requests)}
          </h2>
          {canFilterByRequester && (
            <RequesterSelect
              users={requesters?.results ?? []}
              value={selectedUserId}
              onChange={selectRequester}
              everyoneLabel={intl.formatMessage(messages.everyone)}
              label={intl.formatMessage(messages.requesterFilter)}
              searchPlaceholder={intl.formatMessage(messages.searchPeople)}
              noResultsLabel={intl.formatMessage(messages.noPeopleFound)}
            />
          )}
          <span className="flex-none text-sm text-as-ink-muted">
            {selectedUserId && selectedName
              ? intl.formatMessage(messages.showingUser, {
                  name: (
                    <Link
                      href={`/users/${selectedUserId}`}
                      className="font-semibold text-as-ink-soft hover:text-as-ink hover:underline"
                    >
                      {selectedName}
                    </Link>
                  ),
                  count: data.pageInfo.results,
                })
              : canViewAll && !onProfile
                ? intl.formatMessage(messages.showingAll, {
                    count: data.pageInfo.results,
                  })
                : intl.formatMessage(messages.showingYours, {
                    count: data.pageInfo.results,
                  })}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {!router.query.userId && !onProfile && (
            <Link href="/requests/removals" className={`${pillControl} px-4`}>
              {intl.formatMessage(messages.removalRequests)}
              {!!removalCount?.pending && (
                <span className="ml-2 inline-flex min-w-[1.25rem] items-center justify-center rounded-full bg-as-accent px-1.5 text-[11px] font-bold leading-5 text-as-ground">
                  {removalCount.pending}
                </span>
              )}
            </Link>
          )}
          <PillSelect
            id="mediaType"
            label={intl.formatMessage(messages.mediaTypeFilter)}
            value={currentMediaType}
            onChange={(e) => {
              setCurrentMediaType(e.target.value as MediaType);
              resetPage();
            }}
          >
            <option value="all">
              {intl.formatMessage(globalMessages.all)}
            </option>
            <option value="movie">
              {intl.formatMessage(globalMessages.movies)}
            </option>
            <option value="tv">
              {intl.formatMessage(globalMessages.tvshows)}
            </option>
            <option value="music">
              {intl.formatMessage(globalMessages.music)}
            </option>
            <option value="book">
              {intl.formatMessage(globalMessages.books)}
            </option>
            {comicsEnabled && (
              <option value="comic">
                {intl.formatMessage(globalMessages.comicsandmanga)}
              </option>
            )}
          </PillSelect>
          <PillSelect
            id="filter"
            label={intl.formatMessage(messages.statusFilter)}
            value={currentFilter}
            onChange={(e) => {
              setCurrentFilter(e.target.value as Filter);
              resetPage();
            }}
          >
            <option value="all">
              {intl.formatMessage(globalMessages.all)}
            </option>
            <option value="pending">
              {intl.formatMessage(globalMessages.pending)}
            </option>
            <option value="approved">
              {intl.formatMessage(globalMessages.approved)}
            </option>
            <option value="completed">
              {intl.formatMessage(globalMessages.completed)}
            </option>
            <option value="processing">
              {intl.formatMessage(globalMessages.processing)}
            </option>
            <option value="failed">
              {intl.formatMessage(globalMessages.failed)}
            </option>
            <option value="available">
              {intl.formatMessage(globalMessages.available)}
            </option>
            <option value="unavailable">
              {intl.formatMessage(globalMessages.unavailable)}
            </option>
            <option value="deleted">
              {intl.formatMessage(globalMessages.deleted)}
            </option>
          </PillSelect>
          <PillSelect
            id="sort"
            label={intl.formatMessage(messages.sortFilter)}
            value={currentSort}
            onChange={(e) => {
              setCurrentSort(e.target.value as Sort);
              resetPage();
            }}
          >
            <option value="added">
              {intl.formatMessage(messages.sortAdded)}
            </option>
            <option value="modified">
              {intl.formatMessage(messages.sortModified)}
            </option>
          </PillSelect>
          <Tooltip content={intl.formatMessage(messages.sortDirection)}>
            <button
              type="button"
              className={`${pillControl} w-10`}
              aria-label={intl.formatMessage(messages.sortDirection)}
              onClick={() =>
                setCurrentSortDirection(
                  currentSortDirection === 'asc' ? 'desc' : 'asc'
                )
              }
            >
              {currentSortDirection === 'asc' ? (
                <ArrowUpIcon className="h-4 w-4" />
              ) : (
                <ArrowDownIcon className="h-4 w-4" />
              )}
            </button>
          </Tooltip>
          <div className="ml-auto">
            <LayoutToggle value={layout} onChange={setLayout} />
          </div>
        </div>
      </div>

      {serviceErrors.length > 0 &&
        (isManager || hasPermission(Permission.REQUEST_ADVANCED)) && (
          <div className="flex items-center gap-2.5 rounded-[18px] bg-[#3b3424] px-4 py-3 text-sm text-[#f0d9a8]">
            <ExclamationTriangleIcon className="h-5 w-5 flex-none" />
            <span>
              {intl.formatMessage(messages.unableToConnect, {
                services: serviceErrors.map((s) => s.name).join(', '),
              })}
            </span>
          </div>
        )}

      {data.results.length > 0 ? (
        layout === 'list' ? (
          <ListFrame
            gridClassName={REQUEST_LIST_GRID}
            columns={[
              intl.formatMessage(messages.columnTitle),
              intl.formatMessage(messages.columnStatus),
              intl.formatMessage(messages.columnRequested),
              intl.formatMessage(messages.columnDetails),
              '',
            ]}
          >
            {data.results.map((request) => (
              <RequestCard
                key={`request-list-${request.id}`}
                request={request}
                revalidateList={() => revalidate()}
                showRequester={showRequester}
                layout="list"
              />
            ))}
          </ListFrame>
        ) : (
          <div className="grid grid-cols-1 gap-x-4 gap-y-6 lg:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {data.results.map((request) => (
              <RequestCard
                key={`request-list-${request.id}`}
                request={request}
                revalidateList={() => revalidate()}
                showRequester={showRequester}
              />
            ))}
          </div>
        )
      ) : (
        <div className="flex w-full flex-col items-center justify-center gap-4 rounded-[22px] bg-as-surface py-20">
          <span className="font-display text-lg text-as-ink-muted">
            {intl.formatMessage(globalMessages.noresults)}
          </span>
          {(currentFilter !== Filter.ALL ||
            currentMediaType !== Filter.ALL) && (
            <button
              type="button"
              className="h-10 rounded-full bg-as-accent px-5 text-sm font-bold text-as-ground transition hover:brightness-110"
              onClick={() => {
                setCurrentFilter(Filter.ALL);
                setCurrentMediaType(Filter.ALL);
              }}
            >
              {intl.formatMessage(messages.showAllRequests)}
            </button>
          )}
        </div>
      )}

      <nav
        className="flex flex-col items-center gap-3 sm:flex-row sm:justify-between"
        aria-label="Pagination"
      >
        <p className="hidden text-sm text-as-ink-muted lg:block lg:flex-1">
          {data.results.length > 0 &&
            intl.formatMessage(globalMessages.showingresults, {
              from: pageIndex * currentPageSize + 1,
              to:
                data.results.length < currentPageSize
                  ? pageIndex * currentPageSize + data.results.length
                  : (pageIndex + 1) * currentPageSize,
              total: data.pageInfo.results,
              strong: (msg: ReactNode) => (
                <span className="font-semibold text-as-ink">{msg}</span>
              ),
            })}
        </p>
        <span className="flex items-center gap-2 text-sm text-as-ink-muted sm:flex-1 lg:justify-center">
          {intl.formatMessage(globalMessages.resultsperpage, {
            pageSize: (
              <PillSelect
                id="pageSize"
                label={intl.formatMessage(messages.pageSize)}
                value={currentPageSize}
                onChange={(e) => {
                  setCurrentPageSize(Number(e.target.value));
                  resetPage().then(() => window.scrollTo(0, 0));
                }}
              >
                <option value="5">5</option>
                <option value="10">10</option>
                <option value="25">25</option>
                <option value="50">50</option>
                <option value="100">100</option>
              </PillSelect>
            ),
          })}
        </span>
        <div className="flex gap-2 sm:flex-1 sm:justify-end">
          <button
            type="button"
            className={`${pillControl} gap-1.5 pl-3 pr-4`}
            disabled={!hasPrevPage}
            onClick={() => updateQueryParams('page', (page - 1).toString())}
          >
            <ChevronLeftIcon className="h-4 w-4" />
            {intl.formatMessage(globalMessages.previous)}
          </button>
          <button
            type="button"
            className={`${pillControl} gap-1.5 pl-4 pr-3`}
            disabled={!hasNextPage}
            onClick={() => updateQueryParams('page', (page + 1).toString())}
          >
            {intl.formatMessage(globalMessages.next)}
            <ChevronRightIcon className="h-4 w-4" />
          </button>
        </div>
      </nav>
    </div>
  );
};

export default AmbientRequestList;
