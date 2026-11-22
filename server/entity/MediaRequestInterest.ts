import { MediaRequest } from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import { DbAwareColumn } from '@server/utils/DbColumnHelper';
import {
  Entity,
  Index,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

/**
 * A user who asked to be told when someone else's request becomes
 * available ("Notify me too"). It is tied to the request, so it follows
 * the request's format, 4K or seasons, and goes away with it. It is not a
 * request of the user's own and does not count toward their quota.
 */
@Entity()
@Unique('UNIQUE_REQUEST_INTEREST', ['request', 'user'])
export class MediaRequestInterest {
  @PrimaryGeneratedColumn()
  public id: number;

  @ManyToOne(() => MediaRequest, { onDelete: 'CASCADE' })
  @Index('IDX_media_request_interest_request')
  public request: MediaRequest;

  @ManyToOne(() => User, { eager: true, onDelete: 'CASCADE' })
  @Index('IDX_media_request_interest_user')
  public user: User;

  @DbAwareColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  public createdAt: Date;

  constructor(init?: Partial<MediaRequestInterest>) {
    Object.assign(this, init);
  }
}

export default MediaRequestInterest;
