import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

import MusicBrainz from '@server/api/musicbrainz';
import type { MbReleaseGroup } from '@server/api/musicbrainz/interfaces';
import OpenLibrary from '@server/api/openlibrary';
import type { OlWork } from '@server/api/openlibrary/interfaces';
import { MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import { GenreBlockedError, MediaRequest } from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import { emptyBlockedGenres } from '@server/lib/genreBlock';
import { Permission } from '@server/lib/permissions';
import { getSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';

mock.method(MediaRequest, 'sendNotification', async () => undefined);

const getAlbumMock = mock.method(
  MusicBrainz.prototype,
  'getAlbum',
  async ({ releaseGroupId }: { releaseGroupId: string }) =>
    ({
      id: releaseGroupId,
      title: 'Holiday Songs',
      'primary-type': 'Album',
      'artist-credit': [],
      genres: [{ name: 'pop', count: 3 }],
      tags: [{ name: 'christmas music', count: 2 }],
    }) as unknown as MbReleaseGroup
).mock;

mock.method(
  OpenLibrary.prototype,
  'getWork',
  async (workId: string): Promise<OlWork> => ({
    key: `/works/${workId}`,
    title: 'Ghost Stories',
    type: { key: '/type/work' },
    subjects: ['Fiction, horror', 'Ghosts'],
  })
);

setupTestDb();

afterEach(() => {
  getSettings().main.blockedGenres = emptyBlockedGenres();
});

const createUser = (email: string, permissions = Permission.REQUEST) =>
  getRepository(User).save(new User({ email, permissions, avatar: '' }));

const isGenreBlocked = (name: string) => (error: Error) =>
  error instanceof GenreBlockedError && error.message.includes(name);

describe('blocked genres for music and books', () => {
  it('refuses an album with a blocked genre or tag', async () => {
    getSettings().main.blockedGenres = {
      ...emptyBlockedGenres(),
      music: 'christmas',
    };
    const user = await createUser('music@seerr.dev');

    await assert.rejects(
      MediaRequest.request(
        { mediaId: 'album-1', mediaType: MediaType.MUSIC },
        user
      ),
      isGenreBlocked('christmas')
    );
  });

  it('looks a bulk album up only when genres are blocked', async () => {
    const user = await createUser('bulk@seerr.dev');
    getAlbumMock.resetCalls();

    await MediaRequest.request(
      { mediaId: 'album-2', mediaType: MediaType.MUSIC },
      user,
      { skipMetadataLookup: true }
    );
    assert.strictEqual(getAlbumMock.callCount(), 0);

    getSettings().main.blockedGenres = {
      ...emptyBlockedGenres(),
      music: 'christmas',
    };
    await assert.rejects(
      MediaRequest.request(
        { mediaId: 'album-3', mediaType: MediaType.MUSIC },
        user,
        { skipMetadataLookup: true }
      ),
      isGenreBlocked('christmas')
    );
    assert.strictEqual(getAlbumMock.callCount(), 1);
  });

  it('refuses a book with a blocked subject', async () => {
    getSettings().main.blockedGenres = {
      ...emptyBlockedGenres(),
      book: 'horror',
    };
    const user = await createUser('book@seerr.dev');

    await assert.rejects(
      MediaRequest.request(
        { mediaId: 'OL1W', mediaType: MediaType.BOOK },
        user
      ),
      isGenreBlocked('horror')
    );
  });

  it('lets a manager request a blocked book by hand', async () => {
    getSettings().main.blockedGenres = {
      ...emptyBlockedGenres(),
      book: 'horror',
    };
    const manager = await createUser(
      'manager@seerr.dev',
      Permission.REQUEST | Permission.MANAGE_REQUESTS
    );

    const request = await MediaRequest.request(
      { mediaId: 'OL2W', mediaType: MediaType.BOOK },
      manager
    );
    assert.ok(request.id);
  });
});
