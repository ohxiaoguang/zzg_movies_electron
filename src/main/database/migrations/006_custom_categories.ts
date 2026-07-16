import type Database from 'better-sqlite3';

export const customCategoriesMigration = {
  version: 6,
  run(db: Database.Database): void {
    db.exec(`
      CREATE TABLE custom_category (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        normalized_name TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE UNIQUE INDEX idx_custom_category_normalized_name
      ON custom_category(normalized_name);

      CREATE TABLE film_custom_category (
        film_id TEXT NOT NULL,
        category_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (film_id, category_id),
        FOREIGN KEY (film_id) REFERENCES film(id) ON DELETE CASCADE,
        FOREIGN KEY (category_id) REFERENCES custom_category(id) ON DELETE CASCADE
      );

      CREATE INDEX idx_film_custom_category_category
      ON film_custom_category(category_id, film_id);
    `);
  },
};
