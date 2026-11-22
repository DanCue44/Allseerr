import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddRequestNotFound1792917100086 implements MigrationInterface {
  name = 'AddRequestNotFound1792917100086';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "media_request" ADD "notFoundAt" TIMESTAMP WITH TIME ZONE`
    );
    await queryRunner.query(
      `ALTER TABLE "media_request" ADD "notFoundReason" text`
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
