import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddRequestNotFound1792917100000 implements MigrationInterface {
  name = 'AddRequestNotFound1792917100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "media_request" ADD COLUMN "notFoundAt" datetime`
    );
    await queryRunner.query(
      `ALTER TABLE "media_request" ADD COLUMN "notFoundReason" text`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "media_request" DROP COLUMN "notFoundReason"`
    );
    await queryRunner.query(
      `ALTER TABLE "media_request" DROP COLUMN "notFoundAt"`
    );
  }
}
