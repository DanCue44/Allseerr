import { UserType, useUser } from '@app/hooks/useUser';
import type { TvWatchedResponse } from '@server/interfaces/api/mediaInterfaces';
import useSWR, { mutate } from 'swr';

export const tvWatchedKey = (tvId: number): string =>
  `/api/v1/tv/${tvId}/watched`;

/**
 * The tick for a season: every episode TMDB lists seen, or only some of
 * them (or some started). Nothing for a season never touched.
 */
export const seasonWatchedState = (
  summary: { watchedEpisodes: number; inProgressEpisodes: number } | undefined,
  episodeCount: number
): { watched: boolean; inProgress: boolean } | undefined => {
  if (
    !summary ||
    (summary.watchedEpisodes === 0 && summary.inProgressEpisodes === 0)
  ) {
    return undefined;
  }

  const watched = episodeCount > 0 && summary.watchedEpisodes >= episodeCount;

  return { watched, inProgress: !watched };
};

/** Refreshes a series page, its ticks and the home row after a mark */
export const refreshTvWatched = async (tvId: number): Promise<void> => {
  await Promise.all([
    mutate(tvWatchedKey(tvId)),
    mutate(`/api/v1/tv/${tvId}`),
    mutate('/api/v1/discover/continue-watching'),
  ]);
};

/**
 * What the signed-in person has watched of a series, per season and
 * episode. Nothing for local accounts, which have no media server account
 * to ask.
 */
const useTvWatched = (
  tvId?: number
): { watched?: TvWatchedResponse; canMark: boolean } => {
  const { user } = useUser();
  const enabled = !!tvId && !!user && user.userType !== UserType.LOCAL;
  const { data } = useSWR<TvWatchedResponse>(
    enabled ? tvWatchedKey(tvId) : null
  );

  return { watched: enabled ? data : undefined, canMark: enabled && !!data };
};

export default useTvWatched;
