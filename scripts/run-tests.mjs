import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
let electron;
try {
  // The Electron package prepares its binary on first require in a clean install.
  // Its entry point also resolves platform-specific paths and distribution overrides.
  electron = require('electron');
} catch (error) {
  console.error('[test-runner] Could not prepare Electron:', error);
  process.exit(1);
}
const vitest = path.join(root, 'node_modules', 'vitest', 'vitest.mjs');
console.log(`[test-runner] Running tests with ${electron}`);
const result = spawnSync(electron, [vitest, 'run', ...process.argv.slice(2)], {
  cwd: root,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  stdio: 'inherit',
  windowsHide: true,
});
if (result.error) console.error('[test-runner] Failed to start Electron:', result.error);
if (result.signal) console.error(`[test-runner] Electron terminated by signal ${result.signal}`);
process.exit(result.status ?? 1);
