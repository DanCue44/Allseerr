import { Card } from '@app/components/Allseerr/Title';
import RecordingRequestModal from '@app/components/BookRecordings/RecordingRequestModal';
import Badge from '@app/components/Common/Badge';
import Button from '@app/components/Common/Button';
import NarratorLinks from '@app/components/Common/NarratorLinks';
import useSettings from '@app/hooks/useSettings';
import { splitRuntime } from '@app/utils/audiobookEdition';
import type {
  RecordingChoice,
  RecordingRequestState,
} from '@app/utils/bookRecordings';
import {
  canHaveRecordings,
  getRecordingRequestState,
  getVisibleRecordingRequests,
  shouldOfferUnabridged,
} from '@app/utils/bookRecordings';
import defineMessages from '@app/utils/defineMessages';
import { PlusIcon } from '@heroicons/react/24/outline';
import type { BookRecordingAbridged } from '@server/constants/bookRecording';
import type { MediaStatus } from '@server/constants/media';
import type {
  BookRecordingSummary,
  BookRecordingsResponse,
  RecordingRequestSummary,
} from '@server/lib/talearrRecordings';
import { useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.BookRecordings', {
  recordings: 'Recordings',
  fromtalearr: 'From Talearr',
  primary: 'In the library',
  abridged: 'Abridged',
  unabridged: 'Unabridged',
  unknown: 'Unknown',
  unknownnarrator: 'Unknown narrator',
  runtimeshort: '{hours}h {minutes}m',
  runtimeminutes: '{minutes}m',
  downloaded: 'Downloaded',
  searching: 'Searching',
  notmonitored: 'Not monitored',
  requests: 'Requests',
  requestunabridged: 'Unabridged recording',
  requestabridged: 'Abridged recording',
  requestnarrator: 'Narrated by {narrator}',
  requestnarratorunknown: 'Another narrator',
  requestedition: 'Edition narrated by {narrator}',
  requesteditionunknown: 'Another edition',
  requestedby: 'Requested by {user}',
  pending: 'Pending Approval',
  approved: 'Requested',
  available: 'Available',
  failed: 'Failed',
  declined: 'Declined',
  requestanother: 'Request Another Recording',
  abridgedprompt:
    'You have the abridged recording. Request the unabridged one?',
  requestunabridgedbutton: 'Request Unabridged',
});

const ABRIDGED_BADGES: Record<
  BookRecordingAbridged,
  { message: keyof typeof messages; badge: 'success' | 'warning' | 'dark' }
> = {
  unabridged: { message: 'unabridged', badge: 'success' },
  abridged: { message: 'abridged', badge: 'warning' },
  unknown: { message: 'unknown', badge: 'dark' },
};

const STATE_BADGES: Record<
  RecordingRequestState,
  'warning' | 'primary' | 'success' | 'danger' | 'dark'
> = {
  pending: 'warning',
  approved: 'primary',
  available: 'success',
  failed: 'danger',
  declined: 'dark',
};

interface BookRecordingsProps {
  olId: string;
  title: string;
  statusAudio?: MediaStatus;
  // The ambient book page wraps the section in its cards
  ambient?: boolean;
  onRequested?: () => void;
}

/**
 * The recordings Talearr keeps of a book's audiobook, the recording
 * requests made for it and a way to ask for another one. Only shown with
 * Talearr as the book service once the audiobook is in the library.
 */
