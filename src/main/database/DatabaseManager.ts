import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { initialMigration } from './migrations/001_initial';
import { filmFilesMigration } from './migrations/002_film_files';
import { groupedFilmFilesRepairMigration } from './migrations/003_reconcile_grouped_film_files';
import { userEditedTaxonomyMigration } from './migrations/004_user_edited_taxonomy';
import { protectLegacyTaxonomyMigration } from './migrations/005_protect_legacy_taxonomy';
import { customCategoriesMigration } from './migrations/006_custom_categories';
import { sourceOriginalPreviewMigration } from './migrations/007_source_original_preview';
import { titleUserEditedMigration } from './migrations/008_title_user_edited';
import { parseFilmPartName } from '../scanner/PartNaming';
import type { AppLogger } from '../system/AppLogger';

export class DatabaseManager {
  public readonly db: Database.Database;

  public constructor(public readonly databasePath: string, private readonly logger?: AppLogger) {
    this.logger?.info('Database initialization started', { databasePath });
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.logger?.info('better-sqlite3 loaded', { module: 'better-sqlite3' });
    this.db = new Database(databasePath);
    this.db.function('filename_stem', { deterministic: true }, (filename: unknown) => (
      typeof filename === 'string' ? path.parse(filename).name : ''
    ));
    this.db.function('cd_group_key', { deterministic: true }, (filename: unknown) => {
      if (typeof filename !== 'string') return null;
      return parseFilmPartName(filename)?.baseName.normalize('NFKC').toLocaleLowerCase() ?? null;
    });
    this.db.function('cd_part_number', { deterministic: true }, (filename: unknown) => {
      if (typeof filename !== 'string') return null;
      return parseFilmPartName(filename)?.partNumber ?? null;
    });
    this.logger?.info('Database opened', { databasePath, open: this.db.open });
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.runMigrations();
  }

  public transaction<T>(operation: () => T): T {
    return this.db.transaction(operation)();
  }

  public close(): void {
    if (this.db.open) this.db.close();
  }

  public get schemaVersion(): number {
    return Number(this.db.pragma('user_version', { simple: true }));
  }

  public hasTable(tableName: string): boolean {
    const row = this.db
      .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(tableName) as { present?: number } | undefined;
    return row?.present === 1;
  }

  private runMigrations(): void {
    const currentVersion = this.schemaVersion;
    this.logger?.info('Database schema inspected', { version: currentVersion });
    const migrations = [initialMigration, filmFilesMigration, groupedFilmFilesRepairMigration, userEditedTaxonomyMigration, protectLegacyTaxonomyMigration, customCategoriesMigration, sourceOriginalPreviewMigration, titleUserEditedMigration];
    if (currentVersion >= migrations[migrations.length - 1].version) {
      this.logger?.info('Database schema ready', { version: currentVersion });
      return;
    }

    if (currentVersion > 0) {
      const backupPath = this.createRepairBackup();
      this.logger?.info('Database backup created before film-file repair', { backupPath });
    }

    this.transaction(() => {
      for (const migration of migrations) {
        if (migration.version <= currentVersion) continue;
        if ('sql' in migration) this.db.exec(migration.sql);
        else if (migration === groupedFilmFilesRepairMigration) {
          const report = groupedFilmFilesRepairMigration.run(this.db);
          this.logger?.info('Film-file repair completed', { ...report });
        } else migration.run(this.db);
        this.db.pragma(`user_version = ${migration.version}`);
        this.logger?.info('Database migration completed', { version: migration.version });
      }
    });
    this.logger?.info('Database schema ready', { version: this.schemaVersion });
  }

  private createRepairBackup(): string {
    const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
    let backupPath = path.join(path.dirname(this.databasePath), `film-library.backup-before-film-file-repair-${stamp}.db`);
    let suffix = 1;
    while (fs.existsSync(backupPath)) {
      backupPath = path.join(path.dirname(this.databasePath), `film-library.backup-before-film-file-repair-${stamp}-${suffix}.db`);
      suffix += 1;
    }
    const escaped = backupPath.replaceAll("'", "''");
    this.db.exec(`VACUUM INTO '${escaped}'`);
    const verification = new Database(backupPath, { readonly: true });
    try {
      const result = verification.pragma('integrity_check', { simple: true });
      if (result !== 'ok') throw new Error('DATABASE_BACKUP_INTEGRITY_FAILED');
    } finally {
      verification.close();
    }
    return backupPath;
  }
}
