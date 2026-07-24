export const filmPlaybackStateMigration = {
  version: 11,
  sql: `
    CREATE TABLE film_playback_state (
      film_id TEXT PRIMARY KEY
        REFERENCES film(id) ON DELETE CASCADE,
      last_part_id TEXT
        REFERENCES film_file(id) ON DELETE SET NULL,
      position_seconds REAL NOT NULL DEFAULT 0
        CHECK (position_seconds >= 0),
      duration_seconds REAL
        CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
      last_played_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX idx_film_playback_state_last_played
      ON film_playback_state(last_played_at DESC);
  `,
};
