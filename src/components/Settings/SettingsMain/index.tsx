import BlocklistedTagsSelector from '@app/components/BlocklistedTagsSelector';
import Button from '@app/components/Common/Button';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import SensitiveInput from '@app/components/Common/SensitiveInput';
import LanguageSelector from '@app/components/LanguageSelector';
import RegionSelector from '@app/components/RegionSelector';
import { WatchProviderSelector } from '@app/components/Selector';
import AccentColorPicker from '@app/components/Settings/AccentColorPicker';
import CopyButton from '@app/components/Settings/CopyButton';
import SettingsBadge from '@app/components/Settings/SettingsBadge';
import ApplicationLogo from '@app/components/Settings/SettingsMain/ApplicationLogo';
import useHomeScreenNotice from '@app/components/Settings/SettingsMain/useHomeScreenNotice';
import { availableLanguages } from '@app/context/LanguageContext';
import useBookLanguages from '@app/hooks/useBookLanguages';
import useLocale from '@app/hooks/useLocale';
import useToasts from '@app/hooks/useToasts';
import { Permission, useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { isValidURL } from '@app/utils/urlValidationHelper';
import { parseBlockedWatchProviders } from '@app/utils/watchProviderBlock';
import { ArrowDownOnSquareIcon, BeakerIcon } from '@heroicons/react/24/outline';
import { ArrowPathIcon } from '@heroicons/react/24/solid';
import type { UserSettingsGeneralResponse } from '@server/interfaces/api/userSettingsInterfaces';
import type { MainSettings } from '@server/lib/settings';
import type { AvailableLocale } from '@server/types/languages';
import { DEFAULT_ACCENT_COLOR } from '@server/utils/accentColor';
import axios from 'axios';
import { Field, Form, Formik } from 'formik';
import { useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR, { mutate } from 'swr';
import * as Yup from 'yup';

const messages = defineMessages('components.Settings.SettingsMain', {
  general: 'General',
  generalsettings: 'General Settings',
  generalsettingsDescription:
    'Configure global and default settings for Allseerr.',
  apikey: 'API Key',
  apikeyCopied: 'Copied API key to clipboard.',
  applicationTitle: 'Application Title',
  applicationTitleTip:
    'Shown in the top bar, on the sign in page, in page titles, in emails and when the app is installed',
  accentColor: 'Accent Color',
  accentColorTip:
    'Accent color of the Ambient interface. Users can pick their own in their profile settings.',
  resetAccentColor: 'Reset to Default',
  applicationurl: 'Application URL',
  discoverRegion: 'Discover Region',
  discoverRegionTip: 'Filter content by regional availability',
  originallanguage: 'Discover Language',
  originallanguageTip: 'Filter content by original language',
  blocklistRegion: 'Blocklist Region',
  blocklistRegionTip:
    'Region used for blocklist content scanning (independent of discover settings)',
  blocklistLanguage: 'Blocklist Language',
  blocklistLanguageTip:
    'Language used for blocklist content scanning (independent of discover settings)',
  blockedWatchProviders: 'Block Requests for Streaming Services',
  blockedWatchProvidersTip:
    'Titles included with a subscription to these services in the streaming region cannot be requested. Users with Manage Requests can still request them by hand.',
  blocklistedTags: 'Blocklist Content with Tags',
  blocklistedTagsTip:
    'Automatically add content with tags to the blocklist using the "Process Blocklisted Tags" job',
  blocklistedTagsLimit: 'Limit Content Blocklisted per Tag',
  blocklistedTagsLimitTip:
    'The "Process Blocklisted Tags" job will blocklist this many pages into each sort. Larger numbers will create a more accurate blocklist, but use more space.',
  streamingRegion: 'Streaming Region',
  streamingRegionTip: 'Show streaming sites by regional availability',
  hideBlocklisted: 'Hide Blocklisted Items',
  hideBlocklistedTip:
    'Hide blocklisted items from discover pages for all users with the "Manage Blocklist" permission',
  toastApiKeySuccess: 'New API key generated successfully!',
  toastApiKeyFailure: 'Something went wrong while generating a new API key.',
  toastSettingsSuccess: 'Settings saved successfully!',
  toastSettingsFailure: 'Something went wrong while saving settings.',
  hideAvailable: 'Hide Available Media',
  hideAvailableTip:
    'Hide available media from the discover pages but not search results',
  hideRequested: 'Hide Requested Media',
  hideRequestedTip:
    'Hide media that has been requested from the discover pages but not search results',
  cacheImages: 'Enable Image Caching',
  cacheImagesTip:
    'Cache externally sourced images (requires a significant amount of disk space). Posters are then served by Allseerr itself, so a CDN in front of it, such as Cloudflare, can cache them close to your users.',
  validationApplicationTitle: 'You must provide an application title',
  validationApplicationUrl: 'You must provide a valid URL',
  validationApplicationUrlTrailingSlash: 'URL must not end in a trailing slash',
  partialRequestsEnabled: 'Allow Partial Series Requests',
  allowCurrentSeasonRequests: 'Allow Users to Request Only the Current Season',
  allowCurrentSeasonRequestsTip:
    'Lets users request only the current season of a series. Admins can always make these requests. When a new season starts, older seasons the request brought in are deleted from disk after the notice period, while seasons that were already here are kept unless an admin approves deleting them',
  currentSeasonRolloverDelayDays: 'Days Notice Before Deleting Seasons',
  currentSeasonRolloverDelayDaysTip:
    'How long admins have to keep older seasons once a new season of a current season request starts. Set to 0 to delete them right away',
  validationCurrentSeasonRolloverDelayDays:
    'You must provide a whole number of days, 0 or more',
  enableSpecialEpisodes: 'Allow Special Episodes Requests',
  defaultBookFormat: 'Default Book Format',
  defaultBookFormatTip: 'Format preselected when requesting a book',
  bookLanguage: 'Book Language',
  bookLanguageTip:
    'Language books are requested in, unless a user picks their own. Managers can pick another when requesting.',
  bookFormatBoth: 'Both',
  googleBooksApiKey: 'Google Books API Key',
  googleBooksApiKeyTip:
    'Used to check whether books have ebook editions. Without a key, ebook editions are not checked.',
  toastGoogleBooksSuccess: 'Google Books accepted the API key!',
  toastGoogleBooksFailure: 'Google Books rejected the API key.',
  locale: 'Display Language',
  youtubeUrl: 'YouTube URL',
  youtubeUrlTip:
    'Base URL for YouTube videos if a self-hosted YouTube instance is used.',
  versionCheck: 'Version Check',
  versionCheckTip: 'Automatically check for new versions on GitHub.',
  validationUrl: 'You must provide a valid URL',
});

const SettingsMain = () => {
  const { addToast } = useToasts();
  const showHomeScreenNotice = useHomeScreenNotice();
  const { user: currentUser, hasPermission: userHasPermission } = useUser();
  const intl = useIntl();
  const { setLocale } = useLocale();
  const bookLanguages = useBookLanguages();
  const [isTestingGoogleBooks, setIsTestingGoogleBooks] = useState(false);
  const {
    data,
    error,
    mutate: revalidate,
  } = useSWR<MainSettings>('/api/v1/settings/main');
  const { data: userData } = useSWR<UserSettingsGeneralResponse>(
    currentUser ? `/api/v1/user/${currentUser.id}/settings/main` : null
  );

  const MainSettingsSchema = Yup.object().shape({
    applicationTitle: Yup.string().required(
      intl.formatMessage(messages.validationApplicationTitle)
    ),
    applicationUrl: Yup.string()
      .test(
        'valid-url',
        intl.formatMessage(messages.validationApplicationUrl),
        isValidURL
      )
      .test(
        'no-trailing-slash',
        intl.formatMessage(messages.validationApplicationUrlTrailingSlash),
        (value) => !value || !value.endsWith('/')
      ),
    blocklistedTagsLimit: Yup.number()
      .test(
        'positive',
        'Number must be greater than 0.',
        (value) => (value ?? 0) >= 0
      )
      .test(
        'lte-250',
        'Number must be less than or equal to 250.',
        (value) => (value ?? 0) <= 250
      ),
    currentSeasonRolloverDelayDays: Yup.number()
      .typeError(
        intl.formatMessage(messages.validationCurrentSeasonRolloverDelayDays)
      )
      .integer(
        intl.formatMessage(messages.validationCurrentSeasonRolloverDelayDays)
      )
      .min(
        0,
        intl.formatMessage(messages.validationCurrentSeasonRolloverDelayDays)
      ),
    youtubeUrl: Yup.string().url(intl.formatMessage(messages.validationUrl)),
  });

  const regenerate = async () => {
    try {
      await axios.post('/api/v1/settings/main/regenerate');

      revalidate();
      addToast(intl.formatMessage(messages.toastApiKeySuccess), {
        autoDismiss: true,
        appearance: 'success',
      });
    } catch {
      addToast(intl.formatMessage(messages.toastApiKeyFailure), {
        autoDismiss: true,
        appearance: 'error',
      });
    }
  };

  const testGoogleBooks = async (apiKey?: string) => {
    setIsTestingGoogleBooks(true);

    try {
      await axios.post('/api/v1/settings/googlebooks/test', { apiKey });

      addToast(intl.formatMessage(messages.toastGoogleBooksSuccess), {
        autoDismiss: true,
        appearance: 'success',
      });
    } catch {
      addToast(intl.formatMessage(messages.toastGoogleBooksFailure), {
        autoDismiss: true,
        appearance: 'error',
      });
    } finally {
      setIsTestingGoogleBooks(false);
    }
  };

  if (!data && !error) {
    return <LoadingSpinner />;
  }

  return (
    <>
      <PageTitle
        title={[
          intl.formatMessage(messages.general),
          intl.formatMessage(globalMessages.settings),
        ]}
      />
      <div className="mb-6">
        <h3 className="heading">
          {intl.formatMessage(messages.generalsettings)}
        </h3>
        <p className="description">
          {intl.formatMessage(messages.generalsettingsDescription)}
        </p>
      </div>
      <div className="section">
        <Formik
          initialValues={{
            applicationTitle: data?.applicationTitle,
            applicationUrl: data?.applicationUrl,
            hideAvailable: data?.hideAvailable,
            hideBlocklisted: data?.hideBlocklisted,
            hideRequested: data?.hideRequested,
            locale: data?.locale ?? 'en',
            discoverRegion: data?.discoverRegion,
            originalLanguage: data?.originalLanguage,
            streamingRegion: data?.streamingRegion || 'US',
            blockedWatchProviders: data?.blockedWatchProviders ?? '',
            blocklistRegion: data?.blocklistRegion || '',
            blocklistLanguage: data?.blocklistLanguage || '',
            blocklistedTags: data?.blocklistedTags,
            blocklistedTagsLimit: data?.blocklistedTagsLimit || 50,
            partialRequestsEnabled: data?.partialRequestsEnabled,
            allowCurrentSeasonRequests: data?.allowCurrentSeasonRequests,
            currentSeasonRolloverDelayDays:
              data?.currentSeasonRolloverDelayDays ?? 3,
            enableSpecialEpisodes: data?.enableSpecialEpisodes,
            defaultBookFormat: data?.defaultBookFormat ?? 'both',
            bookLanguage: data?.bookLanguage ?? 'en',
            googleBooksApiKey: data?.googleBooksApiKey ?? '',
            cacheImages: data?.cacheImages,
            youtubeUrl: data?.youtubeUrl,
            versionCheck: data?.versionCheck,
            accentColor: data?.accentColor || DEFAULT_ACCENT_COLOR,
          }}
          enableReinitialize
          validationSchema={MainSettingsSchema}
          onSubmit={async (values) => {
            try {
              await axios.post('/api/v1/settings/main', {
                applicationTitle: values.applicationTitle,
                applicationUrl: values.applicationUrl,
                hideAvailable: values.hideAvailable,
                hideBlocklisted: values.hideBlocklisted,
                hideRequested: values.hideRequested,
                locale: values.locale,
                discoverRegion: values.discoverRegion,
                streamingRegion: values.streamingRegion,
                blockedWatchProviders: values.blockedWatchProviders,
                originalLanguage: values.originalLanguage,
                blocklistRegion: values.blocklistRegion,
                blocklistLanguage: values.blocklistLanguage,
                blocklistedTags: values.blocklistedTags,
                blocklistedTagsLimit: values.blocklistedTagsLimit,
                partialRequestsEnabled: values.partialRequestsEnabled,
                allowCurrentSeasonRequests: values.allowCurrentSeasonRequests,
                currentSeasonRolloverDelayDays: Number(
                  values.currentSeasonRolloverDelayDays
                ),
                enableSpecialEpisodes: values.enableSpecialEpisodes,
                defaultBookFormat: values.defaultBookFormat,
                bookLanguage: values.bookLanguage,
                // Only admins see the key, so only they can change it
                ...(userHasPermission(Permission.ADMIN)
                  ? { googleBooksApiKey: values.googleBooksApiKey.trim() }
                  : {}),
                cacheImages: values.cacheImages,
                youtubeUrl: values.youtubeUrl,
                versionCheck: values?.versionCheck,
                accentColor: values.accentColor,
              });
              mutate('/api/v1/settings/public');
              mutate('/api/v1/status?checkUpdateAvailable=false');

              if (setLocale) {
                setLocale(
                  (userData?.locale
                    ? userData.locale
                    : values.locale) as AvailableLocale
                );
              }

              addToast(intl.formatMessage(messages.toastSettingsSuccess), {
                autoDismiss: true,
                appearance: 'success',
              });

              if (values.applicationTitle !== data?.applicationTitle) {
                showHomeScreenNotice(values.applicationTitle);
              }
            } catch {
              addToast(intl.formatMessage(messages.toastSettingsFailure), {
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
            isSubmitting,
            isValid,
            values,
            setFieldValue,
          }) => {
            return (
              <Form className="section" data-testid="settings-main-form">
                {userHasPermission(Permission.ADMIN) && (
                  <div className="form-row">
                    <label htmlFor="apiKey" className="text-label">
                      {intl.formatMessage(messages.apikey)}
                    </label>
                    <div className="form-input-area">
                      <div className="form-input-field">
                        <SensitiveInput
                          type="text"
                          id="apiKey"
                          className="rounded-l-only"
                          value={data?.apiKey}
                          readOnly
                        />
                        <CopyButton
                          textToCopy={data?.apiKey ?? ''}
                          toastMessage={intl.formatMessage(
                            messages.apikeyCopied
                          )}
                          key={data?.apiKey}
                        />
                        <button
                          onClick={(e) => {
                            e.preventDefault();
                            regenerate();
                          }}
                          className="input-action"
                          type="button"
                        >
                          <ArrowPathIcon />
                        </button>
                      </div>
                    </div>
                  </div>
                )}
                <div className="form-row">
                  <label htmlFor="applicationTitle" className="text-label">
                    {intl.formatMessage(messages.applicationTitle)}
                    <span className="label-tip">
                      {intl.formatMessage(messages.applicationTitleTip)}
                    </span>
                  </label>
                  <div className="form-input-area">
                    <div className="form-input-field">
                      <Field
                        id="applicationTitle"
                        name="applicationTitle"
                        type="text"
                      />
                    </div>
                    {errors.applicationTitle &&
                      touched.applicationTitle &&
                      typeof errors.applicationTitle === 'string' && (
                        <div className="error">{errors.applicationTitle}</div>
                      )}
                  </div>
                </div>
                <ApplicationLogo
                  logoVersion={data?.applicationLogoVersion}
                  applicationTitle={values.applicationTitle}
                  onChange={() => revalidate()}
                />
                <div className="form-row">
                  <label
                    id="accentColor-label"
                    htmlFor="accentColor"
                    className="text-label"
                  >
                    {intl.formatMessage(messages.accentColor)}
                    <span className="label-tip">
                      {intl.formatMessage(messages.accentColorTip)}
                    </span>
                  </label>
                  <div className="form-input-area">
                    <div className="flex flex-wrap items-center gap-3">
                      <AccentColorPicker
                        id="accentColor"
                        value={values.accentColor}
                        onChange={(color) =>
                          setFieldValue('accentColor', color)
                        }
                      />
                      {values.accentColor !== DEFAULT_ACCENT_COLOR && (
                        <Button
                          type="button"
                          buttonType="ghost"
                          buttonSize="sm"
                          onClick={() =>
                            setFieldValue('accentColor', DEFAULT_ACCENT_COLOR)
                          }
                        >
                          {intl.formatMessage(messages.resetAccentColor)}
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
                <div className="form-row">
                  <label htmlFor="applicationUrl" className="text-label">
                    {intl.formatMessage(messages.applicationurl)}
                  </label>
                  <div className="form-input-area">
                    <div className="form-input-field">
                      <Field
                        id="applicationUrl"
                        name="applicationUrl"
                        type="text"
                        inputMode="url"
                      />
                    </div>
                    {errors.applicationUrl &&
                      touched.applicationUrl &&
                      typeof errors.applicationUrl === 'string' && (
                        <div className="error">{errors.applicationUrl}</div>
                      )}
                  </div>
                </div>
                <div className="form-row">
                  <label htmlFor="cacheImages" className="checkbox-label">
                    <span className="mr-2">
                      {intl.formatMessage(messages.cacheImages)}
                    </span>
                    <SettingsBadge badgeType="experimental" />
                    <span className="label-tip">
                      {intl.formatMessage(messages.cacheImagesTip)}
                    </span>
                  </label>
                  <div className="form-input-area">
                    <Field
                      type="checkbox"
                      id="cacheImages"
                      name="cacheImages"
                      onChange={() => {
                        setFieldValue('cacheImages', !values.cacheImages);
                      }}
                    />
                  </div>
                </div>
                <div className="form-row">
                  <label htmlFor="locale" className="text-label">
                    {intl.formatMessage(messages.locale)}
                  </label>
                  <div className="form-input-area">
                    <div className="form-input-field">
                      <Field as="select" id="locale" name="locale">
                        {(
                          Object.keys(
                            availableLanguages
                          ) as (keyof typeof availableLanguages)[]
                        ).map((key) => (
                          <option
                            key={key}
                            value={availableLanguages[key].code}
                            lang={availableLanguages[key].code}
                          >
                            {availableLanguages[key].display}
                          </option>
                        ))}
                      </Field>
                    </div>
                  </div>
                </div>
                <div className="form-row">
                  <label htmlFor="discoverRegion" className="text-label">
                    <span>{intl.formatMessage(messages.discoverRegion)}</span>
                    <span className="label-tip">
                      {intl.formatMessage(messages.discoverRegionTip)}
                    </span>
                  </label>
                  <div className="form-input-area">
                    <div className="form-input-field">
                      <RegionSelector
                        value={values.discoverRegion ?? ''}
                        name="discoverRegion"
                        onChange={setFieldValue}
                      />
                    </div>
                  </div>
                </div>
                <div className="form-row">
                  <label htmlFor="originalLanguage" className="text-label">
                    <span>{intl.formatMessage(messages.originallanguage)}</span>
                    <span className="label-tip">
                      {intl.formatMessage(messages.originallanguageTip)}
                    </span>
                  </label>
                  <div className="form-input-area">
                    <div className="form-input-field relative z-30">
                      <LanguageSelector
                        setFieldValue={setFieldValue}
                        value={values.originalLanguage}
                        fieldName="originalLanguage"
                      />
                    </div>
                  </div>
                </div>
                <div className="form-row">
                  <label htmlFor="streamingRegion" className="text-label">
                    <span>{intl.formatMessage(messages.streamingRegion)}</span>
                    <span className="label-tip">
                      {intl.formatMessage(messages.streamingRegionTip)}
                    </span>
                  </label>
                  <div className="form-input-area">
                    <div className="form-input-field relative">
                      <RegionSelector
                        value={values.streamingRegion}
                        name="streamingRegion"
                        onChange={setFieldValue}
                        regionType="streaming"
                        disableAll
                      />
                    </div>
                  </div>
                </div>
                <div className="form-row">
                  <label htmlFor="blockedWatchProviders" className="text-label">
                    <span>
                      {intl.formatMessage(messages.blockedWatchProviders)}
                    </span>
                    <span className="label-tip">
                      {intl.formatMessage(messages.blockedWatchProvidersTip)}
                    </span>
                  </label>
                  <div className="form-input-area">
                    <div className="form-input-field block">
                      <WatchProviderSelector
                        type="movie"
                        region={values.streamingRegion || 'US'}
                        activeProviders={parseBlockedWatchProviders(
                          values.blockedWatchProviders
                        )}
                        onChange={(_region, providers) =>
                          setFieldValue(
                            'blockedWatchProviders',
                            providers.join('|')
                          )
                        }
                        hideRegion
                      />
                    </div>
                  </div>
                </div>
                <div className="form-row">
                  <label htmlFor="blocklistRegion" className="text-label">
                    <span>{intl.formatMessage(messages.blocklistRegion)}</span>
                    <span className="label-tip">
                      {intl.formatMessage(messages.blocklistRegionTip)}
                    </span>
                  </label>
                  <div className="form-input-area">
                    <div className="form-input-field">
                      <RegionSelector
                        value={values.blocklistRegion}
                        name="blocklistRegion"
                        onChange={setFieldValue}
                        regionType="discover"
                      />
                    </div>
                  </div>
                </div>
                <div className="form-row">
                  <label htmlFor="blocklistLanguage" className="text-label">
                    <span>
                      {intl.formatMessage(messages.blocklistLanguage)}
                    </span>
                    <span className="label-tip">
                      {intl.formatMessage(messages.blocklistLanguageTip)}
                    </span>
                  </label>
                  <div className="form-input-area">
                    <div className="form-input-field relative z-20">
                      <LanguageSelector
                        setFieldValue={setFieldValue}
                        serverValue={data?.blocklistLanguage}
                        value={values.blocklistLanguage}
                        fieldName="blocklistLanguage"
                      />
                    </div>
                  </div>
                </div>
                <div className="form-row">
                  <label htmlFor="blocklistedTags" className="text-label">
                    <span>{intl.formatMessage(messages.blocklistedTags)}</span>
                    <span className="label-tip">
                      {intl.formatMessage(messages.blocklistedTagsTip)}
                    </span>
                  </label>
                  <div className="form-input-area">
                    <div className="form-input-field relative z-10">
                      <BlocklistedTagsSelector
                        defaultValue={values.blocklistedTags}
                      />
                    </div>
                  </div>
                </div>
                <div className="form-row">
                  <label htmlFor="blocklistedTagsLimit" className="text-label">
                    <span className="mr-2">
                      {intl.formatMessage(messages.blocklistedTagsLimit)}
                    </span>
                    <SettingsBadge badgeType="advanced" />
                    <span className="label-tip">
                      {intl.formatMessage(messages.blocklistedTagsLimitTip)}
                    </span>
                  </label>
                  <div className="form-input-area">
                    <Field
                      id="blocklistedTagsLimit"
                      name="blocklistedTagsLimit"
                      type="text"
                      inputMode="numeric"
                      className="short"
                      placeholder={50}
                    />
                    {errors.blocklistedTagsLimit &&
                      touched.blocklistedTagsLimit &&
                      typeof errors.blocklistedTagsLimit === 'string' && (
                        <div className="error">
                          {errors.blocklistedTagsLimit}
                        </div>
                      )}
                  </div>
                </div>
                <div className="form-row">
                  <label htmlFor="hideAvailable" className="checkbox-label">
                    <span className="mr-2">
                      {intl.formatMessage(messages.hideAvailable)}
                    </span>
                    <SettingsBadge badgeType="experimental" />
                    <span className="label-tip">
                      {intl.formatMessage(messages.hideAvailableTip)}
                    </span>
                  </label>
                  <div className="form-input-area">
                    <Field
                      type="checkbox"
                      id="hideAvailable"
                      name="hideAvailable"
                      onChange={() => {
                        setFieldValue('hideAvailable', !values.hideAvailable);
                      }}
                    />
                  </div>
                </div>
                <div className="form-row">
                  <label htmlFor="hideBlocklisted" className="checkbox-label">
                    <span className="mr-2">
                      {intl.formatMessage(messages.hideBlocklisted)}
                    </span>
                    <span className="label-tip">
                      {intl.formatMessage(messages.hideBlocklistedTip)}
                    </span>
                  </label>
                  <div className="form-input-area">
                    <Field
                      type="checkbox"
                      id="hideBlocklisted"
                      name="hideBlocklisted"
                      onChange={() => {
                        setFieldValue(
                          'hideBlocklisted',
                          !values.hideBlocklisted
                        );
                      }}
                    />
                  </div>
                </div>
                <div className="form-row">
                  <label htmlFor="hideRequested" className="checkbox-label">
                    <span className="mr-2">
                      {intl.formatMessage(messages.hideRequested)}
                    </span>
                    <span className="label-tip">
                      {intl.formatMessage(messages.hideRequestedTip)}
                    </span>
                  </label>
                  <div className="form-input-area">
                    <Field
                      type="checkbox"
                      id="hideRequested"
                      name="hideRequested"
                      onChange={() => {
                        setFieldValue('hideRequested', !values.hideRequested);
                      }}
                    />
                  </div>
                </div>
                <div className="form-row">
                  <label
                    htmlFor="partialRequestsEnabled"
                    className="checkbox-label"
                  >
                    <span className="mr-2">
                      {intl.formatMessage(messages.partialRequestsEnabled)}
                    </span>
                  </label>
                  <div className="form-input-area">
                    <Field
                      type="checkbox"
                      id="partialRequestsEnabled"
                      name="partialRequestsEnabled"
                      onChange={() => {
                        setFieldValue(
                          'partialRequestsEnabled',
                          !values.partialRequestsEnabled
                        );
                      }}
                    />
                  </div>
                </div>
                <div className="form-row">
                  <label
                    htmlFor="allowCurrentSeasonRequests"
                    className="checkbox-label"
                  >
                    <span className="mr-2">
                      {intl.formatMessage(messages.allowCurrentSeasonRequests)}
                    </span>
                    <span className="label-tip">
                      {intl.formatMessage(
                        messages.allowCurrentSeasonRequestsTip
                      )}
                    </span>
                  </label>
                  <div className="form-input-area">
                    <Field
                      type="checkbox"
                      id="allowCurrentSeasonRequests"
                      name="allowCurrentSeasonRequests"
                      onChange={() => {
                        setFieldValue(
                          'allowCurrentSeasonRequests',
                          !values.allowCurrentSeasonRequests
                        );
                      }}
                    />
                  </div>
                </div>
                <div className="form-row">
                  <label
                    htmlFor="currentSeasonRolloverDelayDays"
                    className="text-label"
                  >
                    <span className="mr-2">
                      {intl.formatMessage(
                        messages.currentSeasonRolloverDelayDays
                      )}
                    </span>
                    <span className="label-tip">
                      {intl.formatMessage(
                        messages.currentSeasonRolloverDelayDaysTip
                      )}
                    </span>
                  </label>
                  <div className="form-input-area">
                    <Field
                      id="currentSeasonRolloverDelayDays"
                      name="currentSeasonRolloverDelayDays"
                      type="text"
                      inputMode="numeric"
                      className="short"
                      placeholder={3}
                    />
                    {errors.currentSeasonRolloverDelayDays &&
                      touched.currentSeasonRolloverDelayDays &&
                      typeof errors.currentSeasonRolloverDelayDays ===
                        'string' && (
                        <div className="error">
                          {errors.currentSeasonRolloverDelayDays}
                        </div>
                      )}
                  </div>
                </div>
                <div className="form-row">
                  <label
                    htmlFor="enableSpecialEpisodes"
                    className="checkbox-label"
                  >
                    <span className="mr-2">
                      {intl.formatMessage(messages.enableSpecialEpisodes)}
                    </span>
                  </label>
                  <div className="form-input-area">
                    <Field
                      type="checkbox"
                      id="enableSpecialEpisodes"
                      name="enableSpecialEpisodes"
                      onChange={() => {
                        setFieldValue(
                          'enableSpecialEpisodes',
                          !values.enableSpecialEpisodes
                        );
                      }}
                    />
                  </div>
                </div>
                <div className="form-row">
                  <label htmlFor="defaultBookFormat" className="text-label">
                    <span>
                      {intl.formatMessage(messages.defaultBookFormat)}
                    </span>
                    <span className="label-tip">
                      {intl.formatMessage(messages.defaultBookFormatTip)}
                    </span>
                  </label>
                  <div className="form-input-area">
                    <div className="form-input-field">
                      <Field
                        as="select"
                        id="defaultBookFormat"
                        name="defaultBookFormat"
                      >
                        <option value="ebook">
                          {intl.formatMessage(globalMessages.ebook)}
                        </option>
                        <option value="audiobook">
                          {intl.formatMessage(globalMessages.audiobook)}
                        </option>
                        <option value="both">
                          {intl.formatMessage(messages.bookFormatBoth)}
                        </option>
                      </Field>
                    </div>
                  </div>
                </div>
                <div className="form-row">
                  <label htmlFor="bookLanguage" className="text-label">
                    <span>{intl.formatMessage(messages.bookLanguage)}</span>
                    <span className="label-tip">
                      {intl.formatMessage(messages.bookLanguageTip)}
                    </span>
                  </label>
                  <div className="form-input-area">
                    <div className="form-input-field">
                      <Field as="select" id="bookLanguage" name="bookLanguage">
                        {bookLanguages.options.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </Field>
                    </div>
                  </div>
                </div>
                {userHasPermission(Permission.ADMIN) && (
                  <div className="form-row">
                    <label htmlFor="googleBooksApiKey" className="text-label">
                      <span>
                        {intl.formatMessage(messages.googleBooksApiKey)}
                      </span>
                      <span className="label-tip">
                        {intl.formatMessage(messages.googleBooksApiKeyTip)}
                      </span>
                    </label>
                    <div className="form-input-area">
                      <div className="form-input-field">
                        <SensitiveInput
                          as="field"
                          id="googleBooksApiKey"
                          name="googleBooksApiKey"
                          autoComplete="one-time-code"
                        />
                        <button
                          onClick={(e) => {
                            e.preventDefault();
                            testGoogleBooks(values.googleBooksApiKey.trim());
                          }}
                          className="input-action"
                          type="button"
                          disabled={
                            isTestingGoogleBooks ||
                            !values.googleBooksApiKey.trim()
                          }
                          data-testid="test-google-books"
                        >
                          <BeakerIcon />
                          <span>
                            {isTestingGoogleBooks
                              ? intl.formatMessage(globalMessages.testing)
                              : intl.formatMessage(globalMessages.test)}
                          </span>
                        </button>
                      </div>
                    </div>
                  </div>
                )}
                <div className="form-row">
                  <label htmlFor="youtubeUrl" className="text-label">
                    {intl.formatMessage(messages.youtubeUrl)}
                    <span className="label-tip">
                      {intl.formatMessage(messages.youtubeUrlTip)}
                    </span>
                  </label>
                  <div className="form-input-area">
                    <div className="form-input-field">
                      <Field
                        id="youtubeUrl"
                        name="youtubeUrl"
                        type="text"
                        inputMode="url"
                      />
                    </div>
                    {errors.youtubeUrl &&
                      touched.youtubeUrl &&
                      typeof errors.youtubeUrl === 'string' && (
                        <div className="error">{errors.youtubeUrl}</div>
                      )}
                  </div>
                </div>
                <div className="form-row">
                  <label htmlFor="versionCheck" className="text-label">
                    {intl.formatMessage(messages.versionCheck)}
                    <span className="label-tip">
                      {intl.formatMessage(messages.versionCheckTip)}
                    </span>
                  </label>
                  <div className="form-input-area">
                    <Field
                      type="checkbox"
                      id="versionCheck"
                      name="versionCheck"
                      onChange={() => {
                        setFieldValue('versionCheck', !values.versionCheck);
                      }}
                    />
                  </div>
                </div>
                <div className="actions">
                  <div className="flex justify-end">
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
    </>
  );
};

export default SettingsMain;
