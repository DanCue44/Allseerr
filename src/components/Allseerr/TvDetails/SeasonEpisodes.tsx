import CachedImage from '@app/components/Common/CachedImage';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import EpisodeWatchedToggle from '@app/components/WatchedButton/EpisodeWatchedToggle';
import SeasonWatchedButton from '@app/components/WatchedButton/SeasonWatchedButton';
import useTvWatched from '@app/hooks/useTvWatched';
import defineMessages from '@app/utils/defineMessages';
import {
  ArrowDownTrayIcon,
  CheckCircleIcon,
  ClockIcon,
  ExclamationCircleIcon,
  MinusIcon,
} from '@heroicons/react/24/solid';
import type { EpisodeAvailability } from '@server/lib/episodeAvailability';
import type { SeasonWithEpisodes } from '@server/models/Tv';
import { useState } from 'react';
import { FormattedRelativeTime, useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages(
  'components.Allseerr.TvDetails.SeasonEpisodes',
  {
    somethingwentwrong: 'Something went wrong while retrieving season data.',
    noepisodes: 'Episode list unavailable.',
    title: 'Title',
    airDate: 'Air Date',
    tba: 'TBA',
    today: 'Today',
    status: 'Status',
    available: 'Available',
    downloading: 'Downloading',
    missing: 'Missing',
    wanted: 'Not aired yet',
    unmonitored: 'Not monitored',
    watched: 'Watched',
  }
);

// Tailwind only makes the classes it can read, so every column mix is spelled out
const COLUMNS = {
  base: 'grid-cols-[2.5rem_minmax(0,1fr)_auto]',
  status: 'grid-cols-[2.5rem_minmax(0,1fr)_auto_1.25rem]',
  marks: 'grid-cols-[2.5rem_minmax(0,1fr)_auto_1.5rem]',
  both: 'grid-cols-[2.5rem_minmax(0,1fr)_auto_1.25rem_1.5rem]',
};

const DAY_MS = 1000 * 60 * 60 * 24;

const STATUS_STYLE: Record<
  EpisodeAvailability,
  { Icon: React.ComponentType<{ className?: string }>; className: string }
> = {
  available: { Icon: CheckCircleIcon, className: 'text-as-ok' },
  downloading: { Icon: ArrowDownTrayIcon, className: 'text-as-accent' },
  missing: { Icon: ExclamationCircleIcon, className: 'text-as-bad' },
  wanted: { Icon: ClockIcon, className: 'text-as-ink-faint' },
  unmonitored: { Icon: MinusIcon, className: 'text-as-ink-faint' },
};

const StatusIcon = ({
  status,
  label,
}: {
  status?: EpisodeAvailability;
  label: string;
}) => {
  if (!status) {
    return <span aria-hidden="true" />;
  }
  const { Icon, className } = STATUS_STYLE[status];

  return (
    <span className="flex justify-end" title={label}>
      <Icon className={`h-[18px] w-[18px] ${className}`} aria-hidden="true" />
      <span className="sr-only">{label}</span>
    </span>
  );
};

// TMDB air dates have no time or zone, so they are compared as UTC days
const dayDiff = (airDate: string): number => {
  const date = new Date(airDate);
  date.setUTCHours(0, 0, 0, 0);
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  return Math.round((date.getTime() - today.getTime()) / DAY_MS);
};

/**
 * Episodes of a season as a compact list, newest first, with each air date
 * in its own column like Sonarr. Upcoming episodes are dimmed and say when
 * they air; tapping a title shows its summary. People with a media server
 * account also see an eye per episode to mark it watched.
 */
const SeasonEpisodes = ({
  seasonNumber,
  tvId,
  mediaId,
}: {
  seasonNumber: number;
  tvId: number;
  /** The title's media id, when the server has it, for marking episodes */
  mediaId?: number;
}) => {
  const intl = useIntl();
  const [openEpisode, setOpenEpisode] = useState<number | null>(null);
  const { watched, canMark } = useTvWatched(tvId);
  const showMarks = canMark && !!mediaId;
  const seasonSummary = watched?.seasons[seasonNumber];
  const { data, error } = useSWR<SeasonWithEpisodes>(
    `/api/v1/tv/${tvId}/season/${seasonNumber}`
  );
  // Which episodes are in the library, from Sonarr; empty when unknown
  const { data: availability } = useSWR<{
    episodes: Record<number, EpisodeAvailability>;
  }>(`/api/v1/tv/${tvId}/season/${seasonNumber}/availability`);
  const statuses = availability?.episodes ?? {};
  const hasStatuses = Object.keys(statuses).length > 0;
  const statusLabel = (status: EpisodeAvailability) =>
    intl.formatMessage(messages[status]);
  const legend = (
    ['available', 'downloading', 'missing', 'wanted'] as const
  ).filter((status) => Object.values(statuses).includes(status));
  const columns = hasStatuses
    ? showMarks
      ? COLUMNS.both
      : COLUMNS.status
    : showMarks
      ? COLUMNS.marks
      : COLUMNS.base;

  if (!data && !error) {
    return <LoadingSpinner />;
  }

  if (!data) {
    return (
      <p className="py-4 text-sm text-as-ink-muted">
        {intl.formatMessage(messages.somethingwentwrong)}
      </p>
    );
  }

  if (data.episodes.length === 0) {
    return (
      <p className="py-4 text-sm text-as-ink-muted">
        {intl.formatMessage(messages.noepisodes)}
      </p>
    );
  }

  return (
    <div className="py-2">
      {showMarks && mediaId && (
        <div className="flex justify-end px-1 pb-2">
          <SeasonWatchedButton
            mediaId={mediaId}
            tvId={tvId}
            seasonNumber={seasonNumber}
            watched={
              (seasonSummary?.watchedEpisodes ?? 0) >= data.episodes.length
            }
          />
        </div>
      )}
      {legend.length > 1 && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 px-1 pb-3 text-[12px] text-as-ink-muted">
          {legend.map((status) => {
            const { Icon, className } = STATUS_STYLE[status];
            return (
              <span key={status} className="inline-flex items-center gap-1.5">
                <Icon
                  className={`h-3.5 w-3.5 ${className}`}
                  aria-hidden="true"
                />
                {statusLabel(status)}
              </span>
            );
          })}
        </div>
      )}
      <div
        className={`grid ${columns} gap-x-3 border-b border-as-line px-1 pb-2 text-[11px] font-semibold uppercase tracking-wide text-as-ink-faint`}
      >
        <span>#</span>
        <span>{intl.formatMessage(messages.title)}</span>
        <span className="text-right">
          {intl.formatMessage(messages.airDate)}
        </span>
        {hasStatuses && (
          <span className="sr-only">{intl.formatMessage(messages.status)}</span>
        )}
        {showMarks && (
          <span className="sr-only">
            {intl.formatMessage(messages.watched)}
          </span>
        )}
      </div>
      <ul className="divide-y divide-as-line">
        {data.episodes
          .slice()
          .reverse()
          .map((episode) => {
            const diff = episode.airDate ? dayDiff(episode.airDate) : null;
            const upcoming = diff === null || diff > 0;
            const isOpen = openEpisode === episode.episodeNumber;
            const hasDetails = !!episode.overview || !!episode.stillPath;

            return (
              <li key={`season-${seasonNumber}-episode-${episode.id}`}>
                <div
                  className={`grid w-full ${columns} items-center gap-x-3 px-1 py-2.5 text-left text-sm transition ${
                    hasDetails ? 'hover:bg-as-raised/60' : ''
                  } ${upcoming ? 'text-as-ink-faint' : 'text-as-ink'}`}
                >
                  <span className="font-semibold tabular-nums text-as-ink-muted">
                    {episode.episodeNumber}
                  </span>
                  <button
                    type="button"
                    disabled={!hasDetails}
                    onClick={() =>
                      setOpenEpisode(isOpen ? null : episode.episodeNumber)
                    }
                    aria-expanded={hasDetails ? isOpen : undefined}
                    className={`truncate text-left font-medium ${
                      hasDetails ? '' : 'cursor-default'
                    }`}
                  >
                    {episode.name}
                  </button>
                  <span className="whitespace-nowrap text-right tabular-nums">
                    {episode.airDate ? (
                      <>
                        {/* Short dates on phones leave the titles more room */}
                        <span className="sm:hidden">
                          {intl.formatDate(episode.airDate, {
                            year: '2-digit',
                            month: 'numeric',
                            day: 'numeric',
                            timeZone: 'UTC',
                          })}
                        </span>
                        <span className="hidden sm:inline">
                          {intl.formatDate(episode.airDate, {
                            year: 'numeric',
                            month: 'short',
                            day: 'numeric',
                            timeZone: 'UTC',
                          })}
                        </span>
                        {diff !== null && diff >= 0 && diff <= 14 && (
                          <span className="ml-2 rounded-full bg-as-accent/15 px-2 py-0.5 text-[11px] font-semibold text-as-accent">
                            {diff === 0 ? (
                              intl.formatMessage(messages.today)
                            ) : (
                              <FormattedRelativeTime
                                value={diff}
                                unit="day"
                                numeric="auto"
                              />
                            )}
                          </span>
                        )}
                      </>
                    ) : (
                      intl.formatMessage(messages.tba)
                    )}
                  </span>
                  {hasStatuses && (
                    <StatusIcon
                      status={statuses[episode.episodeNumber]}
                      label={
                        statuses[episode.episodeNumber]
                          ? statusLabel(statuses[episode.episodeNumber])
                          : ''
                      }
                    />
                  )}
                  {showMarks && mediaId && (
                    <EpisodeWatchedToggle
                      mediaId={mediaId}
                      tvId={tvId}
                      seasonNumber={seasonNumber}
                      episodeNumber={episode.episodeNumber}
                      state={
                        watched?.episodes[
                          `${seasonNumber}-${episode.episodeNumber}`
                        ]
                      }
                      className="justify-self-end"
                    />
                  )}
                </div>
                {isOpen && (
                  <div className="flex flex-col gap-3 px-1 pb-4 pt-1 sm:flex-row">
                    {episode.stillPath && (
                      <div className="relative aspect-video w-full flex-none overflow-hidden rounded-xl sm:w-48">
                        <CachedImage
                          type="tmdb"
                          src={episode.stillPath}
                          alt=""
                          fill
                          style={{ objectFit: 'cover' }}
                        />
                      </div>
                    )}
                    {episode.overview && (
                      <p className="text-sm leading-relaxed text-as-ink-soft">
                        {episode.overview}
                      </p>
                    )}
                  </div>
                )}
              </li>
            );
          })}
      </ul>
    </div>
  );
};

export default SeasonEpisodes;
