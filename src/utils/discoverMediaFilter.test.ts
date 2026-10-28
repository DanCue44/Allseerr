import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DiscoverSliderType } from '@server/constants/discover';
import {
  getSliderMediaKind,
  getSliderPlacements,
  isHomeSlider,
  isSliderInDiscoverFilter,
  selectComicsPageSliders,
  selectDiscoverSliders,
  selectHomeSliders,
} from './discoverMediaFilter';

describe('getSliderMediaKind', () => {
  it('maps every slider type to a media kind', () => {
    const expected: Record<DiscoverSliderType, string> = {
      [DiscoverSliderType.RECENTLY_ADDED]: 'mixed',
      [DiscoverSliderType.RECENT_REQUESTS]: 'mixed',
      [DiscoverSliderType.PLEX_WATCHLIST]: 'mixed',
      [DiscoverSliderType.TRENDING]: 'mixed',
      [DiscoverSliderType.POPULAR_MOVIES]: 'movie',
      [DiscoverSliderType.MOVIE_GENRES]: 'movie',
      [DiscoverSliderType.UPCOMING_MOVIES]: 'movie',
      [DiscoverSliderType.STUDIOS]: 'movie',
      [DiscoverSliderType.POPULAR_TV]: 'tv',
      [DiscoverSliderType.TV_GENRES]: 'tv',
      [DiscoverSliderType.UPCOMING_TV]: 'tv',
      [DiscoverSliderType.NETWORKS]: 'tv',
      [DiscoverSliderType.TMDB_MOVIE_KEYWORD]: 'movie',
      [DiscoverSliderType.TMDB_MOVIE_GENRE]: 'movie',
      [DiscoverSliderType.TMDB_TV_KEYWORD]: 'tv',
      [DiscoverSliderType.TMDB_TV_GENRE]: 'tv',
      [DiscoverSliderType.TMDB_SEARCH]: 'mixed',
      [DiscoverSliderType.TMDB_STUDIO]: 'movie',
      [DiscoverSliderType.TMDB_NETWORK]: 'tv',
      [DiscoverSliderType.TMDB_MOVIE_STREAMING_SERVICES]: 'movie',
      [DiscoverSliderType.TMDB_TV_STREAMING_SERVICES]: 'tv',
      [DiscoverSliderType.POPULAR_MUSIC]: 'music',
      [DiscoverSliderType.NEW_MUSIC]: 'music',
      [DiscoverSliderType.TRENDING_BOOKS]: 'book',
      [DiscoverSliderType.POPULAR_BOOKS]: 'book',
      [DiscoverSliderType.COMING_UP]: 'mixed',
      [DiscoverSliderType.BOOK_SUBJECT]: 'book',
      [DiscoverSliderType.TRENDING_COMICS]: 'mixed',
      [DiscoverSliderType.POPULAR_MANGA]: 'comic',
      [DiscoverSliderType.NEW_MANGA]: 'comic',
      [DiscoverSliderType.POPULAR_COMICS]: 'comic',
    };

    for (const [type, kind] of Object.entries(expected)) {
      assert.equal(
        getSliderMediaKind(Number(type) as DiscoverSliderType),
        kind,
        `slider type ${type}`
      );
    }
  });
});

