import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  getHiddenMediaTypes,
  isResultShown,
} from '@server/lib/hiddenMediaTypes';
import { Permission } from '@server/lib/permissions';

describe('getHiddenMediaTypes', () => {
  it('hides nothing while the setting is off', () => {
    assert.deepEqual(getHiddenMediaTypes(Permission.REQUEST_MOVIE, false), []);
  });

  it('hides the types a user cannot request', () => {
    assert.deepEqual(
      getHiddenMediaTypes(
        Permission.REQUEST_MOVIE | Permission.REQUEST_TV,
        true
      ),
      ['music', 'book']
    );
  });

  it('hides nothing from a user who can request everything', () => {
    assert.deepEqual(getHiddenMediaTypes(Permission.REQUEST, true), []);
  });

  it('hides nothing from admins and request managers', () => {
    assert.deepEqual(getHiddenMediaTypes(Permission.ADMIN, true), []);
    assert.deepEqual(getHiddenMediaTypes(Permission.MANAGE_REQUESTS, true), []);
  });

  it('hides every type from a user who cannot request anything', () => {
    assert.deepEqual(getHiddenMediaTypes(Permission.VOTE, true), [
      'movie',
      'tv',
      'music',
      'book',
    ]);
  });
});

describe('isResultShown', () => {
  it('drops collections with movies and comics and authors with books', () => {
    assert.equal(isResultShown('collection', ['movie']), false);
    assert.equal(isResultShown('comic', ['book']), false);
    assert.equal(isResultShown('author', ['book']), false);
    assert.equal(isResultShown('artist', ['music']), false);
    assert.equal(isResultShown('album', ['book']), true);
  });

  it('keeps people until both movies and series are hidden', () => {
    assert.equal(isResultShown('person', ['movie']), true);
    assert.equal(isResultShown('person', ['movie', 'tv']), false);
  });
});
