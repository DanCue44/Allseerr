import Badge from '@app/components/Common/Badge';
import Button from '@app/components/Common/Button';
import Modal from '@app/components/Common/Modal';
import SensitiveInput from '@app/components/Common/SensitiveInput';
import {
  APP_NAMES,
  APPS,
} from '@app/components/Settings/SettingsUserAccess/common';
import useToasts from '@app/hooks/useToasts';
import defineMessages from '@app/utils/defineMessages';
import { Transition } from '@headlessui/react';
import { PencilIcon } from '@heroicons/react/24/solid';
import type { UserAccessApp } from '@server/constants/userAccess';
import type { UserAccessSettingsResponse } from '@server/interfaces/api/userAccessInterfaces';
import axios from 'axios';
import { Field, Formik } from 'formik';
import { useState } from 'react';
import { useIntl } from 'react-intl';
import * as Yup from 'yup';

const messages = defineMessages(
  'components.Settings.SettingsUserAccess.AppConnections',
  {
    apps: 'Apps',
    appsDescription:
      'Allseerr makes and manages accounts in these apps with an admin key. Nothing changes in an app until you give someone access to it.',
    connected: 'Connected',
    notConnected: 'Not connected',
    edit: 'Edit',
    editApp: '{app} connection',
    url: 'Address',
    urlHelp: 'The address Allseerr reaches {app} at, such as http://{example}',
    publicUrl: 'Public address',
    publicUrlHelp:
      'The address people open {app} at. Used in emails and for sign in with Allseerr.',
    apiKey: 'Admin API key',
    apiKeyHelpAudiobookshelf:
      'An API key of an Audiobookshelf admin, from Settings, API Keys',
    apiKeyHelpKavita:
      'The API key (auth key) of a Kavita admin, from the admin user settings',
    apiKeyHelpKomga:
      'An API key of a Komga admin, from the admin account settings',
    usernameHelpGrimmory:
      'Grimmory has no API keys, Allseerr signs in as this admin',
    savedSecret: 'Saved. Leave empty to keep it.',
    username: 'Admin username',
    usernameHelp: 'Instead of an API key',
    usernameKomga: 'Admin email',
    password: 'Admin password',
    test: 'Test',
    testing: 'Testing…',
    save: 'Save',
    saving: 'Saving…',
    cancel: 'Cancel',
    testSuccess: 'Connected to {app} {version}. Libraries: {libraries}.',
    testFailure: 'Could not connect: {message}',
    saveSuccess: '{app} connection saved.',
    saveFailure: 'Something went wrong while saving.',
    validationUrl: 'Enter a valid http or https address',
    emailPasswords: 'Email new passwords',
    emailPasswordsHelp:
      'When email notifications are set up, people get their new app passwords by email too',
    matchPlexUsernames: 'Keep app usernames the same as Plex',
    matchPlexUsernamesHelp:
      "Linked Audiobookshelf and Kavita accounts are renamed to the person's Plex username, now and whenever it changes, and the person is told. Passwords, progress and bookmarks stay the same. Komga signs people in by email and keeps its names.",
  }
);

const EXAMPLE_HOSTS: Record<UserAccessApp, string> = {
  audiobookshelf: 'audiobookshelf:80',
  kavita: 'kavita:5000',
  komga: 'komga:25600',
  grimmory: 'grimmory:6060',
};

interface AppConnectionsProps {
  settings: UserAccessSettingsResponse;
  onChange: () => void;
}

