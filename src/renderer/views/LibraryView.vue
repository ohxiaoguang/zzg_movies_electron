<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { ElMessage } from 'element-plus';
import { Refresh, Search, Grid, List, Operation } from '@element-plus/icons-vue';
import type { FilmSummaryDto, TagDto } from '../../shared/contracts';
import { useLibraryStore } from '../stores/library';
import { useSourceStore } from '../stores/sources';
import { useScanStore } from '../stores/scan';
import FilmGrid from '../components/film/FilmGrid.vue';
import FilmTable from '../components/film/FilmTable.vue';
import FilmDetailDrawer from '../components/film/FilmDetailDrawer.vue';

const route = useRoute();
const library = useLibraryStore();
const sources = useSourceStore();
const scan = useScanStore();
const tags = ref<TagDto[]>([]);
const selectedFilmId = ref<string | null>(null);
const detailVisible = ref(false);
let searchTimer: ReturnType<typeof setTimeout> | null = null;

watch(() => route.query, () => { syncRouteFilter(); void library.fetchPage(); }, { deep: true, immediate: true });
onMounted(async () => {
  await Promise.all([sources.fetch(), library.loadSettings(), loadTags()]);
  await library.fetchPage();
});
onBeforeUnmount(() => { if (searchTimer) clearTimeout(searchTimer); });

async function loadTags(): Promise<void> {
  const result = await window.filmLibrary.tags.list();
  if (result.ok) tags.value = result.data;
}

function syncRouteFilter(): void {
  library.resetFilters();
  const query = route.query;
  if (typeof query.status === 'string') library.filters.status = query.status as typeof library.filters.status;
  if (query.favorite === '1') library.filters.favoriteOnly = true;
  if (query.missing === '1') library.filters.missingOnly = true;
}

function queueSearch(): void {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { library.filters.page = 1; void library.fetchPage(); }, 300);
}

function filterChanged(): void { library.filters.page = 1; void library.fetchPage(); }
function selectFilm(film: FilmSummaryDto): void { selectedFilmId.value = film.id; detailVisible.value = true; }
async function refresh(): Promise<void> { await library.fetchPage(); await sources.fetch(); await loadTags(); }
async function startScan(): Promise<void> {
  const started = await scan.start();
  if (!started) ElMessage.error('无法启动扫描，请确认没有其他扫描任务正在运行');
}
function changePage(page: number): void { library.filters.page = page; void library.fetchPage(); }
</script>

<template>
  <div class="page-wrap library-page">
    <div class="page-heading">
      <div><div class="eyebrow">YOUR OFFLINE CINEMA</div><h1 class="page-title">全部影片</h1><p class="page-caption">{{ library.pageData.total }} 部影片 · 所有资料只保存在本机</p></div>
      <div class="heading-actions"><el-button :loading="library.loading" @click="refresh"><Refresh />刷新</el-button><el-button type="primary" @click="startScan"><Operation />扫描来源</el-button></div>
    </div>
    <div class="toolbar library-toolbar">
      <el-input v-model="library.filters.search" clearable placeholder="搜索标题、文件名…" @input="queueSearch"><template #prefix><Search /></template></el-input>
      <el-select v-model="library.filters.sourceId" clearable placeholder="全部来源" @change="filterChanged"><el-option v-for="source in sources.sources" :key="source.id" :label="source.name" :value="source.id" /></el-select>
      <el-select v-model="library.filters.status" placeholder="全部状态" @change="filterChanged"><el-option label="全部状态" value="all" /><el-option label="未整理" value="unorganized" /><el-option label="想看" value="want" /><el-option label="正在观看" value="watching" /><el-option label="已看" value="watched" /></el-select>
      <el-select v-model="library.filters.tag" clearable placeholder="标签" @change="filterChanged"><el-option v-for="tag in tags" :key="tag.id" :label="tag.name" :value="tag.name" /></el-select>
      <el-select v-model="library.filters.minRating" clearable placeholder="最低评分" @change="filterChanged"><el-option v-for="rating in [8, 7, 6, 5]" :key="rating" :label="`${rating} 分以上`" :value="rating" /></el-select>
      <el-select v-model="library.filters.sort" placeholder="排序" @change="filterChanged"><el-option label="最近更新" value="recent" /><el-option label="标题" value="title" /><el-option label="年份" value="year" /><el-option label="评分" value="rating" /><el-option label="文件名" value="file" /></el-select>
      <span class="grow" />
      <el-radio-group v-model="library.viewMode" size="small"><el-radio-button value="grid"><Grid /></el-radio-button><el-radio-button value="table"><List /></el-radio-button></el-radio-group>
    </div>
    <div v-if="library.error" class="error-banner">{{ library.error }}</div>
    <FilmGrid v-if="library.viewMode === 'grid'" :films="library.items" :hover-delay="library.settings.hoverDelayMs" :slideshow-interval="library.settings.slideshowIntervalMs" :card-width="library.settings.cardSize" @select="selectFilm" />
    <FilmTable v-else :films="library.items" @select="selectFilm" />
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
