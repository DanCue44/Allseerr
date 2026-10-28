import { MediaType } from '@server/constants/media';
import {
  episodeState,
  hasEpisodeState,
  hasViewState,
  jellyfinCounts,
  jellyfinEpisodeCounts,
  mergeCounts,
  mergeEpisodeCounts,
  plexCounts,
  plexEpisodeCounts,
  progressPercent,
  sameCounts,
  watchedState,
} from '@server/lib/watchedState';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('watchedState', () => {
  it('calls a movie watched once played, and in progress part way', () => {
    assert.equal(watchedState(undefined, MediaType.MOVIE).watched, false);

    const played = plexCounts({ viewCount: 2, lastViewedAt: 1_700_000_000 });
    assert.equal(watchedState(played, MediaType.MOVIE).watched, true);
    assert.equal(watchedState(played, MediaType.MOVIE).inProgress, false);
    assert.equal(
      watchedState(played, MediaType.MOVIE).lastViewedAt,
      new Date(1_700_000_000_000).toISOString()
    );

    const partWay = plexCounts({ viewOffset: 120_000 });
    assert.equal(watchedState(partWay, MediaType.MOVIE).watched, false);
    assert.equal(watchedState(partWay, MediaType.MOVIE).inProgress, true);
  });

  it('calls a series watched when every episode the server has is seen', () => {
    const all = plexCounts({ leafCount: 24, viewedLeafCount: 24 });
    assert.equal(watchedState(all, MediaType.TV).watched, true);

    const some = plexCounts({ leafCount: 24, viewedLeafCount: 3 });
    assert.equal(watchedState(some, MediaType.TV).watched, false);
    assert.equal(watchedState(some, MediaType.TV).inProgress, true);

    const none = plexCounts({ leafCount: 24 });
    assert.equal(hasViewState(none), false);
    assert.equal(watchedState(none, MediaType.TV).inProgress, false);
  });

  it('reads Jellyfin play data for movies and series', () => {
    const movie = jellyfinCounts({
      Type: 'Movie',
      UserData: { Played: true, PlayCount: 1, PlaybackPositionTicks: 0 },
    });
    assert.equal(watchedState(movie, MediaType.MOVIE).watched, true);

    const resumable = jellyfinCounts({
      Type: 'Movie',
      UserData: { Played: false, PlaybackPositionTicks: 600_000_000 },
    });
    assert.equal(resumable.viewOffset, 60_000);
    assert.equal(watchedState(resumable, MediaType.MOVIE).inProgress, true);

    const series = jellyfinCounts({
      Type: 'Series',
      RecursiveItemCount: 10,
      UserData: { Played: false, UnplayedItemCount: 4 },
    });
    assert.equal(series.viewedLeafCount, 6);
    assert.equal(watchedState(series, MediaType.TV).inProgress, true);

    const done = jellyfinCounts({
      Type: 'Series',
      RecursiveItemCount: 10,
      UserData: { Played: true, UnplayedItemCount: 0 },
    });
    assert.equal(watchedState(done, MediaType.TV).watched, true);
  });

  it('keeps the fuller record when a title is in two libraries', () => {
    const hd = plexCounts({ viewCount: 1, lastViewedAt: 100 });
    const uhd = plexCounts({ viewOffset: 5000, lastViewedAt: 200 });
    const merged = mergeCounts(hd, uhd);
    assert.equal(merged.viewCount, 1);
    assert.equal(merged.viewOffset, 5000);
    assert.equal(merged.lastViewedAt?.getTime(), 200_000);
    assert.equal(sameCounts(merged, mergeCounts(uhd, hd)), true);
    assert.equal(sameCounts(hd, uhd), false);
  });
});

describe('episodeState', () => {
  it('calls an episode watched once played, and in progress part way', () => {
    assert.equal(episodeState(undefined).watched, false);
    assert.equal(episodeState(undefined).inProgress, false);

    const played = plexEpisodeCounts({ viewCount: 1, lastViewedAt: 1_700_000 });
    assert.equal(episodeState(played).watched, true);
    assert.equal(episodeState(played).inProgress, false);
    assert.equal(
      episodeState(played).lastViewedAt,
      new Date(1_700_000_000).toISOString()
    );

    const partWay = plexEpisodeCounts({
      viewOffset: 900_000,
      duration: 2_700_000,
    });
    assert.equal(hasEpisodeState(partWay), true);
    assert.equal(episodeState(partWay).watched, false);
    assert.equal(episodeState(partWay).inProgress, true);
    assert.equal(episodeState(partWay).duration, 2_700_000);

    assert.equal(hasEpisodeState(plexEpisodeCounts({ duration: 100 })), false);
  });

  it('reads Jellyfin play data for an episode', () => {
    const resumable = jellyfinEpisodeCounts({
      Type: 'Episode',
      RunTimeTicks: 27_000_000_000,
      UserData: { Played: false, PlaybackPositionTicks: 9_000_000_000 },
    });
    assert.equal(resumable.viewOffset, 900_000);
    assert.equal(resumable.duration, 2_700_000);
    assert.equal(episodeState(resumable).inProgress, true);

    const played = jellyfinEpisodeCounts({
      Type: 'Episode',
      UserData: { Played: true },
    });
    assert.equal(episodeState(played).watched, true);
  });

  it('keeps the record viewed last when an episode is in two libraries', () => {
    const hd = plexEpisodeCounts({ viewCount: 1, lastViewedAt: 100 });
    const uhd = plexEpisodeCounts({
      viewOffset: 5000,
      duration: 9000,
      lastViewedAt: 200,
    });
    const merged = mergeEpisodeCounts(hd, uhd);
    assert.equal(merged.viewCount, 1);
    assert.equal(merged.viewOffset, 5000);
    assert.equal(merged.duration, 9000);
  });
});

describe('progress', () => {
  it('keeps a movie length through a merge and reports how far through', () => {
    const played = plexCounts({
      viewCount: 1,
      duration: 6_000_000,
      lastViewedAt: 100,
    });
    const partWay = plexCounts({ viewOffset: 1_500_000, lastViewedAt: 200 });
    const merged = mergeCounts(played, partWay);
    assert.equal(merged.duration, 6_000_000);
    assert.equal(watchedState(merged, MediaType.MOVIE).duration, 6_000_000);
    assert.equal(progressPercent(merged.viewOffset, merged.duration), 25);
  });

  it('has no progress without a length or an offset', () => {
    assert.equal(progressPercent(null, 1000), null);
    assert.equal(progressPercent(500, null), null);
    assert.equal(progressPercent(500, 0), null);
    assert.equal(progressPercent(5000, 1000), 100);
  });
});
