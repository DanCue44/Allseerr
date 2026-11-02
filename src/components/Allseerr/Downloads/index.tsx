import type { DownloadsLayout } from '@app/components/Allseerr/Downloads/DownloadCard';
import DownloadCard, {
  DOWNLOADS_LAYOUTS,
  QUEUE_LIST_GRID,
} from '@app/components/Allseerr/Downloads/DownloadCard';
import {
  EmptyState,
  LayoutToggle,
  ListFrame,
  StatTile,
} from '@app/components/Allseerr/Downloads/DownloadsCommon';
import RemoveDownloadModal from '@app/components/Allseerr/Downloads/RemoveDownloadModal';
import SeedingView from '@app/components/Allseerr/Downloads/SeedingView';
import StickySummary, {
  useScrolledPast,
} from '@app/components/Allseerr/Downloads/StickySummary';
import type {
  DownloadStatusFilter,
  DownloadTab,
} from '@app/components/Allseerr/Downloads/downloadFilters';
import {
  DOWNLOAD_TABS,
  STATUS_FILTERS,
  filterDownloads,
  matchesStatus,
  matchesTab,
} from '@app/components/Allseerr/Downloads/downloadFilters';
import type { DownloadsView } from '@app/components/Allseerr/Downloads/seedingLogic';
import { DOWNLOADS_VIEWS } from '@app/components/Allseerr/Downloads/seedingLogic';
import ReleasePicker from '@app/components/ArrActions/ReleasePicker';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import useSettings from '@app/hooks/useSettings';
import useToasts from '@app/hooks/useToasts';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { Transition } from '@headlessui/react';
import { ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import { isTalearrService } from '@server/constants/bookService';
import type {
  DownloadItem,
  DownloadRemoveBody,
  DownloadRemoveResponse,
  DownloadRetryImportResponse,
  DownloadsResponse,
} from '@server/interfaces/api/downloadInterfaces';
import axios from 'axios';
import { useEffect, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.Allseerr.Downloads', {
  downloads: 'Downloads',
  subtitle: 'Every download from Radarr, Sonarr, Lidarr and {bookService}',
  seedingSubtitle:
    'What {bookService} seeds, and the seeding time private trackers ask for',
  viewQueue: 'Queue',
  viewSeeding: 'Seeding',
  views: 'Downloads view',
  downloading: 'Downloading',
  queued: 'Queued',
  attention: 'Need attention',
  summaryLabel: 'Downloads summary',
  compactDownloading: '{count} downloading',
  compactQueued: '{count} queued',
  compactAttention: '{count} need attention',
  statusFilter: 'Status',
  filterAll: 'All statuses',
  filterDownloading: 'Downloading',
  filterQueued: 'Queued or paused',
  filterImporting: 'Importing',
  filterAttention: 'Needs attention',
  emptyTitle: 'Nothing is downloading',
  emptyText:
    'Downloads from Radarr, Sonarr, Lidarr and {bookService} show up here while they are on their way.',
  noMatches: 'No downloads match these filters',
  showAll: 'Show all downloads',
  unableToConnect: 'Unable to reach {servers}. Their downloads are not shown.',
  loadError: 'Unable to load the downloads.',
  searchStarted: '{server} is searching for {title}.',
  searchError: 'Could not start the search: {message}',
  retryImported: 'Imported {title}.',
  retryImportPending:
    '{server} is still importing {title}. Check back in a minute.',
  retryImportStuck: 'The import of {title} is still stuck: {message}',
  retryImportError: 'Could not retry the import: {message}',
  removed: 'Removed {title} from the queue.',
  removedSearched: 'Removed {title} from the queue and started a new search.',
  removedSearchFailed:
    'Removed {title} from the queue, but could not search again: {message}',
  removeError: 'Could not remove the download: {message}',
  columnTitle: 'Title',
  columnStatus: 'Status',
  columnProgress: 'Progress',
  columnSize: 'Size',
  columnClient: 'Client',
});

