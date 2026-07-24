<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { FolderOpened, Setting, VideoCamera } from '@element-plus/icons-vue';
import QRCode from 'qrcode';
import type {
  AppInfoDto,
  LanPairedDeviceDto,
  LanPairingCodeDto,
  LanServerStatusDto,
  PlaybackCacheInfoDto,
  SettingsDto,
} from '../../shared/contracts';
import { useLibraryStore } from '../stores/library';

const library = useLibraryStore();
const info = ref<AppInfoDto | null>(null);
const form = reactive<SettingsDto>({
  cardSize: 220,
  hoverDelayMs: 450,
  slideshowIntervalMs: 1200,
  pageSize: 60,
  videoExtensions: [],
  imageExtensions: [],
  ignoredDirectories: [],
  autoScanOnStartup: false,
  autoLaunchOnStartup: false,
  launchToTray: false,
  minimizeToTray: false,
  ffprobePath: '',
  playbackCacheDirectory: '',
  playbackCacheLimitGb: 20,
  lanServerEnabled: false,
  lanServerPort: 48765,
  lanServerBindMode: 'localhost',
  lanServerHost: '',
  lanRequireAuthentication: true,
});
const saving = ref(false);
const ffprobeResult = ref<string | null>(null);
const lanStatus = ref<LanServerStatusDto | null>(null);
const lanChanging = ref(false);
const pairingCode = ref<LanPairingCodeDto | null>(null);
const pairedDevices = ref<LanPairedDeviceDto[]>([]);
const qrDataUrl = ref<string | null>(null);
const playbackCache = ref<PlaybackCacheInfoDto | null>(null);
const cacheChanging = ref(false);

