import Button from '@app/components/Common/Button';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import SensitiveInput from '@app/components/Common/SensitiveInput';
import useToasts from '@app/hooks/useToasts';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { isValidURL } from '@app/utils/urlValidationHelper';
import { ArrowDownOnSquareIcon, BeakerIcon } from '@heroicons/react/24/outline';
import type { TracearrSettings } from '@server/lib/settings';
import axios from 'axios';
import { Field, Formik } from 'formik';
import { useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';
import * as Yup from 'yup';

const messages = defineMessages('components.Settings.SettingsTracearr', {
  tracearrSettings: 'Tracearr Settings',
  tracearrSettingsDescription:
    'Optionally connect Tracearr as a source of watch history for Plex, Jellyfin and Emby. Allseerr reads play counts and recently watched titles for user profiles and media pages from it. When Tautulli is also set up, Tautulli is used first.',
  url: 'URL',
  urlTip: 'Where Allseerr reaches Tracearr, for example http://tracearr:3000',
  apiKey: 'API Key',
  apiKeyTip:
    'A Tracearr public API key (trr_pub_...), made under Settings > Data & API > API in Tracearr',
  validationUrl: 'You must provide a valid URL',
  validationUrlTrailingSlash: 'URL must not end in a trailing slash',
  validationBoth: 'Enter both the URL and the API key, or neither',
  test: 'Test',
  testing: 'Testing…',
  testSuccess: 'Connected to Tracearr {version}',
  testFailure: 'Could not connect to Tracearr',
  toastSuccess: 'Tracearr settings saved successfully!',
  toastFailure: 'Something went wrong while saving Tracearr settings.',
});

const SettingsTracearr = () => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const [isTesting, setIsTesting] = useState(false);
  const { data, error, mutate } = useSWR<TracearrSettings>(
    '/api/v1/settings/tracearr'
  );

  const schema = Yup.object().shape(
    {
      url: Yup.string()
        .when('apiKey', {
          is: (value: unknown) => !!value,
          then: (s) => s.required(intl.formatMessage(messages.validationBoth)),
          otherwise: (s) => s.nullable(),
        })
        .test(
          'url',
          intl.formatMessage(messages.validationUrl),
          (value) => !value || isValidURL(value)
        )
        .test(
          'no-trailing-slash',
          intl.formatMessage(messages.validationUrlTrailingSlash),
          (value) => !value || !value.endsWith('/')
        ),
      apiKey: Yup.string().when('url', {
        is: (value: unknown) => !!value,
        then: (s) => s.required(intl.formatMessage(messages.validationBoth)),
        otherwise: (s) => s.nullable(),
      }),
    },
    [['url', 'apiKey']]
  );

  const test = async (values: TracearrSettings) => {
    setIsTesting(true);

    try {
      const response = await axios.post<{ version: string }>(
        '/api/v1/settings/tracearr/test',
        values
      );
      addToast(
        intl.formatMessage(messages.testSuccess, {
          version: response.data.version,
        }),
        { appearance: 'success', autoDismiss: true }
      );
    } catch {
      addToast(intl.formatMessage(messages.testFailure), {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      setIsTesting(false);
    }
  };

  if (!data && !error) {
    return <LoadingSpinner />;
  }

  return (
    <>
      <div className="mb-6 mt-10">
        <h3 className="heading">
          {intl.formatMessage(messages.tracearrSettings)}
        </h3>
        <p className="description">
          {intl.formatMessage(messages.tracearrSettingsDescription)}
        </p>
      </div>
      <Formik
        initialValues={{ url: data?.url ?? '', apiKey: data?.apiKey ?? '' }}
        enableReinitialize
        validationSchema={schema}
        onSubmit={async (values) => {
          try {
            await axios.post('/api/v1/settings/tracearr', values);
            addToast(intl.formatMessage(messages.toastSuccess), {
              appearance: 'success',
              autoDismiss: true,
            });
          } catch {
            addToast(intl.formatMessage(messages.toastFailure), {
              appearance: 'error',
              autoDismiss: true,
            });
          } finally {
            mutate();
          }
        }}
      >
        {({ errors, touched, values, handleSubmit, isSubmitting, isValid }) => (
          <form className="section" onSubmit={handleSubmit}>
            <div className="form-row">
              <label htmlFor="tracearrUrl" className="text-label">
                {intl.formatMessage(messages.url)}
                <span className="label-tip">
                  {intl.formatMessage(messages.urlTip)}
                </span>
              </label>
              <div className="form-input-area">
                <div className="form-input-field">
                  <Field
                    type="text"
                    inputMode="url"
                    id="tracearrUrl"
                    name="url"
                    autoComplete="off"
                    data-form-type="other"
                    data-1pignore="true"
                    data-lpignore="true"
                    data-bwignore="true"
                  />
                </div>
                {errors.url && touched.url && (
                  <div className="error">{errors.url}</div>
                )}
              </div>
            </div>
            <div className="form-row">
              <label htmlFor="tracearrApiKey" className="text-label">
                {intl.formatMessage(messages.apiKey)}
                <span className="label-tip">
                  {intl.formatMessage(messages.apiKeyTip)}
                </span>
              </label>
              <div className="form-input-area">
                <div className="form-input-field">
                  <SensitiveInput
                    as="field"
                    id="tracearrApiKey"
                    name="apiKey"
                  />
                </div>
                {errors.apiKey && touched.apiKey && (
                  <div className="error">{errors.apiKey}</div>
                )}
              </div>
            </div>
            <div className="actions">
              <div className="flex justify-end">
                <span className="ml-3 inline-flex rounded-md shadow-sm">
                  <Button
                    buttonType="warning"
                    disabled={
                      isTesting || !isValid || !values.url || !values.apiKey
                    }
                    onClick={(e) => {
                      e.preventDefault();
                      test(values);
                    }}
                  >
                    <BeakerIcon />
                    <span>
                      {intl.formatMessage(
                        isTesting ? messages.testing : messages.test
                      )}
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
          </form>
        )}
      </Formik>
    </>
  );
};

export default SettingsTracearr;
