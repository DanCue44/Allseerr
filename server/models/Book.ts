import {
  getAuthorPhotoUrl,
  getCoverUrl,
  getOlId,
  getOlText,
} from '@server/api/openlibrary';
import type {
  OlAuthor,
  OlAuthorSearchDoc,
  OlSearchDoc,
  OlSubjectWork,
  OlWork,
} from '@server/api/openlibrary/interfaces';
import { MediaStatus } from '@server/constants/media';
import type Media from '@server/entity/Media';
import { getOwnedCoverPath } from '@server/lib/audiobookshelfCover';
import { cleanBookSubjects } from '@server/lib/bookSubjects';
import type { AudiobookshelfSettings } from '@server/lib/settings';
import type { AuthorResult, BookResult } from '@server/models/Search';

export interface BookLink {
  title: string;
  url: string;
}

/**
 * An audiobook edition Audible lists for the book, as saved by the last
 * availability lookup
 */
export interface AudiobookEdition {
  asin?: string;
  narrators: string[];
  runtimeMinutes?: number;
  coverUrl?: string;
}

export interface BookDetails {
  id: string;
  olId: string;
  mediaType: 'book';
  title: string;
  subtitle?: string;
  description?: string;
  authors: {
    id: string;
    name: string;
  }[];
  firstPublishYear?: number;
  posterPath: string | null;
  subjects: string[];
  subjectPlaces: string[];
  subjectPeople: string[];
  subjectTimes: string[];
  editionCount?: number;
  pageCount?: number;
  ratingsAverage?: number;
  ratingsCount?: number;
  languages: string[];
  links: BookLink[];
  audiobookshelfUrl?: string | null;
  audiobookshelfEbookUrl?: string | null;
  audiobookshelfAudiobookUrl?: string | null;
  audiobookshelfEbookItemId?: string | null;
  audiobookshelfAudiobookItemId?: string | null;
  nobookendsEbookUrl?: string | null;
  nobookendsAudiobookUrl?: string | null;
  audiobookEdition?: AudiobookEdition | null;
  mediaInfo?: Media;
  onUserWatchlist?: boolean;
}

export interface AuthorDetails {
  id: string;
  olId: string;
  mediaType: 'author';
  name: string;
  bio?: string;
  birthDate?: string;
  deathDate?: string;
  profilePath: string | null;
  links: BookLink[];
  wikipedia?: string;
  works: BookResult[];
  totalWorks: number;
  // Whether the current user follows the author through their watchlist
  onUserWatchlist?: boolean;
}

// Subject lists on OpenLibrary are long, the most common ones come first
const MAX_SUBJECTS = 20;

/**
 * OpenLibrary descriptions often end with a markdown source note and links
 */
const cleanDescription = (description?: string): string | undefined =>
  description
    ?.replace(/\r\n/g, '\n')
    .replace(/\n\s*\[\d+\]:\s*\S+/g, '')
    .replace(/\(\[[^\]]*\]\[\d+\]\)/g, '')
    .replace(/-{5,}[\s\S]*$/, '')
    .trim() || undefined;

export const mapBookResult = (doc: OlSearchDoc, media?: Media): BookResult => ({
  id: getOlId(doc.key),
  mediaType: 'book',
  title: doc.title,
  subtitle: doc.subtitle,
  authorId: doc.author_key?.[0],
  authorName: doc.author_name?.join(', ') || undefined,
  firstPublishYear: doc.first_publish_year,
  editionCount: doc.edition_count,
  posterPath: getOwnedCoverPath(media) ?? getCoverUrl(doc.cover_i, 'M'),
  mediaInfo: media,
});

export const mapSubjectWorkResult = (
  work: OlSubjectWork,
  media?: Media
): BookResult => ({
  id: getOlId(work.key),
  mediaType: 'book',
  title: work.title,
  authorId: work.authors?.[0] ? getOlId(work.authors[0].key) : undefined,
  authorName:
    work.authors?.map((author) => author.name).join(', ') || undefined,
  firstPublishYear: work.first_publish_year,
  editionCount: work.edition_count,
  posterPath: getOwnedCoverPath(media) ?? getCoverUrl(work.cover_id, 'M'),
  mediaInfo: media,
});

