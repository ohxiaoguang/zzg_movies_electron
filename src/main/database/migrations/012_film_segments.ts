export const filmSegmentsMigration = {
  version: 12,
  sql: `
    CREATE TABLE film_segment (
      id TEXT PRIMARY KEY,
      film_id TEXT NOT NULL
        REFERENCES film(id) ON DELETE CASCADE,
      film_file_id TEXT NOT NULL
        REFERENCES film_file(id) ON DELETE CASCADE,
      start_seconds REAL NOT NULL
        CHECK (start_seconds >= 0),
      end_seconds REAL NOT NULL
        CHECK (end_seconds > start_seconds),
      title TEXT NOT NULL DEFAULT '',
      comment TEXT NOT NULL DEFAULT '',
      include_in_preview INTEGER NOT NULL DEFAULT 1
        CHECK (include_in_preview IN (0, 1)),
      sort_order INTEGER NOT NULL DEFAULT 0,
      source_file_size INTEGER NOT NULL DEFAULT 0,
      source_file_modified_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX idx_film_segment_film_order
      ON film_segment(film_id, sort_order, start_seconds);
    CREATE INDEX idx_film_segment_file_time
      ON film_segment(film_file_id, start_seconds, end_seconds);
  `,
};
