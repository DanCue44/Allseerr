import Button from '@app/components/Common/Button';
import { SmallLoadingSpinner } from '@app/components/Common/LoadingSpinner';
import useInterfaceStyle from '@app/hooks/useInterfaceStyle';
import defineMessages from '@app/utils/defineMessages';
import { KeyIcon } from '@heroicons/react/24/outline';
import { useState } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Login', {
  signinwithoidc: 'Sign in with single sign-on',
});

interface OidcLoginButtonProps {
  label?: string;
  isProcessing?: boolean;
}

/**
 * Leaves for the outside OpenID Connect provider, which sends the browser
 * back to the sign in page once the user is signed in
 */
const OidcLoginButton = ({ label, isProcessing }: OidcLoginButtonProps) => {
  const intl = useIntl();
  const [interfaceStyle] = useInterfaceStyle();
  const [leaving, setLeaving] = useState(false);

  return (
    <Button
      className={`relative w-full flex-1 ${
        interfaceStyle === 'ambient' ? 'h-[50px] text-[15px]' : ''
      }`}
      buttonType="primary"
      data-testid="oidc-login-button"
      disabled={leaving || isProcessing}
      onClick={() => {
        setLeaving(true);
        // An API route that redirects to the provider, not a page
        // eslint-disable-next-line @next/next/no-location-assign-relative-destination
        window.location.assign('/api/v1/auth/oidc-login/start');
      }}
    >
      {leaving && (
        <div className="absolute right-0 mr-4 h-4 w-4">
          <SmallLoadingSpinner />
        </div>
      )}
      <KeyIcon />
      <span>{label || intl.formatMessage(messages.signinwithoidc)}</span>
    </Button>
  );
};

export default OidcLoginButton;
