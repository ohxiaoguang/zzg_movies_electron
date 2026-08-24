import fs from 'node:fs';
import path from 'node:path';
import type {
  CorrectSourceTransferInput,
  SourceTransferRecordDto,
  TransferSourceInput,
  TransferSourceResultDto,
} from '../../shared/contracts';
import type { DatabaseManager } from '../database/DatabaseManager';
import type { SourceRepository } from '../database/repositories/SourceRepository';
import { discoverSidecarSubtitleFiles } from './PlaybackSessionService';
import type { AppLogger } from '../system/AppLogger';

interface FilmRow {
  id: string;
  relative_path: string;
  nfo_relative_path: string | null;
}

interface FilmFileRow {
  id: string;
  relative_path: string;
  missing: number;
}

interface FilmAssetRow {
  id: string;
  relative_path: string;
  missing: number;
}

interface FileMove {
  sourcePath: string;
  destinationPath: string;
  kind: 'video' | 'sidecar';
}

export class SourceTransferService {
  private transferring = false;

  public constructor(
    private readonly database: DatabaseManager,
    private readonly sources: SourceRepository,
    private readonly logger: AppLogger,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async transfer(input: TransferSourceInput): Promise<TransferSourceResultDto> {
    if (this.transferring) throw new Error('SOURCE_TRANSFER_ALREADY_RUNNING');
    this.transferring = true;
    try {
      return await this.runTransfer(input);
    } finally {
      this.transferring = false;
    }
  }

  public listRecentTransfers(): SourceTransferRecordDto[] {
    const deletedSources = this.database.db
      .prepare('SELECT id, name, deleted_at FROM media_source WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC')
      .all() as Array<{ id: string; name: string; deleted_at: string }>;
    const films = this.database.db
      .prepare('SELECT source_id, relative_path FROM film ORDER BY id')
      .all() as Array<{ source_id: string; relative_path: string }>;
    const records = new Map<string, SourceTransferRecordDto>();
    for (const deleted of deletedSources) {
      for (const film of films) {
        const folderName = firstRelativeComponent(film.relative_path);
        if (!folderName || !isTransferFolderName(deleted.name, folderName)) continue;
        const target = this.sources.findById(film.source_id);
        if (!target || target.deletedAt) continue;
        const key = `${deleted.id}:${target.id}:${folderName}`;
        const existing = records.get(key);
        if (existing) existing.filmCount += 1;
        else records.set(key, {
          sourceId: deleted.id,
          sourceName: deleted.name,
          targetSourceId: target.id,
          targetSourceName: target.name,
          destinationFolderName: folderName,
          filmCount: 1,
          movedAt: deleted.deleted_at,
        });
      }
    }
    return [...records.values()].sort((left, right) => right.movedAt.localeCompare(left.movedAt));
  }

  public async correctTransfer(input: CorrectSourceTransferInput): Promise<TransferSourceResultDto> {
    if (this.transferring) throw new Error('SOURCE_TRANSFER_ALREADY_RUNNING');
    this.transferring = true;
    try {
      return await this.runCorrection(input);
    } finally {
      this.transferring = false;
    }
  }

  private async runTransfer(input: TransferSourceInput): Promise<TransferSourceResultDto> {
    if (input.sourceId === input.targetSourceId) throw new Error('SOURCE_TRANSFER_SAME_SOURCE');
    const source = this.sources.findById(input.sourceId);
    const target = this.sources.findById(input.targetSourceId);
    if (!source || source.deletedAt) throw new Error('SOURCE_NOT_FOUND');
    if (!target || target.deletedAt) throw new Error('SOURCE_TRANSFER_TARGET_NOT_FOUND');

    const sourceRoot = path.resolve(source.rootPath);
    const targetRoot = path.resolve(target.rootPath);
    await assertDirectory(sourceRoot, 'SOURCE_TRANSFER_SOURCE_OFFLINE');
    await assertDirectory(targetRoot, 'SOURCE_TRANSFER_TARGET_OFFLINE');
    if (pathsOverlap(sourceRoot, targetRoot)) throw new Error('SOURCE_TRANSFER_PATH_OVERLAP');

    const folderName = await this.availableFolderName(targetRoot, source.name);
    const destinationRoot = path.join(targetRoot, folderName);
    const films = this.database.db
      .prepare('SELECT id, relative_path, nfo_relative_path FROM film WHERE source_id = ? ORDER BY id')
      .all(source.id) as FilmRow[];
    const filmFiles = this.database.db
      .prepare('SELECT id, relative_path, missing FROM film_file WHERE source_id = ? ORDER BY id')
      .all(source.id) as FilmFileRow[];
    const assets = this.database.db
      .prepare(
        `SELECT asset.id, asset.relative_path, asset.missing
         FROM film_asset asset
         JOIN film ON film.id = asset.film_id
         WHERE film.source_id = ?
         ORDER BY asset.id`,
      )
      .all(source.id) as FilmAssetRow[];

    const moves = new Map<string, FileMove>();
    const videoPaths: string[] = [];
    for (const file of filmFiles) {
      const move = await this.optionalMove(sourceRoot, destinationRoot, file.relative_path, 'video');
      if (!move && !file.missing) throw new Error('SOURCE_TRANSFER_FILE_MISSING');
      if (move) {
        moves.set(pathKey(move.sourcePath), move);
        videoPaths.push(move.sourcePath);
      }
    }
    for (const asset of assets) {
      const move = await this.optionalMove(sourceRoot, destinationRoot, asset.relative_path, 'sidecar');
      if (!move && !asset.missing) throw new Error('SOURCE_TRANSFER_ASSET_MISSING');
      if (move) moves.set(pathKey(move.sourcePath), move);
    }
    for (const film of films) {
      if (!film.nfo_relative_path) continue;
      const move = await this.optionalMove(sourceRoot, destinationRoot, film.nfo_relative_path, 'sidecar');
      if (move) moves.set(pathKey(move.sourcePath), move);
    }
    for (const videoPath of videoPaths) {
      const subtitles = await discoverSidecarSubtitleFiles(videoPath);
      for (const subtitle of subtitles) {
        const relativePath = path.relative(sourceRoot, subtitle.filePath);
        const move = await this.optionalMove(sourceRoot, destinationRoot, relativePath, 'sidecar');
        if (move) moves.set(pathKey(move.sourcePath), move);
      }
    }

    await fs.promises.mkdir(destinationRoot, { recursive: false });
    const completed: FileMove[] = [];
    try {
      for (const move of moves.values()) {
        await moveFile(move.sourcePath, move.destinationPath);
        completed.push(move);
      }
      this.updateDatabase(source.id, target.id, folderName, films, filmFiles, assets);
    } catch (error) {
      const rollbackErrors: string[] = [];
      for (const move of completed.reverse()) {
        try {
          await moveFile(move.destinationPath, move.sourcePath);
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError instanceof Error ? rollbackError.message : 'ROLLBACK_FAILED');
        }
      }
      await removeEmptyDirectories(destinationRoot);
      if (rollbackErrors.length) {
        this.logger.error('Source transfer rollback incomplete', { sourceId: source.id, rollbackErrors });
        throw new Error('SOURCE_TRANSFER_ROLLBACK_FAILED', { cause: error });
      }
      throw error;
    }

    const movedFileCount = [...moves.values()].filter((move) => move.kind === 'video').length;
    const movedAssetCount = moves.size - movedFileCount;
    this.logger.info('Source transfer completed', {
      sourceId: source.id,
      targetSourceId: target.id,
      destinationFolderName: folderName,
      movedFilmCount: films.length,
      movedFileCount,
      movedAssetCount,
    });
    return {
      sourceId: source.id,
      targetSourceId: target.id,
      destinationFolderName: folderName,
      destinationPath: destinationRoot,
      movedFilmCount: films.length,
      movedFileCount,
      movedAssetCount,
    };
  }

