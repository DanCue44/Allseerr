import type ChaptarrAPI from '@server/api/servarr/chaptarr';
import type {
  ChaptarrBook,
  ChaptarrMediaType,
} from '@server/api/servarr/chaptarr';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import MediaRequest from '@server/entity/MediaRequest';
import { isSameBookTitle } from '@server/lib/chaptarrRequests';
import logger from '@server/logger';
import { requestErrorLogFields } from '@server/utils/requestError';
import { In, IsNull } from 'typeorm';

const STATUS_KEYS = {
  ebook: 'status',
  audiobook: 'statusAudio',
} as const;

const BOOK_ID_KEYS = {
  ebook: 'externalServiceId',
  audiobook: 'externalServiceIdAudio',
} as const;

const FORMATS: ChaptarrMediaType[] = ['ebook', 'audiobook'];

const LABEL = 'Chaptarr Scan';

/**
 * Whether a Chaptarr book has its file: present, gone, or unknown when
 * Chaptarr did not say. Only a file count of zero, or hasFiles set to
 * false, counts as gone.
 */
export const getChaptarrFileState = (
  book: ChaptarrBook
): 'present' | 'gone' | 'unknown' => {
  const count = book.statistics?.bookFileCount;

  if (typeof count === 'number') {
    return count > 0 ? 'present' : 'gone';
  }

  if (typeof book.hasFiles === 'boolean') {
    return book.hasFiles ? 'present' : 'gone';
  }

  return 'unknown';
};

/**
 * The format a Chaptarr book holds. Readarr books have none and count as
 * either format.
 */
const holdsFormat = (book: ChaptarrBook, format: ChaptarrMediaType) =>
  !book.mediaType || book.mediaType === format;

export type ChaptarrFormatCheck =
  | { state: 'present' }
  | { state: 'gone' }
  | { state: 'unknown' }
  // Chaptarr has the file under another book of the same work
  | { state: 'moved'; bookId: number };

/**
 * Tells whether Chaptarr still has the file of one format of a book. The
 * library listing only nominates a format: a book missing from it or
 * listed without files is read again by its id, and only a missing book
 * (404) or one Chaptarr says has no files is gone. Any error, or a book
 * of the other format, leaves the format alone. A file kept under another
 * book of the same work and format moves the link there instead.
 */
export const checkChaptarrFormat = async (
  chaptarr: ChaptarrAPI,
  media: Media,
  format: ChaptarrMediaType,
  library: Map<number, ChaptarrBook>,
  books: ChaptarrBook[]
): Promise<ChaptarrFormatCheck> => {
  const bookId = media[BOOK_ID_KEYS[format]];

  if (!bookId) {
    return { state: 'unknown' };
  }

  const listed = library.get(bookId);

  if (listed && !holdsFormat(listed, format)) {
    return { state: 'unknown' };
  }

  if (listed && getChaptarrFileState(listed) !== 'gone') {
    return { state: getChaptarrFileState(listed) };
  }

  // Throws on anything but a 404, which keeps the format as it is
  const fresh = await chaptarr.getBook(bookId);

  if (fresh) {
    if (!holdsFormat(fresh, format)) {
      return { state: 'unknown' };
    }

    const state = getChaptarrFileState(fresh);

    if (state !== 'gone') {
      return { state };
    }
  }

  // Chaptarr can also hold the same book twice under its author, as
  // editions from different metadata sources with their own work ids
  const linked = fresh ?? listed;
  const isCopy = (book: ChaptarrBook) =>
    (!!media.foreignBookId && book.foreignBookId === media.foreignBookId) ||
    (!!linked?.authorId &&
      book.authorId === linked.authorId &&
      isSameBookTitle(book.title, linked.title));
  const copy = books.find(
    (book) =>
      !!book.id &&
      book.id !== bookId &&
      (book.mediaType ?? 'ebook') === format &&
      getChaptarrFileState(book) === 'present' &&
      isCopy(book)
  );

  if (copy?.id) {
    return { state: 'moved', bookId: copy.id };
  }

  return { state: 'gone' };
};

/**
 * Resets one format of a book whose file Chaptarr no longer has, the way
 * the availability sync resets movies and shows: the format is marked
 * deleted, which completes its approved requests, and its Chaptarr book
 * id is cleared unless an approved request for it is still in flight.
 * The server id is shared by both formats and is only cleared once
 * neither has a book id.
 */
export const resetChaptarrFormat = async (
  media: Media,
  format: ChaptarrMediaType
): Promise<void> => {
  const inFlight = await getRepository(MediaRequest).exist({
    where: {
      media: { id: media.id },
      status: MediaRequestStatus.APPROVED,
      isAudiobook: format === 'audiobook',
      recording: IsNull(),
    },
  });
  const bookId = media[BOOK_ID_KEYS[format]];

  media[STATUS_KEYS[format]] = MediaStatus.DELETED;

  if (!inFlight) {
    media[BOOK_ID_KEYS[format]] = null;

    if (!media.externalServiceId && !media.externalServiceIdAudio) {
      media.serviceId = null;
    }
  }

  await getRepository(Media).save(media);

  logger.info(
    `Chaptarr no longer has the ${format} of a book. Status changed to deleted.`,
    {
      label: LABEL,
      mediaId: media.id,
      olId: media.olId,
      format,
      bookId,
      keptServiceData: inFlight,
    }
  );
};

/**
 * Resets the available formats of books whose files Chaptarr no longer
 * has. Runs only on a complete, non-empty library listing; Chaptarr
 * failing to list its books ends the scan before this. Each format is
 * checked on its own, and a format that cannot be checked is kept.
 */
export const syncChaptarrAvailability = async (
  chaptarr: ChaptarrAPI,
  serverIds: number[],
  books: ChaptarrBook[],
  isRunning: () => boolean = () => true
): Promise<void> => {
  if (books.length === 0) {
    logger.info('Chaptarr listed no books, skipping its availability check', {
      label: LABEL,
    });
    return;
  }

  const library = new Map(
    books.filter((book) => !!book.id).map((book) => [book.id as number, book])
  );
  const available = await getRepository(Media).find({
    where: [
      {
        mediaType: MediaType.BOOK,
        serviceId: In(serverIds),
        status: MediaStatus.AVAILABLE,
      },
      {
        mediaType: MediaType.BOOK,
        serviceId: In(serverIds),
        statusAudio: MediaStatus.AVAILABLE,
      },
    ],
  });

  for (const media of available) {
    if (!isRunning()) {
      return;
    }

    for (const format of FORMATS) {
      if (
        media[STATUS_KEYS[format]] !== MediaStatus.AVAILABLE ||
        !media[BOOK_ID_KEYS[format]]
      ) {
        continue;
      }

      try {
        const check = await checkChaptarrFormat(
          chaptarr,
          media,
          format,
          library,
          books
        );

        if (check.state === 'moved') {
          await getRepository(Media).update(media.id, {
            [BOOK_ID_KEYS[format]]: check.bookId,
          });
          media[BOOK_ID_KEYS[format]] = check.bookId;
          logger.info('Linked a book to the Chaptarr book holding its file', {
            label: LABEL,
            mediaId: media.id,
            format,
            bookId: check.bookId,
          });
        } else if (check.state === 'gone') {
          await resetChaptarrFormat(media, format);
        }
      } catch (e) {
        logger.debug('Could not check a book in Chaptarr, keeping it', {
          label: LABEL,
          mediaId: media.id,
          format,
          ...requestErrorLogFields(e),
        });
      }
    }
  }
};
