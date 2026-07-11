import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type {
  CreateSourceInput,
  MediaSourceDto,
  RemoveSourceInput,
  UpdateSourceInput,
} from '../../../shared/contracts';

interface SourceRow {
  id: string;
  name: string;
  root_path: string;
  enabled: number;
  recursive: number;
  archived: number;
  created_at: string;
  updated_at: string;
  last_scan_at: string | null;
  last_scan_status: string | null;
}

export class SourceRepository {
  public constructor(private readonly db: Database.Database) {}

  public list(): MediaSourceDto[] {
    const rows = this.db
      .prepare('SELECT * FROM media_source ORDER BY archived ASC, name COLLATE NOCASE ASC')
      .all() as SourceRow[];
    return rows.map((row) => this.toDto(row));
  }

  public findById(id: string): MediaSourceDto | null {
    const row = this.db.prepare('SELECT * FROM media_source WHERE id = ?').get(id) as SourceRow | undefined;
    return row ? this.toDto(row) : null;
  }

  public create(input: CreateSourceInput): MediaSourceDto {
    const now = new Date().toISOString();
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO media_source
          (id, name, root_path, enabled, recursive, archived, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
      )
      .run(id, input.name, path.resolve(input.rootPath), input.enabled === false ? 0 : 1, input.recursive === false ? 0 : 1, now, now);
    return this.findById(id)!;
  }

  public update(input: UpdateSourceInput): MediaSourceDto {
    const existing = this.findById(input.id);
    if (!existing) throw new Error('SOURCE_NOT_FOUND');
    const name = input.name ?? existing.name;
    const rootPath = input.rootPath ? path.resolve(input.rootPath) : existing.rootPath;
    const enabled = input.enabled ?? existing.enabled;
    const recursive = input.recursive ?? existing.recursive;
    const updatedAt = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE media_source
         SET name = ?, root_path = ?, enabled = ?, recursive = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(name, rootPath, enabled ? 1 : 0, recursive ? 1 : 0, updatedAt, input.id);
    return this.findById(input.id)!;
  }

  public remove(input: RemoveSourceInput): void {
    const existing = this.findById(input.id);
    if (!existing) throw new Error('SOURCE_NOT_FOUND');
    if (input.mode === 'archive') {
      const now = new Date().toISOString();
      this.db
        .prepare('UPDATE media_source SET archived = 1, enabled = 0, updated_at = ? WHERE id = ?')
        .run(now, input.id);
      this.db.prepare('UPDATE film SET archived = 1, updated_at = ? WHERE source_id = ?').run(now, input.id);
      return;
    }
    this.db.prepare('DELETE FROM media_source WHERE id = ?').run(input.id);
  }

  public setScanResult(id: string, status: string, scannedAt: string | null): void {
    this.db
      .prepare('UPDATE media_source SET last_scan_status = ?, last_scan_at = ?, updated_at = ? WHERE id = ?')
      .run(status, scannedAt, new Date().toISOString(), id);
  }

  public isOnline(id: string): boolean {
    const source = this.findById(id);
    try {
      return Boolean(source && fs.statSync(source.rootPath).isDirectory());
    } catch {
      return false;
    }
  }

  private toDto(row: SourceRow): MediaSourceDto {
    return {
      id: row.id,
      name: row.name,
      rootPath: row.root_path,
      enabled: Boolean(row.enabled),
      recursive: Boolean(row.recursive),
      archived: Boolean(row.archived),
      online: isDirectory(row.root_path),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastScanAt: row.last_scan_at,
      lastScanStatus: row.last_scan_status,
    };
  }
}

function isDirectory(rootPath: string): boolean {
  try {
    return fs.statSync(rootPath).isDirectory();
  } catch {
    return false;
  }
}
