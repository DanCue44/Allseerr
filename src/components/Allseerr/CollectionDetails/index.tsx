import { ambientGrid } from '@app/components/Allseerr/ListPage';
import { TitleHero } from '@app/components/Allseerr/Title';
import StatusPill from '@app/components/Allseerr/Title/StatusPill';
import {
  chip,
  pillIcon,
  pillPrimary,
  pillSecondary,
  statusTone,
} from '@app/components/Allseerr/Title/styles';
import BlocklistModal from '@app/components/BlocklistModal';
import Button from '@app/components/Common/Button';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import Tooltip from '@app/components/Common/Tooltip';
import RequestModal from '@app/components/RequestModal';
import TitleCard from '@app/components/TitleCard';
import useSettings from '@app/hooks/useSettings';
import useToasts from '@app/hooks/useToasts';
import { Permission, useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import ErrorPage from '@app/pages/_error';
import defineMessages from '@app/utils/defineMessages';
import { refreshIntervalHelper } from '@app/utils/refreshIntervalHelper';
import {
  ArrowDownTrayIcon,
  EyeIcon,
  EyeSlashIcon,
} from '@heroicons/react/24/outline';
import { MediaStatus } from '@server/constants/media';
import type { Collection } from '@server/models/Collection';
import axios from 'axios';
import { uniq } from 'lodash';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useMemo, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.Allseerr.CollectionDetails', {
  overview: 'Overview',
  overviewunavailable: 'Overview unavailable.',
  numberofmovies: '{count} Movies',
  removefromblocklistpartialcount:
    '{removeLabel} ({count, plural, one {# movie} other {# movies}})',
  requestcollection: 'Request Collection',
  requestcollection4k: 'Request Collection in 4K',
  downloading: 'Downloading: {titles}',
  downloading4k: 'Downloading in 4K: {titles}',
  movies: 'Movies',
  nomovies: 'No movies in this collection.',
});

const returnCollectionDownloadItems = (data: Collection | undefined) => {
  const [downloadStatus, downloadStatus4k] = [
    data?.parts.flatMap((item) =>
      item.mediaInfo?.downloadStatus ? item.mediaInfo?.downloadStatus : []
    ),
    data?.parts.flatMap((item) =>
      item.mediaInfo?.downloadStatus4k ? item.mediaInfo?.downloadStatus4k : []
    ),
  ];

  return { downloadStatus, downloadStatus4k };
};

interface CollectionDetailsProps {
  collection?: Collection;
}

/**
 * Ambient collection page: backdrop hero with the poster, overview, request
 * and blocklist actions as pills, and the movies as a card grid. Same data
 * and actions as the classic page.
 */