  private async runCorrection(input: CorrectSourceTransferInput): Promise<TransferSourceResultDto> {
    if (input.currentTargetSourceId === input.newTargetSourceId) throw new Error('SOURCE_TRANSFER_SAME_SOURCE');
    const originalSource = this.sources.findById(input.sourceId);
    const currentTarget = this.sources.findById(input.currentTargetSourceId);
    const newTarget = this.sources.findById(input.newTargetSourceId);
    if (!originalSource?.deletedAt || !isTransferFolderName(originalSource.name, input.destinationFolderName)) {
      throw new Error('SOURCE_TRANSFER_RECORD_NOT_FOUND');
    }
    if (!currentTarget || currentTarget.deletedAt) throw new Error('SOURCE_TRANSFER_TARGET_NOT_FOUND');
    if (!newTarget || newTarget.deletedAt) throw new Error('SOURCE_TRANSFER_TARGET_NOT_FOUND');

    const currentRoot = path.resolve(currentTarget.rootPath);
    const newRoot = path.resolve(newTarget.rootPath);
    await assertDirectory(currentRoot, 'SOURCE_TRANSFER_SOURCE_OFFLINE');
    await assertDirectory(newRoot, 'SOURCE_TRANSFER_TARGET_OFFLINE');
    if (pathsOverlap(currentRoot, newRoot)) throw new Error('SOURCE_TRANSFER_PATH_OVERLAP');

    const films = (this.database.db
      .prepare('SELECT id, relative_path, nfo_relative_path FROM film WHERE source_id = ? ORDER BY id')
      .all(currentTarget.id) as FilmRow[])
      .filter((film) => firstRelativeComponent(film.relative_path) === input.destinationFolderName);
    if (!films.length) throw new Error('SOURCE_TRANSFER_RECORD_NOT_FOUND');
    const placeholders = films.map(() => '?').join(',');
    const filmIds = films.map((film) => film.id);
    const filmFiles = this.database.db
      .prepare(`SELECT id, relative_path, missing FROM film_file WHERE source_id = ? AND film_id IN (${placeholders}) ORDER BY id`)
      .all(currentTarget.id, ...filmIds) as FilmFileRow[];
    const assets = this.database.db
      .prepare(`SELECT id, relative_path, missing FROM film_asset WHERE film_id IN (${placeholders}) ORDER BY id`)
      .all(...filmIds) as FilmAssetRow[];

    const newFolderName = await this.availableFolderName(newRoot, originalSource.name);
    const destinationRoot = path.join(newRoot, newFolderName);
    const moves = new Map<string, FileMove>();
    const videoPaths: string[] = [];
    for (const file of filmFiles) {
      const relativePath = withoutFirstRelativeComponent(file.relative_path, input.destinationFolderName);
      const move = await this.optionalRebasedMove(currentRoot, file.relative_path, destinationRoot, relativePath, 'video');
      if (!move && !file.missing) throw new Error('SOURCE_TRANSFER_FILE_MISSING');
      if (move) {
        moves.set(pathKey(move.sourcePath), move);
        videoPaths.push(move.sourcePath);
      }
    }
    for (const asset of assets) {
      const relativePath = withoutFirstRelativeComponent(asset.relative_path, input.destinationFolderName);
      const move = await this.optionalRebasedMove(currentRoot, asset.relative_path, destinationRoot, relativePath, 'sidecar');
      if (!move && !asset.missing) throw new Error('SOURCE_TRANSFER_ASSET_MISSING');
      if (move) moves.set(pathKey(move.sourcePath), move);
    }
    for (const film of films) {
      if (!film.nfo_relative_path) continue;
      const relativePath = withoutFirstRelativeComponent(film.nfo_relative_path, input.destinationFolderName);
      const move = await this.optionalRebasedMove(currentRoot, film.nfo_relative_path, destinationRoot, relativePath, 'sidecar');
      if (move) moves.set(pathKey(move.sourcePath), move);
    }
    for (const videoPath of videoPaths) {
      const subtitles = await discoverSidecarSubtitleFiles(videoPath);
      for (const subtitle of subtitles) {
        const currentRelativePath = path.relative(currentRoot, subtitle.filePath);
        const relativePath = withoutFirstRelativeComponent(currentRelativePath, input.destinationFolderName);
        const move = await this.optionalRebasedMove(currentRoot, currentRelativePath, destinationRoot, relativePath, 'sidecar');
        if (move) moves.set(pathKey(move.sourcePath), move);
      }
    }

    await fs.promises.mkdir(destinationRoot, { recursive: false });
    const completed: FileMove[] = [];
    try {
      for (const move of moves.values()) {
        await moveFile(move.sourcePath, move.destinationPath);
        completed.push(move);
      }
      this.updateCorrectedDatabase(
        currentTarget.id,
        newTarget.id,
        input.destinationFolderName,
        newFolderName,
        films,
        filmFiles,
        assets,
      );
    } catch (error) {
      const rollbackErrors: string[] = [];
      for (const move of completed.reverse()) {
        try {
          await moveFile(move.destinationPath, move.sourcePath);
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError instanceof Error ? rollbackError.message : 'ROLLBACK_FAILED');
        }
      }
      await removeEmptyDirectories(destinationRoot);
      if (rollbackErrors.length) {
        this.logger.error('Source transfer correction rollback incomplete', { sourceId: originalSource.id, rollbackErrors });
        throw new Error('SOURCE_TRANSFER_ROLLBACK_FAILED', { cause: error });
      }
      throw error;
    }
    await removeEmptyDirectories(path.join(currentRoot, input.destinationFolderName));

