class HttpFilmLibraryClient {
  async request(path, query, options = {}) {
    const url = this.url(path, query);
    const method = options.method || 'GET';
    const response = await fetch(url, {
      method,
      headers: {
        Accept: 'application/json',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(method !== 'GET' && method !== 'HEAD' ? { 'X-Film-Library-Request': '1' } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const result = await response.json();
    if (!response.ok || !result.ok) {
      const error = new Error(result.error?.message || `HTTP ${response.status}`);
      error.code = result.error?.code || `HTTP_${response.status}`;
      error.status = response.status;
      throw error;
    }
    return result.data;
  }

  url(path, query) {
    const url = new URL(path, window.location.origin);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null || value === '') continue;
        if (Array.isArray(value)) value.forEach((item) => url.searchParams.append(key, String(item)));
        else url.searchParams.set(key, String(value));
      }
    }
    return url;
  }

  serverInfo() { return this.request('/api/v1/server-info'); }
  me() { return this.request('/api/v1/auth/me'); }
  films(query) { return this.request('/api/v1/films', query); }
  film(id) { return this.request(`/api/v1/films/${encodeURIComponent(id)}`); }
  filters() { return this.request('/api/v1/filters/counts'); }
  login(username, password) { return this.request('/api/v1/auth/login', null, { method: 'POST', body: { username, password } }); }
  logout() { return this.request('/api/v1/auth/logout', null, { method: 'POST' }); }
  updateFavorite(id, favorite) { return this.request(`/api/v1/films/${encodeURIComponent(id)}/favorite`, null, { method: 'PATCH', body: { favorite } }); }
  updateMetadata(id, body) { return this.request(`/api/v1/films/${encodeURIComponent(id)}/metadata`, null, { method: 'PATCH', body }); }
  updateTaxonomy(id, body) { return this.request(`/api/v1/films/${encodeURIComponent(id)}/taxonomy`, null, { method: 'PATCH', body }); }
  rescanSource(id) { return this.request(`/api/v1/sources/${encodeURIComponent(id)}/rescan`, null, { method: 'POST' }); }
  playbackCapabilities() { return this.request('/api/v1/playback/capabilities'); }
  createPlaybackSession(body) { return this.request('/api/v1/playback/sessions', null, { method: 'POST', body }); }
  playbackSession(id) { return this.request(`/api/v1/playback/sessions/${encodeURIComponent(id)}`); }
  updatePlaybackProgress(id, body) {
    return this.request(`/api/v1/playback/sessions/${encodeURIComponent(id)}/progress`, null, { method: 'PATCH', body });
  }
  cancelPlaybackSession(id) {
    return this.request(`/api/v1/playback/sessions/${encodeURIComponent(id)}`, null, { method: 'DELETE' });
  }
  importNfo(id, mode) {
    return this.request(`/api/v1/films/${encodeURIComponent(id)}/nfo-import`, null, {
      method: 'POST',
      body: { mode, ...(mode === 'force-replace' ? { confirmation: 'IMPORT_NFO_REPLACE' } : {}) },
    });
  }
  createCategory(name) { return this.request('/api/v1/categories', null, { method: 'POST', body: { name } }); }
  renameCategory(id, name) { return this.request(`/api/v1/categories/${encodeURIComponent(id)}`, null, { method: 'PATCH', body: { name } }); }
  removeCategory(id) {
    return this.request(`/api/v1/categories/${encodeURIComponent(id)}`, null, {
      method: 'DELETE',
      body: { confirmation: 'DELETE_CATEGORY' },
    });
  }
  media(kind, id) { return `/media/v1/${kind}/${encodeURIComponent(id)}`; }
}

const client = new HttpFilmLibraryClient();
const state = {
  view: 'library',
  libraryMode: 'all',
  page: 1,
  pageSize: 24,
  totalPages: 1,
  searchTimer: null,
  server: null,
  auth: null,
  filters: null,
  playbackCapabilities: null,
  playback: null,
};
let activeCardPreviewClose = null;
const elements = Object.fromEntries([
  'menu-toggle', 'sidebar-backdrop', 'app-sidebar', 'mobile-role-badge', 'sidebar-status',
  'count-all', 'count-unorganized', 'count-organized', 'count-favorite', 'count-all-data',
  'library-view', 'library-title', 'library-caption', 'sources-view', 'sources-caption',
  'source-grid', 'sources-refresh', 'categories-view', 'categories-caption', 'category-grid',
  'actors-view', 'actors-caption', 'actor-search', 'actor-count', 'actor-grid', 'actors-refresh',
  'settings-view', 'server-facts', 'device-facts', 'settings-device-revoke',
  'role-badge', 'result-summary', 'error', 'film-grid', 'search', 'source',
  'category', 'tag', 'genre', 'actor', 'comment-images', 'sort', 'refresh', 'previous-page', 'next-page',
  'page-summary', 'film-detail', 'detail-content', 'close-detail', 'login-dialog',
  'login-form', 'login-error', 'account-username', 'account-password', 'device-revoke',
  'create-category',
].map((id) => [camel(id), document.querySelector(`#${id}`)]));

void bootstrap();

async function bootstrap() {
  bindEvents();
  try {
    state.server = await client.serverInfo();
    await initializeLibrary();
  } catch (error) {
    if (isAuthenticationError(error)) showLogin();
    else showError(error);
  }
}

async function initializeLibrary() {
  state.auth = await client.me();
  const admin = state.auth.canManage;
  elements.roleBadge.textContent = admin ? '管理员' : '访客';
  elements.roleBadge.classList.toggle('admin', admin);
  elements.mobileRoleBadge.textContent = admin ? '管理员' : '访客';
  elements.mobileRoleBadge.classList.toggle('admin', admin);
  elements.sidebarStatus.textContent = state.server.networkScope === 'lan' ? '局域网连接正常' : '本机连接正常';
  elements.createCategory.hidden = !admin;
  const canRevoke = state.server.authenticationRequired && state.auth.authenticated;
  elements.deviceRevoke.hidden = !canRevoke;
  elements.settingsDeviceRevoke.hidden = !canRevoke;
  [state.filters, state.playbackCapabilities] = await Promise.all([
    client.filters(),
    client.playbackCapabilities().catch(() => null),
  ]);
  populateFilters(state.filters);
  renderIndexViews();
  showView(state.view, state.libraryMode, { load: false, reset: false });
  await loadFilms();
}

function bindEvents() {
  for (const item of document.querySelectorAll('.nav-item')) {
    item.addEventListener('click', () => showView(item.dataset.view, item.dataset.libraryMode));
  }
  elements.menuToggle.addEventListener('click', toggleSidebar);
  elements.sidebarBackdrop.addEventListener('click', closeSidebar);
  elements.refresh.addEventListener('click', () => void reloadLibrary());
  elements.sourcesRefresh.addEventListener('click', () => void reloadLibrary());
  elements.actorsRefresh.addEventListener('click', () => void reloadLibrary());
  elements.actorSearch.addEventListener('input', renderActors);
  for (const select of [elements.source, elements.category, elements.tag, elements.genre, elements.actor, elements.commentImages, elements.sort]) {
    select.addEventListener('change', () => { state.page = 1; void loadFilms(); });
  }
  elements.search.addEventListener('input', () => {
    if (state.searchTimer) window.clearTimeout(state.searchTimer);
    state.searchTimer = window.setTimeout(() => { state.page = 1; void loadFilms(); }, 250);
  });
  elements.previousPage.addEventListener('click', () => {
    if (state.page > 1) { state.page -= 1; void loadFilms(); }
  });
  elements.nextPage.addEventListener('click', () => {
    if (state.page < state.totalPages) { state.page += 1; void loadFilms(); }
  });
  elements.closeDetail.addEventListener('click', closeFilmDetail);
  elements.filmDetail.addEventListener('close', stopDetailPlayback);
  elements.filmDetail.addEventListener('cancel', stopDetailPlayback);
  elements.filmDetail.addEventListener('click', (event) => {
    if (event.target === elements.filmDetail) closeFilmDetail();
  });
  elements.accountUsername.value = localStorage.getItem('film-library-web-username') || '';
  elements.loginForm.addEventListener('submit', (event) => {
    event.preventDefault();
    void completeLogin();
  });
  elements.deviceRevoke.addEventListener('click', () => void revokeDevice());
  elements.settingsDeviceRevoke.addEventListener('click', () => void revokeDevice());
  elements.createCategory.addEventListener('click', () => void createCategory());
  window.addEventListener('scroll', () => activeCardPreviewClose?.(), true);
  window.addEventListener('resize', () => activeCardPreviewClose?.());
}

function closeFilmDetail() {
  stopDetailPlayback();
  if (elements.filmDetail.open) elements.filmDetail.close();
}

function stopDetailPlayback() {
  releaseActivePlayback();
  for (const video of elements.detailContent.querySelectorAll('video')) {
    video.pause();
    video.removeAttribute('src');
    video.load();
  }
}

function populateFilters(filters) {
  fillSelect(elements.source, filters.sources, (item) => item.id, (item) => `${item.name}${item.online ? '' : '（离线）'}`, true);
  fillSelect(elements.category, filters.categories, (item) => item.id, countLabel, true);
  fillSelect(elements.tag, filters.tags, (item) => item.id, countLabel, true);
  fillSelect(elements.genre, filters.genres, (item) => item.id, countLabel, true);
  fillSelect(elements.actor, filters.actors, (item) => item.name, countLabel, true);
  elements.countAll.textContent = String(filters.navigation.all);
  elements.countUnorganized.textContent = String(filters.navigation.unorganized);
  elements.countOrganized.textContent = String(filters.navigation.organized);
  elements.countFavorite.textContent = String(filters.navigation.favorite);
  elements.countAllData.textContent = String(filters.navigation.allData);
}

function currentQuery() {
  const organizationState = state.libraryMode === 'organized' || state.libraryMode === 'unorganized'
    ? state.libraryMode
    : 'all';
  return {
    page: state.page,
    pageSize: state.pageSize,
    search: elements.search.value.trim(),
    sourceId: elements.source.value,
    categoryIds: elements.category.value ? [elements.category.value] : [],
    nfoTagIds: elements.tag.value ? [elements.tag.value] : [],
    genreIds: elements.genre.value ? [elements.genre.value] : [],
    actor: elements.actor.value,
    organizationState,
    favoriteOnly: state.libraryMode === 'favorite',
    commentImages: elements.commentImages.value,
    allData: state.libraryMode === 'all-data',
    sort: elements.sort.value,
  };
}

async function reloadLibrary() {
  hideError();
  try {
    state.filters = await client.filters();
    populateFilters(state.filters);
    renderIndexViews();
    if (state.view === 'library') await loadFilms();
  } catch (error) {
    if (isAuthenticationError(error)) showLogin();
    else showError(error);
  }
}

async function loadFilms() {
  setBusy(true);
  hideError();
  try {
    const page = await client.films(currentQuery());
    state.page = page.page;
    state.totalPages = page.totalPages;
    elements.resultSummary.textContent = `${page.total} 部影片`;
    elements.libraryCaption.textContent = `${page.total} 条记录 · 所有资料只保存在服务端电脑`;
    elements.pageSummary.textContent = `第 ${page.page} / ${page.totalPages} 页`;
    elements.previousPage.disabled = page.page <= 1;
    elements.nextPage.disabled = page.page >= page.totalPages;
    renderFilms(page.items);
  } catch (error) {
    if (isAuthenticationError(error)) showLogin();
    else showError(error);
  } finally {
    setBusy(false);
  }
}

function showView(view = 'library', libraryMode = 'all', options = {}) {
  const knownViews = ['library', 'sources', 'categories', 'actors', 'settings'];
  state.view = knownViews.includes(view) ? view : 'library';
  if (state.view === 'library') {
    state.libraryMode = ['all', 'unorganized', 'organized', 'favorite', 'all-data'].includes(libraryMode)
      ? libraryMode
      : 'all';
    if (options.reset !== false) resetLibraryFilters();
    state.page = 1;
    updateLibraryHeading();
  }

  for (const item of document.querySelectorAll('.nav-item')) {
    const active = item.dataset.view === state.view
      && (state.view !== 'library' || item.dataset.libraryMode === state.libraryMode);
    item.classList.toggle('is-active', active);
    if (active) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  }
  for (const [name, viewElement] of Object.entries({
    library: elements.libraryView,
    sources: elements.sourcesView,
    categories: elements.categoriesView,
    actors: elements.actorsView,
    settings: elements.settingsView,
  })) {
    viewElement.hidden = name !== state.view;
  }
  closeSidebar();
  if (state.view === 'library' && options.load !== false) void loadFilms();
}

function updateLibraryHeading() {
  const headings = {
    all: ['全部影片', '浏览当前可用的影片资料'],
    unorganized: ['未整理', '尚未加入“我的分类”的影片'],
    organized: ['已整理', '已经加入“我的分类”的影片'],
    favorite: ['收藏', '标记为收藏的影片'],
    'all-data': ['所有数据', '包含缺失、离线及已归档记录'],
  };
  const [title, caption] = headings[state.libraryMode] || headings.all;
  elements.libraryTitle.textContent = title;
  elements.libraryCaption.textContent = caption;
}

function resetLibraryFilters() {
  elements.search.value = '';
  elements.source.value = '';
  elements.category.value = '';
  elements.tag.value = '';
  elements.genre.value = '';
  elements.actor.value = '';
  elements.commentImages.value = 'all';
  for (const option of elements.sort.options) {
    if (option.value === 'organized') option.hidden = state.libraryMode !== 'organized';
    if (option.value === 'favorite') option.hidden = state.libraryMode !== 'favorite';
  }
  elements.sort.value = state.libraryMode === 'organized'
    ? 'organized'
    : state.libraryMode === 'favorite' ? 'favorite' : 'added';
}

function openLibraryWithFilter(filter) {
  showView('library', 'all', { load: false });
  if (filter.sourceId) elements.source.value = filter.sourceId;
  if (filter.categoryId) elements.category.value = filter.categoryId;
  if (filter.actor) elements.actor.value = filter.actor;
  void loadFilms();
}

function toggleSidebar() {
  const open = !elements.appSidebar.classList.contains('is-open');
  elements.appSidebar.classList.toggle('is-open', open);
  elements.sidebarBackdrop.hidden = !open;
  elements.menuToggle.setAttribute('aria-expanded', String(open));
}

function closeSidebar() {
  elements.appSidebar.classList.remove('is-open');
  elements.sidebarBackdrop.hidden = true;
  elements.menuToggle.setAttribute('aria-expanded', 'false');
}

function renderIndexViews() {
  renderSources();
  renderCategories();
  renderActors();
  renderWebSettings();
}

function renderSources() {
  const sources = state.filters?.sources || [];
  elements.sourceGrid.replaceChildren();
  elements.sourcesCaption.textContent = `${sources.length} 个来源 · 网页端不会显示磁盘路径`;
  if (!sources.length) {
    elements.sourceGrid.append(createElement('p', 'empty-state', '还没有影片来源'));
    return;
  }
  for (const source of sources) {
    const card = createElement('article', 'index-card');
    const status = createElement('span', `source-state${source.online ? ' online' : ''}`);
    const copy = createElement('div', 'index-copy');
    copy.append(
      createElement('strong', '', source.name),
      createElement('small', '', `${source.online ? '在线' : '离线'} · ${source.enabled ? '已启用' : '已停用'} · ${formatScanTime(source.lastScanAt)}`),
    );
    const actions = createElement('div', 'index-actions');
    actions.append(actionButton('查看影片', () => openLibraryWithFilter({ sourceId: source.id })));
    if (state.auth?.canManage) {
      actions.append(actionButton('扫描', () => runAdminAction(
        () => client.rescanSource(source.id),
        `“${source.name}”扫描已启动`,
      )));
    }
    card.append(status, copy, actions);
    elements.sourceGrid.append(card);
  }
}

function renderCategories() {
  const categories = state.filters?.categories || [];
  elements.categoryGrid.replaceChildren();
  elements.categoriesCaption.textContent = `${categories.length} 个分类 · 点击分类查看影片`;
  if (!categories.length) {
    elements.categoryGrid.append(createElement('p', 'empty-state', '还没有自定义分类'));
    return;
  }
  for (const category of categories) {
    const card = createElement('article', 'index-card');
    const icon = createElement('span', 'index-icon', '◆');
    const copy = createElement('div', 'index-copy');
    copy.append(
      createElement('strong', '', category.name),
      createElement('small', '', `${category.filmCount || 0} 部影片`),
    );
    const actions = createElement('div', 'index-actions');
    actions.append(actionButton('查看', () => openLibraryWithFilter({ categoryId: category.id })));
    if (state.auth?.canManage) {
      actions.append(
        actionButton('重命名', () => void renameCategory(category.id)),
        actionButton('删除', () => void deleteCategory(category.id), 'danger'),
      );
    }
    card.append(icon, copy, actions);
    elements.categoryGrid.append(card);
  }
}

function renderActors() {
  const needle = elements.actorSearch.value.trim().toLocaleLowerCase();
  const actors = (state.filters?.actors || []).filter((actor) => actor.name.toLocaleLowerCase().includes(needle));
  elements.actorGrid.replaceChildren();
  elements.actorCount.textContent = `${actors.length} 位演员`;
  if (!actors.length) {
    elements.actorGrid.append(createElement('p', 'empty-state', needle ? '没有匹配的演员' : '还没有演员数据'));
    return;
  }
  for (const actor of actors) {
    const card = createElement('button', 'actor-card');
    card.type = 'button';
    card.append(
      createElement('span', 'actor-avatar', actor.name.slice(0, 1).toUpperCase()),
      createElement('span', 'index-copy', actor.name),
      createElement('small', 'muted', `${actor.filmCount} 部`),
    );
    card.addEventListener('click', () => openLibraryWithFilter({ actor: actor.name }));
    elements.actorGrid.append(card);
  }
}

function renderWebSettings() {
  if (!state.server || !state.auth) return;
  elements.serverFacts.replaceChildren();
  addFact(elements.serverFacts, '访问地址', (state.server.baseUrls?.length ? state.server.baseUrls : [state.server.baseUrl]).join(' · '));
  addFact(elements.serverFacts, '网络范围', state.server.networkScope === 'lan' ? '私有局域网' : '仅本机');
  addFact(elements.serverFacts, '监听端口', String(state.server.port));
  addFact(elements.serverFacts, '身份验证', state.server.authenticationRequired ? '需要账号登录' : '本机免登录');
  addFact(elements.serverFacts, '管理接口', state.server.managementAvailable ? '可用（登录账号授权）' : '未启用');
  if (state.playbackCapabilities) {
    addFact(elements.serverFacts, 'ffprobe', state.playbackCapabilities.ffprobeAvailable ? '可用' : '未找到');
    addFact(elements.serverFacts, 'ffmpeg', state.playbackCapabilities.ffmpegAvailable ? '可用' : '未找到');
    addFact(
      elements.serverFacts,
      '播放任务',
      `${state.playbackCapabilities.activeJobs} / ${state.playbackCapabilities.maxConcurrentJobs}`,
    );
  }
  elements.deviceFacts.replaceChildren();
  addFact(elements.deviceFacts, '账号', state.auth.device?.name?.replace(/^账号\s+/, '') || '本机浏览器');
  addFact(elements.deviceFacts, '角色', state.auth.canManage ? '管理员' : '访客');
  addFact(elements.deviceFacts, '最近使用', formatDateTime(state.auth.device?.lastUsedAt));
}

function formatScanTime(value) {
  return value ? `上次扫描 ${formatDateTime(value)}` : '尚未扫描';
}

function formatDateTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

function availabilityLabel(value) {
  const labels = {
    partial_missing: '部分分段文件缺失',
    missing: '影片文件缺失',
    source_offline: '影片来源当前离线',
    source_removed: '影片来源已删除',
    archived: '影片记录已归档',
  };
  return labels[value] || '影片当前不可用';
}

function renderFilms(films) {
  activeCardPreviewClose?.();
  elements.filmGrid.replaceChildren();
  if (!films.length) {
    elements.filmGrid.append(createElement('p', 'empty', '没有符合当前条件的影片'));
    return;
  }
  for (const film of films) {
    const card = createElement('article', 'film-card');
    const open = createElement('div', 'film-open');
    open.tabIndex = 0;
    open.setAttribute('role', 'button');
    const poster = document.createElement('img');
    poster.alt = `${film.title} 海报`;
    poster.loading = 'lazy';
    poster.src = film.posterAssetId
      ? client.media('assets', film.posterAssetId)
      : client.media('posters', film.id);
    poster.addEventListener('error', () => {
      poster.removeAttribute('src');
      poster.className = 'poster-placeholder';
    });
    const copy = createElement('span', 'film-copy');
    copy.append(
      createElement('strong', '', `${film.favorite ? '★ ' : ''}${film.title}`),
      createElement('small', '', [film.year, film.sourceName].filter(Boolean).join(' · ')),
      createElement('small', 'film-flags', film.customCategories.map((item) => item.name).join(' · ') || '未分类'),
    );
    const posterFrame = createElement('span', 'film-poster-frame');
    const previewTriggers = createElement('span', 'film-preview-triggers');
    for (const [channel, icon, label, count] of [
      ['highlights', '▶', '精彩片段', film.highlightSegmentCount],
      ['stills', '▧', '剧照', film.previewImageAssetIds.length],
      ['comments', '💬', '评论图', film.commentImageCount],
    ]) {
      const trigger = document.createElement('button');
      trigger.type = 'button';
      trigger.className = 'film-preview-trigger';
      trigger.dataset.previewChannel = channel;
      trigger.textContent = icon;
      trigger.title = `${label} ${count}`;
      trigger.setAttribute('aria-label', `预览${label}`);
      trigger.disabled = !count;
      trigger.addEventListener('click', (event) => event.stopPropagation());
      previewTriggers.append(trigger);
    }
    posterFrame.append(poster, previewTriggers);
    open.append(posterFrame, copy);
    open.addEventListener('click', () => void showDetail(film.id));
    open.addEventListener('keydown', (event) => {
      if (event.target !== open) return;
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        void showDetail(film.id);
      }
    });
    card.append(open);
    attachFilmCardPreview(card, film);
    elements.filmGrid.append(card);
  }
}

