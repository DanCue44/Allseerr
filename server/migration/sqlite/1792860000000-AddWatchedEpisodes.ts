import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddWatchedEpisodes1792860000000 implements MigrationInterface {
  name = 'AddWatchedEpisodes1792860000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "watched_episode" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "tmdbId" integer NOT NULL, "seasonNumber" integer NOT NULL, "episodeNumber" integer NOT NULL, "viewCount" integer NOT NULL DEFAULT (0), "viewOffset" integer, "duration" integer, "lastViewedAt" datetime, "createdAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), "updatedAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), "userId" integer, CONSTRAINT "UNIQUE_USER_WATCHED_EPISODE" UNIQUE ("userId", "tmdbId", "seasonNumber", "episodeNumber"), CONSTRAINT "FK_watched_episode_user" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE NO ACTION)`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_watched_episode_user" ON "watched_episode" ("userId") `
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_watched_episode_tmdb" ON "watched_episode" ("tmdbId") `
    );
    await queryRunner.query(
      `ALTER TABLE "watched_item" ADD COLUMN "duration" integer`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "watched_item" DROP COLUMN "duration"`
    );
    await queryRunner.query(`DROP INDEX "IDX_watched_episode_tmdb"`);
    await queryRunner.query(`DROP INDEX "IDX_watched_episode_user"`);
    await queryRunner.query(`DROP TABLE "watched_episode"`);
  }
}
