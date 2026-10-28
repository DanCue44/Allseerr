import { DiscoverSliderType } from '@server/constants/discover';

/**
 * The media types a Discover row can be narrowed to. The values match the
 * mediaType filter of the request and media APIs, so they can be passed on
 * as they are.
 */
export const SPACE_MEDIA_TYPES = ['movie', 'tv', 'music', 'book'] as const;

export type SpaceMediaType = (typeof SPACE_MEDIA_TYPES)[number];

/** A media type, or every type at once as on the For You home */
export type DiscoverMediaFilter = 'all' | SpaceMediaType;

/**
 * Comic rows hold comic and manga series, which the books space shows on
 * its Comics & Manga page rather than among the books
 */
export type SliderMediaKind = SpaceMediaType | 'comic' | 'mixed';

/**
 * The kind of media a Discover slider shows. Mixed sliders hold more than one
 * media type.
 */
export const getSliderMediaKind = (
  type: DiscoverSliderType
): SliderMediaKind => {
  switch (type) {
    case DiscoverSliderType.POPULAR_MOVIES:
    case DiscoverSliderType.MOVIE_GENRES:
    case DiscoverSliderType.UPCOMING_MOVIES:
    case DiscoverSliderType.STUDIOS:
    case DiscoverSliderType.TMDB_MOVIE_KEYWORD:
    case DiscoverSliderType.TMDB_MOVIE_GENRE:
    case DiscoverSliderType.TMDB_STUDIO:
    case DiscoverSliderType.TMDB_MOVIE_STREAMING_SERVICES:
      return 'movie';
    case DiscoverSliderType.POPULAR_TV:
    case DiscoverSliderType.TV_GENRES:
    case DiscoverSliderType.UPCOMING_TV:
    case DiscoverSliderType.NETWORKS:
    case DiscoverSliderType.TMDB_TV_KEYWORD:
    case DiscoverSliderType.TMDB_TV_GENRE:
    case DiscoverSliderType.TMDB_NETWORK:
    case DiscoverSliderType.TMDB_TV_STREAMING_SERVICES:
      return 'tv';
    case DiscoverSliderType.POPULAR_MUSIC:
    case DiscoverSliderType.NEW_MUSIC:
      return 'music';
    case DiscoverSliderType.TRENDING_BOOKS:
    case DiscoverSliderType.POPULAR_BOOKS:
    case DiscoverSliderType.BOOK_SUBJECT:
      return 'book';
    case DiscoverSliderType.POPULAR_MANGA:
    case DiscoverSliderType.NEW_MANGA:
    case DiscoverSliderType.POPULAR_COMICS:
      return 'comic';
    default:
      return 'mixed';
  }
};

// Mixed sliders whose data can be narrowed to any one media type
const FILTERABLE_MIXED: DiscoverSliderType[] = [
  DiscoverSliderType.RECENTLY_ADDED,
  DiscoverSliderType.RECENT_REQUESTS,
  DiscoverSliderType.PLEX_WATCHLIST,
];

// TMDB trending and Continue Watching can be narrowed to movies or series,
// but have no music or books
const TRENDING_FILTERS: DiscoverMediaFilter[] = ['movie', 'tv'];

/**
 * Whether a slider belongs in a media type's space. Mixed sliders that cannot
 * be narrowed (such as a TMDB search) are left out, as is Coming Up, which a
 * space shows on its own Upcoming page.
 */
export const isSliderInDiscoverFilter = (
  type: DiscoverSliderType,
  filter: DiscoverMediaFilter
): boolean => {
  if (filter === 'all') {
    return true;
  }

  const kind = getSliderMediaKind(type);

  if (kind !== 'mixed') {
    return kind === filter;
  }

  if (
    type === DiscoverSliderType.TRENDING ||
    type === DiscoverSliderType.CONTINUE_WATCHING
  ) {
    return TRENDING_FILTERS.includes(filter);
  }

  return FILTERABLE_MIXED.includes(type);
};

interface SliderLike {
  type?: DiscoverSliderType;
  enabled?: boolean;
  isBuiltIn?: boolean;
}

/**
 * Picks the sliders a media type's space shows, keeping the configured
 * order. Every slider keeps its enabled setting, so a row an admin hid in
 * Customize Discover stays hidden in the spaces too.
 */
export const selectDiscoverSliders = <T extends SliderLike>(
  sliders: T[],
  filter: DiscoverMediaFilter
): T[] =>
  sliders.filter(
    (slider) =>
      slider.type !== undefined &&
      !!slider.enabled &&
      isSliderInDiscoverFilter(slider.type, filter)
  );

/**
 * Whether a slider is shown on the For You home. The home is a personal mix
 * across every media type: the built-in rows made for one type live in that
 * type's space instead, while sliders an admin created are kept.
 */
export const isHomeSlider = (slider: SliderLike): boolean =>
  slider.type !== undefined &&
  (!slider.isBuiltIn || getSliderMediaKind(slider.type) === 'mixed');

/** The enabled sliders of the For You home, in the configured order. */
export const selectHomeSliders = <T extends SliderLike>(sliders: T[]): T[] =>
  sliders.filter((slider) => !!slider.enabled && isHomeSlider(slider));

/**
 * Whether a slider is shown on the Comics & Manga page of the books space:
 * the comic rows, and the trending comics row of the home, which the page
 * narrows to trending manga
 */
export const isComicsPageSlider = (type: DiscoverSliderType): boolean =>
  type === DiscoverSliderType.TRENDING_COMICS ||
  getSliderMediaKind(type) === 'comic';

/** The enabled sliders of the Comics & Manga page, in the configured order */
export const selectComicsPageSliders = <T extends SliderLike>(
  sliders: T[]
): T[] =>
  sliders.filter(
    (slider) =>
      slider.type !== undefined &&
      !!slider.enabled &&
      isComicsPageSlider(slider.type)
  );

/** A place a slider shows up: the home, a space or the Comics & Manga page */
export type SliderPlacement = DiscoverMediaFilter | 'comics';

/**
 * Where a slider shows up when it is enabled: the For You home ('all'), the
 * spaces of the media types it holds and the Comics & Manga page. Labels
 * the rows while customizing.
 */
export const getSliderPlacements = (slider: SliderLike): SliderPlacement[] => {
  const type = slider.type;

  if (type === undefined) {
    return [];
  }

  return [
    ...(isHomeSlider(slider) ? (['all'] as const) : []),
    ...SPACE_MEDIA_TYPES.filter((mediaType) =>
      isSliderInDiscoverFilter(type, mediaType)
    ),
    ...(isComicsPageSlider(type) ? (['comics'] as const) : []),
  ];
};
