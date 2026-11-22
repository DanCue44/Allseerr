import assert from 'node:assert/strict';
import { beforeEach, describe, it, mock } from 'node:test';

import RadarrAPI from '@server/api/servarr/radarr';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import { Notification } from '@server/lib/notifications';
import {
  buildNotFoundReason,
  findNotFoundRequests,
  getNotFoundDays,
  hasWaited,
  markRequestNotFound,
  requestNotFoundJob,
} from '@server/lib/requestNotFound';
import type {
  RadarrSettings,
  RequestNotFoundSettings,
} from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import enableRequestNotFoundAlerts from '@server/lib/settings/migrations/0017_enable_request_not_found_alerts';
import { setupTestDb } from '@server/test/db';

const sendNotificationMock = mock.method(
  MediaRequest,
  'sendNotification',
  async () => undefined
).mock;

const monitoredMock = mock.method(
  RadarrAPI.prototype,
  'setMoviesMonitored',
  async () => undefined
).mock;

setupTestDb();

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-06-01T12:00:00.000Z').getTime();

const config = (
  overrides: Partial<RequestNotFoundSettings> = {}
): RequestNotFoundSettings => ({
  enabled: true,
  unmonitor: false,
  days: { movie: 30, tv: 30, music: 30, book: 30, comic: 0 },
  ...overrides,
});

beforeEach(() => {
  sendNotificationMock.resetCalls();
  monitoredMock.resetCalls();
  getSettings().radarr = [];
  getSettings().main.requestNotFound = undefined;
});

let tmdbId = 1000;

/**
 * An approved request last changed the given days ago. Written without
 * listeners, so nothing is sent to an arr.
 */
const seedRequest = async ({
  daysAgo = 40,
  status = MediaRequestStatus.APPROVED,
  mediaStatus = MediaStatus.PROCESSING,
  type = MediaType.MOVIE,
  externalServiceId,
}: {
  daysAgo?: number;
  status?: MediaRequestStatus;
  mediaStatus?: MediaStatus;
  type?: MediaType;
  externalServiceId?: number;
} = {}): Promise<MediaRequest> => {
  const demo = await getRepository(User).findOneOrFail({
    where: { email: 'demo@seerr.dev' },
  });
  tmdbId += 1;
  const media = await getRepository(Media).save(
    new Media({
      mediaType: type,
      tmdbId,
      status: mediaStatus,
      status4k: MediaStatus.UNKNOWN,
      externalServiceId,
      serviceId: externalServiceId ? 0 : undefined,
    })
  );
  const when = new Date(NOW - daysAgo * DAY);
  const result = await getRepository(MediaRequest)
    .createQueryBuilder()
    .insert()
    .into(MediaRequest)
    .values({
      type,
      status,
      media,
      requestedBy: demo,
      is4k: false,
      createdAt: when,
      updatedAt: when,
    })
    .callListeners(false)
    .execute();

  return getRepository(MediaRequest).findOneOrFail({
    where: { id: result.identifiers[0].id },
    relations: { media: { seasons: true }, requestedBy: true, seasons: true },
  });
};

describe('getNotFoundDays', () => {
  it('reads the days of the media type, 0 when left out', () => {
    assert.equal(getNotFoundDays(config(), MediaType.MOVIE), 30);
    assert.equal(getNotFoundDays(config(), MediaType.COMIC), 0);
  });
});

describe('hasWaited', () => {
  it('counts from the last change of the request', () => {
    const request = {
      createdAt: new Date(NOW - 60 * DAY),
      updatedAt: new Date(NOW - 10 * DAY),
    };

    assert.equal(hasWaited(request, 30, NOW), false);
    assert.equal(hasWaited(request, 10, NOW), true);
    assert.equal(hasWaited(request, 0, NOW), false);
  });
});

describe('findNotFoundRequests', () => {
  it('finds an approved request that found nothing for too long', async () => {
    const request = await seedRequest();

    const found = await findNotFoundRequests(config(), NOW);

    assert.deepEqual(
      found.map((r) => r.id),
      [request.id]
    );
  });

  it('leaves out requests that are recent, pending, found or left out', async () => {
    await seedRequest({ daysAgo: 10 });
    await seedRequest({ status: MediaRequestStatus.PENDING });
    await seedRequest({ mediaStatus: MediaStatus.PARTIALLY_AVAILABLE });
    await seedRequest({ type: MediaType.COMIC });

    const found = await findNotFoundRequests(config(), NOW);

    assert.equal(found.length, 0);
  });

  it('leaves out requests already marked', async () => {
    const request = await seedRequest();
    await markRequestNotFound(request, config(), NOW);

    const found = await findNotFoundRequests(config(), NOW);

    assert.equal(found.length, 0);
  });
});

describe('markRequestNotFound', () => {
  it('marks the request, keeps it approved and tells the requester', async () => {
    const request = await seedRequest();

    await markRequestNotFound(request, config(), NOW);

    const saved = await getRepository(MediaRequest).findOneOrFail({
      where: { id: request.id },
    });
    assert.equal(saved.status, MediaRequestStatus.APPROVED);
    assert.equal(saved.notFoundAt?.getTime(), NOW);
    assert.equal(saved.notFoundReason, buildNotFoundReason(30, false));
    assert.equal(sendNotificationMock.callCount(), 1);
    assert.equal(
      sendNotificationMock.calls[0].arguments[2],
      Notification.MEDIA_NOT_FOUND
    );
    assert.equal(monitoredMock.callCount(), 0);
  });

  it('stops the search when asked to', async () => {
    getSettings().radarr = [
      {
        id: 0,
        name: 'Radarr',
        hostname: 'localhost',
        port: 7878,
        apiKey: 'key',
        useSsl: false,
        is4k: false,
        isDefault: true,
      } as RadarrSettings,
    ];
    const request = await seedRequest({ externalServiceId: 77 });

    await markRequestNotFound(request, config({ unmonitor: true }), NOW);

    assert.equal(monitoredMock.callCount(), 1);
    assert.deepEqual(monitoredMock.calls[0].arguments, [[77], false]);
    const saved = await getRepository(MediaRequest).findOneOrFail({
      where: { id: request.id },
    });
    assert.equal(saved.notFoundReason, buildNotFoundReason(30, true));
  });
});

describe('requestNotFoundJob', () => {
  it('does nothing while turned off', async () => {
    await seedRequest();

    assert.equal(await requestNotFoundJob.run(NOW), 0);
    assert.equal(sendNotificationMock.callCount(), 0);
  });

  it('marks every request due once turned on', async () => {
    await seedRequest();
    await seedRequest();
    getSettings().main.requestNotFound = config();

    assert.equal(await requestNotFoundJob.run(NOW), 2);
    assert.equal(await requestNotFoundJob.run(NOW), 0);
  });
});

describe('0017_enable_request_not_found_alerts', () => {
  it('turns the new type on where declined requests are sent, once', () => {
    const migrated = enableRequestNotFoundAlerts({
      notifications: {
        agents: {
          email: { types: 64 },
          discord: { types: 2 },
        },
      },
    });

    assert.equal(
      (migrated.notifications.agents.email.types ?? 0) &
        Notification.MEDIA_NOT_FOUND,
      Notification.MEDIA_NOT_FOUND
    );
    assert.equal(
      (migrated.notifications.agents.discord.types ?? 0) &
        Notification.MEDIA_NOT_FOUND,
      0
    );
    assert.deepEqual(migrated.migrations, [
      '0017_enable_request_not_found_alerts',
    ]);
  });
});
