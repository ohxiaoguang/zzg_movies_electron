import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executable = path.resolve(process.argv[2] ?? path.join(projectRoot, 'out/local-film-library-win32-x64/local-film-library.exe'));
const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS ?? 30_000);
let cdpMessageId = 0;

let child;
let smokeRoot;
let logFile;

try {
  if (!fs.existsSync(executable)) throw new Error(`Packaged executable not found: ${executable}`);
  const port = await findFreePort();
  smokeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'local-film-library-smoke-'));
  const userData = path.join(smokeRoot, 'user-data');
  const mediaRoot = path.join(smokeRoot, 'media-root');
  fs.mkdirSync(mediaRoot, { recursive: true });

  child = spawn(executable, [
    `--user-data-dir=${userData}`,
    '--disable-gpu',
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${port}`,
  ], {
    cwd: path.dirname(executable),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let processOutput = '';
  child.stdout?.on('data', (chunk) => { processOutput += String(chunk); });
  child.stderr?.on('data', (chunk) => { processOutput += String(chunk); });

  logFile = path.join(userData, 'logs', 'application.log');
  await waitFor(() => {
    const contents = readText(logFile);
    return contents.includes('Renderer did-finish-load') ? contents : false;
  }, timeoutMs, () => `renderer did not finish loading\n${processOutput}`);

  const page = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`);
    if (!response.ok) return false;
    const pages = await response.json();
    return pages.find((item) => item.type === 'page' && item.webSocketDebuggerUrl) ?? false;
  }, timeoutMs, () => `Chrome DevTools page was not exposed\n${processOutput}`);

  const socket = await connectWebSocket(page.webSocketDebuggerUrl);
  try {
    try {
      await cdpEvaluate(socket, '1 + 1', false);
    } catch (error) {
      throw new Error(`CDP probe failed page=${JSON.stringify(page)} state=${socket.readyState}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    const sourcePath = JSON.stringify(mediaRoot);
    const evaluation = await cdpEvaluate(socket, `(async () => {
      const health = await window.filmLibrary.app.health();
      const before = await window.filmLibrary.sources.list();
      const created = await window.filmLibrary.sources.create({ name: 'Smoke Source', rootPath: ${sourcePath} });
      const after = await window.filmLibrary.sources.list();
      return { health, before, created, after };
    })()`, true);

    if (evaluation?.exceptionDetails) throw new Error(`Renderer evaluation failed: ${JSON.stringify(evaluation.exceptionDetails)}`);
    const result = evaluation?.result?.value;
    if (!result?.health?.ok || !result.health.data?.databaseReady || !result.health.data?.ipcReady) throw new Error(`Health check failed: ${JSON.stringify(result?.health)}`);
    if (!result.created?.ok) throw new Error(`Source create failed: ${JSON.stringify(result.created)}`);
    if (!result.after?.ok || !result.after.data.some((source) => source.name === 'Smoke Source')) throw new Error(`Source list did not contain the created source: ${JSON.stringify(result.after)}`);

    console.log(`SMOKE_OK health=ok database=ready ipc=ready sourceCount=${result.after.data.length}`);
  } finally {
    socket.close();
  }
} catch (error) {
  console.error(`SMOKE_FAILED ${error instanceof Error ? error.message : String(error)}`);
  if (logFile) console.error(`SMOKE_LOG=${logFile}`);
  process.exitCode = 1;
} finally {
  if (child && child.exitCode === null) {
    await terminateProcessTree(child);
    await waitFor(() => child.exitCode !== null, 2_000, () => 'packaged app did not exit after smoke test cleanup').catch(() => child.kill('SIGKILL'));
  }
  const keepSmoke = process.env.SMOKE_KEEP === '1' || (process.exitCode !== undefined && process.exitCode !== 0);
  if (smokeRoot && !keepSmoke) fs.rmSync(smokeRoot, { recursive: true, force: true });
  else if (smokeRoot) console.log(`SMOKE_KEEP_ROOT=${smokeRoot}`);
}

function terminateProcessTree(processHandle) {
  if (process.platform !== 'win32' || !processHandle.pid) {
    processHandle.kill();
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    execFile('taskkill.exe', ['/PID', String(processHandle.pid), '/T', '/F'], { windowsHide: true }, () => resolve());
  });
}

async function findFreePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor(check, duration, errorMessage) {
  const deadline = Date.now() + duration;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const message = typeof errorMessage === 'function' ? errorMessage() : errorMessage;
  throw new Error(lastError ? `${message}: ${lastError.message}` : message);
}

function readText(filePath) {
  try { return fs.readFileSync(filePath, 'utf8'); } catch { return ''; }
}

function connectWebSocket(url) {
  const endpoint = new URL(url);
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(Number(endpoint.port), endpoint.hostname);
    let buffer = Buffer.alloc(0);
    let handshaken = false;
    const listeners = new Set();
    const key = crypto.randomBytes(16).toString('base64');

    const result = {
      send(message) {
        const payload = Buffer.from(message, 'utf8');
        const mask = crypto.randomBytes(4);
        const header = payload.length < 126
          ? Buffer.from([0x81, 0x80 | payload.length])
          : Buffer.from([0x81, 0x80 | 126, (payload.length >> 8) & 0xff, payload.length & 0xff]);
        const masked = Buffer.from(payload);
        for (let index = 0; index < masked.length; index += 1) masked[index] ^= mask[index % 4];
        socket.write(Buffer.concat([header, mask, masked]));
      },
      onMessage(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      close() {
        socket.end();
      },
    };

    socket.on('error', () => {
      if (!handshaken) reject(new Error('Could not connect to Chrome DevTools'));
    });
    socket.on('connect', () => {
      socket.write(`GET ${endpoint.pathname} HTTP/1.1\r\nHost: ${endpoint.hostname}:${endpoint.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!handshaken) {
        const end = buffer.indexOf(Buffer.from('\r\n\r\n'));
        if (end < 0) return;
        const response = buffer.subarray(0, end).toString('ascii');
        if (!response.startsWith('HTTP/1.1 101')) {
          reject(new Error(`Chrome DevTools handshake failed: ${response.split('\r\n')[0]}`));
          socket.destroy();
          return;
        }
        handshaken = true;
        buffer = buffer.subarray(end + 4);
        resolve(result);
      }
      while (handshaken) {
        if (buffer.length < 2) return;
        const first = buffer[0];
        const second = buffer[1];
        let length = second & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (buffer.length < 4) return;
          length = buffer.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          if (buffer.length < 10) return;
          const longLength = buffer.readBigUInt64BE(2);
          if (longLength > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Chrome DevTools frame too large');
          length = Number(longLength);
          offset = 10;
        }
        const masked = (second & 0x80) !== 0;
        const maskOffset = masked ? 4 : 0;
        if (buffer.length < offset + maskOffset + length) return;
        const mask = masked ? buffer.subarray(offset, offset + 4) : null;
        const payloadOffset = offset + maskOffset;
        const payload = Buffer.from(buffer.subarray(payloadOffset, payloadOffset + length));
        buffer = buffer.subarray(payloadOffset + length);
        if (mask) for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
        if ((first & 0x0f) === 0x1 || (first & 0x0f) === 0x2) for (const listener of listeners) listener(payload.toString('utf8'));
        if ((first & 0x0f) === 0x8) { socket.end(); return; }
      }
    });
  });
}

function cdpEvaluate(socket, expression, awaitPromise) {
  return new Promise((resolve, reject) => {
    const id = ++cdpMessageId;
    let removeListener = () => {};
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Chrome DevTools evaluation timed out'));
    }, 30_000);
    const cleanup = () => {
      clearTimeout(timer);
      removeListener();
    };
    const onMessage = (raw) => {
      try {
        const message = JSON.parse(raw);
        if (message.id !== id) return;
        cleanup();
        resolve(message.result);
      } catch (error) {
        cleanup();
        reject(error);
      }
    };
    removeListener = socket.onMessage(onMessage);
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise, returnByValue: true, userGesture: true } }));
  });
}
