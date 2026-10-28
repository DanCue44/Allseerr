import AddEmailModal from '@app/components/Login/AddEmailModal';
import useSettings from '@app/hooks/useSettings';
import useToasts from '@app/hooks/useToasts';
import { useUser } from '@app/hooks/useUser';
import defineMessages from '@app/utils/defineMessages';
import PlexOAuth from '@app/utils/plex';
import {
  ChevronRightIcon,
  ExclamationTriangleIcon,
} from '@heroicons/react/24/outline';
import axios from 'axios';
import { useState } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Layout.UserWarnings', {
  emailRequired: 'An email address is required.',
  emailInvalid: 'Email address is invalid.',
  passwordRequired: 'A password is required.',
  profileIncomplete: 'Profile is incomplete',
  plexSignInExpired: 'Plex sign-in expired',
  plexSignInRequired:
    'Sign in with Plex again to keep your watchlist and watched history in sync.',
  plexSignInSuccess: 'Plex is connected again.',
  plexSignInError:
    'Something went wrong signing in with Plex. Please try again.',
});

const plexOAuth = new PlexOAuth();

/**
 * A banner under the top bar for anything the person has to put right:
 * a missing email address, or a Plex sign in plex.tv no longer accepts.
 */
const UserWarnings: React.FC = () => {
  const intl = useIntl();
  const settings = useSettings();
  const { addToast } = useToasts();
  const { user, revalidate } = useUser();
  const [showEmailModal, setShowEmailModal] = useState(false);
  const [isSigningIn, setIsSigningIn] = useState(false);

  if (!user || !user.warnings || user.warnings.length === 0) {
    return null;
  }

  let title = intl.formatMessage(messages.profileIncomplete);
  let warningText = '';
  let action: (() => void) | undefined;

  const signInWithPlex = async () => {
    setIsSigningIn(true);
    try {
      const authToken = await plexOAuth.login(
        settings.currentSettings.plexClientIdentifier
      );
      await axios.post('/api/v1/auth/plex', { authToken });
      await revalidate();
      addToast(intl.formatMessage(messages.plexSignInSuccess), {
        appearance: 'success',
        autoDismiss: true,
      });
    } catch {
      addToast(intl.formatMessage(messages.plexSignInError), {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      setIsSigningIn(false);
    }
  };

  for (const warning of user.warnings) {
    switch (warning) {
      case 'userEmailRequired':
        warningText = intl.formatMessage(messages.emailRequired);
        action = () => setShowEmailModal(true);
        break;
      case 'plexSignInRequired':
        title = intl.formatMessage(messages.plexSignInExpired);
        warningText = intl.formatMessage(messages.plexSignInRequired);
        action = () => {
          // The popup has to open on the click itself, before plex.tv answers
          plexOAuth.preparePopup();
          setTimeout(() => signInWithPlex(), 1500);
        };
        break;
    }
  }

  if (!warningText) {
    return null;
  }

  return (
    <>
      {showEmailModal && (
        <AddEmailModal
          onClose={() => setShowEmailModal(false)}
          onSave={() => {
            setShowEmailModal(false);
            revalidate();
          }}
        />
      )}
      <button
        onClick={action}
        disabled={isSigningIn}
        className="service-error-banner mb-4 w-full cursor-pointer transition duration-300 hover:border-yellow-400 hover:bg-yellow-500/30"
      >
        <ExclamationTriangleIcon className="h-5 w-5 flex-shrink-0" />
        <span className="flex-1 text-left">
          <span className="font-bold">{title}</span>
          {': '}
          {warningText}
        </span>
        <ChevronRightIcon className="h-5 w-5 flex-shrink-0" />
      </button>
    </>
  );
};

export default UserWarnings;
