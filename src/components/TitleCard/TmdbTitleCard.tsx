import TitleCard from '@app/components/TitleCard';
import BookTitleCard from '@app/components/TitleCard/BookTitleCard';
import { ComicIdTitleCard } from '@app/components/TitleCard/ComicTitleCard';
import MusicBrainzTitleCard from '@app/components/TitleCard/MusicBrainzTitleCard';
import MusicTitleCard from '@app/components/TitleCard/MusicTitleCard';
import OpenLibraryTitleCard from '@app/components/TitleCard/OpenLibraryTitleCard';
import { Permission, useUser } from '@app/hooks/useUser';
import type { MovieDetails } from '@server/models/Movie';
import type { TvDetails } from '@server/models/Tv';
import { useInView } from 'react-intersection-observer';
import useSWR from 'swr';

export interface TmdbTitleCardProps {
  id: number;
  tmdbId: number;
  tvdbId?: number;
  // Music media lists pass their albums through here with their MBID
  mbId?: string | null;
  // and books with their OpenLibrary work id. Followed artists and authors
  // come with their MusicBrainz artist or OpenLibrary author id, and the
  // name and photo to show.
  olId?: string | null;
  // Comic and manga series come with their comic id
  comicId?: string | null;
  type: 'movie' | 'tv' | 'music' | 'book' | 'comic' | 'artist' | 'author';
  title?: string;
  image?: string | null;
  canExpand?: boolean;
  isAddedToWatchlist?: boolean;
  mutateParent?: () => void;
}

const isMovie = (movie: MovieDetails | TvDetails): movie is MovieDetails => {
  return (movie as MovieDetails).title !== undefined;
};

const TmdbTitleCard = (props: TmdbTitleCardProps) => {
  if (props.type === 'music') {
    return props.mbId ? (
      <MusicBrainzTitleCard mbId={props.mbId} canExpand={props.canExpand} />
    ) : null;
  }

  if (props.type === 'book') {
    return props.olId ? (
      <OpenLibraryTitleCard olId={props.olId} canExpand={props.canExpand} />
    ) : null;
  }

  if (props.type === 'comic') {
    return props.comicId ? (
      <ComicIdTitleCard comicId={props.comicId} canExpand={props.canExpand} />
    ) : null;
  }

  if (props.type === 'artist') {
    return props.mbId ? (
      <MusicTitleCard
        id={props.mbId}
        mediaType="artist"
        title={props.title ?? ''}
        image={props.image}
        canExpand={props.canExpand}
      />
    ) : null;
  }

  if (props.type === 'author') {
    return props.olId ? (
      <BookTitleCard
        id={props.olId}
        mediaType="author"
        title={props.title ?? ''}
        image={props.image}
        canExpand={props.canExpand}
      />
    ) : null;
  }

  return <TmdbMediaTitleCard {...props} type={props.type} />;
};

const TmdbMediaTitleCard = ({
  id,
  tmdbId,
  tvdbId,
  type,
  canExpand,
  isAddedToWatchlist = false,
  mutateParent,
}: TmdbTitleCardProps & { type: 'movie' | 'tv' }) => {
  const { hasPermission } = useUser();

  const { ref, inView } = useInView({
    triggerOnce: true,
  });
  const url =
    type === 'movie' ? `/api/v1/movie/${tmdbId}` : `/api/v1/tv/${tmdbId}`;
  const { data: title, error } = useSWR<MovieDetails | TvDetails>(
    inView ? `${url}` : null
  );

  if (!title && !error) {
    return (
      <div ref={ref}>
        <TitleCard.Placeholder canExpand={canExpand} />
      </div>
    );
  }

  if (!title) {
    return hasPermission(Permission.ADMIN) ? (
      <TitleCard.ErrorCard
        id={id}
        tmdbId={tmdbId}
        tvdbId={tvdbId}
        type={type}
      />
    ) : null;
  }

  return isMovie(title) ? (
    <TitleCard
      key={title.id}
      id={title.id}
      isAddedToWatchlist={
        title.mediaInfo?.watchlists?.length || isAddedToWatchlist
      }
      image={title.posterPath}
      status={title.mediaInfo?.status}
      watched={title.mediaInfo?.watched}
      summary={title.overview}
      title={title.title}
      userScore={title.voteAverage}
      year={title.releaseDate}
      mediaType={'movie'}
      canExpand={canExpand}
      mutateParent={mutateParent}
    />
  ) : (
    <TitleCard
      key={title.id}
      id={title.id}
      isAddedToWatchlist={
        title.mediaInfo?.watchlists?.length || isAddedToWatchlist
      }
      image={title.posterPath}
      status={title.mediaInfo?.status}
      watched={title.mediaInfo?.watched}
      summary={title.overview}
      title={title.name}
      userScore={title.voteAverage}
      year={title.firstAirDate}
      mediaType={'tv'}
      canExpand={canExpand}
      mutateParent={mutateParent}
    />
  );
};

export default TmdbTitleCard;
