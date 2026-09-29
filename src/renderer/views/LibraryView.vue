<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Download, Refresh, Search, Grid, List, Operation } from '@element-plus/icons-vue';
import type { ActorDto, CustomCategoryDto, FilmSummaryDto, TagDto } from '../../shared/contracts';
import { useLibraryStore } from '../stores/library';
import { useSourceStore } from '../stores/sources';
import { useScanStore } from '../stores/scan';
import FilmGrid from '../components/film/FilmGrid.vue';
import FilmTable from '../components/film/FilmTable.vue';
import FilmDetailDrawer from '../components/film/FilmDetailDrawer.vue';
import { closeAllHoverPopups } from '../composables/hoverPopupManager';

const route = useRoute();
const library = useLibraryStore();
const sources = useSourceStore();
const scan = useScanStore();
const nfoTags = ref<TagDto[]>([]);
const categories = ref<CustomCategoryDto[]>([]);
const actors = ref<ActorDto[]>([]);
const selectedFilmId = ref<string | null>(null);
const detailVisible = ref(false);
const selectedRecordIds = ref<string[]>([]);
const deletingRecords = ref(false);
const exportingCsv = ref(false);
let searchTimer: ReturnType<typeof setTimeout> | null = null;

const allData = computed(() => route.query.all === '1');
const organizedPage = computed(() => route.query.organization === 'organized');
const favoritePage = computed(() => route.query.favorite === '1');
const exportPage = computed(() => organizedPage.value || favoritePage.value);

watch(() => route.query, () => { closeAllHoverPopups(); syncRouteFilter(); void library.fetchPage(); }, { deep: true, immediate: true });
onMounted(async () => {
  await Promise.all([sources.fetch(), library.loadSettings(), loadTaxonomies()]);
  await library.fetchPage();
});
onBeforeUnmount(() => { if (searchTimer) clearTimeout(searchTimer); });

async function loadTaxonomies(): Promise<void> {
  const [tagResult, categoryResult, actorResult] = await Promise.all([
    window.filmLibrary.nfoTags.list(),
    window.filmLibrary.categories.list(),
    window.filmLibrary.actors.list(),
  ]);
  if (tagResult.ok) nfoTags.value = tagResult.data;
  if (categoryResult.ok) categories.value = categoryResult.data;
  if (actorResult.ok) actors.value = actorResult.data;
}

function syncRouteFilter(): void {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = null;
  selectedRecordIds.value = [];
  library.resetPageFilters();
  const query = route.query;
  library.filters.allData = allData.value;
  if (query.organization === 'unorganized' || query.organization === 'organized') library.filters.organizationState = query.organization;
  if (typeof query.category === 'string') library.filters.categoryIds = [query.category];
  if (typeof query.actor === 'string') library.filters.actor = query.actor;
  if (query.favorite === '1') library.filters.favoriteOnly = true;
  if (organizedPage.value) library.filters.sort = 'organized';
  if (favoritePage.value) library.filters.sort = 'favorite';
  if (query.missing === '1') library.filters.missingOnly = true;
}

function queueSearch(): void {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { library.filters.page = 1; void library.fetchPage(); }, 300);
}

function filterChanged(): void { selectedRecordIds.value = []; library.filters.page = 1; void library.fetchPage(); }
function selectFilm(film: FilmSummaryDto): void { selectedFilmId.value = film.id; detailVisible.value = true; }
async function refresh(): Promise<void> {
  await library.fetchPage();
  await sources.fetch();
  await loadTaxonomies();
  window.dispatchEvent(new Event('film-library:changed'));
}
function clearGlobalFilters(): void {
  library.filters.sourceIds = [];
  library.filters.categoryIds = [];
  filterChanged();
}
function toggleSource(id: string): void {
  const selected = library.filters.sourceIds ?? [];
  library.filters.sourceIds = selected.includes(id) ? selected.filter((value) => value !== id) : [...selected, id];
  filterChanged();
}
function clearSourceFilter(): void { library.filters.sourceIds = []; filterChanged(); }
const sourceButtons = computed(() => [
  ...sources.sources.map((source) => ({ id: source.id, name: source.name })),
  ...(library.filters.sourceIds ?? []).filter((id) => !sources.sources.some((source) => source.id === id))
    .map((id) => ({ id, name: '已移除来源' })),
]);
async function exportCsv(): Promise<void> {
  if (exportingCsv.value) return;
  exportingCsv.value = true;
  try {
    const query = {
      ...library.filters,
      page: 1,
      sourceIds: [...(library.filters.sourceIds ?? [])],
      categoryIds: [...(library.filters.categoryIds ?? [])],
      nfoTagIds: [...(library.filters.nfoTagIds ?? [])],
      genreIds: [...(library.filters.genreIds ?? [])],
      organizationState: favoritePage.value ? 'all' as const : 'organized' as const,
      favoriteOnly: favoritePage.value,
    };
    const result = await window.filmLibrary.films.exportCsv(query);
    if (!result.ok) ElMessage.error(result.error.message);
    else if (result.data.saved) ElMessage.success(`已导出 ${result.data.rowCount} 部影片`);
  } finally {
    exportingCsv.value = false;
  }
}
function selectionChanged(rows: FilmSummaryDto[]): void { selectedRecordIds.value = rows.map((row) => row.id); }
async function showInFolder(film: FilmSummaryDto): Promise<void> {
  const result = await window.filmLibrary.films.showInFolder(film.id);
  if (!result.ok) ElMessage.error(result.error.message);
}
async function deleteRecords(ids: string[]): Promise<void> {
  if (!ids.length || deletingRecords.value) return;
  try {
    await ElMessageBox.confirm('将删除选中的影片数据库记录、标签关联和资源索引，但不会修改任何外部媒体文件。', '确认删除数据库记录', { type: 'warning' });
    deletingRecords.value = true;
    const result = ids.length === 1
      ? await window.filmLibrary.films.recordsDelete({ id: ids[0] })
      : await window.filmLibrary.films.recordsDeleteBatch({ ids: [...ids] });
    if (!result.ok) ElMessage.error(result.error.message);
    else { ElMessage.success('数据库记录已删除'); selectedRecordIds.value = []; await refresh(); }
  } catch (error) {
    if (error !== 'cancel') console.error('[library] delete records failed', error);
  } finally {
    deletingRecords.value = false;
  }
}
async function startScan(): Promise<void> {
  const started = await scan.start();
  if (!started) ElMessage.error('无法启动扫描，请确认没有其他扫描任务正在运行');
}
function changePage(page: number): void { library.filters.page = page; void library.fetchPage(); }
</script>

