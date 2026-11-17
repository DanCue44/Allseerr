import { MAX_IMAGE_CACHE_SIZE } from '@server/lib/imageProxies';
import ImageProxy from '@server/lib/imageproxy';
import logger from '@server/logger';

// Same key and base as the /imageproxy/caa route, so warmed images land in
// the cache the route reads from
let caaProxy: ImageProxy | undefined;
const getCaaProxy = () => {
  if (!caaProxy) {
    caaProxy = new ImageProxy('caa', 'https://archive.org', {
      rateLimitOptions: { maxRequests: 4, maxRPS: 4 },
      maxCacheSize: MAX_IMAGE_CACHE_SIZE,
    });
  }
  return caaProxy;
};

const warming = new Set<string>();

/**
 * Fetches album covers into the image cache in the background, a few at a
 * time. Cover Art Archive images come from Internet Archive storage and take
 * a second or more each the first time, so shelves people are about to see
 * are warmed ahead. Covers already cached are skipped quickly.
 */
export const warmCoverArt = (urls: (string | null | undefined)[]): void => {
  const paths = [
    ...new Set(
      urls
        .filter((url): url is string => !!url)
        .filter((url) => url.startsWith('https://archive.org/'))
        .map((url) => url.replace('https://archive.org', ''))
        .filter((path) => !warming.has(path))
    ),
  ];

  if (!paths.length) {
    return;
  }

  paths.forEach((path) => warming.add(path));

  const queue = [...paths];
  let warmed = 0;
  const worker = async () => {
    for (let path = queue.shift(); path; path = queue.shift()) {
      try {
        await getCaaProxy().getImage(path);
        warmed += 1;
      } catch {
        // A missing cover is fine, the card shows a placeholder
      } finally {
        warming.delete(path);
      }
    }
  };

  Promise.all(Array.from({ length: 4 }, worker)).then(() => {
    logger.debug(`Warmed ${warmed} of ${paths.length} album cover(s)`, {
      label: 'Image Cache',
    });
  });
};
