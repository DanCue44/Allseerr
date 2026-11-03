import Modal from '@app/components/Common/Modal';
import SensitiveInput from '@app/components/Common/SensitiveInput';
import CopyButton from '@app/components/Settings/CopyButton';
import useToasts from '@app/hooks/useToasts';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { isValidURL } from '@app/utils/urlValidationHelper';
import { Transition } from '@headlessui/react';
import type {
  NoBookEndsSyncBackfillResponse,
  NoBookEndsSyncSettingsResponse,
  NoBookEndsSyncTestResponse,
} from '@server/interfaces/api/settingsInterfaces';
import axios from 'axios';
import { Field, Formik } from 'formik';
import { useState } from 'react';
import { useIntl } from 'react-intl';
import * as Yup from 'yup';

const messages = defineMessages('components.Settings.NoBookEndsSyncModal', {
  configurenobookendssync: 'Configure NoBookEnds Sync',
  editnobookendssync: 'Edit NoBookEnds Sync',
  intro:
    'NoBookEnds Sync aligns an audiobook to its EPUB, so the NoBookEnds app can highlight the words as they are read. It runs next to Audiobookshelf. Allseerr queues each book there once it has both formats, and tells the app where to find it.',
  installLink: 'How to install NoBookEnds Sync',
  composeTitle: 'Docker Compose example',
  composeHelp:
    'Replace the Audiobookshelf address and API key (a read only user with download permission), pick a long random admin token and set your time zone. Background alignments run overnight, in AUTO_WINDOW. For an NVIDIA GPU, install the NVIDIA Container Toolkit and uncomment the GPU lines. Without a GPU, use the :cpu image; it runs more slowly.',
  copyCompose: 'Copied the Docker Compose example',
  enabled: 'Enable NoBookEnds Sync',
  enabledHelp:
    'Queue books with both an audiobook and an ebook, and offer Listen and Read in the app.',
  url: 'Public URL',
  urlHelp:
    'Address the NoBookEnds app reaches the Sync server at, such as https://sync.example.com. Not needed while Allseerr serves it to phones (NoBookEnds Sync settings).',
  internalUrl: 'Internal URL',
  internalUrlHelp:
    'Optional. Address this server reaches it at, when the public one does not work from here, such as http://NoBookEnds-Sync:8000. The public URL is used otherwise.',
  adminToken: 'Admin Token',
  adminTokenHelp:
    'The ADMIN_TOKEN the Sync server was started with. Needed to queue books. Never sent to users.',
  adminTokenSaved: 'A token is saved. Leave this empty to keep it.',
  queueAll: 'Queue All Books',
  queueingAll: 'Queueing...',
  statusLine: 'NoBookEnds Sync {version} on {device}',
  gpu: 'GPU',
  cpu: 'CPU',
  workerStopped: 'The worker is not running.',
  queueLength:
    '{total, plural, =0 {Nothing is waiting} one {# book is waiting} other {# books are waiting}} ({user} requested, {auto} in the background)',
  windowLine:
    'Background alignments run {start} to {end}{active, select, true { (running now)} other {}}.',
  noWindow: 'Background alignments run at any time.',
  statusUnavailable:
    'This Sync server does not report its queue. It may be an older version, or have no ADMIN_TOKEN.',
  processing: 'Aligning {title}',
  processingProgress: 'Aligning {title} ({progress}%)',
  unknownTitle: 'a book',
  tokenInvalid:
    'The admin token was refused, or the Sync server has no ADMIN_TOKEN.',
  noToken: 'Add the admin token to see the queue and queue books.',
  validationUrlRequired: 'You must provide a valid URL',
  validationUrlTrailingSlash: 'URL must not end in a trailing slash',
  toastTestSuccess: 'NoBookEnds Sync connection established successfully!',
  toastTestTokenFailure:
    'NoBookEnds Sync answered, but the admin token was refused.',
  toastTestFailure: 'Failed to connect to NoBookEnds Sync.',
  toastSaveFailure:
    'Something went wrong while saving NoBookEnds Sync settings.',
  toastQueued:
    'NoBookEnds Sync accepted {accepted, plural, one {# book} other {# books}}{rejected, plural, =0 {} other {, # rejected (missing, or without audio or an EPUB)}}{failed, plural, =0 {} other {, # tried again later}}.',
  toastQueuedWindow:
    'They are aligned in the background between {start} and {end}.',
  toastQueuedNoWindow: 'They are aligned in the background.',
  toastQueueFailure: 'Failed to queue the books on NoBookEnds Sync.',
});

