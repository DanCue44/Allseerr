import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddPlexTokenInvalidAt1792840000000 implements MigrationInterface {
  name = 'AddPlexTokenInvalidAt1792840000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "user" ADD COLUMN "plexTokenInvalidAt" datetime`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "user" DROP COLUMN "plexTokenInvalidAt"`
    );
  }
}
