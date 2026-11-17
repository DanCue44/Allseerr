import ImageProxy from '@server/lib/imageproxy';

export type ImageProxyType = 'tmdb' | 'tvdb' | 'caa' | 'tadb' | 'openlibrary';

const ORIGINS: Record<ImageProxyType, string> = {
  tmdb: 'https://image.tmdb.org',
  tvdb: 'https://artworks.thetvdb.com',
  caa: 'https://archive.org',
  tadb: 'https://r2.theaudiodb.com',
  openlibrary: 'https://covers.openlibrary.org',
};

const isImageProxyType = (type: string): type is ImageProxyType =>
  Object.prototype.hasOwnProperty.call(ORIGINS, type);

// Per image host, so a flood of new image paths cannot fill the config volume
export const MAX_IMAGE_CACHE_SIZE = 1024 * 1024 * 1024;

// Created on first use, once the outgoing proxy (if any) is configured
const proxies: Partial<Record<ImageProxyType, ImageProxy>> = {};

/**
 * The shared, disk cached image proxy for an image host, or undefined for an
 * unknown type
 */
export const getImageProxy = (type: string): ImageProxy | undefined => {
  if (!isImageProxyType(type)) {
    return undefined;
  }
  if (!proxies[type]) {
    proxies[type] = new ImageProxy(type, ORIGINS[type], {
      rateLimitOptions: {
        maxRequests: 20,
        maxRPS: 50,
      },
      maxCacheSize: MAX_IMAGE_CACHE_SIZE,
    });
  }
  return proxies[type];
};

/**
 * Loads an image from one of the proxied hosts through its proxy, so it is
 * cached on disk for the browser as well. Returns null for other hosts.
 */
export const getProxiedImageBuffer = async (
  url: string
): Promise<Buffer | null> => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  const type = (Object.keys(ORIGINS) as ImageProxyType[]).find(
    (key) => ORIGINS[key] === parsed.origin
  );
  if (!type) {
    return null;
  }

  const image = await getImageProxy(type)?.getImage(parsed.pathname);
  return image?.imageBuffer ?? null;
};
