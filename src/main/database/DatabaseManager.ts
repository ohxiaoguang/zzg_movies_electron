import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { initialMigration } from './migrations/001_initial';
import type { AppLogger } from '../system/AppLogger';

export class DatabaseManager {
  public readonly db: Database.Database;

  public constructor(public readonly databasePath: string, private readonly logger?: AppLogger) {
    this.logger?.info('Database initialization started', { databasePath });
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.logger?.info('better-sqlite3 loaded', { module: 'better-sqlite3' });
    this.db = new Database(databasePath);
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
    if (currentVersion >= initialMigration.version) {
      this.logger?.info('Database schema ready', { version: currentVersion });
      return;
    }

    this.transaction(() => {
      this.db.exec(initialMigration.sql);
      this.db.pragma(`user_version = ${initialMigration.version}`);
    });
    this.logger?.info('Database migration completed', { version: initialMigration.version });
    this.logger?.info('Database schema ready', { version: this.schemaVersion });
  }
}
