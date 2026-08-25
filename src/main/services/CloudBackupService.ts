import fs from 'node:fs';
import path from 'node:path';
import type {
  CloudBackupConfigUpdateInput,
  CloudBackupActivityDto,
  CloudBackupRestoreInput,
  CloudBackupRestorePreviewDto,
  CloudBackupRestoreResultDto,
  CloudBackupRunResultDto,
  CloudBackupState,
  CloudBackupStatusDto,
  CloudBackupVersionDto,
  LibraryDataBackupDocument,
} from '../../shared/contracts';
import type { AppLogger } from '../system/AppLogger';
import { CloudBackupConfigService, parseGitHubRepository } from './CloudBackupConfigService';
import { LibraryDataBackupService } from './LibraryDataBackupService';

type BackupTrigger = CloudBackupActivityDto['trigger'];
type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type ActivityListener = (activity: CloudBackupActivityDto) => void;

interface GitHubRepositoryResponse {
  private?: boolean;
  default_branch?: string;
}

interface GitHubContentResponse {
  sha?: string;
  content?: string;
  encoding?: string;
  commit?: { sha?: string };
}

const MAX_BACKUP_BYTES = 20 * 1024 * 1024;

export class CloudBackupService {
  private state: CloudBackupState = 'ready';
  private running: Promise<CloudBackupRunResultDto> | null = null;
  private activity: CloudBackupActivityDto | null = null;
  private readonly activityListeners = new Set<ActivityListener>();

  public constructor(
    private readonly config: CloudBackupConfigService,
    private readonly libraryData: LibraryDataBackupService,
    private readonly logger: AppLogger,
    private readonly fetcher: FetchLike = fetch,
  ) {}

  public status(): CloudBackupStatusDto {
    return { ...this.config.status(this.state), activity: this.activity };
  }

  public onActivity(listener: ActivityListener): () => void {
    this.activityListeners.add(listener);
    return () => this.activityListeners.delete(listener);
  }

  public async updateConfig(input: CloudBackupConfigUpdateInput): Promise<CloudBackupStatusDto> {
    await this.config.update(input);
    this.state = 'ready';
    return this.status();
  }

  public async testConnection(): Promise<CloudBackupStatusDto> {
    try {
      const context = await this.githubContext();
      await this.repositoryInfo(context);
      this.config.clearError();
      this.state = 'ready';
      return this.status();
    } catch (error) {
      this.recordError(error);
      throw error;
    }
  }

  public runBackup(trigger: BackupTrigger, force = false, timeoutMs = 15_000): Promise<CloudBackupRunResultDto> {
    if (this.running) {
      this.publishActivity(trigger, 'running');
      return this.observeRun(trigger, this.running);
    }
    this.publishActivity(trigger, 'running');
    this.running = this.runBackupInternal(trigger, force, timeoutMs)
      .then((result) => {
        this.publishActivity(trigger, result.skipped ? 'skipped' : 'success', result.commitSha);
        return result;
      })
      .catch((error: unknown) => {
        if (this.state !== 'error') this.recordError(error);
        this.publishActivity(trigger, 'error', null, error instanceof Error ? error.message : 'CLOUD_BACKUP_FAILED');
        throw error;
      })
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }

  private observeRun(trigger: BackupTrigger, operation: Promise<CloudBackupRunResultDto>): Promise<CloudBackupRunResultDto> {
    return operation.then((result) => {
      this.publishActivity(trigger, result.skipped ? 'skipped' : 'success', result.commitSha);
      return result;
    }, (error: unknown) => {
      this.publishActivity(trigger, 'error', null, error instanceof Error ? error.message : 'CLOUD_BACKUP_FAILED');
      throw error;
    });
  }

  private publishActivity(
    trigger: BackupTrigger,
    phase: CloudBackupActivityDto['phase'],
    commitSha: string | null = null,
    errorCode: string | null = null,
  ): void {
    this.activity = { trigger, phase, at: new Date().toISOString(), commitSha, errorCode };
    for (const listener of this.activityListeners) {
      try {
        listener(this.activity);
      } catch (error) {
        this.logger.warn('Cloud backup activity listener failed', {
          errorCode: error instanceof Error ? error.message : 'CLOUD_BACKUP_ACTIVITY_LISTENER_FAILED',
        });
      }
    }
  }

  public async backupOnStartup(): Promise<CloudBackupRunResultDto | null> {
    const status = this.status();
    if (!status.configured || (!status.autoBackupOnStartup && !status.pendingUpload)) return null;
    return this.runBackup('startup');
  }

  public async backupOnShutdown(timeoutMs = 8_000): Promise<CloudBackupRunResultDto | null> {
    if (!this.status().autoBackupOnQuit || !this.status().configured) return null;
    return this.runBackup('shutdown', false, timeoutMs);
  }