const TAB_MESSAGES: Record<DownloadTab, keyof typeof globalMessages> = {
  all: 'all',
  movie: 'movies',
  tv: 'tvshows',
  music: 'music',
  book: 'books',
};

const STATUS_MESSAGES: Record<DownloadStatusFilter, keyof typeof messages> = {
  all: 'filterAll',
  downloading: 'filterDownloading',
  queued: 'filterQueued',
  importing: 'filterImporting',
  attention: 'filterAttention',
};

const REFRESH_MS = 5000;

const errorMessage = (e: unknown): string =>
  (axios.isAxiosError(e) &&
    (e.response?.data as { message?: string } | undefined)?.message) ||
  (e as Error)?.message ||
  '';

/**
 * Every download of every arr in one list for admins, refreshed every few
 * seconds while the page is open
 */
const Downloads = () => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const { currentSettings } = useSettings();
  // Book downloads come from Chaptarr, or Talearr when it is the book service
  const bookService = isTalearrService(currentSettings.bookService)
    ? 'Talearr'
    : 'Chaptarr';
  const [view, setView] = useState<DownloadsView>('queue');
  const [layout, setLayout] = useState<DownloadsLayout>('cards');
  const [tab, setTab] = useState<DownloadTab>('all');
  const [statusFilter, setStatusFilter] = useState<DownloadStatusFilter>('all');
  // The stat tiles, and the filter row a click in the compact summary scrolls to
  const [statsRef, statsHidden] = useScrolledPast();
  const filtersRef = useRef<HTMLDivElement>(null);
  const [removing, setRemoving] = useState<DownloadItem | null>(null);
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState<DownloadItem | null>(null);
  // Seeding is a Talearr extra; other book services get the unsupported
  // state when they open it
  const showSeeding = currentSettings.booksEnabled;
  const activeView = showSeeding ? view : 'queue';
  const { data, error, mutate } = useSWR<DownloadsResponse>(
    activeView === 'queue' ? '/api/v1/downloads' : null,
    {
      refreshInterval: REFRESH_MS,
      refreshWhenHidden: false,
      revalidateOnFocus: true,
    }
  );

  // Remember the filters between visits
  useEffect(() => {
    try {
      const saved = JSON.parse(
        window.localStorage.getItem('downloads-filters') ?? '{}'
      );
      if (DOWNLOAD_TABS.includes(saved.tab)) {
        setTab(saved.tab);
      }
      if (STATUS_FILTERS.includes(saved.status)) {
        setStatusFilter(saved.status);
      }
      if (DOWNLOADS_VIEWS.includes(saved.view)) {
        setView(saved.view);
      }
      if (DOWNLOADS_LAYOUTS.includes(saved.layout)) {
        setLayout(saved.layout);
      }
    } catch {
      // Storage may be blocked, the filters start fresh
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        'downloads-filters',
        JSON.stringify({ tab, status: statusFilter, view, layout })
      );
    } catch {
      // Storage may be blocked
    }
  }, [tab, statusFilter, view, layout]);

  // The navigation badge's count, shared with the layout
  const { data: counts } = useSWR<{ seedingAtRisk?: number }>(
    showSeeding ? '/api/v1/downloads/count' : null,
    { refreshInterval: 60_000 }
  );
  const seedingAtRisk = counts?.seedingAtRisk ?? 0;

  const searchAgain = async (item: DownloadItem) => {
    try {
      await axios.post(
        `/api/v1/downloads/${encodeURIComponent(item.id)}/search`
      );
      addToast(
        intl.formatMessage(messages.searchStarted, {
          server: item.serverName,
          title: item.title,
        }),
        { appearance: 'success', autoDismiss: true }
      );
    } catch (e) {
      addToast(
        intl.formatMessage(messages.searchError, { message: errorMessage(e) }),
        { appearance: 'error', autoDismiss: true }
      );
    }
  };

  const retryImport = async (item: DownloadItem) => {
    try {
      const { data: result } = await axios.post<DownloadRetryImportResponse>(
        `/api/v1/downloads/${encodeURIComponent(item.id)}/retry-import`
      );
      addToast(
        result.imported
          ? intl.formatMessage(messages.retryImported, { title: item.title })
          : result.pending
            ? intl.formatMessage(messages.retryImportPending, {
                server: item.serverName,
                title: item.title,
              })
            : intl.formatMessage(messages.retryImportStuck, {
                title: item.title,
                message: result.message ?? '',
              }),
        {
          appearance: result.imported
            ? 'success'
            : result.pending
              ? 'info'
              : 'warning',
          autoDismiss: true,
        }
      );
      mutate();
    } catch (e) {
      addToast(
        intl.formatMessage(messages.retryImportError, {
          message: errorMessage(e),
        }),
        { appearance: 'error', autoDismiss: true }
      );
    }
  };

  const remove = async (item: DownloadItem, options: DownloadRemoveBody) => {
    setBusy(true);
    try {
      const { data: result } = await axios.post<DownloadRemoveResponse>(
        `/api/v1/downloads/${encodeURIComponent(item.id)}/remove`,
        options
      );
      addToast(
        result.searchError
          ? intl.formatMessage(messages.removedSearchFailed, {
              title: item.title,
              message: result.searchError,
            })
          : intl.formatMessage(
              result.searched ? messages.removedSearched : messages.removed,
              { title: item.title }
            ),
        {
          appearance: result.searchError ? 'warning' : 'success',
          autoDismiss: true,
        }
      );
      setRemoving(null);
      mutate();
    } catch (e) {
      addToast(
        intl.formatMessage(messages.removeError, { message: errorMessage(e) }),
        { appearance: 'error', autoDismiss: true }
      );
    } finally {
      setBusy(false);
    }
  };

  const results = data?.results ?? [];
  const visible = filterDownloads(results, tab, statusFilter);
  const totals = data?.totals;

  // The Queue / Seeding switch and the layout toggle, full size in the page
  // header and compact on the sticky summary
  const viewControls = (compact: boolean) => (
    <>
      {showSeeding && (
        <div
          className={`flex flex-none rounded-full bg-as-surface ${compact ? 'p-0.5' : 'p-1'}`}
          role="tablist"
          aria-label={intl.formatMessage(messages.views)}
        >
          {DOWNLOADS_VIEWS.map((key) => {
            const active = activeView === key;

            return (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setView(key)}
                className={`flex items-center gap-1.5 whitespace-nowrap rounded-full font-semibold transition ${
                  compact ? 'h-7 px-3 text-xs' : 'h-9 px-4 text-sm'
                } ${
                  active
                    ? 'bg-as-raised text-as-ink'
                    : 'text-as-ink-muted hover:text-as-ink'
                }`}
              >
                {intl.formatMessage(
                  key === 'seeding' ? messages.viewSeeding : messages.viewQueue
                )}
                {key === 'seeding' && seedingAtRisk > 0 && (
                  <span className="inline-flex min-w-[1.25rem] items-center justify-center rounded-full bg-[#3b2427] px-1.5 text-[11px] font-bold leading-5 text-[#f2b0aa]">
                    {seedingAtRisk}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
      <LayoutToggle value={layout} onChange={setLayout} compact={compact} />
    </>
  );

  return (
    <div className="flex flex-col gap-6 pb-6">
      <PageTitle title={intl.formatMessage(messages.downloads)} />

      <Transition
        as="div"
        enter="transition-opacity duration-300"
        enterFrom="opacity-0"
        enterTo="opacity-100"
        leave="transition-opacity duration-300"
        leaveFrom="opacity-100"
        leaveTo="opacity-0"
        show={!!removing}
      >
        {removing && (
          <RemoveDownloadModal
            key={removing.id}
            item={removing}
            busy={busy}
            onCancel={() => !busy && setRemoving(null)}
            onRemove={(options) => remove(removing, options)}
          />
        )}
      </Transition>
      <Transition
        as="div"
        enter="transition-opacity duration-300"
        enterFrom="opacity-0"
        enterTo="opacity-100"
        leave="transition-opacity duration-300"
        leaveFrom="opacity-100"
        leaveTo="opacity-0"
        show={!!picking}
      >
        {picking?.mediaId && picking.target && (
          <ReleasePicker
            mediaId={picking.mediaId}
            target={picking.target}
            serviceName={picking.serverName}
            subTitle={picking.title}
            onClose={() => setPicking(null)}
            onGrabbed={() => {
              setPicking(null);
              mutate();
            }}
          />
        )}
      </Transition>

      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-col gap-1">
          <h2 className="font-display text-[22px] font-medium text-as-ink">
            {intl.formatMessage(messages.downloads)}
          </h2>
          <p className="text-sm text-as-ink-muted">
            {intl.formatMessage(
              activeView === 'seeding'
                ? messages.seedingSubtitle
                : messages.subtitle,
              { bookService }
            )}
          </p>
        </div>
        <div className="flex flex-none items-center gap-2 self-start sm:self-auto">
          {viewControls(false)}
        </div>
      </div>

      {activeView === 'seeding' ? (
        <SeedingView layout={layout} summaryActions={viewControls(true)} />
      ) : (
        <>
          <div
            ref={statsRef}
            className="grid grid-cols-3 gap-2 sm:flex sm:gap-3"
          >
            <StatTile
              label={intl.formatMessage(messages.downloading)}
              value={totals?.downloading ?? 0}
            />
            <StatTile
              label={intl.formatMessage(messages.queued)}
              value={totals?.queued ?? 0}
            />
            <StatTile
              label={intl.formatMessage(messages.attention)}
              value={totals?.attention ?? 0}
              tone={
                totals?.attention
                  ? 'bg-[#3b3424] text-[#f0d9a8]'
                  : 'bg-as-surface text-as-ink'
              }
            />
          </div>

          <StickySummary
            show={statsHidden}
            actions={viewControls(true)}
            label={intl.formatMessage(messages.summaryLabel)}
            groups={[
              (
                [
                  [
                    'downloading',
                    messages.compactDownloading,
                    totals?.downloading,
                  ],
                  ['queued', messages.compactQueued, totals?.queued],
                  ['attention', messages.compactAttention, totals?.attention],
                ] as const
              ).map(([key, message, count]) => ({
                key,
                text: intl.formatMessage(message, { count: count ?? 0 }),
                tone:
                  key === 'attention' && count ? 'text-[#f0d9a8]' : undefined,
                active: statusFilter === key,
                onClick: () => {
                  setStatusFilter(statusFilter === key ? 'all' : key);
                  filtersRef.current?.scrollIntoView({ block: 'start' });
                },
              })),
            ]}
          />

          <div
            ref={filtersRef}
            className="flex scroll-mt-36 flex-col gap-3 md:flex-row md:items-center md:justify-between"
          >
            <div
              className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] md:mx-0 md:px-0 md:pb-0"
              role="tablist"
            >
              {DOWNLOAD_TABS.filter(
                (key) =>
                  // Music and books only show when their service is set up
                  (key !== 'music' || currentSettings.musicEnabled) &&
                  (key !== 'book' || currentSettings.booksEnabled)
              ).map((key) => {
                const count = results.filter((item) =>
                  matchesTab(item, key)
                ).length;
                const active = tab === key;

                return (
                  <button
                    key={key}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => setTab(key)}
                    className={`flex h-10 flex-none items-center gap-1.5 whitespace-nowrap rounded-full px-4 text-sm font-semibold transition ${
                      active
                        ? 'bg-as-accent text-as-ground'
                        : 'border border-as-line text-as-ink-soft hover:border-as-line-strong hover:text-as-ink'
                    }`}
                  >
                    {intl.formatMessage(globalMessages[TAB_MESSAGES[key]])}
                    <span
                      className={`text-xs tabular-nums ${
                        active ? 'text-as-ground/80' : 'text-as-ink-faint'
                      }`}
                    >
                      {count}
                    </span>
                  </button>
                );
              })}
            </div>
            <select
              id="downloads-status"
              aria-label={intl.formatMessage(messages.statusFilter)}
              value={statusFilter}
              onChange={(e) =>
                setStatusFilter(e.target.value as DownloadStatusFilter)
              }
              className="block h-10 !w-full !flex-none cursor-pointer rounded-full border border-as-line bg-transparent py-0 pl-4 pr-9 text-sm font-semibold leading-none text-as-ink transition hover:border-as-line-strong focus:border-as-accent focus:ring-0 sm:text-sm sm:leading-none md:!w-auto [&>option]:bg-as-surface"
            >
              {STATUS_FILTERS.map((key) => (
                <option key={key} value={key}>
                  {intl.formatMessage(messages[STATUS_MESSAGES[key]])}
                  {key !== 'all' &&
                    ` (${
                      results.filter(
                        (item) =>
                          matchesTab(item, tab) && matchesStatus(item, key)
                      ).length
                    })`}
                </option>
              ))}
            </select>
          </div>

          {(data?.serverErrors.length ?? 0) > 0 && (
            <div className="flex items-start gap-2.5 rounded-[18px] bg-[#3b3424] px-4 py-3 text-sm text-[#f0d9a8]">
              <ExclamationTriangleIcon className="h-5 w-5 flex-none" />
              <span>
                {intl.formatMessage(messages.unableToConnect, {
                  servers: data?.serverErrors
                    .map((serverError) => serverError.serverName)
                    .join(', '),
                })}
              </span>
            </div>
          )}

          {!data && !error ? (
            <LoadingSpinner />
          ) : !data ? (
            <EmptyState title={intl.formatMessage(messages.loadError)} />
          ) : results.length === 0 ? (
            <EmptyState
              title={intl.formatMessage(messages.emptyTitle)}
              text={intl.formatMessage(messages.emptyText, { bookService })}
            />
          ) : visible.length === 0 ? (
            <EmptyState
              title={intl.formatMessage(messages.noMatches)}
              action={
                <button
                  type="button"
                  onClick={() => {
                    setTab('all');
                    setStatusFilter('all');
                  }}
                  className="mt-1 h-10 rounded-full border border-as-line-strong px-5 text-sm font-semibold text-as-ink transition hover:bg-as-raised"
                >
                  {intl.formatMessage(messages.showAll)}
                </button>
              }
            />
          ) : layout === 'list' ? (
            <ListFrame
              gridClassName={QUEUE_LIST_GRID}
              columns={[
                intl.formatMessage(messages.columnTitle),
                intl.formatMessage(messages.columnStatus),
                intl.formatMessage(messages.columnProgress),
                intl.formatMessage(messages.columnSize),
                intl.formatMessage(messages.columnClient),
              ]}
            >
              {visible.map((item) => (
                <DownloadCard
                  key={item.id}
                  item={item}
                  layout="list"
                  onSearch={searchAgain}
                  onRetryImport={retryImport}
                  onPickRelease={setPicking}
                  onRemove={setRemoving}
                />
              ))}
            </ListFrame>
          ) : (
            <div className="grid grid-cols-1 gap-x-4 gap-y-6 lg:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
              {visible.map((item) => (
                <DownloadCard
                  key={item.id}
                  item={item}
                  onSearch={searchAgain}
                  onRetryImport={retryImport}
                  onPickRelease={setPicking}
                  onRemove={setRemoving}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default Downloads;
