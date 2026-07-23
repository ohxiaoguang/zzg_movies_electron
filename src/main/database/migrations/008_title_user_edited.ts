import type Database from 'better-sqlite3';

export const titleUserEditedMigration = {
  version: 8,
  run(db: Database.Database): void {
    db.exec(`
      ALTER TABLE film
      ADD COLUMN title_user_edited INTEGER NOT NULL DEFAULT 0
      CHECK (title_user_edited IN (0, 1));

      UPDATE film
      SET title_user_edited = 1
      WHERE nfo_status = 'ok'
         OR TRIM(title) <> TRIM(COALESCE(sort_title, ''));
    `);
  },
};
