import Modal from '@app/components/Common/Modal';
import SensitiveInput from '@app/components/Common/SensitiveInput';
import useToasts from '@app/hooks/useToasts';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { isValidURL } from '@app/utils/urlValidationHelper';
import { Transition } from '@headlessui/react';
import type { GrimmoryLibrary } from '@server/api/grimmory';
import type { GrimmorySettingsResponse } from '@server/interfaces/api/settingsInterfaces';
import axios from 'axios';
import { Field, Formik } from 'formik';
import { useState } from 'react';
import type { MessageDescriptor } from 'react-intl';
import { useIntl } from 'react-intl';
import * as Yup from 'yup';

const messages = defineMessages('components.Settings.GrimmoryModal', {
  configuregrimmory: 'Configure Grimmory',
  editgrimmory: 'Edit Grimmory',
  url: 'Grimmory URL',
  urlHelp: 'The address Allseerr reaches Grimmory at.',
  publicUrl: 'Public URL',
  publicUrlHelp:
    'Optional. The address people open Grimmory at, for links on book pages, when it differs from the one above.',
  username: 'Username',
  usernameHelp:
    'Grimmory has no API keys, so Allseerr signs in as a Grimmory user. A user who can see the libraries is enough; managing accounts from User Access needs an admin.',
  password: 'Password',
  passwordSaved: 'A password is saved. Leave this empty to keep it.',
  serves: 'Formats',
  servesHelp:
    'The formats Grimmory serves in place of Audiobookshelf. Their links on book pages open Grimmory, and the Grimmory Scan job marks requested books available once Grimmory has them.',
  ebooks: 'Ebooks',
  audiobooks: 'Audiobooks',
  ebookLibrary: 'Ebook Library',
  audiobookLibrary: 'Audiobook Library',
  libraryHelp: 'Optional. Only books in this library count for the format.',
  anyLibrary: 'Any library',
  testForLibraries: 'Click Test to list your libraries.',
  validationUrlRequired: 'You must provide a valid URL',
  validationUrlTrailingSlash: 'URL must not end in a trailing slash',
  toastTestSuccess: 'Signed in to Grimmory {version}.',
  toastTestFailure: 'Failed to sign in to Grimmory.',
  toastSaveFailure: 'Something went wrong while saving Grimmory settings.',
});

interface GrimmoryModalProps {
  grimmory: GrimmorySettingsResponse;
  onClose: () => void;
  onSave: () => void;
}

