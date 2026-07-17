export const sourceOriginalPreviewMigration = {
  version: 7,
  sql: `
    ALTER TABLE media_source
    ADD COLUMN allow_original_preview INTEGER NOT NULL DEFAULT 0
    CHECK (allow_original_preview IN (0, 1));
  `,
};
