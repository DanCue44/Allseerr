import { MediaType } from '@server/constants/media';
import {
  hasViewState,
  jellyfinCounts,
  mergeCounts,
  plexCounts,
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
