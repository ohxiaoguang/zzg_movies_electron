import type Database from 'better-sqlite3';

export const userEditedTaxonomyMigration = {
  version: 4,
  run(db: Database.Database): void {
    db.exec(`
      ALTER TABLE film ADD COLUMN tags_user_edited INTEGER NOT NULL DEFAULT 0 CHECK (tags_user_edited IN (0, 1));
      ALTER TABLE film ADD COLUMN genres_user_edited INTEGER NOT NULL DEFAULT 0 CHECK (genres_user_edited IN (0, 1));
    `);
  },
};
