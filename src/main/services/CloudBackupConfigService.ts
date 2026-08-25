import fs from 'node:fs';
import path from 'node:path';
import type { CloudBackupConfigUpdateInput, CloudBackupStatusDto } from '../../shared/contracts';

export interface SecretProtector {
  encryptStringAsync(value: string): Promise<Buffer>;
  decryptStringAsync(value: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }>;
}

interface StoredCloudBackupConfig {
  version: 1;
  repositoryUrl: string;
  branch: string;
  backupPath: string;
  autoBackupOnStartup: boolean;
  autoBackupOnQuit: boolean;
  encryptedToken: string;
  lastSuccessAt: string | null;
  lastCommitSha: string | null;
  lastDataHash: string | null;
  lastErrorCode: string | null;
}

const DEFAULT_CONFIG: StoredCloudBackupConfig = {
  version: 1,
  repositoryUrl: '',
  branch: '',
  backupPath: 'library-backup.json',
  autoBackupOnStartup: false,
  autoBackupOnQuit: false,
  encryptedToken: '',
  lastSuccessAt: null,
  lastCommitSha: null,
  lastDataHash: null,
  lastErrorCode: null,
};

export class CloudBackupConfigService {
  public constructor(
    public readonly configFilePath: string,
    public readonly pendingFilePath: string,
    private readonly secrets: SecretProtector,
  ) {}

  public getStored(): StoredCloudBackupConfig {
    let parsed: unknown;
    try {
      if (!fs.existsSync(this.configFilePath)) return { ...DEFAULT_CONFIG };
      parsed = JSON.parse(fs.readFileSync(this.configFilePath, 'utf8'));
    } catch {
      throw new Error('CLOUD_BACKUP_CONFIG_READ_FAILED');
    }
    if (!isRecord(parsed) || parsed.version !== 1) throw new Error('CLOUD_BACKUP_CONFIG_INVALID');
    return {
      ...DEFAULT_CONFIG,
      repositoryUrl: typeof parsed.repositoryUrl === 'string' ? parsed.repositoryUrl : '',
      branch: typeof parsed.branch === 'string' ? parsed.branch : '',
      backupPath: typeof parsed.backupPath === 'string' ? parsed.backupPath : DEFAULT_CONFIG.backupPath,
      autoBackupOnStartup: parsed.autoBackupOnStartup === true,
      autoBackupOnQuit: parsed.autoBackupOnQuit === true,
      encryptedToken: typeof parsed.encryptedToken === 'string' ? parsed.encryptedToken : '',
      lastSuccessAt: nullableString(parsed.lastSuccessAt),
      lastCommitSha: nullableString(parsed.lastCommitSha),
      lastDataHash: nullableString(parsed.lastDataHash),
      lastErrorCode: nullableString(parsed.lastErrorCode),
    };
  }

  public status(state: CloudBackupStatusDto['state']): CloudBackupStatusDto {
    const stored = this.getStored();
    const tokenConfigured = Boolean(stored.encryptedToken);
    const configured = Boolean(stored.repositoryUrl && tokenConfigured);
    return {
      state: configured ? state : 'disabled',
      repositoryUrl: stored.repositoryUrl,
      branch: stored.branch,
      backupPath: stored.backupPath,
      tokenConfigured,
      configured,
      autoBackupOnStartup: stored.autoBackupOnStartup,
      autoBackupOnQuit: stored.autoBackupOnQuit,
      lastSuccessAt: stored.lastSuccessAt,
      lastCommitSha: stored.lastCommitSha,
      lastErrorCode: stored.lastErrorCode,
      pendingUpload: fs.existsSync(this.pendingFilePath),
      activity: null,
    };
  }

  public async update(input: CloudBackupConfigUpdateInput): Promise<void> {
    const current = this.getStored();
    const repositoryUrl = input.repositoryUrl.trim();
    if (repositoryUrl) parseGitHubRepository(repositoryUrl);
    const branch = input.branch.trim();
    if (branch.length > 200 || [...branch].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })) throw new Error('CLOUD_BACKUP_BRANCH_INVALID');
    let encryptedToken = current.encryptedToken;
    if (input.clearToken) encryptedToken = '';
    if (input.token !== undefined && input.token.trim()) {
      if (input.token.trim().length > 1000) throw new Error('CLOUD_BACKUP_TOKEN_INVALID');
      encryptedToken = (await this.secrets.encryptStringAsync(input.token.trim())).toString('base64');
    }
    const targetChanged = repositoryUrl !== current.repositoryUrl || branch !== current.branch;
    this.write({
      ...current,
      repositoryUrl,
      branch,
      autoBackupOnStartup: input.autoBackupOnStartup,
      autoBackupOnQuit: input.autoBackupOnQuit,
      encryptedToken,
      lastSuccessAt: targetChanged ? null : current.lastSuccessAt,
      lastCommitSha: targetChanged ? null : current.lastCommitSha,
      lastDataHash: targetChanged ? null : current.lastDataHash,
      lastErrorCode: null,
    });
  }

  public async token(): Promise<string> {
    const stored = this.getStored();
    if (!stored.encryptedToken) throw new Error('CLOUD_BACKUP_TOKEN_REQUIRED');
    try {
      const encrypted = Buffer.from(stored.encryptedToken, 'base64');
      const decrypted = await this.secrets.decryptStringAsync(encrypted);
      if (decrypted.shouldReEncrypt) {
        const reEncrypted = await this.secrets.encryptStringAsync(decrypted.result);
        this.write({ ...stored, encryptedToken: reEncrypted.toString('base64') });
      }
      return decrypted.result;
    } catch {
      throw new Error('CLOUD_BACKUP_TOKEN_DECRYPT_FAILED');
    }
  }

  public markSuccess(commitSha: string, dataHash: string, at: string): void {
    const stored = this.getStored();
    this.write({
      ...stored,
      lastSuccessAt: at,
      lastCommitSha: commitSha,
      lastDataHash: dataHash,
      lastErrorCode: null,
    });
  }

  public markError(code: string): void {
    const stored = this.getStored();
    this.write({ ...stored, lastErrorCode: code.slice(0, 200) });
  }

  public clearError(): void {
    const stored = this.getStored();
    if (stored.lastErrorCode) this.write({ ...stored, lastErrorCode: null });
  }

  private write(config: StoredCloudBackupConfig): void {
    fs.mkdirSync(path.dirname(this.configFilePath), { recursive: true });
    const tempPath = `${this.configFilePath}.tmp`;
    try {
      fs.writeFileSync(tempPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tempPath, this.configFilePath);
    } catch {
      try { fs.unlinkSync(tempPath); } catch { /* Best-effort cleanup. */ }
      throw new Error('CLOUD_BACKUP_CONFIG_WRITE_FAILED');
    }
  }
}

export function parseGitHubRepository(repositoryUrl: string): { owner: string; repository: string } {
  const value = repositoryUrl.trim();
  const shorthand = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(value);
  if (shorthand) return { owner: shorthand[1]!, repository: shorthand[2]! };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('CLOUD_BACKUP_REPOSITORY_INVALID');
  }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com' || url.username || url.password || url.search || url.hash) {
    throw new Error('CLOUD_BACKUP_REPOSITORY_INVALID');
  }
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length !== 2) throw new Error('CLOUD_BACKUP_REPOSITORY_INVALID');
  const owner = parts[0]!;
  const repository = parts[1]!.replace(/\.git$/i, '');
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error('CLOUD_BACKUP_REPOSITORY_INVALID');
  }
  return { owner, repository };
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
