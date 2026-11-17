import {
  AUDIOBOOKSHELF_IMAGE_TYPE,
  getAudiobookshelfCover,
} from '@server/lib/audiobookshelfCover';
import { getImageProxy } from '@server/lib/imageProxies';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { Router } from 'express';

const router = Router();

// Image types the browser only loads through the proxy while image caching is
// on. Music, book and Audiobookshelf covers always go through it.
const CACHE_SETTING_TYPES = ['tmdb', 'tvdb'];

const isAllowedSegment = (segment: string) =>
  segment !== '.' &&
  segment !== '..' &&
  (/^[\w.-]+$/.test(segment) ||
    /^w\d+_filter\(duotone,[\da-f]{6},[\da-f]{6}\)$/i.test(segment));

router.get<{
  type: string;
  path: string[];
}>('/:type/*path', async (req, res, next) => {
  if (
    CACHE_SETTING_TYPES.includes(req.params.type) &&
    !getSettings().main.cacheImages
  ) {
    return next({ status: 404, message: 'Image caching is disabled.' });
  }

  const joinedPath = '/' + req.params.path.join('/');

  if (joinedPath.startsWith('//') || joinedPath.includes('://')) {
    logger.error('Invalid URL for image proxy', { imagePath: joinedPath });
    return next({ status: 403, message: 'Invalid URL for image proxy.' });
  }

  const segments = joinedPath.split('/').filter((segment) => segment !== '');

  if (!segments.every(isAllowedSegment)) {
    return next({ status: 400, message: 'Invalid image path.' });
  }

  const imagePath = '/' + segments.join('/');

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
