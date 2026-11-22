import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddUnwatchedQuota1792910000000 implements MigrationInterface {
  name = 'AddUnwatchedQuota1792910000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "user" ADD COLUMN "unwatchedQuotaLimit" integer`
    );
    await queryRunner.query(
      `ALTER TABLE "user" ADD COLUMN "unwatchedQuotaDays" integer`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "user" DROP COLUMN "unwatchedQuotaDays"`
    );
    await queryRunner.query(
      `ALTER TABLE "user" DROP COLUMN "unwatchedQuotaLimit"`
    );
  }
}
