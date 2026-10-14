import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(electronEntry: string, testEntry = 'console.log("FIXTURE_TESTS_STARTED");', ci = 'false') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'film-test-runner-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.mkdirSync(path.join(root, 'node_modules', 'electron'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules', 'vitest'), { recursive: true });
  fs.copyFileSync(path.resolve('scripts/run-tests.mjs'), path.join(root, 'scripts/run-tests.mjs'));
  fs.writeFileSync(path.join(root, 'node_modules/electron/index.js'), electronEntry);
  fs.writeFileSync(path.join(root, 'node_modules/vitest/vitest.mjs'), testEntry);
  return spawnSync(process.execPath, [path.join(root, 'scripts/run-tests.mjs'), '--reporter=verbose'], {
    env: { ...process.env, CI: ci, ELECTRON_RUN_AS_NODE: '1' },
    windowsHide: true,
    encoding: 'utf8',
  });
}

describe('test runner bootstrapping', () => {
  it('uses the package entry without assuming a pre-existing dist/electron.exe', () => {
    const result = fixture('console.log("PACKAGE_ENTRY_RESOLVED"); module.exports = process.execPath;',
      'console.log("FIXTURE_TESTS_STARTED", process.argv.slice(2).join(" "));');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('PACKAGE_ENTRY_RESOLVED');
    expect(result.stdout).toContain('FIXTURE_TESTS_STARTED run --reporter=verbose');
  });

  it('limits CI concurrency and gives integration operations a finite startup budget', () => {
    const result = fixture('module.exports = process.execPath;',
      'console.log(JSON.stringify(process.argv.slice(2)));', 'true');
    expect(result.status).toBe(0);
    const args = JSON.parse(result.stdout.trim().split('\n').at(-1)!);
    expect(args).toContain('--maxWorkers=2');
    expect(args).toContain('--testTimeout=20000');
    expect(args).toContain('--hookTimeout=30000');
  });

  it('keeps local test timeouts unchanged', () => {
    const result = fixture('module.exports = process.execPath;',
      'console.log(JSON.stringify(process.argv.slice(2)));');
    expect(result.status).toBe(0);
    const args = JSON.parse(result.stdout.trim().split('\n').at(-1)!);
    expect(args.some((arg: string) => arg.startsWith('--testTimeout') || arg.startsWith('--maxWorkers'))).toBe(false);
  });

  it('reports binary preparation failures instead of returning only exit code 1', () => {
    const result = fixture('throw new Error("DOWNLOAD_FAILED");');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Could not prepare Electron');
    expect(result.stderr).toContain('DOWNLOAD_FAILED');
  });

  it('reports the actual spawn error for a missing executable', () => {
    const result = fixture('module.exports = require("node:path").join(__dirname, "missing.exe");');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Failed to start Electron');
    expect(result.stderr).toContain('ENOENT');
  });

  it('preserves a failing test exit code', () => {
    expect(fixture('module.exports = process.execPath;', 'process.exit(7);').status).toBe(7);
  });
});
