import { TitleHero } from '@app/components/Allseerr/Title';
import {
  BookCoverCard,
  CoverCard,
  coverGridClass,
} from '@app/components/Allseerr/Title/CoverCard';
import ScrollingTitle from '@app/components/Allseerr/Title/ScrollingTitle';
import { chip } from '@app/components/Allseerr/Title/styles';
import HeadphonesIcon from '@app/components/Common/HeadphonesIcon';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import ErrorPage from '@app/pages/_error';
import defineMessages from '@app/utils/defineMessages';
import { ArrowTopRightOnSquareIcon } from '@heroicons/react/24/outline';
import { BookOpenIcon } from '@heroicons/react/24/solid';
import { MediaStatus } from '@server/constants/media';
import type {
  NarratorBook,
  NarratorDetails as NarratorDetailsType,
} from '@server/lib/narrators';
import type { BookResult } from '@server/models/Search';
import { useRouter } from 'next/router';
import { useMemo, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.Allseerr.NarratorDetails', {
  narrator: 'Narrator',
  books: 'Audiobooks',
  nobooks: 'No audiobooks are listed for this narrator.',
  nofilteredbooks: 'None of the audiobooks shown here match this filter.',
  truncated: 'Showing their {shown} latest recordings.',
  matching: 'Looking up {count, plural, one {# book} other {# books}}...',
  statbooks: 'Audiobooks',
  statauthors: 'Authors',
  statinlibrary: 'In library',
  filterall: 'All',
  filterinlibrary: 'In library',
  filternotowned: 'Not owned',
  filterrequested: 'Requested',
  filterbooks: 'Show audiobooks',
  seriesplace: 'Book {position}',
  otherbooks: 'Other books',
  unknownauthor: 'Unknown author',
  audible: 'Audible',
  openinaudible: 'Open in Audible',
});

type BooksFilter = 'all' | 'library' | 'notowned' | 'requested';

const OWNED = [MediaStatus.AVAILABLE, MediaStatus.PARTIALLY_AVAILABLE];
const IN_FLIGHT = [MediaStatus.PENDING, MediaStatus.PROCESSING];

// The audiobook is what a narrator page is about
const isInLibrary = (book: NarratorBook) =>
  OWNED.includes(book.mediaInfo?.statusAudio as MediaStatus);

const isRequested = (book: NarratorBook) =>
  !isInLibrary(book) &&
  IN_FLIGHT.includes(book.mediaInfo?.statusAudio as MediaStatus);

const filterTest: Record<BooksFilter, (book: NarratorBook) => boolean> = {
  all: () => true,
  library: isInLibrary,
  notowned: (book) => !isInLibrary(book),
  requested: isRequested,
};

// Asks again while books are still being matched, a few times at most
const MAX_REFRESHES = 10;
const REFRESH_INTERVAL_MS = 4000;

const toBookResult = (book: NarratorBook, olId: string): BookResult => ({
  id: olId,
  mediaType: 'book',
  title: book.title,
  authorName: book.authors.join(', ') || undefined,
  firstPublishYear: book.releaseDate
    ? Number(book.releaseDate.slice(0, 4)) || undefined
    : undefined,
  posterPath: book.coverUrl,
  mediaInfo: book.mediaInfo,
});

const NarratorBookCard = ({
  book,
  subtitle,
}: {
  book: NarratorBook;
  subtitle?: string;
}) => {
  // Books not matched to an OpenLibrary work open a book search instead
  if (!book.olId) {
    return (
      <CoverCard
        href={`/search?type=book&query=${encodeURIComponent(
          [book.title, book.authors[0]].filter(Boolean).join(' ')
        )}`}
        shape="book"
        title={book.title}
        subtitle={subtitle}
        image={book.coverUrl}
        imageType="book"
        fallbackIcon={<BookOpenIcon />}
      />
    );
  }

  return (
    <BookCoverCard book={toBookResult(book, book.olId)} subtitle={subtitle} />
  );
};

/**
 * A narrator's audiobooks, grouped by author, then series in series order,
 * then the author's other books, with the request status of each
 */
