import fs from 'node:fs';
import path from 'node:path';

const port = Number(process.argv[2]);
const rootPath = process.argv[3];

if (!port || !rootPath) throw new Error('Usage: node scripts/smoke-dev-save.mjs <remote-debugging-port> <temporary-root>');

fs.mkdirSync(path.join(rootPath, 'extrafanart'), { recursive: true });
for (const filename of ['Dev Movie-cd1.mp4', 'Dev Movie-cd2.mp4', 'Dev Movie-cd3.mp4']) fs.writeFileSync(path.join(rootPath, filename), filename);
fs.writeFileSync(path.join(rootPath, 'Dev Movie.nfo'), '<movie><title>Dev Movie</title><tag>Dev Tag</tag></movie>');
fs.writeFileSync(path.join(rootPath, 'Dev Movie-poster.jpg'), 'poster');
fs.writeFileSync(path.join(rootPath, 'Dev Movie-fanart.jpg'), 'fanart');
fs.writeFileSync(path.join(rootPath, 'extrafanart', '1.jpg'), 'extra');

const pages = await waitForPages();
const page = pages.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
if (!page) throw new Error('DevTools page not found');

const socket = new WebSocket(page.webSocketDebuggerUrl);
let nextId = 0;
const rootLiteral = JSON.stringify(rootPath);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', () => reject(new Error('DevTools WebSocket error')), { once: true });
});

let apiReady = false;
for (let attempt = 0; attempt < 200; attempt += 1) {
  const probe = await evaluate('Boolean(window.filmLibrary?.app?.health)');
  if (probe.result?.value === true) { apiReady = true; break; }
  await new Promise((resolve) => setTimeout(resolve, 100));
}
if (!apiReady) throw new Error(`Dev preload API timeout page=${JSON.stringify(page)}`);

const result = await evaluate(`(async () => {
  const health = await window.filmLibrary.app.health();
  const before = await window.filmLibrary.sources.list();
  const created = await window.filmLibrary.sources.create({ name: 'Dev Smoke Source', rootPath: ${rootLiteral} });
  const started = created.ok ? await window.filmLibrary.scan.start({ sourceIds: [created.data.id] }) : { ok: false };
  let scanStatus = null;
  for (let index = 0; index < 300 && started.ok; index += 1) {
    scanStatus = await window.filmLibrary.scan.status();
    if (scanStatus.ok && scanStatus.data && scanStatus.data.status !== 'running') break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const after = await window.filmLibrary.sources.list();
  const page = await window.filmLibrary.films.page({ page: 1, pageSize: 20 });
  const detail = page.ok && page.data.items[0] ? await window.filmLibrary.films.detail(page.data.items[0].id) : { ok: false };
  const unorganizedBefore = await window.filmLibrary.films.page({ page: 1, pageSize: 20, organizationState: 'unorganized' });
  const classic = detail.ok ? await window.filmLibrary.categories.create({ name: '  Dev   Classic  ' }) : { ok: false };
  const mystery = detail.ok ? await window.filmLibrary.categories.create({ name: 'Dev Mystery' }) : { ok: false };
  const categorized = detail.ok && classic.ok && mystery.ok ? await window.filmLibrary.films.updateCategories(detail.data.id, [classic.data.id, mystery.data.id]) : { ok: false };
  const favorited = detail.ok ? await window.filmLibrary.films.updateFavorite(detail.data.id, true) : { ok: false };
  const patched = detail.ok ? await window.filmLibrary.films.updatePatch(detail.data.id, { title: 'Dev Auto Saved Title', originalTitle: 'Dev Original Title', rating: 9.5, notes: 'Dev auto-saved notes' }) : { ok: false };
  const patchedDetail = detail.ok ? await window.filmLibrary.films.detail(detail.data.id) : { ok: false };
  const organizedAfter = await window.filmLibrary.films.page({ page: 1, pageSize: 20, organizationState: 'organized' });
  for (let index = 0; index < 50 && !document.querySelector('.app-sidebar'); index += 1) await new Promise((resolve) => setTimeout(resolve, 100));
  const sidebarText = document.querySelector('.app-sidebar')?.textContent || '';
  location.hash = '#/categories';
  for (let index = 0; index < 50 && !document.querySelector('.category-card'); index += 1) await new Promise((resolve) => setTimeout(resolve, 100));
  const categoriesPageText = document.body.textContent || '';
  location.hash = '#/library?smoke=1';
  for (let index = 0; index < 50 && !document.querySelector('.film-card'); index += 1) await new Promise((resolve) => setTimeout(resolve, 100));
  document.querySelector('.film-card')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 500));
  const detailHeader = document.querySelector('.detail-sticky-header');
  const ui = { sidebarText, categoriesPageText, detailHeaderText: detailHeader?.textContent || '', drawerText: document.querySelector('.el-drawer')?.textContent || '', stickyHeader: Boolean(detailHeader) };
  const setting = await window.filmLibrary.settings.update({ cardSize: 270 });
  const removed = created.ok ? await window.filmLibrary.sources.remove({ id: created.data.id, mode: 'keep-records' }) : { ok: false };
  const allData = await window.filmLibrary.films.recordsPageAll({ page: 1, pageSize: 20 });
  const restored = created.ok ? await window.filmLibrary.sources.restore({ id: created.data.id }) : { ok: false };
  return { health, before, created, started, scanStatus, after, page, detail, unorganizedBefore, classic, mystery, categorized, favorited, patched, patchedDetail, organizedAfter, ui, setting, removed, allData, restored };
})()`);

