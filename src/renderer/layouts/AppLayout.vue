<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { Film, FolderOpened, CollectionTag, Setting, VideoCamera, Star, Clock, CircleCheck, Files, User } from '@element-plus/icons-vue';
import { useScanStore } from '../stores/scan';
import ScanProgressDialog from '../components/scan/ScanProgressDialog.vue';
import ResonanceBall from '../components/resonance/ResonanceBall.vue';
import { closeAllHoverPopups } from '../composables/hoverPopupManager';
import type { CloudBackupActivityDto } from '../../shared/contracts';

const router = useRouter();
const route = useRoute();
const scan = useScanStore();
const counts = ref({ all: 0, unorganized: 0, organized: 0, favorite: 0, allData: 0 });
const appVersion = ref('');
const startupBackupActivity = ref<CloudBackupActivityDto | null>(null);
const shutdownBackupActivity = ref<CloudBackupActivityDto | null>(null);
let stopBackupActivity: (() => void) | null = null;
let startupStatusTimer: number | null = null;

const startupBackupText = computed(() => {
  const activity = startupBackupActivity.value;
  if (!activity) return '';
  if (activity.phase === 'running') return '启动自动备份：正在同步到 GitHub…';
  if (activity.phase === 'success') return '启动自动备份：备份完成';
  if (activity.phase === 'skipped') return '启动自动备份：云端已是最新';
  return '启动自动备份失败，请到设置中查看原因';
});
async function loadCounts(): Promise<void> {
  const result = await window.filmLibrary.films.navigationCounts();
  if (result.ok) counts.value = result.data;
}
async function loadAppVersion(): Promise<void> {
  const result = await window.filmLibrary.app.info();
  if (result.ok) appVersion.value = `v${result.data.version.replace(/^v/i, '')}`;
}
function handleLibraryChanged(): void { void loadCounts(); }
onMounted(() => {
  scan.listen();
  window.addEventListener('film-library:changed', handleLibraryChanged);
  void loadCounts();
  void loadAppVersion();
  stopBackupActivity = window.filmLibrary.cloudBackup.onActivity(handleBackupActivity);
  void loadBackupActivity();
});
onBeforeUnmount(() => {
  window.removeEventListener('film-library:changed', handleLibraryChanged);
  stopBackupActivity?.();
  if (startupStatusTimer !== null) window.clearTimeout(startupStatusTimer);
});
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

async function loadBackupActivity(): Promise<void> {
  const result = await window.filmLibrary.cloudBackup.status();
  if (result.ok && result.data.activity) handleBackupActivity(result.data.activity);
}

function handleBackupActivity(activity: CloudBackupActivityDto): void {
  if (activity.trigger === 'shutdown') {
    if (activity.phase === 'running') shutdownBackupActivity.value = activity;
    return;
  }
  if (activity.trigger !== 'startup') return;
  startupBackupActivity.value = activity;
  if (startupStatusTimer !== null) window.clearTimeout(startupStatusTimer);
  if (activity.phase !== 'running') {
    startupStatusTimer = window.setTimeout(() => {
      startupBackupActivity.value = null;
      startupStatusTimer = null;
    }, activity.phase === 'error' ? 12_000 : 8_000);
  }
}
</script>

<template>
  <el-container class="app-shell">
    <el-aside width="246px" class="app-sidebar">
      <div class="brand-block">
        <div class="brand-mark"><VideoCamera :size="22" /></div>
        <div>
          <div class="brand-title">LOCAL FILM <span v-if="appVersion" class="brand-version">{{ appVersion }}</span></div>
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
    </el-aside>
    <el-main class="app-main">
      <RouterView />
    </el-main>
  </el-container>
  <ResonanceBall />
  <ScanProgressDialog v-model="scan.dialogVisible" :progress="scan.progress" @cancel="scan.cancel" @close="scan.closeDialog" />
  <Transition name="backup-status">
    <div v-if="startupBackupActivity" class="cloud-backup-status" :class="startupBackupActivity.phase" role="status">
      <span v-if="startupBackupActivity.phase === 'running'" class="cloud-backup-spinner" />
      <span v-else class="cloud-backup-dot" />
      {{ startupBackupText }}
    </div>
  </Transition>
  <div v-if="shutdownBackupActivity?.phase === 'running'" class="shutdown-backup-overlay" role="alert" aria-live="assertive">
    <section class="shutdown-backup-card">
      <span class="shutdown-backup-spinner" />
      <h2>正在备份影片整理数据</h2>
      <p>正在同步到 GitHub，完成后会自动退出…</p>
    </section>
  </div>
</template>

<style scoped>
.side-menu .el-menu-item small { margin-left: auto; color: var(--subtle); font-size: 10px; }
.brand-version { color: var(--accent); font-size: 10px; font-weight: 700; letter-spacing: .04em; }
.cloud-backup-status { position: fixed; z-index: 2100; right: 22px; bottom: 18px; display: flex; align-items: center; gap: 9px; max-width: min(460px, calc(100vw - 44px)); padding: 10px 14px; border: 1px solid rgba(152, 227, 194, .22); border-radius: 10px; color: #c8d0dc; background: rgba(20, 24, 33, .96); box-shadow: 0 12px 36px rgba(0, 0, 0, .32); font-size: 12px; }
.cloud-backup-status.error { border-color: rgba(255, 116, 116, .28); color: #ffb3b3; }
.cloud-backup-dot { width: 7px; height: 7px; flex: 0 0 auto; border-radius: 50%; background: var(--accent); }
.cloud-backup-status.error .cloud-backup-dot { background: #ff7474; }
.cloud-backup-spinner, .shutdown-backup-spinner { width: 14px; height: 14px; flex: 0 0 auto; border: 2px solid rgba(152, 227, 194, .25); border-top-color: var(--accent); border-radius: 50%; animation: cloud-backup-spin .8s linear infinite; }
.shutdown-backup-overlay { position: fixed; z-index: 5000; inset: 0; display: grid; place-items: center; background: rgba(8, 10, 14, .82); backdrop-filter: blur(7px); }
.shutdown-backup-card { width: min(390px, calc(100vw - 48px)); padding: 34px; border: 1px solid rgba(152, 227, 194, .18); border-radius: 16px; text-align: center; background: #171b25; box-shadow: 0 24px 80px rgba(0, 0, 0, .5); }
.shutdown-backup-card .shutdown-backup-spinner { width: 30px; height: 30px; margin: 0 auto 20px; border-width: 3px; }
.shutdown-backup-card h2 { margin: 0; color: var(--ink); font-size: 20px; }
.shutdown-backup-card p { margin: 10px 0 0; color: var(--muted); font-size: 13px; }
.backup-status-enter-active, .backup-status-leave-active { transition: opacity .18s ease, transform .18s ease; }
.backup-status-enter-from, .backup-status-leave-to { opacity: 0; transform: translateY(8px); }
@keyframes cloud-backup-spin { to { transform: rotate(360deg); } }
</style>