export const NOBOOKENDS_SYNC_INSTALL_URL = 'https://nobookends.com/sync/';

export const NOBOOKENDS_SYNC_COMPOSE = `services:
  nobookends-sync:
    # :latest has NVIDIA GPU support and falls back to the CPU,
    # :cpu is a much smaller image for servers without a GPU
    image: ghcr.io/dancue44/nobookends-sync:latest
    container_name: nobookends-sync
    restart: unless-stopped
    ports:
      - "8000:8000"
    environment:
      ABS_URL: http://audiobookshelf:80
      ABS_API_KEY: your-audiobookshelf-api-key
      ADMIN_TOKEN: a-long-random-token
      TZ: America/Chicago
      # Background alignments only run in this window
      AUTO_WINDOW: "01:00-06:00"
    volumes:
      - ./nobookends-sync:/data
    # NVIDIA GPU (optional, needs the NVIDIA Container Toolkit):
    # deploy:
    #   resources:
    #     reservations:
    #       devices:
    #         - driver: nvidia
    #           count: all
    #           capabilities: [gpu]
`;

interface NoBookEndsSyncModalProps {
  nobookendsSync: NoBookEndsSyncSettingsResponse;
  onClose: () => void;
  onSave: () => void;
}

interface FormValues {
  enabled: boolean;
  url: string;
  internalUrl: string;
  adminToken: string;
}

