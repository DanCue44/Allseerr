import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { UserType } from '@server/constants/user';
import { UserAppAccountGrant } from '@server/constants/userAccess';
import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import { UserAccessProfile } from '@server/entity/UserAccessProfile';
import { UserAppAccount } from '@server/entity/UserAppAccount';
import { defaultPlexDefaultAccess, getSettings } from '@server/lib/settings';
import { updatePerson } from '@server/lib/userAccess';
import {
  applyPlexDefaults,
  setPlexMemberSource,
} from '@server/lib/userAccess/plexDefaults';
import { setupTestDb } from '@server/test/db';

setupTestDb();

let members = new Set<number>();

const accountsOf = async (userId: number) =>
  getRepository(UserAppAccount).find({
    where: { user: { id: userId } },
    order: { app: 'ASC' },
  });

const makePlexUser = async (email: string, plexId: number): Promise<User> =>
  getRepository(User).save(
    new User({
      email,
      plexUsername: email.split('@')[0],
      plexId,
      plexToken: '',
      permissions: 32,
      avatar: '',
      userType: UserType.PLEX,
    })
  );

beforeEach(async () => {
  members = new Set<number>();
  setPlexMemberSource(async () => members);

  const settings = getSettings();
  settings.userAccess = {
    audiobookshelf: {},
    kavita: {},
    komga: {},
    grimmory: {},
    emailPasswords: false,
    oidc: { enabled: false, clients: [] },
    plexDefault: { ...defaultPlexDefaultAccess(), enabled: true },
  };

  // The seeded demo user shares the admin's Plex id; give it its own
  const demo = await getRepository(User).findOneOrFail({ where: { id: 2 } });
  demo.plexId = 1002;
  await getRepository(User).save(demo);
});

afterEach(() => {
  setPlexMemberSource(null);
});

describe('default access for Plex users', () => {
  it('gives a Plex server member every default app', async () => {
    const reader = await makePlexUser('reader@example.com', 5001);
    members.add(5001);

    const changes = await applyPlexDefaults();
    const accounts = await accountsOf(reader.id);

    assert.deepEqual(
      accounts.map((a) => [a.app, a.enabled, a.grantedBy, a.libraryIds]),
      [
        ['audiobookshelf', true, UserAppAccountGrant.PLEX, null],
        ['kavita', true, UserAppAccountGrant.PLEX, null],
        ['komga', true, UserAppAccountGrant.PLEX, null],
      ]
    );
    assert.equal(
      changes.filter((c) => c.userId === reader.id && c.change === 'granted')
        .length,
      3
    );
  });

  it('leaves people who do not share the Plex server alone', async () => {
    const stranger = await makePlexUser('stranger@example.com', 5002);

    await applyPlexDefaults();

    assert.equal((await accountsOf(stranger.id)).length, 0);
  });

  it('does nothing while it is turned off or Plex cannot be read', async () => {
    const reader = await makePlexUser('reader@example.com', 5003);
    members.add(5003);

    getSettings().userAccess = {
      ...getSettings().userAccess,
      plexDefault: { ...defaultPlexDefaultAccess(), enabled: false },
    };
    assert.deepEqual(await applyPlexDefaults(), []);

    getSettings().userAccess = {
      ...getSettings().userAccess,
      plexDefault: { ...defaultPlexDefaultAccess(), enabled: true },
    };
    setPlexMemberSource(async () => null);
    assert.deepEqual(await applyPlexDefaults(), []);
    assert.equal((await accountsOf(reader.id)).length, 0);
  });

  it('keeps an admin choice for one person over the default', async () => {
    const reader = await makePlexUser('reader@example.com', 5004);
    members.add(5004);
    await applyPlexDefaults();

    // An admin turns Kavita off for this person only
    await updatePerson(reader.id, { apps: { kavita: { enabled: false } } });
    await applyPlexDefaults();

    const kavita = (await accountsOf(reader.id)).find(
      (a) => a.app === 'kavita'
    );
    assert.equal(kavita?.enabled, false);
    assert.equal(kavita?.grantedBy, UserAppAccountGrant.ADMIN);
  });

  it('takes the default apps back from someone removed from Plex but keeps admin grants', async () => {
    const reader = await makePlexUser('reader@example.com', 5005);
    members.add(5005);
    await applyPlexDefaults();

    // Audiobookshelf was given to this person on purpose as well
    await updatePerson(reader.id, {
      apps: { audiobookshelf: { enabled: true } },
    });

    members.delete(5005);
    const changes = await applyPlexDefaults();
    const accounts = await accountsOf(reader.id);

    assert.deepEqual(
      accounts.map((a) => [a.app, a.enabled]),
      [
        ['audiobookshelf', true],
        ['kavita', false],
        ['komga', false],
      ]
    );
    assert.deepEqual(
      changes.map((c) => [c.app, c.change]),
      [
        ['kavita', 'removed'],
        ['komga', 'removed'],
      ]
    );

    // Back on the Plex server, the default apps return
    members.add(5005);
    await applyPlexDefaults();
    assert.ok((await accountsOf(reader.id)).every((a) => a.enabled));
  });

  it('only sets the default age limit for people who are not admins', async () => {
    getSettings().userAccess = {
      ...getSettings().userAccess,
      plexDefault: {
        ...defaultPlexDefaultAccess(),
        enabled: true,
        ageLimit: 'tween',
      },
    };
    const reader = await makePlexUser('reader@example.com', 5006);
    members.add(5006);

    await applyPlexDefaults();

    const profiles = await getRepository(UserAccessProfile).find({
      relations: { user: true },
    });
    const limitFor = (userId: number) =>
      profiles.find((p) => p.user.id === userId)?.ageLimit ?? null;

    // The owner (an admin) gets the apps but never an age limit
    assert.equal(limitFor(1), null);
    assert.equal(limitFor(reader.id), 'tween');
    assert.ok((await accountsOf(1)).length > 0);
  });

  it('gives no age limit when the default has none', async () => {
    const reader = await makePlexUser('reader@example.com', 5007);
    members.add(5007);

    await applyPlexDefaults();

    const profile = await getRepository(UserAccessProfile).findOne({
      where: { user: { id: reader.id } },
    });
    assert.equal(profile, null);
  });
});
