import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddWatchedItems1792820000000 implements MigrationInterface {
  name = 'AddWatchedItems1792820000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "watched_item" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "mediaType" varchar NOT NULL, "tmdbId" integer NOT NULL, "viewCount" integer NOT NULL DEFAULT (0), "viewedLeafCount" integer NOT NULL DEFAULT (0), "leafCount" integer NOT NULL DEFAULT (0), "viewOffset" integer, "lastViewedAt" datetime, "createdAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), "updatedAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), "userId" integer, CONSTRAINT "UNIQUE_USER_WATCHED" UNIQUE ("userId", "mediaType", "tmdbId"), CONSTRAINT "FK_watched_item_user" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE NO ACTION)`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_watched_item_user" ON "watched_item" ("userId") `
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_watched_item_tmdb" ON "watched_item" ("tmdbId") `
    );
    await queryRunner.query(
      `ALTER TABLE "user_settings" ADD COLUMN "hideWatched" boolean`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "user_settings" DROP COLUMN "hideWatched"`
    );
    await queryRunner.query(`DROP INDEX "IDX_watched_item_tmdb"`);
    await queryRunner.query(`DROP INDEX "IDX_watched_item_user"`);
    await queryRunner.query(`DROP TABLE "watched_item"`);
  }
}
