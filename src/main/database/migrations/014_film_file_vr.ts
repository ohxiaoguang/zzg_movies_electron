export const filmFileVrMigration = {
  version: 14,
  sql: `
    ALTER TABLE film_file
      ADD COLUMN is_vr INTEGER NOT NULL DEFAULT 0 CHECK (is_vr IN (0, 1));
  `,
};
