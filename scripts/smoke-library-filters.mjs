/* global document, window, location */
export async function verifyDesktopLibraryFilters(evaluate) {
  const result = await evaluate(`(${desktopFlow.toString()})()`, true);
  if (result?.exceptionDetails) throw new Error('Desktop filters: ' + JSON.stringify(result.exceptionDetails));
  const expected = result?.result?.value;
  if (!expected?.sourceIds?.length) throw new Error('Desktop filter test returned no selection');
  await evaluate('location.reload(); true', false);
  await new Promise((resolve) => setTimeout(resolve, 500));
  const restore = await evaluate(`(async () => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const selected = document.querySelectorAll('.source-filter-button[data-source-id][aria-pressed="true"]');
      if (selected.length === 2 && document.querySelector('.global-filters .category-filter')?.textContent.includes('Smoke Classic')) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('Desktop global filters were not restored after reload');
  })()`, true);
  if (restore?.exceptionDetails || restore?.result?.value !== true) throw new Error('Desktop filter restore: ' + JSON.stringify(restore));
  console.log('DESKTOP_FILTERS_OK sources=multiple category=all navigation=retained reload=retained');
}

async function desktopFlow() {
  const delay = (ms = 100) => new Promise((resolve) => setTimeout(resolve, ms));
  const assert = (value, message) => { if (!value) throw new Error(message); };
  async function waitFor(check) {
    for (let index = 0; index < 80; index += 1) { const value = check(); if (value) return value; await delay(); }
    throw new Error('Desktop filter UI did not become ready');
  }
  for (const close of document.querySelectorAll('.el-drawer__close-btn')) close.click();
  const sources = await window.filmLibrary.sources.list();
  assert(sources.ok, 'Cannot load sources');
  const original = sources.data.find((source) => source.name === 'Smoke Source');
  assert(original, 'Missing smoke source');
  const second = await window.filmLibrary.sources.create({ name: 'Smoke Source B', rootPath: original.rootPath + '/extrafanart' });
  assert(second.ok, 'Cannot create second source');
  location.hash = '#/settings';
  await delay(300);
  location.hash = '#/library';
  await waitFor(() => document.querySelectorAll('.source-filter-button[data-source-id]').length === 2);
  document.querySelector('.global-filter-heading .el-button')?.click();
  await delay();
  const sourceButtons = [...document.querySelectorAll('.source-filter-button[data-source-id]')];
  for (const button of sourceButtons) { button.click(); await delay(); }
  const categories = await window.filmLibrary.categories.list();
  assert(categories.ok && categories.data.length >= 2, 'Missing smoke categories');
  const picker = document.querySelector('.global-filters .category-filter .el-select__wrapper');
  picker.click();
  for (const category of categories.data.slice(0, 2)) {
    const option = await waitFor(() => [...document.querySelectorAll('.el-select-dropdown__item')].find((item) => item.getClientRects().length && item.textContent.trim() === category.name));
    option.click();
    await delay();
  }
  document.querySelector('.page-title').click();
  const read = () => JSON.parse(localStorage.getItem('local-film-library:global-filters-v1'));
  const saved = read();
  assert(saved.sourceIds.length === 2 && saved.categoryIds.length === 2, 'Multiple selections not persisted');
  const search = document.querySelector('.library-toolbar input');
  search.value = 'page-local-only';
  search.dispatchEvent(new Event('input', { bubbles: true }));
  for (const [route, title] of [['#/library?favorite=1', '收藏'], ['#/library?organization=unorganized', '未整理'], ['#/library?organization=organized', '已整理'], ['#/library?all=1', '所有数据'], ['#/settings', '设置'], ['#/library', '全部影片']]) {
    location.hash = route;
    await waitFor(() => document.querySelector('.page-title')?.textContent === title);
    await delay();
    assert(JSON.stringify(read()) === JSON.stringify(saved), 'Navigation reset global filters');
    if (title !== '设置') {
      assert(document.querySelectorAll('.source-filter-button[data-source-id][aria-pressed="true"]').length === 2, 'Source buttons lost selection');
      assert(document.querySelector('.library-toolbar input').value === '', 'Page search was not reset');
    }
  }
  const global = document.querySelector('.global-filters').getBoundingClientRect();
  const toolbar = document.querySelector('.library-toolbar').getBoundingClientRect();
  assert(global.bottom <= toolbar.top, 'Global controls are not above the local toolbar');
  assert(!document.querySelector('.library-toolbar').textContent.includes('小卡片'), 'Card-size control remains in toolbar');
  assert(!document.querySelector('.library-toolbar').textContent.includes('仅收藏'), 'Favorite toggle remains in toolbar');
  return saved;
}

