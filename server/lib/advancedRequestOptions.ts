import { Permission, hasPermission } from '@server/lib/permissions';

/**
 * The parts of the Advanced Requests permission an admin can grant one by
 * one. Every permission bit is taken, so they are stored on the user as
 * their own bit field. The profile covers the quality profile and, for
 * Sonarr, the language profile; Lidarr uses the same four.
 */
export enum AdvancedRequestOption {
  SERVER = 1,
  PROFILE = 2,
  ROOT_FOLDER = 4,
  TAGS = 8,
}

export const ALL_ADVANCED_REQUEST_OPTIONS =
  AdvancedRequestOption.SERVER |
  AdvancedRequestOption.PROFILE |
  AdvancedRequestOption.ROOT_FOLDER |
  AdvancedRequestOption.TAGS;

/**
 * Cleans a stored or sent value: null (every option, as before the options
 * were split) or the known option bits.
 */
export const normalizeAdvancedRequestOptions = (
  value: unknown
): number | null => {
  if (value === null || value === undefined) {
    return null;
  }

  const options = Number(value);

  if (!Number.isInteger(options) || options < 0) {
    return null;
  }

  const known = options & ALL_ADVANCED_REQUEST_OPTIONS;

  // Every option is stored as null, so options added later are included
  return known === ALL_ADVANCED_REQUEST_OPTIONS ? null : known;
};

/**
 * The request options a user may choose. Managers and admins choose all of
 * them, users with Advanced Requests the ones an admin left them (all when
 * never narrowed), everyone else none.
 */
export const getAdvancedRequestOptions = (
  permissions: number,
  stored?: number | null
): number => {
  if (hasPermission(Permission.MANAGE_REQUESTS, permissions)) {
    return ALL_ADVANCED_REQUEST_OPTIONS;
  }

  if (!hasPermission(Permission.REQUEST_ADVANCED, permissions)) {
    return 0;
  }

  return stored === null || stored === undefined
    ? ALL_ADVANCED_REQUEST_OPTIONS
    : stored & ALL_ADVANCED_REQUEST_OPTIONS;
};

export const hasAdvancedRequestOption = (
  options: number,
  option: AdvancedRequestOption
): boolean => (options & option) === option;

interface RequestOptionFields {
  serverId?: number | null;
  profileId?: number | null;
  rootFolder?: string | null;
  languageProfileId?: number | null;
  tags?: number[] | null;
}

/**
 * Copies the options a user may choose from an edit onto a request. When
 * the server changes, options the user may not choose are cleared so the
 * new server's defaults are used rather than ids from the old one.
 */
export const applyAdvancedRequestOptions = (
  request: RequestOptionFields,
  body: RequestOptionFields,
  options: number,
  { languageProfile = false }: { languageProfile?: boolean } = {}
): void => {
  if (!options) {
    return;
  }

  const serverChanged =
    hasAdvancedRequestOption(options, AdvancedRequestOption.SERVER) &&
    body.serverId !== request.serverId;

  if (hasAdvancedRequestOption(options, AdvancedRequestOption.SERVER)) {
    request.serverId = body.serverId;
  }

  const apply = <K extends keyof RequestOptionFields>(
    option: AdvancedRequestOption,
    key: K
  ) => {
    if (hasAdvancedRequestOption(options, option)) {
      request[key] = body[key];
    } else if (serverChanged) {
      request[key] = null;
    }
  };

  apply(AdvancedRequestOption.PROFILE, 'profileId');
  apply(AdvancedRequestOption.ROOT_FOLDER, 'rootFolder');
  apply(AdvancedRequestOption.TAGS, 'tags');

  if (languageProfile) {
    apply(AdvancedRequestOption.PROFILE, 'languageProfileId');
  }
};