export const mapAuthorResult = (doc: OlAuthorSearchDoc): AuthorResult => {
  const id = getOlId(doc.key);

  return {
    id,
    mediaType: 'author',
    name: doc.name,
    birthDate: doc.birth_date,
    deathDate: doc.death_date,
    topWork: doc.top_work,
    workCount: doc.work_count,
    profilePath: `https://covers.openlibrary.org/a/olid/${id}-M.jpg`,
  };
};

/**
 * Where a book opens in Audiobookshelf when it cannot be linked directly: a
 * title search in the format's library, or Audiobookshelf's home page. With
 * a format, only once that format is available, in its library: ebooks may
 * sit in a library of their own. Without one, once either format is
 * available.
 */
export const getAudiobookshelfUrl = (
  settings: AudiobookshelfSettings,
  title: string,
  media?: Media,
  format?: 'ebook' | 'audiobook'
): string | null => {
  const baseUrl = settings.url?.replace(/\/+$/, '');
  const ebookAvailable = media?.status === MediaStatus.AVAILABLE;
  const audiobookAvailable = media?.statusAudio === MediaStatus.AVAILABLE;
  const available =
    format === 'ebook'
      ? ebookAvailable
      : format === 'audiobook'
        ? audiobookAvailable
        : ebookAvailable || audiobookAvailable;

  if (!baseUrl || !available) {
    return null;
  }

  // Search the audiobook library when it has the audiobook
  const libraryId =
    format === 'ebook' || (!format && !audiobookAvailable)
      ? settings.ebookLibraryId || settings.libraryId
      : settings.libraryId;

  return libraryId
    ? `${baseUrl}/library/${encodeURIComponent(
        libraryId
      )}/search?q=${encodeURIComponent(title)}`
    : baseUrl;
};

export const mapBookDetails = (
  work: OlWork,
  {
    summary,
    authors,
    media,
  }: {
    summary?: OlSearchDoc;
    authors?: { id: string; name: string }[];
    media?: Media;
  } = {}
): BookDetails => {
  const id = getOlId(work.key);

  return {
    id,
    olId: id,
    mediaType: 'book',
    title: work.title,
    subtitle: work.subtitle ?? summary?.subtitle,
    description: cleanDescription(getOlText(work.description)),
    authors:
      authors ??
      (summary?.author_key ?? []).map((authorId, index) => ({
        id: authorId,
        name: summary?.author_name?.[index] ?? '',
      })),
    firstPublishYear: summary?.first_publish_year,
    // The cover of the copy in the library, so the book is easy to spot in
    // the apps that read it
    posterPath:
      getOwnedCoverPath(media) ??
      getCoverUrl(
        work.covers?.find((cover) => cover > 0) ?? summary?.cover_i,
        'L'
      ),
    subjects: cleanBookSubjects(work.subjects, MAX_SUBJECTS),
    subjectPlaces: (work.subject_places ?? []).slice(0, MAX_SUBJECTS),
    subjectPeople: (work.subject_people ?? []).slice(0, MAX_SUBJECTS),
    subjectTimes: (work.subject_times ?? []).slice(0, MAX_SUBJECTS),
    editionCount: summary?.edition_count,
    pageCount: summary?.number_of_pages_median,
    ratingsAverage: summary?.ratings_average,
    ratingsCount: summary?.ratings_count,
    languages: summary?.language ?? [],
    links: (work.links ?? []).map((link) => ({
      title: link.title,
      url: link.url,
    })),
    mediaInfo: media,
  };
};

export const mapAuthorDetails = (
  author: OlAuthor
): Omit<AuthorDetails, 'works' | 'totalWorks'> => {
  const id = getOlId(author.key);

  return {
    id,
    olId: id,
    mediaType: 'author',
    name: author.name,
    bio: cleanDescription(getOlText(author.bio)),
    birthDate: author.birth_date,
    deathDate: author.death_date,
    profilePath: getAuthorPhotoUrl(
      author.photos?.find((photo) => photo > 0),
      'L'
    ),
    links: (author.links ?? []).map((link) => ({
      title: link.title,
      url: link.url,
    })),
    wikipedia: author.wikipedia,
  };
};
