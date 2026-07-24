export const lanDevicesMigration = {
  version: 9,
  sql: `
    CREATE TABLE lan_device (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      last_used_at TEXT,
      revoked_at TEXT
    );

    CREATE INDEX idx_lan_device_active_token
      ON lan_device(token_hash)
      WHERE revoked_at IS NULL;
  `,
};
