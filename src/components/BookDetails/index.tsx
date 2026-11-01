import BlocklistButton from '@app/components/BlocklistButton';
import BookRecordings from '@app/components/BookRecordings';
import BookFormatIndicators from '@app/components/Common/BookFormatIndicators';
import Button from '@app/components/Common/Button';
import CachedImage from '@app/components/Common/CachedImage';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import type { PlayButtonLink } from '@app/components/Common/PlayButton';
import PlayButton from '@app/components/Common/PlayButton';
import PosterLightbox from '@app/components/Common/PosterLightbox';
import Tag from '@app/components/Common/Tag';
import Tooltip from '@app/components/Common/Tooltip';
import FavoriteButton from '@app/components/FavoriteButton';
import IssueModal from '@app/components/IssueModal';
import BookManageSlideOver from '@app/components/ManageSlideOver/BookManageSlideOver';
import RemovalRequestButton from '@app/components/RemovalRequestButton';
import RequestModal from '@app/components/RequestModal';
import StatusBadge from '@app/components/StatusBadge';
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
  BookOpenIcon,
  CogIcon,
  ExclamationTriangleIcon,
} from '@heroicons/react/24/outline';
import { ArrowDownTrayIcon, PlayIcon } from '@heroicons/react/24/solid';
import { IssueStatus } from '@server/constants/issue';
import { MediaRequestStatus, MediaStatus } from '@server/constants/media';
import type { BookDetails as BookDetailsType } from '@server/models/Book';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { Fragment, useEffect, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.BookDetails', {
  overview: 'Overview',
  overviewunavailable: 'Overview unavailable.',
  pagecount: '{pageCount, plural, one {# Page} other {# Pages}}',
  editioncount: '{editionCount, plural, one {# Edition} other {# Editions}}',
  author: '{authorCount, plural, one {Author} other {Authors}}',
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
  subjects: 'Subjects',
  places: 'Places',
  people: 'People',
  times: 'Times',
  viewrequest: 'View {format} Request',
  managebook: 'Manage Book',
  readinaudiobookshelf: 'Read in Audiobookshelf',
  listeninaudiobookshelf: 'Listen in Audiobookshelf',
  openinnobookends: 'Open in NoBookEnds',
  readinnobookends: 'Read in NoBookEnds',
  listeninnobookends: 'Listen in NoBookEnds',
  openinopenlibrary: 'Open in OpenLibrary',
  reportissue: 'Report an Issue',
});

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

  const mediaLinks: PlayButtonLink[] = [];

  if (data.audiobookshelfEbookUrl) {
    mediaLinks.push({
      text: intl.formatMessage(messages.readinaudiobookshelf),
      url: data.audiobookshelfEbookUrl,
      svg: <BookOpenIcon />,
    });
  }

  if (data.audiobookshelfAudiobookUrl) {
    mediaLinks.push({
      text: intl.formatMessage(messages.listeninaudiobookshelf),
      url: data.audiobookshelfAudiobookUrl,
      svg: <PlayIcon />,
    });
  }

  // Opens the format's Audiobookshelf item in the NoBookEnds app
  const bothInNoBookEnds =
    !!data.nobookendsEbookUrl && !!data.nobookendsAudiobookUrl;
  const noBookEndsIcon = (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src="/nobookends-icon.png"
      alt=""
      className="mr-2 h-5 w-5 shrink-0 rounded-[4px]"
    />
  );

  if (data.nobookendsEbookUrl) {
    mediaLinks.push({
      text: intl.formatMessage(
        bothInNoBookEnds ? messages.readinnobookends : messages.openinnobookends
      ),
      url: data.nobookendsEbookUrl,
      svg: noBookEndsIcon,
    });
  }

  if (data.nobookendsAudiobookUrl) {
    mediaLinks.push({
      text: intl.formatMessage(
        bothInNoBookEnds
          ? messages.listeninnobookends
          : messages.openinnobookends
      ),
      url: data.nobookendsAudiobookUrl,
      svg: noBookEndsIcon,
    });
  }

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
  const canReportIssue =
    (data.mediaInfo?.status === MediaStatus.AVAILABLE ||
      data.mediaInfo?.statusAudio === MediaStatus.AVAILABLE) &&
    hasPermission([Permission.CREATE_ISSUES, Permission.MANAGE_ISSUES], {
      type: 'or',
    });
  const openIssues = (data.mediaInfo?.issues ?? []).filter(
    (issue) => issue.status === IssueStatus.OPEN
  );

  const authorNames = data.authors
    .map((author) => author.name)
    .filter(Boolean)
    .join(', ');

  const bookAttributes: string[] = [];
  if (data.pageCount) {
    bookAttributes.push(
      intl.formatMessage(messages.pagecount, { pageCount: data.pageCount })
    );
  }
  if (data.editionCount) {
    bookAttributes.push(
      intl.formatMessage(messages.editioncount, {
        editionCount: data.editionCount,
      })
    );
  }

  const subjectGroups = [
    { title: messages.subjects, items: data.subjects },
    { title: messages.places, items: data.subjectPlaces },
    { title: messages.people, items: data.subjectPeople },
    { title: messages.times, items: data.subjectTimes },
  ].filter((group) => group.items.length > 0);

  const authorLinks = data.authors.map((author, index) => (
    <Fragment key={`author-${author.id}`}>
      {index > 0 && ', '}
      <Link href={`/author/${author.id}`} className="hover:underline">
        {author.name || author.id}
      </Link>
    </Fragment>
  ));

  return (
    <div className="media-page" style={{ height: 493 }}>
      {data.posterPath && (
        <div className="media-page-bg-image">
          <CachedImage
            type="book"
            alt=""
            src={data.posterPath}
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              filter: 'blur(16px)',
              transform: 'scale(1.1)',
            }}
            fill
            priority
          />
          <div
            className="absolute inset-0"
            style={{
              backgroundImage:
                'linear-gradient(180deg, rgb(var(--tw-gray-900, 17 24 39) / 0.6) 0%, rgb(var(--tw-gray-900, 17 24 39) / 1) 100%)',
            }}
          />
        </div>
      )}
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
      <div className="media-header">
        <div className="media-poster bg-gray-800">
          {data.posterPath ? (
            <PosterLightbox type="book" src={data.posterPath}>
              <CachedImage
                type="book"
                src={data.posterPath}
                alt=""
                sizes="100vw"
                style={{ width: '100%', height: 'auto' }}
                width={600}
                height={900}
                priority
              />
            </PosterLightbox>
          ) : (
            <div className="flex aspect-[2/3] h-full w-full items-center justify-center text-gray-600">
              <BookOpenIcon className="h-1/2 w-1/2" />
            </div>
          )}
        </div>
        <div className="media-title">
          <div className="media-status">
            <StatusBadge
              status={data.mediaInfo?.status}
              downloadItem={data.mediaInfo?.downloadStatus}
              inProgress={(data.mediaInfo?.downloadStatus ?? []).length > 0}
              title={data.title}
              olId={data.mediaInfo?.olId}
              bookFormat="ebook"
              mediaType="book"
              serviceUrl={data.mediaInfo?.serviceUrl}
            />
            <StatusBadge
              status={data.mediaInfo?.statusAudio}
              downloadItem={data.mediaInfo?.downloadStatusAudio}
              inProgress={
                (data.mediaInfo?.downloadStatusAudio ?? []).length > 0
              }
              title={data.title}
              olId={data.mediaInfo?.olId}
              bookFormat="audiobook"
              mediaType="book"
              serviceUrl={data.mediaInfo?.serviceUrl}
            />
            <BookFormatIndicators
              olId={data.id}
              title={data.title}
              author={data.authors.map((author) => author.name).join(', ')}
              status={data.mediaInfo?.status}
              statusAudio={data.mediaInfo?.statusAudio}
              size="inline"
              className="align-middle"
            />
          </div>
          <h1 data-testid="media-title">
            {data.title}{' '}
            {!!data.firstPublishYear && (
              <span className="media-year">({data.firstPublishYear})</span>
            )}
          </h1>
          <span className="media-attributes">
            {authorLinks.length > 0 && <span>{authorLinks}</span>}
            {bookAttributes.map((attribute, index) => (
              <Fragment key={`attribute-${index}`}>
                <span>|</span>
                <span>{attribute}</span>
              </Fragment>
            ))}
          </span>
        </div>
        <div className="media-actions">
          <div className="z-20">
            <PlayButton links={mediaLinks} />
          </div>
          {canRequest && isRequestable && (
            <Button
              buttonType="primary"
              onClick={() => setShowRequestModal(true)}
              className="ml-2 first:ml-0"
            >
              <ArrowDownTrayIcon />
              <span>{intl.formatMessage(globalMessages.request)}</span>
            </Button>
          )}
          {activeRequest && (
            <Button
              buttonType="warning"
              onClick={() => setShowRequestModal(true)}
              className="ml-2 first:ml-0"
            >
              <span>
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
            />
          )}
          <FavoriteButton
            mediaType="book"
            id={data.olId}
            title={data.title}
            className="ml-2 first:ml-0"
          />
          <BlocklistButton
            mediaType="book"
            id={data.olId}
            title={data.title}
            media={data.mediaInfo}
            onUpdate={() => revalidate()}
          />
          <RemovalRequestButton
            media={data.mediaInfo}
            title={data.title}
            className="ml-2 first:ml-0"
          />
          {canReportIssue && (
            <Tooltip content={intl.formatMessage(messages.reportissue)}>
              <Button
                buttonType="warning"
                onClick={() => setShowIssueModal(true)}
                className="ml-2 first:ml-0"
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
                  buttonType="ghost"
                  onClick={() => setShowManager(true)}
                  className="relative ml-2 first:ml-0"
                >
                  <CogIcon className="!mr-0" />
                  {hasPermission(
                    [Permission.MANAGE_ISSUES, Permission.VIEW_ISSUES],
                    { type: 'or' }
                  ) &&
                    openIssues.length > 0 && (
                      <>
                        <div className="absolute -right-1 -top-1 h-3 w-3 rounded-full bg-red-600" />
                        <div className="absolute -right-1 -top-1 h-3 w-3 animate-ping rounded-full bg-red-600" />
                      </>
                    )}
                </Button>
              </Tooltip>
            )}
        </div>
      </div>
      <div className="media-overview">
        <div className="media-overview-left">
          <h2>{intl.formatMessage(messages.overview)}</h2>
          <p className="whitespace-pre-line">
            {data.description ??
              intl.formatMessage(messages.overviewunavailable)}
          </p>
          {subjectGroups.map((group) => (
            <div key={`subjects-${group.title.id}`} className="mt-6">
              <h3 className="mb-2 text-sm font-bold uppercase tracking-wider text-gray-400">
                {intl.formatMessage(group.title)}
              </h3>
              {group.items.map((subject) => (
                <span
                  key={`subject-${subject}`}
                  className="mb-2 mr-2 inline-flex"
                >
                  <Tag>{subject}</Tag>
                </span>
              ))}
            </div>
          ))}
          <BookRecordings
            olId={data.olId}
            title={data.title}
            statusAudio={data.mediaInfo?.statusAudio}
            onRequested={() => revalidate()}
          />
        </div>
        <div className="media-overview-right">
          <div className="media-facts">
            {data.authors.length > 0 && (
              <div className="media-fact">
                <span>
                  {intl.formatMessage(messages.author, {
                    authorCount: data.authors.length,
                  })}
                </span>
                <span className="media-fact-value">{authorLinks}</span>
              </div>
            )}
            {!!data.firstPublishYear && (
              <div className="media-fact">
                <span>{intl.formatMessage(messages.firstpublished)}</span>
                <span className="media-fact-value">
                  {data.firstPublishYear}
                </span>
              </div>
            )}
            {!!data.pageCount && (
              <div className="media-fact">
                <span>{intl.formatMessage(messages.pages)}</span>
                <span className="media-fact-value">
                  {intl.formatNumber(data.pageCount)}
                </span>
              </div>
            )}
            {!!audiobookEdition?.narrators.length && (
              <div className="media-fact">
                <span>
                  {intl.formatMessage(messages.narrator, {
                    narratorCount: audiobookEdition.narrators.length,
                  })}
                </span>
                <span className="media-fact-value">
                  {audiobookEdition.narrators.join(', ')}
                </span>
              </div>
            )}
            {!!audiobookEdition?.runtimeMinutes && (
              <div className="media-fact">
                <span>{intl.formatMessage(messages.audiobooklength)}</span>
                <span className="media-fact-value">
                  {intl.formatMessage(
                    audiobookEdition.runtimeMinutes >= 60
                      ? messages.runtimeshort
                      : messages.runtimeminutes,
                    splitRuntime(audiobookEdition.runtimeMinutes)
                  )}
                </span>
              </div>
            )}
            {!!data.editionCount && (
              <div className="media-fact">
                <span>{intl.formatMessage(messages.editions)}</span>
                <span className="media-fact-value">
                  {intl.formatNumber(data.editionCount)}
                </span>
              </div>
            )}
            {!!data.ratingsAverage && !!data.ratingsCount && (
              <div className="media-fact">
                <span>{intl.formatMessage(messages.rating)}</span>
                <span className="media-fact-value">
                  {intl.formatMessage(messages.ratingvalue, {
                    rating: data.ratingsAverage.toFixed(1),
                    ratingCount: data.ratingsCount,
                  })}
                </span>
              </div>
            )}
            {data.languages.length > 0 && (
              <div className="media-fact">
                <span>{intl.formatMessage(messages.languages)}</span>
                <span className="media-fact-value">
                  {data.languages.slice(0, 5).join(', ').toUpperCase()}
                </span>
              </div>
            )}
            <div className="media-fact">
              <a
                href={`https://openlibrary.org/works/${data.olId}`}
                target="_blank"
                rel="noreferrer"
                className="hover:text-gray-100"
              >
                {intl.formatMessage(messages.openinopenlibrary)}
              </a>
            </div>
          </div>
        </div>
      </div>
      <div className="extra-bottom-space relative" />
    </div>
  );
};

export default BookDetails;
