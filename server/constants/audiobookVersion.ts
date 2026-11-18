import { isTalearrService } from '@server/constants/bookService';

/**
 * Which readings of an audiobook a request asks Talearr for: only the
 * unabridged one, the unabridged one by preference (the abridged one when
 * no unabridged release is found), the same two for the abridged reading,
 * or both readings as recordings of their own
 */
export type AudiobookVersion =
  | 'unabridged'
  | 'preferUnabridged'
  | 'abridged'
  | 'preferAbridged'
  | 'both';

export const AUDIOBOOK_VERSIONS: readonly AudiobookVersion[] = [
  'unabridged',
  'preferUnabridged',
  'abridged',
  'preferAbridged',
  'both',
];

/**
 * Talearr's per book grab policy for a version, null to follow its global
 * policy (both: the abridged reading is asked for as a recording of its own)
 */
export const audiobookVersionPolicy = (
  version: AudiobookVersion
):
  | 'unabridgedOnly'
  | 'preferUnabridged'
  | 'abridgedOnly'
  | 'preferAbridged'
  | null => {
  switch (version) {
    case 'unabridged':
      return 'unabridgedOnly';
    case 'preferUnabridged':
      return 'preferUnabridged';
    case 'abridged':
      return 'abridgedOnly';
    case 'preferAbridged':
      return 'preferAbridged';
    default:
      return null;
  }
};

// Whether the version wants the abridged reading, as the only, preferred or
// second reading
export const wantsAbridgedReading = (version: AudiobookVersion): boolean =>
  version === 'abridged' || version === 'preferAbridged' || version === 'both';

export const isAudiobookVersion = (value: unknown): value is AudiobookVersion =>
  typeof value === 'string' &&
  AUDIOBOOK_VERSIONS.includes(value as AudiobookVersion);

/**
 * The Audiobook Versions setting: one version for every audiobook request,
 * or `requester` to let the requester pick one per request
 */
export type AudiobookVersionsMode = AudiobookVersion | 'requester';

export const AUDIOBOOK_VERSIONS_MODES: readonly AudiobookVersionsMode[] = [
  ...AUDIOBOOK_VERSIONS,
  'requester',
];

// Both readings unless the setting says otherwise, also for settings saved
// before it existed
export const DEFAULT_AUDIOBOOK_VERSIONS_MODE: AudiobookVersionsMode = 'both';

export const isAudiobookVersionsMode = (
  value: unknown
): value is AudiobookVersionsMode =>
  typeof value === 'string' &&
  AUDIOBOOK_VERSIONS_MODES.includes(value as AudiobookVersionsMode);

/**
 * The setting in effect: it only applies with Talearr, and an unknown
 * stored value counts as the default
 */
export const getAudiobookVersionsMode = (
  bookService: string | null | undefined,
  mode: unknown
): AudiobookVersionsMode | undefined =>
  isTalearrService(bookService)
    ? isAudiobookVersionsMode(mode)
      ? mode
      : DEFAULT_AUDIOBOOK_VERSIONS_MODE
    : undefined;

// The version a requester gets when they pick none, such as from an older
// client, the same as the setting's default
export const DEFAULT_AUDIOBOOK_VERSION: AudiobookVersion = 'both';

/**
 * The version an audiobook request is sent to Talearr with: the one the
 * setting names, or with `requester` the one stored on the request, which
 * is both when the requester picked none
 */
export const resolveAudiobookVersion = (
  mode: AudiobookVersionsMode | undefined,
  requested?: string | null
): AudiobookVersion => {
  if (mode === 'requester') {
    return isAudiobookVersion(requested)
      ? requested
      : DEFAULT_AUDIOBOOK_VERSION;
  }

  return mode ?? DEFAULT_AUDIOBOOK_VERSION;
};
