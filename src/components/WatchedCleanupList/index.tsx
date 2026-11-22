import Button from '@app/components/Common/Button';
import CachedImage from '@app/components/Common/CachedImage';
import ConfirmButton from '@app/components/Common/ConfirmButton';
import Header from '@app/components/Common/Header';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import useToasts from '@app/hooks/useToasts';
import defineMessages from '@app/utils/defineMessages';
import type {
  WatchedCleanupActionResponse,
  WatchedCleanupResponse,
} from '@server/interfaces/api/removalInterfaces';
import type { CleanupSuggestion } from '@server/lib/watchedCleanup';
import axios from 'axios';
import Link from 'next/link';
import { useState } from 'react';
import { FormattedRelativeTime, useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.WatchedCleanupList', {
  title: 'Watched Cleanup',
  removalrequests: 'Removal Requests',
  description:
    'Requested movies and series that everyone who asked for them has watched. Nothing is removed until you choose titles below.',
  disabled:
    'Watched cleanup suggestions are turned off. Turn them on in Settings > Users.',
  empty: 'Nothing to clean up. Every requested title still has a viewer.',
  selectAll: 'Select All',
  selected: '{count} selected',
  createRequests: 'Create Removal Requests',
  removeNow: 'Remove Now',
  confirmRemove: 'Remove {count, plural, one {# Title} other {# Titles}}?',
  watchedBy: 'Watched by {names}',
  lastWatched: 'Last watched',
  is4k: '4K',
  requestsCreated:
    '{count, plural, one {# removal request} other {# removal requests}} created',
  removed: '{count, plural, one {# title} other {# titles}} removed',
  someFailed:
    '{count, plural, one {# title} other {# titles}} could not be handled',
});

const itemKey = (s: Pick<CleanupSuggestion, 'mediaId' | 'is4k'>) =>
  `${s.mediaId}:${s.is4k ? '4k' : 'hd'}`;

const WatchedCleanupList = () => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [isWorking, setIsWorking] = useState(false);
  const { data, error, mutate } = useSWR<WatchedCleanupResponse>(
    '/api/v1/removal/suggestions'
  );

  const results = data?.results ?? [];
  const allSelected =
    results.length > 0 && results.every((s) => selected.has(itemKey(s)));

  const toggle = (key: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });

  const act = async (action: 'request' | 'remove') => {
    setIsWorking(true);

    try {
      const response = await axios.post<WatchedCleanupActionResponse>(
        '/api/v1/removal/suggestions',
        {
          action,
          items: results
            .filter((s) => selected.has(itemKey(s)))
            .map((s) => ({ mediaId: s.mediaId, is4k: s.is4k })),
        }
      );
      const done = response.data.results.filter(
        (r) => r.status === 'requested' || r.status === 'removed'
      ).length;
      const failed = response.data.results.length - done;

      if (done > 0) {
        addToast(
          intl.formatMessage(
            action === 'remove' ? messages.removed : messages.requestsCreated,
            { count: done }
          ),
          { appearance: 'success', autoDismiss: true }
        );
      }
      if (failed > 0) {
        addToast(intl.formatMessage(messages.someFailed, { count: failed }), {
          appearance: 'error',
          autoDismiss: true,
        });
      }
    } catch (e) {
      addToast(e.response?.data?.message ?? e.message, {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      setSelected(new Set());
      setIsWorking(false);
      mutate();
    }
  };

  return (
    <>
      <PageTitle title={intl.formatMessage(messages.title)} />
      <div className="mb-4">
        <Header
          subtext={
            <Link href="/requests/removals" className="hover:underline">
              {intl.formatMessage(messages.removalrequests)}
            </Link>
          }
        >
          {intl.formatMessage(messages.title)}
        </Header>
        <p className="mt-2 text-sm text-gray-400">
          {intl.formatMessage(messages.description)}
        </p>
      </div>
      {error?.response?.status === 403 ? (
        <div className="py-24 text-center text-gray-400">
          {intl.formatMessage(messages.disabled)}
        </div>
      ) : !data && !error ? (
        <LoadingSpinner />
      ) : results.length === 0 ? (
        <div className="py-24 text-center text-2xl text-gray-400">
          {intl.formatMessage(messages.empty)}
        </div>
      ) : (
        <>
          <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center">
            <label className="flex flex-1 items-center gap-2 text-sm text-gray-300">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={() =>
                  setSelected(
                    allSelected ? new Set() : new Set(results.map(itemKey))
                  )
                }
              />
              {selected.size > 0
                ? intl.formatMessage(messages.selected, {
                    count: selected.size,
                  })
                : intl.formatMessage(messages.selectAll)}
            </label>
            <Button
              buttonType="warning"
              buttonSize="sm"
              disabled={selected.size === 0 || isWorking}
              onClick={() => act('request')}
            >
              {intl.formatMessage(messages.createRequests)}
            </Button>
            {selected.size > 0 && !isWorking && (
              <ConfirmButton
                className="h-8 text-sm"
                onClick={() => act('remove')}
                confirmText={intl.formatMessage(messages.confirmRemove, {
                  count: selected.size,
                })}
              >
                {intl.formatMessage(messages.removeNow)}
              </ConfirmButton>
            )}
          </div>
          <ul className="space-y-2">
            {results.map((suggestion) => {
              const key = itemKey(suggestion);

              return (
                <li
                  key={key}
                  className="flex items-center gap-4 rounded-xl bg-gray-800 p-3 ring-1 ring-gray-700"
                >
                  <input
                    type="checkbox"
                    checked={selected.has(key)}
                    onChange={() => toggle(key)}
                    aria-label={suggestion.title ?? String(suggestion.tmdbId)}
                  />
                  <div className="relative h-20 w-14 flex-shrink-0 overflow-hidden rounded-md">
                    <CachedImage
                      type="tmdb"
                      src={
                        suggestion.posterPath
                          ? `https://image.tmdb.org/t/p/w300_and_h450_face${suggestion.posterPath}`
                          : '/images/allseerr_poster_not_found.png'
                      }
                      alt=""
                      fill
                      style={{ objectFit: 'cover' }}
                    />
                  </div>
                  <div className="min-w-0 flex-1">
                    <Link
                      href={`/${suggestion.mediaType === 'movie' ? 'movie' : 'tv'}/${suggestion.tmdbId}`}
                      className="block truncate font-semibold text-white hover:underline"
                    >
                      {suggestion.title ?? `TMDB ${suggestion.tmdbId}`}
                      {suggestion.is4k && (
                        <span className="ml-2 text-xs text-gray-400">
                          {intl.formatMessage(messages.is4k)}
                        </span>
                      )}
                    </Link>
                    <div className="truncate text-sm text-gray-300">
                      {intl.formatMessage(messages.watchedBy, {
                        names: suggestion.requesters
                          .map((r) => r.displayName)
                          .join(', '),
                      })}
                    </div>
                    {suggestion.lastWatchedAt && (
                      <div className="text-xs text-gray-400">
                        {intl.formatMessage(messages.lastWatched)}{' '}
                        <FormattedRelativeTime
                          value={Math.floor(
                            (new Date(suggestion.lastWatchedAt).getTime() -
                              Date.now()) /
                              1000
                          )}
                          updateIntervalInSeconds={60}
                          numeric="auto"
                        />
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </>
  );
};

export default WatchedCleanupList;
