import useSettings from '@app/hooks/useSettings';
import { useUser } from '@app/hooks/useUser';
import type { HideableMediaType } from '@server/lib/hiddenMediaTypes';
import { getHiddenMediaTypes } from '@server/lib/hiddenMediaTypes';
import { useMemo } from 'react';

/**
 * The media types the signed-in user cannot request, while the admin keeps
 * them out of the user's navigation and search (Settings, Users)
 */
const useHiddenMediaTypes = (): HideableMediaType[] => {
  const settings = useSettings();
  const { user } = useUser();
  const permissions = user?.permissions ?? 0;
  const hideUnrequestable = !!settings.currentSettings.hideUnrequestable;

  // Kept stable between renders so it can sit in effect and memo deps
  return useMemo(
    () => getHiddenMediaTypes(permissions, hideUnrequestable),
    [permissions, hideUnrequestable]
  );
};

export default useHiddenMediaTypes;