const NoBookEndsSyncModal = ({
  nobookendsSync,
  onClose,
  onSave,
}: NoBookEndsSyncModalProps) => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const [isTesting, setIsTesting] = useState(false);
  const [isQueueing, setIsQueueing] = useState(false);
  const [testResult, setTestResult] = useState<NoBookEndsSyncTestResponse>();
  const isConfigured = !!nobookendsSync.url;
  // Queueing uses the saved settings, not what the form holds
  const canQueueAll = nobookendsSync.enabled && nobookendsSync.adminTokenSet;

  const urlRule = Yup.string()
    .test(
      'valid-url',
      intl.formatMessage(messages.validationUrlRequired),
      (value) => !value || isValidURL(value)
    )
    .test(
      'no-trailing-slash',
      intl.formatMessage(messages.validationUrlTrailingSlash),
      (value) => !value || !value.endsWith('/')
    );

  const NoBookEndsSyncSettingsSchema = Yup.object().shape({
    // Served through Allseerr, the apps need no public address
    url: urlRule.when('enabled', {
      is: (enabled: boolean) => enabled && !nobookendsSync.proxy,
      then: (schema) =>
        schema.required(intl.formatMessage(messages.validationUrlRequired)),
    }),
    internalUrl: urlRule,
  });

  const testConnection = async (values: FormValues) => {
    setIsTesting(true);

    try {
      const response = await axios.post<NoBookEndsSyncTestResponse>(
        '/api/v1/settings/nobookends-sync/test',
        {
          url: values.url,
          internalUrl: values.internalUrl,
          ...(values.adminToken ? { adminToken: values.adminToken } : {}),
        }
      );

      setTestResult(response.data);
      addToast(
        intl.formatMessage(
          response.data.tokenValid === false
            ? messages.toastTestTokenFailure
            : messages.toastTestSuccess
        ),
        {
          autoDismiss: true,
          appearance:
            response.data.tokenValid === false ? 'warning' : 'success',
        }
      );
    } catch {
      setTestResult(undefined);
      addToast(intl.formatMessage(messages.toastTestFailure), {
        autoDismiss: true,
        appearance: 'error',
      });
    } finally {
      setIsTesting(false);
    }
  };

  const queueAll = async () => {
    setIsQueueing(true);

    try {
      const response = await axios.post<NoBookEndsSyncBackfillResponse>(
        '/api/v1/settings/nobookends-sync/backfill'
      );

      const { accepted, rejected, failed, window } = response.data;
      const windowText =
        window?.start && window.end
          ? intl.formatMessage(messages.toastQueuedWindow, {
              start: window.start,
              end: window.end,
            })
          : intl.formatMessage(messages.toastQueuedNoWindow);

      addToast(
        `${intl.formatMessage(messages.toastQueued, {
          accepted,
          rejected,
          failed,
        })} ${accepted ? windowText : ''}`.trim(),
        {
          autoDismiss: true,
          appearance: rejected || failed ? 'warning' : 'success',
        }
      );
    } catch {
      addToast(intl.formatMessage(messages.toastQueueFailure), {
        autoDismiss: true,
        appearance: 'error',
      });
    } finally {
      setIsQueueing(false);
    }
  };

  const statusLines = (result: NoBookEndsSyncTestResponse): string[] => {
    const lines = [
      intl.formatMessage(messages.statusLine, {
        version: result.version ?? '',
        device: intl.formatMessage(result.gpu ? messages.gpu : messages.cpu),
      }),
    ];

    if (!result.ok) {
      lines.push(intl.formatMessage(messages.workerStopped));
    }

    if (result.tokenValid === false) {
      lines.push(intl.formatMessage(messages.tokenInvalid));
    } else if (result.status) {
      const { current, queue, window } = result.status;

      if (current) {
        const title =
          current.title ?? intl.formatMessage(messages.unknownTitle);
        lines.push(
          current.progress !== null
            ? intl.formatMessage(messages.processingProgress, {
                title,
                progress: Math.round(current.progress * 100),
              })
            : intl.formatMessage(messages.processing, { title })
        );
      }

      lines.push(
        intl.formatMessage(messages.queueLength, {
          total: queue.total,
          user: queue.user,
          auto: queue.auto,
        })
      );
      lines.push(
        window.start && window.end
          ? intl.formatMessage(messages.windowLine, {
              start: window.start,
              end: window.end,
              active: String(window.active),
            })
          : intl.formatMessage(messages.noWindow)
      );
    } else if (result.statusUnavailable) {
      lines.push(intl.formatMessage(messages.statusUnavailable));
    } else {
      lines.push(intl.formatMessage(messages.noToken));
    }

    return lines;
  };

  return (
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
      <Formik<FormValues>
        initialValues={{
          enabled: nobookendsSync.enabled,
          url: nobookendsSync.url ?? '',
          internalUrl: nobookendsSync.internalUrl ?? '',
          adminToken: '',
        }}
        validationSchema={NoBookEndsSyncSettingsSchema}
        onSubmit={async (values) => {
          try {
            await axios.post('/api/v1/settings/nobookends-sync', {
              enabled: values.enabled,
              url: values.url,
              internalUrl: values.internalUrl,
              // An empty field keeps the saved token
              ...(values.adminToken ? { adminToken: values.adminToken } : {}),
            });

            onSave();
          } catch {
            addToast(intl.formatMessage(messages.toastSaveFailure), {
              autoDismiss: true,
              appearance: 'error',
            });
          }
        }}
      >
        {({
          errors,
          touched,
          values,
          handleSubmit,
          isSubmitting,
          isValid,
          setFieldValue,
        }) => (
          <Modal
            onCancel={onClose}
            okButtonType="primary"
            okText={
              isSubmitting
                ? intl.formatMessage(globalMessages.saving)
                : intl.formatMessage(globalMessages.save)
            }
            secondaryButtonType="warning"
            secondaryText={
              isTesting
                ? intl.formatMessage(globalMessages.testing)
                : intl.formatMessage(globalMessages.test)
            }
            onSecondary={() => testConnection(values)}
            secondaryDisabled={
              (!values.url && !values.internalUrl) ||
              !!errors.url ||
              !!errors.internalUrl ||
              isTesting ||
              isSubmitting
            }
            tertiaryButtonType="default"
            tertiaryText={
              canQueueAll
                ? intl.formatMessage(
                    isQueueing ? messages.queueingAll : messages.queueAll
                  )
                : undefined
            }
            onTertiary={canQueueAll ? () => queueAll() : undefined}
            tertiaryDisabled={isQueueing || isSubmitting}
            okDisabled={isSubmitting || isTesting || !isValid}
            onOk={() => handleSubmit()}
            title={intl.formatMessage(
              isConfigured
                ? messages.editnobookendssync
                : messages.configurenobookendssync
            )}
          >
            <div className="mb-6">
              <p className="mb-2 text-sm text-gray-300">
                {intl.formatMessage(messages.intro)}{' '}
                <a
                  href={NOBOOKENDS_SYNC_INSTALL_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-white underline transition duration-300 hover:text-gray-200"
                >
                  {intl.formatMessage(messages.installLink)}
                </a>
              </p>
              <details className="mb-4 text-sm text-gray-300">
                <summary className="cursor-pointer font-bold text-gray-200">
                  {intl.formatMessage(messages.composeTitle)}
                </summary>
                <p className="mt-2">
                  {intl.formatMessage(messages.composeHelp)}
                </p>
                <div className="form-input-field mt-2">
                  <textarea
                    readOnly
                    rows={14}
                    value={NOBOOKENDS_SYNC_COMPOSE}
                    className="rounded-l-only font-mono text-xs"
                    aria-label={intl.formatMessage(messages.composeTitle)}
                  />
                  <CopyButton
                    textToCopy={NOBOOKENDS_SYNC_COMPOSE}
                    toastMessage={intl.formatMessage(messages.copyCompose)}
                  />
                </div>
              </details>
              {testResult && (
                <div
                  className="mb-4 rounded-md bg-gray-700 p-3 text-sm text-gray-200"
                  data-testid="nobookends-sync-status"
                >
                  {statusLines(testResult).map((line) => (
                    <p key={line}>{line}</p>
                  ))}
                </div>
              )}
              <div className="form-row">
                <label htmlFor="enabled" className="checkbox-label">
                  {intl.formatMessage(messages.enabled)}
                  <span className="label-tip">
                    {intl.formatMessage(messages.enabledHelp)}
                  </span>
                </label>
                <div className="form-input-area">
                  <Field
                    type="checkbox"
                    id="enabled"
                    name="enabled"
                    onChange={() => {
                      setFieldValue('enabled', !values.enabled);
                    }}
                  />
                </div>
              </div>
              <div className="form-row">
                <label htmlFor="url" className="text-label">
                  {intl.formatMessage(messages.url)}
                  {values.enabled && !nobookendsSync.proxy && (
                    <span className="label-required">*</span>
                  )}
                  <span className="label-tip">
                    {intl.formatMessage(messages.urlHelp)}
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
                <label htmlFor="internalUrl" className="text-label">
                  {intl.formatMessage(messages.internalUrl)}
                  <span className="label-tip">
                    {intl.formatMessage(messages.internalUrlHelp)}
                  </span>
                </label>
                <div className="form-input-area">
                  <div className="form-input-field">
                    <Field
                      id="internalUrl"
                      name="internalUrl"
                      type="text"
                      inputMode="url"
                      autoComplete="off"
                      data-form-type="other"
                      data-1pignore="true"
                      data-lpignore="true"
                      data-bwignore="true"
                    />
                  </div>
                  {errors.internalUrl && touched.internalUrl && (
                    <div className="error">{errors.internalUrl}</div>
                  )}
                </div>
              </div>
              <div className="form-row">
                <label htmlFor="adminToken" className="text-label">
                  {intl.formatMessage(messages.adminToken)}
                  <span className="label-tip">
                    {intl.formatMessage(messages.adminTokenHelp)}
                  </span>
                </label>
                <div className="form-input-area">
                  <div className="form-input-field">
                    <SensitiveInput
                      as="field"
                      id="adminToken"
                      name="adminToken"
                      autoComplete="one-time-code"
                    />
                  </div>
                  {nobookendsSync.adminTokenSet && (
                    <p className="mt-1 text-xs text-gray-400">
                      {intl.formatMessage(messages.adminTokenSaved)}
                    </p>
                  )}
                </div>
              </div>
            </div>
          </Modal>
        )}
      </Formik>
    </Transition>
  );
};

export default NoBookEndsSyncModal;
