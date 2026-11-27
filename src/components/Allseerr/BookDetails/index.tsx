import NoBookEndsButton from '@app/components/Allseerr/BookDetails/NoBookEndsButton';
import {
  Card,
  DetailRow,
  LinkChips,
  TitleHero,
} from '@app/components/Allseerr/Title';
import Biography from '@app/components/Allseerr/Title/Biography';
import {
  BookCoverCard,
  CoverRail,
  railCoverClass,
} from '@app/components/Allseerr/Title/CoverCard';
import StatusPill from '@app/components/Allseerr/Title/StatusPill';
import {
  chip,
  pillIcon,
  pillIconWarn,
  pillPrimary,
  pillPrimaryCollapse,
  pillSecondary,
  pillSecondaryCollapse,
  softChip,
} from '@app/components/Allseerr/Title/styles';
import BlocklistButton from '@app/components/BlocklistButton';
import BookRecordings from '@app/components/BookRecordings';
import BookFormatIndicators from '@app/components/Common/BookFormatIndicators';
import Button from '@app/components/Common/Button';
import CachedImage from '@app/components/Common/CachedImage';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import NarratorLinks from '@app/components/Common/NarratorLinks';
import PageTitle from '@app/components/Common/PageTitle';
import Tooltip from '@app/components/Common/Tooltip';
import FavoriteButton from '@app/components/FavoriteButton';
import IssueModal from '@app/components/IssueModal';
import BookManageSlideOver from '@app/components/ManageSlideOver/BookManageSlideOver';
import NotifyMeButton from '@app/components/NotifyMeButton';
import RemovalRequestButton from '@app/components/RemovalRequestButton';
import RequestModal from '@app/components/RequestModal';
import WatchlistButton from '@app/components/WatchlistButton';
import useAudiobookEdition from '@app/hooks/useAudiobookEdition';
import useSettings from '@app/hooks/useSettings';
import { Permission, useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import ErrorPage from '@app/pages/_error';
import { splitRuntime } from '@app/utils/audiobookEdition';
import { isBookFormatRequestable } from '@app/utils/bookStatus';
import defineMessages from '@app/utils/defineMessages';
import { refreshIntervalHelper } from '@app/utils/refreshIntervalHelper';
import {
  ArrowDownTrayIcon,
  BookOpenIcon,
  ClockIcon,
  CogIcon,
  ExclamationTriangleIcon,
  PlayIcon,
} from '@heroicons/react/24/outline';
import { IssueStatus } from '@server/constants/issue';
import { MediaRequestStatus, MediaStatus } from '@server/constants/media';
import type {
  AuthorDetails as AuthorDetailsType,
  BookDetails as BookDetailsType,
} from '@server/models/Book';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { Fragment, useEffect, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.Allseerr.BookDetails', {
  overviewunavailable: 'Overview unavailable.',
  pagecount: '{pageCount, plural, one {# page} other {# pages}}',
  editioncount: '{editionCount, plural, one {# edition} other {# editions}}',
  author: '{authorCount, plural, one {Author} other {Authors}}',
  byauthor: 'by {authors}',
  firstpublished: 'First Published',
  pages: 'Pages',
  narrator: '{narratorCount, plural, one {Narrator} other {Narrators}}',
  audiobooklength: 'Audiobook Length',
  runtimeshort: '{hours}h {minutes}m',
  runtimeminutes: '{minutes}m',
  editions: 'Editions',
  rating: 'Rating',
  ratingvalue: '{rating} / 5 ({ratingCount, number} ratings)',
  languages: 'Languages',
  details: 'Details',
  subjects: 'Subjects',
  places: 'Places',
  people: 'People',
  times: 'Times',
  openlibraryid: 'OpenLibrary ID',
  viewrequest: 'View {format} Request',
  managebook: 'Manage Book',
  readinaudiobookshelf: 'Read in Audiobookshelf',
  listeninaudiobookshelf: 'Listen in Audiobookshelf',
  readingrimmory: 'Read in Grimmory',
  listeningrimmory: 'Listen in Grimmory',
  moreby: 'More by {author}',
  seeall: 'See all',
  requestedby: 'Requested by {user} on {date}',
  reportissue: 'Report an Issue',
});

