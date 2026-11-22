import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { UserType } from '@server/constants/user';
import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import {
  oidcSubjectKey,
  openLoginState,
  profileFromClaims,
  resolveOidcLoginUser,
  sealLoginState,
} from '@server/lib/oidcLogin';
import type { OidcLoginSettings } from '@server/lib/settings';
import { defaultOidcLoginSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';

setupTestDb();

const ISSUER = 'https://auth.example.com/application/o/allseerr/';

let settings: OidcLoginSettings;

beforeEach(() => {
  settings = {
    ...defaultOidcLoginSettings(),
    enabled: true,
    issuerUrl: ISSUER,
    clientId: 'allseerr',
  };
});

const withSubject = (email: string) =>
  getRepository(User)
    .createQueryBuilder('user')
    .addSelect('user.oidcSubject')
    .where('user.email = :email', { email })
    .getOneOrFail();

describe('profileFromClaims', () => {
  it('maps the standard claims', () => {
    assert.deepEqual(
      profileFromClaims({
        sub: 'abc-123',
        email: ' Reader@Example.com ',
        email_verified: true,
        preferred_username: 'reader',
        name: 'Avid Reader',
        picture: 'https://auth.example.com/avatar.png',
      }),
      {
        subject: 'abc-123',
        email: 'reader@example.com',
        emailVerified: true,
        username: 'reader',
        displayName: 'Avid Reader',
        picture: 'https://auth.example.com/avatar.png',
      }
    );
  });

  it('falls back to the nickname and the given and family names', () => {
    const profile = profileFromClaims({
      sub: 'abc',
      nickname: 'nick',
      given_name: 'Ada',
      family_name: 'Lovelace',
    });

    assert.equal(profile?.username, 'nick');
    assert.equal(profile?.displayName, 'Ada Lovelace');
    assert.equal(profile?.email, undefined);
    assert.equal(profile?.emailVerified, undefined);
  });

  it('reads email_verified sent as a string', () => {
    assert.equal(
      profileFromClaims({ sub: 'a', email_verified: 'false' })?.emailVerified,
      false
    );
    assert.equal(
      profileFromClaims({ sub: 'a', email_verified: 'true' })?.emailVerified,
      true
    );
  });

  it('drops an invalid email address and a picture that is not a web address', () => {
    const profile = profileFromClaims({
      sub: 'a',
      email: 'not-an-email',
      picture: 'javascript:alert(1)',
    });

    assert.equal(profile?.email, undefined);
    assert.equal(profile?.picture, undefined);
  });

  it('needs a subject', () => {
    assert.equal(profileFromClaims({ email: 'a@example.com' }), null);
    assert.equal(profileFromClaims({ sub: '  ' }), null);
    assert.equal(profileFromClaims({ sub: 42 }), null);
  });
});

describe('oidcSubjectKey', () => {
  it('keeps subjects of different issuers apart and ignores a trailing slash', () => {
    assert.equal(
      oidcSubjectKey('https://a.example.com/', 'x'),
      oidcSubjectKey('https://a.example.com', 'x')
    );
    assert.notEqual(
      oidcSubjectKey('https://a.example.com', 'x'),
      oidcSubjectKey('https://b.example.com', 'x')
    );
  });
});

describe('resolveOidcLoginUser', () => {
  it('links the account with the same email address on a first sign in', async () => {
    const result = await resolveOidcLoginUser(
      { subject: 'sub-1', email: 'demo@seerr.dev', emailVerified: true },
      settings,
      32
    );

    assert.ok('user' in result);
    assert.equal(result.outcome, 'matched');
    assert.equal(result.user.email, 'demo@seerr.dev');
    assert.equal(
      (await withSubject('demo@seerr.dev')).oidcSubject,
      oidcSubjectKey(ISSUER, 'sub-1')
    );
  });

  it('finds the linked account by subject even after the email changes', async () => {
    await resolveOidcLoginUser(
      { subject: 'sub-1', email: 'demo@seerr.dev' },
      settings,
      32
    );

    const result = await resolveOidcLoginUser(
      { subject: 'sub-1', email: 'new-address@example.com' },
      settings,
      32
    );

    assert.ok('user' in result);
    assert.equal(result.outcome, 'linked');
    assert.equal(result.user.email, 'demo@seerr.dev');
  });

  it('does not match an address the provider says is not verified', async () => {
    const result = await resolveOidcLoginUser(
      { subject: 'sub-1', email: 'demo@seerr.dev', emailVerified: false },
      settings,
      32
    );

    assert.deepEqual(result, { error: 'no-account' });
  });

  it('does not match by email when that is off', async () => {
    settings.matchByEmail = false;

    const result = await resolveOidcLoginUser(
      { subject: 'sub-1', email: 'demo@seerr.dev', emailVerified: true },
      settings,
      32
    );

    assert.deepEqual(result, { error: 'no-account' });
  });

  it('will not move an account linked to another subject', async () => {
    await resolveOidcLoginUser(
      { subject: 'sub-1', email: 'demo@seerr.dev' },
      settings,
      32
    );

    const result = await resolveOidcLoginUser(
      { subject: 'sub-2', email: 'demo@seerr.dev' },
      settings,
      32
    );

    assert.deepEqual(result, { error: 'already-linked' });
  });

  it('refuses people with no account while making accounts is off', async () => {
    const result = await resolveOidcLoginUser(
      { subject: 'sub-9', email: 'stranger@example.com' },
      settings,
      32
    );

    assert.deepEqual(result, { error: 'no-account' });
    assert.equal(
      await getRepository(User).count({
        where: { email: 'stranger@example.com' },
      }),
      0
    );
  });

  it('makes an account with the default permissions when that is on', async () => {
    settings.autoCreateUsers = true;

    const result = await resolveOidcLoginUser(
      {
        subject: 'sub-9',
        email: 'stranger@example.com',
        username: 'stranger',
        picture: 'https://auth.example.com/a.png',
      },
      settings,
      32
    );

    assert.ok('user' in result);
    assert.equal(result.outcome, 'created');

    const user = await withSubject('stranger@example.com');
    assert.equal(user.username, 'stranger');
    assert.equal(user.permissions, 32);
    assert.equal(user.userType, UserType.LOCAL);
    assert.equal(user.avatar, 'https://auth.example.com/a.png');
    assert.equal(user.oidcSubject, oidcSubjectKey(ISSUER, 'sub-9'));
  });

  it('needs an email address to make an account', async () => {
    settings.autoCreateUsers = true;

    assert.deepEqual(
      await resolveOidcLoginUser({ subject: 'sub-9' }, settings, 32),
      { error: 'missing-email' }
    );
  });

  it('does not make a second account for a taken address', async () => {
    settings.autoCreateUsers = true;
    settings.matchByEmail = false;

    assert.deepEqual(
      await resolveOidcLoginUser(
        { subject: 'sub-9', email: 'demo@seerr.dev' },
        settings,
        32
      ),
      { error: 'email-taken' }
    );
  });
});

describe('login state cookie', () => {
  const data = { state: 's', verifier: 'v', nonce: 'n', at: 1_000_000 };

  it('opens what it sealed', () => {
    assert.deepEqual(
      openLoginState(sealLoginState(data, 'secret'), 'secret', 1_000_001),
      data
    );
  });

  it('refuses a changed or foreign cookie', () => {
    const sealed = sealLoginState(data, 'secret');
    const [, signature] = sealed.split('.');
    const forged = `${Buffer.from(
      JSON.stringify({ ...data, state: 'other' })
    ).toString('base64url')}.${signature}`;

    assert.equal(openLoginState(forged, 'secret', 1_000_001), null);
    assert.equal(openLoginState(sealed, 'other-secret', 1_000_001), null);
    assert.equal(openLoginState('garbage', 'secret'), null);
    assert.equal(openLoginState(undefined, 'secret'), null);
  });

  it('expires after ten minutes', () => {
    const sealed = sealLoginState(data, 'secret');

    assert.equal(
      openLoginState(sealed, 'secret', data.at + 11 * 60 * 1000),
      null
    );
  });
});
