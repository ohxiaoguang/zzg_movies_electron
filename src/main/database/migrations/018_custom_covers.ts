export const customCoversMigration = {
  version: 18,
  sql: `ALTER TABLE film_asset ADD COLUMN user_managed INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE film_asset ADD COLUMN custom_cover INTEGER NOT NULL DEFAULT 0;
        CREATE UNIQUE INDEX film_custom_cover ON film_asset(film_id) WHERE custom_cover = 1;`,
};
