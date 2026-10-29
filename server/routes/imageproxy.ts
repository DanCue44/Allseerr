import {
  AUDIOBOOKSHELF_IMAGE_TYPE,
  getAudiobookshelfCover,
} from '@server/lib/audiobookshelfCover';
import { getImageProxy } from '@server/lib/imageProxies';
import logger from '@server/logger';
import { Router } from 'express';

const router = Router();

router.get<{
  type: string;
  path: string[];
}>('/:type/*path', async (req, res, next) => {
  const imagePath = '/' + req.params.path.join('/');

  if (imagePath.startsWith('//') || imagePath.includes('://')) {
    logger.error('Invalid URL for image proxy', { imagePath });
    return next({ status: 403, message: 'Invalid URL for image proxy.' });
  }

  const isCover = req.params.type === AUDIOBOOKSHELF_IMAGE_TYPE;
  const proxy = isCover ? undefined : getImageProxy(req.params.type);

  if (!isCover && !proxy) {
    logger.error('Unsupported image type', {
      imagePath,
      type: req.params.type,
    });
    return next({ status: 400, message: 'Unsupported image type.' });
  }

  try {
    const imageData = isCover
      ? await getAudiobookshelfCover(imagePath)
      : await proxy?.getImage(imagePath);

    if (!imageData) {
      return next({ status: 404, message: 'Image not found.' });
    }

    res.writeHead(200, {
      'Content-Type': `image/${imageData.meta.extension}`,
      'Content-Length': imageData.imageBuffer.length,
      'Cache-Control': `public, max-age=${imageData.meta.curRevalidate}`,
      'OS-Cache-Key': imageData.meta.cacheKey,
      'OS-Cache-Status': imageData.meta.cacheMiss ? 'MISS' : 'HIT',
    });

    res.end(imageData.imageBuffer);
  } catch (e) {
    logger.error('Failed to proxy image', {
      imagePath,
      errorMessage: e.message,
    });
    if (!res.headersSent) {
      return next({ status: 500, message: 'Failed to proxy image.' });
    }
    next(e);
  }
});

export default router;
