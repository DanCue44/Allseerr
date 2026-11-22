/**
 * Requests can be blocked by genre. Movies and series use TMDB genre ids
 * (the two lists differ), music uses MusicBrainz genres and tags and books
 * use OpenLibrary subjects, both matched by name. This module has no server
 * imports so the request window can use the same checks.
 */

export const GENRE_BLOCK_TYPES = ['movie', 'tv', 'music', 'book'] as const;

export type GenreBlockType = (typeof GENRE_BLOCK_TYPES)[number];

/**
 * The blocked genres of each media type, each a comma separated list: TMDB
 * genre ids for movies and series ("27,10749"), names for music and books
 * ("christmas,horror").
 */
export type BlockedGenres = Record<GenreBlockType, string>;

export const emptyBlockedGenres = (): BlockedGenres => ({
  movie: '',
  tv: '',
  music: '',
  book: '',
});

const MAX_LIST_LENGTH = 2000;

export const parseGenreList = (value?: string | null): string[] => [
  ...new Set(
    (value ?? '')
      .split(/[|,]/)
      .map((item) => item.trim())
      .filter(Boolean)
  ),
];

/**
 * Cleans a blocked genres value sent by a client. Anything that is not an
 * object gives null; missing or invalid lists are empty. Ids are kept only
 * for movies and series, names are lowercased for music and books.
 */
export const normalizeBlockedGenres = (
  value: unknown
): BlockedGenres | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const input = value as Partial<Record<GenreBlockType, unknown>>;
  const result = emptyBlockedGenres();

  for (const type of GENRE_BLOCK_TYPES) {
    const raw = typeof input[type] === 'string' ? (input[type] as string) : '';
    const items = parseGenreList(raw.slice(0, MAX_LIST_LENGTH));

    result[type] = (
      type === 'movie' || type === 'tv'
        ? items.filter((item) => /^\d+$/.test(item) && Number(item) > 0)
        : items.map((item) => item.toLowerCase())
    ).join(',');
  }

  return result;
};

/**
 * A person's own blocked genres, stored as JSON, or null when they follow
 * the server's list.
 */
export const parseUserBlockedGenres = (
  value?: string | null
): BlockedGenres | null => {
  if (!value) {
    return null;
  }

  try {
    return normalizeBlockedGenres(JSON.parse(value));
  } catch {
    return null;
  }
};

/**
 * The blocked genres that apply to a person: their own list when an admin
 * set one, otherwise the server's.
 */
export const getEffectiveBlockedGenres = (
  userValue: string | null | undefined,
  serverValue: Partial<BlockedGenres> | null | undefined
): BlockedGenres =>
  parseUserBlockedGenres(userValue) ??
  normalizeBlockedGenres(serverValue ?? {}) ??
  emptyBlockedGenres();

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Whether a genre name holds a blocked name as a whole word or phrase, so
 * "horror" blocks "Horror" and "Horror fiction" but not "Horrorcore".
 */
const matchesName = (genre: string, blocked: string): boolean =>
  new RegExp(
    `(^|[^\\p{L}\\p{N}])${escapeRegExp(blocked)}($|[^\\p{L}\\p{N}])`,
    'iu'
  ).test(genre);

/**
 * The blocked genres a title is in, as names to show. Movies and series
 * match on genre id and show TMDB's name; music and books show the blocked
 * name that matched one of their genres.
 */
export const findBlockedGenres = (
  type: GenreBlockType,
  genres: { id?: number; name: string }[] | string[] | undefined,
  blocked: BlockedGenres
): string[] => {
  const list = parseGenreList(blocked[type]);

  if (!list.length || !genres?.length) {
    return [];
  }

  const items = genres.map((genre) =>
    typeof genre === 'string' ? { name: genre } : genre
  );

  if (type === 'movie' || type === 'tv') {
    const ids = list.map(Number);

    return [
      ...new Set(
        items
          .filter((genre) => genre.id !== undefined && ids.includes(genre.id))
          .map((genre) => genre.name)
      ),
    ];
  }

  return list.filter((name) =>
    items.some((genre) => matchesName(genre.name, name))
  );
};
