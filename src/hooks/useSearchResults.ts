import type { BaseSearchResult } from '@app/hooks/useDiscover';
import useDiscover, { encodeURIExtraParams } from '@app/hooks/useDiscover';
import { rankCombinedResults } from '@server/lib/searchRank';
import type { Results } from '@server/models/Search';
import { useMemo } from 'react';
import useSWR from 'swr';

type SearchApiType = 'music' | 'book' | 'comic';

/**
 * Search results for the search pages. A search of one kind (music, books or
 * comics) is one request. The combined search is two: movies, series and
 * people from TMDB, which answers quickly, and music, books and comics, which
 * can take seconds. The first is shown as soon as it arrives and the second
 * joins the first page when it does, ranked across kinds the way the server
 * ranks a combined answer.
 */
const useSearchResults = <T extends Results>(
  query: string | undefined,
  apiType?: SearchApiType
) => {
  const combined = !apiType;
  const discover = useDiscover<T>(
    '/api/v1/search',
    {
      query,
      ...(apiType ? { type: apiType } : { sources: 'media' }),
    },
    { hideAvailable: false, hideBlocklisted: false, hideRequested: false }
  );

  const { data: extras, error: extrasError } = useSWR<BaseSearchResult<T>>(
    combined && query
      ? `/api/v1/search?page=1&query=${encodeURIExtraParams(
          query
        )}&sources=extras`
      : null,
    { dedupingInterval: 30000, revalidateOnFocus: false }
  );
  const extrasLoading = combined && !!query && !extras && !extrasError;

  const firstPage = discover.firstResultData?.results;
  const titles = useMemo(() => {
    const extraResults = extras?.results ?? [];

    if (!combined || extraResults.length === 0) {
      return discover.titles;
    }

    // Only the first page is ranked with the extras, so later pages keep
    // their place as they load
    const firstIds = new Set((firstPage ?? []).map((result) => result.id));
    const split = discover.titles.findIndex((title) => !firstIds.has(title.id));
    const firstCount = split === -1 ? discover.titles.length : split;
    const seen = new Set(
      discover.titles.map((title) => `${title.mediaType}:${title.id}`)
    );

    return [
      ...rankCombinedResults(query ?? '', [
        ...discover.titles.slice(0, firstCount),
        ...extraResults.filter(
          (result) => !seen.has(`${result.mediaType}:${result.id}`)
        ),
      ]),
      ...discover.titles.slice(firstCount),
    ];
  }, [combined, extras, firstPage, discover.titles, query]);

  const isEmpty = discover.isEmpty && !extrasLoading && titles.length === 0;

  return {
    ...discover,
    titles,
    isEmpty,
    // Still loading while the extras are on their way and nothing is shown
    isLoadingInitialData:
      discover.isLoadingInitialData ||
      (extrasLoading && discover.titles.length === 0),
    isLoadingMore: discover.isLoadingMore || extrasLoading,
    isReachingEnd: discover.isReachingEnd && !extrasLoading,
  };
};

export default useSearchResults;
