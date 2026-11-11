import { MediaServerType } from '@server/constants/server';
import type { PublicSettingsResponse } from '@server/interfaces/api/settingsInterfaces';
import { DEFAULT_ACCENT_COLOR } from '@server/utils/accentColor';
import React from 'react';
import useSWR from 'swr';

export interface SettingsContextProps {
  currentSettings: PublicSettingsResponse;
  children?: React.ReactNode;
}

const defaultSettings: PublicSettingsResponse = {
  initialized: false,
  applicationTitle: 'Allseerr',
  applicationUrl: '',
  applicationLogoVersion: '',
  accentColor: DEFAULT_ACCENT_COLOR,
  hideAvailable: false,
  hideBlocklisted: false,
  hideRequested: false,
  localLogin: true,
  mediaServerLogin: true,
  movie4kEnabled: false,
  series4kEnabled: false,
  booksEnabled: false,
  discoverRegion: '',
  streamingRegion: '',
  blockedWatchProviders: '',
  musicEnabled: false,
  subtitlesEnabled: false,
  audiobookshelfEnabled: false,
  readingAppsEnabled: false,
  originalLanguage: '',
  mediaServerType: MediaServerType.NOT_CONFIGURED,
  partialRequestsEnabled: true,
  allowCurrentSeasonRequests: false,
  hideUnrequestable: false,
  defaultBookFormat: 'both',
  bookLanguage: 'en',
  enableSpecialEpisodes: false,
  cacheImages: false,
  vapidPublic: '',
  enablePushRegistration: false,
  locale: 'en',
  emailEnabled: false,
  newPlexLogin: true,
  youtubeUrl: '',
  versionCheck: true,
  plexClientIdentifier: '',
};

export const SettingsContext = React.createContext<SettingsContextProps>({
  currentSettings: defaultSettings,
});

export const SettingsProvider = ({
  children,
  currentSettings,
}: SettingsContextProps) => {
  const { data, error } = useSWR<PublicSettingsResponse>(
    '/api/v1/settings/public',
    { fallbackData: currentSettings }
  );

  let newSettings = defaultSettings;

  if (data && !error) {
    newSettings = data;
  }

  return (
    <SettingsContext.Provider value={{ currentSettings: newSettings }}>
      {children}
    </SettingsContext.Provider>
  );
};