function attachFilmCardPreview(card, film) {
  if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;
  let openTimer = null;
  let closeTimer = null;
  let popup = null;
  let slideshowTimer = null;
  let mediaGeneration = 0;
  let detailPromise = null;
  let activeChannel = null;

  const cancelClose = () => {
    if (closeTimer) window.clearTimeout(closeTimer);
    closeTimer = null;
  };
  const close = () => {
    if (openTimer) window.clearTimeout(openTimer);
    if (closeTimer) window.clearTimeout(closeTimer);
    if (slideshowTimer) window.clearInterval(slideshowTimer);
    openTimer = null;
    closeTimer = null;
    slideshowTimer = null;
    mediaGeneration += 1;
    if (popup?.querySelector('video') === state.playback?.video) releaseActivePlayback();
    popup?.remove();
    popup = null;
    activeChannel = null;
    if (activeCardPreviewClose === close) activeCardPreviewClose = null;
  };
  const scheduleClose = () => {
    cancelClose();
    closeTimer = window.setTimeout(close, configuredHoverCloseDelayMs());
  };
  const ensureDetail = () => {
    detailPromise ||= client.film(film.id);
    return detailPromise;
  };
  const show = (channel) => {
    if (popup) return;
    activeCardPreviewClose?.();
    activeCardPreviewClose = close;
    activeChannel = channel;
    popup = createElement('section', 'web-card-preview');
    popup.addEventListener('mouseenter', cancelClose);
    popup.addEventListener('mouseleave', scheduleClose);
    const media = createElement('div', 'web-card-preview-media');
    const body = createElement('div', 'web-card-preview-body');
    body.append(createElement('strong', '', film.title), createElement('small', 'muted', [film.year, film.sourceName].filter(Boolean).join(' · ')));
    popup.append(media, body);
    document.body.append(popup);
    positionFilmCardPreview(popup, card);

    const activate = async (channel) => {
      if (!popup) return;
      const generation = ++mediaGeneration;
      if (slideshowTimer) window.clearInterval(slideshowTimer);
      slideshowTimer = null;
      if (media.querySelector('video') === state.playback?.video) releaseActivePlayback();
      media.replaceChildren();
      media.classList.toggle('is-comment', channel === 'comments');
      media.style.removeProperty('aspect-ratio');
      positionFilmCardPreview(popup, card);
      if (channel !== 'highlights') {
        const ids = channel === 'comments' ? film.commentImageAssetIds : film.previewImageAssetIds;
        const image = document.createElement('img');
        image.alt = channel === 'comments' ? `${film.title} 精彩评论` : `${film.title} 剧照`;
        let index = 0;
        const pagination = ids.length > 1
          ? createPreviewPagination(ids.length, (nextIndex) => {
            index = nextIndex;
            renderImage();
            scheduleImageSlideshow();
          }, '预览图片切换')
          : null;
        const renderImage = () => {
          image.src = client.media('assets', ids[index]);
          pagination?.setActive(index);
        };
        const scheduleImageSlideshow = () => {
          if (slideshowTimer) window.clearInterval(slideshowTimer);
          slideshowTimer = ids.length > 1
            ? window.setInterval(() => { index = (index + 1) % ids.length; renderImage(); }, 1800)
            : null;
        };
        image.addEventListener('load', () => {
          if (channel !== 'comments' || generation !== mediaGeneration || !image.naturalWidth || !image.naturalHeight || !popup) return;
          const aspectRatio = image.naturalWidth / image.naturalHeight;
          media.style.aspectRatio = String(aspectRatio);
          positionFilmCardPreview(popup, card, aspectRatio);
        });
        renderImage();
        media.append(image);
        if (pagination) media.append(pagination.element);
        scheduleImageSlideshow();
        return;
      }
      const status = createElement('span', 'web-card-preview-status', '正在准备精彩片段…');
      const segmentLabel = createElement('div', 'web-segment-preview-label');
      const video = document.createElement('video');
      video.playsInline = true;
      video.preload = 'metadata';
      video.muted = true;
      media.append(video, segmentLabel, status);
      try {
        const detail = await ensureDetail();
        if (!popup || generation !== mediaGeneration) return;
        const segments = detail.segments.filter((segment) => segment.includeInPreview);
        if (!segments.length) {
          status.textContent = '暂无可用的精彩片段';
          return;
        }
        let segmentIndex = 0;
        let activeSegment = null;
        let activeSession = null;
        let advancing = false;
        const pagination = segments.length > 1
          ? createPreviewPagination(segments.length, (nextIndex) => { void play(nextIndex); }, '预览片段切换')
          : null;
        if (pagination) {
          media.append(pagination.element);
          status.classList.add('above-pagination');
        }
        const play = async (nextIndex) => {
          if (!popup || generation !== mediaGeneration || !segments.length) return;
          segmentIndex = nextIndex % segments.length;
          activeSegment = segments[segmentIndex];
          segmentLabel.replaceChildren(
            createElement('strong', '', activeSegment.title || `精彩片段 ${segmentIndex + 1}`),
            createElement('span', '', `${formatPlaybackTime(activeSegment.startSeconds)} → ${formatPlaybackTime(activeSegment.endSeconds)}`),
          );
          pagination?.setActive(segmentIndex);
          status.textContent = '正在准备精彩片段…';
          activeSession = await startAdaptivePlayback(video, status, {
            partId: activeSegment.filmFileId,
            purpose: 'segment-preview',
            startSeconds: activeSegment.startSeconds,
            endSeconds: activeSegment.endSeconds,
          }, null, { muted: true, controls: false });
          video.muted = true;
          advancing = false;
        };
        const advance = () => {
          if (advancing || !activeSegment) return;
          advancing = true;
          void play(segmentIndex + 1);
        };
        video.addEventListener('timeupdate', () => {
          if (!activeSegment || !activeSession) return;
          const end = activeSession.transport === 'direct'
            ? activeSegment.endSeconds
            : activeSegment.endSeconds - activeSegment.startSeconds;
          if (video.currentTime + .05 >= end) advance();
        });
        video.addEventListener('ended', advance);
        await play(0);
      } catch (error) {
        if (popup && generation === mediaGeneration) status.textContent = errorMessage(error);
      }
    };
    void activate(channel);
  };

  for (const trigger of card.querySelectorAll('.film-preview-trigger:not(:disabled)')) {
    trigger.addEventListener('mouseenter', () => {
      cancelClose();
      const channel = trigger.dataset.previewChannel;
      if (!channel || activeChannel === channel) return;
      if (popup) {
        close();
        show(channel);
        return;
      }
      if (openTimer) window.clearTimeout(openTimer);
      openTimer = window.setTimeout(() => { openTimer = null; show(channel); }, 420);
    });
    trigger.addEventListener('mouseleave', scheduleClose);
    trigger.addEventListener('focus', () => {
      cancelClose();
      const channel = trigger.dataset.previewChannel;
      if (!channel || activeChannel === channel) return;
      if (popup) close();
      show(channel);
    });
    trigger.addEventListener('blur', scheduleClose);
  }
}

