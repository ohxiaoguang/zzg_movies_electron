import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { AccountAuthStatusDto, AccountCredentialsInput } from '../../shared/contracts';

const CREDENTIAL_VERSION = 1;
const PASSWORD_KEY_BYTES = 32;
const MAX_USERNAME_LENGTH = 64;

interface CredentialRecord {
  version: number;
  id: string;
  username: string;
  salt: string;
  passwordHash: string;
  createdAt: string;
}

export class AccountCredentialService {
  private readonly desktopSessions = new Map<number, string>();

  public constructor(public readonly credentialFilePath: string) {}

  public status(webContentsId: number): AccountAuthStatusDto {
    const record = this.readCredential();
    if (!record) {
      this.desktopSessions.clear();
      return {
        configured: false,
        authenticated: false,
        username: null,
        credentialFilePath: this.credentialFilePath,
      };
    }
    const authenticated = this.desktopSessions.get(webContentsId) === record.id;
    return {
      configured: true,
      authenticated,
      username: authenticated ? record.username : null,
      credentialFilePath: this.credentialFilePath,
    };
  }

  public setup(input: AccountCredentialsInput, webContentsId: number): AccountAuthStatusDto {
    const credentials = validateCredentials(input);
    if (fs.existsSync(this.credentialFilePath)) throw new Error('ACCOUNT_ALREADY_CONFIGURED');
    fs.mkdirSync(path.dirname(this.credentialFilePath), { recursive: true });
    const salt = randomBytes(16).toString('base64url');
    const record: CredentialRecord = {
      version: CREDENTIAL_VERSION,
      id: randomBytes(16).toString('hex'),
      username: credentials.username,
      salt,
      passwordHash: passwordHash(credentials.password, salt).toString('base64url'),
      createdAt: new Date().toISOString(),
    };
    try {
      fs.writeFileSync(this.credentialFilePath, `${JSON.stringify(record, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
    } catch (error) {
      if (isFileExistsError(error)) throw new Error('ACCOUNT_ALREADY_CONFIGURED', { cause: error });
      throw new Error('ACCOUNT_CREDENTIAL_WRITE_FAILED', { cause: error });
    }
    this.desktopSessions.set(webContentsId, record.id);
    return this.status(webContentsId);
  }

  public login(input: AccountCredentialsInput, webContentsId: number): AccountAuthStatusDto {
    const record = this.verify(input);
    this.desktopSessions.set(webContentsId, record.id);
    return this.status(webContentsId);
  }

  public logout(webContentsId: number): AccountAuthStatusDto {
    this.desktopSessions.delete(webContentsId);
    return this.status(webContentsId);
  }

  public isDesktopAuthenticated(webContentsId: number): boolean {
    return this.status(webContentsId).authenticated;
  }

  public verify(input: AccountCredentialsInput): { id: string; username: string } {
    const credentials = validateCredentials(input);
    const record = this.readCredential();
    if (!record) throw new Error('ACCOUNT_SETUP_REQUIRED');
    const candidate = passwordHash(credentials.password, record.salt);
    const expected = Buffer.from(record.passwordHash, 'base64url');
    const passwordMatches = candidate.length === expected.length && timingSafeEqual(candidate, expected);
    if (credentials.username !== record.username || !passwordMatches) throw new Error('INVALID_ACCOUNT_CREDENTIALS');
    return { id: record.id, username: record.username };
  }

  public currentCredentialId(): string | null {
    return this.readCredential()?.id ?? null;
  }

  private readCredential(): CredentialRecord | null {
    let text: string;
    try {
      text = fs.readFileSync(this.credentialFilePath, 'utf8');
    } catch (error) {
      if (isFileMissingError(error)) return null;
      throw new Error('ACCOUNT_CREDENTIAL_READ_FAILED', { cause: error });
    }
    try {
      const value = JSON.parse(text) as Partial<CredentialRecord>;
      if (
        value.version !== CREDENTIAL_VERSION
        || typeof value.id !== 'string'
        || !/^[0-9a-f]{32}$/.test(value.id)
        || typeof value.username !== 'string'
        || !value.username
        || typeof value.salt !== 'string'
        || typeof value.passwordHash !== 'string'
        || typeof value.createdAt !== 'string'
        || Buffer.from(value.passwordHash, 'base64url').length !== PASSWORD_KEY_BYTES
      ) {
        throw new Error('ACCOUNT_CREDENTIAL_FILE_INVALID');
      }
      return value as CredentialRecord;
    } catch (error) {
      if (error instanceof Error && error.message === 'ACCOUNT_CREDENTIAL_FILE_INVALID') throw error;
      throw new Error('ACCOUNT_CREDENTIAL_FILE_INVALID', { cause: error });
    }
  }
}

function validateCredentials(input: AccountCredentialsInput): AccountCredentialsInput {
  if (!input || typeof input.username !== 'string' || typeof input.password !== 'string') {
    throw new Error('INVALID_ACCOUNT_INPUT');
  }
  const username = input.username.trim().normalize('NFKC');
  if (!username || username.length > MAX_USERNAME_LENGTH || hasControlCharacter(username)) {
    throw new Error('INVALID_ACCOUNT_USERNAME');
  }
  if (input.password.length < 1) {
    throw new Error('INVALID_ACCOUNT_PASSWORD');
  }
  return { username, password: input.password };
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

function passwordHash(password: string, salt: string): Buffer {
  return scryptSync(password, salt, PASSWORD_KEY_BYTES, { N: 16_384, r: 8, p: 1 });
}

function isFileMissingError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

function isFileExistsError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST');
}
