import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AccountCredentialService } from '../src/main/services/AccountCredentialService';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('shared account credentials', () => {
  it('stores only a salted password hash and requires login in a new desktop session', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'film-library-account-'));
    roots.push(root);
    const credentialPath = path.join(root, 'account-credentials.json');
    const service = new AccountCredentialService(credentialPath);

    expect(service.status(10)).toMatchObject({ configured: false, authenticated: false });
    expect(service.setup({ username: 'owner', password: 'a-secure-password' }, 10)).toMatchObject({
      configured: true,
      authenticated: true,
      username: 'owner',
    });

    const stored = fs.readFileSync(credentialPath, 'utf8');
    expect(stored).toContain('"username": "owner"');
    expect(stored).not.toContain('a-secure-password');
    expect(service.status(11)).toMatchObject({ configured: true, authenticated: false, username: null });
    expect(() => service.login({ username: 'owner', password: 'wrong-password' }, 11)).toThrow('INVALID_ACCOUNT_CREDENTIALS');
    expect(service.login({ username: 'owner', password: 'a-secure-password' }, 11).authenticated).toBe(true);
  });

  it('returns to first-time setup after the credential file is manually deleted', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'film-library-account-reset-'));
    roots.push(root);
    const credentialPath = path.join(root, 'account-credentials.json');
    const service = new AccountCredentialService(credentialPath);
    service.setup({ username: 'owner', password: 'a-secure-password' }, 10);

    fs.unlinkSync(credentialPath);

    expect(service.status(10)).toMatchObject({ configured: false, authenticated: false });
    expect(service.setup({ username: 'new-owner', password: 'another-password' }, 10)).toMatchObject({
      configured: true,
      authenticated: true,
      username: 'new-owner',
    });
  });

  it('accepts a one-character password without complexity rules', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'film-library-account-short-password-'));
    roots.push(root);
    const service = new AccountCredentialService(path.join(root, 'account-credentials.json'));

    expect(service.setup({ username: 'owner', password: '1' }, 10).authenticated).toBe(true);
    expect(service.login({ username: 'owner', password: '1' }, 11).authenticated).toBe(true);
    expect(() => service.login({ username: 'owner', password: '' }, 12)).toThrow('INVALID_ACCOUNT_PASSWORD');
  });
});
