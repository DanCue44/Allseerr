import type { Results } from '@server/models/Search';

export const searchTokens = (value: string): string[] =>
  value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/['’]s\b/g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

const resultName = (result: Results): string =>
  result.mediaType === 'tv' ||
  result.mediaType === 'person' ||
  result.mediaType === 'artist' ||
  result.mediaType === 'author' ||
  result.mediaType === 'narrator'
    ? result.name
    : result.title;

/**
 * How closely a result's title matches the query: 3 for the same words, 2
 * for a title that starts with them, 1 for a title holding every word of the
 * query, 0 otherwise
 */
export const titleMatchTier = (query: string, title: string): number => {
  const queryTokens = searchTokens(query);
  const titleTokens = searchTokens(title);

  if (queryTokens.length === 0 || titleTokens.length === 0) {
    return 0;
  }

  const queryText = queryTokens.join(' ');
  const titleText = titleTokens.join(' ');

  if (titleText === queryText) {
    return 3;
  }

  if (titleText.startsWith(`${queryText} `)) {
    return 2;
  }

  return queryTokens.every((token) => titleTokens.includes(token)) ? 1 : 0;
};

/**
 * Orders the combined search across kinds: titles that match the query
 * closely come first, whatever their kind, so a manga called exactly what
 * was searched for is not left below forty loosely matching albums. Within a
 * tier each source keeps its own order, TMDB first, then music, books and
 * comics.
 */
export const rankCombinedResults = <T extends Results>(
  query: string,
  results: T[]
): T[] =>
  results
    .map((result, index) => ({
      result,
      index,
      tier: titleMatchTier(query, resultName(result) ?? ''),
    }))
    .sort((a, b) => b.tier - a.tier || a.index - b.index)
    .map(({ result }) => result);
