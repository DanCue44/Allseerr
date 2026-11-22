import assert from 'node:assert/strict';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';

import TracearrAPI, {
  normalizeExternalId,
  tracearrMediaRef,
} from '@server/api/tracearr';
import { MediaStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { User } from '@server/entity/User';
import { Permission } from '@server/lib/permissions';
import type { TracearrSettings } from '@server/lib/settings';
import {
  TracearrUserNotFoundError,
  getTracearrMediaWatchData,
  getTracearrUserWatchData,
} from '@server/lib/tracearrWatchData';
import { setupTestDb } from '@server/test/db';

/*
 * A stand-in for Tracearr that answers with the shapes in its published
 * v2 OpenAPI document. No real Tracearr is needed to run these.
 */
const KEY = 'trr_pub_testkey';
const IDENTITY = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const JELLYFIN_GUID = 'A1B2C3D4-0000-4000-8000-00000000ABCD';

const identities = [
  {
    id: OTHER,
    username: 'someone',
    identity_name: null,
    email: null,
    plex_account_id: null,
    accounts: [
      {
        server_id: 's',
        server_type: 'jellyfin',
        server_user_id: 'u2',
        external_user_id: JELLYFIN_GUID.replace(/-/g, '').toLowerCase(),
        username: 'someone',
        removed_at: null,
      },
    ],
  },
  {
    id: IDENTITY,
    username: 'viewer',
    identity_name: 'Viewer',
    email: null,
    plex_account_id: '4242',
    accounts: [
      {
        server_id: 's',
        server_type: 'plex',
        server_user_id: 'u1',
        external_user_id: '4242',
        username: 'viewer',
        removed_at: null,
      },
    ],
  },
];

const history = [
  {
    id: 'h1',
    media_type: 'episode',
    media_title: 'Pilot',
    show_title: 'A Show',
    started_at: '2026-11-19T20:00:00Z',
    watched: true,
    media_id: null,
    show_media_id: null,
    imdb_id: null,
    tmdb_id: null,
    tvdb_id: null,
    rating_key: '9001',
    parent_rating_key: '9000',
    grandparent_rating_key: 'show-key',
  },
  {
    id: 'h2',
    media_type: 'movie',
    media_title: 'A Movie',
    show_title: null,
    started_at: '2026-11-18T20:00:00Z',
    watched: true,
    media_id: null,
    show_media_id: null,
    imdb_id: null,
    tmdb_id: 603,
    tvdb_id: null,
    rating_key: '77',
    parent_rating_key: null,
    grandparent_rating_key: null,
  },
  // The same movie again keeps one entry
  {
    id: 'h3',
    media_type: 'movie',
    media_title: 'A Movie',
    show_title: null,
    started_at: '2026-11-17T20:00:00Z',
    watched: false,
    media_id: null,
    show_media_id: null,
    imdb_id: null,
    tmdb_id: 603,
    tvdb_id: null,
    rating_key: '77',
    parent_rating_key: null,
    grandparent_rating_key: null,
  },
];

const window = (plays: number) => ({
  combined: { plays, watch_time_ms: plays * 1000, unique_users: 1 },
  per_server: [],
});

const requests: string[] = [];
let server: Server;
let settings: TracearrSettings;

const send = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

const handle = (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? '/', 'http://tracearr');
  requests.push(`${req.method} ${url.pathname}${url.search}`);

  if (req.headers.authorization !== `Bearer ${KEY}`) {
    return send(res, 401, { error: 'Invalid or missing API key' });
  }

  const path = url.pathname;

  if (path === '/base/api/v2/public/servers') {
    return send(res, 200, { data: [], tracearr_version: '3.2.1' });
  }
  if (path === '/base/api/v2/public/users') {
    // Two pages, one identity each
    const second = url.searchParams.get('cursor') === 'page2';
    return send(res, 200, {
      data: [identities[second ? 1 : 0]],
      meta: { nextCursor: second ? null : 'page2', pageSize: 100 },
    });
  }
  const identity = identities.find(
    (i) => path === `/base/api/v2/public/users/${i.id}`
  );
  if (identity) {
    return send(res, 200, identity);
  }
  if (path === `/base/api/v2/public/users/${IDENTITY}/stats`) {
    return send(res, 200, {
      user_id: IDENTITY,
      windows: {
        all_time: { plays: 42, watch_time_ms: 1 },
        last_30: { plays: 4, watch_time_ms: 1 },
        last_7: { plays: 1, watch_time_ms: 1 },
      },
      top_genres: [],
    });
  }
  if (path === `/base/api/v2/public/users/${IDENTITY}/history`) {
    return send(res, 200, {
      data: history,
      meta: { nextCursor: null, pageSize: 100 },
    });
  }
  if (path === '/base/api/v2/public/media/movie:tmdb:603/stats') {
    return send(res, 200, {
      media_id: 'm',
      media_type: 'movie',
      windows: { all_time: window(9), last_30: window(3), last_7: window(2) },
    });
  }
  if (path === '/base/api/v2/public/media/movie:tmdb:603/watchers') {
    return send(res, 200, {
      media_id: 'm',
      media_type: 'movie',
      window: 'all_time',
      watchers: [
        {
          user: {
            server_user_id: 'u1',
            user_id: IDENTITY,
            username: 'viewer',
            identity_name: 'Viewer',
          },
          plays: 5,
          watch_time_ms: 1,
          completion_pct: 100,
          last_watched_day: '2026-11-18',
        },
        {
          user: {
            server_user_id: 'u2',
            user_id: OTHER,
            username: 'someone',
            identity_name: null,
          },
          plays: 4,
          watch_time_ms: 1,
          completion_pct: 100,
          last_watched_day: '2026-11-18',
        },
      ],
    });
  }

  return send(res, 404, { error: 'Not found' });
};

