import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { LanDeviceRole, LanPairedDeviceDto } from '../../../shared/contracts';

interface LanDeviceRow {
  id: string;
  name: string;
  token_hash: string;
  role: LanDeviceRole;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export class LanDeviceRepository {
  public constructor(private readonly db: Database.Database) {}

  public create(name: string, tokenHash: string, role: LanDeviceRole): LanPairedDeviceDto {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(
      `INSERT INTO lan_device (id, name, token_hash, role, created_at, last_used_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL)`,
    ).run(id, normalizeDeviceName(name), tokenHash, role, now);
    return this.findById(id)!;
  }

  public findActiveByTokenHash(tokenHash: string): LanPairedDeviceDto | null {
    const row = this.db.prepare(
      'SELECT * FROM lan_device WHERE token_hash = ? AND revoked_at IS NULL',
    ).get(tokenHash) as LanDeviceRow | undefined;
    return row ? toDto(row) : null;
  }

  public list(): LanPairedDeviceDto[] {
    return (this.db.prepare(
      'SELECT * FROM lan_device ORDER BY revoked_at IS NOT NULL, created_at DESC, id',
    ).all() as LanDeviceRow[]).map(toDto);
  }

  public activeCount(): number {
    const row = this.db.prepare(
      'SELECT COUNT(*) AS count FROM lan_device WHERE revoked_at IS NULL',
    ).get() as { count: number };
    return Number(row.count);
  }

  public touch(id: string, usedAt = new Date().toISOString()): void {
    this.db.prepare(
      'UPDATE lan_device SET last_used_at = ? WHERE id = ? AND revoked_at IS NULL',
    ).run(usedAt, id);
  }

  public revoke(id: string): void {
    const result = this.db.prepare(
      'UPDATE lan_device SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL',
    ).run(new Date().toISOString(), id);
    if (!result.changes) throw new Error('LAN_DEVICE_NOT_FOUND');
  }

  public revokeByTokenHash(tokenHash: string): void {
    const result = this.db.prepare(
      'UPDATE lan_device SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL',
    ).run(new Date().toISOString(), tokenHash);
    if (!result.changes) throw new Error('UNAUTHORIZED');
  }

  public rotateToken(id: string, nextTokenHash: string): LanPairedDeviceDto {
    const result = this.db.prepare(
      `UPDATE lan_device
       SET token_hash = ?, last_used_at = ?
       WHERE id = ? AND revoked_at IS NULL`,
    ).run(nextTokenHash, new Date().toISOString(), id);
    if (!result.changes) throw new Error('UNAUTHORIZED');
    return this.findById(id)!;
  }

  private findById(id: string): LanPairedDeviceDto | null {
    const row = this.db.prepare('SELECT * FROM lan_device WHERE id = ?').get(id) as LanDeviceRow | undefined;
    return row ? toDto(row) : null;
  }
}

function normalizeDeviceName(name: string): string {
  const normalized = name.trim().replace(/\s+/g, ' ').slice(0, 100);
  if (!normalized) throw new Error('INVALID_DEVICE_NAME');
  return normalized;
}

function toDto(row: LanDeviceRow): LanPairedDeviceDto {
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  };
}