if (result.exceptionDetails) throw new Error(`Dev renderer evaluation failed: ${JSON.stringify(result.exceptionDetails)}`);
const value = result.result?.value;
if (!value?.health?.ok || !value.health.data?.databaseReady || !value.health.data?.ipcReady) throw new Error(`Dev health failed: ${JSON.stringify(value?.health)}`);
if (!value.created?.ok) throw new Error(`Dev source create failed: ${JSON.stringify(value.created)}`);
if (!value.started?.ok || value.scanStatus?.data?.status !== 'completed') throw new Error(`Dev scan failed: ${JSON.stringify(value.scanStatus)}`);
if (!value.after?.ok || !value.after.data.some((source) => source.name === 'Dev Smoke Source')) throw new Error(`Dev source list failed: ${JSON.stringify(value.after)}`);
if (!value.page?.ok || value.page.data.total !== 1) throw new Error(`Dev multi-part page failed: ${JSON.stringify(value.page)}`);
if (!value.detail?.ok || value.detail.data.parts.length !== 3 || value.detail.data.images.length !== 3) throw new Error(`Dev detail failed: ${JSON.stringify(value.detail)}`);
if (!value.unorganizedBefore?.ok || value.unorganizedBefore.data.total !== 1 || !value.classic?.ok || value.classic.data.name !== 'Dev Classic' || !value.categorized?.ok || value.categorized.data.customCategories.length !== 2 || !value.organizedAfter?.ok || value.organizedAfter.data.total !== 1) throw new Error(`Dev category update failed: ${JSON.stringify({ classic: value.classic, categorized: value.categorized, organizedAfter: value.organizedAfter })}`);
if (!value.favorited?.ok || !value.patched?.ok || !value.patchedDetail?.ok || value.patchedDetail.data.title !== 'Dev Auto Saved Title' || value.patchedDetail.data.originalTitle !== 'Dev Original Title' || !value.patchedDetail.data.favorite || value.patchedDetail.data.rating !== 9.5 || value.patchedDetail.data.notes !== 'Dev auto-saved notes' || value.patchedDetail.data.nfoTags[0]?.name !== 'Dev Tag') throw new Error(`Dev patch update failed: ${JSON.stringify({ favorited: value.favorited, patched: value.patched, patchedDetail: value.patchedDetail })}`);
if (!value.ui?.sidebarText.includes('未整理') || !value.ui.sidebarText.includes('已整理') || !value.ui.sidebarText.includes('我的分类') || value.ui.sidebarText.includes('想看') || value.ui.sidebarText.includes('正在观看') || value.ui.sidebarText.includes('标签管理') || !value.ui.categoriesPageText.includes('Dev Classic') || !value.ui.stickyHeader || !value.ui.detailHeaderText.includes('收藏') || !value.ui.detailHeaderText.includes('我的分类') || !value.ui.drawerText.includes('NFO 标签') || value.ui.drawerText.includes('类型')) throw new Error(`Dev UI verification failed: ${JSON.stringify(value.ui)}`);
if (!value.setting?.ok || value.setting.data.cardSize !== 270) throw new Error(`Dev setting failed: ${JSON.stringify(value.setting)}`);
if (!value.removed?.ok || value.allData?.data.items[0]?.availability !== 'source_removed') throw new Error(`Dev source removal failed: ${JSON.stringify({ removed: value.removed, allData: value.allData })}`);
if (!value.restored?.ok) throw new Error(`Dev source restore failed: ${JSON.stringify(value.restored)}`);

if (fs.readFileSync(path.join(rootPath, 'Dev Movie.nfo'), 'utf8') !== '<movie><title>Dev Movie</title><tag>Dev Tag</tag></movie>') throw new Error('Dev smoke unexpectedly modified NFO');
console.log(`DEV_SMOKE_OK health=ok database=ready ipc=ready sourceCount=${value.after.data.length} parts=${value.detail.data.parts.length} categories=${value.patchedDetail.data.customCategories.length}`);
await evaluate('window.close()').catch(() => undefined);
socket.close();

async function waitForPages() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (response.ok) {
        const pages = await response.json();
        if (pages.some((item) => item.type === 'page' && item.webSocketDebuggerUrl)) return pages;
      }
    } catch {
      // The Vite/Electron dev startup is still in progress.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('DevTools page timeout');
}

function evaluate(expression) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeEventListener('message', onMessage);
      socket.removeEventListener('error', onError);
    };
    const onError = () => {
      cleanup();
      reject(new Error('DevTools WebSocket error'));
    };
    const onMessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== id) return;
      cleanup();
      resolve(message.result);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('DevTools evaluate timeout'));
    }, 20_000);
    socket.addEventListener('message', onMessage);
    socket.addEventListener('error', onError, { once: true });
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  });
}
