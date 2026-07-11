<script setup lang="ts">
import { onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { Film, FolderOpened, CollectionTag, Setting, VideoCamera, Star, Clock, View, CircleCheck, Warning } from '@element-plus/icons-vue';
import { useScanStore } from '../stores/scan';
import ScanProgressDialog from '../components/scan/ScanProgressDialog.vue';

const router = useRouter();
const route = useRoute();
const scan = useScanStore();
onMounted(() => scan.listen());

function go(path: string): void {
  void router.push(path);
}

function selected(): string {
  if (route.path.startsWith('/sources')) return 'sources';
  if (route.path.startsWith('/tags')) return 'tags';
  if (route.path.startsWith('/settings')) return 'settings';
  return 'library';
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
        <el-menu-item index="library"><Film /><span>全部影片</span></el-menu-item>
        <el-menu-item index="/library?status=unorganized"><Clock /><span>未整理</span></el-menu-item>
        <el-menu-item index="/library?status=want"><Star /><span>想看</span></el-menu-item>
        <el-menu-item index="/library?status=watching"><View /><span>正在观看</span></el-menu-item>
        <el-menu-item index="/library?status=watched"><CircleCheck /><span>已看</span></el-menu-item>
        <el-menu-item index="/library?favorite=1"><Star /><span>收藏</span></el-menu-item>
        <el-menu-item index="/library?missing=1"><Warning /><span>文件缺失</span></el-menu-item>
      </el-menu>
      <div class="sidebar-label secondary">MANAGE</div>
      <el-menu :default-active="selected()" class="side-menu" @select="go">
        <el-menu-item index="sources"><FolderOpened /><span>来源管理</span></el-menu-item>
        <el-menu-item index="tags"><CollectionTag /><span>标签管理</span></el-menu-item>
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
