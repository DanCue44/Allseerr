import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Null means every advanced request option, so users who already have
 * Advanced Requests keep all of them.
 */
export class AddUserAdvancedRequestOptions1792900600000 implements MigrationInterface {
  name = 'AddUserAdvancedRequestOptions1792900600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "user" ADD COLUMN "advancedRequestOptions" integer`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "user" DROP COLUMN "advancedRequestOptions"`
    );
  }
}