<template>
  <div class="page-wrap library-page">
    <div class="page-heading">
      <div><div class="eyebrow">YOUR OFFLINE CINEMA</div><h1 class="page-title">{{ allData ? '所有数据' : library.filters.organizationState === 'unorganized' ? '未整理' : library.filters.organizationState === 'organized' ? '已整理' : library.filters.favoriteOnly ? '收藏' : '全部影片' }}</h1><p class="page-caption">{{ library.pageData.total }} 条记录 · 所有资料只保存在本机</p></div>
      <section class="global-filters" aria-label="全局筛选">
        <div class="global-filter-heading"><strong>全局筛选</strong><span>跨页面生效 · 重启后保留</span><el-button v-if="library.filters.sourceIds?.length || library.filters.categoryIds?.length" link size="small" @click="clearGlobalFilters">清空全局筛选</el-button></div>
        <div class="global-filter-fields">
          <div class="source-filter" role="group" aria-label="来源（可多选）">
            <button type="button" class="source-filter-button" :aria-pressed="!library.filters.sourceIds?.length" @click="clearSourceFilter">全部来源</button>
            <button v-for="source in sourceButtons" :key="source.id" type="button" class="source-filter-button" :data-source-id="source.id" :aria-pressed="library.filters.sourceIds?.includes(source.id) ?? false" :title="source.name" @click="toggleSource(source.id)">{{ source.name }}</button>
          </div>
          <el-select v-model="library.filters.categoryIds" class="category-filter" multiple filterable clearable collapse-tags collapse-tags-tooltip placeholder="我的分类（同时包含全部）" aria-label="我的分类（同时包含全部所选分类，跨页面生效）" @change="filterChanged"><el-option v-for="category in categories" :key="category.id" :label="category.name" :value="category.id" /></el-select>
        </div>
        <small v-if="library.globalFilterStorageError" class="filter-storage-error" role="alert">{{ library.globalFilterStorageError }}</small>
      </section>
      <div class="heading-actions"><el-button v-if="exportPage" :loading="exportingCsv" @click="exportCsv"><Download />导出 CSV</el-button><el-button v-if="allData" type="danger" :disabled="!selectedRecordIds.length" :loading="deletingRecords" @click="deleteRecords(selectedRecordIds)">删除选中</el-button><el-button v-else type="primary" @click="startScan"><Operation />扫描来源</el-button></div>
    </div>
    <div class="page-filter-heading">当前页筛选<span>切换影片页面后重置</span></div>
    <div class="toolbar library-toolbar" role="group" aria-label="当前页筛选">
      <el-input v-model="library.filters.search" clearable placeholder="搜索标题、文件名…" @input="queueSearch"><template #prefix><Search /></template></el-input>
      <el-select v-model="library.filters.nfoTagIds" multiple filterable clearable placeholder="NFO 标签" @change="filterChanged"><el-option v-for="tag in nfoTags" :key="tag.id" :label="tag.name" :value="tag.id" /></el-select>
      <el-select v-model="library.filters.actor" filterable clearable placeholder="NFO 演员" @change="filterChanged"><el-option v-for="actor in actors" :key="actor.name" :label="`${actor.name} (${actor.filmCount})`" :value="actor.name" /></el-select>
      <el-select v-model="library.filters.commentImages" placeholder="精彩评论截图" @change="filterChanged"><el-option label="全部评论状态" value="all" /><el-option label="有精彩评论截图" value="with" /><el-option label="无精彩评论截图" value="without" /></el-select>
      <el-select v-model="library.filters.sort" placeholder="排序" @change="filterChanged"><el-option v-if="organizedPage" label="整理顺序" value="organized" /><el-option v-if="favoritePage" label="收藏顺序" value="favorite" /><el-option label="最近新增" value="added" /><el-option label="最近观看" value="played" /><el-option label="最近更新" value="recent" /><el-option label="标题" value="title" /><el-option label="年份" value="year" /><el-option label="评分" value="rating" /><el-option label="文件名" value="file" /><el-option label="视频大小（大到小）" value="size" /></el-select>
      <el-select v-if="allData" v-model="library.filters.availability" placeholder="数据状态" @change="filterChanged"><el-option label="全部状态" value="all" /><el-option label="正常" value="available" /><el-option label="部分缺失" value="partial_missing" /><el-option label="完全缺失" value="missing" /><el-option label="来源离线" value="source_offline" /><el-option label="来源已删除" value="source_removed" /></el-select>
      <el-select v-if="allData" v-model="library.filters.duplicateFilenameOnly" placeholder="同名影片" @change="filterChanged"><el-option label="全部文件名" :value="false" /><el-option label="仅看同名影片" :value="true" /></el-select>
      <el-button :loading="library.loading" @click="refresh"><Refresh />刷新</el-button>
      <span class="grow" />
      <el-radio-group v-if="!allData" v-model="library.viewMode" size="small"><el-radio-button value="grid"><Grid /></el-radio-button><el-radio-button value="table"><List /></el-radio-button></el-radio-group>
    </div>
    <div v-if="library.error" class="error-banner">{{ library.error }}</div>
    <FilmGrid v-if="!allData && library.viewMode === 'grid'" :films="library.items" :hover-delay="library.settings.hoverDelayMs" :hover-close-delay="library.settings.hoverCloseDelayMs" :slideshow-interval="library.settings.slideshowIntervalMs" :card-width="library.settings.cardSize" @select="selectFilm" @updated="refresh" />
    <FilmTable v-else :films="library.items" :all-data="allData" @select="selectFilm" @selection-change="selectionChanged" @show-in-folder="showInFolder" @delete-row="deleteRecords([$event.id])" />
    <el-pagination v-if="library.pageData.total" background layout="prev, pager, next, ->, total" :current-page="library.pageData.page" :page-size="library.pageData.pageSize" :total="library.pageData.total" @current-change="changePage" />
    <FilmDetailDrawer v-model="detailVisible" :film-id="selectedFilmId" @updated="refresh" />
  </div>
