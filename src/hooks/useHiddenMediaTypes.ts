import useSettings from '@app/hooks/useSettings';
import { useUser } from '@app/hooks/useUser';
import type { HideableMediaType } from '@server/lib/hiddenMediaTypes';
import { getHiddenMediaTypes } from '@server/lib/hiddenMediaTypes';

/**
 * The media types the signed-in user cannot request, while the admin keeps
 * them out of the user's navigation and search (Settings, Users)
 */
const useHiddenMediaTypes = (): HideableMediaType[] => {
  const settings = useSettings();
  const { user } = useUser();

  return getHiddenMediaTypes(
    user?.permissions ?? 0,
    !!settings.currentSettings.hideUnrequestable
  );
};

export default useHiddenMediaTypes;
