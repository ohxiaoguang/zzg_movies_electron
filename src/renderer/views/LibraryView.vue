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
  library.resetFilters();
  const query = route.query;
  library.filters.allData = allData.value;
  if (query.organization === 'unorganized' || query.organization === 'organized') library.filters.organizationState = query.organization;
  if (typeof query.category === 'string') library.filters.categoryIds = [query.category];
  if (typeof query.actor === 'string') library.filters.actor = query.actor;
  if (query.favorite === '1') library.filters.favoriteOnly = true;
  if (query.missing === '1') library.filters.missingOnly = true;
}

function queueSearch(): void {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { library.filters.page = 1; void library.fetchPage(); }, 300);
}

function filterChanged(): void { library.filters.page = 1; void library.fetchPage(); }
function selectFilm(film: FilmSummaryDto): void { selectedFilmId.value = film.id; detailVisible.value = true; }
async function refresh(): Promise<void> {
  await library.fetchPage();
  await sources.fetch();
  await loadTaxonomies();
  window.dispatchEvent(new Event('film-library:changed'));
}
function favoriteFilterChanged(value: string): void { library.filters.favoriteOnly = value === 'favorite'; filterChanged(); }
async function exportCsv(): Promise<void> {
  if (exportingCsv.value) return;
  exportingCsv.value = true;
  try {
    const query = {
      ...library.filters,
      page: 1,
      categoryIds: [...(library.filters.categoryIds ?? [])],
      nfoTagIds: [...(library.filters.nfoTagIds ?? [])],
      organizationState: 'organized' as const,
    };
    const result = await window.filmLibrary.films.exportCsv(query);
    if (!result.ok) ElMessage.error(result.error.message);
    else if (result.data.saved) ElMessage.success(`已导出 ${result.data.rowCount} 部影片`);
  } finally {
    exportingCsv.value = false;
  }
}
async function cardSizeChanged(value: number): Promise<void> {
  library.settings.cardSize = value;
  const result = await window.filmLibrary.settings.update({ cardSize: value });
  if (!result.ok) ElMessage.error(result.error.message);
}
function selectionChanged(rows: FilmSummaryDto[]): void { selectedRecordIds.value = rows.map((row) => row.id); }
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
      <div class="heading-actions"><el-button v-if="organizedPage" :loading="exportingCsv" @click="exportCsv"><Download />导出 CSV</el-button><el-button v-if="allData" type="danger" :disabled="!selectedRecordIds.length" :loading="deletingRecords" @click="deleteRecords(selectedRecordIds)">删除选中</el-button><el-button v-else type="primary" @click="startScan"><Operation />扫描来源</el-button></div>
    </div>
    <div class="toolbar library-toolbar">
      <el-input v-model="library.filters.search" clearable placeholder="搜索标题、文件名…" @input="queueSearch"><template #prefix><Search /></template></el-input>
      <el-select v-model="library.filters.sourceId" clearable placeholder="全部来源" @change="filterChanged"><el-option v-for="source in sources.sources" :key="source.id" :label="source.name" :value="source.id" /></el-select>
      <el-select v-model="library.filters.categoryIds" multiple filterable clearable placeholder="我的分类" @change="filterChanged"><el-option v-for="category in categories" :key="category.id" :label="category.name" :value="category.id" /></el-select>
      <el-select v-if="library.filters.categoryIds?.length" v-model="library.filters.categoryMatch" placeholder="分类匹配" @change="filterChanged"><el-option label="匹配任意" value="any" /><el-option label="匹配全部" value="all" /></el-select>
      <el-select v-model="library.filters.nfoTagIds" multiple filterable clearable placeholder="NFO 标签" @change="filterChanged"><el-option v-for="tag in nfoTags" :key="tag.id" :label="tag.name" :value="tag.id" /></el-select>
      <el-select v-model="library.filters.actor" filterable clearable placeholder="NFO 演员" @change="filterChanged"><el-option v-for="actor in actors" :key="actor.name" :label="`${actor.name} (${actor.filmCount})`" :value="actor.name" /></el-select>
      <el-select :model-value="library.filters.favoriteOnly ? 'favorite' : 'all'" placeholder="收藏" @change="favoriteFilterChanged"><el-option label="全部影片" value="all" /><el-option label="仅收藏" value="favorite" /></el-select>
      <el-select v-model="library.filters.sort" placeholder="排序" @change="filterChanged"><el-option label="最近更新" value="recent" /><el-option label="标题" value="title" /><el-option label="年份" value="year" /><el-option label="评分" value="rating" /><el-option label="文件名" value="file" /></el-select>
      <el-select v-if="allData" v-model="library.filters.availability" placeholder="数据状态" @change="filterChanged"><el-option label="全部状态" value="all" /><el-option label="正常" value="available" /><el-option label="部分缺失" value="partial_missing" /><el-option label="完全缺失" value="missing" /><el-option label="来源离线" value="source_offline" /><el-option label="来源已删除" value="source_removed" /><el-option label="已归档" value="archived" /></el-select>
      <el-select v-if="!allData" v-model="library.settings.cardSize" placeholder="卡片大小" @change="cardSizeChanged"><el-option label="小卡片" :value="160" /><el-option label="标准" :value="200" /><el-option label="大卡片" :value="240" /><el-option label="超大" :value="280" /></el-select>
      <el-button :loading="library.loading" @click="refresh"><Refresh />刷新</el-button>
      <span class="grow" />
      <el-radio-group v-model="library.viewMode" size="small"><el-radio-button value="grid"><Grid /></el-radio-button><el-radio-button value="table"><List /></el-radio-button></el-radio-group>
    </div>
    <div v-if="library.error" class="error-banner">{{ library.error }}</div>
    <FilmGrid v-if="!allData && library.viewMode === 'grid'" :films="library.items" :hover-delay="library.settings.hoverDelayMs" :slideshow-interval="library.settings.slideshowIntervalMs" :card-width="library.settings.cardSize" @select="selectFilm" @updated="refresh" />
    <FilmTable v-else :films="library.items" :all-data="allData" @select="selectFilm" @selection-change="selectionChanged" @delete-row="deleteRecords([$event.id])" />
    <el-pagination v-if="library.pageData.total" background layout="prev, pager, next, ->, total" :current-page="library.pageData.page" :page-size="library.pageData.pageSize" :total="library.pageData.total" @current-change="changePage" />
    <FilmDetailDrawer v-model="detailVisible" :film-id="selectedFilmId" @updated="refresh" />
  </div>
</template>

<style scoped>
.heading-actions { display: flex; gap: 9px; }
.heading-actions .el-button svg { width: 15px; margin-right: 5px; }
.library-toolbar .el-input { width: 260px; }
.library-toolbar .el-select { width: 138px; }
.library-toolbar .el-radio-button svg { width: 15px; }
.error-banner { padding: 13px 16px; margin-bottom: 16px; border: 1px solid rgba(255, 120, 120, .25); border-radius: 9px; color: #ffadad; background: rgba(255, 100, 100, .07); font-size: 13px; }
</style>
