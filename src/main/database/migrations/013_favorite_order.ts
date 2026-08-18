export const favoriteOrderMigration = {
  version: 13,
  sql: `
    ALTER TABLE film ADD COLUMN favorited_at TEXT;

    UPDATE film
    SET favorited_at = updated_at
    WHERE favorite = 1;

    CREATE INDEX idx_film_favorite_order
      ON film(favorite, favorited_at DESC);
  `,
};
