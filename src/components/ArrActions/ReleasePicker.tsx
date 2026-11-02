import type {
  ReleaseFilter,
  ReleaseSort,
} from '@app/components/ArrActions/releaseList';
import {
  filterReleases,
  splitAge,
  targetQuery,
} from '@app/components/ArrActions/releaseList';
import Button from '@app/components/Common/Button';
import { SmallLoadingSpinner } from '@app/components/Common/LoadingSpinner';
import Modal from '@app/components/Common/Modal';
import useInterfaceStyle from '@app/hooks/useInterfaceStyle';
import useToasts from '@app/hooks/useToasts';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { formatBytes } from '@app/utils/numberHelpers';
import {
  ArrowDownTrayIcon,
  ChevronRightIcon,
} from '@heroicons/react/24/outline';
import type {
  ArrActionResponse,
  ArrGrabBody,
  ArrRelease,
  ArrReleasesResponse,
  ArrTarget,
} from '@server/interfaces/api/arrActionInterfaces';
import axios from 'axios';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.ArrActions.ReleasePicker', {
  searchmanually: 'Search Manually',
  searching: 'Searching the indexers in {service}…',
  searchingnote:
    'Searching every indexer can take a minute or two. {seconds, plural, one {# second} other {# seconds}} so far.',
  searchfailed: 'The search in {service} failed: {message}',
  searchagain: 'Search Again',
  noreleases: 'No releases found.',
  nomatches: 'No releases match the filters.',
  approvedonly: 'Approved only',
  allprotocols: 'All protocols',
  usenet: 'Usenet',
  torrent: 'Torrent',
  sortby: 'Sort by',
  sortdefault: 'Best match',
  sortsize: 'Size',
  sortage: 'Age',
  sortseeders: 'Seeders',
  protocol: 'Protocol',
  showing: '{shown, number} of {total, number} releases',
  grab: 'Grab',
  confirmgrab: 'Grab this release?',
  grabbing: 'Grabbing…',
  grabbed: 'Sent {title} to the download client.',
  graberror: 'Could not grab the release: {message}',
  ageHours: '{value, plural, one {# hour} other {# hours}}',
  ageDays: '{value, plural, one {# day} other {# days}}',
  ageYears: '{value, plural, one {# year} other {# years}}',
  seeders: '{seeders, number} seeders',
  peers: '{seeders, number} / {leechers, number} peers',
  score: 'Score {score, number}',
  rejections:
    '{count, plural, one {# reason it was rejected} other {# reasons it was rejected}}',
  approved: 'Approved',
  issueresolved: 'The issue was resolved.',
  alreadygrabbed: 'Already grabbed',
  grabbedimported: 'Grabbed {date}. The file you have now came from it.',
  grabbeddownloading: 'Grabbed {date} and still in {client}.',
  grabbedimportblocked:
    'Grabbed {date} and downloaded, but its import is stuck. Retry the import from Downloads instead of grabbing it again.',
  grabbedearlier: 'Grabbed before, on {date}.',
  downloadclient: 'the download client',
  confirmregrab: 'Grab it again?',
});

interface ReleasePickerProps {
  mediaId: number;
  target: ArrTarget;
  serviceName: string;
  subTitle?: string;
  issueId?: number;
  resolveIssue?: boolean;
  // The file was replaced right before, for the issue comment
  replaced?: boolean;
  onClose: () => void;
  onGrabbed: () => void;
}

// The server waits up to three minutes for the indexers
const SEARCH_TIMEOUT_MS = 200_000;

const errorMessage = (e: unknown): string =>
  (axios.isAxiosError(e) &&
    (e.response?.data as { message?: string } | undefined)?.message) ||
  (e as Error)?.message ||
  '';

/**
 * Lists the releases an arr finds on its indexers for an item, to grab one
 * by hand. Render inside a Transition.
 */