export async function verifyWebLibraryFilters(evaluate) {
  const result = await evaluate(`(${webFlow.toString()})()`, true);
  if (result?.exceptionDetails || result?.result?.value !== true) throw new Error('Web filters: ' + JSON.stringify(result));
  await evaluate('location.reload(); true', false);
  await new Promise((resolve) => setTimeout(resolve, 500));
  const restored = await evaluate(`(async () => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (document.querySelectorAll('#source-buttons button[data-source-id][aria-pressed="true"]').length === 2 &&
          document.querySelectorAll('#category-options input:checked').length === 2 &&
          document.documentElement.style.getPropertyValue('--card-width') === '240px') return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('Web preferences did not survive reload');
  })()`, true);
  if (restored?.exceptionDetails || restored?.result?.value !== true) throw new Error('Web filter restore: ' + JSON.stringify(restored));
  console.log('WEB_FILTERS_OK sources=multiple queries=filtered categories=multiple navigation=retained reload=retained card-size=settings');
}

async function webFlow() {
  const delay = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));
  const assert = (value, message) => { if (!value) throw new Error(message); };
  async function waitFor(check) {
    for (let index = 0; index < 100; index += 1) { if (check()) return; await delay(); }
    throw new Error('Web filter UI did not become ready: ' + (document.querySelector('#error')?.textContent || ''));
  }
  await waitFor(() => document.querySelectorAll('#source-buttons button').length >= 3 && document.querySelector('#film-grid')?.getAttribute('aria-busy') === 'false');
  const names = ['Smoke Source', 'Smoke Source B'];
  const button = (name) => [...document.querySelectorAll('#source-buttons button')].find((item) => item.textContent === name);
  const settled = () => waitFor(() => document.querySelector('#film-grid').getAttribute('aria-busy') === 'false');
  button(names[0]).click(); await settled();
  button(names[1]).click(); await settled();
  assert(document.querySelectorAll('#source-buttons button[aria-pressed="true"]').length === 2, 'Web source buttons are not multi-select');
  button(names[0]).click(); await settled();
  assert(document.querySelector('#result-summary').textContent === '0 部影片', 'Source query was ignored');
  button(names[0]).click(); await settled();
  assert(document.querySelector('#result-summary').textContent === '1 部影片', 'Source union did not include the original source');
  document.querySelector('#category-summary').click();
  const ids = [...document.querySelectorAll('#category-options input')].slice(0, 2).map((input) => input.dataset.categoryId);
  assert(ids.length === 2, 'Missing web categories');
  for (const id of ids) {
    [...document.querySelectorAll('#category-options input')].find((input) => input.dataset.categoryId === id).click();
    await settled();
  }
  document.querySelector('#category-summary').click();
  const read = () => JSON.parse(localStorage.getItem('local-film-library:global-filters-v1'));
  const saved = JSON.stringify(read());
  const search = document.querySelector('#search');
  search.value = 'page-local-only';
  search.dispatchEvent(new Event('input', { bubbles: true }));
  for (const mode of ['favorite', 'unorganized', 'organized', 'all-data', 'all']) {
    document.querySelector('.nav-item[data-library-mode="' + mode + '"]').click();
    await settled();
    assert(JSON.stringify(read()) === saved, 'Web navigation reset global filters');
    assert(search.value === '', 'Web navigation did not reset local search');
  }
  document.querySelector('#refresh').click();
  await delay(200); await settled();
  assert(document.querySelectorAll('#category-options input:checked').length === 2, 'Refresh reset web categories');
  document.querySelector('.nav-item[data-view="settings"]').click();
  const size = document.querySelector('#card-size');
  assert(size && document.querySelector('#settings-view').contains(size), 'Card size missing from web settings');
  size.value = '240';
  size.dispatchEvent(new Event('input', { bubbles: true }));
  document.querySelector('.nav-item[data-library-mode="all"]').click();
  await settled();
  assert(document.querySelector('#result-summary').textContent === '1 部影片', 'Web category/source query failed');
  assert(document.documentElement.style.getPropertyValue('--card-width') === '240px', 'Web card size not applied');
  assert(document.querySelector('.global-filters').getBoundingClientRect().bottom <= document.querySelector('.filters').getBoundingClientRect().top, 'Web global controls are not above local filters');
  return true;
}