const AppConnections = ({ settings, onChange }: AppConnectionsProps) => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const [editing, setEditing] = useState<UserAccessApp | null>(null);
  const [isTesting, setIsTesting] = useState(false);

  const apiKeyHelp: Record<UserAccessApp, string> = {
    audiobookshelf: intl.formatMessage(messages.apiKeyHelpAudiobookshelf),
    kavita: intl.formatMessage(messages.apiKeyHelpKavita),
    komga: intl.formatMessage(messages.apiKeyHelpKomga),
    grimmory: '',
  };

  const isConnected = (app: UserAccessApp) =>
    !!settings[app].url &&
    (settings[app].apiKeySet ||
      (!!settings[app].username && settings[app].passwordSet));

  const schema = Yup.object().shape({
    url: Yup.string()
      .required(intl.formatMessage(messages.validationUrl))
      .matches(/^https?:\/\/.+/i, intl.formatMessage(messages.validationUrl)),
    publicUrl: Yup.string().matches(
      /^(https?:\/\/.+)?$/i,
      intl.formatMessage(messages.validationUrl)
    ),
  });

  const saveToggle = async (
    change: { emailPasswords: boolean } | { matchPlexUsernames: boolean }
  ) => {
    try {
      await axios.post('/api/v1/settings/user-access', change);
      onChange();
    } catch {
      addToast(intl.formatMessage(messages.saveFailure), {
        autoDismiss: true,
        appearance: 'error',
      });
    }
  };

  return (
    <div className="mb-10">
      <h3 className="heading">{intl.formatMessage(messages.apps)}</h3>
      <p className="description">
        {intl.formatMessage(messages.appsDescription)}
      </p>
      <ul className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-4">
        {APPS.map((app) => (
          <li
            key={app}
            className="flex items-center justify-between rounded-[22px] bg-as-surface p-5 ring-1 ring-as-line"
          >
            <div className="min-w-0">
              <div className="font-semibold text-as-ink">{APP_NAMES[app]}</div>
              <div className="mt-1 truncate text-sm text-as-ink-muted">
                {settings[app].publicUrl || settings[app].url || ' '}
              </div>
              <div className="mt-2">
                {isConnected(app) ? (
                  <Badge badgeType="success">
                    {intl.formatMessage(messages.connected)}
                  </Badge>
                ) : (
                  <Badge>{intl.formatMessage(messages.notConnected)}</Badge>
                )}
              </div>
            </div>
            <Button buttonSize="sm" onClick={() => setEditing(app)}>
              <PencilIcon />
              <span>{intl.formatMessage(messages.edit)}</span>
            </Button>
          </li>
        ))}
      </ul>
      <div className="form-row mt-6">
        <label htmlFor="emailPasswords" className="checkbox-label">
          {intl.formatMessage(messages.emailPasswords)}
          <span className="label-tip">
            {intl.formatMessage(messages.emailPasswordsHelp)}
          </span>
        </label>
        <div className="form-input-area">
          <input
            type="checkbox"
            id="emailPasswords"
            checked={settings.emailPasswords}
            onChange={(e) => saveToggle({ emailPasswords: e.target.checked })}
          />
        </div>
      </div>
      <div className="form-row">
        <label htmlFor="matchPlexUsernames" className="checkbox-label">
          {intl.formatMessage(messages.matchPlexUsernames)}
          <span className="label-tip">
            {intl.formatMessage(messages.matchPlexUsernamesHelp)}
          </span>
        </label>
        <div className="form-input-area">
          <input
            type="checkbox"
            id="matchPlexUsernames"
            checked={settings.matchPlexUsernames}
            onChange={(e) =>
              saveToggle({ matchPlexUsernames: e.target.checked })
            }
          />
        </div>
      </div>

      {editing && (
        <Transition
          as="div"
          appear
          show
          enter="transition-opacity ease-in-out duration-300"
          enterFrom="opacity-0"
          enterTo="opacity-100"
          leave="transition-opacity ease-in-out duration-300"
          leaveFrom="opacity-100"
          leaveTo="opacity-0"
        >
          <Formik
            initialValues={{
              url: settings[editing].url,
              publicUrl: settings[editing].publicUrl,
              apiKey: '',
              username: settings[editing].username,
              password: '',
            }}
            validationSchema={schema}
            onSubmit={async ({ apiKey, password, ...values }) => {
              try {
                await axios.post('/api/v1/settings/user-access', {
                  [editing]: {
                    ...values,
                    // Empty fields keep the saved secrets
                    ...(apiKey ? { apiKey } : {}),
                    ...(password ? { password } : {}),
                  },
                });
                addToast(
                  intl.formatMessage(messages.saveSuccess, {
                    app: APP_NAMES[editing],
                  }),
                  { autoDismiss: true, appearance: 'success' }
                );
                setEditing(null);
                onChange();
              } catch {
                addToast(intl.formatMessage(messages.saveFailure), {
                  autoDismiss: true,
                  appearance: 'error',
                });
              }
            }}
          >
            {({ errors, touched, values, handleSubmit, isSubmitting }) => {
              const test = async () => {
                setIsTesting(true);
                try {
                  const response = await axios.post<{
                    version?: string;
                    libraries: { name: string }[];
                  }>(`/api/v1/settings/user-access/${editing}/test`, {
                    url: values.url,
                    username: values.username,
                    ...(values.apiKey ? { apiKey: values.apiKey } : {}),
                    ...(values.password ? { password: values.password } : {}),
                  });
                  addToast(
                    intl.formatMessage(messages.testSuccess, {
                      app: APP_NAMES[editing],
                      version: response.data.version ?? '',
                      libraries:
                        response.data.libraries
                          .map((library) => library.name)
                          .join(', ') || '-',
                    }),
                    { autoDismiss: true, appearance: 'success' }
                  );
                } catch (e) {
                  addToast(
                    intl.formatMessage(messages.testFailure, {
                      message: e.response?.data?.message ?? e.message,
                    }),
                    { autoDismiss: true, appearance: 'error' }
                  );
                } finally {
                  setIsTesting(false);
                }
              };

              return (
                <Modal
                  title={intl.formatMessage(messages.editApp, {
                    app: APP_NAMES[editing],
                  })}
                  onCancel={() => setEditing(null)}
                  cancelText={intl.formatMessage(messages.cancel)}
                  okText={intl.formatMessage(
                    isSubmitting ? messages.saving : messages.save
                  )}
                  onOk={() => handleSubmit()}
                  okDisabled={isSubmitting || isTesting}
                  secondaryButtonType="warning"
                  secondaryText={intl.formatMessage(
                    isTesting ? messages.testing : messages.test
                  )}
                  onSecondary={() => test()}
                  secondaryDisabled={isTesting || !values.url}
                >
                  <div className="form-row">
                    <label htmlFor="url" className="text-label">
                      {intl.formatMessage(messages.url)}
                      <span className="label-required">*</span>
                      <span className="label-tip">
                        {intl.formatMessage(messages.urlHelp, {
                          app: APP_NAMES[editing],
                          example: EXAMPLE_HOSTS[editing],
                        })}
                      </span>
                    </label>
                    <div className="form-input-area">
                      <div className="form-input-field">
                        <Field
                          id="url"
                          name="url"
                          type="text"
                          inputMode="url"
                          autoComplete="off"
                        />
                      </div>
                      {errors.url && touched.url && (
                        <div className="error">{errors.url}</div>
                      )}
                    </div>
                  </div>
                  <div className="form-row">
                    <label htmlFor="publicUrl" className="text-label">
                      {intl.formatMessage(messages.publicUrl)}
                      <span className="label-tip">
                        {intl.formatMessage(messages.publicUrlHelp, {
                          app: APP_NAMES[editing],
                        })}
                      </span>
                    </label>
                    <div className="form-input-area">
                      <div className="form-input-field">
                        <Field
                          id="publicUrl"
                          name="publicUrl"
                          type="text"
                          inputMode="url"
                          autoComplete="off"
                        />
                      </div>
                      {errors.publicUrl && touched.publicUrl && (
                        <div className="error">{errors.publicUrl}</div>
                      )}
                    </div>
                  </div>
                  {editing !== 'grimmory' && (
                    <div className="form-row">
                      <label htmlFor="apiKey" className="text-label">
                        {intl.formatMessage(messages.apiKey)}
                        <span className="label-tip">
                          {settings[editing].apiKeySet
                            ? intl.formatMessage(messages.savedSecret)
                            : apiKeyHelp[editing]}
                        </span>
                      </label>
                      <div className="form-input-area">
                        <div className="form-input-field">
                          <SensitiveInput
                            as="field"
                            id="apiKey"
                            name="apiKey"
                            autoComplete="one-time-code"
                          />
                        </div>
                      </div>
                    </div>
                  )}
                  {editing !== 'audiobookshelf' && (
                    <>
                      <div className="form-row">
                        <label htmlFor="username" className="text-label">
                          {intl.formatMessage(
                            editing === 'komga'
                              ? messages.usernameKomga
                              : messages.username
                          )}
                          <span className="label-tip">
                            {intl.formatMessage(
                              editing === 'grimmory'
                                ? messages.usernameHelpGrimmory
                                : messages.usernameHelp
                            )}
                          </span>
                        </label>
                        <div className="form-input-area">
                          <div className="form-input-field">
                            <Field
                              id="username"
                              name="username"
                              type="text"
                              autoComplete="off"
                            />
                          </div>
                        </div>
                      </div>
                      <div className="form-row">
                        <label htmlFor="password" className="text-label">
                          {intl.formatMessage(messages.password)}
                          {settings[editing].passwordSet && (
                            <span className="label-tip">
                              {intl.formatMessage(messages.savedSecret)}
                            </span>
                          )}
                        </label>
                        <div className="form-input-area">
                          <div className="form-input-field">
                            <SensitiveInput
                              as="field"
                              id="password"
                              name="password"
                              autoComplete="one-time-code"
                            />
                          </div>
                        </div>
                      </div>
                    </>
                  )}
                </Modal>
              );
            }}
          </Formik>
        </Transition>
      )}
    </div>
  );
};

export default AppConnections;