const BookRecordings = ({
  olId,
  title,
  statusAudio,
  ambient,
  onRequested,
}: BookRecordingsProps) => {
  const intl = useIntl();
  const settings = useSettings();
  const [showModal, setShowModal] = useState(false);
  const [preferred, setPreferred] = useState<RecordingChoice | undefined>();
  const enabled = canHaveRecordings(
    settings.currentSettings.bookService,
    statusAudio
  );
  const { data, mutate } = useSWR<BookRecordingsResponse>(
    enabled ? `/api/v1/book/${olId}/recordings` : null,
    { revalidateOnFocus: false }
  );

  if (!enabled || !data) {
    return null;
  }

  const requests = getVisibleRecordingRequests(data.requests);

  if (!data.supported && requests.length === 0) {
    return null;
  }

  const runtime = (minutes: number | null) =>
    minutes
      ? intl.formatMessage(
          minutes >= 60 ? messages.runtimeshort : messages.runtimeminutes,
          splitRuntime(minutes)
        )
      : undefined;

  const recordingState = (recording: BookRecordingSummary) =>
    recording.hasFiles ? (
      <Badge badgeType="success">
        {intl.formatMessage(messages.downloaded)}
      </Badge>
    ) : recording.monitored ? (
      <Badge badgeType="primary">
        {intl.formatMessage(messages.searching)}
      </Badge>
    ) : (
      <Badge badgeType="dark">
        {intl.formatMessage(messages.notmonitored)}
      </Badge>
    );

  const requestLabel = (request: RecordingRequestSummary) => {
    switch (request.recording) {
      case 'unabridged':
        return intl.formatMessage(messages.requestunabridged);
      case 'abridged':
        return intl.formatMessage(messages.requestabridged);
      case 'narrator':
        return request.narrator
          ? intl.formatMessage(messages.requestnarrator, {
              narrator: request.narrator,
            })
          : intl.formatMessage(messages.requestnarratorunknown);
      default:
        return request.narrator
          ? intl.formatMessage(messages.requestedition, {
              narrator: request.narrator,
            })
          : intl.formatMessage(messages.requesteditionunknown);
    }
  };

  const openModal = (choice?: RecordingChoice) => {
    setPreferred(choice);
    setShowModal(true);
  };

  const rowClass = ambient
    ? 'flex flex-wrap items-center justify-between gap-2 border-t border-as-line py-3'
    : 'flex flex-wrap items-center justify-between gap-2 border-t border-gray-700 py-3';
  const mutedClass = ambient ? 'text-as-ink-muted' : 'text-gray-400';
  const strongClass = ambient ? 'text-as-ink' : 'text-gray-100';

  const body = (
    <div className="flex flex-col" data-testid="book-recordings">
      {shouldOfferUnabridged(data) && (
        <div
          className={`mb-3 flex flex-wrap items-center justify-between gap-3 rounded-xl px-4 py-3 text-sm ${
            ambient
              ? 'bg-as-tile text-as-ink-soft'
              : 'bg-gray-800 text-gray-300 ring-1 ring-gray-700'
          }`}
          data-testid="recordings-abridged-prompt"
        >
          <span>{intl.formatMessage(messages.abridgedprompt)}</span>
          <Button
            buttonType="primary"
            buttonSize="sm"
            onClick={() => openModal('unabridged')}
          >
            {intl.formatMessage(messages.requestunabridgedbutton)}
          </Button>
        </div>
      )}
      {data.recordings.map((recording) => (
        <div key={`recording-${recording.bookId}`} className={rowClass}>
          <div className="flex min-w-0 flex-col">
            <span className={`truncate font-semibold ${strongClass}`}>
              {recording.narrators.length ? (
                <NarratorLinks narrators={recording.narrators} />
              ) : (
                intl.formatMessage(messages.unknownnarrator)
              )}
            </span>
            <span className={`text-xs ${mutedClass}`}>
              {[
                recording.role === 'primary'
                  ? intl.formatMessage(messages.primary)
                  : undefined,
                runtime(recording.runtimeMinutes),
                [recording.publisher, recording.releaseDate?.slice(0, 4)]
                  .filter(Boolean)
                  .join(' ') || undefined,
              ]
                .filter(Boolean)
                .join(' - ')}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge badgeType={ABRIDGED_BADGES[recording.abridged].badge}>
              {intl.formatMessage(
                messages[ABRIDGED_BADGES[recording.abridged].message]
              )}
            </Badge>
            {recordingState(recording)}
          </div>
        </div>
      ))}
      {requests.length > 0 && (
        <>
          <h3
            className={`pt-3 text-xs font-bold uppercase tracking-wider ${
              ambient ? 'text-as-ink-faint' : 'text-gray-400'
            }`}
          >
            {intl.formatMessage(messages.requests)}
          </h3>
          {requests.map((request) => {
            const state = getRecordingRequestState(request.status);

            return (
              <div key={`recording-request-${request.id}`} className={rowClass}>
                <div className="flex min-w-0 flex-col">
                  <span className={`truncate font-semibold ${strongClass}`}>
                    {requestLabel(request)}
                  </span>
                  <span className={`text-xs ${mutedClass}`}>
                    {intl.formatMessage(messages.requestedby, {
                      user: request.requestedBy.displayName,
                    })}
                  </span>
                </div>
                <Badge badgeType={STATE_BADGES[state]}>
                  {intl.formatMessage(messages[state])}
                </Badge>
              </div>
            );
          })}
        </>
      )}
      {data.canRequest && (
        <div className="pt-3">
          <Button
            buttonType={ambient ? 'ghost' : 'default'}
            buttonSize="sm"
            onClick={() => openModal()}
            data-testid="request-another-recording"
          >
            <PlusIcon />
            <span>{intl.formatMessage(messages.requestanother)}</span>
          </Button>
        </div>
      )}
      <RecordingRequestModal
        show={showModal}
        olId={olId}
        title={title}
        info={data}
        preferred={preferred}
        onCancel={() => setShowModal(false)}
        onComplete={() => {
          setShowModal(false);
          mutate();
          onRequested?.();
        }}
      />
    </div>
  );

  if (ambient) {
    return (
      <Card
        title={intl.formatMessage(messages.recordings)}
        action={
          <span className="text-xs text-as-ink-faint">
            {intl.formatMessage(messages.fromtalearr)}
          </span>
        }
      >
        {body}
      </Card>
    );
  }

  return (
    <div className="mt-6">
      <h2>{intl.formatMessage(messages.recordings)}</h2>
      {body}
    </div>
  );
};

export default BookRecordings;
