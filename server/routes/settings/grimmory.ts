import type { GrimmoryLibrary } from '@server/api/grimmory';
import GrimmoryAPI, { clearGrimmoryTokens } from '@server/api/grimmory';
import type { GrimmorySettingsResponse } from '@server/interfaces/api/settingsInterfaces';
import { clearGrimmoryLookups } from '@server/lib/grimmoryItem';
import type { GrimmorySettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { Router } from 'express';

const grimmoryRoutes = Router();

const isHttpUrl = (value: string): boolean => {
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
};

const trimmed = (value: unknown): string | undefined =>
  typeof value === 'string' ? value.trim() : undefined;

const trimmedUrl = (value: unknown): string | undefined =>
  trimmed(value)?.replace(/\/+$/, '');

/**
 * The settings without the password, only whether one is saved
 */
export const maskGrimmorySettings = ({
  password,
  ...settings
}: GrimmorySettings): GrimmorySettingsResponse => ({
  ...settings,
  passwordSet: !!password,
});

grimmoryRoutes.get('/', (_req, res) => {
  res.status(200).json(maskGrimmorySettings(getSettings().grimmory));
});

/**
 * Saves the Grimmory connection and the formats it serves. A missing
 * password keeps the saved one, an empty one removes it.
 */
grimmoryRoutes.post<never, GrimmorySettingsResponse, GrimmorySettings>(
  '/',
  async (req, res, next) => {
    const settings = getSettings();
    const url = trimmedUrl(req.body.url);
    const publicUrl = trimmedUrl(req.body.publicUrl);

    if ((url && !isHttpUrl(url)) || (publicUrl && !isHttpUrl(publicUrl))) {
      return next({ status: 400, message: 'Invalid Grimmory URL.' });
    }

    settings.grimmory = {
      ...(url !== undefined ? { url } : {}),
      ...(publicUrl !== undefined ? { publicUrl } : {}),
      ...(req.body.username !== undefined
        ? { username: trimmed(req.body.username) ?? '' }
        : {}),
      ...(typeof req.body.password === 'string'
        ? { password: req.body.password }
        : {}),
      ...(req.body.ebookLibraryId !== undefined
        ? { ebookLibraryId: trimmed(req.body.ebookLibraryId) ?? '' }
        : {}),
      ...(req.body.audiobookLibraryId !== undefined
        ? { audiobookLibraryId: trimmed(req.body.audiobookLibraryId) ?? '' }
        : {}),
      ...(typeof req.body.ebooks === 'boolean'
        ? { ebooks: req.body.ebooks }
        : {}),
      ...(typeof req.body.audiobooks === 'boolean'
        ? { audiobooks: req.body.audiobooks }
        : {}),
    };

    await settings.save();
    // Lookups made with the old settings may point elsewhere
    clearGrimmoryTokens();
    clearGrimmoryLookups();

    return res.status(200).json(maskGrimmorySettings(settings.grimmory));
  }
);

/**
 * Signs in to Grimmory and lists its libraries so they can be picked. A
 * missing password tests with the saved one.
 */
grimmoryRoutes.post<
  never,
  { version?: string; libraries: GrimmoryLibrary[] },
  { url?: string; username?: string; password?: string }
>('/test', async (req, res, next) => {
  const url = trimmedUrl(req.body.url);
  const username = trimmed(req.body.username);
  const password = req.body.password || getSettings().grimmory.password;

  if (!url || !isHttpUrl(url)) {
    return next({ status: 400, message: 'Invalid Grimmory URL.' });
  }

  if (!username || !password) {
    return next({
      status: 400,
      message: 'Add the username and password of a Grimmory user.',
    });
  }

  // A test never reuses a token signed in with other details
  clearGrimmoryTokens();
  const client = new GrimmoryAPI({ url, username, password });

  try {
    const { version } = await client.test();
    const libraries = await client.getLibraries();

    return res.status(200).json({ version, libraries });
  } catch (e) {
    logger.error('Failed to test Grimmory', {
      label: 'Grimmory',
      message: e.message,
    });

    return next({
      status: 500,
      message: 'Failed to sign in to Grimmory or list its libraries.',
    });
  }
});

export default grimmoryRoutes;