onMounted(async () => {
  try {
    const [settings, appInfo, localWeb, cache] = await Promise.all([
      window.filmLibrary.settings.get(),
      window.filmLibrary.app.info(),
      window.filmLibrary.lanServer.status(),
      window.filmLibrary.settings.cacheInfo(),
    ]);
    if (settings.ok) Object.assign(form, settings.data);
    if (appInfo.ok) info.value = appInfo.data;
    if (localWeb.ok) {
      lanStatus.value = localWeb.data;
      await updateQrCode();
    }
    if (cache.ok) playbackCache.value = cache.data;
    await loadDevices();
  } catch (error) {
    console.error('[settings] load failed', error);
    ElMessage.error('设置加载失败，请查看日志');
  }
});
async function save(): Promise<void> {
  saving.value = true;
  try {
    const input = {
      cardSize: Number(form.cardSize),
      hoverDelayMs: Number(form.hoverDelayMs),
      slideshowIntervalMs: Number(form.slideshowIntervalMs),
      pageSize: Number(form.pageSize),
      videoExtensions: [...form.videoExtensions],
      imageExtensions: [...form.imageExtensions],
      ignoredDirectories: [...form.ignoredDirectories],
      autoScanOnStartup: Boolean(form.autoScanOnStartup),
      autoLaunchOnStartup: Boolean(form.autoLaunchOnStartup),
      launchToTray: Boolean(form.launchToTray),
      minimizeToTray: Boolean(form.minimizeToTray),
      ffprobePath: form.ffprobePath,
      playbackCacheDirectory: form.playbackCacheDirectory,
      playbackCacheLimitGb: Number(form.playbackCacheLimitGb),
      lanServerEnabled: Boolean(form.lanServerEnabled),
      lanServerPort: Number(form.lanServerPort),
      lanServerBindMode: form.lanServerBindMode,
      lanServerHost: form.lanServerHost.trim(),
      lanRequireAuthentication: form.lanServerBindMode === 'lan' ? true : Boolean(form.lanRequireAuthentication),
    };
    const result = await window.filmLibrary.settings.update(input);
    if (result.ok) {
      Object.assign(form, result.data);
      library.settings = result.data;
      ElMessage.success('设置已保存');
    } else ElMessage.error(result.error.message);
    await refreshLanStatus();
    await refreshPlaybackCache();
  } catch (error) {
    console.error('[settings] save failed', error);
    ElMessage.error('设置保存失败，请查看日志');
  } finally {
    saving.value = false;
  }
}
async function testFfprobe(): Promise<void> { const result = await window.filmLibrary.settings.testFfprobe(form.ffprobePath); if (result.ok) { ffprobeResult.value = result.data.message + (result.data.version ? ' · ' + result.data.version : ''); ElMessage.success(ffprobeResult.value); } else { ffprobeResult.value = result.error.message; ElMessage.warning(result.error.message); } }
async function changeLanServer(action: 'start' | 'stop'): Promise<void> {
  lanChanging.value = true;
  try {
    if (action === 'start') {
      const saved = await window.filmLibrary.settings.update({
        lanServerEnabled: true,
        lanServerPort: Number(form.lanServerPort),
        lanServerBindMode: form.lanServerBindMode,
        lanServerHost: form.lanServerHost.trim(),
        lanRequireAuthentication: form.lanServerBindMode === 'lan' ? true : Boolean(form.lanRequireAuthentication),
      });
      if (!saved.ok) {
        ElMessage.error(saved.error.message);
        await refreshLanStatus();
        return;
      }
      Object.assign(form, saved.data);
    }
    const result = action === 'start'
      ? await window.filmLibrary.lanServer.status()
      : await window.filmLibrary.lanServer.stop();
    if (result.ok) {
      lanStatus.value = result.data;
      form.lanServerEnabled = result.data.enabled;
      await updateQrCode();
      ElMessage.success(action === 'start' ? '本机网页服务已启动' : '本机网页服务已停止');
    } else {
      const refreshed = await window.filmLibrary.lanServer.status();
      if (refreshed.ok) lanStatus.value = refreshed.data;
      ElMessage.error(result.error.message);
    }
  } finally {
    lanChanging.value = false;
  }
}
async function refreshLanStatus(): Promise<void> {
  const result = await window.filmLibrary.lanServer.status();
  if (result.ok) {
    lanStatus.value = result.data;
    form.lanServerEnabled = result.data.enabled;
    await updateQrCode();
  }
}
async function createPairingCode(role: 'viewer' | 'admin'): Promise<void> {
  const result = await window.filmLibrary.lanServer.createPairingCode(role);
  if (result.ok) pairingCode.value = result.data;
  else ElMessage.error(result.error.message);
}
async function loadDevices(): Promise<void> {
  const result = await window.filmLibrary.lanServer.listDevices();
  if (result.ok) pairedDevices.value = result.data;
}
async function revokeDevice(device: LanPairedDeviceDto): Promise<void> {
  const result = await window.filmLibrary.lanServer.revokeDevice(device.id);
  if (!result.ok) ElMessage.error(result.error.message);
  else {
    ElMessage.success(`已撤销“${device.name}”`);
    await Promise.all([loadDevices(), refreshLanStatus()]);
  }
}
async function updateQrCode(): Promise<void> {
  const url = lanStatus.value?.baseUrl;
  if (!url) {
    qrDataUrl.value = null;
    return;
  }
  try {
    qrDataUrl.value = await QRCode.toDataURL(url, {
      width: 180,
      margin: 1,
      color: { dark: '#101820', light: '#ffffff' },
    });
  } catch {
    qrDataUrl.value = null;
  }
}
async function openFolder(kind: 'data' | 'logs'): Promise<void> { const result = kind === 'data' ? await window.filmLibrary.app.openDataFolder() : await window.filmLibrary.app.openLogsFolder(); if (!result.ok) ElMessage.error(result.error.message); }
async function refreshPlaybackCache(): Promise<void> {
  const result = await window.filmLibrary.settings.cacheInfo();
  if (result.ok) playbackCache.value = result.data;
  else ElMessage.error(result.error.message);
}
async function choosePlaybackCacheDirectory(): Promise<void> {
  const selected = await window.filmLibrary.settings.chooseCacheDirectory();
  if (!selected.ok) {
    ElMessage.error(selected.error.message);
    return;
  }
  if (!selected.data) return;
  await updatePlaybackCacheDirectory(selected.data);
}
async function restoreDefaultPlaybackCacheDirectory(): Promise<void> {
  await updatePlaybackCacheDirectory('');
}
async function updatePlaybackCacheDirectory(directory: string): Promise<void> {
  cacheChanging.value = true;
  try {
    const result = await window.filmLibrary.settings.update({ playbackCacheDirectory: directory });
    if (!result.ok) {
      ElMessage.error(result.error.message);
      return;
    }
    Object.assign(form, result.data);
    library.settings = result.data;
    await refreshPlaybackCache();
    ElMessage.success(directory ? '播放缓存目录已更改' : '已恢复默认播放缓存目录');
  } finally {
    cacheChanging.value = false;
  }
}
async function openPlaybackCacheDirectory(): Promise<void> {
  const result = await window.filmLibrary.settings.openCacheDirectory();
  if (!result.ok) ElMessage.error(result.error.message);
}
async function clearPlaybackCache(): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `将清理当前目录中的 ${formatBytes(playbackCache.value?.sizeBytes ?? 0)} 播放缓存，不会删除影片原文件。`,
      '清理播放缓存',
      { confirmButtonText: '清理缓存', cancelButtonText: '取消', type: 'warning' },
    );
  } catch {
    return;
  }
  cacheChanging.value = true;
  try {
    const result = await window.filmLibrary.settings.clearCache();
    if (!result.ok) {
      ElMessage.error(result.error.message);
      return;
    }
    playbackCache.value = result.data;
    ElMessage.success('播放缓存已清理');
  } finally {
    cacheChanging.value = false;
  }
}
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / (1024 ** index);
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}
function listText(values: string[]): string { return values.join(', '); }
function parseList(value: string): string[] { return value.split(/[,，\n]/).map((item) => item.trim()).filter(Boolean); }
function updateVideoExtensions(value: string): void { form.videoExtensions = parseList(value); }
function updateImageExtensions(value: string): void { form.imageExtensions = parseList(value); }
function updateIgnoredDirectories(value: string): void { form.ignoredDirectories = parseList(value); }
</script>