const NarratorDetails = () => {
  const intl = useIntl();
  const router = useRouter();
  const name = typeof router.query.name === 'string' ? router.query.name : '';
  const [booksFilter, setBooksFilter] = useState<BooksFilter>('all');
  const [refreshes, setRefreshes] = useState(0);
  const { data, error } = useSWR<NarratorDetailsType>(
    name ? `/api/v1/narrator?name=${encodeURIComponent(name)}` : null,
    {
      refreshInterval: (latest) =>
        latest?.pending && refreshes < MAX_REFRESHES ? REFRESH_INTERVAL_MS : 0,
      onSuccess: (latest) => {
        if (latest.pending) {
          setRefreshes((count) => count + 1);
        }
      },
    }
  );

  const books = useMemo(
    () =>
      data?.authors.flatMap((author) => [
        ...author.series.flatMap((series) => series.books),
        ...author.standalone,
      ]) ?? [],
    [data]
  );
  const inLibrary = books.filter(isInLibrary).length;

  const shownAuthors = useMemo(
    () =>
      (data?.authors ?? [])
        .map((author) => ({
          ...author,
          series: author.series
            .map((series) => ({
              ...series,
              books: series.books.filter(filterTest[booksFilter]),
            }))
            .filter((series) => series.books.length > 0),
          standalone: author.standalone.filter(filterTest[booksFilter]),
        }))
        .filter(
          (author) => author.series.length > 0 || author.standalone.length > 0
        ),
    [data, booksFilter]
  );

  if (!data && !error) {
    return <LoadingSpinner />;
  }

  if (!data) {
    return <ErrorPage statusCode={404} />;
  }

  const stats = [
    {
      key: 'books',
      value: data.totalBooks,
      label: intl.formatMessage(messages.statbooks),
    },
    {
      key: 'authors',
      value: data.authors.length,
      label: intl.formatMessage(messages.statauthors),
    },
    {
      key: 'library',
      value: inLibrary,
      label: intl.formatMessage(messages.statinlibrary),
    },
  ];

  const filters: { key: BooksFilter; label: string }[] = [
    { key: 'all', label: intl.formatMessage(messages.filterall) },
    { key: 'library', label: intl.formatMessage(messages.filterinlibrary) },
    { key: 'notowned', label: intl.formatMessage(messages.filternotowned) },
    { key: 'requested', label: intl.formatMessage(messages.filterrequested) },
  ];

  const releaseYear = (book: NarratorBook) => book.releaseDate?.slice(0, 4);

  return (
    <div className="relative -mx-4 -mt-20 pb-10 lg:-mt-28">
      <PageTitle title={data.name} />
      <TitleHero
        imageType="book"
        backdropPath={books[0]?.coverUrl}
        blurBackdrop
        compact
        posterAlt={data.name}
        posterShape="round"
        posterFallback={<HeadphonesIcon />}
        heading={
          <>
            <ScrollingTitle
              text={data.name}
              testId="media-title"
              className="font-display text-[28px] font-bold leading-[1.1] tracking-[-0.5px] text-as-ink sm:text-4xl lg:text-5xl"
            />
            <div className="text-sm text-as-ink-muted lg:text-base">
              {intl.formatMessage(messages.narrator)}
            </div>
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

        <div className="flex gap-2">
          <a
            href={`https://www.audible.com/search?searchNarrator=${encodeURIComponent(
              data.name
            )}`}
            target="_blank"
            rel="noreferrer"
            aria-label={intl.formatMessage(messages.openinaudible)}
            className={`${chip} inline-flex flex-none items-center gap-1.5 [&_svg]:h-3.5 [&_svg]:w-3.5`}
          >
            <ArrowTopRightOnSquareIcon />
            <span>{intl.formatMessage(messages.audible)}</span>
          </a>
        </div>
      </TitleHero>

      <div className="flex flex-col gap-4 px-4 pt-[30px] lg:px-10">
        <div className="flex items-baseline gap-2.5">
          <h2 className="font-display text-[22px] font-medium text-as-ink">
            {intl.formatMessage(messages.books)}
          </h2>
          {data.totalBooks > 0 && (
            <span className="text-base text-as-ink-faint">
              {intl.formatNumber(data.totalBooks)}
            </span>
          )}
          {data.pending > 0 && refreshes < MAX_REFRESHES && (
            <span className="ml-auto text-sm text-as-ink-faint">
              {intl.formatMessage(messages.matching, { count: data.pending })}
            </span>
          )}
        </div>

        {books.length > 0 && (
          <div
            role="group"
            aria-label={intl.formatMessage(messages.filterbooks)}
            className="-mx-4 flex gap-2 overflow-x-auto px-4 [scrollbar-width:none] lg:mx-0 lg:px-0 [&::-webkit-scrollbar]:hidden"
          >
            {filters.map((filter) => (
              <button
                key={filter.key}
                type="button"
                aria-pressed={booksFilter === filter.key}
                onClick={() => setBooksFilter(filter.key)}
                className={`flex-none rounded-full px-3.5 py-1.5 text-[13px] transition ${
                  booksFilter === filter.key
                    ? 'bg-as-ink font-semibold text-as-ground'
                    : 'bg-as-raised text-as-ink-soft hover:text-as-ink'
                }`}
              >
                {filter.label}
              </button>
            ))}
          </div>
        )}

        {books.length === 0 ? (
          <p className="text-as-ink-muted">
            {intl.formatMessage(messages.nobooks)}
          </p>
        ) : shownAuthors.length === 0 ? (
          <p className="text-as-ink-muted">
            {intl.formatMessage(messages.nofilteredbooks)}
          </p>
        ) : (
          shownAuthors.map((author) => (
            <section
              key={`author-${author.name}`}
              className="flex flex-col gap-4 pt-4"
              data-testid="narrator-author"
            >
              <h3 className="font-display text-xl font-semibold text-as-ink">
                {author.name || intl.formatMessage(messages.unknownauthor)}
              </h3>
              {author.series.map((series) => (
                <div
                  key={`series-${author.name}-${series.name}`}
                  className="flex flex-col gap-3"
                >
                  <h4 className="text-[15px] font-semibold text-as-ink-soft">
                    {series.name}
                  </h4>
                  <div className={coverGridClass}>
                    {series.books.map((book) => (
                      <NarratorBookCard
                        key={`book-${book.asin}`}
                        book={book}
                        subtitle={
                          book.series?.position
                            ? intl.formatMessage(messages.seriesplace, {
                                position: book.series.position,
                              })
                            : releaseYear(book)
                        }
                      />
                    ))}
                  </div>
                </div>
              ))}
              {author.standalone.length > 0 && (
                <div className="flex flex-col gap-3">
                  {author.series.length > 0 && (
                    <h4 className="text-[15px] font-semibold text-as-ink-soft">
                      {intl.formatMessage(messages.otherbooks)}
                    </h4>
                  )}
                  <div className={coverGridClass}>
                    {author.standalone.map((book) => (
                      <NarratorBookCard
                        key={`book-${book.asin}`}
                        book={book}
                        subtitle={releaseYear(book)}
                      />
                    ))}
                  </div>
                </div>
              )}
            </section>
          ))
        )}
        {data.truncated && (
          <p className="text-sm text-as-ink-faint">
            {intl.formatMessage(messages.truncated, {
              shown: data.totalBooks,
            })}
          </p>
        )}
      </div>
    </div>
  );
};

export default NarratorDetails;
