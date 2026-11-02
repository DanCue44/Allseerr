import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddChaptarrBookMatches1792880000086 implements MigrationInterface {
  name = 'AddChaptarrBookMatches1792880000086';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "chaptarr_book_match" ("id" SERIAL NOT NULL, "foreignBookId" character varying NOT NULL, "title" character varying NOT NULL, "author" character varying, "olId" character varying, "attempts" integer NOT NULL DEFAULT 0, "retryAfter" TIMESTAMP, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_chaptarr_book_match_foreign" UNIQUE ("foreignBookId"), CONSTRAINT "PK_chaptarr_book_match" PRIMARY KEY ("id"))`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_chaptarr_book_match_ol" ON "chaptarr_book_match" ("olId") `
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."IDX_chaptarr_book_match_ol"`);
    await queryRunner.query(`DROP TABLE "chaptarr_book_match"`);
  }
}
