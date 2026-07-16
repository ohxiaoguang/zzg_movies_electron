import { randomUUID } from 'node:crypto';
import type { MediaSourceDto, ScanStartDto, ScanStartInput, ScanStatusDto } from '../../shared/contracts';
import type { DatabaseManager } from '../database/DatabaseManager';
import { FilmFileOwnershipConflictError, FilmRepository } from '../database/repositories/FilmRepository';
import { SettingsRepository } from '../database/repositories/SettingsRepository';
import { SourceRepository } from '../database/repositories/SourceRepository';
import type { AppLogger } from '../system/AppLogger';
import { ScanCancellation } from './ScanCancellation';
import { assertUniqueIncomingPhysicalFiles, dedupeFilmCandidates, type FilmCandidate } from './ScanCandidate';
import { SourceScanner } from './SourceScanner';

type ProgressListener = (progress: ScanStatusDto) => void;
interface ScanTarget { source: MediaSourceDto; relativeDirectory: string | null; }

interface ScanMergeFailureDetails {
  sourceId: string;
  relativePath: string;
  existingFilmId: string | null;
  existingFilmTitle: string | null;
  targetFilmId: string;
  targetFilmTitle: string | null;
  groupKey: string;
  sqlStage: string;
  sqliteErrorCode: string | null;
}

function normalizeRelativeDirectory(value: string): string {
  const normalized = value.trim().replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '') || '.';
  if (normalized.startsWith('/') || normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) throw new Error('MEDIA_PATH_OUTSIDE_SOURCE');
  return normalized;
}

export class ScanCoordinator {
  private readonly listeners = new Set<ProgressListener>();
  private state: ScanStatusDto | null = null;
  private cancellation: ScanCancellation | null = null;

  public constructor(
    private readonly database: DatabaseManager,
    private readonly sources: SourceRepository,
    private readonly films: FilmRepository,
    private readonly settings: SettingsRepository,
    private readonly logger: AppLogger,
  ) {}

