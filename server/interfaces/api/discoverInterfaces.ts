export interface GenreSliderItem {
  id: number;
  name: string;
  backdrops: string[];
}

export interface WatchlistItem {
  id: number;
  ratingKey: string;
  tmdbId: number;
  // Albums are watchlisted by MusicBrainz release group, books by
  // OpenLibrary work, followed artists by MusicBrainz artist and followed
  // authors by OpenLibrary author
  mbId?: string | null;
  olId?: string | null;
  mediaType: 'movie' | 'tv' | 'music' | 'book' | 'comic' | 'artist' | 'author';
  title: string;
  // Photo of a followed artist or author
  image?: string | null;
}

export interface WatchlistResponse {
  page: number;
  totalPages: number;
  totalResults: number;
  results: WatchlistItem[];
}

export interface BookRelease {
  // Google Books volume id, or OpenLibrary work id
  id: string;
  title: string;
  authorName: string;
  // OpenLibrary id of the followed author
  authorId: string;
  // YYYY-MM-DD, or YYYY-MM or YYYY when that is all the source knows
  date: string;
  posterUrl?: string;
  // Set when the book has a page of its own (OpenLibrary results)
  olId?: string;
}

export interface UpcomingBooksResponse {
  // Google Books lists books before they come out; OpenLibrary only knows
  // the year, so without a Google Books key only this year's books show
  source: 'googlebooks' | 'openlibrary';
  followedAuthors: number;
  // Books out this many days ago or less count as new (Google Books only)
  recentDays: number;
  comingSoon: BookRelease[];
  newReleases: BookRelease[];
}

// An OpenLibrary subject offered while setting up a book subject slider
export interface BookSubjectSuggestion {
  // The subject key, as in /subjects/science_fiction
  subject: string;
  name: string;
  workCount: number;
}

export interface BookSubjectSearchResponse {
  results: BookSubjectSuggestion[];
}

/** A movie left part way, or the next episode of a series in progress */
export interface ContinueWatchingItem {
  mediaType: 'movie' | 'tv';
  tmdbId: number;
  title: string;
  posterPath?: string | null;
  year?: string | null;
  seasonNumber?: number;
  episodeNumber?: number;
  episodeTitle?: string;
  /** How far through, 0 to 100, when left part way */
  progress: number | null;
  viewOffset: number | null;
  duration: number | null;
  lastViewedAt: string | null;
}

export interface ContinueWatchingResponse {
  results: ContinueWatchingItem[];
}
