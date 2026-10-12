import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readRecentAppLogs } from '../src/main/system/AppLogReader';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'app-logs-'));
  roots.push(root);
  return path.join(root, 'application.log');
}
describe('recent application logs', () => {
  it('returns empty logs for a missing file and preserves non-JSON lines', async () => {
    const file = fixture();
    expect(await readRecentAppLogs(file)).toEqual({ entries: [], truncated: false });
    fs.writeFileSync(file, 'legacy line\n' + JSON.stringify({ at: '2026-10-12T12:21:21Z', level: 'warn', message: 'Backup failed', details: { errorCode: 'CLOUD_BACKUP_TIMEOUT' } }) + '\n');
    expect(await readRecentAppLogs(file)).toEqual({ truncated: false, entries: [
      { at: '2026-10-12T12:21:21Z', level: 'warn', message: 'Backup failed', details: '{"errorCode":"CLOUD_BACKUP_TIMEOUT"}' },
      { at: '', level: 'unknown', message: 'legacy line', details: '' },
    ] });
  });
  it('bounds reads by bytes and rows and retains recent complete UTF-8 entries', async () => {
    const file = fixture();
    const lines = Array.from({ length: 1100 }, (_, index) => JSON.stringify({ message: `日志 ${index}` }));
    fs.writeFileSync(file, lines.join('\n') + '\n');
    let result = await readRecentAppLogs(file);
    expect(result.truncated).toBe(true);
    expect(result.entries).toHaveLength(1000);
    expect(result.entries[0].message).toBe('日志 1099');
    fs.writeFileSync(file, JSON.stringify({ message: '旧'.repeat(300_000) }) + '\n' + JSON.stringify({ message: '最新日志' }) + '\n');
    result = await readRecentAppLogs(file);
    expect(result.truncated).toBe(true);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].message).toBe('最新日志');
  });
});
