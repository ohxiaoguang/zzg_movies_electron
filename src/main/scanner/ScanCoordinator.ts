import { randomUUID } from 'node:crypto';
import type { MediaSourceDto, ScanStartDto, ScanStartInput, ScanStatusDto } from '../../shared/contracts';
import type { DatabaseManager } from '../database/DatabaseManager';
import { FilmRepository } from '../database/repositories/FilmRepository';
import { SettingsRepository } from '../database/repositories/SettingsRepository';
import { SourceRepository } from '../database/repositories/SourceRepository';
import type { AppLogger } from '../system/AppLogger';
import { ScanCancellation } from './ScanCancellation';
import type { FilmCandidate } from './ScanCandidate';
import { SourceScanner } from './SourceScanner';

type ProgressListener = (progress: ScanStatusDto) => void;

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
    if (this.state?.status === 'running') throw new Error('SCAN_ALREADY_RUNNING');
    const available = this.sources.list().filter((source) => source.enabled && !source.archived);
    const selected = input.sourceIds?.length
      ? available.filter((source) => input.sourceIds!.includes(source.id))
      : available;
    if (input.sourceIds?.length && selected.length !== input.sourceIds.length) throw new Error('SOURCE_NOT_FOUND');
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
      sourceCount: selected.length,
      cancelled: false,
    };
    this.database.db
      .prepare('INSERT INTO scan_job (id, started_at, status, source_count) VALUES (?, ?, ?, ?)')
      .run(jobId, startedAt, 'running', selected.length);
    this.emit();
    void this.run(selected, jobId);
    return { jobId };
  }

  public cancel(): void {
    this.cancellation?.cancel();
  }

  public status(): ScanStatusDto | null {
    return this.state;
  }

  private async run(selected: MediaSourceDto[], jobId: string): Promise<void> {
    const cancellation = this.cancellation!;
    let runError: string | null = null;
    try {
      for (const source of selected) {
        if (cancellation.cancelled) break;
        this.updateState({ currentSource: source.name, currentDirectory: '.', currentFilm: null });
        const scanner = new SourceScanner(source, {
          settings: this.settings.get(),
          cancellation,
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
          this.sources.setScanResult(source.id, 'offline', null);
          this.updateState({ message: `${source.name} 离线，已保留原有缺失状态` });
          continue;
        }
        if (!result.complete) {
          this.sources.setScanResult(source.id, 'incomplete', null);
          this.updateState({ message: `${source.name} 扫描不完整，未执行缺失标记` });
          continue;
        }
        const merge = this.mergeSource(source, result.candidates);
        this.updateState({
          created: this.state!.created + merge.created,
          updated: this.state!.updated + merge.updated,
          moved: this.state!.moved + merge.moved,
          missing: this.state!.missing + merge.missing,
          otherErrors: this.state!.otherErrors + merge.errors,
        });
        this.sources.setScanResult(source.id, 'completed', new Date().toISOString());
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
      this.logger.error('Scan coordinator failed', { error: runError, jobId });
      this.updateState({
        status: 'failed',
        currentSource: null,
        currentDirectory: null,
        currentFilm: null,
        finishedAt: new Date().toISOString(),
        message: '扫描异常，未对未完成来源执行缺失标记',
        otherErrors: this.state!.otherErrors + 1,
      });
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

  private mergeSource(source: MediaSourceDto, candidates: FilmCandidate[]): { created: number; updated: number; moved: number; missing: number; errors: number } {
    const now = new Date().toISOString();
    let created = 0;
    let updated = 0;
    let moved = 0;
    let errors = 0;
    const missing = this.database.transaction(() => {
      const sourceMissing = this.films.markSourceMissing(source.id, now);
      for (const candidate of candidates) {
        const byPath = this.films.findByPath(source.id, candidate.relativePath);
        if (byPath) {
          this.films.updateFromCandidate(byPath.id, candidate, now);
          updated += 1;
          continue;
        }
        const byFingerprint = this.films.findByFingerprint(source.id, candidate.fingerprint);
        if (byFingerprint.length === 1) {
          this.films.updateFromCandidate(byFingerprint[0].id, candidate, now);
          moved += 1;
          continue;
        }
        if (byFingerprint.length > 1) errors += 1;
        this.films.insertCandidate(candidate, now);
        created += 1;
      }
      return sourceMissing;
    });
    return { created, updated, moved, missing, errors };
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
