import type Database from 'better-sqlite3';

export const lanDeviceRolesMigration = {
  version: 10,
  run(db: Database.Database): void {
    db.exec(`
      ALTER TABLE lan_device
      ADD COLUMN role TEXT NOT NULL DEFAULT 'viewer'
      CHECK (role IN ('viewer', 'admin'));
    `);
  },
};
