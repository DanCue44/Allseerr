import { hasPermission, Permission } from '@server/lib/permissions';

/** The media types a user can be kept from seeing, one per request permission */
export type HideableMediaType = 'movie' | 'tv' | 'music' | 'book';

const REQUEST_PERMISSIONS: Record<HideableMediaType, Permission> = {
  movie: Permission.REQUEST_MOVIE,
  tv: Permission.REQUEST_TV,
  music: Permission.REQUEST_MUSIC,
  book: Permission.REQUEST_BOOK,
};

/**
 * The media types a user cannot request, which leave their navigation and
 * search while "Hide What Users Can't Request" is on. Admins and request
 * managers see everything.
 */
export const getHiddenMediaTypes = (
  permissions: number,
  hideUnrequestable: boolean
): HideableMediaType[] => {
  if (
    !hideUnrequestable ||
    hasPermission(Permission.MANAGE_REQUESTS, permissions)
  ) {
    return [];
  }

  return (Object.keys(REQUEST_PERMISSIONS) as HideableMediaType[]).filter(
    (mediaType) =>
      !hasPermission(
        [Permission.REQUEST, REQUEST_PERMISSIONS[mediaType]],
        permissions,
        { type: 'or' }
      )
  );
};

/**
 * Whether a search result stays for a user. Collections are movies, comics
 * sit with the books and people go once both movies and series are hidden.
 */
export const isResultShown = (
  mediaType: string,
  hidden: HideableMediaType[]
): boolean => {
  switch (mediaType) {
    case 'movie':
    case 'collection':
      return !hidden.includes('movie');
    case 'tv':
      return !hidden.includes('tv');
    case 'person':
      return !hidden.includes('movie') || !hidden.includes('tv');
    case 'album':
    case 'artist':
    case 'music':
      return !hidden.includes('music');
    case 'book':
    case 'author':
    case 'comic':
      return !hidden.includes('book');
    default:
      return true;
  }
};
