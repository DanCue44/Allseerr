import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Permission } from '@server/lib/permissions';
import {
  ALL_ADVANCED_REQUEST_OPTIONS,
  AdvancedRequestOption,
  applyAdvancedRequestOptions,
  getAdvancedRequestOptions,
  normalizeAdvancedRequestOptions,
} from './advancedRequestOptions';

const advanced = Permission.REQUEST | Permission.REQUEST_ADVANCED;

describe('getAdvancedRequestOptions', () => {
  it('gives every option to existing Advanced Requests users', () => {
    assert.strictEqual(
      getAdvancedRequestOptions(advanced, null),
      ALL_ADVANCED_REQUEST_OPTIONS
    );
  });

  it('narrows to the stored options', () => {
    assert.strictEqual(
      getAdvancedRequestOptions(advanced, AdvancedRequestOption.TAGS),
      AdvancedRequestOption.TAGS
    );
  });

  it('gives none without Advanced Requests and all to managers', () => {
    assert.strictEqual(
      getAdvancedRequestOptions(Permission.REQUEST, AdvancedRequestOption.TAGS),
      0
    );
    assert.strictEqual(
      getAdvancedRequestOptions(Permission.MANAGE_REQUESTS, 0),
      ALL_ADVANCED_REQUEST_OPTIONS
    );
  });
});

describe('normalizeAdvancedRequestOptions', () => {
  it('stores every option as null and drops unknown bits', () => {
    assert.strictEqual(
      normalizeAdvancedRequestOptions(ALL_ADVANCED_REQUEST_OPTIONS),
      null
    );
    assert.strictEqual(normalizeAdvancedRequestOptions(2 | 64), 2);
    assert.strictEqual(normalizeAdvancedRequestOptions(0), 0);
    assert.strictEqual(normalizeAdvancedRequestOptions('x'), null);
  });
});

describe('applyAdvancedRequestOptions', () => {
  const stored = () => ({
    serverId: 1,
    profileId: 5,
    rootFolder: '/stored',
    languageProfileId: 2,
    tags: [6],
  });
  const body = {
    serverId: 2,
    profileId: 9,
    rootFolder: '/chosen',
    languageProfileId: 4,
    tags: [3],
  };

  it('changes only the allowed options', () => {
    const request = stored();
    applyAdvancedRequestOptions(
      request,
      body,
      AdvancedRequestOption.ROOT_FOLDER
    );
    assert.deepStrictEqual(request, { ...stored(), rootFolder: '/chosen' });
  });

  it('clears what the user cannot pick when the server changes', () => {
    const request = stored();
    applyAdvancedRequestOptions(request, body, AdvancedRequestOption.SERVER, {
      languageProfile: true,
    });
    assert.deepStrictEqual(request, {
      serverId: 2,
      profileId: null,
      rootFolder: null,
      languageProfileId: null,
      tags: null,
    });
  });

  it('changes nothing without options', () => {
    const request = stored();
    applyAdvancedRequestOptions(request, body, 0);
    assert.deepStrictEqual(request, stored());
  });
});