function createPreviewPagination(count, onSelect, label) {
  const element = createElement('div', 'web-card-preview-pagination');
  element.setAttribute('aria-label', label);
  const dots = [];
  for (let index = 0; index < count; index += 1) {
    const dot = document.createElement('button');
    dot.type = 'button';
    dot.className = 'web-preview-dot';
    dot.setAttribute('aria-label', `显示第 ${index + 1} 项预览`);
    dot.addEventListener('click', (event) => {
      event.stopPropagation();
      onSelect(index);
    });
    dots.push(dot);
    element.append(dot);
  }
  return {
    element,
    setActive(index) {
      dots.forEach((dot, dotIndex) => {
        const active = dotIndex === index;
        dot.classList.toggle('active', active);
        if (active) dot.setAttribute('aria-current', 'true');
        else dot.removeAttribute('aria-current');
      });
    },
  };
}

function positionFilmCardPreview(popup, card, commentAspectRatio = null) {
  const margin = 12;
  const gap = 10;
  const rect = card.getBoundingClientRect();
  const available = window.innerWidth - margin * 2;
  if (!popup.dataset.side) {
    const baseWidth = Math.min(500, available);
    popup.dataset.side = rect.right + gap + baseWidth <= window.innerWidth - margin ? 'right' : 'left';
  }
  const width = commentAspectRatio
    ? Math.min(1000, available, Math.max(500, commentAspectRatio * 220))
    : Math.min(500, available);
  popup.style.width = `${width}px`;
  const height = popup.offsetHeight || 360;
  let left = popup.dataset.side === 'right' ? rect.right + gap : rect.left - width - gap;
  left = Math.max(margin, Math.min(left, window.innerWidth - width - margin));
  popup.style.left = `${left}px`;
  popup.style.top = `${Math.min(window.innerHeight - height - margin, Math.max(margin, rect.top))}px`;
}

