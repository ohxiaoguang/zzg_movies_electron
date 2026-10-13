/* global document, window */
import fs from 'node:fs';
import path from 'node:path';

export async function verifyScanReport(evaluate, mediaRoot) {
  const root = path.join(mediaRoot, 'scan-report-fixture');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'Bad.mp4'), 'fake video');
  fs.writeFileSync(path.join(root, 'Good.mp4'), 'fake video');
  fs.writeFileSync(path.join(root, 'Bad.nfo'), '<movie><title>broken');
  fs.writeFileSync(path.join(root, 'poster.jpg'), 'generic cover');
  const response = await evaluate(`(${scanReportFlow.toString()})(${JSON.stringify(root)})`, true);
  if (response?.exceptionDetails) throw new Error(`Scan report UI failed: ${JSON.stringify(response.exceptionDetails)}`);
  if (!response?.result?.value?.ok) throw new Error(`Scan report result invalid: ${JSON.stringify(response)}`);
  console.log('SCAN_REPORT_OK worker=ok health=responsive nfo=1 ambiguity=2 popup=ok search=ok');
}

async function scanReportFlow(root) {
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const delay = () => new Promise((resolve) => setTimeout(resolve, 50));
  const source = await window.filmLibrary.sources.create({ name: 'Scan Report Smoke', rootPath: root });
  assert(source.ok, 'Could not create scan report source');
  const start = await window.filmLibrary.scan.start({ sourceIds: [source.data.id] });
  assert(start.ok, 'Could not start background scan');
  let status;
  for (let i = 0; i < 100; i++) {
    const health = await window.filmLibrary.app.health(); assert(health.ok, 'Main process health failed during scan');
    const current = await window.filmLibrary.scan.status(); assert(current.ok, 'Could not read scan status');
    status = current.data;
    if (status?.status !== 'running') break;
    await delay();
  }
  assert(status?.status === 'completed', `Scan did not finish: ${JSON.stringify(status)}`);
  assert(status.nfoErrors === 1 && status.ambiguousAssets === 2, 'Scan counts were incorrect');
  const report = await window.filmLibrary.scan.issues({ jobId: start.data.jobId, page: 1, pageSize: 20 });
  assert(report.ok && report.data.total === 3, 'Could not read exact scan issue details');
  await delay();
  const nfoButton = [...document.querySelectorAll('.scan-metrics button')].find((button) => button.textContent.includes('NFO'));
  assert(nfoButton && !nfoButton.disabled, 'NFO issue metric is not clickable');
  nfoButton.click();
  let dialog;
  for (let i = 0; i < 80; i++) {
    dialog = [...document.querySelectorAll('.el-dialog')].find((element) => element.querySelector('.issue-filters'));
    if (dialog?.textContent.includes('Bad.nfo')) break;
    await delay();
  }
  assert(dialog?.textContent.includes('Bad.nfo') && dialog.textContent.includes('解析失败'), 'NFO popup does not show the file and reason');
  const search = dialog.querySelector('.issue-filters input[placeholder="搜索影片、来源或文件路径"]');
  assert(search, 'Issue search input missing');
  search.value = 'does-not-exist'; search.dispatchEvent(new Event('input', { bubbles: true }));
  await delay();
  [...dialog.querySelectorAll('.issue-filters button')].find((button) => button.textContent.trim() === '查询').click();
  for (let i = 0; i < 80 && !dialog.textContent.includes('没有此类扫描问题'); i++) await delay();
  assert(dialog.textContent.includes('没有此类扫描问题'), 'Issue popup search did not update');
  [...dialog.querySelectorAll('.el-dialog__footer button')].find((button) => button.textContent.trim() === '关闭').click();
  return { ok: true };
}
