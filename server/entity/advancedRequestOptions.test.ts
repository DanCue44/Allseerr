import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

import MusicBrainz from '@server/api/musicbrainz';
import type { MbReleaseGroup } from '@server/api/musicbrainz/interfaces';
import { MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import { MediaRequest } from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import { AdvancedRequestOption } from '@server/lib/advancedRequestOptions';
import { Permission } from '@server/lib/permissions';
import { setupTestDb } from '@server/test/db';

mock.method(MediaRequest, 'sendNotification', async () => undefined);

mock.method(
  MusicBrainz.prototype,
  'getAlbum',
  async ({ releaseGroupId }: { releaseGroupId: string }) =>
    ({
      id: releaseGroupId,
      title: 'OK Computer',
      'primary-type': 'Album',
      'artist-credit': [],
    }) as unknown as MbReleaseGroup
);

setupTestDb();

const options = { serverId: 2, profileId: 9, rootFolder: '/chosen', tags: [3] };

const requestAlbum = async (
  email: string,
  permissions: number,
  advancedRequestOptions: number | null = null
) => {
  const user = await getRepository(User).save(
    new User({ email, permissions, avatar: '', advancedRequestOptions })
  );

  return MediaRequest.request(
    { mediaId: `album-${email}`, mediaType: MediaType.MUSIC, ...options },
    user
  );
};

const stored = (request: MediaRequest) => ({
  serverId: request.serverId ?? null,
  profileId: request.profileId ?? null,
  rootFolder: request.rootFolder ?? null,
  tags: request.tags ?? null,
});

describe('advanced options on music requests', () => {
  it('ignores options from a regular requester', async () => {
    const request = await requestAlbum('regular@seerr.dev', Permission.REQUEST);

    assert.deepStrictEqual(stored(request), {
      serverId: null,
      profileId: null,
      rootFolder: null,
      tags: null,
    });
  });

  it('keeps every option for Advanced Requests', async () => {
    const request = await requestAlbum(
      'advanced@seerr.dev',
      Permission.REQUEST | Permission.REQUEST_ADVANCED
    );

    assert.deepStrictEqual(stored(request), options);
  });

  it('keeps only the options an admin left the user', async () => {
    const request = await requestAlbum(
      'narrow@seerr.dev',
      Permission.REQUEST | Permission.REQUEST_ADVANCED,
      AdvancedRequestOption.SERVER | AdvancedRequestOption.ROOT_FOLDER
    );

    assert.deepStrictEqual(stored(request), {
      serverId: 2,
      profileId: null,
      rootFolder: '/chosen',
      tags: null,
    });
  });
});