  public onProgress(listener: ProgressListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public start(input: ScanStartInput): ScanStartDto {
    const available = this.sources.list().filter((source) => source.enabled && !source.archived);
    const selected = input.sourceIds?.length
      ? available.filter((source) => input.sourceIds!.includes(source.id))
      : available;
    if (input.sourceIds?.length && selected.length !== input.sourceIds.length) throw new Error('SOURCE_NOT_FOUND');
    return this.begin(selected.map((source) => ({ source, relativeDirectory: null })));
  }

  public startDirectory(sourceId: string, relativeDirectory: string): ScanStartDto {
    const source = this.sources.list().find((item) => item.id === sourceId && item.enabled && !item.archived);
    if (!source) throw new Error('SOURCE_NOT_FOUND');
    const normalized = normalizeRelativeDirectory(relativeDirectory);
    return this.begin([{ source, relativeDirectory: normalized }]);
  }

  private begin(targets: ScanTarget[]): ScanStartDto {
    if (this.state?.status === 'running') throw new Error('SCAN_ALREADY_RUNNING');
    const jobId = randomUUID();
    const startedAt = new Date().toISOString();
    this.cancellation = new ScanCancellation();
    this.state = {
      jobId,
      status: 'running',
      currentSource: null,
      currentDirectory: null,
      currentFilm: null,
      discovered: 0,
      processed: 0,
      created: 0,
      updated: 0,
      moved: 0,
      missing: 0,
      nfoErrors: 0,
      ambiguousAssets: 0,
      otherErrors: 0,
      message: null,
      startedAt,
      finishedAt: null,
      sourceCount: targets.length,
      cancelled: false,
    };
    this.database.db
      .prepare('INSERT INTO scan_job (id, started_at, status, source_count) VALUES (?, ?, ?, ?)')
      .run(jobId, startedAt, 'running', targets.length);
    this.emit();
    void this.run(targets, jobId);
    return { jobId };
  }

  public cancel(): void {
    this.cancellation?.cancel();
  }

  public status(): ScanStatusDto | null {
    return this.state;
  }

  private async run(targets: ScanTarget[], jobId: string): Promise<void> {
    const cancellation = this.cancellation!;
    let runError: string | null = null;
    let activeSource: MediaSourceDto | null = null;
    try {
      for (const target of targets) {
        const source = target.source;
        activeSource = source;
        if (cancellation.cancelled) break;
        this.updateState({ currentSource: source.name, currentDirectory: target.relativeDirectory ?? '.', currentFilm: null });
        const scanner = new SourceScanner(source, {
          settings: this.settings.get(),
          cancellation,
          relativeDirectory: target.relativeDirectory ?? undefined,
          onProgress: (progress) => {
            this.updateState({
              currentDirectory: progress.currentDirectory,
              currentFilm: progress.currentFilm,
            });
          },
        });
        const result = await scanner.scan();
        this.updateState({
          discovered: this.state!.discovered + result.stats.discovered,
          processed: this.state!.processed + result.stats.processed,
          nfoErrors: this.state!.nfoErrors + result.stats.nfoErrors,
          ambiguousAssets: this.state!.ambiguousAssets + result.stats.ambiguousAssets,
          otherErrors: this.state!.otherErrors + result.stats.otherErrors,
        });
        if (result.cancelled || cancellation.cancelled) break;
        if (result.offline) {
          if (target.relativeDirectory) this.updateState({ message: `${source.name} · ${target.relativeDirectory} 目录不可用，已保留原有缺失状态` });
          else {
            this.sources.setScanResult(source.id, 'offline', null);
            this.updateState({ message: `${source.name} 离线，已保留原有缺失状态` });
          }
          continue;
        }
        if (!result.complete) {
          this.sources.setScanResult(source.id, 'incomplete', null);
          this.updateState({ message: `${source.name} 扫描不完整，未执行缺失标记` });
          continue;
        }
        const merge = this.mergeSource(source, result.candidates, target.relativeDirectory);
        this.updateState({
          created: this.state!.created + merge.created,
          updated: this.state!.updated + merge.updated,
          moved: this.state!.moved + merge.moved,
          missing: this.state!.missing + merge.missing,
          otherErrors: this.state!.otherErrors + merge.errors,
        });
        if (target.relativeDirectory) this.updateState({ message: `${source.name} · ${target.relativeDirectory} 目录扫描完成` });
        else this.sources.setScanResult(source.id, 'completed', new Date().toISOString());
        this.emit();
      }
      const cancelled = cancellation.cancelled;
      this.updateState({
        status: cancelled ? 'cancelled' : 'completed',
        cancelled,
        currentSource: null,
        currentDirectory: null,
        currentFilm: null,
        finishedAt: new Date().toISOString(),
        message: cancelled ? '扫描已取消，未对未完成来源执行缺失标记' : this.state!.message ?? '扫描完成',
      });
    } catch (error) {
      runError = error instanceof Error ? error.message : 'SCAN_FAILED';
      const mergeDetails = error instanceof FilmFileOwnershipConflictError ? error.details : null;
      const duplicateMessage = error instanceof Error && error.message.startsWith('INCOMING_FILM_FILE_DUPLICATES') ? error.message : null;
      const failureDetails: ScanMergeFailureDetails | null = mergeDetails ?? (duplicateMessage ? {
        sourceId: activeSource?.id ?? 'unknown',
        relativePath: duplicateMessage.slice('INCOMING_FILM_FILE_DUPLICATES:'.length).split(';')[0] ?? 'unknown',
        existingFilmId: null,
        existingFilmTitle: null,
        targetFilmId: 'unknown',
        targetFilmTitle: null,
        groupKey: 'incoming-candidate-assertion',
        sqlStage: 'incoming-film-file-assertion',
        sqliteErrorCode: null,
      } : null);
      const cause = error instanceof Error && error.cause instanceof Error ? error.cause : null;
      if (failureDetails) {
        runError = 'DATABASE_MERGE_FAILED';
        this.logger.error('Database merge failed', {
          jobId,
          sourceId: failureDetails.sourceId,
          relativeFile: failureDetails.relativePath,
          existingFilmId: failureDetails.existingFilmId,
          targetFilmId: failureDetails.targetFilmId,
          groupKey: failureDetails.groupKey,
          sqlStage: failureDetails.sqlStage,
          sqliteErrorCode: failureDetails.sqliteErrorCode,
          sqliteError: cause?.message,
        });
        this.recordScanError(jobId, failureDetails, cause?.message ?? (error instanceof Error ? error.message : 'DATABASE_MERGE_FAILED'));
        this.sources.setScanResult(failureDetails.sourceId, 'database_failed', null);
      } else {
        this.logger.error('Scan coordinator failed', { error: runError, jobId, sourceId: activeSource?.id ?? null });
      }
      this.updateState({
        status: 'failed',
        currentSource: null,
        currentDirectory: null,
        currentFilm: null,
        finishedAt: new Date().toISOString(),
        message: '扫描异常，未对未完成来源执行缺失标记',
        otherErrors: this.state!.otherErrors + 1,
      });
      if (failureDetails) this.updateState({ status: 'database_failed', message: formatDatabaseMergeMessage(failureDetails) });
    } finally {
      const finalState = this.state!;
      this.database.db
        .prepare(
          `UPDATE scan_job SET finished_at = ?, status = ?, created_count = ?, updated_count = ?,
           moved_count = ?, missing_count = ?, error_count = ?, cancelled = ?, scan_error = ? WHERE id = ?`,
        )
        .run(
          finalState.finishedAt ?? new Date().toISOString(),
          finalState.status,
          finalState.created,
          finalState.updated,
          finalState.moved,
          finalState.missing,
          finalState.nfoErrors + finalState.ambiguousAssets + finalState.otherErrors,
          finalState.cancelled ? 1 : 0,
          runError,
          jobId,
        );
      this.cancellation = null;
      this.emit();
    }
  }

  private mergeSource(source: MediaSourceDto, candidates: FilmCandidate[], relativeDirectory: string | null = null): { created: number; updated: number; moved: number; missing: number; errors: number } {
    const now = new Date().toISOString();
    let created = 0;
    let updated = 0;
    let moved = 0;
    let errors = 0;
    const deduplicated = dedupeFilmCandidates(source.id, candidates);
    for (const conflict of deduplicated.conflicts) {
      this.logger.warn('Duplicate physical file in scan candidates', {
        sourceId: conflict.sourceId,
        relativeFile: conflict.relativePath,
        keptLogicalKey: conflict.keptLogicalKey,
        discardedLogicalKeys: conflict.discardedLogicalKeys,
        reason: conflict.reason,
      });
    }
    assertUniqueIncomingPhysicalFiles(source.id, deduplicated.candidates);
    const missing = this.database.transaction(() => {
      const sourceMissing = relativeDirectory
        ? this.films.markDirectoryMissing(source.id, relativeDirectory, now)
        : this.films.markSourceMissing(source.id, now);
      for (const candidate of deduplicated.candidates) {
        const result = this.films.upsertCandidate(candidate, now);
        if (result.created) created += 1;
        else if (result.moved) moved += 1;
        else updated += 1;
      }
      return sourceMissing;
    });
    return { created, updated, moved, missing, errors };
  }

  private recordScanError(jobId: string, details: ScanMergeFailureDetails, message: string): void {
    this.database.db.prepare(
      `INSERT INTO scan_error (id, scan_job_id, source_id, relative_path, error_type, message, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(randomUUID(), jobId, details.sourceId, details.relativePath, 'DATABASE_MERGE_FAILED', JSON.stringify({ ...details, message }), new Date().toISOString());
  }

  private updateState(patch: Partial<ScanStatusDto>): void {
    if (!this.state) return;
    this.state = { ...this.state, ...patch };
    this.emit();
  }

  private emit(): void {
    if (!this.state) return;
    for (const listener of this.listeners) listener(this.state);
  }
}

function formatDatabaseMergeMessage(details: ScanMergeFailureDetails): string {
  const existing = details.existingFilmTitle || '\u5df2\u6709\u5f71\u7247\u8bb0\u5f55';
  const target = details.targetFilmTitle || '\u65b0\u5f71\u7247\u8bb0\u5f55';
  return [
    '\u6570\u636e\u5e93\u5408\u5e76\u5931\u8d25',
    '\u539f\u56e0\uff1a\u540c\u4e00\u4e2a\u5f71\u7247\u6587\u4ef6\u88ab\u91cd\u590d\u5173\u8054\u3002',
    `\u6587\u4ef6：${details.relativePath}`,
    `\u5df2\u6709\u5f71\u7247\u8bb0\u5f55：${existing}`,
    `\u65b0\u5f71\u7247\u8bb0\u5f55：${target}`,
  ].join('\n');
}