    const movedFileCount = [...moves.values()].filter((move) => move.kind === 'video').length;
    const movedAssetCount = moves.size - movedFileCount;
    this.logger.info('Source transfer target corrected', {
      sourceId: originalSource.id,
      previousTargetSourceId: currentTarget.id,
      targetSourceId: newTarget.id,
      destinationFolderName: newFolderName,
      movedFilmCount: films.length,
      movedFileCount,
      movedAssetCount,
    });
    return {
      sourceId: originalSource.id,
      targetSourceId: newTarget.id,
      destinationFolderName: newFolderName,
      destinationPath: destinationRoot,
      movedFilmCount: films.length,
      movedFileCount,
      movedAssetCount,
    };
  }

  private async optionalMove(
    sourceRoot: string,
    destinationRoot: string,
    relativePath: string,
    kind: FileMove['kind'],
  ): Promise<FileMove | null> {
    const sourcePath = resolveFileWithin(sourceRoot, relativePath);
    const destinationPath = resolveFileWithin(destinationRoot, relativePath);
    try {
      const stat = await fs.promises.stat(sourcePath);
      if (!stat.isFile()) return null;
      return { sourcePath, destinationPath, kind };
    } catch {
      return null;
    }
  }

  private async optionalRebasedMove(
    sourceRoot: string,
    sourceRelativePath: string,
    destinationRoot: string,
    destinationRelativePath: string,
    kind: FileMove['kind'],
  ): Promise<FileMove | null> {
    const sourcePath = resolveFileWithin(sourceRoot, sourceRelativePath);
    const destinationPath = resolveFileWithin(destinationRoot, destinationRelativePath);
    try {
      const stat = await fs.promises.stat(sourcePath);
      if (!stat.isFile()) return null;
      return { sourcePath, destinationPath, kind };
    } catch {
      return null;
    }
  }

  private updateDatabase(
    sourceId: string,
    targetId: string,
    folderName: string,
    films: FilmRow[],
    filmFiles: FilmFileRow[],
    assets: FilmAssetRow[],
  ): void {
    const now = this.clock().toISOString();
    this.database.transaction(() => {
      const updateFilm = this.database.db.prepare(
        `UPDATE film
         SET source_id = ?, relative_path = ?, nfo_relative_path = ?, updated_at = ?
         WHERE id = ? AND source_id = ?`,
      );
      for (const film of films) {
        updateFilm.run(
          targetId,
          path.join(folderName, film.relative_path),
          film.nfo_relative_path ? path.join(folderName, film.nfo_relative_path) : null,
          now,
          film.id,
          sourceId,
        );
      }

      const updateFile = this.database.db.prepare(
        'UPDATE film_file SET source_id = ?, relative_path = ?, updated_at = ? WHERE id = ? AND source_id = ?',
      );
      for (const file of filmFiles) {
        updateFile.run(targetId, path.join(folderName, file.relative_path), now, file.id, sourceId);
      }

      const updateAsset = this.database.db.prepare('UPDATE film_asset SET relative_path = ? WHERE id = ?');
      for (const asset of assets) updateAsset.run(path.join(folderName, asset.relative_path), asset.id);

      const removed = this.database.db.prepare(
        'UPDATE media_source SET deleted_at = ?, enabled = 0, updated_at = ? WHERE id = ? AND deleted_at IS NULL',
      ).run(now, now, sourceId);
      if (removed.changes !== 1) throw new Error('SOURCE_NOT_FOUND');
    });
  }

  private updateCorrectedDatabase(
    currentTargetId: string,
    newTargetId: string,
    oldFolderName: string,
    newFolderName: string,
    films: FilmRow[],
    filmFiles: FilmFileRow[],
    assets: FilmAssetRow[],
  ): void {
    const now = this.clock().toISOString();
    this.database.transaction(() => {
      const updateFilm = this.database.db.prepare(
        `UPDATE film
         SET source_id = ?, relative_path = ?, nfo_relative_path = ?, updated_at = ?
         WHERE id = ? AND source_id = ?`,
      );
      for (const film of films) {
        updateFilm.run(
          newTargetId,
          path.join(newFolderName, withoutFirstRelativeComponent(film.relative_path, oldFolderName)),
          film.nfo_relative_path
            ? path.join(newFolderName, withoutFirstRelativeComponent(film.nfo_relative_path, oldFolderName))
            : null,
          now,
          film.id,
          currentTargetId,
        );
      }

      const updateFile = this.database.db.prepare(
        'UPDATE film_file SET source_id = ?, relative_path = ?, updated_at = ? WHERE id = ? AND source_id = ?',
      );
      for (const file of filmFiles) {
        updateFile.run(
          newTargetId,
          path.join(newFolderName, withoutFirstRelativeComponent(file.relative_path, oldFolderName)),
          now,
          file.id,
          currentTargetId,
        );
      }

      const updateAsset = this.database.db.prepare('UPDATE film_asset SET relative_path = ? WHERE id = ?');
      for (const asset of assets) {
        updateAsset.run(path.join(newFolderName, withoutFirstRelativeComponent(asset.relative_path, oldFolderName)), asset.id);
      }
    });
  }

  private async availableFolderName(targetRoot: string, sourceName: string): Promise<string> {
    const base = `${safeFolderName(sourceName)}_${formatLocalTimestamp(this.clock())}`;
    let candidate = base;
    let suffix = 2;
    while (await pathExists(path.join(targetRoot, candidate))) {
      candidate = `${base}_${suffix}`;
      suffix += 1;
    }
    return candidate;
  }
}

