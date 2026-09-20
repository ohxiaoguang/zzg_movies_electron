import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseManager } from '../database/DatabaseManager';
import { isPathWithinRoot } from '../media/MediaPathResolver';

export interface TransferMove {
  sourcePath: string;
  destinationPath: string;
}

interface TransferPlan {
  sourceRoot: string;
  destinationRoot: string;
  moves: TransferMove[];
}

/** The journal is removed in the same SQLite transaction as the index update. */
export class TransferJournal {
  public constructor(private readonly database: DatabaseManager) {}

  public async execute(plan: TransferPlan, commit: () => void): Promise<void> {
    const id = randomUUID();
    this.database.db.prepare('INSERT INTO source_transfer_journal (id, payload) VALUES (?, ?)')
      .run(id, JSON.stringify(plan));
    try {
      for (const move of plan.moves) {
        await assertSafeLocation(plan.sourceRoot, move.sourcePath);
        await assertSafeLocation(plan.destinationRoot, move.destinationPath);
        await moveFile(move.sourcePath, move.destinationPath, partialPath(move.destinationPath, id));
      }
      this.database.transaction(() => {
        commit();
        this.remove(id);
      });
    } catch (error) {
      try {
        await this.rollback(id, plan);
      } catch (rollbackError) {
        throw new Error('SOURCE_TRANSFER_RECOVERY_REQUIRED', { cause: rollbackError });
      }
      throw error;
    }
  }

  public async recover(): Promise<void> {
    const rows = this.database.db.prepare('SELECT id, payload FROM source_transfer_journal').all() as Array<{ id: string; payload: string }>;
    for (const row of rows) {
      if (!/^[0-9a-f-]{36}$/.test(row.id)) throw new Error('SOURCE_TRANSFER_RECOVERY_REQUIRED');
      const plan = JSON.parse(row.payload) as TransferPlan;
      await this.rollback(row.id, plan);
    }
  }

  private async rollback(id: string, plan: TransferPlan): Promise<void> {
    // Check both roots before touching anything: an unplugged disk is not a missing file.
    if (!(await fs.promises.stat(plan.sourceRoot)).isDirectory()
      || !(await fs.promises.stat(plan.destinationRoot)).isDirectory()) {
      throw new Error('SOURCE_TRANSFER_RECOVERY_REQUIRED');
    }
    for (const move of [...plan.moves].reverse()) {
      await assertSafeLocation(plan.sourceRoot, move.sourcePath);
      await assertSafeLocation(plan.destinationRoot, move.destinationPath);
      const source = await fileExists(move.sourcePath);
      const destination = await fileExists(move.destinationPath);
      if (!source && !destination) throw new Error('SOURCE_TRANSFER_RECOVERY_REQUIRED');
      if (source && destination) {
        // A crash can occur after cross-volume publication but before source removal.
        // Never overwrite a file recreated/changed by another application.
        if (await digest(move.sourcePath) !== await digest(move.destinationPath)) {
          throw new Error('SOURCE_TRANSFER_RECOVERY_REQUIRED');
        }
        await fs.promises.unlink(move.destinationPath);
      } else if (destination) {
        await removePartial(partialPath(move.sourcePath, id));
        await moveFile(move.destinationPath, move.sourcePath, partialPath(move.sourcePath, id));
      }
      await removePartial(partialPath(move.destinationPath, id));
      await removePartial(partialPath(move.sourcePath, id));
    }
    this.remove(id);
    await removeEmptyDirectories(plan.destinationRoot).catch(() => undefined);
  }

  private remove(id: string): void {
    this.database.db.prepare('DELETE FROM source_transfer_journal WHERE id = ?').run(id);
  }
}

async function assertSafeLocation(root: string, target: string): Promise<void> {
  if (!path.isAbsolute(root) || !path.isAbsolute(target) || root === target || !isPathWithinRoot(root, target)) {
    throw new Error('SOURCE_TRANSFER_INVALID_PATH');
  }
  const realRoot = await fs.promises.realpath(root);
  let ancestor = target;
  for (;;) {
    try {
      const resolved = await fs.promises.realpath(ancestor);
      if (!isPathWithinRoot(realRoot, resolved)) throw new Error('SOURCE_TRANSFER_INVALID_PATH');
      return;
    } catch (error) {
      if (!hasCode(error, 'ENOENT')) throw error;
      if (ancestor === root) throw error;
      ancestor = path.dirname(ancestor);
    }
  }
}

function partialPath(file: string, id: string): string {
  return `${file}.${id}.partial`;
}

async function fileExists(file: string): Promise<boolean> {
  try {
    if (!(await fs.promises.lstat(file)).isFile()) throw new Error('SOURCE_TRANSFER_INVALID_PATH');
    return true;
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return false;
    throw error;
  }
}

async function moveFile(source: string, destination: string, partial: string): Promise<void> {
  if (await fileExists(destination)) throw new Error('SOURCE_TRANSFER_DESTINATION_EXISTS');
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  try {
    await fs.promises.rename(source, destination);
  } catch (error) {
    if (!hasCode(error, 'EXDEV')) throw error;
    await fs.promises.copyFile(source, partial, fs.constants.COPYFILE_EXCL);
    const handle = await fs.promises.open(partial, 'r+');
    try { await handle.sync(); } finally { await handle.close(); }
    await fs.promises.rename(partial, destination);
    await fs.promises.unlink(source);
  }
}

async function digest(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function removePartial(file: string): Promise<void> {
  try { await fs.promises.unlink(file); } catch (error) { if (!hasCode(error, 'ENOENT')) throw error; }
}

export async function removeEmptyDirectories(directory: string): Promise<void> {
  // Never follow junctions while cleaning up application-created directories.
  if ((await fs.promises.lstat(directory)).isSymbolicLink()) return;
  const entries = await fs.promises.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.isSymbolicLink()) await removeEmptyDirectories(path.join(directory, entry.name));
  }
  await fs.promises.rmdir(directory).catch(() => undefined);
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