async function showDetail(id) {
  activeCardPreviewClose?.();
  elements.detailContent.replaceChildren(createElement('p', 'muted', '正在读取详情…'));
  elements.filmDetail.showModal();
  try {
    const [film, server] = await Promise.all([client.film(id), client.serverInfo()]);
    state.server = server;
    renderDetail(film);
  } catch (error) {
    elements.detailContent.replaceChildren(createElement('p', 'error-panel', errorMessage(error)));
  }
}

function renderDetail(film) {
  releaseActivePlayback();
  const mediaNavigation = createDetailMediaNavigation();
  const playback = createUnifiedPlayback(film);
  const layout = createElement('div', 'detail-layout-grid');
  const main = createElement('main', 'detail-main-column');
  main.append(playback.section, createMediaSection(film, playback, mediaNavigation));
  layout.append(createDetailHeader(film, mediaNavigation.element, playback), main);
  elements.detailContent.replaceChildren(layout);
  playback.activate();
}

function createDetailHeader(film, mediaNavigation, playback) {
  const header = createElement('header', 'detail-header');
  const poster = createElement('div', 'detail-poster');
  const image = document.createElement('img');
  image.src = film.posterAssetId
    ? client.media('assets', film.posterAssetId)
    : client.media('posters', film.id);
  image.alt = `${film.title} 海报`;
  image.addEventListener('error', () => {
    poster.replaceChildren(createElement('span', 'detail-poster-placeholder', '无海报'));
  });
  poster.append(image);
  const main = createElement('div', 'detail-header-main');
  const titleRow = createElement('div', 'detail-title-row');
  const titleBlock = createElement('div', 'detail-title-copy');
  titleBlock.append(
    createElement('p', 'eyebrow', [film.year, film.contentRating, film.sourceName].filter(Boolean).join(' · ')),
    createElement('h2', '', film.title),
    createElement('p', 'muted', film.originalTitle || ' '),
  );
  const controls = createElement('div', 'detail-header-controls');
  if (state.auth?.canManage) {
    const favorite = actionButton(film.favorite ? '★ 已收藏' : '☆ 收藏', () => updateDetail(
      film.id,
      () => client.updateFavorite(film.id, !film.favorite),
      film.favorite ? '已取消收藏' : '已加入收藏',
    ), `favorite-button${film.favorite ? ' active' : ''}`);
    controls.append(favorite);
  }
  controls.append(mediaNavigation);
  titleRow.append(titleBlock, controls);
  const availability = film.availability && film.availability !== 'available'
    ? createElement('span', 'availability-warning', availabilityLabel(film.availability))
    : null;
  const categories = createCategoryEditor(film);
  main.append(titleRow);
  if (availability) main.append(availability);
  main.append(categories);
  const sidebarInfo = createElement('div', 'detail-sidebar-info');
  const basicInfo = createSidebarDisclosure('基本信息', [
    createLocalMetadataSection(film),
    createNfoTagsSection(film),
    createNfoSummarySection(film),
  ]);
  const detailsContent = [];
  const partsSection = createPartsSection(film, playback);
  if (partsSection) detailsContent.push(partsSection);
  detailsContent.push(createFileInfoSection(film));
  sidebarInfo.append(basicInfo, createSidebarDisclosure('详细信息', detailsContent));
  main.append(sidebarInfo);
  header.append(poster, main);
  return header;
}

function createSidebarDisclosure(title, content, open = false) {
  const disclosure = createElement('details', 'detail-sidebar-disclosure');
  disclosure.open = open;
  disclosure.append(createElement('summary', '', title), ...content);
  return disclosure;
}

function createDetailMediaNavigation() {
  const element = createElement('div', 'detail-media-navigation');
  let backward = null;
  let forward = null;
  const backButton = actionButton('后退', () => backward?.(), 'detail-navigation-button');
  const forwardButton = actionButton('前进', () => forward?.(), 'detail-navigation-button');
  element.append(backButton, forwardButton);
  const setMode = (options = {}) => {
    backward = options.backward || null;
    forward = options.forward || null;
    backButton.disabled = !backward;
    forwardButton.disabled = !forward;
    backButton.title = options.backTitle || '后退';
    forwardButton.title = options.forwardTitle || '前进';
  };
  setMode();
  return { element, setMode };
}

function createCategoryEditor(film) {
  const section = createElement('div', 'detail-categories');
  section.append(createElement('span', 'detail-field-label', '我的分类'));
  const chips = createElement('div', 'category-chips');
  if (!film.customCategories.length) chips.append(createElement('span', 'muted', '未分类'));
  for (const category of film.customCategories) {
    const chip = createElement('span', 'category-chip', category.name);
    if (state.auth?.canManage) {
      const remove = actionButton('×', () => {
        const ids = film.customCategories.filter((item) => item.id !== category.id).map((item) => item.id);
        void updateDetail(film.id, () => client.updateTaxonomy(film.id, { categoryIds: ids }), '分类已更新');
      }, 'category-remove');
      remove.title = `移除 ${category.name}`;
      chip.append(remove);
    }
    chips.append(chip);
  }
  section.append(chips);
  if (state.auth?.canManage) {
    const available = (state.filters?.categories || []).filter(
      (category) => !film.customCategories.some((selected) => selected.id === category.id),
    );
    const editor = createElement('div', 'category-combobox');
    const input = document.createElement('input');
    const suggestions = document.createElement('datalist');
    suggestions.id = `category-options-${film.id}`;
    input.type = 'text';
    input.placeholder = '选择或输入新分类，回车添加';
    input.setAttribute('list', suggestions.id);
    input.setAttribute('aria-label', '添加分类');
    for (const category of available) suggestions.append(new Option(category.name, category.name));
    let submitting = false;
    const submit = async () => {
      const name = input.value.trim();
      if (!name || submitting) return;
      const existing = available.find((category) => category.name.toLocaleLowerCase() === name.toLocaleLowerCase());
      submitting = true;
      input.disabled = true;
      const ids = [...film.customCategories.map((item) => item.id), ...(existing ? [existing.id] : [])];
      await updateDetail(
        film.id,
        () => client.updateTaxonomy(film.id, {
          categoryIds: ids,
          ...(existing ? {} : { newCategoryNames: [name] }),
        }),
        existing ? '分类已添加' : '新分类已创建并添加',
      );
      if (input.isConnected) {
        submitting = false;
        input.disabled = false;
        input.select();
      }
    };
    input.addEventListener('change', () => void submit());
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      void submit();
    });
    editor.append(input, suggestions);
    section.append(editor);
  }
  return section;
}