  public async versions(): Promise<CloudBackupVersionDto[]> {
    const context = await this.githubContext();
    const info = await this.repositoryInfo(context);
    const branch = context.branch || info.defaultBranch;
    const query = new URLSearchParams({ path: context.backupPath, sha: branch, per_page: '30' });
    const response = await this.requestJson<unknown[]>(context, `/commits?${query}`, { method: 'GET' });
    if (!Array.isArray(response)) throw new Error('CLOUD_BACKUP_REMOTE_INVALID');
    return response.flatMap((item): CloudBackupVersionDto[] => {
      if (!isRecord(item) || typeof item.sha !== 'string' || !isRecord(item.commit)) return [];
      const commit = item.commit;
      const author = isRecord(commit.author) ? commit.author : null;
      return [{
        commitSha: item.sha,
        committedAt: author && typeof author.date === 'string' ? author.date : '',
        message: typeof commit.message === 'string' ? commit.message : 'Library backup',
      }];
    });
  }

  public async previewRestore(commitSha: string): Promise<CloudBackupRestorePreviewDto> {
    const document = await this.readRemoteDocument(commitSha);
    return this.libraryData.preview(document, commitSha);
  }

  public async restore(input: CloudBackupRestoreInput): Promise<CloudBackupRestoreResultDto> {
    const document = await this.readRemoteDocument(input.commitSha);
    const preview = this.libraryData.preview(document, input.commitSha);
    if (!preview.matchedFilms) throw new Error('CLOUD_BACKUP_NO_MATCHES');
    const safetyDocument = this.libraryData.exportDocument();
    const safetyStamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
    const safetyPath = path.join(path.dirname(this.config.configFilePath), `library-data-before-restore-${safetyStamp}.json`);
    fs.writeFileSync(safetyPath, `${JSON.stringify(safetyDocument, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    const result = this.libraryData.restore(document);
    this.logger.info('Cloud backup restored', {
      commitSha: input.commitSha,
      matchedFilms: result.matchedFilms,
      segmentsRestored: result.segmentsRestored,
      safetyPath,
    });
    return result;
  }

  private async runBackupInternal(trigger: BackupTrigger, force: boolean, timeoutMs: number): Promise<CloudBackupRunResultDto> {
    this.state = 'running';
    const document = this.libraryData.exportDocument();
    const stored = this.config.getStored();
    if (!force && stored.lastDataHash === document.dataHash) {
      safeUnlink(this.config.pendingFilePath);
      this.state = 'success';
      return {
        uploaded: false,
        skipped: true,
        commitSha: stored.lastCommitSha,
        exportedAt: document.exportedAt,
        counts: document.counts,
      };
    }
    const json = `${JSON.stringify(document, null, 2)}\n`;
    if (Buffer.byteLength(json, 'utf8') > MAX_BACKUP_BYTES) throw new Error('CLOUD_BACKUP_FILE_TOO_LARGE');
    fs.mkdirSync(path.dirname(this.config.pendingFilePath), { recursive: true });
    fs.writeFileSync(this.config.pendingFilePath, json, { encoding: 'utf8', mode: 0o600 });

    try {
      const context = await this.githubContext();
      const info = await this.repositoryInfo(context, timeoutMs);
      const branch = context.branch || info.defaultBranch;
      const remote = await this.readContent(context, branch, timeoutMs, true);
      if (!force && remote?.document) assertSafeAutomaticBackup(document, remote.document);
      if (!force && remote?.document.dataHash === document.dataHash) {
        this.config.markSuccess(remote.commitSha ?? remote.blobSha, document.dataHash, document.exportedAt);
        safeUnlink(this.config.pendingFilePath);
        this.state = 'success';
        return {
          uploaded: false,
          skipped: true,
          commitSha: remote.commitSha ?? remote.blobSha,
          exportedAt: document.exportedAt,
          counts: document.counts,
        };
      }
      const body: Record<string, unknown> = {
        message: `Backup library data (${trigger}) ${document.exportedAt}`,
        content: Buffer.from(json, 'utf8').toString('base64'),
        branch,
      };
      if (remote?.blobSha) body.sha = remote.blobSha;
      const response = await this.requestJson<GitHubContentResponse>(
        context,
        `/contents/${encodePath(context.backupPath)}`,
        { method: 'PUT', body: JSON.stringify(body) },
        timeoutMs,
      );
      const commitSha = response.commit?.sha;
      if (!commitSha) throw new Error('CLOUD_BACKUP_REMOTE_INVALID');
      this.config.markSuccess(commitSha, document.dataHash, document.exportedAt);
      safeUnlink(this.config.pendingFilePath);
      this.state = 'success';
      this.logger.info('Cloud backup uploaded', {
        trigger,
        commitSha,
        filmCount: document.counts.films,
        segmentCount: document.counts.segments,
      });
      return {
        uploaded: true,
        skipped: false,
        commitSha,
        exportedAt: document.exportedAt,
        counts: document.counts,
      };
    } catch (error) {
      this.recordError(error);
      throw error;
    }
  }

  private async readRemoteDocument(ref: string): Promise<LibraryDataBackupDocument> {
    if (!/^[0-9a-f]{7,64}$/i.test(ref)) throw new Error('CLOUD_BACKUP_COMMIT_INVALID');
    const context = await this.githubContext();
    await this.repositoryInfo(context);
    const content = await this.readContent(context, ref, 15_000, false);
    if (!content) throw new Error('CLOUD_BACKUP_NOT_FOUND');
    return content.document;
  }

  private async githubContext(): Promise<{
    owner: string;
    repository: string;
    token: string;
    branch: string;
    backupPath: string;
  }> {
    const stored = this.config.getStored();
    if (!stored.repositoryUrl) throw new Error('CLOUD_BACKUP_REPOSITORY_REQUIRED');
    const repository = parseGitHubRepository(stored.repositoryUrl);
    return {
      ...repository,
      token: await this.config.token(),
      branch: stored.branch,
      backupPath: stored.backupPath,
    };
  }

  private async repositoryInfo(
    context: Awaited<ReturnType<CloudBackupService['githubContext']>>,
    timeoutMs = 15_000,
  ): Promise<{ defaultBranch: string }> {
    const response = await this.requestJson<GitHubRepositoryResponse>(context, '', { method: 'GET' }, timeoutMs);
    if (response.private !== true) throw new Error('CLOUD_BACKUP_REPOSITORY_NOT_PRIVATE');
    if (!response.default_branch) throw new Error('CLOUD_BACKUP_REMOTE_INVALID');
    return { defaultBranch: response.default_branch };
  }

  private async readContent(
    context: Awaited<ReturnType<CloudBackupService['githubContext']>>,
    ref: string,
    timeoutMs: number,
    optional: boolean,
  ): Promise<{ document: LibraryDataBackupDocument; blobSha: string; commitSha: string | null } | null> {
    const query = new URLSearchParams({ ref });
    let response: GitHubContentResponse;
    try {
      response = await this.requestJson<GitHubContentResponse>(
        context,
        `/contents/${encodePath(context.backupPath)}?${query}`,
        { method: 'GET' },
        timeoutMs,
      );
    } catch (error) {
      if (optional && error instanceof Error && error.message === 'CLOUD_BACKUP_NOT_FOUND') return null;
      throw error;
    }
    if (!response.sha || response.encoding !== 'base64' || typeof response.content !== 'string') {
      throw new Error('CLOUD_BACKUP_REMOTE_INVALID');
    }
    const content = Buffer.from(response.content.replace(/\s/g, ''), 'base64');
    if (content.length > MAX_BACKUP_BYTES) throw new Error('CLOUD_BACKUP_FILE_TOO_LARGE');
    let parsed: unknown;
    try {
      parsed = JSON.parse(content.toString('utf8'));
    } catch {
      throw new Error('CLOUD_BACKUP_FILE_INVALID');
    }
    return { document: this.libraryData.parseDocument(parsed), blobSha: response.sha, commitSha: null };
  }

  private async requestJson<T>(
    context: Awaited<ReturnType<CloudBackupService['githubContext']>>,
    suffix: string,
    init: RequestInit,
    timeoutMs = 15_000,
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await this.fetcher(
        `https://api.github.com/repos/${encodeURIComponent(context.owner)}/${encodeURIComponent(context.repository)}${suffix}`,
        {
          ...init,
          signal: controller.signal,
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${context.token}`,
            'Content-Type': 'application/json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'Local-Film-Library',
            ...init.headers,
          },
        },
      );
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw new Error('CLOUD_BACKUP_TIMEOUT', { cause: error });
      throw new Error('CLOUD_BACKUP_NETWORK_FAILED', { cause: error });
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) {
      if (response.status === 401) throw new Error('CLOUD_BACKUP_AUTH_FAILED');
      if (response.status === 403) throw new Error('CLOUD_BACKUP_FORBIDDEN');
      if (response.status === 404) throw new Error('CLOUD_BACKUP_NOT_FOUND');
      if (response.status === 409 || response.status === 422) throw new Error('CLOUD_BACKUP_CONFLICT');
      throw new Error('CLOUD_BACKUP_REMOTE_FAILED');
    }
    try {
      return await response.json() as T;
    } catch {
      throw new Error('CLOUD_BACKUP_REMOTE_INVALID');
    }
  }

  private recordError(error: unknown): void {
    const code = error instanceof Error ? error.message : 'CLOUD_BACKUP_FAILED';
    this.state = 'error';
    try { this.config.markError(code); } catch { /* Keep the original error. */ }
    this.logger.warn('Cloud backup operation failed', { errorCode: code });
  }
}

function assertSafeAutomaticBackup(local: LibraryDataBackupDocument, remote: LibraryDataBackupDocument): void {
  if (local.counts.films === 0 && remote.counts.films > 0) throw new Error('CLOUD_BACKUP_EMPTY_LIBRARY');
  if (remote.counts.films >= 20 && local.counts.films < Math.floor(remote.counts.films * 0.5)) {
    throw new Error('CLOUD_BACKUP_LIBRARY_REGRESSION');
  }
}

function encodePath(value: string): string {
  return value.split('/').map(encodeURIComponent).join('/');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeUnlink(filePath: string): void {
  try { fs.unlinkSync(filePath); } catch { /* A later successful run can clean it up. */ }
}
