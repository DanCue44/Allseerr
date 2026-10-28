import type DiscoverSlider from '@server/entity/DiscoverSlider';

export enum DiscoverSliderType {
  RECENTLY_ADDED = 1,
  RECENT_REQUESTS,
  PLEX_WATCHLIST,
  TRENDING,
  POPULAR_MOVIES,
  MOVIE_GENRES,
  UPCOMING_MOVIES,
  STUDIOS,
  POPULAR_TV,
  TV_GENRES,
  UPCOMING_TV,
  NETWORKS,
  TMDB_MOVIE_KEYWORD,
  TMDB_MOVIE_GENRE,
  TMDB_TV_KEYWORD,
  TMDB_TV_GENRE,
  TMDB_SEARCH,
  TMDB_STUDIO,
  TMDB_NETWORK,
  TMDB_MOVIE_STREAMING_SERVICES,
  TMDB_TV_STREAMING_SERVICES,
  POPULAR_MUSIC = 22,
  NEW_MUSIC = 23,
  TRENDING_BOOKS = 24,
  POPULAR_BOOKS,
  COMING_UP,
  // Books on an OpenLibrary subject an admin picks, the key is in `data`
  BOOK_SUBJECT = 27,
  // Trending manga and popular comics from Talearr, on the For You home
  TRENDING_COMICS = 28,
  POPULAR_MANGA,
  NEW_MANGA,
  POPULAR_COMICS,
  // What the signed-in person is part way through on the media server
  CONTINUE_WATCHING = 32,
}

export const defaultSliders: Partial<DiscoverSlider>[] = [
  {
    type: DiscoverSliderType.CONTINUE_WATCHING,
    enabled: true,
    isBuiltIn: true,
    order: 0,
  },
  {
    type: DiscoverSliderType.RECENTLY_ADDED,
    enabled: true,
    isBuiltIn: true,
    order: 0,
  },
  {
    type: DiscoverSliderType.RECENT_REQUESTS,
    enabled: true,
    isBuiltIn: true,
    order: 1,
  },
  {
    type: DiscoverSliderType.PLEX_WATCHLIST,
    enabled: true,
    isBuiltIn: true,
    order: 2,
  },
  {
    type: DiscoverSliderType.TRENDING,
    enabled: true,
    isBuiltIn: true,
    order: 3,
  },
  {
    type: DiscoverSliderType.POPULAR_MOVIES,
    enabled: true,
    isBuiltIn: true,
    order: 4,
  },
  {
    type: DiscoverSliderType.MOVIE_GENRES,
    enabled: true,
    isBuiltIn: true,
    order: 5,
  },
  {
    type: DiscoverSliderType.UPCOMING_MOVIES,
    enabled: true,
    isBuiltIn: true,
    order: 6,
  },
  {
    type: DiscoverSliderType.STUDIOS,
    enabled: true,
    isBuiltIn: true,
    order: 7,
  },
  {
    type: DiscoverSliderType.POPULAR_TV,
    enabled: true,
    isBuiltIn: true,
    order: 8,
  },
  {
    type: DiscoverSliderType.TV_GENRES,
    enabled: true,
    isBuiltIn: true,
    order: 9,
  },
  {
    type: DiscoverSliderType.UPCOMING_TV,
    enabled: true,
    isBuiltIn: true,
    order: 10,
  },
  {
    type: DiscoverSliderType.NETWORKS,
    enabled: true,
    isBuiltIn: true,
    order: 11,
  },
  {
    type: DiscoverSliderType.POPULAR_MUSIC,
    enabled: true,
    isBuiltIn: true,
    order: 12,
  },
  {
    type: DiscoverSliderType.NEW_MUSIC,
    enabled: true,
    isBuiltIn: true,
    order: 13,
  },
  // Shown only once LazyLibrarian is configured
  {
    type: DiscoverSliderType.TRENDING_BOOKS,
    enabled: true,
    isBuiltIn: true,
    order: 14,
  },
  {
    type: DiscoverSliderType.POPULAR_BOOKS,
    enabled: true,
    isBuiltIn: true,
    order: 15,
  },
  // Upcoming movies, episodes and albums from the release calendar
  {
    type: DiscoverSliderType.COMING_UP,
    enabled: true,
    isBuiltIn: true,
    order: 16,
  },
  // Comic and manga rows, shown only while Talearr's comics library is on
  {
    type: DiscoverSliderType.TRENDING_COMICS,
    enabled: true,
    isBuiltIn: true,
    order: 17,
  },
  {
    type: DiscoverSliderType.POPULAR_MANGA,
    enabled: true,
    isBuiltIn: true,
    order: 18,
  },
  {
    type: DiscoverSliderType.NEW_MANGA,
    enabled: true,
    isBuiltIn: true,
    order: 19,
  },
  {
    type: DiscoverSliderType.POPULAR_COMICS,
    enabled: true,
    isBuiltIn: true,
    order: 20,
  },
];
