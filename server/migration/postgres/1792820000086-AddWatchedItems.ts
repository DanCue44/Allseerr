import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddWatchedItems1792820000086 implements MigrationInterface {
  name = 'AddWatchedItems1792820000086';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "watched_item" ("id" SERIAL NOT NULL, "mediaType" character varying NOT NULL, "tmdbId" integer NOT NULL, "viewCount" integer NOT NULL DEFAULT 0, "viewedLeafCount" integer NOT NULL DEFAULT 0, "leafCount" integer NOT NULL DEFAULT 0, "viewOffset" integer, "lastViewedAt" TIMESTAMP, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), "userId" integer, CONSTRAINT "UNIQUE_USER_WATCHED" UNIQUE ("userId", "mediaType", "tmdbId"), CONSTRAINT "PK_watched_item" PRIMARY KEY ("id"))`
    );
    await queryRunner.query(
      `ALTER TABLE "watched_item" ADD CONSTRAINT "FK_watched_item_user" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE NO ACTION`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_watched_item_user" ON "watched_item" ("userId") `
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_watched_item_tmdb" ON "watched_item" ("tmdbId") `
    );
    await queryRunner.query(
      `ALTER TABLE "user_settings" ADD "hideWatched" boolean`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "user_settings" DROP COLUMN "hideWatched"`
    );
    await queryRunner.query(`DROP INDEX "public"."IDX_watched_item_tmdb"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_watched_item_user"`);
    await queryRunner.query(
      `ALTER TABLE "watched_item" DROP CONSTRAINT "FK_watched_item_user"`
    );
    await queryRunner.query(`DROP TABLE "watched_item"`);
  }
}
