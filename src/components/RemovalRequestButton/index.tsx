import Button from '@app/components/Common/Button';
import Modal from '@app/components/Common/Modal';
import Tooltip from '@app/components/Common/Tooltip';
import useSettings from '@app/hooks/useSettings';
import useToasts from '@app/hooks/useToasts';
import { Permission, useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { Transition } from '@headlessui/react';
import { TrashIcon } from '@heroicons/react/24/outline';
import type { BookFormatChoice } from '@server/constants/media';
import {
  MediaStatus,
  MediaType,
  RemovalRequestStatus,
} from '@server/constants/media';
import type Media from '@server/entity/Media';
import type { RemovalRequestResultsResponse } from '@server/interfaces/api/removalInterfaces';
import axios from 'axios';
import { useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR, { mutate } from 'swr';

const messages = defineMessages('components.RemovalRequestButton', {
  requestremoval: 'Request Removal',
  requestremoval4k: 'Request 4K Removal',
  removalrequested: 'Removal Requested',
  removalrequestedTip:
    'A removal request is waiting for approval. Cancel it from Removal Requests.',
  removalModalTitle: 'Request Removal',
  removalModalSubtitle:
    'Ask to remove {title} and its files from the server. An admin will review it.',
  removalModalSubtitleSelf:
    'Ask to remove {title} and its files from the server. If you are the only one who requested it, it is removed right away. Otherwise an admin will review it.',
  submit: 'Request Removal',
  submitting: 'Requesting…',
  reason: 'Reason',
  reasonTip: 'Optional. Tell the admin why it can go.',
  reasonPlaceholder: 'We finished watching it',
  reasonPlaceholderMusic: 'We do not listen to it anymore',
  reasonPlaceholderBook: 'We finished reading it',
  success: 'Removal requested for <strong>{title}</strong>.',
  removed: '<strong>{title}</strong> was removed.',
  alreadyRequested: 'A removal request for this title already exists.',
  error: 'Something went wrong while requesting removal.',
  format: 'Format',
  formatTip: 'Which formats to remove from the server',
  bothFormats: 'Both',
});

interface RemovalRequestButtonProps {
  media?: Media;
  title: string;
  is4k?: boolean;
  className?: string;
}

const removableStatuses = [
  MediaStatus.AVAILABLE,
  MediaStatus.PARTIALLY_AVAILABLE,
];

const RemovalRequestButton = ({
  media,
  title,
  is4k = false,
  className = 'ml-2',
}: RemovalRequestButtonProps) => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const { hasPermission } = useUser();
  const settings = useSettings();
  const [showModal, setShowModal] = useState(false);
  const [reason, setReason] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [bookFormat, setBookFormat] = useState<BookFormatChoice>('both');

  const isBook = media?.mediaType === MediaType.BOOK;
  // A book can be removed when either of its formats is available
  const ebookRemovable =
    isBook && removableStatuses.includes(media?.status ?? MediaStatus.UNKNOWN);
  const audiobookRemovable =
    isBook &&
    removableStatuses.includes(media?.statusAudio ?? MediaStatus.UNKNOWN);

  const canRequest =
    !!media &&
    (isBook
      ? ebookRemovable || audiobookRemovable
      : removableStatuses.includes(media[is4k ? 'status4k' : 'status'])) &&
    hasPermission(
      [
        Permission.REQUEST,
        Permission.REQUEST_MOVIE,
        Permission.REQUEST_TV,
        Permission.REQUEST_MUSIC,
        Permission.REQUEST_BOOK,
      ],
      { type: 'or' }
    );

  const removalsKey = canRequest
    ? `/api/v1/removal?mediaId=${media?.id}&filter=pending`
    : null;
  const { data } = useSWR<RemovalRequestResultsResponse>(removalsKey);

  if (!canRequest) {
    return null;
  }

  const pending = data?.results.find(
    (removal) =>
      removal.is4k === is4k &&
      (removal.status === RemovalRequestStatus.PENDING ||
        removal.status === RemovalRequestStatus.FAILED)
  );

  const submit = async () => {
    setIsSubmitting(true);
    try {
      const { data: removal } = await axios.post<{
        status: RemovalRequestStatus;
      }>('/api/v1/removal', {
        mediaId: media?.id,
        is4k,
        reason: reason.trim() || undefined,
        ...(isBook
          ? {
              bookFormat:
                ebookRemovable && audiobookRemovable
                  ? bookFormat
                  : ebookRemovable
                    ? 'ebook'
                    : 'audiobook',
            }
          : {}),
      });
      const removed = removal?.status === RemovalRequestStatus.APPROVED;
      addToast(
        intl.formatMessage(removed ? messages.removed : messages.success, {
          title,
          strong: (msg: React.ReactNode) => <strong>{msg}</strong>,
        }),
        { autoDismiss: true, appearance: 'success' }
      );
      setShowModal(false);
      setReason('');
      setBookFormat('both');
      if (removalsKey) {
        mutate(removalsKey);
      }
      mutate('/api/v1/removal/count');
      if (removed) {
        // The title is gone, so its page and cards change state
        mutate(() => true);
      }
    } catch (e) {
      addToast(
        intl.formatMessage(
          axios.isAxiosError(e) && e.response?.status === 409
            ? messages.alreadyRequested
            : messages.error
        ),
        { autoDismiss: true, appearance: 'error' }
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <>
      <Transition
        as="div"
        enter="transition-opacity duration-300"
        enterFrom="opacity-0"
        enterTo="opacity-100"
        leave="transition-opacity duration-300"
        leaveFrom="opacity-100"
        leaveTo="opacity-0"
        show={showModal}
      >
        <Modal
          backgroundClickable
          title={intl.formatMessage(messages.removalModalTitle)}
          subTitle={intl.formatMessage(
            settings.currentSettings.selfRemoval &&
              !hasPermission(Permission.MANAGE_REQUESTS)
              ? messages.removalModalSubtitleSelf
              : messages.removalModalSubtitle,
            { title }
          )}
          onCancel={() => setShowModal(false)}
          onOk={() => submit()}
          okText={
            isSubmitting
              ? intl.formatMessage(messages.submitting)
              : intl.formatMessage(messages.submit)
          }
          okButtonType="danger"
          okDisabled={isSubmitting}
        >
          {ebookRemovable && audiobookRemovable && (
            <div className="mb-4">
              <label htmlFor="removalBookFormat" className="text-label">
                {intl.formatMessage(messages.format)}
                <span className="label-tip">
                  {intl.formatMessage(messages.formatTip)}
                </span>
              </label>
              <div className="form-input-field mt-2">
                <select
                  id="removalBookFormat"
                  name="removalBookFormat"
                  value={bookFormat}
                  onChange={(e) =>
                    setBookFormat(e.target.value as BookFormatChoice)
                  }
                >
                  <option value="both">
                    {intl.formatMessage(messages.bothFormats)}
                  </option>
                  <option value="ebook">
                    {intl.formatMessage(globalMessages.ebook)}
                  </option>
                  <option value="audiobook">
                    {intl.formatMessage(globalMessages.audiobook)}
                  </option>
                </select>
              </div>
            </div>
          )}
          <label htmlFor="removalReason" className="text-label">
            {intl.formatMessage(messages.reason)}
            <span className="label-tip">
              {intl.formatMessage(messages.reasonTip)}
            </span>
          </label>
          <div className="form-input-field mt-2">
            <textarea
              id="removalReason"
              name="removalReason"
              rows={3}
              maxLength={500}
              value={reason}
              placeholder={intl.formatMessage(
                isBook
                  ? messages.reasonPlaceholderBook
                  : media?.mediaType === MediaType.MUSIC
                    ? messages.reasonPlaceholderMusic
                    : messages.reasonPlaceholder
              )}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
        </Modal>
      </Transition>
      {pending ? (
        <Tooltip content={intl.formatMessage(messages.removalrequestedTip)}>
          <Button buttonType="ghost" className={className} disabled>
            <TrashIcon />
            <span>{intl.formatMessage(messages.removalrequested)}</span>
          </Button>
        </Tooltip>
      ) : (
        <Tooltip
          content={intl.formatMessage(
            is4k ? messages.requestremoval4k : messages.requestremoval
          )}
        >
          <Button
            buttonType="ghost"
            className={className}
            onClick={() => setShowModal(true)}
          >
            <TrashIcon />
          </Button>
        </Tooltip>
      )}
    </>
  );
};

export default RemovalRequestButton;