before(async () => {
  server = createServer(handle);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  settings = { url: `http://127.0.0.1:${port}/base`, apiKey: KEY };
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  requests.length = 0;
});

describe('TracearrAPI', () => {
  it('tests the connection with the Bearer key', async () => {
    const result = await new TracearrAPI(settings).getServers();
    assert.equal(result.tracearr_version, '3.2.1');
  });

  it('fails with a wrong key', async () => {
    await assert.rejects(
      new TracearrAPI({ ...settings, apiKey: 'wrong' }).getServers()
    );
  });

  it('pages through identities to find an account', async () => {
    const identity = await new TracearrAPI(settings).findIdentity([4242]);
    assert.equal(identity?.id, IDENTITY);
    assert.equal(
      requests.filter((r) => r.startsWith('GET /base/api/v2/public/users'))
        .length,
      2
    );
  });

  it('matches Jellyfin ids written with dashes', async () => {
    const identity = await new TracearrAPI(settings).findIdentity([
      JELLYFIN_GUID,
    ]);
    assert.equal(identity?.id, OTHER);
  });

  it('builds media refs and normalizes ids', () => {
    assert.equal(tracearrMediaRef('movie', 603), 'movie:tmdb:603');
    assert.equal(tracearrMediaRef('tv', 1399), 'show:tmdb:1399');
    assert.equal(normalizeExternalId('AB-cd'), 'abcd');
  });
});

describe('Tracearr watch data', () => {
  setupTestDb();

  it('reads a profile play count and recently watched titles', async () => {
    const movie = await getRepository(Media).save(
      new Media({
        tmdbId: 603,
        mediaType: MediaType.MOVIE,
        status: MediaStatus.AVAILABLE,
      })
    );
    const show = await getRepository(Media).save(
      new Media({
        tmdbId: 1399,
        mediaType: MediaType.TV,
        status: MediaStatus.AVAILABLE,
        ratingKey: 'show-key',
      })
    );

    const data = await getTracearrUserWatchData(settings, {
      plexId: 4242,
      jellyfinUserId: null,
    });

    assert.equal(data.playCount, 42);
    assert.deepEqual(
      data.recentlyWatched.map((m) => m.id),
      [show.id, movie.id]
    );
  });

  it('says so when Tracearr does not know the user', async () => {
    await assert.rejects(
      getTracearrUserWatchData(settings, { plexId: 1, jellyfinUserId: null }),
      TracearrUserNotFoundError
    );
  });

  it('reads play counts and maps watchers to users', async () => {
    const plexUser = await getRepository(User).save(
      new User({
        email: 'plexviewer@example.com',
        permissions: Permission.REQUEST,
        avatar: '',
        plexId: 4242,
      })
    );
    const jellyfinUser = await getRepository(User).save(
      new User({
        email: 'jfviewer@example.com',
        permissions: Permission.REQUEST,
        avatar: '',
        jellyfinUserId: JELLYFIN_GUID,
      })
    );

    const data = await getTracearrMediaWatchData(settings, {
      mediaType: MediaType.MOVIE,
      tmdbId: 603,
    });

    assert.equal(data.data?.playCount, 9);
    assert.equal(data.data?.playCount30Days, 3);
    assert.equal(data.data?.playCount7Days, 2);
    assert.deepEqual(
      data.data?.users.map((u) => u.id).sort(),
      [plexUser.id, jellyfinUser.id].sort()
    );
  });

  it('returns nothing for a title Tracearr has never seen', async () => {
    const data = await getTracearrMediaWatchData(settings, {
      mediaType: MediaType.TV,
      tmdbId: 5,
    });
    assert.deepEqual(data, {});
  });
});
