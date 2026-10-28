import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddPlexTokenInvalidAt1792840000086 implements MigrationInterface {
  name = 'AddPlexTokenInvalidAt1792840000086';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "user" ADD "plexTokenInvalidAt" TIMESTAMP`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "user" DROP COLUMN "plexTokenInvalidAt"`
    );
  }
}