function createMediaSection(film, playback, navigation) {
  const section = createElement('section', 'detail-section media-section');
  const tabs = createElement('div', 'detail-tabs');
  const highlightsButton = actionButton('精彩片段', () => activate('highlights'), 'detail-tab active');
  const imageButton = actionButton('图片图库', () => activate('images'), 'detail-tab');
  tabs.append(highlightsButton, imageButton);
  const highlightsPanel = createElement('div', 'detail-tab-panel');
  highlightsPanel.dataset.tab = 'highlights';
  highlightsPanel.append(playback.segmentsPanel);
  const imagePanel = createElement('div', 'detail-tab-panel');
  imagePanel.dataset.tab = 'images';
  imagePanel.hidden = true;
  const gallery = film.images.length ? createGallery(film) : null;
  imagePanel.append(gallery?.section || createElement('p', 'media-empty', '暂无图片'));
  const panels = [highlightsPanel, imagePanel];
  function activate(name) {
    highlightsButton.classList.toggle('active', name === 'highlights');
    imageButton.classList.toggle('active', name === 'images');
    for (const panel of panels) panel.hidden = panel.dataset.tab !== name;
    if (name !== 'images') {
      const seekStep = configuredSeekStepSeconds();
      navigation.setMode(playback.canSeek ? {
        backward: () => playback.seek(-configuredSeekStepSeconds()),
        forward: () => playback.seek(configuredSeekStepSeconds()),
        backTitle: `后退 ${seekStep} 秒`,
        forwardTitle: `前进 ${seekStep} 秒`,
      } : {});
    } else {
      releaseActivePlayback();
      navigation.setMode(gallery?.canStep ? {
        backward: () => gallery.step(-1),
        forward: () => gallery.step(1),
        backTitle: '上一张',
        forwardTitle: '下一张',
      } : {});
    }
  }
  section.addEventListener('playback:reveal', () => activate('highlights'));
  section.append(tabs, ...panels);
  activate('highlights');
  return section;
}

function createGallery(film) {
  const gallery = createElement('div', 'detail-gallery');
  const commentImages = film.images.filter((item) => item.assetType === 'comment');
  const stillImages = film.images.filter((item) => item.assetType !== 'comment');
  const images = [...commentImages, ...stillImages];
  const thumbnailButtons = [];
  const lightbox = createElement('div', 'gallery-lightbox');
  const stage = createElement('div', 'gallery-lightbox-stage');
  const image = document.createElement('img');
  const count = createElement('span', 'gallery-count');
  const close = actionButton('×', () => closeViewer(), 'gallery-close');
  lightbox.hidden = true;
  lightbox.tabIndex = -1;
  lightbox.setAttribute('role', 'dialog');
  lightbox.setAttribute('aria-modal', 'true');
  lightbox.setAttribute('aria-label', `${film.title} 图片查看器`);
  image.alt = `${film.title} 图片`;
  let index = 0;
  const show = (next) => {
    index = (next + images.length) % images.length;
    image.src = client.media('assets', images[index].id);
    count.textContent = `${index + 1} / ${images.length}`;
    thumbnailButtons.forEach((item, itemIndex) => item.classList.toggle('active', itemIndex === index));
    lightbox.hidden = false;
    window.requestAnimationFrame(() => lightbox.focus());
  };
  function closeViewer() {
    lightbox.hidden = true;
  }
  stage.append(image, close, count);
  if (images.length > 1) {
    stage.append(
      actionButton('‹', () => show(index - 1), 'gallery-arrow left'),
      actionButton('›', () => show(index + 1), 'gallery-arrow right'),
    );
  }
  lightbox.append(stage);
  lightbox.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeViewer();
    } else if (event.key === 'ArrowLeft' && images.length > 1) {
      event.preventDefault();
      show(index - 1);
    } else if (event.key === 'ArrowRight' && images.length > 1) {
      event.preventDefault();
      show(index + 1);
    }
  });
  const appendGroup = (title, items, offset, className = '') => {
    if (!items.length) return;
    const group = createElement('section', `gallery-group${className ? ` ${className}` : ''}`);
    const heading = createElement('div', 'section-heading');
    heading.append(createElement('span', '', title), createElement('small', '', `${items.length} 张 · 点击缩略图查看大图`));
    const thumbnails = createElement('div', 'gallery-thumbnail-grid');
    items.forEach((item, itemIndex) => {
      const absoluteIndex = offset + itemIndex;
      const button = actionButton('', () => show(absoluteIndex));
      const thumbnail = document.createElement('img');
      thumbnail.src = client.media('assets', item.id);
      thumbnail.alt = `${title}缩略图 ${itemIndex + 1}`;
      button.append(thumbnail);
      thumbnails.append(button);
      thumbnailButtons[absoluteIndex] = button;
    });
    group.append(heading, thumbnails);
    gallery.append(group);
  };
  appendGroup('精彩评论', commentImages, 0, 'comment-gallery-group');
  appendGroup('剧照', stillImages, commentImages.length);
  gallery.append(lightbox);
  return {
    section: gallery,
    canStep: images.length > 1,
    step(delta) {
      show(index + delta);
    },
  };
}

function createPartsSection(film, playback) {
  if (!film.parts.length) return null;
  const section = createElement('section', 'detail-section');
  const heading = createElement('div', 'section-heading');
  heading.append(createElement('span', '', '分段文件'), createElement('span', 'muted', `${film.parts.length} 个`));
  const list = createElement('div', 'parts-list');
  for (const part of film.parts) {
    const row = createElement('div', 'part-row');
    const copy = document.createElement('div');
    copy.append(
      createElement('strong', '', part.partType === 'single' ? '单文件' : `${part.partType.toUpperCase()} ${part.partNumber}`),
      createElement('span', 'text-mono', part.filename),
    );
    const actions = createElement('div', 'part-actions');
    if (part.missing) actions.append(createElement('span', 'missing-tag', '缺失'));
    const play = actionButton('播放', () => playback.playPart(part.id), 'text-button');
    play.disabled = part.missing;
    actions.append(play);
    row.append(copy, actions);
    list.append(row);
  }
  section.append(heading, list);
  return section;
}

function createLocalMetadataSection(film) {
  const section = createElement('section', 'detail-section');
  const heading = createElement('div', 'section-heading');
  heading.append(createElement('span', '', '本地资料'));
  if (!state.auth?.canManage) {
    const facts = createElement('dl', 'fact-grid');
    addFact(facts, '标题', film.title);
    addFact(facts, '原始标题', film.originalTitle || '—');
    addFact(facts, '评分', film.rating ? `${film.rating} / 10` : '—');
    addFact(facts, '备注', film.notes || '—');
    section.append(heading, facts);
    return section;
  }
  const status = createElement('span', 'save-state muted', '修改后自动保存');
  heading.append(status);
  const form = createElement('form', 'detail-form');
  form.addEventListener('submit', (event) => event.preventDefault());
  const title = field('标题', 'text', film.title);
  const originalTitle = field('原始标题', 'text', film.originalTitle || '');
  const rating = field('评分', 'number', String(film.rating || 0));
  rating.input.min = '0';
  rating.input.max = '10';
  rating.input.step = '0.5';
  const notes = field('备注', 'textarea', film.notes || '');
  notes.input.placeholder = '只保存在本地数据库';
  form.append(title.label, originalTitle.label, rating.label, notes.label);
  let saveTimer = null;
  const scheduleSave = () => {
    if (saveTimer) window.clearTimeout(saveTimer);
    status.textContent = '等待保存…';
    saveTimer = window.setTimeout(async () => {
      status.textContent = '正在保存…';
      try {
        await client.updateMetadata(film.id, {
          title: title.input.value,
          originalTitle: originalTitle.input.value,
          rating: Number(rating.input.value),
          notes: notes.input.value,
        });
        status.textContent = '已保存';
        toast('本地资料已保存');
        await reloadLibrary();
      } catch (error) {
        status.textContent = `保存失败：${errorMessage(error)}`;
        status.classList.add('error-panel');
      }
    }, 650);
  };
  for (const input of [title.input, originalTitle.input, rating.input, notes.input]) input.addEventListener('input', scheduleSave);
  section.append(heading, form);
  return section;
}

function createNfoTagsSection(film) {
  const section = createElement('section', 'detail-section nfo-tags-section');
  const heading = createElement('div', 'section-heading');
  const label = createElement('span', '', 'NFO 标签');
  label.append(createElement('small', '', '来自 NFO，只读'));
  heading.append(label);
  const tags = createElement('div', 'nfo-tags');
  if (!film.nfoTags.length) tags.append(createElement('span', 'muted', '暂无 NFO 标签'));
  for (const tag of film.nfoTags) tags.append(createElement('span', 'nfo-tag', tag.name));
  section.append(heading, tags);
  return section;
}