<template>
  <div class="page-wrap settings-page"><div class="page-heading"><div><div class="eyebrow">LOCAL CONFIGURATION</div><h1 class="page-title">设置</h1><p class="page-caption">调整启动、托盘、网页服务和本地预览行为。</p></div><el-button type="primary" :loading="saving" @click="save">保存设置</el-button></div>
    <div class="settings-grid"><section class="settings-card"><div class="settings-title"><Setting /><span>应用数据</span></div><div class="data-row"><span>数据库位置</span><code>{{ info?.databasePath || '读取中…' }}</code></div><div class="data-row"><span>日志目录</span><code>{{ info?.logsDirectory || '读取中…' }}</code></div><div class="settings-actions\"><el-button size="small" @click="openFolder('data')"><FolderOpened />打开数据目录</el-button><el-button size="small" @click="openFolder('logs')">打开日志目录</el-button></div></section>
      <section class="settings-card"><div class="settings-title"><VideoCamera /><span>卡片与预览</span></div><div class="setting-row"><label>默认卡片宽度</label><el-input-number v-model="form.cardSize" :min="140" :max="320" :step="10" /><span>px</span></div><div class="setting-row"><label>悬浮延迟</label><el-input-number v-model="form.hoverDelayMs" :min="100" :max="3000" :step="50" /><span>ms</span></div><div class="setting-row"><label>图片轮播间隔</label><el-input-number v-model="form.slideshowIntervalMs" :min="500" :max="10000" :step="100" /><span>ms</span></div><div class="setting-row"><label>每页数量</label><el-input-number v-model="form.pageSize" :min="12" :max="200" :step="12" /></div></section>
      <section class="settings-card wide startup-settings-card">
        <div class="settings-title"><span>启动与系统托盘</span><span class="muted">Windows 正式安装版</span></div>
        <div class="startup-options">
          <div class="startup-option"><div><strong>开机自启动</strong><small>登录 Windows 后自动启动本地影库</small></div><el-switch v-model="form.autoLaunchOnStartup" /></div>
          <div class="startup-option"><div><strong>开机时仅启动托盘</strong><small>由开机自启动唤起时不显示主窗口，可从托盘恢复</small></div><el-switch v-model="form.launchToTray" :disabled="!form.autoLaunchOnStartup" /></div>
          <div class="startup-option"><div><strong>最小化到托盘</strong><small>点击窗口最小化按钮时隐藏到托盘；关闭按钮仍会退出应用</small></div><el-switch v-model="form.minimizeToTray" /></div>
        </div>
      </section>
      <section class="settings-card wide cache-settings-card">
        <div class="settings-title"><span>网页播放缓存</span><span class="muted">Remux、转码分片和网页字幕</span></div>
        <div class="data-row cache-directory"><span>缓存目录</span><code :title="playbackCache?.directory">{{ playbackCache?.directory || '读取中…' }}</code></div>
        <div class="cache-metrics">
          <div><span>当前缓存</span><strong>{{ formatBytes(playbackCache?.sizeBytes || 0) }}</strong></div>
          <div><span>缓存上限</span><div class="cache-limit"><el-input-number v-model="form.playbackCacheLimitGb" :min="1" :max="500" :step="5" /><span>GB</span></div></div>
          <div><span>转码任务</span><strong>{{ playbackCache?.activeJobs || 0 }}</strong></div>
        </div>
        <el-progress
          :percentage="playbackCache?.limitBytes ? Math.min(100, Math.round(playbackCache.sizeBytes / playbackCache.limitBytes * 100)) : 0"
          :stroke-width="7"
        />
        <p class="muted cache-note">更改上限后点击页面右上角“保存设置”。选择目录时会在目标位置使用专属缓存子目录，清理不会删除影片原文件。</p>
        <div class="settings-actions">
          <el-button size="small" :loading="cacheChanging" @click="choosePlaybackCacheDirectory"><FolderOpened />更改目录</el-button>
          <el-button size="small" :disabled="!form.playbackCacheDirectory || cacheChanging" @click="restoreDefaultPlaybackCacheDirectory">恢复默认</el-button>
          <el-button size="small" :disabled="cacheChanging" @click="openPlaybackCacheDirectory">打开缓存目录</el-button>
          <el-button size="small" type="danger" plain :loading="cacheChanging" @click="clearPlaybackCache">清理缓存</el-button>
        </div>
      </section>
      <section class="settings-card wide lan-settings-card">
        <div class="settings-title"><span>局域网网页访问</span><span class="muted">里程碑 B · 只读 · 禁止公网暴露</span></div>
        <div class="lan-config-grid">
          <div>
            <div class="setting-row"><label>启用网页服务</label><el-switch v-model="form.lanServerEnabled" /></div>
            <div class="setting-row"><label>监听模式</label><el-select v-model="form.lanServerBindMode" @change="form.lanRequireAuthentication = true"><el-option label="仅本机" value="localhost" /><el-option label="私有局域网" value="lan" /></el-select></div>
            <div class="setting-row"><label>端口</label><el-input-number v-model="form.lanServerPort" :min="1024" :max="65535" /></div>
            <div v-if="form.lanServerBindMode === 'lan'" class="setting-row"><label>指定网卡 IPv4</label><el-input v-model="form.lanServerHost" placeholder="留空监听全部私有网卡" /></div>
            <div class="setting-row"><label>要求设备配对</label><el-switch v-model="form.lanRequireAuthentication" :disabled="form.lanServerBindMode === 'lan'" /><span v-if="form.lanServerBindMode === 'lan'" class="muted">局域网模式强制开启</span></div>
          </div>
          <div class="lan-diagnostics">
            <div class="data-row"><span>服务状态</span><strong>{{ lanStatus?.state === 'running' ? '运行中' : lanStatus?.state === 'error' ? '启动失败' : lanStatus?.state === 'starting' ? '正在启动' : '已停止' }}</strong></div>
            <div class="data-row"><span>监听地址</span><code>{{ lanStatus?.bindAddress || '—' }}:{{ lanStatus?.port || form.lanServerPort }}</code></div>
            <div v-for="url in lanStatus?.baseUrls || []" :key="url" class="data-row"><span>访问地址</span><code>{{ url }}</code></div>
            <img v-if="qrDataUrl" class="lan-qr" :src="qrDataUrl" alt="局域网访问地址二维码" />
          </div>
        </div>
        <p class="lan-warning">只允许受信任的私有局域网使用。不要在路由器中做端口转发，也不要把该端口暴露到公网。首次连接需要在桌面端生成短时配对码。</p>
        <p v-if="lanStatus?.lastErrorCode" class="lan-error">诊断代码：{{ lanStatus.lastErrorCode }}。桌面功能不受影响；请检查端口占用、网卡地址及 Windows 防火墙。</p>
        <div class="settings-actions"><el-button v-if="lanStatus?.state !== 'running'" size="small" type="primary" :loading="lanChanging" @click="changeLanServer('start')">启动网页服务</el-button><el-button v-else size="small" :loading="lanChanging" @click="changeLanServer('stop')">停止网页服务</el-button><el-button :disabled="lanStatus?.state !== 'running' || !lanStatus.authenticationRequired" @click="createPairingCode('viewer')">生成访客配对码</el-button><el-button type="warning" :disabled="lanStatus?.state !== 'running' || !lanStatus.authenticationRequired" @click="createPairingCode('admin')">生成管理员配对码</el-button></div>
        <div v-if="pairingCode" class="pairing-code"><span>{{ pairingCode.role === 'admin' ? '管理员配对码' : '访客配对码' }}</span><strong>{{ pairingCode.code }}</strong><small>{{ new Date(pairingCode.expiresAt).toLocaleTimeString() }} 前有效，成功配对后立即失效</small></div>
        <div class="paired-devices"><div class="section-label">已配对设备</div><div v-if="pairedDevices.length" class="device-list"><div v-for="device in pairedDevices" :key="device.id" class="device-row"><div><strong>{{ device.name }} · {{ device.role === 'admin' ? '管理员' : '访客' }}</strong><small>{{ device.revokedAt ? '已撤销' : `最近使用：${device.lastUsedAt ? new Date(device.lastUsedAt).toLocaleString() : '尚未访问'}` }}</small></div><el-button v-if="!device.revokedAt" text type="danger" @click="revokeDevice(device)">撤销</el-button></div></div><p v-else class="muted">尚无已配对设备</p></div>
      </section>
      <section class="settings-card wide"><div class="settings-title"><span>扫描选项</span></div><div class="setting-row"><label>启动时自动扫描</label><el-switch v-model="form.autoScanOnStartup" /><span class="muted">默认关闭，避免外部磁盘未就绪时误判</span></div><el-form label-position="top"><el-form-item label="影片扩展名"><el-input :model-value="listText(form.videoExtensions)" @update:model-value="updateVideoExtensions" /></el-form-item><el-form-item label="图片扩展名"><el-input :model-value="listText(form.imageExtensions)" @update:model-value="updateImageExtensions" /></el-form-item><el-form-item label="忽略目录"><el-input type="textarea" :rows="3" :model-value="listText(form.ignoredDirectories)" @update:model-value="updateIgnoredDirectories" /></el-form-item></el-form></section>
      <section class="settings-card wide"><div class="settings-title"><span>可选 ffprobe / ffmpeg</span><span class="muted">MKV、MPG/MPEG、AVI、TS、FLV、WMV 兼容缓存会查找 ffprobe 同目录或系统 PATH 中的 ffmpeg</span></div><el-input v-model="form.ffprobePath" placeholder="留空则尝试使用 PATH 中的 ffprobe；兼容预览还需要 ffmpeg"><template #append><el-button @click="testFfprobe">测试 ffprobe</el-button></template></el-input><p v-if="ffprobeResult" class="test-result">{{ ffprobeResult }}</p></section>
    </div>
  </div>