const AmbientCollectionDetails = ({ collection }: CollectionDetailsProps) => {
  const intl = useIntl();
  const router = useRouter();
  const settings = useSettings();
  const { hasPermission } = useUser();
  const [requestModal, setRequestModal] = useState(false);
  const [is4k, setIs4k] = useState(false);
  const [showBlocklistModal, setShowBlocklistModal] = useState(false);
  const [isBlocklistUpdating, setIsBlocklistUpdating] = useState(false);
  const { addToast } = useToasts();

  const {
    data,
    error,
    mutate: revalidate,
  } = useSWR<Collection>(`/api/v1/collection/${router.query.collectionId}`, {
    fallbackData: collection,
    revalidateOnMount: true,
    refreshInterval: refreshIntervalHelper(
      returnCollectionDownloadItems(collection),
      15000
    ),
  });

  const { data: genres } =
    useSWR<{ id: number; name: string }[]>(`/api/v1/genres/movie`);

  const onClickHideItemBtn = async (): Promise<void> => {
    setIsBlocklistUpdating(true);

    try {
      await axios.post(`/api/v1/blocklist/collection/${data?.id}`);

      addToast(
        <span>
          {intl.formatMessage(globalMessages.blocklistSuccess, {
            title: data?.name,
            strong: (msg: React.ReactNode) => <strong>{msg}</strong>,
          })}
        </span>,
        { appearance: 'success', autoDismiss: true }
      );

      revalidate();
    } catch {
      addToast(intl.formatMessage(globalMessages.blocklistError), {
        appearance: 'error',
        autoDismiss: true,
      });
    }

    setIsBlocklistUpdating(false);
    setShowBlocklistModal(false);
  };

  const onClickUnblocklistBtn = async (): Promise<void> => {
    if (!data) return;

    setIsBlocklistUpdating(true);

    try {
      await axios.delete(`/api/v1/blocklist/collection/${data.id}`);

      addToast(
        <span>
          {intl.formatMessage(globalMessages.removeFromBlocklistSuccess, {
            title: data.name,
            strong: (msg: React.ReactNode) => <strong>{msg}</strong>,
          })}
        </span>,
        { appearance: 'success', autoDismiss: true }
      );

      revalidate();
    } catch {
      addToast(intl.formatMessage(globalMessages.blocklistError), {
        appearance: 'error',
        autoDismiss: true,
      });
    }

    setIsBlocklistUpdating(false);
  };

  const [downloadStatus, downloadStatus4k] = useMemo(() => {
    const downloadItems = returnCollectionDownloadItems(data);
    return [downloadItems.downloadStatus, downloadItems.downloadStatus4k];
  }, [data]);

  const [titles, titles4k] = useMemo(() => {
    return [
      data?.parts
        .filter((media) => (media.mediaInfo?.downloadStatus ?? []).length > 0)
        .map((title) => title.title),
      data?.parts
        .filter((media) => (media.mediaInfo?.downloadStatus4k ?? []).length > 0)
        .map((title) => title.title),
    ];
  }, [data?.parts]);

  if (!data && !error) {
    return <LoadingSpinner />;
  }

  if (!data) {
    return <ErrorPage statusCode={404} />;
  }

  let collectionStatus = MediaStatus.UNKNOWN;
  let collectionStatus4k = MediaStatus.UNKNOWN;

  const blocklistedParts = data.parts.filter(
    (part) =>
      part.mediaInfo && part.mediaInfo.status === MediaStatus.BLOCKLISTED
  );
  const isCollectionBlocklisted = blocklistedParts.length > 0;
  const isCollectionPartiallyBlocklisted =
    blocklistedParts.length > 0 && blocklistedParts.length < data.parts.length;

  if (isCollectionBlocklisted) {
    collectionStatus = MediaStatus.BLOCKLISTED;
  } else if (
    data.parts.length > 0 &&
    data.parts.every(
      (part) =>
        part.mediaInfo && part.mediaInfo.status === MediaStatus.AVAILABLE
    )
  ) {
    collectionStatus = MediaStatus.AVAILABLE;
  } else if (
    data.parts.some(
      (part) =>
        part.mediaInfo && part.mediaInfo.status === MediaStatus.AVAILABLE
    )
  ) {
    collectionStatus = MediaStatus.PARTIALLY_AVAILABLE;
  }

  if (
    data.parts.length > 0 &&
    data.parts.every(
      (part) =>
        part.mediaInfo && part.mediaInfo.status4k === MediaStatus.AVAILABLE
    )
  ) {
    collectionStatus4k = MediaStatus.AVAILABLE;
  } else if (
    data.parts.some(
      (part) =>
        part.mediaInfo && part.mediaInfo.status4k === MediaStatus.AVAILABLE
    )
  ) {
    collectionStatus4k = MediaStatus.PARTIALLY_AVAILABLE;
  }

  const hasRequestable =
    hasPermission([Permission.REQUEST, Permission.REQUEST_MOVIE], {
      type: 'or',
    }) &&
    data.parts.filter(
      (part) =>
        !part.mediaInfo ||
        part.mediaInfo.status === MediaStatus.DELETED ||
        part.mediaInfo.status === MediaStatus.UNKNOWN
    ).length > 0;

  const show4k =
    settings.currentSettings.movie4kEnabled &&
    hasPermission([Permission.REQUEST_4K, Permission.REQUEST_4K_MOVIE], {
      type: 'or',
    });

  const hasRequestable4k =
    show4k &&
    data.parts.filter(
      (part) =>
        !part.mediaInfo ||
        part.mediaInfo.status4k === MediaStatus.DELETED ||
        part.mediaInfo.status4k === MediaStatus.UNKNOWN
    ).length > 0;

  const blocklistVisibility = hasPermission(
    [Permission.MANAGE_BLOCKLIST, Permission.VIEW_BLOCKLIST],
    { type: 'or' }
  );

  const genreIds =
    genres && data.parts.some((part) => part.genreIds.length)
      ? uniq(data.parts.flatMap((part) => part.genreIds))
      : [];

  const parts = data.parts.filter((title) => {
    if (!blocklistVisibility) {
      return title.mediaInfo?.status !== MediaStatus.BLOCKLISTED;
    }
    return title;
  });

  const openRequest = (in4k: boolean) => {
    setIs4k(in4k);
    setRequestModal(true);
  };

  return (
    <div className="relative -mx-4 -mt-20 pb-10 lg:-mt-28">
      <PageTitle title={data.name} />
      <RequestModal
        tmdbId={data.id}
        show={requestModal}
        type="collection"
        is4k={is4k}
        onComplete={() => {
          revalidate();
          setRequestModal(false);
        }}
        onCancel={() => setRequestModal(false)}
      />
      <BlocklistModal
        tmdbId={data.id}
        type="collection"
        show={showBlocklistModal}
        onCancel={() => setShowBlocklistModal(false)}
        onComplete={onClickHideItemBtn}
        isUpdating={isBlocklistUpdating}
      />

      <TitleHero
        backdropPath={data.backdropPath}
        posterPath={data.posterPath}
        posterAlt={data.name}
        badges={
          <>
            {isCollectionPartiallyBlocklisted ? (
              <span
                className={`inline-flex rounded-full px-3.5 py-[7px] text-[13px] font-bold ${statusTone.bad}`}
              >
                {intl.formatMessage(globalMessages.partiallyblocklisted)}
              </span>
            ) : (
              <StatusPill
                status={collectionStatus}
                downloads={downloadStatus}
                labelHd={show4k && collectionStatus4k !== MediaStatus.UNKNOWN}
              />
            )}
            {show4k && (
              <StatusPill
                status={collectionStatus4k}
                downloads={downloadStatus4k}
                is4k
              />
            )}
          </>
        }
      >
        <h1
          className="font-display text-3xl font-bold leading-[1.05] tracking-[-1px] text-as-ink sm:text-4xl lg:text-5xl"
          data-testid="media-title"
        >
          {data.name}
        </h1>

        <div className="flex flex-wrap items-center gap-3 text-as-ink-muted">
          <span>
            {intl.formatMessage(messages.numberofmovies, {
              count: data.parts.length,
            })}
          </span>
          {genreIds.length > 0 && <span>·</span>}
          {genreIds.map((genreId) => (
            <Link
              key={`genre-${genreId}`}
              href={`/discover/movies/genre/${genreId}`}
              className={chip}
            >
              {genres?.find((g) => g.id === genreId)?.name}
            </Link>
          ))}
        </div>

        {(titles?.length ?? 0) > 0 && (
          <p className="text-[13px] text-as-ink-muted">
            {intl.formatMessage(messages.downloading, {
              titles: titles?.join(', '),
            })}
          </p>
        )}
        {show4k && (titles4k?.length ?? 0) > 0 && (
          <p className="text-[13px] text-as-ink-muted">
            {intl.formatMessage(messages.downloading4k, {
              titles: titles4k?.join(', '),
            })}
          </p>
        )}

        <div className="flex max-w-[760px] flex-col gap-1.5">
          <h2 className="text-xs font-bold uppercase tracking-wider text-as-ink-faint">
            {intl.formatMessage(messages.overview)}
          </h2>
          <p className="leading-relaxed text-as-ink-soft">
            {data.overview || intl.formatMessage(messages.overviewunavailable)}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 max-sm:justify-center">
          {hasRequestable && (
            <Button className={pillPrimary} onClick={() => openRequest(false)}>
              <ArrowDownTrayIcon />
              <span>{intl.formatMessage(messages.requestcollection)}</span>
            </Button>
          )}
          {hasRequestable4k && (
            <Button
              className={hasRequestable ? pillSecondary : pillPrimary}
              onClick={() => openRequest(true)}
            >
              <ArrowDownTrayIcon />
              <span>{intl.formatMessage(messages.requestcollection4k)}</span>
            </Button>
          )}
          {hasPermission([Permission.MANAGE_BLOCKLIST], { type: 'or' }) &&
            (isCollectionBlocklisted ? (
              <Tooltip
                content={
                  blocklistedParts.length === data.parts.length
                    ? intl.formatMessage(globalMessages.removefromBlocklist)
                    : intl.formatMessage(
                        messages.removefromblocklistpartialcount,
                        {
                          removeLabel: intl.formatMessage(
                            globalMessages.removefromBlocklist
                          ),
                          count: blocklistedParts.length,
                        }
                      )
                }
              >
                <Button
                  className={pillIcon}
                  onClick={onClickUnblocklistBtn}
                  disabled={isBlocklistUpdating}
                  aria-label={intl.formatMessage(
                    globalMessages.removefromBlocklist
                  )}
                >
                  <EyeIcon />
                </Button>
              </Tooltip>
            ) : (
              <Tooltip
                content={intl.formatMessage(globalMessages.addToBlocklist)}
              >
                <Button
                  className={pillIcon}
                  onClick={() => setShowBlocklistModal(true)}
                  disabled={isBlocklistUpdating}
                  aria-label={intl.formatMessage(globalMessages.addToBlocklist)}
                >
                  <EyeSlashIcon />
                </Button>
              </Tooltip>
            ))}
        </div>
      </TitleHero>

      <section className="flex flex-col gap-4 px-4 pt-[34px] lg:px-10">
        <h2 className="flex items-baseline gap-2.5 font-display text-[22px] font-medium text-as-ink">
          {intl.formatMessage(messages.movies)}
          {parts.length > 0 && (
            <span className="text-base text-as-ink-faint">
              {intl.formatNumber(parts.length)}
            </span>
          )}
        </h2>
        {parts.length === 0 ? (
          <p className="text-as-ink-muted">
            {intl.formatMessage(messages.nomovies)}
          </p>
        ) : (
          <ul className={ambientGrid}>
            {parts.map((title) => (
              <li key={`collection-movie-${title.id}`}>
                <TitleCard
                  id={title.id}
                  isAddedToWatchlist={title.mediaInfo?.watchlists?.length ?? 0}
                  image={title.posterPath}
                  status={title.mediaInfo?.status}
                  watched={title.mediaInfo?.watched}
                  summary={title.overview}
                  title={title.title}
                  userScore={title.voteAverage}
                  year={title.releaseDate}
                  mediaType={title.mediaType}
                  inProgress={
                    (title.mediaInfo?.downloadStatus ?? []).length > 0
                  }
                  mutateParent={revalidate}
                  canExpand
                />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
};

export default AmbientCollectionDetails;
