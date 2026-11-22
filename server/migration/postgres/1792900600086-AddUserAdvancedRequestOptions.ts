import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Null means every advanced request option, so users who already have
 * Advanced Requests keep all of them.
 */
export class AddUserAdvancedRequestOptions1792900600086 implements MigrationInterface {
  name = 'AddUserAdvancedRequestOptions1792900600086';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "user" ADD "advancedRequestOptions" integer`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "user" DROP COLUMN "advancedRequestOptions"`
    );
  }
}
