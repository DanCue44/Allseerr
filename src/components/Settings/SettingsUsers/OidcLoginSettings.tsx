import Button from '@app/components/Common/Button';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import SensitiveInput from '@app/components/Common/SensitiveInput';
import CopyButton from '@app/components/Settings/CopyButton';
import useToasts from '@app/hooks/useToasts';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { ArrowDownOnSquareIcon, BeakerIcon } from '@heroicons/react/24/outline';
import type { OidcLoginSettings as OidcLoginSettingsData } from '@server/lib/settings';
import axios from 'axios';
import { Field, Form, Formik } from 'formik';
import { useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR, { mutate } from 'swr';
import * as yup from 'yup';

const messages = defineMessages(
  'components.Settings.SettingsUsers.OidcLoginSettings',
  {
    oidcLogin: 'Single Sign-On (OpenID Connect)',
    oidcLoginDescription:
      'Let users sign in with an OpenID Connect provider such as Authentik, Authelia, Keycloak or Pocket ID. This is separate from Sign in with Allseerr on the User Access page, where other apps sign in with Allseerr.',
    enabled: 'Enable Single Sign-On',
    enabledTip: 'Show a single sign-on button on the sign in page',
    redirectUri: 'Redirect URI',
    redirectUriTip:
      'Register this address with your provider. It follows the Application URL in the general settings.',
    issuerUrl: 'Issuer URL',
    issuerUrlTip:
      'The address the provider publishes its .well-known/openid-configuration under',
    clientId: 'Client ID',
    clientSecret: 'Client Secret',
    clientSecretTip: 'Leave empty for a public client',
    scopes: 'Scopes',
    scopesTip:
      'Separated by spaces. openid is required, email is needed to match or make accounts.',
    buttonLabel: 'Button Label',
    buttonLabelTip: 'Leave empty for "Sign in with single sign-on"',
    autoCreateUsers: 'Create New Users',
    autoCreateUsersTip:
      'Make an account, with the default permissions, for people the provider signs in who have none yet',
    matchByEmail: 'Match Existing Users by Email',
    matchByEmailTip:
      'On a first sign in, link the account that has the same email address. Addresses the provider marks as not verified are never matched.',
    hideLocalLogin: 'Hide the Email and Password Form',
    hideLocalLoginTip:
      'Leave the email and password form off the sign in page. It stays available at /login?local=1.',
    validationIssuerUrl: 'You must provide a valid URL',
    validationRequired: 'Needed to enable single sign-on',
    test: 'Test',
    testing: 'Testing…',
    testSuccess: 'The provider answered.',
    testFailure: 'Could not reach the provider: {error}',
    saved: 'Single sign-on settings saved.',
    saveFailure: 'Something went wrong while saving single sign-on settings.',
  }
);

type OidcLoginResponse = OidcLoginSettingsData & { redirectUri: string };

const OidcLoginSettings = () => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const [testing, setTesting] = useState(false);
  const {
    data,
    error,
    mutate: revalidate,
  } = useSWR<OidcLoginResponse>('/api/v1/settings/oidc-login');

  if (!data && !error) {
    return <LoadingSpinner />;
  }

  if (!data) {
    return null;
  }

  const required = () =>
    yup.string().when('enabled', {
      is: true,
      then: (schema) =>
        schema.required(intl.formatMessage(messages.validationRequired)),
      otherwise: (schema) => schema,
    });

  const schema = yup.object().shape({
    issuerUrl: required().matches(/^https?:\/\/\S+$/i, {
      message: intl.formatMessage(messages.validationIssuerUrl),
      excludeEmptyString: true,
    }),
    clientId: required(),
  });

  const { redirectUri, ...initialValues } = data;

  return (
    <div className="mt-10">
      <div className="mb-6">
        <h3 className="heading">{intl.formatMessage(messages.oidcLogin)}</h3>
        <p className="description">
          {intl.formatMessage(messages.oidcLoginDescription)}
        </p>
      </div>
      <Formik
        initialValues={initialValues}
        validationSchema={schema}
        enableReinitialize
        onSubmit={async (values) => {
          try {
            await axios.post('/api/v1/settings/oidc-login', values);
            mutate('/api/v1/settings/public');
            addToast(intl.formatMessage(messages.saved), {
              autoDismiss: true,
              appearance: 'success',
            });
          } catch {
            addToast(intl.formatMessage(messages.saveFailure), {
              autoDismiss: true,
              appearance: 'error',
            });
          } finally {
            revalidate();
          }
        }}
      >
        {({
          errors,
          touched,
          values,
          isSubmitting,
          isValid,
          setFieldValue,
        }) => {
          const testProvider = async () => {
            setTesting(true);
            try {
              await axios.post('/api/v1/settings/oidc-login/test', values);
              addToast(intl.formatMessage(messages.testSuccess), {
                autoDismiss: true,
                appearance: 'success',
              });
            } catch (e) {
              addToast(
                intl.formatMessage(messages.testFailure, {
                  error: e.response?.data?.message ?? e.message,
                }),
                { autoDismiss: true, appearance: 'error' }
              );
            } finally {
              setTesting(false);
            }
          };

          const checkbox = (
            name:
              | 'enabled'
              | 'autoCreateUsers'
              | 'matchByEmail'
              | 'hideLocalLogin',
            label: string,
            tip: string
          ) => (
            <div className="form-row">
              <label htmlFor={`oidc-${name}`} className="checkbox-label">
                {label}
                <span className="label-tip">{tip}</span>
              </label>
              <div className="form-input-area">
                <Field
                  type="checkbox"
                  id={`oidc-${name}`}
                  name={name}
                  onChange={() => setFieldValue(name, !values[name])}
                />
              </div>
            </div>
          );

          const textField = (
            name: 'issuerUrl' | 'clientId' | 'scopes' | 'buttonLabel',
            label: string,
            tip?: string,
            inputMode?: 'url'
          ) => (
            <div className="form-row">
              <label htmlFor={`oidc-${name}`} className="text-label">
                {label}
                {name === 'issuerUrl' || name === 'clientId'
                  ? values.enabled && <span className="label-required">*</span>
                  : null}
                {tip && <span className="label-tip">{tip}</span>}
              </label>
              <div className="form-input-area">
                <div className="form-input-field">
                  <Field
                    type="text"
                    inputMode={inputMode}
                    id={`oidc-${name}`}
                    name={name}
                    autoComplete="off"
                  />
                </div>
                {errors[name] && touched[name] && (
                  <div className="error">{errors[name]}</div>
                )}
              </div>
            </div>
          );

          return (
            <Form className="section" data-testid="settings-oidc-login-form">
              {checkbox(
                'enabled',
                intl.formatMessage(messages.enabled),
                intl.formatMessage(messages.enabledTip)
              )}
              <div className="form-row">
                <label htmlFor="oidc-redirectUri" className="text-label">
                  {intl.formatMessage(messages.redirectUri)}
                  <span className="label-tip">
                    {intl.formatMessage(messages.redirectUriTip)}
                  </span>
                </label>
                <div className="form-input-area">
                  <div className="form-input-field">
                    <input
                      type="text"
                      id="oidc-redirectUri"
                      className="rounded-l-only"
                      value={redirectUri}
                      readOnly
                    />
                    <CopyButton textToCopy={redirectUri} />
                  </div>
                </div>
              </div>
              {textField(
                'issuerUrl',
                intl.formatMessage(messages.issuerUrl),
                intl.formatMessage(messages.issuerUrlTip),
                'url'
              )}
              {textField('clientId', intl.formatMessage(messages.clientId))}
              <div className="form-row">
                <label htmlFor="oidc-clientSecret" className="text-label">
                  {intl.formatMessage(messages.clientSecret)}
                  <span className="label-tip">
                    {intl.formatMessage(messages.clientSecretTip)}
                  </span>
                </label>
                <div className="form-input-area">
                  <div className="form-input-field">
                    <SensitiveInput
                      as="field"
                      type="text"
                      id="oidc-clientSecret"
                      name="clientSecret"
                      autoComplete="off"
                    />
                  </div>
                </div>
              </div>
              {textField(
                'scopes',
                intl.formatMessage(messages.scopes),
                intl.formatMessage(messages.scopesTip)
              )}
              {textField(
                'buttonLabel',
                intl.formatMessage(messages.buttonLabel),
                intl.formatMessage(messages.buttonLabelTip)
              )}
              {checkbox(
                'matchByEmail',
                intl.formatMessage(messages.matchByEmail),
                intl.formatMessage(messages.matchByEmailTip)
              )}
              {checkbox(
                'autoCreateUsers',
                intl.formatMessage(messages.autoCreateUsers),
                intl.formatMessage(messages.autoCreateUsersTip)
              )}
              {checkbox(
                'hideLocalLogin',
                intl.formatMessage(messages.hideLocalLogin),
                intl.formatMessage(messages.hideLocalLoginTip)
              )}
              <div className="actions">
                <div className="flex justify-end">
                  <span className="ml-3 inline-flex rounded-md shadow-sm">
                    <Button
                      buttonType="warning"
                      type="button"
                      disabled={
                        testing || !values.issuerUrl || !values.clientId
                      }
                      onClick={testProvider}
                    >
                      <BeakerIcon />
                      <span>
                        {testing
                          ? intl.formatMessage(messages.testing)
                          : intl.formatMessage(messages.test)}
                      </span>
                    </Button>
                  </span>
                  <span className="ml-3 inline-flex rounded-md shadow-sm">
                    <Button
                      buttonType="primary"
                      type="submit"
                      disabled={isSubmitting || !isValid}
                    >
                      <ArrowDownOnSquareIcon />
                      <span>
                        {isSubmitting
                          ? intl.formatMessage(globalMessages.saving)
                          : intl.formatMessage(globalMessages.save)}
                      </span>
                    </Button>
                  </span>
                </div>
              </div>
            </Form>
          );
        }}
      </Formik>
    </div>
  );
};

export default OidcLoginSettings;
