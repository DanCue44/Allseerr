import { AmbientPageHeader, PillTabs } from '@app/components/Allseerr/ListPage';
import ListView from '@app/components/Common/ListView';
import PageTitle from '@app/components/Common/PageTitle';
import useComicsEnabled from '@app/hooks/useComicsEnabled';
import useDiscover from '@app/hooks/useDiscover';
import useHiddenMediaTypes from '@app/hooks/useHiddenMediaTypes';
import useSettings from '@app/hooks/useSettings';
import globalMessages from '@app/i18n/globalMessages';
import ErrorPage from '@app/pages/_error';
import defineMessages from '@app/utils/defineMessages';
import { isResultShown } from '@server/lib/hiddenMediaTypes';
import type {
  AlbumResult,
  ArtistResult,
  AuthorResult,
  BookResult,
  CollectionResult,
  ComicResult,
  MovieResult,
  PersonResult,
  TvResult,
} from '@server/models/Search';
import { useRouter } from 'next/router';
import { useMemo } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Allseerr.Search', {
  search: 'Search',
  searchresults: 'Search Results',
  resultsfor: 'Results for {query}',
  resulttypes: 'Result types',
  movies: 'Movies',
  series: 'Series',
  people: 'People',
  comics: 'Comics',
});

// Music, books and comics have their own search; movies, series and people
// are the matching part of the combined search
type SearchType =
  | 'all'
  | 'movie'
  | 'tv'
  | 'music'
  | 'book'
  | 'comic'
  | 'person';

const searchTypes: SearchType[] = [
  'all',
  'movie',
  'tv',
  'music',
  'book',
  'comic',
  'person',
];

type SearchResult =
  | MovieResult
  | TvResult
  | PersonResult
  | AlbumResult
  | ArtistResult
  | BookResult
  | AuthorResult
  | CollectionResult
  | ComicResult;

/**
 * Ambient search results: the query as the heading, type tabs as pills and
 * the results in the card grid. Uses the same search endpoint as the classic
 * page.
 */
const AmbientSearch = () => {
  const intl = useIntl();
  const router = useRouter();
  const settings = useSettings();
  const booksEnabled = !!settings.currentSettings.booksEnabled;
  const comicsEnabled = useComicsEnabled();
  const hiddenMediaTypes = useHiddenMediaTypes();
  // Types the user cannot request are not offered while the admin hides them
  const isOffered = (type: SearchType) =>
    (type === 'all' || isResultShown(type, hiddenMediaTypes)) &&
    (type === 'book' ? booksEnabled : type === 'comic' ? comicsEnabled : true);
  const requested = router.query.type as SearchType | undefined;
  const searchType: SearchType =
    requested && searchTypes.includes(requested) && isOffered(requested)
      ? requested
      : 'all';
  const apiType =
    searchType === 'music' || searchType === 'book' || searchType === 'comic'
      ? searchType
      : undefined;

  const {
    isLoadingInitialData,
    isEmpty,
    isLoadingMore,
    isReachingEnd,
    titles,
    fetchMore,
    error,
  } = useDiscover<SearchResult>(
    `/api/v1/search`,
    {
      query: router.query.query,
      ...(apiType ? { type: apiType } : {}),
    },
    { hideAvailable: false, hideBlocklisted: false, hideRequested: false }
  );

  const results = useMemo(() => {
    switch (searchType) {
      case 'movie':
        return titles.filter(
          (title) =>
            title.mediaType === 'movie' || title.mediaType === 'collection'
        );
      case 'tv':
        return titles.filter((title) => title.mediaType === 'tv');
      case 'person':
        return titles.filter((title) => title.mediaType === 'person');
      default:
        return titles;
    }
  }, [titles, searchType]);

  if (error) {
    return <ErrorPage statusCode={500} />;
  }

  const query =
    typeof router.query.query === 'string' ? router.query.query : undefined;

  const labels: Record<SearchType, string> = {
    all: intl.formatMessage(globalMessages.all),
    movie: intl.formatMessage(messages.movies),
    tv: intl.formatMessage(messages.series),
    music: intl.formatMessage(globalMessages.music),
    book: intl.formatMessage(globalMessages.books),
    comic: intl.formatMessage(messages.comics),
    person: intl.formatMessage(messages.people),
  };

  const tabs = searchTypes
    // Books are offered once a book service can fulfil book requests, and
    // comics while Talearr's comics library is on
    .filter(isOffered)
    .map((type) => ({
      key: type,
      label: labels[type],
      active: searchType === type,
      replace: true,
      href: {
        pathname: router.pathname,
        query: {
          ...router.query,
          type: type === 'all' ? undefined : type,
        },
      },
    }));

  const isLoading =
    isLoadingInitialData || (isLoadingMore && (titles?.length ?? 0) > 0);
  const noResults =
    !isLoadingInitialData &&
    results.length === 0 &&
    (isEmpty || !!isReachingEnd);

  return (
    <>
      <PageTitle title={intl.formatMessage(messages.search)} />
      <AmbientPageHeader
        title={
          query
            ? intl.formatMessage(messages.resultsfor, {
                query: <span className="text-as-accent-soft">{query}</span>,
              })
            : intl.formatMessage(messages.searchresults)
        }
      />
      <div className="-mt-2 mb-7">
        <PillTabs
          label={intl.formatMessage(messages.resulttypes)}
          tabs={tabs}
        />
      </div>
      <ListView
        items={results}
        isEmpty={noResults}
        isLoading={isLoading}
        isReachingEnd={isReachingEnd}
        onScrollBottom={fetchMore}
      />
    </>
  );
};

export default AmbientSearch;
