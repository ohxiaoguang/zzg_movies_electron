const port = Number(process.argv[2]);
const rootPath = process.argv[3];

if (!port || !rootPath) throw new Error('Usage: node scripts/smoke-dev-save.mjs <remote-debugging-port> <temporary-root>');

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

const result = await evaluate(`(async () => {
  const health = await window.filmLibrary.app.health();
  const before = await window.filmLibrary.sources.list();
  const created = await window.filmLibrary.sources.create({ name: 'Dev Smoke Source', rootPath: ${rootLiteral} });
  const after = await window.filmLibrary.sources.list();
  return { health, before, created, after };
})()`);

if (result.exceptionDetails) throw new Error(`Dev renderer evaluation failed: ${JSON.stringify(result.exceptionDetails)}`);
const value = result.result?.value;
if (!value?.health?.ok || !value.health.data?.databaseReady || !value.health.data?.ipcReady) throw new Error(`Dev health failed: ${JSON.stringify(value?.health)}`);
if (!value.created?.ok) throw new Error(`Dev source create failed: ${JSON.stringify(value.created)}`);
if (!value.after?.ok || !value.after.data.some((source) => source.name === 'Dev Smoke Source')) throw new Error(`Dev source list failed: ${JSON.stringify(value.after)}`);

console.log(`DEV_SMOKE_OK health=ok database=ready ipc=ready sourceCount=${value.after.data.length}`);
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
    const timer = setTimeout(() => reject(new Error('DevTools evaluate timeout')), 20_000);
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== id) return;
      clearTimeout(timer);
      resolve(message.result);
    });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('DevTools WebSocket error'));
    }, { once: true });
  });
}
