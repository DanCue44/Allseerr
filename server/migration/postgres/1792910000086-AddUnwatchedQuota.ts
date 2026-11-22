import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddUnwatchedQuota1792910000086 implements MigrationInterface {
  name = 'AddUnwatchedQuota1792910000086';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "user" ADD "unwatchedQuotaLimit" integer`
    );
    await queryRunner.query(
      `ALTER TABLE "user" ADD "unwatchedQuotaDays" integer`
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
