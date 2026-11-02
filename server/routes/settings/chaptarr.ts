import type { TalearrIdentity } from '@server/api/servarr/chaptarr';
import ChaptarrAPI from '@server/api/servarr/chaptarr';
import { startChaptarrFullScan } from '@server/lib/scanners/chaptarr';
import type { ChaptarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { hasBookGrabPolicy } from '@server/lib/talearrAudiobookVersions';
import logger from '@server/logger';
import { Router } from 'express';

const chaptarrRoutes = Router();

chaptarrRoutes.get('/', (_req, res) => {
  const settings = getSettings();

  res.status(200).json(settings.chaptarr);
});

chaptarrRoutes.post('/', async (req, res) => {
  const settings = getSettings();

  const newChaptarr = req.body as ChaptarrSettings;
  const lastItem = settings.chaptarr[settings.chaptarr.length - 1];
  newChaptarr.id = lastItem ? lastItem.id + 1 : 0;

  // If we are setting this as the default, clear any previous defaults first
  if (req.body.isDefault) {
    settings.chaptarr.forEach((chaptarrInstance) => {
      chaptarrInstance.isDefault = false;
    });
  }

  settings.chaptarr = [...settings.chaptarr, newChaptarr];
  await settings.save();

  // Brings the library in now instead of at the nightly scan
  if (newChaptarr.syncEnabled) {
    startChaptarrFullScan('a server was added');
  }

  return res.status(201).json(newChaptarr);
});

chaptarrRoutes.post('/test', async (req, res, next) => {
  try {
    const chaptarr = new ChaptarrAPI({
      apiKey: req.body.apiKey,
      url: ChaptarrAPI.buildUrl(req.body, '/api/v1'),
    });

    const status = await chaptarr.getSystemStatus();
    const { appName, isChaptarr } = await chaptarr.getCapabilities();
    const [profiles, metadataProfiles, folders, tags, talearr] =
      await Promise.all([
        chaptarr.getChaptarrProfiles(),
        chaptarr.getMetadataProfiles(),
        chaptarr.getChaptarrRootFolders(),
        chaptarr.getTags(),
        // Talearr is a Chaptarr fork, so the server may be either one
        isChaptarr
          ? chaptarr.getTalearrIdentity()
          : Promise.resolve<TalearrIdentity>({ isTalearr: false }),
      ]);
    // Talearr's per book grab policy, which the Audiobook Versions setting
    // uses to search for the abridged reading
    const bookGrabPolicy = talearr.isTalearr
      ? await hasBookGrabPolicy(chaptarr)
      : false;

    return res.status(200).json({
      appName,
      isChaptarr,
      isTalearr: talearr.isTalearr,
      ...(talearr.isTalearr && {
        talearr: {
          version: talearr.version,
          grabPolicy: talearr.grabPolicy,
          bookGrabPolicy,
          metadataProblem: talearr.metadataProblem,
        },
      }),
      profiles: profiles.map((profile) => ({
        id: profile.id,
        name: profile.name,
        profileType: profile.profileType,
      })),
      metadataProfiles: metadataProfiles.map((profile) => ({
        id: profile.id,
        name: profile.name,
        profileType: profile.profileType,
      })),
      rootFolders: folders.map((folder) => ({
        id: folder.id,
        path: folder.path,
        folderType: folder.folderType,
        ebookQualityProfileId: folder.ebook?.qualityProfileId,
        ebookMetadataProfileId: folder.ebook?.metadataProfileId,
        audiobookQualityProfileId: folder.audiobook?.qualityProfileId,
        audiobookMetadataProfileId: folder.audiobook?.metadataProfileId,
      })),
      tags,
      urlBase: status.urlBase,
    });
  } catch (e) {
    logger.error('Failed to test Chaptarr', {
      label: 'Chaptarr',
      message: e.message,
    });

    next({ status: 500, message: 'Failed to connect to Chaptarr' });
  }
});

chaptarrRoutes.put<{ id: string }>('/:id', async (req, res) => {
  const settings = getSettings();

  const chaptarrIndex = settings.chaptarr.findIndex(
    (r) => r.id === Number(req.params.id)
  );

  if (chaptarrIndex === -1) {
    return res
      .status(404)
      .json({ status: '404', message: 'Settings instance not found' });
  }

  // If we are setting this as the default, clear any previous defaults first
  if (req.body.isDefault) {
    settings.chaptarr.forEach((chaptarrInstance) => {
      chaptarrInstance.isDefault = false;
    });
  }

  const wasSyncing = settings.chaptarr[chaptarrIndex].syncEnabled;
  settings.chaptarr[chaptarrIndex] = {
    ...req.body,
    id: Number(req.params.id),
  } as ChaptarrSettings;
  await settings.save();

  if (settings.chaptarr[chaptarrIndex].syncEnabled && !wasSyncing) {
    startChaptarrFullScan('sync was turned on');
  }

  return res.status(200).json(settings.chaptarr[chaptarrIndex]);
});

chaptarrRoutes.delete<{ id: string }>('/:id', async (req, res) => {
  const settings = getSettings();

  const chaptarrIndex = settings.chaptarr.findIndex(
    (r) => r.id === Number(req.params.id)
  );

  if (chaptarrIndex === -1) {
    return res
      .status(404)
      .json({ status: '404', message: 'Settings instance not found' });
  }

  const removed = settings.chaptarr.splice(chaptarrIndex, 1);
  await settings.save();

  return res.status(200).json(removed[0]);
});

export default chaptarrRoutes;
