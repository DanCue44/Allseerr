import { MediaStatus } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import type { ImageResponse } from '@server/lib/imageproxy';
import ImageProxy from '@server/lib/imageproxy';
import { getSettings } from '@server/lib/settings';

export const AUDIOBOOKSHELF_IMAGE_TYPE = 'audiobookshelf';

// Large enough for the book page, small enough for a page of cards
const COVER_QUERY = 'width=600&format=jpeg';
const COVER_PATH = /^\/items\/([0-9a-f-]{36})\/cover$/;

/**
 * Where the Audiobookshelf cover of the copy of a book in the library is
 * served, so a book looks the same here as in the apps that read the library.
 * The audiobook's cover wins, as editions of an audiobook often have their
 * own art. Null while neither format is in the library or Audiobookshelf
 * cannot be asked.
 */
export const getOwnedCoverPath = (
  media?: Pick<
    Media,
    'status' | 'statusAudio' | 'absEbookItemId' | 'absAudiobookItemId'
  > | null
): string | null => {
  const { url, apiKey } = getSettings().audiobookshelf;

  if (!media || !url || !apiKey) {
    return null;
  }

  const itemId =
    media.statusAudio === MediaStatus.AVAILABLE && media.absAudiobookItemId
      ? media.absAudiobookItemId
      : media.status === MediaStatus.AVAILABLE && media.absEbookItemId
        ? media.absEbookItemId
        : null;

  return itemId
    ? `/imageproxy/${AUDIOBOOKSHELF_IMAGE_TYPE}/items/${itemId}/cover`
    : null;
};

// Rebuilt when the Audiobookshelf address or key changes
let cached: { signature: string; proxy: ImageProxy } | undefined;

const getProxy = (): ImageProxy | undefined => {
  const { url, apiKey } = getSettings().audiobookshelf;

  if (!url || !apiKey) {
    return undefined;
  }

  const signature = `${url}\n${apiKey}`;

  if (cached?.signature !== signature) {
    cached = {
      signature,
      proxy: new ImageProxy(
        AUDIOBOOKSHELF_IMAGE_TYPE,
        url.replace(/\/+$/, ''),
        {
          headers: { Authorization: `Bearer ${apiKey}` },
          rateLimitOptions: { maxRequests: 20, maxRPS: 50 },
        }
      ),
    };
  }

  return cached.proxy;
};

/**
 * The cover of an Audiobookshelf item remembered for a book, through the
 * disk cache. Null for any other path or item, so the proxy never opens up
 * the rest of the library.
 */
export const getAudiobookshelfCover = async (
  imagePath: string
): Promise<ImageResponse | null> => {
  const itemId = COVER_PATH.exec(imagePath)?.[1];
  const proxy = getProxy();

  if (!itemId || !proxy) {
    return null;
  }

  const known = await getRepository(Media).count({
    where: [{ absAudiobookItemId: itemId }, { absEbookItemId: itemId }],
  });

  if (!known) {
    return null;
  }

  return proxy.getImage(`/api/items/${itemId}/cover?${COVER_QUERY}`);
};
