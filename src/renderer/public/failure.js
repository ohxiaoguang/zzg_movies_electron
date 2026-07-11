const params = new URLSearchParams(window.location.search);
const reason = document.querySelector('#reason');
const status = document.querySelector('#status');
const openLogs = document.querySelector('#open-logs');
const reload = document.querySelector('#reload');

if (reason) reason.textContent = params.get('reason') || 'unknown';
reload?.addEventListener('click', () => window.location.reload());

const api = window.filmLibrary;
if (!api?.app?.openLogsFolder) {
  if (openLogs) openLogs.disabled = true;
} else {
  openLogs?.addEventListener('click', async () => {
    const result = await api.app.openLogsFolder();
    if (!result.ok && status) status.textContent = '无法打开日志目录，请手动查看应用数据目录。';
  });
}
