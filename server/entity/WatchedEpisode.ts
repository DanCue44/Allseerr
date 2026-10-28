import { User } from '@server/entity/User';
import type { EpisodeCounts } from '@server/lib/watchedState';
import { DbAwareColumn, resolveDbType } from '@server/utils/DbColumnHelper';
import {
  Column,
  Entity,
  Index,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

/**
 * One episode a person has played or started on the media server, as their
 * own account there reports it. Only touched episodes have rows; the series
 * itself is summed up in WatchedItem.
 */
@Entity()
@Unique('UNIQUE_USER_WATCHED_EPISODE', [
  'user',
  'tmdbId',
  'seasonNumber',
  'episodeNumber',
])
class WatchedEpisode implements EpisodeCounts {
  @PrimaryGeneratedColumn()
  public id: number;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @Index('IDX_watched_episode_user')
  public user: User;

  /** The series on TMDB */
  @Column({ type: 'int' })
  @Index('IDX_watched_episode_tmdb')
  public tmdbId: number;

  @Column({ type: 'int' })
  public seasonNumber: number;

  @Column({ type: 'int' })
  public episodeNumber: number;

  @Column({ type: 'int', default: 0 })
  public viewCount: number;

  /** How far in, in milliseconds, when left part way */
  @Column({ type: 'int', nullable: true })
  public viewOffset: number | null;

  /** The episode's length in milliseconds */
  @Column({ type: 'int', nullable: true })
  public duration: number | null;

  @DbAwareColumn({ type: 'datetime', nullable: true })
  public lastViewedAt: Date | null;

  @DbAwareColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  public createdAt: Date;

  @UpdateDateColumn({
    type: resolveDbType('datetime'),
    default: () => 'CURRENT_TIMESTAMP',
  })
  public updatedAt: Date;

  constructor(init?: Partial<WatchedEpisode>) {
    Object.assign(this, init);
  }

  public assign(counts: EpisodeCounts): void {
    this.viewCount = counts.viewCount;
    this.viewOffset = counts.viewOffset;
    this.duration = counts.duration;
    this.lastViewedAt = counts.lastViewedAt;
  }
}

export default WatchedEpisode;