function createNfoSummarySection(film) {
  const section = createElement('section', 'detail-section info-section');
  const heading = createElement('div', 'section-heading');
  heading.append(createElement('span', '', 'NFO 摘要'));
  if (state.auth?.canManage) {
    const actions = createElement('div', 'section-actions');
    actions.append(
      actionButton('补充空字段', () => importNfo(film.id, 'supplement'), 'text-button'),
      actionButton('强制重新导入', () => chooseNfoImport(film.id), 'text-button'),
    );
    heading.append(actions);
  }
  const plot = createElement('p', 'plot', film.plot || film.outline || '暂无简介');
  const facts = createElement('dl', 'fact-grid');
  addFact(facts, '导演', film.directors.join(' · ') || '—');
  const actorValue = document.createElement('dd');
  if (film.actors.length) {
    const links = createElement('div', 'actor-links');
    for (const actor of film.actors) {
      const count = state.filters?.actors?.find((item) => item.name === actor)?.filmCount;
      links.append(actionButton(`${actor}${count === undefined ? '' : `（${count} 部）`}`, () => openLibraryWithFilter({ actor })));
    }
    actorValue.append(links);
  } else {
    actorValue.textContent = '—';
  }
  facts.append(createElement('dt', '', '演员'), actorValue);
  addFact(facts, '类型', film.genres.map((item) => item.name).join(' · ') || '—');
  section.append(heading, plot, facts);
  return section;
}

function createFileInfoSection(film) {
  const section = createElement('section', 'detail-section info-section');
  const heading = createElement('div', 'section-heading');
  heading.append(createElement('span', '', '文件信息'));
  const facts = createElement('dl', 'fact-grid');
  addFact(facts, '来源', film.sourceName);
  addFact(facts, '主文件', film.parts[0]?.filename || '—');
  addFact(facts, '容器', film.containerFormat || '—');
  addFact(facts, '视频', [film.videoCodec, film.width && film.height ? `${film.width}×${film.height}` : ''].filter(Boolean).join(' ') || '—');
  addFact(facts, 'NFO', film.nfoStatus === 'ok' ? '已读取' : film.nfoStatus === 'error' ? '读取失败' : '未找到');
  section.append(heading, facts);
  if (film.nfoError) section.append(createElement('p', 'error-panel', film.nfoError));
  return section;
}

function createUnifiedPlayback(film) {
  const section = createElement('section', 'web-playback unified-playback');
  const status = createElement('small', 'muted playback-status');
  const video = document.createElement('video');
  video.controls = true;
  video.playsInline = true;
  video.preload = 'metadata';
  video.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    event.stopPropagation();
    const delta = event.shiftKey ? configuredFineSeekStepSeconds() : configuredSeekStepSeconds();
    seekVideoBy(video, event.key === 'ArrowLeft' ? -delta : delta);
  }, true);
  const videoFrame = createElement('div', 'segment-video-frame');
  const segmentLabel = createElement('div', 'segment-current-label');
  videoFrame.append(video, segmentLabel);
  video.addEventListener('loadedmetadata', () => {
    const active = state.playback;
    if (active?.video === video) active.mediaReady = true;
  });
  const subtitlePicker = createElement('label', 'subtitle-picker');
  const subtitleSelect = document.createElement('select');
  subtitlePicker.append(createElement('span', '', '字幕'), subtitleSelect);
  resetSubtitlePicker(subtitleSelect);
  subtitleSelect.addEventListener('change', () => selectSubtitleTrack(video, subtitleSelect.value));
  const parts = film.parts.filter((part) => !part.missing);
  const allSegments = film.segments || [];
  const previewSegments = allSegments.filter((segment) => segment.includeInPreview);
  const segmentsPanel = createElement('div', 'web-segments-panel');
  let activeSegmentIndex = -1;
  let activeSegment = null;
  let activeSegmentSession = null;

  if (!parts.length) {
    status.textContent = '原片文件当前不可用';
  } else {
    status.textContent = allSegments.length
      ? `${allSegments.length} 个片段标注 · 点击播放原片或选择精彩片段`
      : '点击播放原片';
  }

  const clearSegmentMode = () => {
    activeSegmentIndex = -1;
    activeSegment = null;
    activeSegmentSession = null;
    segmentLabel.replaceChildren();
  };
  const playOriginal = async (partId = null) => {
    clearSegmentMode();
    await startAdaptivePlayback(
      video,
      status,
      partId ? { partId } : { filmId: film.id },
      subtitleSelect,
    );
  };
  const playSegment = async (segment, sequencePosition = -1) => {
    activeSegmentIndex = sequencePosition;
    activeSegment = segment;
    segmentLabel.replaceChildren(
      createElement('strong', '', segment.title || '未命名片段'),
      createElement('span', '', `${formatPlaybackTime(segment.startSeconds)} → ${formatPlaybackTime(segment.endSeconds)}`),
    );
    status.textContent = `正在准备 ${segment.title || '未命名片段'}…`;
    activeSegmentSession = await startAdaptivePlayback(video, status, {
      partId: segment.filmFileId,
      purpose: 'segment-preview',
      startSeconds: segment.startSeconds,
      endSeconds: segment.endSeconds,
    });
    if (activeSegmentSession) {
      status.textContent = `${segment.title || '未命名片段'} · ${formatPlaybackTime(segment.startSeconds)}–${formatPlaybackTime(segment.endSeconds)}`;
    }
  };
  const playSegmentAt = async (index) => {
    if (index >= previewSegments.length) {
      clearSegmentMode();
      video.pause();
      status.textContent = '精彩片段播放完毕';
      return;
    }
    await playSegment(previewSegments[index], index);
  };
  const advanceSegment = () => {
    if (activeSegmentIndex >= 0) void playSegmentAt(activeSegmentIndex + 1);
  };

  video.addEventListener('timeupdate', () => {
    if (activeSegment && activeSegmentSession) {
      const segment = activeSegment;
      const finished = activeSegmentSession.transport === 'direct'
        ? video.currentTime + 0.05 >= segment.endSeconds
        : video.currentTime + 0.05 >= segment.endSeconds - segment.startSeconds;
      if (finished) {
        if (activeSegmentIndex >= 0) advanceSegment();
        else {
          video.pause();
          clearSegmentMode();
        }
      }
      return;
    }
    const active = state.playback;
    if (!active?.sessionId || active.video !== video || Date.now() - active.lastProgressAt < 10_000) return;
    active.lastProgressAt = Date.now();
    void client.updatePlaybackProgress(active.sessionId, {
      positionSeconds: video.currentTime,
      ...(Number.isFinite(video.duration) ? { durationSeconds: video.duration } : {}),
    }).catch(() => undefined);
  });
  video.addEventListener('ended', () => {
    if (activeSegment) {
      if (activeSegmentIndex >= 0) advanceSegment();
      else {
        clearSegmentMode();
        status.textContent = '片段播放完毕';
      }
      return;
    }
    const active = state.playback;
    if (!active?.sessionId || active.video !== video) return;
    void client.updatePlaybackProgress(active.sessionId, {
      positionSeconds: video.duration || video.currentTime,
      ...(Number.isFinite(video.duration) ? { durationSeconds: video.duration } : {}),
    }).catch(() => undefined);
  });
  video.addEventListener('pause', () => {
    if (activeSegment) return;
    const active = state.playback;
    if (!active?.sessionId || active.video !== video || !(video.currentTime > 0)) return;
    void client.updatePlaybackProgress(active.sessionId, {
      positionSeconds: video.currentTime,
      ...(Number.isFinite(video.duration) ? { durationSeconds: video.duration } : {}),
    }).catch(() => undefined);
  });
  const playerActions = createElement('div', 'unified-player-actions');
  const playOriginalButton = actionButton('播放 / 继续原片', () => void playOriginal(), 'primary-button');
  playOriginalButton.disabled = !parts.length;
  const playHighlightsButton = actionButton('连续播放精彩片段', () => void playSegmentAt(0));
  playHighlightsButton.disabled = !previewSegments.length;
  playerActions.append(playOriginalButton, playHighlightsButton);
  const playerControls = createElement('div', 'player-control-row');
  playerControls.append(subtitlePicker, playerActions);
  section.append(status, videoFrame, playerControls);

  if (parts.length > 1) {
    const choices = createElement('div', 'original-part-choices');
    for (const part of parts) {
      choices.append(actionButton(
        `${part.partType.toUpperCase()} ${part.partNumber}`,
        () => void playOriginal(part.id),
      ));
    }
    section.append(choices);
  }
  if (allSegments.length) {
    const timelines = createElement('div', 'web-segment-timelines');
    for (const part of film.parts) {
      const partSegments = allSegments.filter((segment) => segment.filmFileId === part.id);
      if (!partSegments.length) continue;
      const duration = Math.max(
        Number(film.runtimeSeconds) || 0,
        ...partSegments.map((segment) => segment.endSeconds),
        1,
      );
      const timelineRow = createElement('div', 'web-segment-timeline-row');
      timelineRow.append(createElement(
        'span',
        'web-segment-part-label',
        part.partType === 'single' ? part.filename : `${part.partType.toUpperCase()} ${part.partNumber}`,
      ));
      const track = createElement('div', 'web-segment-timeline');
      for (const segment of partSegments) {
        const node = actionButton('', () => void playSegment(segment), 'web-segment-node');
        node.title = `${segment.title || '未命名片段'} · ${formatPlaybackTime(segment.startSeconds)} → ${formatPlaybackTime(segment.endSeconds)}`;
        node.setAttribute('aria-label', node.title);
        node.classList.toggle('disabled', !segment.includeInPreview);
        node.style.left = `${Math.min(100, (segment.startSeconds / duration) * 100)}%`;
        node.style.width = `${Math.max(.5, Math.min(100, ((segment.endSeconds - segment.startSeconds) / duration) * 100))}%`;
        track.append(node);
      }
      timelineRow.append(track);
      timelines.append(timelineRow);
    }
    const list = createElement('div', 'web-segment-list');
    allSegments.forEach((segment, index) => {
      const row = actionButton('', () => void playSegment(segment), 'web-segment-row');
      row.append(
        createElement('strong', '', segment.title || `片段 ${index + 1}`),
        createElement('span', '', formatPlaybackTime(segment.endSeconds - segment.startSeconds)),
      );
      if (!segment.includeInPreview) row.append(createElement('em', '', '不纳入连续预览'));
      if (segment.sourceChanged) row.append(createElement('em', '', '源文件已变化'));
      list.append(row);
    });
    segmentsPanel.append(timelines, list);
  } else {
    segmentsPanel.append(createElement('p', 'segment-empty-hint', '暂无精彩片段；没有片段时，影片卡片将使用图片轮播预览'));
  }

  const reveal = () => {
    section.dispatchEvent(new CustomEvent('playback:reveal', { bubbles: true }));
    section.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
  return {
    section,
    segmentsPanel,
    canSeek: parts.length > 0,
    activate() {
      if (!parts.length || state.playback?.video === video) return;
      resetSubtitlePicker(subtitleSelect);
    },
    playPart(partId) {
      reveal();
      void playOriginal(partId);
    },
    seek(deltaSeconds) {
      seekVideoBy(video, deltaSeconds);
    },
  };
}

