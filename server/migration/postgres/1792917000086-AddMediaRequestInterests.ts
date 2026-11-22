import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddMediaRequestInterests1792917000086 implements MigrationInterface {
  name = 'AddMediaRequestInterests1792917000086';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "media_request_interest" ("id" SERIAL NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "requestId" integer, "userId" integer, CONSTRAINT "UNIQUE_REQUEST_INTEREST" UNIQUE ("requestId", "userId"), CONSTRAINT "PK_media_request_interest" PRIMARY KEY ("id"))`
    );
    await queryRunner.query(
      `ALTER TABLE "media_request_interest" ADD CONSTRAINT "FK_media_request_interest_request" FOREIGN KEY ("requestId") REFERENCES "media_request"("id") ON DELETE CASCADE ON UPDATE NO ACTION`
    );
    await queryRunner.query(
      `ALTER TABLE "media_request_interest" ADD CONSTRAINT "FK_media_request_interest_user" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE NO ACTION`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_media_request_interest_request" ON "media_request_interest" ("requestId") `
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_media_request_interest_user" ON "media_request_interest" ("userId") `
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."IDX_media_request_interest_user"`
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_media_request_interest_request"`
    );
    await queryRunner.query(
      `ALTER TABLE "media_request_interest" DROP CONSTRAINT "FK_media_request_interest_user"`
    );
    await queryRunner.query(
      `ALTER TABLE "media_request_interest" DROP CONSTRAINT "FK_media_request_interest_request"`
    );
    await queryRunner.query(`DROP TABLE "media_request_interest"`);
  }
}
