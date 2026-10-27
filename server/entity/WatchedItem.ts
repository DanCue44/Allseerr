import { MediaType } from '@server/constants/media';
import { UserType } from '@server/constants/user';
import { getRepository } from '@server/datasource';
import type Media from '@server/entity/Media';
import { User } from '@server/entity/User';
import type { WatchedCounts } from '@server/lib/watchedState';
import { watchedState } from '@server/lib/watchedState';
import logger from '@server/logger';
import { DbAwareColumn, resolveDbType } from '@server/utils/DbColumnHelper';
import {
  Column,
  Entity,
  In,
  Index,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

/**
 * What one person has watched of a movie or series on the media server, as
 * their own account there reports it. Filled by the watched sync and when a
 * title is marked watched here; a title never touched has no row.
 */
@Entity()
@Unique('UNIQUE_USER_WATCHED', ['user', 'mediaType', 'tmdbId'])
class WatchedItem implements WatchedCounts {
  /**
   * Puts the person's watched state on each movie and series, so cards and
   * pages can show it. Only people with a media server account get one:
   * a local account has nothing to ask the server with.
   */
  public static async attach(
    user: User | undefined,
    media: Media[]
  ): Promise<void> {
    if (!user || user.userType === UserType.LOCAL) {
      return;
    }

    const titles = media.filter(
      (m) =>
        (m.mediaType === MediaType.MOVIE || m.mediaType === MediaType.TV) &&
        m.tmdbId != null
    );

    if (titles.length === 0) {
      return;
    }

    try {
      const rows = await getRepository(WatchedItem).find({
        where: {
          user: { id: user.id },
          tmdbId: In([...new Set(titles.map((m) => m.tmdbId as number))]),
        },
      });

      for (const m of titles) {
        const row = rows.find(
          (r) => r.tmdbId === m.tmdbId && r.mediaType === m.mediaType
        );
        m.watched = watchedState(row, m.mediaType);
      }
    } catch (e) {
      logger.debug('Could not load watched state', {
        label: 'Watched',
        errorMessage: e.message,
      });
    }
  }

  @PrimaryGeneratedColumn()
  public id: number;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @Index('IDX_watched_item_user')
  public user: User;

  @Column({ type: 'varchar' })
  public mediaType: MediaType;

  @Column({ type: 'int' })
  @Index('IDX_watched_item_tmdb')
  public tmdbId: number;

  @Column({ type: 'int', default: 0 })
  public viewCount: number;

  @Column({ type: 'int', default: 0 })
  public viewedLeafCount: number;

  @Column({ type: 'int', default: 0 })
  public leafCount: number;

  @Column({ type: 'int', nullable: true })
  public viewOffset: number | null;

  @DbAwareColumn({ type: 'datetime', nullable: true })
  public lastViewedAt: Date | null;

  @DbAwareColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  public createdAt: Date;

  @UpdateDateColumn({
    type: resolveDbType('datetime'),
    default: () => 'CURRENT_TIMESTAMP',
  })
  public updatedAt: Date;

  constructor(init?: Partial<WatchedItem>) {
    Object.assign(this, init);
  }

  public assign(counts: WatchedCounts): void {
    this.viewCount = counts.viewCount;
    this.viewedLeafCount = counts.viewedLeafCount;
    this.leafCount = counts.leafCount;
    this.viewOffset = counts.viewOffset;
    this.lastViewedAt = counts.lastViewedAt;
  }
}

export default WatchedItem;
