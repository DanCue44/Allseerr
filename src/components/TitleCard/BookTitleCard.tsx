import Spinner from '@app/assets/spinner.svg';
import BookFormatIndicators from '@app/components/Common/BookFormatIndicators';
import Button from '@app/components/Common/Button';
import CachedImage from '@app/components/Common/CachedImage';
import FormatIcon from '@app/components/Common/FormatIcon';
import RequestModal from '@app/components/RequestModal';
import useInterfaceStyle from '@app/hooks/useInterfaceStyle';
import { useIsTouch } from '@app/hooks/useIsTouch';
import useSettings from '@app/hooks/useSettings';
import { Permission, useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import { isBookFormatRequestable } from '@app/utils/bookStatus';
import { Transition } from '@headlessui/react';
import { ArrowDownTrayIcon } from '@heroicons/react/24/outline';
import { BookOpenIcon, UserIcon } from '@heroicons/react/24/solid';
import type { MediaStatus } from '@server/constants/media';
import Link from 'next/link';
import { Fragment, useCallback, useEffect, useState } from 'react';
import { useIntl } from 'react-intl';

interface BookTitleCardProps {
  id: string;
  mediaType: 'book' | 'author' | 'narrator';
  title: string;
  // The authors, for book cards
  subtitle?: string;
  year?: number | string;
  image?: string | null;
  status?: MediaStatus;
  statusAudio?: MediaStatus;
  canExpand?: boolean;
}

/**
 * Portrait card for books, authors and narrators, the book counterpart of
 * TitleCard
 */
const BookTitleCard = ({
  id,
  mediaType,
  title,
  subtitle,
  year,
  image,
  status,
  statusAudio,
  canExpand = false,
}: BookTitleCardProps) => {
  const isTouch = useIsTouch();
  const [interfaceStyle] = useInterfaceStyle();
  const ambient = interfaceStyle === 'ambient';
  const intl = useIntl();
  const settings = useSettings();
  const { hasPermission } = useUser();
  const [isUpdating, setIsUpdating] = useState(false);
  const [currentStatus, setCurrentStatus] = useState(status);
  const [currentStatusAudio, setCurrentStatusAudio] = useState(statusAudio);
  const [showDetail, setShowDetail] = useState(false);
  const [showRequestModal, setShowRequestModal] = useState(false);
  // Authors and narrators are people, shown round and without a request
  const isAuthor = mediaType === 'author' || mediaType === 'narrator';
  const href =
    mediaType === 'narrator'
      ? `/narrator/${encodeURIComponent(id)}`
      : mediaType === 'author'
        ? `/author/${id}`
        : `/book/${id}`;
  const kindLabel =
    mediaType === 'narrator'
      ? globalMessages.narrator
      : isAuthor
        ? globalMessages.author
        : globalMessages.book;

  useEffect(() => {
    setCurrentStatus(status);
    setCurrentStatusAudio(statusAudio);
  }, [status, statusAudio]);

  // The request modal reports one status for the formats it requested
  const requestComplete = useCallback(
    (newStatus: MediaStatus) => {
      if (isBookFormatRequestable(currentStatus)) {
        setCurrentStatus(newStatus);
      }
      if (isBookFormatRequestable(currentStatusAudio)) {
        setCurrentStatusAudio(newStatus);
      }
      setShowRequestModal(false);
    },
    [currentStatus, currentStatusAudio]
  );

  const requestUpdating = useCallback(
    (updating: boolean) => setIsUpdating(updating),
    []
  );

  const closeModal = useCallback(() => setShowRequestModal(false), []);

  const showRequestButton =
    !isAuthor &&
    settings.currentSettings.booksEnabled &&
    hasPermission([Permission.REQUEST, Permission.REQUEST_BOOK], {
      type: 'or',
    }) &&
    (isBookFormatRequestable(currentStatus) ||
      isBookFormatRequestable(currentStatusAudio));

  return (
    <div
      className={
        canExpand
          ? 'w-full'
          : ambient
            ? 'w-[150px] sm:w-[176px]'
            : 'w-36 sm:w-36 md:w-44'
      }
      data-testid="book-title-card"
    >
      {!isAuthor && (
        <RequestModal
          type="book"
          tmdbId={0}
          olId={id}
          show={showRequestModal}
          onComplete={requestComplete}
          onUpdating={requestUpdating}
          onCancel={closeModal}
        />
      )}
      <div
        className={
          ambient
            ? `relative transform-gpu cursor-default overflow-hidden ${isAuthor ? 'rounded-full' : 'rounded-[8px_18px_18px_8px]'} bg-as-tile bg-cover outline-none transition duration-300 ${
                showDetail ? 'scale-[1.03] shadow-xl shadow-black/40' : ''
              }`
            : `relative transform-gpu cursor-default overflow-hidden rounded-xl bg-gray-800 bg-cover outline-none ring-1 transition duration-300 ${
                showDetail
                  ? 'scale-105 shadow-lg ring-gray-500'
                  : 'scale-100 shadow ring-gray-700'
              }`
        }
        style={{ paddingBottom: '150%' }}
        onMouseEnter={() => {
          if (!isTouch) {
            setShowDetail(true);
          }
        }}
        onMouseLeave={() => setShowDetail(false)}
        onClick={() => setShowDetail(true)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            setShowDetail(true);
          }
        }}
        role="link"
        tabIndex={0}
      >
        <div className="absolute inset-0 h-full w-full overflow-hidden">
          {image ? (
            <CachedImage
              type="book"
              className="absolute inset-0 h-full w-full"
              alt=""
              src={image}
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              fill
            />
          ) : (
            <div className="absolute inset-0 flex items-center justify-center text-gray-600">
              {isAuthor ? (
                <UserIcon className="h-1/2 w-1/2" />
              ) : (
                <BookOpenIcon className="h-1/2 w-1/2" />
              )}
            </div>
          )}
          <div className="absolute left-0 right-0 flex items-center justify-between p-2">
            {ambient ? (
              <FormatIcon
                format={isAuthor ? mediaType : 'book'}
                size="card"
                className={`z-40 self-start ${isAuthor ? 'mx-auto' : ''}`}
              />
            ) : (
              <div className="pointer-events-none z-40 self-start rounded-full border border-amber-500 bg-amber-600/80 shadow-md">
                <div className="flex h-4 items-center px-2 py-2 text-center text-xs font-medium uppercase tracking-wider text-white sm:h-5">
                  {intl.formatMessage(kindLabel)}
                </div>
              </div>
            )}
            {!isAuthor && (
              <div className="pointer-events-none z-40 flex">
                <BookFormatIndicators
                  olId={id}
                  title={title}
                  author={subtitle}
                  status={currentStatus}
                  statusAudio={currentStatusAudio}
                />
              </div>
            )}
          </div>
          <Transition
            as={Fragment}
            show={isUpdating}
            enter="transition-opacity ease-in-out duration-300"
            enterFrom="opacity-0"
            enterTo="opacity-100"
            leave="transition-opacity ease-in-out duration-300"
            leaveFrom="opacity-100"
            leaveTo="opacity-0"
          >
            <div className="absolute inset-0 z-40 flex items-center justify-center rounded-xl bg-gray-800/75 text-white">
              <Spinner className="h-10 w-10" />
            </div>
          </Transition>
          <Transition
            as={Fragment}
            show={!image || showDetail || showRequestModal}
            enter="transition-opacity"
            enterFrom="opacity-0"
            enterTo="opacity-100"
            leave="transition-opacity"
            leaveFrom="opacity-100"
            leaveTo="opacity-0"
          >
            <div className="absolute inset-0 overflow-hidden rounded-xl">
              <Link
                href={href}
                className="absolute inset-0 h-full w-full cursor-pointer overflow-hidden text-left"
                style={{
                  background: ambient
                    ? 'linear-gradient(180deg, rgb(var(--as-ground) / 0.2) 0%, rgb(var(--as-ground) / 0.92) 100%)'
                    : 'linear-gradient(180deg, rgb(var(--tw-gray-800, 45 55 72) / 0.4) 0%, rgb(var(--tw-gray-800, 45 55 72) / 0.9) 100%)',
                }}
              >
                <div className="flex h-full w-full items-end">
                  <div
                    className={`px-2 text-white ${ambient ? 'hidden' : ''} ${
                      showRequestButton ? 'pb-11' : 'pb-2'
                    }`}
                  >
                    {year && (
                      <div className="text-sm font-medium">
                        {String(year).slice(0, 4)}
                      </div>
                    )}
                    <h1
                      className="whitespace-normal text-lg font-bold leading-tight"
                      style={{
                        WebkitLineClamp: 3,
                        display: '-webkit-box',
                        overflow: 'hidden',
                        WebkitBoxOrient: 'vertical',
                        wordBreak: 'break-word',
                      }}
                      data-testid="title-card-title"
                    >
                      {title}
                    </h1>
                    {subtitle && (
                      <div className="truncate text-xs">{subtitle}</div>
                    )}
                  </div>
                </div>
              </Link>
              <div className="absolute bottom-0 left-0 right-0 flex justify-between px-2 py-2">
                {showRequestButton && (
                  <Button
                    buttonType="primary"
                    buttonSize="sm"
                    onClick={(e) => {
                      e.preventDefault();
                      setShowRequestModal(true);
                    }}
                    className={
                      ambient
                        ? 'h-8 w-full rounded-full border-transparent bg-as-accent font-bold text-as-ground hover:bg-as-accent hover:brightness-110'
                        : 'h-7 w-full'
                    }
                  >
                    <ArrowDownTrayIcon />
                    <span>{intl.formatMessage(globalMessages.request)}</span>
                  </Button>
                )}
              </div>
            </div>
          </Transition>
        </div>
      </div>
      {ambient && (
        <Link
          href={href}
          className={`mt-2.5 block ${isAuthor ? 'text-center' : ''}`}
        >
          <div className="line-clamp-2 whitespace-normal break-words font-bold text-as-ink hover:underline">
            {title}
          </div>
          <div className="truncate text-[13px] text-as-ink-faint">
            {intl.formatMessage(kindLabel)}
            {subtitle
              ? ` · ${subtitle}`
              : year
                ? ` · ${String(year).slice(0, 4)}`
                : ''}
          </div>
        </Link>
      )}
    </div>
  );
};

export default BookTitleCard;
