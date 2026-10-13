import { randomUUID } from 'node:crypto';
import type { MediaSourceDto, ScanStartDto, ScanStartInput, ScanStatusDto, ScanIssueDto, ScanIssuesQuery, ScanIssuesPageDto } from '../../shared/contracts';
import type { DatabaseManager } from '../database/DatabaseManager';
import { FilmFileOwnershipConflictError, FilmRepository } from '../database/repositories/FilmRepository';
import { SettingsRepository } from '../database/repositories/SettingsRepository';
import { SourceRepository } from '../database/repositories/SourceRepository';
import type { AppLogger } from '../system/AppLogger';
import { ScanCancellation } from './ScanCancellation';
import { ScanSourceMerger } from './ScanSourceMerger';
import type { ScanWorkerClient, ScanWorkerResult } from './ScanWorkerClient';
import type { SourceScanResult, SourceScannerProgress } from './SourceScanner';
import { isRecord, isUuid } from '../../shared/validation';
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
  private progressTimer: ReturnType<typeof setTimeout> | null = null;
  private lastProgressAt = 0;

  public constructor(
    private readonly database: DatabaseManager,
    private readonly sources: SourceRepository,
    private readonly films: FilmRepository,
    private readonly settings: SettingsRepository,
    private readonly logger: AppLogger,
    private readonly worker?: ScanWorkerClient,
  ) {}

  public onProgress(listener: ProgressListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public start(input: ScanStartInput): ScanStartDto {
    const available = this.sources.list(false).filter((source) => source.enabled && !source.archived);
    const selected = input.sourceIds?.length
      ? available.filter((source) => input.sourceIds!.includes(source.id))
      : available;
    if (input.sourceIds?.length && selected.length !== input.sourceIds.length) throw new Error('SOURCE_NOT_FOUND');
    return this.begin(selected.map((source) => ({ source, relativeDirectory: null })));
  }

  public startDirectory(sourceId: string, relativeDirectory: string): ScanStartDto {
    const source = this.sources.list(false).find((item) => item.id === sourceId && item.enabled && !item.archived);
    if (!source) throw new Error('SOURCE_NOT_FOUND');
    const normalized = normalizeRelativeDirectory(relativeDirectory);
    return this.begin([{ source, relativeDirectory: normalized }]);
  }

  private begin(targets: ScanTarget[]): ScanStartDto {
    if (this.state?.status === 'running') throw new Error('SCAN_ALREADY_RUNNING');
    const release = this.database.operations.acquire('scan');
    try {
      this.database.assertTransfersRecovered();
      const jobId = randomUUID();
      const startedAt = new Date().toISOString();
      this.cancellation = new ScanCancellation();
      this.state = {
        jobId,
        status: 'running',
        issueCount: 0,
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
      void this.run(targets, jobId).catch((error: unknown) => {
        this.logger.error('Scan finalization failed', { error: error instanceof Error ? error.message : 'SCAN_FAILED' });
      }).finally(release);
      return { jobId };
    } catch (error) {
      release();
      this.state = null;
      this.cancellation = null;
      throw error;
    }
  }

  public cancel(): void {
    this.cancellation?.cancel();
  }

  public status(): ScanStatusDto | null {
    if (!this.state) {
      const row = this.database.db.prepare("SELECT value_json AS message FROM app_setting WHERE key = 'scan:last-report'").get() as { message: string } | undefined;
      if (row) { try { this.state = JSON.parse(row.message) as ScanStatusDto; } catch { /* Ignore a damaged historical report. */ } }
    }
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
        const baseDiscovered = this.state!.discovered;
        const baseProcessed = this.state!.processed;
        this.updateState({ phase: 'discovering', currentSource: source.name, currentDirectory: target.relativeDirectory ?? '.', currentFilm: null });
        const onProgress = (progress: SourceScannerProgress) => {
          this.updateState({ currentDirectory: progress.currentDirectory, currentFilm: progress.currentFilm, phase: progress.phase,
            discovered: baseDiscovered + progress.discovered, processed: baseProcessed + progress.processed });
        };
        const mergeReady = (scan: SourceScanResult) => {
          this.recordIssues(jobId, scan.issues ?? []);
          this.updateState({ phase: 'merging' }); this.emit(true);
        };
        const result: ScanWorkerResult = this.worker
          ? await this.worker.run(source, this.settings.get(), target.relativeDirectory, cancellation, onProgress, mergeReady)
          : await new SourceScanner(source, { settings: this.settings.get(), cancellation,
            relativeDirectory: target.relativeDirectory ?? undefined, onProgress }).scan();
        this.recordIssues(jobId, result.issues ?? []);
        this.updateState({
          discovered: baseDiscovered + result.stats.discovered,
          processed: baseProcessed + result.stats.processed,
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
        this.updateState({ phase: 'merging' });
        this.emit(true);
        const merge = result.merge ?? new ScanSourceMerger(this.database, this.films, this.logger).merge(source, result.candidates, target.relativeDirectory, cancellation);
        this.recordIssues(jobId, merge.issues);
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
      if (cancellation.cancelled && error instanceof Error && error.message === 'SCAN_CANCELLED') {
        this.updateState({ status: 'cancelled', cancelled: true, currentSource: null, currentDirectory: null, currentFilm: null,
          finishedAt: new Date().toISOString(), message: '扫描已取消，未完成来源的数据库变更已回滚' });
        return;
      }
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
        this.recordIssues(jobId, [{ id: randomUUID(), type: 'filesystem', sourceId: activeSource?.id ?? null,
          sourceName: activeSource?.name ?? '', filmTitle: this.state!.currentFilm ?? '', relativePath: this.state!.currentDirectory ?? '.',
          relatedPaths: [], message: `扫描失败：${runError}` }]);
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
      this.database.db.prepare("INSERT INTO app_setting (key, value_json) VALUES ('scan:last-report', ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json").run(JSON.stringify(finalState));
      this.cancellation = null;
      this.emit();
    }
  }

  private recordIssues(jobId: string, issues: ScanIssueDto[]): void {
    if (!issues.length) return;
    const insert = this.database.db.prepare(`INSERT OR IGNORE INTO scan_error
      (id, scan_job_id, source_id, relative_path, error_type, message, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    let added = 0;
    this.database.transaction(() => {
      for (const issue of issues) added += Number(insert.run(issue.id, jobId, issue.sourceId, issue.relativePath, issue.type, JSON.stringify(issue), new Date().toISOString()).changes);
    });
    this.updateState({ issueCount: (this.state?.issueCount ?? 0) + added });
  }

  public issues(payload: unknown): ScanIssuesPageDto {
    if (!isRecord(payload) || !isUuid(payload.jobId) || !Number.isInteger(payload.page) || (payload.page as number) < 1
      || !Number.isInteger(payload.pageSize) || (payload.pageSize as number) < 1 || (payload.pageSize as number) > 100
      || (payload.search !== undefined && (typeof payload.search !== 'string' || payload.search.length > 500))
      || (payload.type !== undefined && !['nfo', 'asset', 'filesystem', 'missing', 'database', 'source_offline'].includes(payload.type as string))) throw new Error('INVALID_SCAN_ISSUES_QUERY');
    const query = payload as unknown as ScanIssuesQuery;
    const params: unknown[] = [query.jobId];
    let where = "WHERE e.scan_job_id = ? AND e.error_type <> 'SCAN_REPORT'";
    if (query.type === 'database') where += " AND e.error_type IN ('database', 'DATABASE_MERGE_FAILED')";
    else if (query.type) { where += ' AND e.error_type = ?'; params.push(query.type); }
    if (query.search?.trim()) {
      where += " AND (e.relative_path LIKE ? ESCAPE '\\' OR e.message LIKE ? ESCAPE '\\' OR s.name LIKE ? ESCAPE '\\')";
      const search = `%${query.search.trim().replace(/[\\%_]/g, (value) => `\\${value}`)}%`; params.push(search, search, search);
    }
    const total = (this.database.db.prepare(`SELECT COUNT(*) AS total FROM scan_error e LEFT JOIN media_source s ON s.id = e.source_id ${where}`).get(...params) as { total: number }).total;
    const rows = this.database.db.prepare(`SELECT e.*, s.name AS source_name FROM scan_error e LEFT JOIN media_source s ON s.id = e.source_id ${where} ORDER BY e.created_at, e.id LIMIT ? OFFSET ?`)
      .all(...params, query.pageSize, (query.page - 1) * query.pageSize) as Array<{ id: string; error_type: string; source_id: string | null; source_name: string | null; relative_path: string | null; message: string }>;
    return { page: query.page, pageSize: query.pageSize, total, items: rows.map((row) => {
      let details: Partial<ScanIssueDto> = {}; try { const parsed = JSON.parse(row.message) as unknown; if (isRecord(parsed)) details = parsed as Partial<ScanIssueDto>; } catch { /* Older error rows contain plain text. */ }
      return { id: row.id, type: row.error_type === 'DATABASE_MERGE_FAILED' ? 'database' : row.error_type as ScanIssueDto['type'],
        sourceId: row.source_id, sourceName: row.source_name ?? details.sourceName ?? '已移除来源',
        filmTitle: details.filmTitle ?? '', relativePath: row.relative_path ?? '.', message: details.message ?? row.message,
        relatedPaths: details.relatedPaths ?? [] };
    }) };
  }

  public issueLocation(id: unknown): { rootPath: string; relativePath: string } {
    if (!isUuid(id)) throw new Error('INVALID_SCAN_ISSUE_ID');
    const row = this.database.db.prepare(`SELECT s.root_path, e.relative_path FROM scan_error e JOIN media_source s ON s.id = e.source_id WHERE e.id = ?`).get(id) as { root_path: string; relative_path: string | null } | undefined;
    if (!row) throw new Error('SOURCE_NOT_FOUND');
    return { rootPath: row.root_path, relativePath: row.relative_path ?? '.' };
  }

  private recordScanError(jobId: string, details: ScanMergeFailureDetails, message: string): void {
    this.database.db.prepare(
      `INSERT INTO scan_error (id, scan_job_id, source_id, relative_path, error_type, message, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(randomUUID(), jobId, details.sourceId, details.relativePath, 'DATABASE_MERGE_FAILED', JSON.stringify({ ...details, filmTitle: details.targetFilmTitle ?? details.existingFilmTitle ?? '', relatedPaths: [], message: `数据库合并失败，已回滚本来源的修改：${message}` }), new Date().toISOString());
    this.updateState({ issueCount: (this.state?.issueCount ?? 0) + 1 });
  }

  private updateState(patch: Partial<ScanStatusDto>): void {
    if (!this.state) return;
    this.state = { ...this.state, ...patch };
    this.emit();
  }

  private emit(force = false): void {
    if (!this.state) return;
    if (!force && this.state.status === 'running' && Date.now() - this.lastProgressAt < 100) {
      this.progressTimer ??= setTimeout(() => { this.progressTimer = null; this.emit(true); }, 100);
      return;
    }
    if (this.progressTimer) clearTimeout(this.progressTimer);
    this.progressTimer = null;
    this.lastProgressAt = Date.now();
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