// OpenLibrary subject pages use lower case names joined by underscores
const getSubjectSlug = (subject: string): string =>
  subject
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

interface BookDetailsProps {
  book?: BookDetailsType;
}

const BookDetails = ({ book }: BookDetailsProps) => {
  const settings = useSettings();
  const { user, hasPermission } = useUser();
  const router = useRouter();
  const intl = useIntl();
  const [showRequestModal, setShowRequestModal] = useState(false);
  const [showManager, setShowManager] = useState(false);
  const [showIssueModal, setShowIssueModal] = useState(false);

  const {
    data,
    error,
    mutate: revalidate,
  } = useSWR<BookDetailsType>(`/api/v1/book/${router.query.bookId}`, {
    fallbackData: book,
    // Polls while either format is downloading
    refreshInterval: (latest) =>
      refreshIntervalHelper(
        {
          downloadStatus: latest?.mediaInfo?.downloadStatus,
          downloadStatus4k: undefined,
          downloadStatusAudio: latest?.mediaInfo?.downloadStatusAudio,
        },
        15000
      ),
  });

  // Other works by the first author, for the rail at the bottom
  const firstAuthorId = data?.authors[0]?.id;
  const { data: authorData } = useSWR<AuthorDetailsType>(
    firstAuthorId ? `/api/v1/author/${firstAuthorId}` : null
  );
  const audiobookEdition = useAudiobookEdition(data);

  useEffect(() => {
    if (router.query.manage === '1') {
      setShowManager(true);
      router.replace({
        pathname: router.pathname,
        query: { bookId: router.query.bookId },
      });
    }
  }, [router, router.query.manage]);

  if (!data && !error) {
    return <LoadingSpinner />;
  }

  if (!data) {
    return <ErrorPage statusCode={404} />;
  }

  const canRequest =
    settings.currentSettings.booksEnabled &&
    hasPermission([Permission.REQUEST, Permission.REQUEST_BOOK], {
      type: 'or',
    });

  // A pending request the user may look at, the ebook one first
  const activeRequest = (data.mediaInfo?.requests ?? [])
    .filter(
      (request) =>
        request.status === MediaRequestStatus.PENDING &&
        // Requests for other recordings are shown with the recordings
        !request.recording &&
        (request.requestedBy.id === user?.id ||
          hasPermission(Permission.MANAGE_REQUESTS))
    )
    .sort((a, b) => Number(a.isAudiobook) - Number(b.isAudiobook))[0];
  const isRequestable =
    isBookFormatRequestable(data.mediaInfo?.status) ||
    isBookFormatRequestable(data.mediaInfo?.statusAudio);

  // Issues can be reported once either format is available
  const isAvailable =
    data.mediaInfo?.status === MediaStatus.AVAILABLE ||
    data.mediaInfo?.statusAudio === MediaStatus.AVAILABLE;
  const canReportIssue =
    isAvailable &&
    hasPermission([Permission.CREATE_ISSUES, Permission.MANAGE_ISSUES], {
      type: 'or',
    });
  const openIssues = (data.mediaInfo?.issues ?? []).filter(
    (issue) => issue.status === IssueStatus.OPEN
  );
  // The removal and issue buttons join the row once a format is available,
  // labelled pills then drop to icons on phones to keep it on one line
  const compactActions = isAvailable;

  const latestRequest = (data.mediaInfo?.requests ?? [])
    .filter((request) => request.requestedBy)
    .sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    )[0];

  const authorNames = data.authors
    .map((author) => author.name)
    .filter(Boolean)
    .join(', ');

  const authorLinks = (className: string) =>
    data.authors.map((author, index) => (
      <Fragment key={`author-${author.id}`}>
        {index > 0 && ', '}
        <Link href={`/author/${author.id}`} className={className}>
          {author.name || author.id}
        </Link>
      </Fragment>
    ));

  const subjectGroups = [
    { title: messages.subjects, items: data.subjects, link: true },
    { title: messages.places, items: data.subjectPlaces, link: false },
    { title: messages.people, items: data.subjectPeople, link: false },
    { title: messages.times, items: data.subjectTimes, link: false },
  ].filter((group) => group.items.length > 0);

  const hasStatus =
    (!!data.mediaInfo?.status &&
      data.mediaInfo.status !== MediaStatus.UNKNOWN) ||
    (!!data.mediaInfo?.statusAudio &&
      data.mediaInfo.statusAudio !== MediaStatus.UNKNOWN);

  // Read and listen links, one per format that is available
  const openLinks = [
    ...(data.audiobookshelfEbookUrl
      ? [
          {
            key: 'read',
            href: data.audiobookshelfEbookUrl,
            label: messages.readinaudiobookshelf,
            icon: <BookOpenIcon />,
          },
        ]
      : []),
    ...(data.audiobookshelfAudiobookUrl
      ? [
          {
            key: 'listen',
            href: data.audiobookshelfAudiobookUrl,
            label: messages.listeninaudiobookshelf,
            icon: <PlayIcon />,
          },
        ]
      : []),
    ...(data.grimmoryEbookUrl
      ? [
          {
            key: 'read-grimmory',
            href: data.grimmoryEbookUrl,
            label: messages.readingrimmory,
            icon: <BookOpenIcon />,
          },
        ]
      : []),
    ...(data.grimmoryAudiobookUrl
      ? [
          {
            key: 'listen-grimmory',
            href: data.grimmoryAudiobookUrl,
            label: messages.listeningrimmory,
            icon: <PlayIcon />,
          },
        ]
      : []),
  ];

  const externalLinks = [
    ...(data.audiobookshelfUrl
      ? [
          {
            key: 'audiobookshelf',
            href: data.audiobookshelfUrl,
            label: 'Audiobookshelf',
          },
        ]
      : []),
    {
      key: 'openlibrary',
      href: `https://openlibrary.org/works/${data.olId}`,
      label: 'OpenLibrary',
    },
    ...data.links
      .filter(
        (link, index, links) =>
          links.findIndex((other) => other.url === link.url) === index
      )
      .slice(0, 4)
      .map((link) => ({
        key: `link-${link.url}`,
        href: link.url,
        label: link.title,
      })),
  ];

  const moreByAuthor = (authorData?.works ?? [])
    .filter((work) => work.id !== data.olId)
    .slice(0, 20);
  const firstAuthorName =
    data.authors[0]?.name || authorData?.name || authorNames;

  return (
    <div className="relative -mx-4 -mt-20 pb-10 lg:-mt-28">
      <PageTitle title={[data.title, authorNames]} />
      <RequestModal
        type="book"
        tmdbId={0}
        olId={data.olId}
        show={showRequestModal}
        editRequest={activeRequest}
        onComplete={() => {
          revalidate();
          setShowRequestModal(false);
        }}
        onCancel={() => setShowRequestModal(false)}
      />
      <IssueModal
        onCancel={() => setShowIssueModal(false)}
        show={showIssueModal}
        mediaType="book"
        olId={data.olId}
      />
      <BookManageSlideOver
        data={data}
        onClose={() => {
          setShowManager(false);
          router.replace({
            pathname: router.pathname,
            query: { bookId: router.query.bookId },
          });
        }}
        revalidate={() => revalidate()}
        show={showManager}
      />

      <TitleHero
        imageType="book"
        backdropPath={data.posterPath}
        blurBackdrop
        posterPath={data.posterPath}
        posterAlt={data.title}
        posterShape="book"
        posterFallback={<BookOpenIcon />}
        badges={
          <>
            {hasStatus && (
              <>
                <StatusPill
                  status={data.mediaInfo?.status}
                  downloads={data.mediaInfo?.downloadStatus}
                  label={intl.formatMessage(globalMessages.ebook)}
                  href={
                    data.audiobookshelfEbookUrl ??
                    data.grimmoryEbookUrl ??
                    undefined
                  }
                />
                <StatusPill
                  status={data.mediaInfo?.statusAudio}
                  downloads={data.mediaInfo?.downloadStatusAudio}
                  label={intl.formatMessage(globalMessages.audiobook)}
                  href={
                    data.audiobookshelfAudiobookUrl ??
                    data.grimmoryAudiobookUrl ??
                    undefined
                  }
                />
              </>
            )}
            <BookFormatIndicators
              olId={data.id}
              title={data.title}
              author={data.authors.map((author) => author.name).join(', ')}
              status={data.mediaInfo?.status}
              statusAudio={data.mediaInfo?.statusAudio}
              size="inline"
            />
          </>
        }
      >
        {latestRequest && (
          <span className="flex items-center gap-2 text-[13px] text-as-ink-muted">
            <span className="relative h-6 w-6 overflow-hidden rounded-full bg-as-tile">
              <CachedImage
                type="avatar"
                src={latestRequest.requestedBy.avatar}
                alt=""
                fill
                style={{ objectFit: 'cover' }}
              />
            </span>
            {intl.formatMessage(messages.requestedby, {
              user: latestRequest.requestedBy.displayName,
              date: intl.formatDate(latestRequest.createdAt, {
                month: 'short',
                day: 'numeric',
              }),
            })}
          </span>
        )}

        <div className="flex flex-col gap-1.5">
          <h1
            className="font-display text-3xl font-bold leading-[1.05] tracking-[-1px] text-as-ink sm:text-4xl lg:text-5xl"
            data-testid="media-title"
          >
            {data.title}{' '}
            {!!data.firstPublishYear && (
              <span className="font-medium text-as-ink-faint">
                ({data.firstPublishYear})
              </span>
            )}
          </h1>
          {data.authors.length > 0 && (
            <span className="text-lg text-as-ink-muted">
              {intl.formatMessage(messages.byauthor, {
                authors: (
                  <span>
                    {authorLinks('font-semibold text-as-ink hover:underline')}
                  </span>
                ),
              })}
            </span>
          )}
        </div>

        {data.subtitle && (
          <p className="italic text-as-ink-muted">{data.subtitle}</p>
        )}

        {(!!data.pageCount ||
          !!data.editionCount ||
          data.subjects.length > 0) && (
          <div className="flex flex-wrap items-center gap-3 text-as-ink-muted">
            {!!data.pageCount && (
              <span>
                {intl.formatMessage(messages.pagecount, {
                  pageCount: data.pageCount,
                })}
              </span>
            )}
            {!!data.editionCount && (
              <span>
                {intl.formatMessage(messages.editioncount, {
                  editionCount: data.editionCount,
                })}
              </span>
            )}
            {(!!data.pageCount || !!data.editionCount) &&
              data.subjects.length > 0 && <span>·</span>}
            {data.subjects.slice(0, 4).map((subject) =>
              getSubjectSlug(subject) ? (
                <Link
                  key={`subject-chip-${subject}`}
                  href={`/discover/books/subject/${getSubjectSlug(subject)}`}
                  className={chip}
                >
                  {subject}
                </Link>
              ) : (
                <span key={`subject-chip-${subject}`} className={chip}>
                  {subject}
                </span>
              )
            )}
          </div>
        )}

        <Biography
          text={
            data.description ?? intl.formatMessage(messages.overviewunavailable)
          }
        />

        {/* A slightly tighter gap on phones keeps six icon buttons on one row */}
        <div className="flex flex-wrap items-center gap-2.5 max-sm:justify-center max-sm:gap-2">
          {openLinks.map((link, index) => (
            <a
              key={link.key}
              href={link.href}
              target="_blank"
              rel="noreferrer"
              className={`inline-flex items-center border transition [&_svg]:h-4 [&_svg]:w-4 ${
                index === 0
                  ? compactActions
                    ? pillPrimaryCollapse
                    : pillPrimary
                  : compactActions
                    ? pillSecondaryCollapse
                    : pillSecondary
              }`}
              aria-label={intl.formatMessage(link.label)}
            >
              {link.icon}
              <span className={compactActions ? 'max-sm:sr-only' : ''}>
                {intl.formatMessage(link.label)}
              </span>
            </a>
          ))}
          <NoBookEndsButton book={data} compact={compactActions} />
          {canRequest && isRequestable && (
            <Button
              className={
                openLinks.length > 0
                  ? compactActions
                    ? pillSecondaryCollapse
                    : pillSecondary
                  : compactActions
                    ? pillPrimaryCollapse
                    : pillPrimary
              }
              onClick={() => setShowRequestModal(true)}
              aria-label={intl.formatMessage(globalMessages.request)}
            >
              <ArrowDownTrayIcon />
              <span className={compactActions ? 'max-sm:sr-only' : ''}>
                {intl.formatMessage(globalMessages.request)}
              </span>
            </Button>
          )}
          {activeRequest && (
            <Button
              className={compactActions ? pillSecondaryCollapse : pillSecondary}
              onClick={() => setShowRequestModal(true)}
            >
              <ClockIcon />
              <span className={compactActions ? 'max-sm:sr-only' : ''}>
                {intl.formatMessage(messages.viewrequest, {
                  format: intl.formatMessage(
                    activeRequest.isAudiobook
                      ? globalMessages.audiobook
                      : globalMessages.ebook
                  ),
                })}
              </span>
            </Button>
          )}
          {data.mediaInfo?.status !== MediaStatus.BLOCKLISTED && (
            <WatchlistButton
              mediaType="book"
              id={data.olId}
              title={data.title}
              onUserWatchlist={data.onUserWatchlist}
              ambient
            />
          )}
          <FavoriteButton
            mediaType="book"
            id={data.olId}
            title={data.title}
            className={pillIcon}
          />
          <BlocklistButton
            mediaType="book"
            id={data.olId}
            title={data.title}
            media={data.mediaInfo}
            onUpdate={() => revalidate()}
            ambient
          />
          <NotifyMeButton
            media={data.mediaInfo}
            title={data.title}
            className={pillSecondaryCollapse}
            ambient
          />
          <RemovalRequestButton
            media={data.mediaInfo}
            title={data.title}
            className={pillIcon}
          />
          {canReportIssue && (
            <Tooltip content={intl.formatMessage(messages.reportissue)}>
              <Button
                className={pillIconWarn}
                onClick={() => setShowIssueModal(true)}
                aria-label={intl.formatMessage(messages.reportissue)}
              >
                <ExclamationTriangleIcon />
              </Button>
            </Tooltip>
          )}
          {hasPermission(Permission.MANAGE_REQUESTS) &&
            data.mediaInfo &&
            (data.mediaInfo.status !== MediaStatus.UNKNOWN ||
              data.mediaInfo.statusAudio !== MediaStatus.UNKNOWN) && (
              <Tooltip content={intl.formatMessage(messages.managebook)}>
                <Button
                  className={`relative ${pillIcon}`}
                  onClick={() => setShowManager(true)}
                  aria-label={intl.formatMessage(messages.managebook)}
                >
                  <CogIcon />
                  {hasPermission(
                    [Permission.MANAGE_ISSUES, Permission.VIEW_ISSUES],
                    { type: 'or' }
                  ) &&
                    openIssues.length > 0 && (
                      <>
                        <span className="absolute -right-0.5 -top-0.5 h-3 w-3 rounded-full bg-red-600" />
                        <span className="absolute -right-0.5 -top-0.5 h-3 w-3 animate-ping rounded-full bg-red-600" />
                      </>
                    )}
                </Button>
              </Tooltip>
            )}
        </div>
      </TitleHero>

      <div className="px-4 lg:px-10">
        <section className="grid items-start gap-6 pt-7 lg:grid-cols-[minmax(0,1fr)_340px]">
          <div className="flex min-w-0 flex-col gap-6">
            <BookRecordings
              olId={data.olId}
              title={data.title}
              statusAudio={data.mediaInfo?.statusAudio}
              ambient
              onRequested={() => revalidate()}
            />
            {subjectGroups.length > 0 && (
              <Card title={intl.formatMessage(messages.subjects)}>
                {subjectGroups.map((group) => (
                  <div
                    key={`subjects-${group.title.id}`}
                    className="flex flex-col gap-2"
                  >
                    {(subjectGroups.length > 1 ||
                      group.title !== messages.subjects) && (
                      <h3 className="text-xs font-bold uppercase tracking-wider text-as-ink-faint">
                        {intl.formatMessage(group.title)}
                      </h3>
                    )}
                    <div className="flex flex-wrap gap-2">
                      {group.items.map((subject) =>
                        group.link && getSubjectSlug(subject) ? (
                          <Link
                            key={`subject-${group.title.id}-${subject}`}
                            href={`/discover/books/subject/${getSubjectSlug(
                              subject
                            )}`}
                            className={softChip}
                          >
                            {subject}
                          </Link>
                        ) : (
                          <span
                            key={`subject-${group.title.id}-${subject}`}
                            className="rounded-full border border-as-line bg-as-tile px-3 py-[7px] text-[13px] text-as-ink-soft"
                          >
                            {subject}
                          </span>
                        )
                      )}
                    </div>
                  </div>
                ))}
              </Card>
            )}
          </div>

          <div className="flex min-w-0 flex-col gap-6">
            <Card title={intl.formatMessage(messages.details)}>
              <div>
                {data.authors.length > 0 && (
                  <DetailRow
                    label={intl.formatMessage(messages.author, {
                      authorCount: data.authors.length,
                    })}
                  >
                    <span>
                      {authorLinks('hover:text-as-ink hover:underline')}
                    </span>
                  </DetailRow>
                )}
                {!!data.firstPublishYear && (
                  <DetailRow
                    label={intl.formatMessage(messages.firstpublished)}
                  >
                    {data.firstPublishYear}
                  </DetailRow>
                )}
                {!!data.pageCount && (
                  <DetailRow label={intl.formatMessage(messages.pages)}>
                    {intl.formatNumber(data.pageCount)}
                  </DetailRow>
                )}
                {!!audiobookEdition?.narrators.length && (
                  <DetailRow
                    label={intl.formatMessage(messages.narrator, {
                      narratorCount: audiobookEdition.narrators.length,
                    })}
                  >
                    <NarratorLinks
                      narrators={audiobookEdition.narrators}
                      className="hover:text-as-ink hover:underline"
                    />
                  </DetailRow>
                )}
                {!!audiobookEdition?.runtimeMinutes && (
                  <DetailRow
                    label={intl.formatMessage(messages.audiobooklength)}
                  >
                    {intl.formatMessage(
                      audiobookEdition.runtimeMinutes >= 60
                        ? messages.runtimeshort
                        : messages.runtimeminutes,
                      splitRuntime(audiobookEdition.runtimeMinutes)
                    )}
                  </DetailRow>
                )}
                {!!data.editionCount && (
                  <DetailRow label={intl.formatMessage(messages.editions)}>
                    {intl.formatNumber(data.editionCount)}
                  </DetailRow>
                )}
                {!!data.ratingsAverage && !!data.ratingsCount && (
                  <DetailRow label={intl.formatMessage(messages.rating)}>
                    {intl.formatMessage(messages.ratingvalue, {
                      rating: data.ratingsAverage.toFixed(1),
                      ratingCount: data.ratingsCount,
                    })}
                  </DetailRow>
                )}
                {data.languages.length > 0 && (
                  <DetailRow label={intl.formatMessage(messages.languages)}>
                    {data.languages.slice(0, 5).join(', ').toUpperCase()}
                  </DetailRow>
                )}
                <DetailRow label={intl.formatMessage(messages.openlibraryid)}>
                  <a
                    href={`https://openlibrary.org/works/${data.olId}`}
                    target="_blank"
                    rel="noreferrer"
                    className="font-mono text-xs hover:text-as-ink hover:underline"
                  >
                    {data.olId}
                  </a>
                </DetailRow>
              </div>
              <LinkChips links={externalLinks} />
            </Card>
          </div>
        </section>

        {moreByAuthor.length > 0 && (
          <CoverRail
            title={intl.formatMessage(messages.moreby, {
              author: firstAuthorName,
            })}
            href={firstAuthorId ? `/author/${firstAuthorId}` : undefined}
            seeAllLabel={intl.formatMessage(messages.seeall)}
          >
            {moreByAuthor.map((work) => (
              <BookCoverCard
                key={`more-${work.id}`}
                book={work}
                className={railCoverClass}
              />
            ))}
          </CoverRail>
        )}
      </div>
    </div>
  );
};

export default BookDetails;
