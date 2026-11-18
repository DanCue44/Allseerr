import Alert from '@app/components/Common/Alert';
import HeadphonesIcon from '@app/components/Common/HeadphonesIcon';
import Modal from '@app/components/Common/Modal';
import BookLanguageSelect from '@app/components/RequestModal/BookLanguageSelect';
import QuotaDisplay from '@app/components/RequestModal/QuotaDisplay';
import useBookLanguages from '@app/hooks/useBookLanguages';
import useEditionAvailability from '@app/hooks/useEditionAvailability';
import useReadingAppPrompt from '@app/hooks/useReadingAppPrompt';
import useSettings from '@app/hooks/useSettings';
import useToasts from '@app/hooks/useToasts';
import { useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import {
  getInitialBookFormat,
  isBookFormatRequestable,
} from '@app/utils/bookStatus';
import defineMessages from '@app/utils/defineMessages';
import { ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import { BookOpenIcon } from '@heroicons/react/24/solid';
import type { AudiobookVersion } from '@server/constants/audiobookVersion';
import type { BookLanguage } from '@server/constants/bookLanguages';
import { isBookLanguage } from '@server/constants/bookLanguages';
import type { BookFormatChoice } from '@server/constants/media';
import { MediaRequestStatus, MediaStatus } from '@server/constants/media';
import type { MediaRequest } from '@server/entity/MediaRequest';
import type { NonFunctionProperties } from '@server/interfaces/api/common';
import type { QuotaResponse } from '@server/interfaces/api/userInterfaces';
import { Permission } from '@server/lib/permissions';
import type { BookDetails } from '@server/models/Book';
import axios from 'axios';
import { useEffect, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR, { mutate } from 'swr';

const messages = defineMessages('components.RequestModal.BookRequestModal', {
  requestbooktitle: 'Request Book',
  pendingbookrequest: 'Pending {format} Request',
  bookby: '{title} by {author}',
  format: 'Format',
  both: 'Both',
  formatunavailable: 'Already requested or available',
  requestadmin: 'This request will be approved automatically.',
  requestSuccess: '<strong>{title}</strong> requested successfully!',
  requestCancel: 'Request for <strong>{title}</strong> canceled.',
  requestApproved: 'Request for <strong>{title}</strong> approved!',
  requesterror: 'Something went wrong while submitting the request.',
  errorediting: 'Something went wrong while editing the request.',
  approve: 'Approve Request',
  cancel: 'Cancel Request',
  requestfrom: "{username}'s request is pending approval.",
  pendingapproval: 'Your request is pending approval.',
  noebookedition: 'No ebook edition found. The ebook can still be requested.',
  noaudiobookedition:
    'No audiobook edition found. The audiobook can still be requested.',
  audiobookversion: 'Audiobook Version',
  versionunabridged: 'Unabridged',
  versionabridged: 'Abridged',
  versionboth: 'Both',
  versionbothtip:
    'The abridged reading is asked for as a recording of its own, when Talearr knows one.',
  versionstrictness: 'Preferred or Only',
  versionpreferred: 'Preferred',
  versiononly: 'Only',
  versionpreferredunabridgedtip:
    'Takes the abridged reading when no unabridged release is found.',
  versiononlyunabridgedtip: 'Never takes the abridged reading.',
  versionpreferredabridgedtip:
    'Takes the unabridged reading when no abridged release is found.',
  versiononlyabridgedtip: 'Never takes the unabridged reading.',
});

interface BookRequestModalProps {
  olId: string;
  editRequest?: NonFunctionProperties<MediaRequest>;
  onCancel?: () => void;
  onComplete?: (newStatus: MediaStatus) => void;
  onUpdating?: (isUpdating: boolean) => void;
}

/**
 * Requests the ebook, the audiobook or both formats of a book. Each format
 * is its own request, so choosing both sends two.
 */
const BookRequestModal = ({
  olId,
  editRequest,
  onCancel,
  onComplete,
  onUpdating,
}: BookRequestModalProps) => {
  const [isUpdating, setIsUpdating] = useState(false);
  const { addToast } = useToasts();
  const { data, error } = useSWR<BookDetails>(`/api/v1/book/${olId}`, {
    revalidateOnMount: true,
  });
  const intl = useIntl();
  const { user, hasPermission } = useUser();
  const settings = useSettings();
  const promptReadingApp = useReadingAppPrompt();
  const { data: quota } = useSWR<QuotaResponse>(
    user && !editRequest ? `/api/v1/user/${user.id}/quota` : null
  );
  // Only managers choose the language, everyone else requests in their own
  const canChooseLanguage = hasPermission(Permission.MANAGE_REQUESTS);
  const { userLanguage, serverLanguage } = useBookLanguages();
  const requestLanguage = editRequest
    ? isBookLanguage(editRequest.language)
      ? editRequest.language
      : serverLanguage
    : userLanguage;
  const [language, setLanguage] = useState<BookLanguage>(requestLanguage);

  useEffect(() => {
    setLanguage(requestLanguage);
  }, [requestLanguage]);

  const canRequestEbook = isBookFormatRequestable(data?.mediaInfo?.status);
  const canRequestAudiobook = isBookFormatRequestable(
    data?.mediaInfo?.statusAudio
  );
  const defaultBookFormat = settings.currentSettings.defaultBookFormat;
  const [format, setFormat] = useState<BookFormatChoice>(() =>
    getInitialBookFormat(
      defaultBookFormat,
      canRequestEbook,
      canRequestAudiobook
    )
  );

  useEffect(() => {
    setFormat(
      getInitialBookFormat(
        defaultBookFormat,
        canRequestEbook,
        canRequestAudiobook
      )
    );
  }, [defaultBookFormat, canRequestEbook, canRequestAudiobook]);

  // Talearr only, when the Audiobook Versions setting lets the requester
  // pick the readings of the audiobook
  const canChooseVersion =
    settings.currentSettings.audiobookVersions === 'requester';
  // The reading and, for one reading, whether it is only a preference
  const [reading, setReading] = useState<'unabridged' | 'abridged' | 'both'>(
    'unabridged'
  );
  const [readingOnly, setReadingOnly] = useState(false);
  const audiobookVersion: AudiobookVersion =
    reading === 'both'
      ? 'both'
      : readingOnly
        ? reading
        : reading === 'unabridged'
          ? 'preferUnabridged'
          : 'preferAbridged';

  useEffect(() => {
    if (onUpdating) {
      onUpdating(isUpdating);
    }
  }, [isUpdating, onUpdating]);

  const authorNames = data?.authors.map((author) => author.name).join(', ');
  const availabilityQuery = data
    ? { olId, title: data.title, author: authorNames }
    : undefined;
  // Only asked while a format can be requested, to warn before it is
  const ebook = useEditionAvailability(
    'ebook',
    availabilityQuery,
    !editRequest && canRequestEbook
  );
  const audiobook = useEditionAvailability(
    'audiobook',
    availabilityQuery,
    !editRequest && canRequestAudiobook
  );
  const noEbookEdition = ebook?.exists === false;
  const noAudiobookEdition = audiobook?.exists === false;
  const subTitle = data
    ? authorNames
      ? intl.formatMessage(messages.bookby, {
          title: data.title,
          author: authorNames,
        })
      : data.title
    : undefined;

  const refreshRequests = () => {
    mutate('/api/v1/request?filter=all&take=10&sort=modified&skip=0');
    mutate('/api/v1/request/count');
    mutate(`/api/v1/book/${olId}`);
  };

  const strong = (msg: React.ReactNode) => <strong>{msg}</strong>;

  const sendRequest = async () => {
    setIsUpdating(true);

    try {
      const formats =
        format === 'both' ? [false, true] : [format === 'audiobook'];
      const responses = [];

      for (const isAudiobook of formats) {
        const response = await axios.post<MediaRequest>('/api/v1/request', {
          mediaId: olId,
          mediaType: 'book',
          isAudiobook,
          ...(canChooseLanguage ? { language } : {}),
          ...(isAudiobook && canChooseVersion ? { audiobookVersion } : {}),
        });
        responses.push(response.data);
      }
      refreshRequests();
      // Offers to set up the app the book is read or heard in
      promptReadingApp(
        formats.map((isAudiobook) => (isAudiobook ? 'audiobook' : 'ebook'))
      );

      if (onComplete) {
        onComplete(
          responses.some(
            (request) => request.status === MediaRequestStatus.APPROVED
          )
            ? MediaStatus.PROCESSING
            : MediaStatus.PENDING
        );
      }
      addToast(
        <span>
          {intl.formatMessage(messages.requestSuccess, {
            title: data?.title,
            strong,
          })}
        </span>,
        { appearance: 'success', autoDismiss: true }
      );
    } catch {
      addToast(intl.formatMessage(messages.requesterror), {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      setIsUpdating(false);
    }
  };

  const cancelRequest = async () => {
    setIsUpdating(true);

    try {
      const response = await axios.delete<MediaRequest>(
        `/api/v1/request/${editRequest?.id}`
      );
      refreshRequests();

      if (response.status === 204) {
        if (onComplete) {
          onComplete(MediaStatus.UNKNOWN);
        }
        addToast(
          <span>
            {intl.formatMessage(messages.requestCancel, {
              title: data?.title,
              strong,
            })}
          </span>,
          { appearance: 'success', autoDismiss: true }
        );
      }
    } catch {
      setIsUpdating(false);
    }
  };

  const approveRequest = async () => {
    setIsUpdating(true);

    try {
      // Only a changed language is saved, an older request without one
      // keeps using the requester's language
      if (canChooseLanguage && language !== requestLanguage) {
        await axios.put(`/api/v1/request/${editRequest?.id}`, {
          mediaType: 'book',
          language,
        });
      }

      await axios.post(`/api/v1/request/${editRequest?.id}/approve`);
      refreshRequests();

      addToast(
        <span>
          {intl.formatMessage(messages.requestApproved, {
            title: data?.title,
            strong,
          })}
        </span>,
        { appearance: 'success', autoDismiss: true }
      );

      if (onComplete) {
        onComplete(MediaStatus.PROCESSING);
      }
    } catch {
      addToast(<span>{intl.formatMessage(messages.errorediting)}</span>, {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      setIsUpdating(false);
    }
  };

  if (editRequest) {
    const isOwner = editRequest.requestedBy.id === user?.id;
    const canManage = hasPermission(Permission.MANAGE_REQUESTS);

    return (
      <Modal
        loading={!data && !error}
        backgroundClickable
        onCancel={onCancel}
        title={intl.formatMessage(messages.pendingbookrequest, {
          format: intl.formatMessage(
            editRequest.isAudiobook
              ? globalMessages.audiobook
              : globalMessages.ebook
          ),
        })}
        subTitle={subTitle}
        onOk={() => (canManage ? approveRequest() : cancelRequest())}
        okDisabled={isUpdating}
        okText={intl.formatMessage(
          canManage ? messages.approve : messages.cancel
        )}
        okButtonType={canManage ? 'success' : 'danger'}
        onSecondary={isOwner && canManage ? () => cancelRequest() : undefined}
        secondaryDisabled={isUpdating}
        secondaryText={
          isOwner && canManage ? intl.formatMessage(messages.cancel) : undefined
        }
        secondaryButtonType="danger"
        cancelText={intl.formatMessage(globalMessages.close)}
      >
        {isOwner
          ? intl.formatMessage(messages.pendingapproval)
          : intl.formatMessage(messages.requestfrom, {
              username: editRequest.requestedBy.displayName,
            })}
        {canManage && (
          <BookLanguageSelect
            value={language}
            onChange={setLanguage}
            disabled={isUpdating}
          />
        )}
      </Modal>
    );
  }

  const hasAutoApprove = hasPermission(
    [Permission.MANAGE_REQUESTS, Permission.AUTO_APPROVE],
    { type: 'or' }
  );

  const formatOptions: {
    value: BookFormatChoice;
    label: string;
    disabled: boolean;
    icons: React.ReactNode[];
  }[] = [
    {
      value: 'ebook',
      label: intl.formatMessage(globalMessages.ebook),
      disabled: !canRequestEbook,
      icons: [<BookOpenIcon key="ebook" />],
    },
    {
      value: 'audiobook',
      label: intl.formatMessage(globalMessages.audiobook),
      disabled: !canRequestAudiobook,
      icons: [<HeadphonesIcon key="audiobook" />],
    },
    {
      value: 'both',
      label: intl.formatMessage(messages.both),
      disabled: !canRequestEbook || !canRequestAudiobook,
      icons: [<BookOpenIcon key="ebook" />, <HeadphonesIcon key="audiobook" />],
    },
  ];

  const versionOptions: {
    value: 'unabridged' | 'abridged' | 'both';
    label: string;
  }[] = [
    {
      value: 'unabridged',
      label: intl.formatMessage(messages.versionunabridged),
    },
    { value: 'abridged', label: intl.formatMessage(messages.versionabridged) },
    { value: 'both', label: intl.formatMessage(messages.versionboth) },
  ];

  const strictnessOptions: { only: boolean; label: string }[] = [
    { only: false, label: intl.formatMessage(messages.versionpreferred) },
    { only: true, label: intl.formatMessage(messages.versiononly) },
  ];

  const strictnessTip =
    reading === 'unabridged'
      ? readingOnly
        ? messages.versiononlyunabridgedtip
        : messages.versionpreferredunabridgedtip
      : readingOnly
        ? messages.versiononlyabridgedtip
        : messages.versionpreferredabridgedtip;

  const radioClass = (selected: boolean) =>
    `rounded-md px-2 py-2 text-sm font-medium ring-1 transition duration-150 sm:px-3 ${
      selected
        ? 'bg-indigo-600 text-white ring-indigo-500'
        : 'bg-gray-800 text-gray-300 ring-gray-700 hover:bg-gray-700'
    } disabled:cursor-not-allowed disabled:opacity-50`;

  // Each format is its own request, so both formats need two from the quota
  const quotaExceeded =
    !!quota?.book.restricted ||
    ((quota?.book.limit ?? 0) > 0 &&
      (format === 'both' ? 2 : 1) > (quota?.book.remaining ?? 0));

  return (
    <Modal
      loading={(!data && !error) || !quota}
      backgroundClickable
      onCancel={onCancel}
      onOk={sendRequest}
      okDisabled={
        isUpdating ||
        !data ||
        quotaExceeded ||
        !!formatOptions.find((option) => option.value === format)?.disabled
      }
      title={intl.formatMessage(messages.requestbooktitle)}
      subTitle={subTitle}
      okText={
        isUpdating
          ? intl.formatMessage(globalMessages.requesting)
          : intl.formatMessage(globalMessages.request)
      }
      okButtonType={'primary'}
    >
      {hasAutoApprove && !quota?.book.restricted && (
        <div className="mt-6">
          <Alert
            title={intl.formatMessage(messages.requestadmin)}
            type="info"
          />
        </div>
      )}
      {(quota?.book.limit ?? 0) > 0 && (
        <QuotaDisplay mediaType="book" quota={quota?.book} />
      )}
      <div className="mt-4">
        <span className="text-sm font-medium text-gray-300">
          {intl.formatMessage(messages.format)}
        </span>
        <div
          className="mt-2 grid grid-cols-3 gap-2"
          role="radiogroup"
          aria-label={intl.formatMessage(messages.format)}
        >
          {formatOptions.map((option) => (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={format === option.value}
              disabled={option.disabled}
              title={
                option.disabled
                  ? intl.formatMessage(messages.formatunavailable)
                  : undefined
              }
              onClick={() => setFormat(option.value)}
              className={`flex flex-col items-center justify-center gap-1 rounded-md px-2 py-2 text-sm font-medium ring-1 transition duration-150 sm:flex-row sm:gap-1.5 sm:px-3 ${
                format === option.value && !option.disabled
                  ? 'bg-indigo-600 text-white ring-indigo-500'
                  : 'bg-gray-800 text-gray-300 ring-gray-700 hover:bg-gray-700'
              } disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-gray-800`}
            >
              <span className="flex flex-none items-center gap-0.5 [&>svg]:h-4 [&>svg]:w-4">
                {option.icons}
              </span>
              <span className="max-w-full truncate">{option.label}</span>
            </button>
          ))}
        </div>
        {noEbookEdition && (
          <p
            className="mt-2 flex items-start gap-1.5 text-sm text-yellow-500"
            data-testid="no-ebook-edition"
          >
            <ExclamationTriangleIcon className="mt-0.5 h-4 w-4 flex-none" />
            <span>{intl.formatMessage(messages.noebookedition)}</span>
          </p>
        )}
        {noAudiobookEdition && (
          <p
            className="mt-2 flex items-start gap-1.5 text-sm text-yellow-500"
            data-testid="no-audiobook-edition"
          >
            <ExclamationTriangleIcon className="mt-0.5 h-4 w-4 flex-none" />
            <span>{intl.formatMessage(messages.noaudiobookedition)}</span>
          </p>
        )}
      </div>
      {canChooseVersion && format !== 'ebook' && (
        <div className="mt-4">
          <span className="text-sm font-medium text-gray-300">
            {intl.formatMessage(messages.audiobookversion)}
          </span>
          <div
            className="mt-2 grid grid-cols-3 gap-2"
            role="radiogroup"
            aria-label={intl.formatMessage(messages.audiobookversion)}
          >
            {versionOptions.map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={reading === option.value}
                disabled={isUpdating}
                onClick={() => setReading(option.value)}
                className={radioClass(reading === option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
          {reading === 'both' ? (
            <p className="mt-2 text-sm text-gray-400">
              {intl.formatMessage(messages.versionbothtip)}
            </p>
          ) : (
            <>
              <div
                className="mt-2 grid grid-cols-2 gap-2"
                role="radiogroup"
                aria-label={intl.formatMessage(messages.versionstrictness)}
              >
                {strictnessOptions.map((option) => (
                  <button
                    key={option.label}
                    type="button"
                    role="radio"
                    aria-checked={readingOnly === option.only}
                    disabled={isUpdating}
                    onClick={() => setReadingOnly(option.only)}
                    className={radioClass(readingOnly === option.only)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              <p className="mt-2 text-sm text-gray-400">
                {intl.formatMessage(strictnessTip)}
              </p>
            </>
          )}
        </div>
      )}
      {canChooseLanguage && (
        <BookLanguageSelect
          value={language}
          onChange={setLanguage}
          disabled={isUpdating}
        />
      )}
    </Modal>
  );
};

export default BookRequestModal;
