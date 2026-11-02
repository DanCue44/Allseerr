import { DbAwareColumn, resolveDbType } from '@server/utils/DbColumnHelper';
import {
  Column,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

/**
 * What the Chaptarr full scan found out about a library book that has no
 * OpenLibrary work id: the work its title and author matched, or when to
 * look again. Kept so a large library is looked up over a few nights and
 * a restart does not look every book up again.
 */
@Entity()
@Unique('UQ_chaptarr_book_match_foreign', ['foreignBookId'])
class ChaptarrBookMatch {
  @PrimaryGeneratedColumn()
  public id: number;

  // Chaptarr's work id, shared by the ebook and the audiobook of a book
  @Column()
  public foreignBookId: string;

  // The title and author the lookup used, a change looks the book up again
  @Column()
  public title: string;

  @Column({ type: 'varchar', nullable: true })
  public author?: string | null;

  @Column({ type: 'varchar', nullable: true })
  @Index('IDX_chaptarr_book_match_ol')
  public olId?: string | null;

  // Lookups that found nothing
  @Column({ type: 'int', default: 0 })
  public attempts: number;

  @DbAwareColumn({ type: 'datetime', nullable: true })
  public retryAfter?: Date | null;

  @DbAwareColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  public createdAt: Date;

  @UpdateDateColumn({
    type: resolveDbType('datetime'),
    default: () => 'CURRENT_TIMESTAMP',
  })
  public updatedAt: Date;

  constructor(init?: Partial<ChaptarrBookMatch>) {
    Object.assign(this, init);
  }
}

export default ChaptarrBookMatch;
