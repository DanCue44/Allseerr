import Alert from '@app/components/Common/Alert';
import Button from '@app/components/Common/Button';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import PermissionEdit from '@app/components/PermissionEdit';
import useToasts from '@app/hooks/useToasts';
import { Permission, useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import ErrorPage from '@app/pages/_error';
import defineMessages from '@app/utils/defineMessages';
import { ArrowDownOnSquareIcon } from '@heroicons/react/24/outline';
import {
  ALL_ADVANCED_REQUEST_OPTIONS,
  AdvancedRequestOption,
  hasAdvancedRequestOption,
} from '@server/lib/advancedRequestOptions';
import { hasPermission } from '@server/lib/permissions';
import axios from 'axios';
import { Form, Formik } from 'formik';
import { useRouter } from 'next/router';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages(
  'components.UserProfile.UserSettings.UserPermissions',
  {
    toastSettingsSuccess: 'Permissions saved successfully!',
    toastSettingsFailure: 'Something went wrong while saving settings.',
    permissions: 'Permissions',
    unauthorizedDescription: 'You cannot modify your own permissions.',
    advancedOptions: 'Advanced Request Options',
    advancedOptionsTip:
      'What this user may change when making a request with Advanced Requests. For music, the same choices apply in Lidarr.',
    optionServer: 'Destination Server',
    optionServerTip:
      'Pick which Radarr, Sonarr or Lidarr server gets the request',
    optionProfile: 'Quality Profile',
    optionProfileTip:
      'Pick the quality profile, and the language profile for series',
    optionRootFolder: 'Root Folder',
    optionRootFolderTip: 'Pick the folder the media is saved in',
    optionTags: 'Tags',
    optionTagsTip: 'Pick the tags added to the request',
  }
);

const UserPermissions = () => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const router = useRouter();
  const { user: currentUser } = useUser();
  const { user, revalidate: revalidateUser } = useUser({
    id: Number(router.query.userId),
  });
  const {
    data,
    error,
    mutate: revalidate,
  } = useSWR<{ permissions?: number; advancedRequestOptions?: number | null }>(
    user ? `/api/v1/user/${user?.id}/settings/permissions` : null
  );

  const advancedOptionList = [
    {
      id: 'advanced-server',
      option: AdvancedRequestOption.SERVER,
      name: intl.formatMessage(messages.optionServer),
      description: intl.formatMessage(messages.optionServerTip),
    },
    {
      id: 'advanced-profile',
      option: AdvancedRequestOption.PROFILE,
      name: intl.formatMessage(messages.optionProfile),
      description: intl.formatMessage(messages.optionProfileTip),
    },
    {
      id: 'advanced-rootfolder',
      option: AdvancedRequestOption.ROOT_FOLDER,
      name: intl.formatMessage(messages.optionRootFolder),
      description: intl.formatMessage(messages.optionRootFolderTip),
    },
    {
      id: 'advanced-tags',
      option: AdvancedRequestOption.TAGS,
      name: intl.formatMessage(messages.optionTags),
      description: intl.formatMessage(messages.optionTagsTip),
    },
  ];

  if (!data && !error) {
    return <LoadingSpinner />;
  }

  if (!data) {
    return <ErrorPage statusCode={500} />;
  }

  if (currentUser?.id !== 1 && currentUser?.id === user?.id) {
    return (
      <>
        <div className="mb-6">
          <h3 className="heading">
            {intl.formatMessage(messages.permissions)}
          </h3>
        </div>
        <Alert
          title={intl.formatMessage(messages.unauthorizedDescription)}
          type="error"
        />
      </>
    );
  }

  return (
    <>
      <PageTitle
        title={[
          intl.formatMessage(messages.permissions),
          intl.formatMessage(globalMessages.usersettings),
          user?.displayName,
        ]}
      />
      <div className="mb-6">
        <h3 className="heading">{intl.formatMessage(messages.permissions)}</h3>
      </div>
      <Formik
        initialValues={{
          currentPermissions: data?.permissions,
          advancedRequestOptions:
            data?.advancedRequestOptions ?? ALL_ADVANCED_REQUEST_OPTIONS,
        }}
        enableReinitialize
        onSubmit={async (values) => {
          try {
            await axios.post(`/api/v1/user/${user?.id}/settings/permissions`, {
              permissions: values.currentPermissions ?? 0,
              advancedRequestOptions: values.advancedRequestOptions,
            });

            addToast(intl.formatMessage(messages.toastSettingsSuccess), {
              autoDismiss: true,
              appearance: 'success',
            });
          } catch {
            addToast(intl.formatMessage(messages.toastSettingsFailure), {
              autoDismiss: true,
              appearance: 'error',
            });
          } finally {
            revalidate();
            revalidateUser();
          }
        }}
      >
        {({ isSubmitting, setFieldValue, values }) => {
          return (
            <Form className="section">
              <div className="max-w-3xl">
                <PermissionEdit
                  actingUser={currentUser}
                  currentUser={user}
                  currentPermission={values.currentPermissions ?? 0}
                  onUpdate={(newPermission) =>
                    setFieldValue('currentPermissions', newPermission)
                  }
                />
              </div>
              {hasPermission(
                Permission.REQUEST_ADVANCED,
                values.currentPermissions ?? 0
              ) &&
                !hasPermission(
                  Permission.MANAGE_REQUESTS,
                  values.currentPermissions ?? 0
                ) && (
                  <div className="mt-8 max-w-3xl">
                    <h3 className="heading">
                      {intl.formatMessage(messages.advancedOptions)}
                    </h3>
                    <p className="description mb-4">
                      {intl.formatMessage(messages.advancedOptionsTip)}
                    </p>
                    {advancedOptionList.map((option) => (
                      <div
                        key={option.id}
                        className="relative mt-4 flex items-start first:mt-0"
                      >
                        <div className="flex h-6 items-center">
                          <input
                            type="checkbox"
                            id={option.id}
                            name={option.id}
                            checked={hasAdvancedRequestOption(
                              values.advancedRequestOptions,
                              option.option
                            )}
                            onChange={() =>
                              setFieldValue(
                                'advancedRequestOptions',
                                values.advancedRequestOptions ^ option.option
                              )
                            }
                          />
                        </div>
                        <div className="ml-3 text-sm leading-6">
                          <label
                            htmlFor={option.id}
                            className="block"
                            aria-label={option.name}
                          >
                            <div className="flex flex-col">
                              <span className="font-medium text-white">
                                {option.name}
                              </span>
                              <span className="font-normal text-gray-400">
                                {option.description}
                              </span>
                            </div>
                          </label>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              <div className="actions">
                <div className="flex justify-end">
                  <span className="ml-3 inline-flex rounded-md shadow-sm">
                    <Button
                      buttonType="primary"
                      type="submit"
                      disabled={isSubmitting}
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
    </>
  );
};

export default UserPermissions;
