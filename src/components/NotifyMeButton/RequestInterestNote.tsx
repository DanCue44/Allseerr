import useToasts from '@app/hooks/useToasts';
import defineMessages from '@app/utils/defineMessages';
import axios from 'axios';
import { useState } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.NotifyMeButton', {
  following: 'You will be told when it is available',
  stop: 'Stop',
  waiting:
    '{count, plural, one {# more person is} other {# more people are}} waiting for it',
  stopError: 'Something went wrong. Please try again.',
});

export const interestMessages = defineMessages('components.NotifyMeButton', {
  label: 'Notify Me Too',
});

interface RequestInterestNoteProps {
  requestId: number;
  interest?: { count: number; interested: boolean };
  // The requester sees how many others wait, everyone else their own
  // interest
  isRequester: boolean;
  onChange: () => void;
  className?: string;
}

/**
 * The "Notify me too" line of a request in the request list: for a user
 * who asked to be told, a note with a way to stop, and for the requester
 * and managers, how many others are waiting for the title
 */
const RequestInterestNote = ({
  requestId,
  interest,
  isRequester,
  onChange,
  className,
}: RequestInterestNoteProps) => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const [isUpdating, setIsUpdating] = useState(false);

  if (!interest) {
    return null;
  }

  if (interest.interested && !isRequester) {
    const stop = async () => {
      setIsUpdating(true);
      try {
        await axios.delete(`/api/v1/request/${requestId}/interest`);
        onChange();
      } catch {
        addToast(intl.formatMessage(messages.stopError), {
          autoDismiss: true,
          appearance: 'error',
        });
      } finally {
        setIsUpdating(false);
      }
    };

    return (
      <span className={className}>
        {intl.formatMessage(messages.following)}
        {' · '}
        <button
          type="button"
          className="font-semibold underline hover:no-underline disabled:opacity-50"
          onClick={stop}
          disabled={isUpdating}
        >
          {intl.formatMessage(messages.stop)}
        </button>
      </span>
    );
  }

  if (interest.count > 0) {
    return (
      <span className={className}>
        {intl.formatMessage(messages.waiting, { count: interest.count })}
      </span>
    );
  }

  return null;
};

export default RequestInterestNote;