async function assertDirectory(directory: string, errorCode: string): Promise<void> {
  try {
    if ((await fs.promises.stat(directory)).isDirectory()) return;
  } catch {
    // Mapped to a stable public error below.
  }
  throw new Error(errorCode);
}

function resolveFileWithin(root: string, relativePath: string): string {
  if (!relativePath || path.isAbsolute(relativePath)) throw new Error('SOURCE_TRANSFER_INVALID_PATH');
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relativePath);
  const relative = path.relative(resolvedRoot, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('SOURCE_TRANSFER_INVALID_PATH');
  return resolved;
}

function pathsOverlap(left: string, right: string): boolean {
  return isSameOrNested(left, right) || isSameOrNested(right, left);
}

function isSameOrNested(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return !relative || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function pathKey(filePath: string): string {
  const normalized = path.resolve(filePath);
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

function firstRelativeComponent(relativePath: string): string | null {
  return relativePath.split(/[\\/]/).filter(Boolean)[0] ?? null;
}

function withoutFirstRelativeComponent(relativePath: string, expectedFolderName: string): string {
  const components = relativePath.split(/[\\/]/).filter(Boolean);
  if (components[0] !== expectedFolderName || components.length < 2) throw new Error('SOURCE_TRANSFER_RECORD_NOT_FOUND');
  return path.join(...components.slice(1));
}

function isTransferFolderName(sourceName: string, folderName: string): boolean {
  const prefix = `${safeFolderName(sourceName)}_`;
  if (!folderName.startsWith(prefix)) return false;
  return /^\d{14}(?:_\d+)?$/.test(folderName.slice(prefix.length));
}

function safeFolderName(value: string): string {
  const sanitized = value
    .normalize('NFKC')
    .split('')
    .map((character) => (character.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(character) ? '_' : character))
    .join('')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 80);
  return sanitized || '来源';
}

function formatLocalTimestamp(value: Date): string {
  const parts = [
    value.getFullYear(),
    value.getMonth() + 1,
    value.getDate(),
    value.getHours(),
    value.getMinutes(),
    value.getSeconds(),
  ];
  const [year, ...rest] = parts;
  return `${year}${rest.map((part) => String(part).padStart(2, '0')).join('')}`;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function moveFile(sourcePath: string, destinationPath: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(destinationPath), { recursive: true });
  try {
    await fs.promises.rename(sourcePath, destinationPath);
  } catch (error) {
    if (!isCrossDeviceError(error)) throw error;
    await fs.promises.copyFile(sourcePath, destinationPath, fs.constants.COPYFILE_EXCL);
    try {
      await fs.promises.unlink(sourcePath);
    } catch (unlinkError) {
      await fs.promises.unlink(destinationPath).catch(() => undefined);
      throw unlinkError;
    }
  }
}

async function removeEmptyDirectories(directory: string): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) await removeEmptyDirectories(path.join(directory, entry.name));
  }
  await fs.promises.rmdir(directory).catch(() => undefined);
}

function isCrossDeviceError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as { code?: unknown }).code === 'EXDEV';
}
