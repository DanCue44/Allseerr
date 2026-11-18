import { TitleHero } from '@app/components/Allseerr/Title';
import Biography from '@app/components/Allseerr/Title/Biography';
import {
  BookCoverCard,
  coverGridClass,
} from '@app/components/Allseerr/Title/CoverCard';
import ScrollingTitle from '@app/components/Allseerr/Title/ScrollingTitle';
import { chip, pillPrimary } from '@app/components/Allseerr/Title/styles';
import Button from '@app/components/Common/Button';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import AuthorCatalogRequestModal from '@app/components/RequestModal/AuthorCatalogRequestModal';
import { BulkRequestTransition } from '@app/components/RequestModal/BulkRequest';
import WatchlistButton from '@app/components/WatchlistButton';
import useSettings from '@app/hooks/useSettings';
import { useUser } from '@app/hooks/useUser';
import ErrorPage from '@app/pages/_error';
import defineMessages from '@app/utils/defineMessages';
import {
  ArrowDownTrayIcon,
  ArrowTopRightOnSquareIcon,
} from '@heroicons/react/24/outline';
import { UserIcon } from '@heroicons/react/24/solid';
import { MediaStatus } from '@server/constants/media';
import { Permission } from '@server/lib/permissions';
import type { AuthorDetails as AuthorDetailsType } from '@server/models/Book';
import type { BookResult } from '@server/models/Search';
import { useRouter } from 'next/router';
import { useMemo, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.Allseerr.AuthorDetails', {
  biographyunavailable: 'No biography is available for this author.',
  lifespan: '{birthDate} to {deathDate}',
  born: 'Born {birthDate}',
  works: 'Works',
  noworks: 'No works are listed for this author.',
  nofilteredworks: 'None of the works shown here match this filter.',
  truncatedworks:
    'Showing the {shown} most published of {total, number} works.',
  wikipedia: 'Wikipedia',
  openlibrary: 'OpenLibrary',
  readmore: 'Read more on Wikipedia',
  openinopenlibrary: 'Open in OpenLibrary',
  requestallbooks: 'Request All Books',
  statworks: 'Works',
  statinlibrary: 'In library',
  statrequested: 'Requested',
  filterall: 'All',
  filterinlibrary: 'In library',
  filternotowned: 'Not owned',
  filterrequested: 'Requested',
  filterworks: 'Show works',
  sortworks: 'Sort works',
  sortpopular: 'Popular',
  sortnewest: 'Newest',
  sortoldest: 'Oldest',
});

type WorksFilter = 'all' | 'library' | 'notowned' | 'requested';
type WorksSort = 'popular' | 'newest' | 'oldest';

const OWNED = [MediaStatus.AVAILABLE, MediaStatus.PARTIALLY_AVAILABLE];
const IN_FLIGHT = [MediaStatus.PENDING, MediaStatus.PROCESSING];

// Either format counts: an ebook or an audiobook in the library is owned
const isInLibrary = (work: BookResult) =>
  OWNED.includes(work.mediaInfo?.status as MediaStatus) ||
  OWNED.includes(work.mediaInfo?.statusAudio as MediaStatus);

const isRequested = (work: BookResult) =>
  !isInLibrary(work) &&
  (IN_FLIGHT.includes(work.mediaInfo?.status as MediaStatus) ||
    IN_FLIGHT.includes(work.mediaInfo?.statusAudio as MediaStatus));

const filterTest: Record<WorksFilter, (work: BookResult) => boolean> = {
  all: () => true,
  library: isInLibrary,
  notowned: (work) => !isInLibrary(work),
  requested: isRequested,
};