const ReleasePicker = ({
  mediaId,
  target,
  serviceName,
  subTitle,
  issueId,
  resolveIssue,
  replaced,
  onClose,
  onGrabbed,
}: ReleasePickerProps) => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const [interfaceStyle] = useInterfaceStyle();
  const ambient = interfaceStyle === 'ambient';
  const [releases, setReleases] = useState<ArrRelease[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [seconds, setSeconds] = useState(0);
  const [searchKey, setSearchKey] = useState(0);
  const [filter, setFilter] = useState<ReleaseFilter>({
    approvedOnly: false,
    protocol: 'all',
  });
  const [sort, setSort] = useState<ReleaseSort>('default');
  const [confirming, setConfirming] = useState<string | null>(null);
  const [grabbing, setGrabbing] = useState<string | null>(null);
  const query = targetQuery(target);

  useEffect(() => {
    const controller = new AbortController();
    const started = Date.now();
    const timer = setInterval(
      () => setSeconds(Math.floor((Date.now() - started) / 1000)),
      1000
    );

    setReleases(null);
    setError(null);
    setSeconds(0);

    axios
      .get<ArrReleasesResponse>(
        `/api/v1/media/${mediaId}/arr/releases${query}`,
        { signal: controller.signal, timeout: SEARCH_TIMEOUT_MS }
      )
      .then((response) => setReleases(response.data.results))
      .catch((e) => {
        if (!axios.isCancel(e)) {
          setError(errorMessage(e));
        }
      })
      .finally(() => clearInterval(timer));

    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [mediaId, query, searchKey]);

  const shown = useMemo(
    () => (releases ? filterReleases(releases, filter, sort) : []),
    [releases, filter, sort]
  );
  const hasTorrents = releases?.some((r) => r.protocol === 'torrent');
  const protocols = new Set(releases?.map((r) => r.protocol));

  const grab = useCallback(
    async (release: ArrRelease) => {
      setGrabbing(release.guid);
      try {
        const body: ArrGrabBody = {
          ...target,
          guid: release.guid,
          indexerId: release.indexerId,
          title: release.title,
          replaced,
          issueId,
          resolveIssue: issueId ? resolveIssue : undefined,
        };
        const response = await axios.post<ArrActionResponse>(
          `/api/v1/media/${mediaId}/arr/grab`,
          body
        );
        addToast(
          [
            intl.formatMessage(messages.grabbed, { title: release.title }),
            response.data.issueResolved
              ? intl.formatMessage(messages.issueresolved)
              : '',
          ]
            .filter(Boolean)
            .join(' '),
          { appearance: 'success', autoDismiss: true }
        );
        onGrabbed();
      } catch (e) {
        addToast(
          intl.formatMessage(messages.graberror, { message: errorMessage(e) }),
          { appearance: 'error', autoDismiss: true }
        );
      } finally {
        setGrabbing(null);
        setConfirming(null);
      }
    },
    [
      target,
      replaced,
      issueId,
      resolveIssue,
      mediaId,
      addToast,
      intl,
      onGrabbed,
    ]
  );

  const formatAge = (ageHours: number) => {
    const { unit, value } = splitAge(ageHours);
    return intl.formatMessage(
      unit === 'hour'
        ? messages.ageHours
        : unit === 'day'
          ? messages.ageDays
          : messages.ageYears,
      { value }
    );
  };

  const faint = ambient ? 'text-as-ink-faint' : 'text-gray-400';
  const ink = ambient ? 'text-as-ink' : 'text-white';
  const rowClass = ambient
    ? 'rounded-2xl bg-as-tile px-4 py-3'
    : 'rounded-md border border-gray-700 bg-gray-900/40 px-3 py-3';
  const chipClass = ambient
    ? 'rounded-full bg-as-raised px-2 py-0.5 text-[11px] font-semibold text-as-ink-soft'
    : 'rounded bg-gray-700 px-1.5 py-0.5 text-[11px] font-semibold text-gray-200';
  const selectClass = ambient
    ? 'h-9 w-auto min-w-[9rem] rounded-full border border-as-line bg-as-tile py-0 pl-3 pr-9 text-sm text-as-ink'
    : 'h-9 w-auto min-w-[9rem] rounded-md py-0 pr-9 text-sm';

  return (
    <Modal
      title={intl.formatMessage(messages.searchmanually)}
      subTitle={subTitle}
      onCancel={onClose}
      cancelText={intl.formatMessage(globalMessages.close)}
      backgroundClickable={!grabbing}
    >
      {releases === null && !error && (
        <div className="flex flex-col items-center gap-3 py-10 text-center">
          <div className="h-10">
            <SmallLoadingSpinner />
          </div>
          <div className={`font-semibold ${ink}`}>
            {intl.formatMessage(messages.searching, { service: serviceName })}
          </div>
          <div className={`max-w-sm text-xs ${faint}`}>
            {intl.formatMessage(messages.searchingnote, { seconds })}
          </div>
        </div>
      )}

      {error && (
        <div className="flex flex-col items-center gap-3 py-8 text-center">
          <div className={ambient ? 'text-as-bad' : 'text-red-400'}>
            {intl.formatMessage(messages.searchfailed, {
              service: serviceName,
              message: error,
            })}
          </div>
          <Button buttonSize="sm" onClick={() => setSearchKey((k) => k + 1)}>
            {intl.formatMessage(messages.searchagain)}
          </Button>
        </div>
      )}

      {releases && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <label className={`flex items-center gap-2 text-sm ${ink}`}>
              <input
                type="checkbox"
                checked={filter.approvedOnly}
                onChange={(e) =>
                  setFilter({ ...filter, approvedOnly: e.target.checked })
                }
              />
              {intl.formatMessage(messages.approvedonly)}
            </label>
            {protocols.size > 1 && (
              <select
                className={selectClass}
                value={filter.protocol}
                aria-label={intl.formatMessage(messages.protocol)}
                onChange={(e) =>
                  setFilter({
                    ...filter,
                    protocol: e.target.value as ReleaseFilter['protocol'],
                  })
                }
              >
                <option value="all">
                  {intl.formatMessage(messages.allprotocols)}
                </option>
                <option value="usenet">
                  {intl.formatMessage(messages.usenet)}
                </option>
                <option value="torrent">
                  {intl.formatMessage(messages.torrent)}
                </option>
              </select>
            )}
            <select
              className={selectClass}
              value={sort}
              aria-label={intl.formatMessage(messages.sortby)}
              onChange={(e) => setSort(e.target.value as ReleaseSort)}
            >
              <option value="default">
                {intl.formatMessage(messages.sortdefault)}
              </option>
              <option value="size">
                {intl.formatMessage(messages.sortsize)}
              </option>
              <option value="age">
                {intl.formatMessage(messages.sortage)}
              </option>
              {hasTorrents && (
                <option value="seeders">
                  {intl.formatMessage(messages.sortseeders)}
                </option>
              )}
            </select>
            <span className={`text-xs sm:ml-auto ${faint}`}>
              {intl.formatMessage(messages.showing, {
                shown: shown.length,
                total: releases.length,
              })}
            </span>
          </div>

          {shown.length === 0 && (
            <div className={`py-6 text-center ${faint}`}>
              {intl.formatMessage(
                releases.length ? messages.nomatches : messages.noreleases
              )}
            </div>
          )}

          <ul className="space-y-2">
            {shown.map((release) => {
              const key = `${release.indexerId}-${release.guid}`;
              const isConfirming = confirming === key;
              const grabbed = release.grabbed;
              const grabbedNote = grabbed
                ? intl.formatMessage(
                    grabbed.state === 'imported'
                      ? messages.grabbedimported
                      : grabbed.state === 'downloading'
                        ? messages.grabbeddownloading
                        : grabbed.state === 'importBlocked'
                          ? messages.grabbedimportblocked
                          : messages.grabbedearlier,
                    {
                      date: intl.formatDate(grabbed.date, {
                        dateStyle: 'medium',
                      }),
                      client:
                        grabbed.downloadClient ??
                        intl.formatMessage(messages.downloadclient),
                    }
                  )
                : null;

              return (
                <li
                  key={key}
                  className={`${rowClass} ${
                    grabbed
                      ? ambient
                        ? 'ring-2 ring-as-accent/70'
                        : 'ring-2 ring-indigo-500'
                      : ''
                  }`}
                >
                  {grabbed && (
                    <div
                      className={`mb-2 flex flex-wrap items-center gap-2 text-xs ${ink}`}
                    >
                      <span
                        className={
                          ambient
                            ? 'rounded-full bg-as-accent px-2 py-0.5 text-[11px] font-semibold text-as-ground'
                            : 'rounded bg-indigo-600 px-1.5 py-0.5 text-[11px] font-semibold text-white'
                        }
                      >
                        {intl.formatMessage(messages.alreadygrabbed)}
                      </span>
                      <span>{grabbedNote}</span>
                    </div>
                  )}
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
                    <div className="min-w-0 flex-1">
                      <div
                        className={`break-all text-sm font-medium leading-5 ${ink}`}
                      >
                        {release.infoUrl ? (
                          <a
                            href={release.infoUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="hover:underline"
                          >
                            {release.title}
                          </a>
                        ) : (
                          release.title
                        )}
                      </div>
                      <div
                        className={`mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs ${faint}`}
                      >
                        <span className={chipClass}>{release.quality}</span>
                        {release.approved && (
                          <span
                            className={
                              ambient
                                ? 'rounded-full bg-[#1d3b33] px-2 py-0.5 text-[11px] font-semibold text-[#a8e6c4]'
                                : 'rounded bg-green-800 px-1.5 py-0.5 text-[11px] font-semibold text-green-100'
                            }
                          >
                            {intl.formatMessage(messages.approved)}
                          </span>
                        )}
                        <span>{formatBytes(release.size, 1)}</span>
                        <span>{formatAge(release.ageHours)}</span>
                        <span className="break-all">{release.indexer}</span>
                        {release.protocol === 'torrent' ? (
                          <span>
                            {release.leechers !== undefined
                              ? intl.formatMessage(messages.peers, {
                                  seeders: release.seeders ?? 0,
                                  leechers: release.leechers,
                                })
                              : intl.formatMessage(messages.seeders, {
                                  seeders: release.seeders ?? 0,
                                })}
                          </span>
                        ) : (
                          release.protocol === 'usenet' && (
                            <span>{intl.formatMessage(messages.usenet)}</span>
                          )
                        )}
                        {release.languages.length > 0 && (
                          <span>{release.languages.join(', ')}</span>
                        )}
                        {!!release.customFormatScore && (
                          <span>
                            {intl.formatMessage(messages.score, {
                              score: release.customFormatScore,
                            })}
                          </span>
                        )}
                      </div>
                      {release.rejections.length > 0 && (
                        <details className="group mt-1.5 text-xs">
                          <summary
                            className={`flex cursor-pointer list-none flex-wrap items-center gap-1 ${
                              ambient ? 'text-as-warn' : 'text-yellow-500'
                            }`}
                          >
                            <ChevronRightIcon className="h-3 w-3 transition group-open:rotate-90" />
                            {intl.formatMessage(messages.rejections, {
                              count: release.rejections.length,
                            })}
                            {release.rejectionLabels?.map((label) => (
                              <span
                                key={`${key}-label-${label}`}
                                className={
                                  ambient
                                    ? 'rounded border border-as-warn/40 px-1.5 py-px text-[11px] font-semibold'
                                    : 'rounded bg-yellow-900/60 px-1.5 py-px text-[11px] font-semibold text-yellow-200'
                                }
                              >
                                {label}
                              </span>
                            ))}
                          </summary>
                          <ul
                            className={`mt-1 list-disc space-y-0.5 pl-6 ${faint}`}
                          >
                            {release.rejections.map((rejection, i) => (
                              <li key={`${key}-rejection-${i}`}>{rejection}</li>
                            ))}
                          </ul>
                        </details>
                      )}
                    </div>
                    <div className="flex shrink-0 gap-2 sm:flex-col sm:items-end">
                      {isConfirming ? (
                        <>
                          <Button
                            buttonType="primary"
                            buttonSize="sm"
                            className="flex-1 sm:flex-none"
                            disabled={!!grabbing}
                            onClick={() => grab(release)}
                          >
                            <ArrowDownTrayIcon />
                            <span>
                              {intl.formatMessage(
                                grabbing === release.guid
                                  ? messages.grabbing
                                  : grabbed
                                    ? messages.confirmregrab
                                    : messages.confirmgrab
                              )}
                            </span>
                          </Button>
                          <Button
                            buttonSize="sm"
                            disabled={!!grabbing}
                            onClick={() => setConfirming(null)}
                          >
                            {intl.formatMessage(globalMessages.cancel)}
                          </Button>
                        </>
                      ) : (
                        <Button
                          buttonType={
                            release.approved && !grabbed ? 'primary' : 'default'
                          }
                          buttonSize="sm"
                          className="w-full sm:w-auto"
                          disabled={!!grabbing}
                          onClick={() => setConfirming(key)}
                        >
                          <ArrowDownTrayIcon />
                          <span>{intl.formatMessage(messages.grab)}</span>
                        </Button>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </Modal>
  );
};

export default ReleasePicker;
