import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const drawerPath = path.resolve(process.cwd(), 'src/renderer/components/film/FilmDetailDrawer.vue');
const segmentEditorPath = path.resolve(process.cwd(), 'src/renderer/components/film/FilmSegmentEditor.vue');
const detailPlayerPath = path.resolve(process.cwd(), 'src/renderer/components/film/FilmDetailPlayer.vue');
const cardPath = path.resolve(process.cwd(), 'src/renderer/components/film/FilmCard.vue');
const tablePath = path.resolve(process.cwd(), 'src/renderer/components/film/FilmTable.vue');
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
const themePath = path.resolve(process.cwd(), 'src/renderer/styles/theme.css');
const rendererIndexPath = path.resolve(process.cwd(), 'src/renderer/index.html');
const resonancePath = path.resolve(process.cwd(), 'src/renderer/components/resonance/ResonanceBall.vue');

describe('renderer regressions', () => {
  const drawer = fs.readFileSync(drawerPath, 'utf8');

  it('shows image thumbnails and opens a navigable full-size image dialog', () => {
    expect(drawer).toContain('image-thumbnail-grid');
    expect(drawer).toContain('imageViewerVisible');
    expect(drawer).toContain('class="image-viewer-dialog"');
    expect(drawer).toContain('width="96vw"');
    expect(drawer).toContain('@click="previousImage"');
    expect(drawer).toContain('@click="nextImage"');
    expect(drawer).toContain('object-fit: contain');
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

  it('keeps poster, favorite and categories in the left detail sidebar', () => {
    const header = fs.readFileSync(headerPath, 'utf8');
    expect(drawer).toContain('<FilmDetailHeader');
    expect(header).toContain('position: relative');
    expect(header).toContain('flex-wrap: wrap');
    expect(header).toContain("favorite ? '已收藏' : '收藏'");
    expect(header).toContain('v-for="item in categories"');
    expect(header).toContain('aspect-ratio: 2 / 3');
    expect(drawer).toContain('grid-template-columns: minmax(240px, 1fr) minmax(0, 3fr)');
    expect(drawer).toContain('overflow: hidden');
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

  it('uses annotated segments for hover preview and falls back to images', () => {
    const card = fs.readFileSync(cardPath, 'utf8');
    const popup = fs.readFileSync(popupPath, 'utf8');
    expect(card).not.toContain('<video');
    expect(card).not.toContain('transform: scale');
    expect(card).toContain('createHoverPopupController');
    expect(popup).toContain('<Teleport to="body">');
    expect(popup).toContain('position: fixed');
    expect(popup).toContain('aspect-ratio: 16 / 9');
    expect(popup).toContain(":class=\"{ 'popup-media-image': mode !== 'video' }\"");
    expect(popup).toContain('aspect-ratio: 800 / 537');
    expect(popup).toContain('.popup-media-image img');
    expect(popup).toContain('object-fit: cover');
    expect(popup).toContain('object-fit: contain');
    expect(popup).toContain('class="preview-pagination" aria-label="预览图片切换"');
    expect(popup).toContain('class="preview-pagination" aria-label="预览片段切换"');
    expect(popup).toContain('@click.stop="selectImage(index)"');
    expect(popup).toContain('@click.stop="selectHighlight(index)"');
    expect(popup).toContain('scheduleSlideshow()');
    expect(popup).toContain('highlightPlaybackGeneration');
    expect(popup).toContain('.preview-dot.active');
    expect(popup).toContain('claimPreview');
    expect(popup).toContain('releasePreview');
    expect(popup).toContain("mediaUrl('part', segment.filmFileId)");
    expect(popup).not.toContain("mediaUrl('preview'");
    expect(popup).not.toContain('props.film.allowOriginalPreview');
    expect(popup).toContain('segment-preview-label');
    expect(popup).toContain('activeHighlight.title');
    expect(popup).toContain('正在准备视频预览');
    expect(popup).toContain('window.filmLibrary.films.showInFolder(props.film.id)');
    expect(popup).toContain('打开文件位置');
    expect(popup).toContain('flex-wrap: wrap');
    expect(popup).toMatch(/<video v-if="mode === 'video'"[\s\S]*?<img v-else-if="mode === 'slideshow'[\s\S]*?<div v-else class="popup-empty">暂无预览<\/div>[\s\S]*?<div v-if="mode === 'video' && videoPreparing"/);
  });

  it('uses a full-width detail workbench and exposes segment titles on timeline nodes', () => {
    const segmentEditor = fs.readFileSync(segmentEditorPath, 'utf8');
    const detailPlayer = fs.readFileSync(detailPlayerPath, 'utf8');
    const preload = fs.readFileSync(preloadPath, 'utf8');
    expect(drawer).toContain('size="100vw"');
    expect(drawer).toContain('tab-position="right"');
    expect(drawer).toContain('grid-template-rows: minmax(0, 1fr) 128px');
    expect(drawer).toContain('.el-drawer__header) { height: 34px');
    expect(drawer).not.toContain('label="预览视频"');
    expect(detailPlayer).toContain(':title="`${segment.title');
    expect(detailPlayer).toContain('aspect-ratio: 16 / 9');
    expect(detailPlayer).toContain('element?.videoWidth');
    expect(detailPlayer).toContain('element?.videoHeight');
    expect(detailPlayer).toContain('Math.min(availableWidth, availableHeight * (16 / 9))');
    expect(detailPlayer).toContain('Math.min(stageWidth / videoWidth, stageHeight / videoHeight)');
    expect(detailPlayer).toContain('ref="stageSlot" class="player-stage-slot"');
    expect(detailPlayer).toContain(':style="stageSize"');
    expect(detailPlayer).toContain(':style="fittedSize"');
    expect(drawer).toContain('<FilmDetailPlayer');
    expect(segmentEditor).not.toContain('<video');
    expect(segmentEditor).not.toContain('placeholder="批注');
    expect(segmentEditor).not.toContain('<small v-if="segment.comment"');
    expect((detailPlayer.match(/<video/g) || [])).toHaveLength(1);
    expect(segmentEditor).not.toContain('连续播放精彩片段');
    expect(segmentEditor).not.toContain('空格播放/暂停');
    expect(segmentEditor).not.toContain('@click="edit(segment)"');
    expect(segmentEditor).toContain('grid-template-columns: repeat(2, minmax(0, 1fr))');
    expect(segmentEditor).toContain('formatTime(segment.endSeconds - segment.startSeconds)');
    expect(drawer).toContain('<aside class="detail-sidebar">');
    expect(drawer).toContain("const activeSidebarSections = ref<string[]>([])");
    expect(drawer).toContain('<el-collapse-item title="基本信息" name="basic">');
    expect(drawer).toContain('<el-collapse-item title="详细信息" name="details">');
    expect(drawer).not.toContain('<el-tab-pane label="基本信息"');
    expect(drawer).not.toContain('<el-tab-pane label="详细信息"');
    expect(segmentEditor).toContain('defineExpose({ markStart, markEnd })');
    expect(detailPlayer).toContain('playbackGeneration += 1');
    expect(detailPlayer).toContain('defineExpose({ playSegment, playPreview, playOriginal, selectPart, seekRelative, togglePlayback, stopPlayback, getPlaybackSnapshot })');
    expect(detailPlayer).toContain('window.filmLibrary.films.subtitleTracks(partId)');
    expect(detailPlayer).toContain('window.filmLibrary.films.subtitleContent(partId, Number(index))');
    expect(detailPlayer).toMatch(/watch\(selectedPartId,[\s\S]*?\}, \{ immediate: true \}\);/);
    expect(detailPlayer).toContain("v-if=\"source\"");
    expect(detailPlayer).toContain("'无可用字幕'");
    expect(detailPlayer).toContain('<track');
    expect(detailPlayer).toContain('.detail-player-video::cue');
    expect(detailPlayer).toContain('font-size: 55%');
    expect(preload).toContain('IPC_CHANNELS.playbackSubtitleTracks');
    expect(preload).toContain('IPC_CHANNELS.playbackSubtitleContent');
    expect(fs.readFileSync(rendererIndexPath, 'utf8')).toContain("media-src 'self' blob: film-media:");
    expect(drawer).toContain('detailPlayer.value?.stopPlayback()');
    expect(drawer).toContain('segmentEditor.value?.markStart()');
    expect(drawer).toContain('segmentEditor.value?.markEnd()');
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
    expect(header).toContain('使用本地播放器播放');
    expect(header).toContain("emit('localPlayer')");
    expect(drawer).toContain('@local-player="playWithLocalPlayer"');
    expect(drawer).toContain('window.filmLibrary.films.partsOpen(part.id)');
    expect(drawer).toContain('window.filmLibrary.films.open(detail.value.id)');
    expect(drawer).toContain('detailPlayer.value?.stopPlayback()');
    expect(drawer).toContain('window.filmLibrary.films.rescan(detail.value.id)');
    expect(drawer).toContain('rescanJobId');
    expect(sources).toContain('重新扫描此来源');
    expect(sources).toContain('scan.start([source.id])');
    expect(sources).toContain('CircleCloseFilled');
    expect(sources).toContain('EditPen');
    expect(sources).toContain('class="source-edit-button"');
    expect(sources).toContain('aria-label="编辑来源"');
    expect(sources).toContain('.source-edit-button :deep(svg) { width: 17px; height: 17px;');
    expect(sources).toContain('class="source-delete-button"');
    expect(sources).toContain('aria-label="删除来源"');
    expect(sources).toContain('.source-delete-button :deep(svg) { width: 17px; height: 17px;');
    expect(sources).not.toContain('<Delete />');
    expect(sources).not.toContain('<Edit />');
    expect(sources).not.toContain('原片预览');
    expect(sources).not.toContain('updateOriginalPreview');
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

  it('keeps the all-data toolbar focused on data status', () => {
    const library = fs.readFileSync(libraryPath, 'utf8');
    const table = fs.readFileSync(tablePath, 'utf8');
    expect(library).toContain('library.filters.availability');
    expect(library).not.toContain('library.filters.recordIssue');
    expect(library).not.toContain('library.filters.playbackCompatibility');
    expect(library).toContain('<el-radio-group v-if="!allData"');
    expect(library).not.toContain('label="已归档" value="archived"');
    expect(table).not.toContain('label="评分"');
    expect(table).not.toContain('row.rating');
    expect(table).toContain('label="操作" width="96"');
    expect(library).not.toContain('自动标题与单文件名不一致');
    expect(library).not.toContain('非原生播放');
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
    expect(desktopIntegration).toContain('window.setSkipTaskbar(true)');
    expect(desktopIntegration).toContain('window.setSkipTaskbar(false)');
    expect(desktopIntegration).toContain('window.setEnabled(true)');
    expect(desktopIntegration).toContain('window.setIgnoreMouseEvents(false)');
    expect(desktopIntegration).toContain('window.setFocusable(true)');
    expect(desktopIntegration).toContain('window.moveTop()');
    expect(desktopIntegration).toContain('window.webContents.focus()');
    expect(desktopIntegration).toContain('TRAY_ICON_PNG_BASE64');
    expect(desktopIntegration).toContain('nativeImage.createFromBuffer');
    expect(desktopIntegration).toContain('sourceIcon.isEmpty() || icon.isEmpty()');
    expect(desktopIntegration).not.toContain('data:image/svg+xml');
    expect(desktopIntegration).toContain('new Tray(icon)');
    expect(main).toContain('app.requestSingleInstanceLock()');
    expect(main).toContain('desktopIntegration.shouldStartHidden()');
    expect(mainWindow).toContain('options.showOnReady !== false');
  });

  it('keeps the desktop sidebar fixed while only the main area scrolls', () => {
    const theme = fs.readFileSync(themePath, 'utf8');
    expect(theme).toContain('.app-shell { height: 100vh; min-height: 0; overflow: hidden;');
    expect(theme).toContain('.app-sidebar { position: relative; display: flex; height: 100vh;');
    expect(theme).toContain('.app-main { height: 100vh; min-width: 0; padding: 0; overflow-x: hidden; overflow-y: auto;');
  });

  it('shows the package version at the top and removes the local-only footer', () => {
    const layout = fs.readFileSync(layoutPath, 'utf8');
    const mainWindow = fs.readFileSync(mainWindowPath, 'utf8');
    const theme = fs.readFileSync(themePath, 'utf8');
    expect(layout).toContain('window.filmLibrary.app.info()');
    expect(layout).toContain('class="brand-version"');
    expect(layout).not.toContain('100% 本地运行');
    expect(layout).not.toContain('sidebar-footer');
    expect(theme).not.toContain('.sidebar-footer');
    expect(mainWindow).toContain('title: `Local Film Library v${app.getVersion()}`');
  });

  it('keeps every resonance video fully visible without cropping', () => {
    const resonance = fs.readFileSync(resonancePath, 'utf8');
    expect(resonance).toContain('object-fit: contain; background: #000;');
    expect(resonance).not.toContain('object-fit: cover;');
  });

  it('does not render or bundle a QR code in LAN web access settings', () => {
    const settings = fs.readFileSync(settingsPath, 'utf8');
    expect(settings).not.toContain("from 'qrcode'");
    expect(settings).not.toContain('qrDataUrl');
    expect(settings).not.toContain('lan-qr');
  });
});
