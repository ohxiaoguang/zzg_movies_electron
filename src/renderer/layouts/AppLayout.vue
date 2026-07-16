<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { Film, FolderOpened, CollectionTag, Setting, VideoCamera, Star, Clock, CircleCheck, Files, User } from '@element-plus/icons-vue';
import { useScanStore } from '../stores/scan';
import ScanProgressDialog from '../components/scan/ScanProgressDialog.vue';
import { closeAllHoverPopups } from '../composables/hoverPopupManager';

const router = useRouter();
const route = useRoute();
const scan = useScanStore();
const counts = ref({ all: 0, unorganized: 0, organized: 0, favorite: 0, allData: 0 });
async function loadCounts(): Promise<void> {
  const result = await window.filmLibrary.films.navigationCounts();
  if (result.ok) counts.value = result.data;
}
function handleLibraryChanged(): void { void loadCounts(); }
onMounted(() => {
  scan.listen();
  window.addEventListener('film-library:changed', handleLibraryChanged);
  void loadCounts();
});
onBeforeUnmount(() => window.removeEventListener('film-library:changed', handleLibraryChanged));
watch(() => route.fullPath, () => closeAllHoverPopups());

function go(path: string): void {
  void router.push(path);
}

function selected(): string {
  if (route.path.startsWith('/sources')) return 'sources';
  if (route.path.startsWith('/categories')) return '/categories';
  if (route.path.startsWith('/actors')) return '/actors';
  if (route.path.startsWith('/settings')) return 'settings';
  if (route.query.organization === 'unorganized') return '/library?organization=unorganized';
  if (route.query.organization === 'organized') return '/library?organization=organized';
  if (route.query.favorite === '1') return '/library?favorite=1';
  if (route.query.all === '1') return '/library?all=1';
  return '/library';
}
</script>

<template>
  <el-container class="app-shell">
    <el-aside width="246px" class="app-sidebar">
      <div class="brand-block">
        <div class="brand-mark"><VideoCamera :size="22" /></div>
        <div>
          <div class="brand-title">LOCAL FILM</div>
          <div class="brand-subtitle">Library / 本地影库</div>
        </div>
      </div>
      <div class="sidebar-label">LIBRARY</div>
      <el-menu :default-active="selected()" class="side-menu" @select="go">
        <el-menu-item index="/library"><Film /><span>全部影片</span><small>{{ counts.all }}</small></el-menu-item>
        <el-menu-item index="/library?organization=unorganized"><Clock /><span>未整理</span><small>{{ counts.unorganized }}</small></el-menu-item>
        <el-menu-item index="/library?organization=organized"><CircleCheck /><span>已整理</span><small>{{ counts.organized }}</small></el-menu-item>
        <el-menu-item index="/library?favorite=1"><Star /><span>收藏</span><small>{{ counts.favorite }}</small></el-menu-item>
        <el-menu-item index="/library?all=1"><Files /><span>所有数据</span><small>{{ counts.allData }}</small></el-menu-item>
      </el-menu>
      <div class="sidebar-label secondary">MANAGE</div>
      <el-menu :default-active="selected()" class="side-menu" @select="go">
        <el-menu-item index="sources"><FolderOpened /><span>来源管理</span></el-menu-item>
        <el-menu-item index="/categories"><CollectionTag /><span>我的分类</span></el-menu-item>
        <el-menu-item index="/actors"><User /><span>演员</span></el-menu-item>
        <el-menu-item index="settings"><Setting /><span>设置</span></el-menu-item>
      </el-menu>
      <div class="sidebar-footer">
        <span class="status-dot" /> 100% 本地运行
      </div>
    </el-aside>
    <el-main class="app-main">
      <RouterView />
    </el-main>
  </el-container>
  <ScanProgressDialog v-model="scan.dialogVisible" :progress="scan.progress" @cancel="scan.cancel" @close="scan.closeDialog" />
</template>

<style scoped>
.side-menu .el-menu-item small { margin-left: auto; color: var(--subtle); font-size: 10px; }
</style>