describe('isSliderInDiscoverFilter', () => {
  it('shows everything on All', () => {
    assert.ok(isSliderInDiscoverFilter(DiscoverSliderType.TMDB_SEARCH, 'all'));
    assert.ok(isSliderInDiscoverFilter(DiscoverSliderType.NEW_MUSIC, 'all'));
  });

  it('keeps sliders of the picked type only', () => {
    assert.ok(isSliderInDiscoverFilter(DiscoverSliderType.STUDIOS, 'movie'));
    assert.ok(!isSliderInDiscoverFilter(DiscoverSliderType.STUDIOS, 'tv'));
    assert.ok(isSliderInDiscoverFilter(DiscoverSliderType.NEW_MUSIC, 'music'));
    assert.ok(
      !isSliderInDiscoverFilter(DiscoverSliderType.POPULAR_BOOKS, 'music')
    );
  });

  it('narrows the mixed sliders that can be narrowed', () => {
    for (const filter of ['movie', 'tv', 'music', 'book'] as const) {
      assert.ok(
        isSliderInDiscoverFilter(DiscoverSliderType.RECENTLY_ADDED, filter)
      );
      assert.ok(
        isSliderInDiscoverFilter(DiscoverSliderType.RECENT_REQUESTS, filter)
      );
      assert.ok(
        isSliderInDiscoverFilter(DiscoverSliderType.PLEX_WATCHLIST, filter)
      );
      assert.ok(
        !isSliderInDiscoverFilter(DiscoverSliderType.TMDB_SEARCH, filter)
      );
    }
  });

  it('only keeps trending for movies and series', () => {
    assert.ok(isSliderInDiscoverFilter(DiscoverSliderType.TRENDING, 'movie'));
    assert.ok(isSliderInDiscoverFilter(DiscoverSliderType.TRENDING, 'tv'));
    assert.ok(!isSliderInDiscoverFilter(DiscoverSliderType.TRENDING, 'music'));
    assert.ok(!isSliderInDiscoverFilter(DiscoverSliderType.TRENDING, 'book'));
  });
});

describe('selectDiscoverSliders', () => {
  const sliders = [
    {
      id: 1,
      type: DiscoverSliderType.RECENTLY_ADDED,
      enabled: true,
      isBuiltIn: true,
    },
    {
      id: 2,
      type: DiscoverSliderType.TRENDING,
      enabled: false,
      isBuiltIn: true,
    },
    {
      id: 3,
      type: DiscoverSliderType.POPULAR_MOVIES,
      enabled: true,
      isBuiltIn: true,
    },
    {
      id: 4,
      type: DiscoverSliderType.UPCOMING_MOVIES,
      enabled: false,
      isBuiltIn: true,
    },
    {
      id: 5,
      type: DiscoverSliderType.POPULAR_TV,
      enabled: true,
      isBuiltIn: true,
    },
    {
      id: 6,
      type: DiscoverSliderType.TMDB_MOVIE_GENRE,
      enabled: false,
      isBuiltIn: false,
    },
    {
      id: 7,
      type: DiscoverSliderType.TMDB_MOVIE_KEYWORD,
      enabled: true,
      isBuiltIn: false,
    },
    {
      id: 8,
      type: DiscoverSliderType.PLEX_WATCHLIST,
      enabled: false,
      isBuiltIn: true,
    },
    {
      id: 9,
      type: DiscoverSliderType.TMDB_SEARCH,
      enabled: true,
      isBuiltIn: false,
    },
    {
      id: 10,
      type: DiscoverSliderType.NEW_MUSIC,
      enabled: true,
      isBuiltIn: true,
    },
    {
      id: 11,
      type: DiscoverSliderType.COMING_UP,
      enabled: true,
      isBuiltIn: true,
    },
  ];
  const ids = (filter: Parameters<typeof selectDiscoverSliders>[1]) =>
    selectDiscoverSliders(sliders, filter).map((slider) => slider.id);

  it('shows the enabled sliders on All', () => {
    assert.deepEqual(ids('all'), [1, 3, 5, 7, 9, 10, 11]);
  });

  it('gives a space its enabled sliders, in order', () => {
    assert.deepEqual(ids('movie'), [1, 3, 7]);
    assert.deepEqual(ids('tv'), [1, 5]);
    assert.deepEqual(ids('music'), [1, 10]);
    assert.deepEqual(ids('book'), [1]);
  });

  it('keeps built-in rows an admin hid out of the spaces', () => {
    // Trending (2) and Upcoming Movies (4) are hidden in Customize Discover
    assert.ok(!ids('movie').includes(2));
    assert.ok(!ids('movie').includes(4));
    assert.ok(!ids('tv').includes(2));
  });

  it('skips sliders without a type', () => {
    assert.deepEqual(selectDiscoverSliders([{ enabled: true }], 'all'), []);
  });

  it('fills the For You home with the mixed and custom sliders', () => {
    assert.deepEqual(
      selectHomeSliders(sliders).map((slider) => slider.id),
      [1, 7, 9, 11]
    );
  });
});

