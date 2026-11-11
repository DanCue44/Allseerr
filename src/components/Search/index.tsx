import Header from '@app/components/Common/Header';
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
  ComicResult,
  MovieResult,
  PersonResult,
  TvResult,
} from '@server/models/Search';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Search', {
  search: 'Search',
  searchresults: 'Search Results',
  comics: 'Comics',
});

type SearchType = 'all' | 'music' | 'book' | 'comic';

const Search = () => {
  const intl = useIntl();
  const router = useRouter();
  const settings = useSettings();
  const comicsEnabled = useComicsEnabled();
  const hiddenMediaTypes = useHiddenMediaTypes();
  const searchType: SearchType =
    router.query.type === 'music' ||
    router.query.type === 'book' ||
    (router.query.type === 'comic' && comicsEnabled)
      ? router.query.type
      : 'all';

  const {
    isLoadingInitialData,
    isEmpty,
    isLoadingMore,
    isReachingEnd,
    titles,
    fetchMore,
    error,
  } = useDiscover<
    | MovieResult
    | TvResult
    | PersonResult
    | AlbumResult
    | ArtistResult
    | BookResult
    | AuthorResult
    | ComicResult
  >(
    `/api/v1/search`,
    {
      query: router.query.query,
      ...(searchType !== 'all' ? { type: searchType } : {}),
    },
    { hideAvailable: false, hideBlocklisted: false, hideRequested: false }
  );

  if (error) {
    return <ErrorPage statusCode={500} />;
  }

  const allSearchTypes: { type: SearchType; label: string }[] = [
    { type: 'all', label: intl.formatMessage(globalMessages.all) },
    { type: 'music', label: intl.formatMessage(globalMessages.music) },
    // Books are offered once LazyLibrarian can fulfil book requests
    ...(settings.currentSettings.booksEnabled
      ? [
          {
            type: 'book' as const,
            label: intl.formatMessage(globalMessages.books),
          },
        ]
      : []),
    // Comics are offered while Talearr's comics library is on
    ...(comicsEnabled
      ? [
          {
            type: 'comic' as const,
            label: intl.formatMessage(messages.comics),
          },
        ]
      : []),
  ];
  // Types the user cannot request leave while the admin hides them
  const searchTypes = allSearchTypes.filter(
    ({ type }) => type === 'all' || isResultShown(type, hiddenMediaTypes)
  );

  return (
    <>
      <PageTitle title={intl.formatMessage(messages.search)} />
      <div className="mb-5 mt-1 flex flex-col justify-between sm:flex-row sm:items-end">
        <Header>{intl.formatMessage(messages.searchresults)}</Header>
        <div className="mt-2 flex space-x-2 sm:mt-0">
          {searchTypes.map(({ type, label }) => (
            <Link
              key={type}
              href={{
                pathname: router.pathname,
                query: {
                  ...router.query,
                  type: type === 'all' ? undefined : type,
                },
              }}
              replace
              className={`rounded-full px-3 py-1 text-sm font-medium transition duration-150 ${
                searchType === type
                  ? 'bg-indigo-600 text-white'
                  : 'bg-gray-800 text-gray-300 ring-1 ring-gray-700 hover:bg-gray-700'
              }`}
            >
              {label}
            </Link>
          ))}
        </div>
      </div>
      <ListView
        items={titles}
        isEmpty={isEmpty}
        isLoading={
          isLoadingInitialData || (isLoadingMore && (titles?.length ?? 0) > 0)
        }
        isReachingEnd={isReachingEnd}
        onScrollBottom={fetchMore}
      />
    </>
  );
};

export default Search;
