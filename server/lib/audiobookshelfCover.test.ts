import assert from 'node:assert/strict';
import { beforeEach, describe, it, mock } from 'node:test';

import { MediaStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import {
  getAudiobookshelfCover,
  getOwnedCoverPath,
} from '@server/lib/audiobookshelfCover';
import ImageProxy from '@server/lib/imageproxy';
import { getSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';

const AUDIOBOOK_ITEM = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const EBOOK_ITEM = 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e';

setupTestDb();

beforeEach(() => {
  getSettings().audiobookshelf = {
    url: 'http://abs.test/',
    apiKey: 'read-only-key',
  };
});

const book = (extra: Partial<Media> = {}) =>
  new Media({
    olId: 'OL1234567W',
    mediaType: MediaType.BOOK,
    status: MediaStatus.AVAILABLE,
    statusAudio: MediaStatus.AVAILABLE,
    absEbookItemId: EBOOK_ITEM,
    absAudiobookItemId: AUDIOBOOK_ITEM,
    ...extra,
  });

describe('getOwnedCoverPath', () => {
  it('prefers the audiobook cover', () => {
    assert.strictEqual(
      getOwnedCoverPath(book()),
      `/imageproxy/audiobookshelf/items/${AUDIOBOOK_ITEM}/cover`
    );
  });

  it('falls back to the ebook when the audiobook is not in the library', () => {
    assert.strictEqual(
      getOwnedCoverPath(book({ statusAudio: MediaStatus.UNKNOWN })),
      `/imageproxy/audiobookshelf/items/${EBOOK_ITEM}/cover`
    );
  });

  it('is null without a library copy or an Audiobookshelf key', () => {
    assert.strictEqual(getOwnedCoverPath(undefined), null);
    assert.strictEqual(
      getOwnedCoverPath(
        book({
          status: MediaStatus.PROCESSING,
          statusAudio: MediaStatus.PROCESSING,
        })
      ),
      null
    );
    getSettings().audiobookshelf = { apiKey: '' };
    assert.strictEqual(getOwnedCoverPath(book()), null);
  });
});

describe('getAudiobookshelfCover', () => {
  it('only serves covers of items remembered for a book', async () => {
    const getImage = mock.method(
      ImageProxy.prototype,
      'getImage',
      async () => ({
        meta: {},
        imageBuffer: Buffer.from('jpeg'),
      })
    );

    try {
      await getRepository(Media).save(book());

      assert.ok(await getAudiobookshelfCover(`/items/${AUDIOBOOK_ITEM}/cover`));
      assert.strictEqual(
        getImage.mock.calls[0].arguments[0],
        `/api/items/${AUDIOBOOK_ITEM}/cover?width=600&format=jpeg`
      );

      assert.strictEqual(
        await getAudiobookshelfCover(
          '/items/c3d4e5f6-a7b8-4c9d-8e0f-1a2b3c4d5e6f/cover'
        ),
        null
      );
      assert.strictEqual(
        await getAudiobookshelfCover(`/items/${AUDIOBOOK_ITEM}/file`),
        null
      );
      assert.strictEqual(getImage.mock.callCount(), 1);
    } finally {
      getImage.mock.restore();
    }
  });
});