</template>

<style scoped>
.library-page .page-heading { align-items: center; flex-wrap: wrap; }
.global-filters { flex: 1; min-width: 360px; max-width: 840px; padding: 12px 14px; border: 1px solid rgba(152, 227, 194, .2); border-radius: 12px; background: rgba(152, 227, 194, .04); }
.global-filter-heading { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; min-height: 20px; margin-bottom: 8px; font-size: 11px; }
.global-filter-heading strong { color: var(--accent); font-weight: 600; }
.global-filter-heading span, .page-filter-heading span { color: var(--muted); font-size: 11px; }
.global-filter-heading .el-button { margin-left: auto; }
.global-filter-fields { display: flex; align-items: flex-start; flex-wrap: wrap; gap: 10px; }
.global-filter-fields .source-filter { display: flex; flex: 1 1 240px; flex-wrap: wrap; gap: 7px; min-width: 0; }
.source-filter-button { max-width: 100%; padding: 7px 11px; border: 1px solid var(--line); border-radius: 7px; color: var(--muted); background: transparent; font: inherit; font-size: 12px; overflow-wrap: anywhere; cursor: pointer; }
.source-filter-button:hover, .source-filter-button:focus-visible { border-color: var(--accent); color: var(--accent); }
.source-filter-button[aria-pressed="true"] { color: #12211d; border-color: var(--accent); background: var(--accent); font-weight: 600; }
.global-filter-fields .category-filter { flex: 0 1 260px; min-width: 220px; }
.filter-storage-error { display: block; margin-top: 8px; color: #ffadad; }
.page-filter-heading { display: flex; align-items: center; gap: 10px; margin-bottom: 9px; color: var(--subtle); font-size: 12px; }
.heading-actions { display: flex; gap: 9px; }
.heading-actions .el-button svg { width: 15px; margin-right: 5px; }
.library-toolbar .el-input { width: 260px; }
.library-toolbar .el-select { width: 138px; }
.library-toolbar .el-radio-button svg { width: 15px; }
.error-banner { padding: 13px 16px; margin-bottom: 16px; border: 1px solid rgba(255, 120, 120, .25); border-radius: 9px; color: #ffadad; background: rgba(255, 100, 100, .07); font-size: 13px; }
@media (max-width: 1100px) { .global-filters { order: 3; flex-basis: 100%; max-width: none; min-width: 0; }.heading-actions { margin-left: auto; } }
@media (max-width: 760px) { .global-filters { width: 100%; }.global-filter-fields { flex-direction: column; }.global-filter-fields .source-filter { flex: auto; }.global-filter-fields .el-select { width: 100%; flex: auto; min-width: 0; }.heading-actions { margin-left: 0; flex-wrap: wrap; }.library-toolbar .el-input { width: 100%; } }
</style>
