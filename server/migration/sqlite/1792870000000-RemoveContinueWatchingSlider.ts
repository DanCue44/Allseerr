import type { MigrationInterface, QueryRunner } from 'typeorm';

/** A home row built and dropped before any release; staging had seeded it */
export class RemoveContinueWatchingSlider1792870000000 implements MigrationInterface {
  name = 'RemoveContinueWatchingSlider1792870000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "discover_slider" WHERE "type" = 32`);
  }

  public async down(): Promise<void> {
    // Nothing to put back
  }
}
