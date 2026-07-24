import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const drawerPath = path.resolve(process.cwd(), 'src/renderer/components/film/FilmDetailDrawer.vue');
const cardPath = path.resolve(process.cwd(), 'src/renderer/components/film/FilmCard.vue');
const popupPath = path.resolve(process.cwd(), 'src/renderer/components/film/FilmHoverPopup.vue');
const headerPath = path.resolve(process.cwd(), 'src/renderer/components/film/FilmDetailHeader.vue');
const preloadPath = path.resolve(process.cwd(), 'src/preload/api.ts');
const categoriesPath = path.resolve(process.cwd(), 'src/renderer/views/CategoriesView.vue');
const actorsPath = path.resolve(process.cwd(), 'src/renderer/views/ActorsView.vue');
const libraryPath = path.resolve(process.cwd(), 'src/renderer/views/LibraryView.vue');
const layoutPath = path.resolve(process.cwd(), 'src/renderer/layouts/AppLayout.vue');
const sourcesPath = path.resolve(process.cwd(), 'src/renderer/views/SourcesView.vue');
const mainPath = path.resolve(process.cwd(), 'src/main/index.ts');
const mainWindowPath = path.resolve(process.cwd(), 'src/main/window/createMainWindow.ts');
const settingsPath = path.resolve(process.cwd(), 'src/renderer/views/SettingsView.vue');
const desktopIntegrationPath = path.resolve(process.cwd(), 'src/main/system/DesktopIntegrationService.ts');

