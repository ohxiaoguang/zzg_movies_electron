export const resonanceScenesMigration = {
  version: 17,
  sql: `CREATE TABLE resonance_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    document TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );`,
};
