import type ChaptarrAPI from '@server/api/servarr/chaptarr';
import type { AudiobookVersion } from '@server/constants/audiobookVersion';
import {
  audiobookVersionPolicy,
  getAudiobookVersionsMode,
  resolveAudiobookVersion,
  wantsAbridgedReading,
} from '@server/constants/audiobookVersion';
import type { MediaRequest } from '@server/entity/MediaRequest';
import type { ChaptarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';

const LABEL = 'Talearr Audiobook Versions';

// Servers already reported as having no per book grab policy, so the
// fallback is logged once per server rather than on every request
const reportedUnsupported = new Set<string>();

const serverKey = (server: ChaptarrSettings) =>
  `${server.id}:${server.hostname}:${server.port}`;

/**
 * The version an audiobook request is sent to Talearr with, from the
 * Audiobook Versions setting and the requester's pick. Undefined for
 * requests the setting does not apply to: ebooks, recording requests and
 * any book service but Talearr.
 */
export const getRequestAudiobookVersion = (
  request: Pick<MediaRequest, 'isAudiobook' | 'recording' | 'audiobookVersion'>
): AudiobookVersion | undefined => {
  const settings = getSettings();
  const mode = getAudiobookVersionsMode(
    settings.bookService,
    settings.main.audiobookVersions
  );

  if (!mode || !request.isAudiobook || request.recording) {
    return undefined;
  }

  return resolveAudiobookVersion(mode, request.audiobookVersion);
};

export interface BookGrabPolicyOutcome {
  // Whether the abridged recording still has to be asked for through the
  // recordings route: always for both, and for abridged when Talearr has no
  // per book grab policy
  abridgedRecording: boolean;
}

/**
 * Sets Talearr's grab policy of a book before it is searched for, so the
 * search finds the version asked for: unabridged or abridged only, or one of
 * them by preference. Both clears an override left from an earlier request,
 * so the book follows Talearr's global policy (the unabridged reading by
 * default) and the abridged reading is asked for as a recording of its own.
 * Without a per book policy the abridged versions fall back to the
 * recordings route.
 */
export const applyBookGrabPolicy = async (
  chaptarr: ChaptarrAPI,
  server: ChaptarrSettings,
  bookId: number,
  version: AudiobookVersion,
  requestId?: number
): Promise<BookGrabPolicyOutcome> => {
  const fallback = { abridgedRecording: wantsAbridgedReading(version) };

  try {
    const current = await chaptarr.getTalearrBookGrabPolicy(bookId);

    if (!current.supported) {
      const key = serverKey(server);

      if (!reportedUnsupported.has(key)) {
        reportedUnsupported.add(key);
        logger.info(
          'Talearr has no per book grab policy, asking for the abridged recording through the recordings route instead',
          { label: LABEL, serverId: server.id, requestId }
        );
      }

      return fallback;
    }

    const wanted = audiobookVersionPolicy(version);

    if ((current.abridgedPolicy ?? null) !== wanted) {
      const saved = await chaptarr.setTalearrBookGrabPolicy(bookId, wanted);

      if (!saved) {
        return fallback;
      }

      logger.info('Set the grab policy of the book in Talearr', {
        label: LABEL,
        requestId,
        bookId,
        abridgedPolicy: wanted ?? 'global',
      });
    }

    return { abridgedRecording: version === 'both' };
  } catch (e) {
    logger.warn('Could not set the grab policy of the book in Talearr', {
      label: LABEL,
      requestId,
      bookId,
      version,
      errorMessage: e instanceof Error ? e.message : String(e),
    });
    return fallback;
  }
};

/**
 * Whether the server has Talearr's per book grab policy, for the test
 * button. A book id Talearr does not have still tells a route it knows
 * from one it does not.
 */
export const hasBookGrabPolicy = async (
  chaptarr: ChaptarrAPI
): Promise<boolean> => {
  try {
    return (await chaptarr.getTalearrBookGrabPolicy(0)).supported;
  } catch {
    return false;
  }
};

// For tests, so each one sees the first fallback log again
export const resetReportedUnsupported = (): void => reportedUnsupported.clear();