const AuthorDetails = () => {
  const intl = useIntl();
  const router = useRouter();
  const settings = useSettings();
  const { hasPermission } = useUser();
  const [showCatalogModal, setShowCatalogModal] = useState(false);
  const [worksFilter, setWorksFilter] = useState<WorksFilter>('all');
  const [worksSort, setWorksSort] = useState<WorksSort>('popular');
  const { data, error } = useSWR<AuthorDetailsType>(
    `/api/v1/author/${router.query.authorId}`
  );

  const works = data?.works;
  const counts = useMemo(
    () => ({
      library: works?.filter(isInLibrary).length ?? 0,
      requested: works?.filter(isRequested).length ?? 0,
    }),
    [works]
  );
  const shownWorks = useMemo(() => {
    const filtered = (works ?? []).filter(filterTest[worksFilter]);

    if (worksSort === 'popular') {
      // The API lists works most published first
      return filtered;
    }

    // Works without a year go last either way
    const direction = worksSort === 'newest' ? -1 : 1;
    return [...filtered].sort((a, b) => {
      if (!a.firstPublishYear || !b.firstPublishYear) {
        return (b.firstPublishYear ? 1 : 0) - (a.firstPublishYear ? 1 : 0);
      }
      return direction * (a.firstPublishYear - b.firstPublishYear);
    });
  }, [works, worksFilter, worksSort]);

  if (!data && !error) {
    return <LoadingSpinner />;
  }

  if (!data) {
    return <ErrorPage statusCode={404} />;
  }

  const lifeSpan = data.birthDate
    ? data.deathDate
      ? intl.formatMessage(messages.lifespan, {
          birthDate: data.birthDate,
          deathDate: data.deathDate,
        })
      : intl.formatMessage(messages.born, { birthDate: data.birthDate })
    : undefined;

  const canRequest =
    settings.currentSettings.booksEnabled &&
    hasPermission([Permission.REQUEST, Permission.REQUEST_BOOK], {
      type: 'or',
    }) &&
    data.works.length > 0;

  const stats = [
    {
      key: 'works',
      value: data.totalWorks,
      label: intl.formatMessage(messages.statworks),
    },
    {
      key: 'library',
      value: counts.library,
      label: intl.formatMessage(messages.statinlibrary),
    },
    {
      key: 'requested',
      value: counts.requested,
      label: intl.formatMessage(messages.statrequested),
    },
  ];

  const filters: { key: WorksFilter; label: string }[] = [
    { key: 'all', label: intl.formatMessage(messages.filterall) },
    { key: 'library', label: intl.formatMessage(messages.filterinlibrary) },
    { key: 'notowned', label: intl.formatMessage(messages.filternotowned) },
    { key: 'requested', label: intl.formatMessage(messages.filterrequested) },
  ];

  const externalLinkClass = `${chip} inline-flex flex-none items-center gap-1.5 [&_svg]:h-3.5 [&_svg]:w-3.5`;

  return (
    <div className="relative -mx-4 -mt-20 pb-10 lg:-mt-28">
      <PageTitle title={data.name} />
      <BulkRequestTransition show={showCatalogModal}>
        <AuthorCatalogRequestModal
          authorId={data.olId}
          authorName={data.name}
          onCancel={() => setShowCatalogModal(false)}
          onComplete={() => setShowCatalogModal(false)}
        />
      </BulkRequestTransition>

      <TitleHero
        imageType="book"
        backdropPath={data.profilePath}
        blurBackdrop
        compact
        posterPath={data.profilePath}
        posterAlt={data.name}
        posterShape="round"
        posterFallback={<UserIcon />}
        heading={
          <>
            <ScrollingTitle
              text={data.name}
              testId="media-title"
              className="font-display text-[28px] font-bold leading-[1.1] tracking-[-0.5px] text-as-ink sm:text-4xl lg:text-5xl"
            />
            {lifeSpan && (
              <div className="text-sm text-as-ink-muted lg:text-base">
                {lifeSpan}
              </div>
            )}
          </>
        }
      >
        <dl className="grid max-w-[520px] grid-cols-3 overflow-hidden rounded-2xl border border-as-line-strong">
          {stats.map((stat, index) => (
            <div
              key={stat.key}
              className={`flex flex-col-reverse items-center py-2.5 ${
                index > 0 ? 'border-l border-as-line-strong' : ''
              }`}
            >
              <dt className="text-xs text-as-ink-muted">{stat.label}</dt>
              <dd className="font-display text-xl font-bold text-as-ink">
                {intl.formatNumber(stat.value)}
              </dd>
            </div>
          ))}
        </dl>

        <div className="flex max-w-[520px] items-center gap-2.5">
          {canRequest && (
            <Button
              className={`${pillPrimary} max-sm:flex-1`}
              onClick={() => setShowCatalogModal(true)}
            >
              <ArrowDownTrayIcon />
              <span>{intl.formatMessage(messages.requestallbooks)}</span>
            </Button>
          )}
          <WatchlistButton
            mediaType="author"
            id={data.olId}
            title={data.name}
            onUserWatchlist={data.onUserWatchlist}
            ambient
          />
        </div>

        <Biography
          short
          text={data.bio ?? intl.formatMessage(messages.biographyunavailable)}
        />

        {/* One row of links that scrolls sideways instead of wrapping */}
        <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] lg:mx-0 lg:flex-wrap lg:px-0 [&::-webkit-scrollbar]:hidden">
          <a
            href={`https://openlibrary.org/authors/${data.olId}`}
            target="_blank"
            rel="noreferrer"
            aria-label={intl.formatMessage(messages.openinopenlibrary)}
            className={externalLinkClass}
          >
            <ArrowTopRightOnSquareIcon />
            <span>{intl.formatMessage(messages.openlibrary)}</span>
          </a>
          {data.wikipedia && (
            <a
              href={data.wikipedia}
              target="_blank"
              rel="noreferrer"
              aria-label={intl.formatMessage(messages.readmore)}
              className={externalLinkClass}
            >
              <ArrowTopRightOnSquareIcon />
              <span>{intl.formatMessage(messages.wikipedia)}</span>
            </a>
          )}
          {data.links.map((link) => (
            <a
              key={`link-${link.url}`}
              href={link.url}
              target="_blank"
              rel="noreferrer"
              className={`${chip} flex-none whitespace-nowrap`}
            >
              {link.title}
            </a>
          ))}
        </div>
      </TitleHero>

      <div className="flex flex-col gap-4 px-4 pt-[30px] lg:px-10">
        <div className="flex items-baseline gap-2.5">
          <h2 className="font-display text-[22px] font-medium text-as-ink">
            {intl.formatMessage(messages.works)}
          </h2>
          {data.totalWorks > 0 && (
            <span className="text-base text-as-ink-faint">
              {intl.formatNumber(data.totalWorks)}
            </span>
          )}
          {data.works.length > 1 && (
            <select
              aria-label={intl.formatMessage(messages.sortworks)}
              value={worksSort}
              onChange={(e) => setWorksSort(e.target.value as WorksSort)}
              className="ml-auto w-auto rounded-full border-as-line-strong bg-as-raised py-1 pl-3 pr-8 text-sm text-as-ink-soft"
            >
              <option value="popular">
                {intl.formatMessage(messages.sortpopular)}
              </option>
              <option value="newest">
                {intl.formatMessage(messages.sortnewest)}
              </option>
              <option value="oldest">
                {intl.formatMessage(messages.sortoldest)}
              </option>
            </select>
          )}
        </div>

        {data.works.length > 0 && (
          <div
            role="group"
            aria-label={intl.formatMessage(messages.filterworks)}
            className="-mx-4 flex gap-2 overflow-x-auto px-4 [scrollbar-width:none] lg:mx-0 lg:px-0 [&::-webkit-scrollbar]:hidden"
          >
            {filters.map((filter) => (
              <button
                key={filter.key}
                type="button"
                aria-pressed={worksFilter === filter.key}
                onClick={() => setWorksFilter(filter.key)}
                className={`flex-none rounded-full px-3.5 py-1.5 text-[13px] transition ${
                  worksFilter === filter.key
                    ? 'bg-as-ink font-semibold text-as-ground'
                    : 'bg-as-raised text-as-ink-soft hover:text-as-ink'
                }`}
              >
                {filter.label}
              </button>
            ))}
          </div>
        )}

        {data.works.length === 0 ? (
          <p className="text-as-ink-muted">
            {intl.formatMessage(messages.noworks)}
          </p>
        ) : shownWorks.length === 0 ? (
          <p className="text-as-ink-muted">
            {intl.formatMessage(messages.nofilteredworks)}
          </p>
        ) : (
          <div className={coverGridClass}>
            {shownWorks.map((work) => (
              <BookCoverCard key={`work-${work.id}`} book={work} />
            ))}
          </div>
        )}
        {data.totalWorks > data.works.length && (
          <p className="text-sm text-as-ink-faint">
            {intl.formatMessage(messages.truncatedworks, {
              shown: data.works.length,
              total: data.totalWorks,
            })}
          </p>
        )}
      </div>
    </div>
  );
};

export default AuthorDetails;
