import { ambientGrid } from '@app/components/Allseerr/ListPage';
import PersonCard from '@app/components/PersonCard';
import TitleCard from '@app/components/TitleCard';
import BookTitleCard from '@app/components/TitleCard/BookTitleCard';
import ComicTitleCard, {
  getComicStatus,
  getMissingVolumes,
} from '@app/components/TitleCard/ComicTitleCard';
import MusicTitleCard from '@app/components/TitleCard/MusicTitleCard';
import TmdbTitleCard from '@app/components/TitleCard/TmdbTitleCard';
import useInterfaceStyle from '@app/hooks/useInterfaceStyle';
import { Permission, useUser } from '@app/hooks/useUser';
import useVerticalScroll from '@app/hooks/useVerticalScroll';
import globalMessages from '@app/i18n/globalMessages';
import { MediaStatus } from '@server/constants/media';
import type { WatchlistItem } from '@server/interfaces/api/discoverInterfaces';
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
import { useIntl } from 'react-intl';

type ListViewProps = {
  items?: (
    | TvResult
    | MovieResult
    | PersonResult
    | CollectionResult
    | AlbumResult
    | ArtistResult
    | BookResult
    | AuthorResult
    | ComicResult
  )[];
  plexItems?: WatchlistItem[];
  isEmpty?: boolean;
  isLoading?: boolean;
  isReachingEnd?: boolean;
  onScrollBottom: () => void;
  mutateParent?: () => void;
};

const ListView = ({
  items,
  isEmpty,
  isLoading,
  onScrollBottom,
  isReachingEnd,
  plexItems,
  mutateParent,
}: ListViewProps) => {
  const intl = useIntl();
  const { user, hasPermission } = useUser();
  const [interfaceStyle] = useInterfaceStyle();
  const ambient = interfaceStyle === 'ambient';
  useVerticalScroll(onScrollBottom, !isLoading && !isEmpty && !isReachingEnd);

  const blocklistVisibility = hasPermission(
    [Permission.MANAGE_BLOCKLIST, Permission.VIEW_BLOCKLIST],
    { type: 'or' }
  );

  return (
    <>
      {isEmpty &&
        (ambient ? (
          <div className="mx-auto mt-24 w-full max-w-md rounded-[22px] bg-as-surface px-6 py-10 text-center font-display text-[18px] font-medium text-as-ink-faint">
            {intl.formatMessage(globalMessages.noresults)}
          </div>
        ) : (
          <div className="mt-64 w-full text-center text-2xl text-gray-400">
            {intl.formatMessage(globalMessages.noresults)}
          </div>
        ))}
      <ul className={ambient ? `${ambientGrid} pb-10` : 'cards-vertical'}>
        {plexItems?.map((title, index) => {
          return (
            <li key={`${title.ratingKey}-${index}`}>
              <TmdbTitleCard
                id={title.tmdbId}
                tmdbId={title.tmdbId}
                mbId={title.mbId}
                olId={title.olId}
                type={title.mediaType}
                title={title.title}
                image={title.image}
                isAddedToWatchlist={true}
                canExpand
                mutateParent={mutateParent}
              />
            </li>
          );
        })}
        {items
          ?.filter((title) => {
            if (
              user?.settings?.hideWatched &&
              (title.mediaType === 'movie' || title.mediaType === 'tv') &&
              (title as TvResult | MovieResult).mediaInfo?.watched?.watched
            ) {
              return false;
            }
            if (!blocklistVisibility)
              return (
                (title as TvResult | MovieResult).mediaInfo?.status !==
                MediaStatus.BLOCKLISTED
              );
            return title;
          })
          .map((title, index) => {
            let titleCard: React.ReactNode;

            switch (title.mediaType) {
              case 'movie':
                titleCard = (
                  <TitleCard
                    key={title.id}
                    id={title.id}
                    isAddedToWatchlist={
                      title.mediaInfo?.watchlists?.length ?? 0
                    }
                    image={title.posterPath}
                    status={title.mediaInfo?.status}
                    watched={title.mediaInfo?.watched}
                    summary={title.overview}
                    title={title.title}
                    userScore={title.voteAverage}
                    year={title.releaseDate}
                    mediaType={title.mediaType}
                    inProgress={
                      (title.mediaInfo?.downloadStatus ?? []).length > 0
                    }
                    canExpand
                  />
                );
                break;
              case 'tv':
                titleCard = (
                  <TitleCard
                    key={title.id}
                    id={title.id}
                    isAddedToWatchlist={
                      title.mediaInfo?.watchlists?.length ?? 0
                    }
                    image={title.posterPath}
                    status={title.mediaInfo?.status}
                    watched={title.mediaInfo?.watched}
                    summary={title.overview}
                    title={title.name}
                    userScore={title.voteAverage}
                    year={title.firstAirDate}
                    mediaType={title.mediaType}
                    inProgress={
                      (title.mediaInfo?.downloadStatus ?? []).length > 0
                    }
                    canExpand
                  />
                );
                break;
              case 'collection':
                titleCard = (
                  <TitleCard
                    id={title.id}
                    image={title.posterPath}
                    summary={title.overview}
                    title={title.title}
                    mediaType={title.mediaType}
                    canExpand
                  />
                );
                break;
              case 'person':
                titleCard = (
                  <PersonCard
                    personId={title.id}
                    name={title.name}
                    profilePath={title.profilePath}
                    canExpand
                  />
                );
                break;
              case 'album':
                titleCard = (
                  <MusicTitleCard
                    id={title.id}
                    mediaType="album"
                    title={title.title}
                    subtitle={title.artistName}
                    year={title.releaseDate}
                    image={title.posterPath}
                    needsCoverArt={title.needsCoverArt}
                    albumType={title.albumType}
                    status={title.mediaInfo?.status}
                    inProgress={
                      (title.mediaInfo?.downloadStatus ?? []).length > 0
                    }
                    canExpand
                  />
                );
                break;
              case 'artist':
                titleCard = (
                  <MusicTitleCard
                    id={title.id}
                    mediaType="artist"
                    title={title.name}
                    subtitle={title.disambiguation}
                    image={title.artistThumb}
                    canExpand
                  />
                );
                break;
              case 'book':
                titleCard = (
                  <BookTitleCard
                    id={title.id}
                    mediaType="book"
                    title={title.title}
                    subtitle={title.authorName}
                    year={title.firstPublishYear}
                    image={title.posterPath}
                    status={title.mediaInfo?.status}
                    statusAudio={title.mediaInfo?.statusAudio}
                    canExpand
                  />
                );
                break;
              case 'author':
                titleCard = (
                  <BookTitleCard
                    id={title.id}
                    mediaType="author"
                    title={title.name}
                    subtitle={title.topWork}
                    image={title.profilePath}
                    canExpand
                  />
                );
                break;
              case 'comic':
                titleCard = (
                  <ComicTitleCard
                    id={title.id}
                    kind={title.kind}
                    title={title.title}
                    subtitle={title.authors}
                    year={title.year}
                    image={title.posterPath}
                    status={getComicStatus(title)}
                    missingVolumes={getMissingVolumes(title)}
                    canExpand
                  />
                );
                break;
            }

            return <li key={`${title.id}-${index}`}>{titleCard}</li>;
          })}
        {isLoading &&
          !isReachingEnd &&
          [...Array(20)].map((_item, i) => (
            <li key={`placeholder-${i}`}>
              <TitleCard.Placeholder canExpand />
            </li>
          ))}
      </ul>
    </>
  );
};

export default ListView;
