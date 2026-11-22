import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  emptyBlockedGenres,
  findBlockedGenres,
  getEffectiveBlockedGenres,
  normalizeBlockedGenres,
} from './genreBlock';

describe('normalizeBlockedGenres', () => {
  it('keeps ids for movies and series and lowercased names otherwise', () => {
    assert.deepStrictEqual(
      normalizeBlockedGenres({
        movie: '27, 10749,abc,27',
        tv: '16|0',
        music: ' Christmas ,Black Metal',
        book: 42,
      }),
      { movie: '27,10749', tv: '16', music: 'christmas,black metal', book: '' }
    );
  });

  it('refuses anything that is not an object', () => {
    assert.strictEqual(normalizeBlockedGenres('27'), null);
    assert.strictEqual(normalizeBlockedGenres(null), null);
    assert.strictEqual(normalizeBlockedGenres([]), null);
  });
});

describe('getEffectiveBlockedGenres', () => {
  const server = { ...emptyBlockedGenres(), movie: '27' };

  it("follows the server's list without a list of the user's own", () => {
    assert.deepStrictEqual(getEffectiveBlockedGenres(null, server), server);
  });

  it("uses the user's own list, even an empty one", () => {
    assert.deepStrictEqual(
      getEffectiveBlockedGenres(JSON.stringify(emptyBlockedGenres()), server),
      emptyBlockedGenres()
    );
  });
});

describe('findBlockedGenres', () => {
  const blocked = {
    movie: '27',
    tv: '16',
    music: 'christmas,metal',
    book: 'horror',
  };

  it('matches movies and series by TMDB genre id', () => {
    const genres = [
      { id: 27, name: 'Horror' },
      { id: 16, name: 'Animation' },
    ];

    assert.deepStrictEqual(findBlockedGenres('movie', genres, blocked), [
      'Horror',
    ]);
    assert.deepStrictEqual(findBlockedGenres('tv', genres, blocked), [
      'Animation',
    ]);
  });

  it('matches music and book names as whole words', () => {
    assert.deepStrictEqual(
      findBlockedGenres('music', ['Black Metal', 'rock'], blocked),
      ['metal']
    );
    assert.deepStrictEqual(
      findBlockedGenres('music', ['metalcore'], blocked),
      []
    );
    assert.deepStrictEqual(
      findBlockedGenres('book', ['Fiction, horror', 'Ghost stories'], blocked),
      ['horror']
    );
  });

  it('blocks nothing with an empty list or no genres', () => {
    assert.deepStrictEqual(
      findBlockedGenres('movie', [{ id: 27, name: 'Horror' }], {
        ...blocked,
        movie: '',
      }),
      []
    );
    assert.deepStrictEqual(findBlockedGenres('book', undefined, blocked), []);
  });
});
