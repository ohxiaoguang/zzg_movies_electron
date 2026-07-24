import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseManager } from '../src/main/database/DatabaseManager';
import { LanDeviceRepository } from '../src/main/database/repositories/LanDeviceRepository';
import { SettingsRepository } from '../src/main/database/repositories/SettingsRepository';
import {
  isAllowedLanBindAddress,
  isPrivateClientAddress,
  isPrivateIpv4,
  resolveBindAddress,
} from '../src/main/server/NetworkScope';
import { LanAuthService } from '../src/main/services/LanAuthService';
import { AppLogger } from '../src/main/system/AppLogger';

const roots: string[] = [];
const databases: DatabaseManager[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const database of databases.splice(0)) database.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('LAN settings and network scope', () => {
  it('defaults to disabled localhost and forces authentication for LAN mode', () => {
    const context = createContext();
    const settings = context.settings.get();
    expect(settings).toMatchObject({
      lanServerEnabled: false,
      lanServerPort: 48765,
      lanServerBindMode: 'localhost',
      lanServerHost: '',
      lanRequireAuthentication: true,
    });
    const updated = context.settings.update({
      lanServerEnabled: true,
      lanServerPort: 49321,
      lanServerBindMode: 'lan',
      lanServerHost: '192.168.1.10',
      lanRequireAuthentication: false,
    });
    expect(updated).toMatchObject({
      lanServerEnabled: true,
      lanServerPort: 49321,
      lanServerBindMode: 'lan',
      lanServerHost: '192.168.1.10',
      lanRequireAuthentication: true,
    });
    expect(() => context.settings.update({ lanServerPort: 80 })).toThrow('INVALID_LAN_SERVER_PORT');
    expect(() => context.settings.update({ lanServerHost: '8.8.8.8' })).toThrow('INVALID_LAN_SERVER_HOST');
  });

  it('recognizes private IPv4 ranges without accepting public addresses', () => {
    expect(isPrivateIpv4('10.2.3.4')).toBe(true);
    expect(isPrivateIpv4('172.16.0.1')).toBe(true);
    expect(isPrivateIpv4('172.31.255.254')).toBe(true);
    expect(isPrivateIpv4('192.168.50.2')).toBe(true);
    expect(isPrivateIpv4('8.8.8.8')).toBe(false);
    expect(isAllowedLanBindAddress('0.0.0.0')).toBe(true);
    expect(isAllowedLanBindAddress('1.1.1.1')).toBe(false);
    expect(isPrivateClientAddress('::ffff:192.168.1.20')).toBe(true);
    expect(isPrivateClientAddress('203.0.113.10')).toBe(false);
    expect(resolveBindAddress('localhost', '192.168.1.10')).toBe('127.0.0.1');
    expect(resolveBindAddress('lan', '')).toBe('0.0.0.0');
  });
});

describe('LAN pairing credentials', () => {
  it('expires pairing codes and never stores the device token in plaintext', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-24T00:00:00.000Z'));
    const context = createContext();
    const expired = context.auth.createPairingCode();
    vi.advanceTimersByTime(5 * 60_000 + 1);
    expect(() => context.auth.pair(
      { code: expired.code, deviceName: 'Expired Device' },
      '192.168.1.30',
    )).toThrow('PAIRING_CODE_EXPIRED');

    const active = context.auth.createPairingCode('admin');
    expect(active.role).toBe('admin');
    const result = context.auth.pair(
      { code: active.code, deviceName: 'Phone' },
      '192.168.1.30',
    );
    const row = context.database.db.prepare(
      'SELECT name, token_hash, revoked_at FROM lan_device WHERE id = ?',
    ).get(result.device.id) as { name: string; token_hash: string; revoked_at: string | null };
    expect(row.name).toBe('Phone');
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.token_hash).not.toContain(result.token);
    expect(row.revoked_at).toBeNull();
    expect(result.device.role).toBe('admin');
    expect(context.auth.authenticate(result.token).id).toBe(result.device.id);
    context.auth.revokeDevice(result.device.id);
    expect(() => context.auth.authenticate(result.token)).toThrow('UNAUTHORIZED');
  });
});

function createContext() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'film-library-lan-security-'));
  roots.push(root);
  const logger = new AppLogger(path.join(root, 'logs'));
  const database = new DatabaseManager(path.join(root, 'film-library.db'), logger);
  databases.push(database);
  const settings = new SettingsRepository(database.db);
  const devices = new LanDeviceRepository(database.db);
  const auth = new LanAuthService(devices, logger);
  return { database, settings, auth };
}
