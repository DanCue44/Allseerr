import AmbientMovieDetails from '@app/components/Allseerr/MovieDetails';
import MovieDetails from '@app/components/MovieDetails';
import useInterfaceStyle from '@app/hooks/useInterfaceStyle';
import { getHostAndPort } from '@app/utils/urlHelper';
import type { MovieDetails as MovieDetailsType } from '@server/models/Movie';
import axios from 'axios';
import type { GetServerSideProps, NextPage } from 'next';

interface MoviePageProps {
  movie?: MovieDetailsType;
}

const MoviePage: NextPage<MoviePageProps> = ({ movie }) => {
  const [interfaceStyle] = useInterfaceStyle();

  return interfaceStyle === 'ambient' ? (
    <AmbientMovieDetails key={movie?.id} movie={movie} />
  ) : (
    <MovieDetails key={movie?.id} movie={movie} />
  );
};

export const getServerSideProps: GetServerSideProps<MoviePageProps> = async (
  ctx
) => {
  const response = await axios.get<MovieDetailsType>(
    `http://${getHostAndPort()}/api/v1/movie/${ctx.query.movieId}`,
    {
      headers: ctx.req?.headers?.cookie
        ? { cookie: ctx.req.headers.cookie }
        : undefined,
    }
  );

  return {
    props: {
      movie: response.data,
    },
  };
};

export default MoviePage;
