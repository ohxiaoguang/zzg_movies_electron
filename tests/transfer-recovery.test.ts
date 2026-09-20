import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseManager } from '../src/main/database/DatabaseManager';
import { TransferJournal } from '../src/main/services/TransferJournal';
import { LibraryOperationCoordinator } from '../src/main/services/LibraryOperationCoordinator';

const roots: string[] = [];
const databases: DatabaseManager[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const database of databases.splice(0)) database.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'film-transfer-recovery-'));
  roots.push(root);
  const database = new DatabaseManager(path.join(root, 'library.db'));
  databases.push(database);
  const sourceRoot = path.join(root, 'source');
  const destinationRoot = path.join(root, 'target', 'batch');
  fs.mkdirSync(sourceRoot);
  fs.mkdirSync(destinationRoot, { recursive: true });
  const moves = ['one.mp4', 'two.mp4'].map((name) => ({
    sourcePath: path.join(sourceRoot, name), destinationPath: path.join(destinationRoot, name),
  }));
  for (const move of moves) fs.writeFileSync(move.sourcePath, `contents:${path.basename(move.sourcePath)}`);
  return { database, root, plan: { sourceRoot, destinationRoot, moves } };
}

function seed(f: ReturnType<typeof fixture>): string {
  const id = randomUUID();
  f.database.db.prepare('INSERT INTO source_transfer_journal VALUES (?, ?)').run(id, JSON.stringify(f.plan));
  return id;
}

describe('durable file transfer recovery', () => {
  it('recovers a partially moved batch after reopening SQLite and is idempotent', async () => {
    const f = fixture();
    seed(f);
    fs.renameSync(f.plan.moves[0].sourcePath, f.plan.moves[0].destinationPath);
    f.database.close();
    const reopened = new DatabaseManager(path.join(f.root, 'library.db'));
    databases.push(reopened);
    await new TransferJournal(reopened).recover();
    await new TransferJournal(reopened).recover();
    for (const move of f.plan.moves) {
      expect(fs.readFileSync(move.sourcePath, 'utf8')).toBe(`contents:${path.basename(move.sourcePath)}`);
      expect(fs.existsSync(move.destinationPath)).toBe(false);
    }
    expect(() => reopened.assertTransfersRecovered()).not.toThrow();
  });

  it('removes a published duplicate and incomplete copy while retaining original files', async () => {
    const f = fixture();
    const id = seed(f);
    fs.copyFileSync(f.plan.moves[0].sourcePath, f.plan.moves[0].destinationPath);
    const partial = `${f.plan.moves[1].destinationPath}.${id}.partial`;
    fs.writeFileSync(partial, 'incomplete copy');
    await new TransferJournal(f.database).recover();
    expect(fs.existsSync(partial)).toBe(false);
    expect(fs.existsSync(f.plan.moves[0].sourcePath)).toBe(true);
    expect(fs.existsSync(f.plan.moves[0].destinationPath)).toBe(false);
  });

  it('retains conflicting files and the journal until recovery is possible', async () => {
    const f = fixture();
    seed(f);
    fs.writeFileSync(f.plan.moves[1].destinationPath, 'different file');
    await expect(new TransferJournal(f.database).recover()).rejects.toThrow('SOURCE_TRANSFER_RECOVERY_REQUIRED');
    expect(fs.readFileSync(f.plan.moves[1].destinationPath, 'utf8')).toBe('different file');
    expect(fs.readFileSync(f.plan.moves[1].sourcePath, 'utf8')).toBe('contents:two.mp4');
    expect(() => f.database.assertTransfersRecovered()).toThrow('SOURCE_TRANSFER_RECOVERY_REQUIRED');
  });

  it('does not mistake an offline source root for files needing restoration', async () => {
    const f = fixture();
    seed(f);
    fs.renameSync(f.plan.moves[0].sourcePath, f.plan.moves[0].destinationPath);
    fs.renameSync(f.plan.sourceRoot, `${f.plan.sourceRoot}-offline`);
    await expect(new TransferJournal(f.database).recover()).rejects.toThrow();
    expect(fs.existsSync(f.plan.moves[0].destinationPath)).toBe(true);
    expect(() => f.database.assertTransfersRecovered()).toThrow('SOURCE_TRANSFER_RECOVERY_REQUIRED');
  });

  it('rolls back file moves and the index transaction when commit fails', async () => {
    const f = fixture();
    f.database.db.exec('CREATE TABLE commit_test (value INTEGER)');
    await expect(new TransferJournal(f.database).execute(f.plan, () => {
      f.database.db.exec('INSERT INTO commit_test VALUES (1)');
      throw new Error('COMMIT_FAILED');
    })).rejects.toThrow('COMMIT_FAILED');
    expect(f.database.db.prepare('SELECT * FROM commit_test').all()).toEqual([]);
    for (const move of f.plan.moves) expect(fs.existsSync(move.sourcePath)).toBe(true);
    expect(() => f.database.assertTransfersRecovered()).not.toThrow();
  });

  it('cleans incomplete cross-volume copies after a copy error', async () => {
    const f = fixture();
    vi.spyOn(fs.promises, 'rename').mockRejectedValueOnce(Object.assign(new Error('cross volume'), { code: 'EXDEV' }));
    vi.spyOn(fs.promises, 'copyFile').mockImplementationOnce(async (_source, destination) => {
      fs.writeFileSync(String(destination), 'partial');
      throw new Error('DISK_FULL');
    });
    await expect(new TransferJournal(f.database).execute(f.plan, () => undefined)).rejects.toThrow('DISK_FULL');
    expect(fs.existsSync(f.plan.moves[0].sourcePath)).toBe(true);
    expect(fs.existsSync(f.plan.destinationRoot)).toBe(false);
    expect(() => f.database.assertTransfersRecovered()).not.toThrow();
  });

  it('does not roll back successfully committed transfers on a later startup', async () => {
    const f = fixture();
    await new TransferJournal(f.database).execute(f.plan, () => undefined);
    await new TransferJournal(f.database).recover();
    for (const move of f.plan.moves) {
      expect(fs.existsSync(move.sourcePath)).toBe(false);
      expect(fs.existsSync(move.destinationPath)).toBe(true);
    }
  });
});

describe('library operation shutdown', () => {
  it('rejects new jobs and waits for the active operation to release', async () => {
    const coordinator = new LibraryOperationCoordinator();
    const release = coordinator.acquire('transfer');
    let stopped = false;
    const waiting = coordinator.stopAndWait().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    expect(() => coordinator.acquire('scan')).toThrow('APPLICATION_SHUTTING_DOWN');
    release();
    await waiting;
    expect(stopped).toBe(true);
  });
});
