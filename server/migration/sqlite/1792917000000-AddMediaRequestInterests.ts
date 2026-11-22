import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddMediaRequestInterests1792917000000 implements MigrationInterface {
  name = 'AddMediaRequestInterests1792917000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "media_request_interest" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "createdAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), "requestId" integer, "userId" integer, CONSTRAINT "UNIQUE_REQUEST_INTEREST" UNIQUE ("requestId", "userId"), CONSTRAINT "FK_media_request_interest_request" FOREIGN KEY ("requestId") REFERENCES "media_request" ("id") ON DELETE CASCADE ON UPDATE NO ACTION, CONSTRAINT "FK_media_request_interest_user" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE NO ACTION)`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_media_request_interest_request" ON "media_request_interest" ("requestId") `
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_media_request_interest_user" ON "media_request_interest" ("userId") `
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_media_request_interest_user"`);
    await queryRunner.query(`DROP INDEX "IDX_media_request_interest_request"`);
    await queryRunner.query(`DROP TABLE "media_request_interest"`);
  }
}
