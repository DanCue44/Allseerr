import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddUserBlockedGenres1792900500000 implements MigrationInterface {
  name = 'AddUserBlockedGenres1792900500000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "user" ADD COLUMN "blockedGenres" text`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "user" DROP COLUMN "blockedGenres"`);
  }
}