async function startAdaptivePlayback(video, status, input, subtitleSelect = null, options = {}) {
  releaseActivePlayback();
  if (subtitleSelect) resetSubtitlePicker(subtitleSelect);
  video.controls = options.controls !== false;
  state.playback = {
    video,
    hls: null,
    sessionId: null,
    lastProgressAt: 0,
    statusTimer: null,
    mediaReady: false,
    hlsUrl: null,
    resumePositionSeconds: 0,
    completionReloadAttempts: 0,
    completionReloadInProgress: false,
  };
  video.muted = options.muted === true;
  status.textContent = '正在检测视频并准备播放…';
  try {
    const session = await client.createPlaybackSession(input);
    if (state.playback?.video !== video) {
      void client.cancelPlaybackSession(session.id).catch(() => undefined);
      return null;
    }
    state.playback.sessionId = session.id;
    state.playback.resumePositionSeconds = session.playbackPositionSeconds;
    status.textContent = playbackDescription(session);
    if (input.purpose !== 'segment-preview') {
      attachSubtitleTracks(video, session.subtitleTracks);
      if (subtitleSelect) {
        configureSubtitlePicker(subtitleSelect, session.subtitleTracks);
        selectSubtitleTrack(video, subtitleSelect.value);
      }
    }
    if (session.transport === 'direct') {
      video.src = session.url;
      video.load();
    } else {
      state.playback.hlsUrl = session.url;
      pollPlaybackSession(session.id, status);
      try {
        await attachHls(video, session.url, status);
      } catch {
        if (state.playback?.sessionId !== session.id) return null;
        status.textContent = '首次播放流尚未就绪，转码完成后会自动重新载入播放器…';
        return null;
      }
    }
    const initialPosition = input.purpose === 'segment-preview' && session.transport === 'direct'
      ? session.sourceStartSeconds
      : session.playbackPositionSeconds;
    const resumed = await applyPlaybackPosition(video, initialPosition);
    if (resumed && input.purpose !== 'segment-preview') status.textContent = `${playbackDescription(session)} · 从 ${formatPlaybackTime(session.playbackPositionSeconds)} 继续`;
    if (state.playback?.video !== video) return null;
    await video.play().catch(() => undefined);
    return session;
  } catch (error) {
    status.textContent = errorMessage(error);
    return null;
  }
}

function attachHls(video, url, status) {
  if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = url;
    video.load();
    return Promise.resolve();
  }
  const HlsConstructor = window.Hls;
  if (!HlsConstructor?.isSupported()) throw new Error('当前浏览器不支持 HLS/MSE 播放');
  return new Promise((resolve, reject) => {
    const hls = new HlsConstructor({ enableWorker: true, lowLatencyMode: false });
    let recoveryAttempts = 0;
    let settled = false;
    state.playback.hls = hls;
    hls.on(HlsConstructor.Events.MEDIA_ATTACHED, () => hls.loadSource(url));
    hls.on(HlsConstructor.Events.MANIFEST_PARSED, () => {
      settled = true;
      resolve();
    });
    hls.on(HlsConstructor.Events.ERROR, (_event, data) => {
      if (!data.fatal) return;
      if (recoveryAttempts < 2 && data.type === HlsConstructor.ErrorTypes?.NETWORK_ERROR) {
        recoveryAttempts += 1;
        status.textContent = '首个转码分片尚未就绪，正在重新连接…';
        window.setTimeout(() => hls.startLoad(), 350 * recoveryAttempts);
        return;
      }
      if (recoveryAttempts < 2 && data.type === HlsConstructor.ErrorTypes?.MEDIA_ERROR) {
        recoveryAttempts += 1;
        status.textContent = '播放器正在恢复媒体解码…';
        hls.recoverMediaError();
        return;
      }
      status.textContent = `HLS 播放失败：${data.details || data.type || '未知错误'}`;
      if (!settled) reject(new Error(status.textContent));
    });
    hls.attachMedia(video);
  });
}

function playbackDescription(session) {
  let mode = '原文件直放';
  if (session.mode === 'remux') mode = '实时 Remux（音视频直拷）';
  else if (session.videoMode === 'copy' && session.audioMode === 'transcode') mode = '仅转换音频（视频直拷）';
  else if (session.videoMode === 'transcode' && session.videoDecoder === 'cuda') mode = 'NVIDIA 全硬件转码（CUDA 解码与缩放）';
  else if (session.videoMode === 'transcode' && session.videoEncoder === 'h264_nvenc') mode = 'NVIDIA 硬件编码（CPU 解码）';
  else if (session.videoMode === 'transcode' && session.videoEncoder === 'cached') mode = '读取已缓存转码';
  else if (session.videoMode === 'transcode') mode = 'CPU 软件转码';
  const codecs = [session.videoCodec, session.audioCodec].filter(Boolean).join(' / ');
  const subtitles = session.subtitleTracks?.filter((track) => track.supported).length || 0;
  const processing = session.transport === 'hls' && session.processPercent !== null && session.processPercent < 100
    ? ` · 处理 ${session.processPercent}%`
    : '';
  return `${mode}${codecs ? ` · ${codecs}` : ''}${subtitles ? ` · ${subtitles} 条字幕` : ''}${processing}`;
}

function attachSubtitleTracks(video, tracks = []) {
  for (const existing of video.querySelectorAll('track')) existing.remove();
  for (const [index, item] of tracks.filter((track) => track.supported).entries()) {
    const track = document.createElement('track');
    track.kind = 'subtitles';
    track.src = item.url;
    track.srclang = item.language || 'und';
    track.label = item.title || [item.language, item.codec].filter(Boolean).join(' · ') || `字幕 ${item.index}`;
    track.dataset.streamIndex = String(item.index);
    track.default = index === 0;
    video.append(track);
  }
}

function resetSubtitlePicker(select) {
  select.replaceChildren(new Option('关闭字幕', ''));
  select.value = '';
  select.disabled = true;
}

function configureSubtitlePicker(select, tracks = []) {
  const supported = tracks.filter((track) => track.supported);
  select.replaceChildren(new Option('关闭字幕', ''));
  for (const item of supported) {
    const label = item.title || [item.language, item.codec].filter(Boolean).join(' · ') || `字幕 ${item.index}`;
    select.append(new Option(label, String(item.index)));
  }
  select.value = supported.length ? String(supported[0].index) : '';
  select.disabled = supported.length === 0;
}

function selectSubtitleTrack(video, streamIndex) {
  for (const track of video.querySelectorAll('track')) {
    track.track.mode = track.dataset.streamIndex === streamIndex ? 'showing' : 'disabled';
  }
}

function seekVideoBy(video, deltaSeconds) {
  if (!Number.isFinite(video.currentTime)) return;
  let target = Math.max(0, video.currentTime + deltaSeconds);
  if (Number.isFinite(video.duration)) {
    target = Math.min(video.duration, target);
  } else if (video.seekable.length) {
    target = Math.min(video.seekable.end(video.seekable.length - 1), target);
  }
  try {
    video.currentTime = target;
  } catch {
    // The media element remains authoritative while an HLS stream is preparing.
  }
}

