import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

export const filmFilesMigration = {
  version: 2,
  run(db: Database.Database): void {
    db.exec(`
      ALTER TABLE media_source ADD COLUMN deleted_at TEXT;

      CREATE TABLE film_file (
        id TEXT PRIMARY KEY,
        film_id TEXT NOT NULL REFERENCES film(id) ON DELETE CASCADE,
        source_id TEXT NOT NULL REFERENCES media_source(id),
        relative_path TEXT NOT NULL,
        filename TEXT NOT NULL,
        part_type TEXT NOT NULL DEFAULT 'single' CHECK (part_type IN ('single', 'cd', 'disc')),
        part_number INTEGER NOT NULL DEFAULT 1 CHECK (part_number > 0),
        is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
        file_size INTEGER NOT NULL DEFAULT 0,
        file_modified_at TEXT,
        fingerprint TEXT,
        missing INTEGER NOT NULL DEFAULT 0 CHECK (missing IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(source_id, relative_path)
      );

      CREATE INDEX idx_film_file_film_part ON film_file(film_id, part_number, filename);
      CREATE INDEX idx_film_file_fingerprint ON film_file(source_id, fingerprint);
      CREATE INDEX idx_film_file_missing ON film_file(source_id, missing);
    `);

    const rows = db.prepare(
      `SELECT id, source_id, relative_path, filename, file_size, file_modified_at,
              fingerprint, missing, imported_at, updated_at
       FROM film`,
    ).all() as Array<{
      id: string;
      source_id: string;
      relative_path: string;
      filename: string;
      file_size: number;
      file_modified_at: string | null;
      fingerprint: string | null;
      missing: number;
      imported_at: string;
      updated_at: string;
    }>;
    const insert = db.prepare(
      `INSERT INTO film_file
       (id, film_id, source_id, relative_path, filename, part_type, part_number, is_primary,
        file_size, file_modified_at, fingerprint, missing, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'single', 1, 1, ?, ?, ?, ?, ?, ?)`,
    );
    for (const row of rows) {
      insert.run(
        randomUUID(),
        row.id,
        row.source_id,
        row.relative_path,
        row.filename,
        row.file_size,
        row.file_modified_at,
        row.fingerprint,
        row.missing ? 1 : 0,
        row.imported_at,
        row.updated_at,
      );
    }
  },
};
