import type Database from 'better-sqlite3';

/**
 * Old databases cannot tell whether an existing taxonomy relation came from
 * NFO or a manual edit. Protect every pre-v4 film conservatively; users can
 * explicitly choose force-replace NFO import to opt that film back in.
 */
export const protectLegacyTaxonomyMigration = {
  version: 5,
  run(db: Database.Database): void {
    db.prepare('UPDATE film SET tags_user_edited = 1, genres_user_edited = 1').run();
  },
};
