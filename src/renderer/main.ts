import { createApp } from 'vue';
import { createPinia } from 'pinia';
import ElementPlus from 'element-plus';
import 'element-plus/dist/index.css';
import { router } from './router';
import App from './App.vue';
import './styles/theme.css';

const app = createApp(App);
let rendererMounted = false;

window.addEventListener('error', (event) => {
  console.error('[renderer] uncaught error', event.error ?? event.message);
  if (!rendererMounted) renderStartupFailure('RENDERER_ERROR');
});

window.addEventListener('unhandledrejection', (event) => {
  console.error('[renderer] unhandled rejection', event.reason);
  if (!rendererMounted) renderStartupFailure('UNHANDLED_REJECTION');
});

app.config.errorHandler = (error, _instance, info) => {
  console.error('[renderer] Vue error boundary', { error, info });
  if (!rendererMounted) renderStartupFailure('VUE_ERROR');
};

void bootstrap();

async function bootstrap(): Promise<void> {
  try {
    const api = window.filmLibrary;
    if (!api?.app?.health) throw new Error('PRELOAD_API_MISSING');
    const result = await api.app.health();
    if (!result.ok) throw new Error(result.error.code);
    if (!result.data.ok || !result.data.databaseReady || !result.data.ipcReady) throw new Error('APP_HEALTH_FAILED');

    app.use(createPinia()).use(router).use(ElementPlus).mount('#app');
    rendererMounted = true;
    console.info('[renderer] bootstrap complete');
  } catch (error) {
    console.error('[renderer] bootstrap failed', error);
    renderStartupFailure(error instanceof Error ? error.message : 'BOOTSTRAP_FAILED');
  }
}

function renderStartupFailure(reason: string): void {
  const root = document.querySelector<HTMLElement>('#app');
  if (!root || root.dataset.startupFailure === 'true') return;
  root.dataset.startupFailure = 'true';
  root.replaceChildren();

  const panel = document.createElement('main');
  panel.className = 'startup-error';
  const title = document.createElement('h1');
  title.textContent = '应用界面启动失败';
  const description = document.createElement('p');
  description.textContent = '请打开应用日志目录查看诊断信息，然后重新启动应用。';
  const diagnostic = document.createElement('p');
  diagnostic.textContent = `诊断编号：${reason.slice(0, 120)}`;
  const actions = document.createElement('div');
  actions.className = 'startup-error-actions';
  const openLogs = document.createElement('button');
  openLogs.type = 'button';
  openLogs.textContent = '打开日志目录';
  const reload = document.createElement('button');
  reload.type = 'button';
  reload.className = 'secondary';
  reload.textContent = '重新加载';
  reload.addEventListener('click', () => window.location.reload());
  openLogs.addEventListener('click', async () => {
    const result = await window.filmLibrary?.app.openLogsFolder();
    if (!result?.ok) openLogs.textContent = '无法打开，请查看数据目录';
  });
  if (!window.filmLibrary?.app?.openLogsFolder) openLogs.disabled = true;

  actions.append(openLogs, reload);
  panel.append(title, description, diagnostic, actions);
  root.append(panel);
}
