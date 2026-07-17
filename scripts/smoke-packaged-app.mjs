import { execFile, spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executable = path.resolve(process.argv[2] ?? path.join(projectRoot, 'out/local-film-library-win32-x64/local-film-library.exe'));
const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS ?? 60_000);
const expectedAppVersion = process.env.EXPECTED_APP_VERSION?.trim();
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
  fs.mkdirSync(path.join(mediaRoot, 'extrafanart'), { recursive: true });
  const ffmpegAvailable = spawnSync('ffmpeg', ['-version'], { windowsHide: true, stdio: 'ignore' }).status === 0;
  if (ffmpegAvailable) {
    for (const [index, color] of ['red', 'green', 'blue'].entries()) {
      const output = path.join(mediaRoot, `Smoke Movie-cd${index + 1}.mkv`);
      const generated = spawnSync('ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', `color=c=${color}:s=320x180:r=24`,
        '-f', 'lavfi', '-i', `sine=frequency=${440 + index * 110}:sample_rate=44100`,
        '-t', '1', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
        '-f', 'mpegts', output,
      ], { windowsHide: true, stdio: 'pipe' });
      if (generated.status !== 0) throw new Error(`Could not generate MKV compatibility fixture: ${String(generated.stderr)}`);
    }
  } else {
    for (const filename of ['Smoke Movie-cd1.mp4', 'Smoke Movie-cd2.mp4', 'Smoke Movie-cd3.mp4']) fs.writeFileSync(path.join(mediaRoot, filename), filename);
  }
  fs.writeFileSync(path.join(mediaRoot, 'Smoke Movie.nfo'), '<movie><title>Smoke Movie</title><tag>Smoke Tag</tag><actor>Smoke Actor</actor><plot>Smoke summary</plot></movie>');
  fs.writeFileSync(path.join(mediaRoot, 'Smoke Movie-poster.jpg'), 'poster');
  fs.writeFileSync(path.join(mediaRoot, 'Smoke Movie-fanart.jpg'), 'fanart');
  fs.writeFileSync(path.join(mediaRoot, 'extrafanart', '1.jpg'), 'extra');

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
    const expectedMkvCompatibility = ffmpegAvailable;
    const evaluation = await cdpEvaluate(socket, `(async () => {
      const health = await window.filmLibrary.app.health();
      const info = await window.filmLibrary.app.info();
      const before = await window.filmLibrary.sources.list();
      const created = await window.filmLibrary.sources.create({ name: 'Smoke Source', rootPath: ${sourcePath} });
      const previewEnabled = created.ok ? await window.filmLibrary.sources.update({ id: created.data.id, allowOriginalPreview: true }) : { ok: false };
      const started = previewEnabled.ok ? await window.filmLibrary.scan.start({ sourceIds: [created.data.id] }) : { ok: false };
      let scanStatus = null;
      for (let index = 0; index < 300 && started.ok; index += 1) {
        scanStatus = await window.filmLibrary.scan.status();
        if (scanStatus.ok && scanStatus.data && scanStatus.data.status !== 'running') break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const page = await window.filmLibrary.films.page({ page: 1, pageSize: 20 });
      const detail = page.ok && page.data.items[0] ? await window.filmLibrary.films.detail(page.data.items[0].id) : { ok: false };
      const previewProbe = detail.ok ? await (async () => {
        const response = await fetch('film-media://preview/' + detail.data.id, { headers: { Range: 'bytes=0-9' } });
        const buffer = await response.arrayBuffer();
        const body = new TextDecoder('latin1').decode(buffer);
        return {
          status: response.status,
          contentType: response.headers.get('content-type'),
          byteLength: buffer.byteLength,
          hasFtyp: body.includes('ftyp'),
          hasMoof: body.includes('moof'),
          directBody: body,
        };
      })() : null;
      const directoryRescan = detail.ok ? await window.filmLibrary.films.rescan(detail.data.id) : { ok: false };
      let directoryRescanStatus = null;
      for (let index = 0; index < 300 && directoryRescan.ok; index += 1) {
        directoryRescanStatus = await window.filmLibrary.scan.status();
        if (directoryRescanStatus.ok && directoryRescanStatus.data && directoryRescanStatus.data.status !== 'running') break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const actorList = await window.filmLibrary.actors.list();
      const actorFiltered = await window.filmLibrary.films.page({ page: 1, pageSize: 20, actor: 'Smoke Actor' });
      const parts = detail.ok ? await window.filmLibrary.films.partsList(detail.data.id) : { ok: false };
      const unorganizedBefore = await window.filmLibrary.films.page({ page: 1, pageSize: 20, organizationState: 'unorganized' });
      const classic = detail.ok ? await window.filmLibrary.categories.create({ name: '  Smoke   Classic  ' }) : { ok: false };
      const mystery = detail.ok ? await window.filmLibrary.categories.create({ name: 'Smoke Mystery' }) : { ok: false };
      const categorized = detail.ok && classic.ok && mystery.ok ? await window.filmLibrary.films.updateCategories(detail.data.id, [classic.data.id, mystery.data.id]) : { ok: false };
      const favorited = detail.ok ? await window.filmLibrary.films.updateFavorite(detail.data.id, true) : { ok: false };
      const patched = detail.ok ? await window.filmLibrary.films.updatePatch(detail.data.id, { title: 'Smoke Auto Saved Title', originalTitle: 'Smoke Original Title', rating: 9.5, notes: 'Smoke auto-saved notes' }) : { ok: false };
      const patchedDetail = detail.ok ? await window.filmLibrary.films.detail(detail.data.id) : { ok: false };
      const organizedAfter = await window.filmLibrary.films.page({ page: 1, pageSize: 20, organizationState: 'organized' });
      for (let index = 0; index < 50 && !document.querySelector('.app-sidebar'); index += 1) await new Promise((resolve) => setTimeout(resolve, 100));
      const sidebarText = document.querySelector('.app-sidebar')?.textContent || '';
      location.hash = '#/sources';
      for (let index = 0; index < 50 && !document.querySelector('.source-card'); index += 1) await new Promise((resolve) => setTimeout(resolve, 100));
      const sourcesPageText = document.body.textContent || '';
      location.hash = '#/actors';
      for (let index = 0; index < 50 && !document.querySelector('.actor-card'); index += 1) await new Promise((resolve) => setTimeout(resolve, 100));
      const actorsPageText = document.body.textContent || '';
      document.querySelector('.actor-card')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 300));
      const selectedActor = new URLSearchParams(location.hash.split('?')[1] || '').get('actor');
      location.hash = '#/categories';
      for (let index = 0; index < 50 && !document.querySelector('.category-card'); index += 1) await new Promise((resolve) => setTimeout(resolve, 100));
      const categoriesPageText = document.body.textContent || '';
      location.hash = '#/library?organization=organized';
      await new Promise((resolve) => setTimeout(resolve, 300));
      const organizedActionsText = document.querySelector('.heading-actions')?.textContent || '';
      location.hash = '#/library?smoke=1';
      for (let index = 0; index < 50 && !document.querySelector('.film-card'); index += 1) await new Promise((resolve) => setTimeout(resolve, 100));
      document.querySelector('.film-card')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 500));
      const detailHeader = document.querySelector('.detail-sticky-header');
      const detailHeaderText = detailHeader?.textContent || '';
      const drawerText = document.querySelector('.el-drawer')?.textContent || '';
      const detailActorText = document.querySelector('.actor-links')?.textContent || '';
      document.querySelector('.actor-links button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 300));
      const detailSelectedActor = new URLSearchParams(location.hash.split('?')[1] || '').get('actor');
      const ui = { sidebarText, sourcesPageText, actorsPageText, selectedActor, categoriesPageText, organizedActionsText, detailHeaderText, drawerText, detailActorText, detailSelectedActor, stickyHeader: Boolean(detailHeader) };
      const setting = await window.filmLibrary.settings.update({ cardSize: 280 });
      const removed = created.ok ? await window.filmLibrary.sources.remove({ id: created.data.id, mode: 'keep-records' }) : { ok: false };
      const allData = await window.filmLibrary.films.recordsPageAll({ page: 1, pageSize: 20 });
      const restored = created.ok ? await window.filmLibrary.sources.restore({ id: created.data.id }) : { ok: false };
      const after = await window.filmLibrary.sources.list();
      return { health, info, before, created, previewEnabled, started, scanStatus, page, detail, previewProbe, directoryRescan, directoryRescanStatus, actorList, actorFiltered, parts, unorganizedBefore, classic, mystery, categorized, favorited, patched, patchedDetail, organizedAfter, ui, setting, removed, allData, restored, after };
    })()`, true);

    if (evaluation?.exceptionDetails) throw new Error(`Renderer evaluation failed: ${JSON.stringify(evaluation.exceptionDetails)}`);
    const result = evaluation?.result?.value;
    if (!result?.health?.ok || !result.health.data?.databaseReady || !result.health.data?.ipcReady) throw new Error(`Health check failed: ${JSON.stringify(result?.health)}`);
    if (!result.info?.ok || (expectedAppVersion && result.info.data.version !== expectedAppVersion)) throw new Error(`Application version failed: expected=${expectedAppVersion || '(any)'} actual=${JSON.stringify(result.info)}`);
    if (!result.created?.ok) throw new Error(`Source create failed: ${JSON.stringify(result.created)}`);
    if (!result.previewEnabled?.ok || !result.previewEnabled.data.allowOriginalPreview) throw new Error(`Original preview source update failed: ${JSON.stringify(result.previewEnabled)}`);
    if (!result.started?.ok || result.scanStatus?.data?.status !== 'completed') throw new Error(`Scan failed: ${JSON.stringify(result.scanStatus)}`);
    if (!result.page?.ok || result.page.data.total !== 1) throw new Error(`Multi-part page failed: ${JSON.stringify(result.page)}`);
    if (!result.detail?.ok || result.detail.data.parts.length !== 3 || result.detail.data.images.length !== 3 || !result.detail.data.allowOriginalPreview) throw new Error(`Multi-part detail failed: ${JSON.stringify(result.detail)}`);
    if (expectedMkvCompatibility) {
      if (result.previewProbe?.status !== 200 || result.previewProbe.contentType !== 'video/mp4' || !result.previewProbe.hasFtyp || !result.previewProbe.hasMoof || result.previewProbe.byteLength < 1000) throw new Error(`MKV compatibility preview failed: ${JSON.stringify(result.previewProbe)}`);
    } else if (result.previewProbe?.status !== 206 || result.previewProbe.directBody !== 'Smoke Movi') {
      throw new Error(`Original preview protocol failed: ${JSON.stringify(result.previewProbe)}`);
    }
    if (!result.directoryRescan?.ok || result.directoryRescanStatus?.data?.status !== 'completed') throw new Error(`Directory rescan failed: ${JSON.stringify({ directoryRescan: result.directoryRescan, status: result.directoryRescanStatus })}`);
    if (!result.actorList?.ok || result.actorList.data[0]?.name !== 'Smoke Actor' || result.actorList.data[0]?.filmCount !== 1 || !result.actorFiltered?.ok || result.actorFiltered.data.total !== 1) throw new Error(`Actor index failed: ${JSON.stringify({ actorList: result.actorList, actorFiltered: result.actorFiltered })}`);
    if (!result.parts?.ok || result.parts.data.length !== 3) throw new Error(`Part API failed: ${JSON.stringify(result.parts)}`);
    if (!result.unorganizedBefore?.ok || result.unorganizedBefore.data.total !== 1 || !result.classic?.ok || result.classic.data.name !== 'Smoke Classic' || !result.categorized?.ok || result.categorized.data.customCategories.length !== 2 || !result.organizedAfter?.ok || result.organizedAfter.data.total !== 1) throw new Error(`Category update failed: ${JSON.stringify({ classic: result.classic, categorized: result.categorized, organizedAfter: result.organizedAfter })}`);
    if (!result.favorited?.ok || !result.patched?.ok || !result.patchedDetail?.ok || result.patchedDetail.data.title !== 'Smoke Auto Saved Title' || result.patchedDetail.data.originalTitle !== 'Smoke Original Title' || !result.patchedDetail.data.favorite || result.patchedDetail.data.rating !== 9.5 || result.patchedDetail.data.notes !== 'Smoke auto-saved notes' || result.patchedDetail.data.nfoTags[0]?.name !== 'Smoke Tag') throw new Error(`Patch update failed: ${JSON.stringify({ favorited: result.favorited, patched: result.patched, patchedDetail: result.patchedDetail })}`);
    if (!result.ui?.sidebarText.includes('未整理') || !result.ui.sidebarText.includes('已整理') || !result.ui.sidebarText.includes('我的分类') || !result.ui.sidebarText.includes('演员') || result.ui.sidebarText.includes('想看') || result.ui.sidebarText.includes('正在观看') || result.ui.sidebarText.includes('标签管理') || !result.ui.sourcesPageText.includes('重新扫描') || !result.ui.actorsPageText.includes('Smoke Actor') || result.ui.selectedActor !== 'Smoke Actor' || !result.ui.categoriesPageText.includes('Smoke Classic') || !result.ui.organizedActionsText.includes('导出 CSV') || !result.ui.stickyHeader || !result.ui.detailHeaderText.includes('收藏') || !result.ui.detailHeaderText.includes('我的分类') || !result.ui.detailHeaderText.includes('重新扫描目录') || !result.ui.drawerText.includes('NFO 标签') || result.ui.drawerText.includes('类型') || !result.ui.detailActorText.includes('Smoke Actor') || !result.ui.detailActorText.includes('1 部') || result.ui.detailSelectedActor !== 'Smoke Actor') throw new Error(`UI verification failed: ${JSON.stringify(result.ui)}`);
    if (!result.setting?.ok || result.setting.data.cardSize !== 280) throw new Error(`Settings update failed: ${JSON.stringify(result.setting)}`);
    if (!result.removed?.ok || !result.allData?.ok || result.allData.data.items[0]?.availability !== 'source_removed') throw new Error(`Source removal failed: ${JSON.stringify({ removed: result.removed, allData: result.allData })}`);
    if (!result.restored?.ok) throw new Error(`Source restore failed: ${JSON.stringify(result.restored)}`);
    if (!result.after?.ok || !result.after.data.some((source) => source.name === 'Smoke Source')) throw new Error(`Source list did not contain the created source: ${JSON.stringify(result.after)}`);

    if (fs.readFileSync(path.join(mediaRoot, 'Smoke Movie.nfo'), 'utf8') !== '<movie><title>Smoke Movie</title><tag>Smoke Tag</tag><actor>Smoke Actor</actor><plot>Smoke summary</plot></movie>') throw new Error('Packaged smoke unexpectedly modified NFO');
    console.log(`SMOKE_OK health=ok database=ready ipc=ready sourceCount=${result.after.data.length} categories=${result.patchedDetail.data.customCategories.length}`);
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