describe('renderer regressions', () => {
  const drawer = fs.readFileSync(drawerPath, 'utf8');

  it('keeps the thumbnail strip synchronized with the active image', () => {
    expect(drawer).toContain('thumbnailStripRef');
    expect(drawer).toContain('scrollIntoView');
    expect(drawer).toContain('fullscreenchange');
    expect(drawer).toContain('overflow-y: hidden');
  });

  it('renders every selected category and uses the serialized auto-save queue', () => {
    expect(drawer).not.toContain('collapse-tags');
    expect(drawer).not.toContain('max-collapse-tags');
    expect(drawer).not.toContain('保存修改');
    expect(drawer).toContain('pendingSave');
    expect(drawer).toContain('hydrated');
    expect(drawer).toContain('updatePatch');
    expect(drawer).toContain('saveStateLabel');
    expect(drawer).toContain('updateFavorite');
    expect(drawer).toContain('updateCategories');
  });

  it('keeps favorite and all custom categories in a sticky, wrapping detail header', () => {
    const header = fs.readFileSync(headerPath, 'utf8');
    expect(drawer).toContain('<FilmDetailHeader');
    expect(header).toContain('position: sticky');
    expect(header).toContain('top: 0');
    expect(header).toContain('flex-wrap: wrap');
    expect(header).toContain("favorite ? '已收藏' : '收藏'");
    expect(header).not.toContain('+N');
  });

  it('shows NFO tags as read-only and does not expose tag mutation APIs', () => {
    const preload = fs.readFileSync(preloadPath, 'utf8');
    expect(drawer).toContain('detail.nfoTags');
    expect(drawer).toContain('来自 NFO，只读');
    expect(drawer).not.toContain('removeTag');
    expect(drawer).not.toContain('allow-create default-first-option clearable placeholder="搜索或添加标签"');
    expect(preload).not.toContain('tagsCreate');
    expect(preload).not.toContain('tagsUpdate');
    expect(preload).not.toContain('tagsRemove');
  });

  it('removes legacy film status and genre controls from cards and details', () => {
    const card = fs.readFileSync(cardPath, 'utf8');
    expect(drawer).not.toContain('form.status');
    expect(drawer).not.toContain('detail.genres');
    expect(drawer).not.toContain('保存修改');
    expect(card).not.toContain('statusLabel');
  });

  it('shows complete category names and explicit rename/delete icons', () => {
    const categories = fs.readFileSync(categoriesPath, 'utf8');
    expect(categories).toContain('overflow-wrap: anywhere');
    expect(categories).toContain('white-space: normal');
    expect(categories).toContain(':icon="Edit"');
    expect(categories).toContain(':icon="Delete"');
    expect(categories).toContain('>重命名</el-button>');
    expect(categories).toContain('>删除</el-button>');
  });

  it('requires an explicit merge-or-replace choice for forced NFO import', () => {
    expect(drawer).toContain('chooseForceImport');
    expect(drawer).toContain('force-merge');
    expect(drawer).toContain('force-replace');
    expect(drawer).toContain('合并导入');
    expect(drawer).toContain('替换导入');
    expect(drawer).not.toContain("importNfo('force')");
  });

  it('keeps preview media out of the card and delegates it to a fixed Teleport popup', () => {
    const card = fs.readFileSync(cardPath, 'utf8');
    const popup = fs.readFileSync(popupPath, 'utf8');
    expect(card).not.toContain('<video');
    expect(card).not.toContain('transform: scale');
    expect(card).toContain('createHoverPopupController');
    expect(popup).toContain('<Teleport to="body">');
    expect(popup).toContain('position: fixed');
    expect(popup).toContain('aspect-ratio: 16 / 9');
    expect(popup).toContain('object-fit: contain');
    expect(popup).toContain('claimPreview');
    expect(popup).toContain('releasePreview');
    expect(popup).toContain("mediaUrl('preview', props.film.id)");
    expect(popup).toContain('props.film.allowOriginalPreview');
    expect(popup).toContain('正在准备视频预览');
    expect(popup).toMatch(/<video v-if="mode === 'video'"[\s\S]*?<img v-else-if="mode === 'slideshow'[\s\S]*?<div v-else class="popup-empty">暂无预览<\/div>[\s\S]*?<div v-if="mode === 'video' && videoPreparing"/);
  });

  it('lists NFO actors and routes an actor click to the library filter', () => {
    const actors = fs.readFileSync(actorsPath, 'utf8');
    const layout = fs.readFileSync(layoutPath, 'utf8');
    const library = fs.readFileSync(libraryPath, 'utf8');
    const preload = fs.readFileSync(preloadPath, 'utf8');
    expect(layout).toContain('index="/actors"');
    expect(actors).toContain('window.filmLibrary.actors.list()');
    expect(actors).toContain("query: { actor: actor.name }");
    expect(library).toContain('placeholder="NFO 演员"');
    expect(library).toContain('library.filters.actor');
    expect(preload).toContain('invoke(IPC_CHANNELS.actorsList)');
  });

  it('shows actor film counts in the NFO summary and makes every actor filterable', () => {
    expect(drawer).toContain('window.filmLibrary.actors.list()');
    expect(drawer).toContain('actorCount(actor)');
    expect(drawer).toContain('@click="filterByActor(actor)"');
    expect(drawer).toContain("router.push({ path: '/library', query: { actor: name } })");
    expect(drawer).not.toContain('detail.actors.slice(0, 5)');
  });

  it('exposes explicit film-directory and per-source rescan controls', () => {
    const header = fs.readFileSync(headerPath, 'utf8');
    const sources = fs.readFileSync(sourcesPath, 'utf8');
    expect(header).toContain('重新扫描目录');
    expect(header).toContain("emit('rescan')");
    expect(drawer).toContain('window.filmLibrary.films.rescan(detail.value.id)');
    expect(drawer).toContain('rescanJobId');
    expect(sources).toContain('重新扫描此来源');
    expect(sources).toContain('scan.start([source.id])');
    expect(sources).toContain('原片预览');
    expect(sources).toContain('allowOriginalPreview');
    expect(sources).toContain('updateOriginalPreview');
  });

  it('exports the current organized or favorite page through the desktop CSV API', () => {
    const library = fs.readFileSync(libraryPath, 'utf8');
    const preload = fs.readFileSync(preloadPath, 'utf8');
    expect(library).toContain('导出 CSV');
    expect(library).toContain("const favoritePage = computed(() => route.query.favorite === '1')");
    expect(library).toContain('const exportPage = computed(() => organizedPage.value || favoritePage.value)');
    expect(library).toContain("organizationState: favoritePage.value ? 'all' as const : 'organized' as const");
    expect(library).toContain('favoriteOnly: favoritePage.value');
    expect(library).toContain('window.filmLibrary.films.exportCsv(query)');
    expect(preload).toContain('invoke(IPC_CHANNELS.filmsExportCsv, query)');
  });

  it('filters automatic single-file title mismatches on the all-data page', () => {
    const library = fs.readFileSync(libraryPath, 'utf8');
    expect(library).toContain('library.filters.recordIssue');
    expect(library).toContain('自动标题与单文件名不一致');
    expect(library).toContain('非 CD 多文件错误合并');
    expect(library).toContain('value="invalid-multipart"');
  });

  it('isolates development Chromium cache and uses the current console-message event shape', () => {
    const main = fs.readFileSync(mainPath, 'utf8');
    const mainWindow = fs.readFileSync(mainWindowPath, 'utf8');
    expect(main).toContain("if (!app.isPackaged)");
    expect(main).toContain("app.setPath('sessionData', developmentSessionDataPath)");
    expect(mainWindow).toContain("window.webContents.on('console-message', (details) =>");
    expect(mainWindow).toContain('details.lineNumber');
    expect(mainWindow).not.toContain("console-message', (_event, level, message, line, sourceId)");
  });

  it('exposes playback cache usage, location, limit and safe cleanup in settings', () => {
    const settings = fs.readFileSync(settingsPath, 'utf8');
    const preload = fs.readFileSync(preloadPath, 'utf8');
    expect(settings).toContain('网页播放缓存');
    expect(settings).toContain('playbackCacheLimitGb');
    expect(settings).toContain('choosePlaybackCacheDirectory');
    expect(settings).toContain('clearPlaybackCache');
    expect(settings).toContain('不会删除影片原文件');
    expect(preload).toContain('IPC_CHANNELS.playbackCacheInfo');
    expect(preload).toContain('IPC_CHANNELS.playbackCacheClear');
  });

  it('supports Windows login startup, tray-only startup and minimize-to-tray', () => {
    const main = fs.readFileSync(mainPath, 'utf8');
    const mainWindow = fs.readFileSync(mainWindowPath, 'utf8');
    const settings = fs.readFileSync(settingsPath, 'utf8');
    const desktopIntegration = fs.readFileSync(desktopIntegrationPath, 'utf8');
    expect(settings).toContain('开机自启动');
    expect(settings).toContain('开机时仅启动托盘');
    expect(settings).toContain('最小化到托盘');
    expect(desktopIntegration).toContain('app.setLoginItemSettings');
    expect(desktopIntegration).toContain("argumentsList.includes('--hidden')");
    expect(desktopIntegration).toContain("window.on('minimize'");
    expect(desktopIntegration).toContain('new Tray(icon)');
    expect(main).toContain('app.requestSingleInstanceLock()');
    expect(main).toContain('desktopIntegration.shouldStartHidden()');
    expect(mainWindow).toContain('options.showOnReady !== false');
  });
});
