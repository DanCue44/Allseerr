import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddChaptarrBookMatches1792880000000 implements MigrationInterface {
  name = 'AddChaptarrBookMatches1792880000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "chaptarr_book_match" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "foreignBookId" varchar NOT NULL, "title" varchar NOT NULL, "author" varchar, "olId" varchar, "attempts" integer NOT NULL DEFAULT (0), "retryAfter" datetime, "createdAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), "updatedAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), CONSTRAINT "UQ_chaptarr_book_match_foreign" UNIQUE ("foreignBookId"))`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_chaptarr_book_match_ol" ON "chaptarr_book_match" ("olId") `
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_chaptarr_book_match_ol"`);
    await queryRunner.query(`DROP TABLE "chaptarr_book_match"`);
  }
}