function configuredSeekStepSeconds() {
  const value = Number(state.server?.detailPlayerSeekStepSeconds);
  return Number.isInteger(value) && value >= 1 && value <= 60 ? value : 1;
}

function configuredHoverCloseDelayMs() {
  const value = Number(state.server?.hoverCloseDelayMs);
  return Number.isInteger(value) && value >= 0 && value <= 5000 ? value : 180;
}

function configuredFineSeekStepSeconds() {
  const value = Number(state.server?.detailPlayerFineSeekStepSeconds);
  return Number.isFinite(value) && value >= 0.01 && value <= 5 ? value : 0.1;
}

async function applyPlaybackPosition(video, positionSeconds) {
  if (!Number.isFinite(positionSeconds) || positionSeconds <= 0) return false;
  if (video.readyState < 1) {
    await new Promise((resolve) => {
      const done = () => {
        window.clearTimeout(timer);
        video.removeEventListener('loadedmetadata', done);
        video.removeEventListener('error', done);
        resolve();
      };
      const timer = window.setTimeout(done, 5000);
      video.addEventListener('loadedmetadata', done, { once: true });
      video.addEventListener('error', done, { once: true });
    });
  }
  if (video.readyState < 1) return false;
  const upperBound = Number.isFinite(video.duration) && video.duration > 0
    ? Math.max(0, video.duration - 0.25)
    : positionSeconds;
  const target = Math.min(positionSeconds, upperBound);
  if (!(target > 0)) return false;
  video.currentTime = target;
  return true;
}

function formatPlaybackTime(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainder = total % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
    : `${minutes}:${String(remainder).padStart(2, '0')}`;
}

function pollPlaybackSession(sessionId, status) {
  const active = state.playback;
  if (!active || active.sessionId !== sessionId) return;
  if (active.statusTimer) window.clearTimeout(active.statusTimer);
  active.statusTimer = window.setTimeout(async () => {
    try {
      const session = await client.playbackSession(sessionId);
      if (state.playback?.sessionId !== sessionId) return;
      status.textContent = playbackDescription(session);
      if (session.state === 'complete' && !state.playback.mediaReady) {
        await ensureCompletedHlsPlayback(sessionId, status);
      }
      const activeAfterCheck = state.playback;
      const shouldContinue = session.state !== 'error'
        && session.state !== 'cancelled'
        && (
          session.state !== 'complete'
          || (
            activeAfterCheck?.sessionId === sessionId
            && !activeAfterCheck.mediaReady
            && activeAfterCheck.completionReloadAttempts < 3
          )
        );
      if (shouldContinue) {
        pollPlaybackSession(sessionId, status);
      }
    } catch {
      // Playback itself remains authoritative if a diagnostic poll is interrupted.
    }
  }, 2000);
}

async function ensureCompletedHlsPlayback(sessionId, status) {
  const active = state.playback;
  if (
    !active
    || active.sessionId !== sessionId
    || active.mediaReady
    || !active.hlsUrl
    || active.completionReloadInProgress
    || active.completionReloadAttempts >= 3
  ) {
    return;
  }
  active.completionReloadInProgress = true;
  active.completionReloadAttempts += 1;
  status.textContent = `转码已完成，正在重新载入播放器（${active.completionReloadAttempts}/3）…`;
  try {
    active.hls?.destroy();
    active.hls = null;
    active.video.pause();
    active.video.removeAttribute('src');
    active.video.load();
    await attachHls(active.video, active.hlsUrl, status);
    await applyPlaybackPosition(active.video, active.resumePositionSeconds);
    if (state.playback?.sessionId !== sessionId) return;
    active.mediaReady = active.video.readyState >= 1;
    await active.video.play().catch(() => undefined);
    status.textContent = active.mediaReady
      ? '转码完成，播放器已就绪'
      : '转码完成，播放器仍在载入媒体…';
  } catch (error) {
    if (state.playback?.sessionId === sessionId) status.textContent = errorMessage(error);
  } finally {
    if (state.playback?.sessionId === sessionId) active.completionReloadInProgress = false;
  }
}

function releaseActivePlayback() {
  const active = state.playback;
  if (!active) return;
  const positionSeconds = active.video.currentTime;
  const durationSeconds = active.video.duration;
  state.playback = null;
  if (active.statusTimer) window.clearTimeout(active.statusTimer);
  active.hls?.destroy();
  active.video.pause();
  for (const track of active.video.querySelectorAll('track')) track.remove();
  active.video.removeAttribute('src');
  active.video.load();
  if (active.sessionId) {
    const save = Number.isFinite(positionSeconds) && positionSeconds > 0
      ? client.updatePlaybackProgress(active.sessionId, {
          positionSeconds,
          ...(Number.isFinite(durationSeconds) ? { durationSeconds } : {}),
        }).catch(() => undefined)
      : Promise.resolve();
    void save.finally(() => client.cancelPlaybackSession(active.sessionId).catch(() => undefined));
  }
}

async function updateDetail(id, operation, message) {
  try {
    await operation();
    toast(message);
    renderDetail(await client.film(id));
    await reloadLibrary();
  } catch (error) {
    showError(error);
  }
}

async function importNfo(id, mode) {
  if (mode === 'force-replace' && !window.confirm('强制替换会覆盖该影片在 SQLite 中的可替换元数据。外部 NFO 不会被修改。确认继续？')) return;
  await updateDetail(id, () => client.importNfo(id, mode), 'NFO 已读取并导入 SQLite');
}

async function chooseNfoImport(id) {
  if (window.confirm('确定后会合并导入 NFO；选择取消可继续决定是否替换导入。我的分类、收藏和外部 NFO 均不受影响。')) {
    await importNfo(id, 'force-merge');
    return;
  }
  if (window.confirm('是否改为替换导入 NFO 数据？这会覆盖 SQLite 中可替换的元数据，但不会写回外部 NFO。')) {
    await importNfo(id, 'force-replace');
  }
}

async function createCategory() {
  const name = window.prompt('新分类名称');
  if (!name?.trim()) return;
  await runAdminAction(() => client.createCategory(name), '分类已创建');
  await reloadLibrary();
}

async function renameCategory(id) {
  const existing = state.filters.categories.find((item) => item.id === id);
  const name = window.prompt('新的分类名称', existing?.name || '');
  if (!name?.trim()) return;
  await runAdminAction(() => client.renameCategory(id, name), '分类已重命名');
  await reloadLibrary();
}

async function deleteCategory(id) {
  const existing = state.filters.categories.find((item) => item.id === id);
  if (!window.confirm(`删除分类“${existing?.name || ''}”？只删除分类关联，不删除影片。`)) return;
  await runAdminAction(() => client.removeCategory(id), '分类已删除');
  elements.category.value = '';
  await reloadLibrary();
}

async function runAdminAction(operation, message) {
  hideError();
  try {
    await operation();
    toast(message);
  } catch (error) {
    showError(error);
  }
}

async function completeLogin() {
  elements.loginError.hidden = true;
  try {
    const username = elements.accountUsername.value.trim();
    await client.login(username, elements.accountPassword.value);
    localStorage.setItem('film-library-web-username', username);
    elements.accountPassword.value = '';
    elements.loginDialog.close();
    await initializeLibrary();
  } catch (error) {
    elements.loginError.hidden = false;
    elements.loginError.textContent = errorMessage(error);
  }
}

async function revokeDevice() {
  try { await client.logout(); } catch { /* Expired and logged out have the same local outcome. */ }
  showLogin();
}

function showLogin() {
  if (!elements.loginDialog.open) elements.loginDialog.showModal();
  window.setTimeout(() => (elements.accountUsername.value ? elements.accountPassword : elements.accountUsername).focus(), 0);
}

function isAuthenticationError(error) {
  return error && typeof error === 'object' && (error.status === 401 || error.code === 'UNAUTHORIZED');
}

function field(labelText, type, value) {
  const label = document.createElement('label');
  const caption = createElement('span', '', labelText);
  const input = type === 'textarea' ? document.createElement('textarea') : document.createElement('input');
  if (type !== 'textarea') input.type = type;
  input.value = value;
  label.append(caption, input);
  return { label, input };
}

function actionButton(text, listener, className = '') {
  const button = createElement('button', className, text);
  button.type = 'button';
  button.addEventListener('click', listener);
  return button;
}

function addFact(list, label, value) {
  list.append(createElement('dt', '', label), createElement('dd', '', value));
}

function fillSelect(select, items, valueOf, labelOf, reset = false) {
  const previous = select.value;
  if (reset) while (select.options.length > 1) select.remove(1);
  for (const item of items) {
    const option = document.createElement('option');
    option.value = valueOf(item);
    option.textContent = labelOf(item);
    select.append(option);
  }
  if ([...select.options].some((option) => option.value === previous)) select.value = previous;
}

function countLabel(item) {
  return `${item.name} (${item.filmCount || 0})`;
}

function createElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function camel(value) {
  return value.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
}

function setBusy(busy) {
  elements.refresh.disabled = busy;
  elements.filmGrid.setAttribute('aria-busy', String(busy));
}

function toast(message) {
  elements.resultSummary.textContent = message;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : '操作失败';
}

function showError(error) {
  elements.error.hidden = false;
  elements.error.textContent = errorMessage(error);
}

function hideError() {
  elements.error.hidden = true;
  elements.error.textContent = '';
}
