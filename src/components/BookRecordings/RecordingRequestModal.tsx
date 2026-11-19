import Alert from '@app/components/Common/Alert';
import Modal from '@app/components/Common/Modal';
import QuotaDisplay from '@app/components/RequestModal/QuotaDisplay';
import useReadingAppPrompt from '@app/hooks/useReadingAppPrompt';
import useToasts from '@app/hooks/useToasts';
import { useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import { splitRuntime } from '@app/utils/audiobookEdition';
import type { RecordingChoice } from '@app/utils/bookRecordings';
import {
  RECORDING_CHOICES,
  getCandidateParts,
  getInitialRecordingChoice,
} from '@app/utils/bookRecordings';
import defineMessages from '@app/utils/defineMessages';
import { getRequestErrorMessage } from '@app/utils/requestErrorMessage';
import { Transition } from '@headlessui/react';
import { MediaRequestStatus } from '@server/constants/media';
import type { MediaRequest } from '@server/entity/MediaRequest';
import type { QuotaResponse } from '@server/interfaces/api/userInterfaces';
import { Permission } from '@server/lib/permissions';
import type {
  BookRecordingsResponse,
  RecordingOptionReason,
} from '@server/lib/talearrRecordings';
import axios from 'axios';
import { useEffect, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages(
  'components.BookRecordings.RecordingRequestModal',
  {
    title: 'Request Another Recording',
    recording: 'Recording',
    unabridged: 'Unabridged',
    unabridgeddescription: 'The full reading of the book',
    narrator: 'Another Narrator',
    narratordescription: 'The same book read by someone else',
    edition: 'Specific Edition',
    editiondescription: 'Pick one of the audiobook editions Talearr knows',
    have: 'Already in the library',
    none: 'Talearr knows no such edition',
    requested: 'Already requested',
    narratorlabel: 'Narrator',
    editionlabel: 'Edition',
    abridged: 'Abridged',
    unabridgedtag: 'Unabridged',
    unknownnarrator: 'Unknown narrator',
    runtimeshort: '{hours}h {minutes}m',
    runtimeminutes: '{minutes}m',
    requestadmin: 'This request will be approved automatically.',
    needsapproval:
      'Talearr is asked for the recording once the request is approved.',
    requestSuccess:
      'Requested another recording of <strong>{title}</strong>. It is waiting for approval.',
    requestApproved:
      'Requested another recording of <strong>{title}</strong>. Talearr is looking for it.',
    requesterror: 'Something went wrong while submitting the request.',
  }
);

interface RecordingRequestModalProps {
  show: boolean;
  olId: string;
  title: string;
  info?: BookRecordingsResponse;
  // The option picked first, when it is open
  preferred?: RecordingChoice;
  onCancel: () => void;
  onComplete: () => void;
}

/**
 * Asks Talearr for another recording of an audiobook the library has: the
 * unabridged reading, a reading by another narrator or a picked edition.
 * The request is approved like a book request.
 */
const RecordingRequestModal = ({
  show,
  olId,
  title,
  info,
  preferred,
  onCancel,
  onComplete,
}: RecordingRequestModalProps) => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const promptReadingApp = useReadingAppPrompt('audiobook');
  const { user, hasPermission } = useUser();
  const { data: quota } = useSWR<QuotaResponse>(
    show && user ? `/api/v1/user/${user.id}/quota` : null
  );
  const [choice, setChoice] = useState<RecordingChoice | undefined>();
  const [narrator, setNarrator] = useState('');
  const [editionId, setEditionId] = useState<number | undefined>();
  const [isUpdating, setIsUpdating] = useState(false);

  const narrators = info?.options.narrator.narrators ?? [];
  const candidates = info?.candidates ?? [];

  useEffect(() => {
    if (show) {
      setChoice(getInitialRecordingChoice(info?.options, preferred));
      setNarrator(info?.options.narrator.narrators[0] ?? '');
      setEditionId(info?.candidates[0]?.editionId);
    }
  }, [show, info, preferred]);

  const hasAutoApprove = hasPermission(
    [Permission.MANAGE_REQUESTS, Permission.AUTO_APPROVE],
    { type: 'or' }
  );
  const quotaExceeded =
    !!quota?.book.restricted ||
    ((quota?.book.limit ?? 0) > 0 && (quota?.book.remaining ?? 0) < 1);

  const reasonText = (reason?: RecordingOptionReason) =>
    reason ? intl.formatMessage(messages[reason]) : undefined;

  const choiceText: Record<
    RecordingChoice,
    { label: string; description: string }
  > = {
    unabridged: {
      label: intl.formatMessage(messages.unabridged),
      description: intl.formatMessage(messages.unabridgeddescription),
    },
    narrator: {
      label: intl.formatMessage(messages.narrator),
      description: intl.formatMessage(messages.narratordescription),
    },
    edition: {
      label: intl.formatMessage(messages.edition),
      description: intl.formatMessage(messages.editiondescription),
    },
  };

  const editionLabel = (
    candidate: BookRecordingsResponse['candidates'][number]
  ) => {
    const parts = getCandidateParts(candidate);

    return [
      parts.narrators || intl.formatMessage(messages.unknownnarrator),
      parts.abridged === 'abridged'
        ? intl.formatMessage(messages.abridged)
        : parts.abridged === 'unabridged'
          ? intl.formatMessage(messages.unabridgedtag)
          : undefined,
      parts.runtimeMinutes
        ? intl.formatMessage(
            parts.runtimeMinutes >= 60
              ? messages.runtimeshort
              : messages.runtimeminutes,
            splitRuntime(parts.runtimeMinutes)
          )
        : undefined,
      [parts.publisher, parts.year].filter(Boolean).join(' ') || undefined,
    ]
      .filter(Boolean)
      .join(' - ');
  };

  const canSend =
    !!choice &&
    !!info?.options[choice].available &&
    (choice !== 'narrator' || !!narrator) &&
    (choice !== 'edition' || !!editionId) &&
    !quotaExceeded;

  const strong = (msg: React.ReactNode) => <strong>{msg}</strong>;

  const sendRequest = async () => {
    if (!choice) {
      return;
    }

    setIsUpdating(true);

    try {
      const response = await axios.post<MediaRequest>('/api/v1/request', {
        mediaType: 'book',
        mediaId: olId,
        isAudiobook: true,
        recording: choice,
        ...(choice === 'narrator' ? { recordingNarrator: narrator } : {}),
        ...(choice === 'edition' ? { recordingEditionId: editionId } : {}),
      });

      addToast(
        <span>
          {intl.formatMessage(
            response.data.status === MediaRequestStatus.APPROVED
              ? messages.requestApproved
              : messages.requestSuccess,
            { title, strong }
          )}
        </span>,
        { appearance: 'success', autoDismiss: true }
      );
      onComplete();
      promptReadingApp();
    } catch (e) {
      addToast(
        getRequestErrorMessage(e) ?? intl.formatMessage(messages.requesterror),
        {
          appearance: 'error',
          autoDismiss: true,
        }
      );
    } finally {
      setIsUpdating(false);
    }
  };

  return (
    <Transition
      as="div"
      enter="transition-opacity duration-300"
      enterFrom="opacity-0"
      enterTo="opacity-100"
      leave="transition-opacity duration-300"
      leaveFrom="opacity-100"
      leaveTo="opacity-0"
      show={show}
    >
      <Modal
        loading={!info || !quota}
        backgroundClickable
        onCancel={onCancel}
        onOk={sendRequest}
        okDisabled={isUpdating || !canSend}
        title={intl.formatMessage(messages.title)}
        subTitle={title}
        okText={
          isUpdating
            ? intl.formatMessage(globalMessages.requesting)
            : intl.formatMessage(globalMessages.request)
        }
        okButtonType="primary"
      >
        <div className="mt-6">
          <Alert
            title={intl.formatMessage(
              hasAutoApprove ? messages.requestadmin : messages.needsapproval
            )}
            type="info"
          />
        </div>
        {(quota?.book.limit ?? 0) > 0 && (
          <QuotaDisplay mediaType="book" quota={quota?.book} />
        )}
        <div className="mt-4">
          <span className="text-sm font-medium text-gray-300">
            {intl.formatMessage(messages.recording)}
          </span>
          <div
            className="mt-2 flex flex-col gap-2"
            role="radiogroup"
            aria-label={intl.formatMessage(messages.recording)}
          >
            {RECORDING_CHOICES.map((option) => {
              const state = info?.options[option];
              const disabled = !state?.available;

              return (
                <button
                  key={option}
                  type="button"
                  role="radio"
                  aria-checked={choice === option}
                  disabled={disabled}
                  onClick={() => setChoice(option)}
                  data-testid={`recording-choice-${option}`}
                  className={`flex flex-col items-start rounded-md px-3 py-2 text-left text-sm ring-1 transition duration-150 ${
                    choice === option && !disabled
                      ? 'bg-indigo-600 text-white ring-indigo-500'
                      : 'bg-gray-800 text-gray-300 ring-gray-700 hover:bg-gray-700'
                  } disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-gray-800`}
                >
                  <span className="font-medium">
                    {choiceText[option].label}
                  </span>
                  <span className="text-xs opacity-80">
                    {disabled
                      ? (reasonText(state?.reason) ??
                        choiceText[option].description)
                      : choiceText[option].description}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
        {choice === 'narrator' && narrators.length > 0 && (
          <div className="mt-4">
            <label
              htmlFor="recordingNarrator"
              className="block text-sm font-medium text-gray-300"
            >
              {intl.formatMessage(messages.narratorlabel)}
            </label>
            <select
              id="recordingNarrator"
              value={narrator}
              disabled={isUpdating}
              onChange={(e) => setNarrator(e.target.value)}
              className="mt-2 border-gray-700 bg-gray-800"
            >
              {narrators.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </div>
        )}
        {choice === 'edition' && candidates.length > 0 && (
          <div className="mt-4">
            <label
              htmlFor="recordingEdition"
              className="block text-sm font-medium text-gray-300"
            >
              {intl.formatMessage(messages.editionlabel)}
            </label>
            <select
              id="recordingEdition"
              value={editionId ?? ''}
              disabled={isUpdating}
              onChange={(e) => setEditionId(Number(e.target.value))}
              className="mt-2 border-gray-700 bg-gray-800"
            >
              {candidates.map((candidate) => (
                <option key={candidate.editionId} value={candidate.editionId}>
                  {editionLabel(candidate)}
                </option>
              ))}
            </select>
          </div>
        )}
      </Modal>
    </Transition>
  );
};

export default RecordingRequestModal;