const GrimmoryModal = ({ grimmory, onClose, onSave }: GrimmoryModalProps) => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const [isTesting, setIsTesting] = useState(false);
  const [libraries, setLibraries] = useState<GrimmoryLibrary[]>();
  const isConfigured = !!grimmory.url;

  const urlField = (required: boolean) => {
    let field = Yup.string();

    if (required) {
      field = field.required(
        intl.formatMessage(messages.validationUrlRequired)
      );
    }

    return field
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
  };

  const schema = Yup.object().shape({
    url: urlField(true),
    publicUrl: urlField(false),
  });

  const testConnection = async (values: {
    url: string;
    username: string;
    password: string;
  }) => {
    setIsTesting(true);

    try {
      const response = await axios.post<{
        version?: string;
        libraries: GrimmoryLibrary[];
      }>('/api/v1/settings/grimmory/test', {
        url: values.url,
        username: values.username,
        ...(values.password ? { password: values.password } : {}),
      });

      setLibraries(response.data.libraries);
      addToast(
        intl.formatMessage(messages.toastTestSuccess, {
          version: response.data.version ?? '',
        }),
        { autoDismiss: true, appearance: 'success' }
      );
    } catch {
      addToast(intl.formatMessage(messages.toastTestFailure), {
        autoDismiss: true,
        appearance: 'error',
      });
    } finally {
      setIsTesting(false);
    }
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
      <Formik
        initialValues={{
          url: grimmory.url ?? '',
          publicUrl: grimmory.publicUrl ?? '',
          username: grimmory.username ?? '',
          password: '',
          ebooks: !!grimmory.ebooks,
          audiobooks: !!grimmory.audiobooks,
          ebookLibraryId: grimmory.ebookLibraryId ?? '',
          audiobookLibraryId: grimmory.audiobookLibraryId ?? '',
        }}
        validationSchema={schema}
        onSubmit={async ({ password, ...values }) => {
          try {
            await axios.post('/api/v1/settings/grimmory', {
              ...values,
              // An empty field keeps the saved password
              ...(password ? { password } : {}),
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
        {({ errors, touched, values, handleSubmit, isSubmitting, isValid }) => {
          const textRow = (
            name: 'url' | 'publicUrl' | 'username',
            label: MessageDescriptor,
            help: MessageDescriptor,
            required = false
          ) => (
            <div className="form-row">
              <label htmlFor={name} className="text-label">
                {intl.formatMessage(label)}
                {required && <span className="label-required">*</span>}
                <span className="label-tip">{intl.formatMessage(help)}</span>
              </label>
              <div className="form-input-area">
                <div className="form-input-field">
                  <Field
                    id={name}
                    name={name}
                    type="text"
                    inputMode={name === 'username' ? undefined : 'url'}
                    autoComplete="off"
                    data-form-type="other"
                    data-1pignore="true"
                    data-lpignore="true"
                    data-bwignore="true"
                  />
                </div>
                {name !== 'username' && errors[name] && touched[name] && (
                  <div className="error">{errors[name]}</div>
                )}
              </div>
            </div>
          );

          const libraryRow = (
            name: 'ebookLibraryId' | 'audiobookLibraryId',
            label: MessageDescriptor
          ) => {
            // The saved library stays pickable when the list does not have it
            const knownLibrary = libraries?.some(
              (library) => library.id === values[name]
            );

            return (
              <div className="form-row">
                <label htmlFor={name} className="text-label">
                  {intl.formatMessage(label)}
                  <span className="label-tip">
                    {intl.formatMessage(messages.libraryHelp)}
                  </span>
                </label>
                <div className="form-input-area">
                  <div className="form-input-field">
                    {libraries ? (
                      <Field as="select" id={name} name={name}>
                        <option value="">
                          {intl.formatMessage(messages.anyLibrary)}
                        </option>
                        {values[name] && !knownLibrary && (
                          <option value={values[name]}>{values[name]}</option>
                        )}
                        {libraries.map((library) => (
                          <option key={library.id} value={library.id}>
                            {library.name}
                          </option>
                        ))}
                      </Field>
                    ) : (
                      <Field
                        id={name}
                        name={name}
                        type="text"
                        autoComplete="off"
                      />
                    )}
                  </div>
                  {!libraries && (
                    <p className="mt-1 text-xs text-gray-400">
                      {intl.formatMessage(messages.testForLibraries)}
                    </p>
                  )}
                </div>
              </div>
            );
          };

          return (
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
                !values.url ||
                !!errors.url ||
                !values.username ||
                (!values.password && !grimmory.passwordSet) ||
                isTesting ||
                isSubmitting
              }
              okDisabled={isSubmitting || isTesting || !isValid}
              onOk={() => handleSubmit()}
              title={intl.formatMessage(
                isConfigured
                  ? messages.editgrimmory
                  : messages.configuregrimmory
              )}
            >
              <div className="mb-6">
                {textRow('url', messages.url, messages.urlHelp, true)}
                {textRow(
                  'publicUrl',
                  messages.publicUrl,
                  messages.publicUrlHelp
                )}
                {textRow('username', messages.username, messages.usernameHelp)}
                <div className="form-row">
                  <label htmlFor="password" className="text-label">
                    {intl.formatMessage(messages.password)}
                    {grimmory.passwordSet && (
                      <span className="label-tip">
                        {intl.formatMessage(messages.passwordSaved)}
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
                <div className="form-row">
                  <span className="text-label">
                    {intl.formatMessage(messages.serves)}
                    <span className="label-tip">
                      {intl.formatMessage(messages.servesHelp)}
                    </span>
                  </span>
                  <div className="form-input-area flex flex-col gap-2">
                    <label className="flex items-center gap-2">
                      <Field type="checkbox" id="ebooks" name="ebooks" />
                      <span>{intl.formatMessage(messages.ebooks)}</span>
                    </label>
                    <label className="flex items-center gap-2">
                      <Field
                        type="checkbox"
                        id="audiobooks"
                        name="audiobooks"
                      />
                      <span>{intl.formatMessage(messages.audiobooks)}</span>
                    </label>
                  </div>
                </div>
                {values.ebooks &&
                  libraryRow('ebookLibraryId', messages.ebookLibrary)}
                {values.audiobooks &&
                  libraryRow('audiobookLibraryId', messages.audiobookLibrary)}
              </div>
            </Modal>
          );
        }}
      </Formik>
    </Transition>
  );
};

export default GrimmoryModal;
