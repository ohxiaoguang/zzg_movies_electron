export const initialMigration = {
  version: 1,
  sql: `
    CREATE TABLE media_source (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      root_path TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
      recursive INTEGER NOT NULL DEFAULT 1 CHECK (recursive IN (0, 1)),
      archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_scan_at TEXT,
      last_scan_status TEXT
    );

    CREATE TABLE film (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL REFERENCES media_source(id) ON DELETE CASCADE,
      relative_path TEXT NOT NULL,
      filename TEXT NOT NULL,
      file_size INTEGER NOT NULL DEFAULT 0,
      file_modified_at TEXT,
      fingerprint TEXT,
      title TEXT NOT NULL,
      original_title TEXT,
      sort_title TEXT,
      year INTEGER,
      release_date TEXT,
      runtime_seconds INTEGER,
      plot TEXT,
      outline TEXT,
      tagline TEXT,
      content_rating TEXT,
      studio TEXT,
      country_json TEXT NOT NULL DEFAULT '[]',
      director_json TEXT NOT NULL DEFAULT '[]',
      actors_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'unorganized',
      favorite INTEGER NOT NULL DEFAULT 0 CHECK (favorite IN (0, 1)),
      rating REAL NOT NULL DEFAULT 0,
      notes TEXT NOT NULL DEFAULT '',
      width INTEGER,
      height INTEGER,
      video_codec TEXT,
      audio_codec TEXT,
      container_format TEXT,
      nfo_relative_path TEXT,
      nfo_modified_at TEXT,
      nfo_hash TEXT,
      nfo_status TEXT NOT NULL DEFAULT 'missing',
      nfo_error TEXT,
      missing INTEGER NOT NULL DEFAULT 0 CHECK (missing IN (0, 1)),
      archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
      imported_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_seen_at TEXT,
      UNIQUE(source_id, relative_path)
    );

    CREATE TABLE tag (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE
    );

    CREATE TABLE film_tag (
      film_id TEXT NOT NULL REFERENCES film(id) ON DELETE CASCADE,
      tag_id TEXT NOT NULL REFERENCES tag(id) ON DELETE CASCADE,
      PRIMARY KEY (film_id, tag_id)
    );

    CREATE TABLE genre (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE
    );

    CREATE TABLE film_genre (
      film_id TEXT NOT NULL REFERENCES film(id) ON DELETE CASCADE,
      genre_id TEXT NOT NULL REFERENCES genre(id) ON DELETE CASCADE,
      PRIMARY KEY (film_id, genre_id)
    );

    CREATE TABLE film_asset (
      id TEXT PRIMARY KEY,
      film_id TEXT NOT NULL REFERENCES film(id) ON DELETE CASCADE,
      asset_type TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      file_size INTEGER,
      file_modified_at TEXT,
      missing INTEGER NOT NULL DEFAULT 0 CHECK (missing IN (0, 1))
    );

    CREATE TABLE scan_job (
      id TEXT PRIMARY KEY,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      status TEXT NOT NULL,
      source_count INTEGER NOT NULL DEFAULT 0,
      created_count INTEGER NOT NULL DEFAULT 0,
      updated_count INTEGER NOT NULL DEFAULT 0,
      moved_count INTEGER NOT NULL DEFAULT 0,
      missing_count INTEGER NOT NULL DEFAULT 0,
      error_count INTEGER NOT NULL DEFAULT 0,
      cancelled INTEGER NOT NULL DEFAULT 0 CHECK (cancelled IN (0, 1)),
      scan_error TEXT
    );

    CREATE TABLE scan_error (
      id TEXT PRIMARY KEY,
      scan_job_id TEXT NOT NULL REFERENCES scan_job(id) ON DELETE CASCADE,
      source_id TEXT REFERENCES media_source(id) ON DELETE SET NULL,
      relative_path TEXT,
      error_type TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE app_setting (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL
    );

    CREATE INDEX idx_film_source ON film(source_id);
    CREATE INDEX idx_film_missing ON film(missing);
    CREATE INDEX idx_film_status ON film(status);
    CREATE INDEX idx_film_updated ON film(updated_at);
    CREATE INDEX idx_film_asset_film_type ON film_asset(film_id, asset_type, sort_order);
    CREATE INDEX idx_scan_error_job ON scan_error(scan_job_id);
  `,
};
