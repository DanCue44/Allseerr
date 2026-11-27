import type { GrimmoryBook, GrimmoryFormat } from '@server/api/grimmory';
import GrimmoryAPI from '@server/api/grimmory';
import OpenLibrary from '@server/api/openlibrary';
import { MediaStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import {
  findGrimmoryBook,
  grimmoryServes,
  holdsGrimmoryFormat,
} from '@server/lib/grimmoryItem';
import type { GrimmorySettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { In } from 'typeorm';

const LABEL = 'Grimmory Scan';

const STATUS_KEYS = {
  ebook: 'status',
  audiobook: 'statusAudio',
} as const;

// Formats waiting for a file: requested, or approved and on their way
const WAITING = [MediaStatus.PENDING, MediaStatus.PROCESSING];

export interface GrimmoryScanResult {
  checked: number;
  available: number;
}

/**
 * The formats of a book that wait for a file and that Grimmory serves
 */
export const waitingFormats = (
  settings: GrimmorySettings,
  media: Media
): GrimmoryFormat[] =>
  (['ebook', 'audiobook'] as const).filter(
    (format) =>
      grimmoryServes(settings, format) &&
      WAITING.includes(media[STATUS_KEYS[format]])
  );

/**
 * Marks requested books available once Grimmory has them, for the formats
 * Grimmory serves. Grimmory knows nothing of OpenLibrary, so each waiting
 * book is matched by its title and authors, the same way book pages find
 * it. Saving the status completes the requests and tells the requesters.
 */
class GrimmoryScanner {
  public running = false;
  private cancelled = false;

  public status() {
    return { running: this.running };
  }

  public cancel(): void {
    this.cancelled = true;
  }

  public async run(): Promise<GrimmoryScanResult> {
    const settings = getSettings().grimmory;
    const result: GrimmoryScanResult = { checked: 0, available: 0 };

    if (
      this.running ||
      (!grimmoryServes(settings, 'ebook') &&
        !grimmoryServes(settings, 'audiobook'))
    ) {
      return result;
    }

    this.running = true;
    this.cancelled = false;

    try {
      const repository = getRepository(Media);
      const waiting = (
        await repository.find({
          where: [
            { mediaType: MediaType.BOOK, status: In(WAITING) },
            { mediaType: MediaType.BOOK, statusAudio: In(WAITING) },
          ],
        })
      ).filter(
        (media) => !!media.olId && waitingFormats(settings, media).length > 0
      );

      if (!waiting.length) {
        return result;
      }

      const library = await new GrimmoryAPI({
        url: settings.url ?? '',
        username: settings.username,
        password: settings.password,
      }).getAllBooks();
      const openLibrary = new OpenLibrary();

      for (const media of waiting) {
        if (this.cancelled) {
          break;
        }

        result.checked++;
        const summary = await openLibrary
          .getWorkSummary(media.olId as string)
          .catch(() => undefined);

        if (!summary?.title) {
          continue;
        }

        const book = {
          olId: media.olId as string,
          title: summary.title,
          authors: summary.author_name ?? [],
        };
        let changed = false;

        for (const format of waitingFormats(settings, media)) {
          const match = findGrimmoryBook(
            book,
            library.filter((item: GrimmoryBook) =>
              holdsGrimmoryFormat(settings, item, format)
            )
          );

          if (match) {
            media[STATUS_KEYS[format]] = MediaStatus.AVAILABLE;
            changed = true;
            logger.info('Grimmory has a requested book, marking it available', {
              label: LABEL,
              olId: media.olId,
              format,
              grimmoryBookId: match.id,
            });
          }
        }

        if (changed) {
          await repository.save(media);
          result.available++;
        }
      }

      return result;
    } catch (e) {
      logger.error('Grimmory scan failed', {
        label: LABEL,
        errorMessage: e.message,
      });
      return result;
    } finally {
      this.running = false;
    }
  }
}

export const grimmoryScanner = new GrimmoryScanner();