describe('getSliderPlacements', () => {
  it('places mixed rows on the home and the spaces they narrow to', () => {
    assert.deepEqual(
      getSliderPlacements({
        type: DiscoverSliderType.RECENTLY_ADDED,
        isBuiltIn: true,
      }),
      ['all', 'movie', 'tv', 'music', 'book']
    );
    assert.deepEqual(
      getSliderPlacements({
        type: DiscoverSliderType.TRENDING,
        isBuiltIn: true,
      }),
      ['all', 'movie', 'tv']
    );
    assert.deepEqual(
      getSliderPlacements({
        type: DiscoverSliderType.COMING_UP,
        isBuiltIn: true,
      }),
      ['all']
    );
  });

  it('places built-in type rows in their space only', () => {
    assert.deepEqual(
      getSliderPlacements({
        type: DiscoverSliderType.STUDIOS,
        isBuiltIn: true,
      }),
      ['movie']
    );
    assert.deepEqual(
      getSliderPlacements({
        type: DiscoverSliderType.POPULAR_BOOKS,
        isBuiltIn: true,
      }),
      ['book']
    );
  });

  it('keeps custom type rows on the home as well', () => {
    assert.deepEqual(
      getSliderPlacements({
        type: DiscoverSliderType.TMDB_TV_KEYWORD,
        isBuiltIn: false,
      }),
      ['all', 'tv']
    );
  });

  it('shows book subject rows on the home and in the books space', () => {
    assert.deepEqual(
      getSliderPlacements({
        type: DiscoverSliderType.BOOK_SUBJECT,
        isBuiltIn: false,
      }),
      ['all', 'book']
    );
  });
});

describe('comic sliders', () => {
  const comicTypes = [
    DiscoverSliderType.POPULAR_MANGA,
    DiscoverSliderType.NEW_MANGA,
    DiscoverSliderType.POPULAR_COMICS,
  ];

  it('keeps the comic rows out of the books space and the home', () => {
    for (const type of comicTypes) {
      assert.ok(!isSliderInDiscoverFilter(type, 'book'), `type ${type}`);
      assert.ok(!isHomeSlider({ type, isBuiltIn: true }), `type ${type}`);
    }
    assert.ok(
      !isSliderInDiscoverFilter(DiscoverSliderType.TRENDING_COMICS, 'book')
    );
  });

  it('shows trending comics on the home', () => {
    assert.ok(
      isHomeSlider({
        type: DiscoverSliderType.TRENDING_COMICS,
        isBuiltIn: true,
      })
    );
  });

  it('picks the enabled comic rows for the comics page, in order', () => {
    const sliders = [
      { id: 1, type: DiscoverSliderType.TRENDING_BOOKS, enabled: true },
      { id: 2, type: DiscoverSliderType.TRENDING_COMICS, enabled: true },
      { id: 3, type: DiscoverSliderType.POPULAR_MANGA, enabled: true },
      { id: 4, type: DiscoverSliderType.NEW_MANGA, enabled: false },
      { id: 5, type: DiscoverSliderType.POPULAR_COMICS, enabled: true },
      { id: 6, type: DiscoverSliderType.TRENDING, enabled: true },
    ];

    assert.deepEqual(
      selectComicsPageSliders(sliders).map((slider) => slider.id),
      [2, 3, 5]
    );
  });

  it('labels where the comic rows show', () => {
    assert.deepEqual(
      getSliderPlacements({
        type: DiscoverSliderType.TRENDING_COMICS,
        isBuiltIn: true,
      }),
      ['all', 'comics']
    );
    assert.deepEqual(
      getSliderPlacements({
        type: DiscoverSliderType.POPULAR_COMICS,
        isBuiltIn: true,
      }),
      ['comics']
    );
  });
});
