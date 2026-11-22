import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddOidcSubjectToUser1792893170086 implements MigrationInterface {
  name = 'AddOidcSubjectToUser1792893170086';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "user" ADD "oidcSubject" character varying`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_bdbe0fa2960410a0291e8db97a" ON "user" ("oidcSubject") `
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."IDX_bdbe0fa2960410a0291e8db97a"`
    );
    await queryRunner.query(`ALTER TABLE "user" DROP COLUMN "oidcSubject"`);
  }
}