</template>

<style scoped>
.settings-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; max-width: 1000px; }.settings-card { padding: 20px; border: 1px solid var(--line); border-radius: 14px; background: rgba(21,24,33,.8); }.settings-card.wide { grid-column: 1 / -1; }.settings-title { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 20px; color: var(--ink); font-size: 13px; font-weight: 750; }.settings-title svg { width: 17px; color: var(--accent); }.data-row { display: grid; grid-template-columns: 92px 1fr; gap: 10px; margin: 12px 0; color: var(--muted); font-size: 11px; }.data-row code { overflow: hidden; color: #b9c1d0; text-overflow: ellipsis; white-space: nowrap; }.settings-actions { display: flex; gap: 8px; margin-top: 18px; }.settings-actions svg { width: 13px; margin-right: 5px; }.setting-row { display: flex; align-items: center; gap: 9px; margin: 14px 0; color: var(--muted); font-size: 12px; }.setting-row label { width: 120px; color: var(--ink); }.setting-row .el-input-number { width: 130px; }.setting-row .muted { margin-left: 8px; }.settings-card :deep(.el-form-item) { margin-bottom: 15px; }.test-result { margin: 11px 0 0; color: var(--accent); font-size: 12px; }
.cache-directory { grid-template-columns: 76px minmax(0, 1fr); }.cache-metrics { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; margin: 16px 0 12px; }.cache-metrics > div { padding: 12px; border: 1px solid var(--line); border-radius: 9px; background: rgba(12,15,21,.45); }.cache-metrics span, .cache-metrics strong { display: block; }.cache-metrics span { color: var(--muted); font-size: 11px; }.cache-metrics strong { margin-top: 7px; color: var(--ink); font-size: 18px; }.cache-limit { display: flex; align-items: center; gap: 7px; margin-top: 6px; }.cache-limit span { display: inline; }.cache-note { margin: 10px 0 0; font-size: 11px; line-height: 1.6; }
.startup-options { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }.startup-option { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 14px; border: 1px solid var(--line); border-radius: 9px; background: rgba(12,15,21,.45); }.startup-option strong, .startup-option small { display: block; }.startup-option strong { color: var(--ink); font-size: 12px; }.startup-option small { margin-top: 5px; color: var(--muted); font-size: 10px; line-height: 1.5; }
.lan-error { margin: 12px 0 0; color: #ffadad; font-size: 12px; }
.lan-config-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(280px, .8fr); gap: 24px; }.lan-settings-card .el-select { width: 180px; }.lan-settings-card .setting-row .el-input { width: min(360px, 100%); }.lan-diagnostics { position: relative; min-height: 170px; padding: 12px 200px 12px 14px; border: 1px solid var(--line); border-radius: 10px; background: rgba(12,15,21,.55); }.lan-diagnostics .data-row { grid-template-columns: 72px minmax(0, 1fr); }.lan-qr { position: absolute; top: 12px; right: 12px; width: 150px; height: 150px; padding: 5px; border-radius: 7px; background: #fff; }.lan-warning { padding: 11px 13px; border: 1px solid rgba(255,193,94,.24); border-radius: 8px; color: #e8c582; background: rgba(255,193,94,.06); font-size: 12px; line-height: 1.6; }.pairing-code { display: flex; align-items: center; gap: 14px; margin-top: 16px; padding: 14px; border: 1px solid rgba(152,227,194,.3); border-radius: 10px; background: rgba(152,227,194,.07); }.pairing-code span, .pairing-code small { color: var(--muted); font-size: 11px; }.pairing-code strong { color: var(--accent); font: 700 28px/1 ui-monospace, monospace; letter-spacing: .22em; }.paired-devices { margin-top: 20px; }.section-label { margin-bottom: 9px; color: var(--ink); font-size: 12px; font-weight: 700; }.device-list { display: grid; gap: 7px; }.device-row { display: flex; align-items: center; justify-content: space-between; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; }.device-row strong, .device-row small { display: block; }.device-row strong { color: var(--ink); font-size: 12px; }.device-row small { margin-top: 3px; color: var(--muted); font-size: 10px; }
@media (max-width: 760px) { .settings-grid { grid-template-columns: 1fr; }.settings-card.wide { grid-column: auto; }.startup-options, .cache-metrics { grid-template-columns: 1fr; }.settings-actions { flex-wrap: wrap; }.lan-config-grid { grid-template-columns: 1fr; }.lan-diagnostics { padding-right: 14px; padding-bottom: 180px; }.lan-qr { top: auto; right: 50%; bottom: 12px; transform: translateX(50%); } }
</style>
