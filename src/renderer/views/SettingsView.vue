<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { FolderOpened, Setting, VideoCamera } from '@element-plus/icons-vue';
import type { AppInfoDto, SettingsDto } from '../../shared/contracts';
import { useLibraryStore } from '../stores/library';

const library = useLibraryStore();
const info = ref<AppInfoDto | null>(null);
const form = reactive<SettingsDto>({ cardSize: 220, hoverDelayMs: 450, slideshowIntervalMs: 1200, pageSize: 60, videoExtensions: [], imageExtensions: [], ignoredDirectories: [], autoScanOnStartup: false, ffprobePath: '' });
const saving = ref(false);
const ffprobeResult = ref<string | null>(null);

onMounted(async () => {
  try {
    const [settings, appInfo] = await Promise.all([window.filmLibrary.settings.get(), window.filmLibrary.app.info()]);
    if (settings.ok) Object.assign(form, settings.data);
    if (appInfo.ok) info.value = appInfo.data;
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
      ffprobePath: form.ffprobePath,
    };
    const result = await window.filmLibrary.settings.update(input);
    if (result.ok) { Object.assign(form, result.data); library.settings = result.data; ElMessage.success('设置已保存'); }
    else ElMessage.error(result.error.message);
  } catch (error) {
    console.error('[settings] save failed', error);
    ElMessage.error('设置保存失败，请查看日志');
  } finally {
    saving.value = false;
  }
}
async function testFfprobe(): Promise<void> { const result = await window.filmLibrary.settings.testFfprobe(form.ffprobePath); if (result.ok) { ffprobeResult.value = result.data.message + (result.data.version ? ' · ' + result.data.version : ''); ElMessage.success(ffprobeResult.value); } else { ffprobeResult.value = result.error.message; ElMessage.warning(result.error.message); } }
async function openFolder(kind: 'data' | 'logs'): Promise<void> { const result = kind === 'data' ? await window.filmLibrary.app.openDataFolder() : await window.filmLibrary.app.openLogsFolder(); if (!result.ok) ElMessage.error(result.error.message); }
function listText(values: string[]): string { return values.join(', '); }
function parseList(value: string): string[] { return value.split(/[,，\n]/).map((item) => item.trim()).filter(Boolean); }
function updateVideoExtensions(value: string): void { form.videoExtensions = parseList(value); }
function updateImageExtensions(value: string): void { form.imageExtensions = parseList(value); }
function updateIgnoredDirectories(value: string): void { form.ignoredDirectories = parseList(value); }
</script>

<template>
  <div class="page-wrap settings-page"><div class="page-heading"><div><div class="eyebrow">LOCAL CONFIGURATION</div><h1 class="page-title">设置</h1><p class="page-caption">调整本地目录、扫描和悬浮预览行为。</p></div><el-button type="primary" :loading="saving" @click="save">保存设置</el-button></div>
    <div class="settings-grid"><section class="settings-card"><div class="settings-title"><Setting /><span>应用数据</span></div><div class="data-row"><span>数据库位置</span><code>{{ info?.databasePath || '读取中…' }}</code></div><div class="data-row"><span>日志目录</span><code>{{ info?.logsDirectory || '读取中…' }}</code></div><div class="settings-actions\"><el-button size="small" @click="openFolder('data')"><FolderOpened />打开数据目录</el-button><el-button size="small" @click="openFolder('logs')">打开日志目录</el-button></div></section>
      <section class="settings-card"><div class="settings-title"><VideoCamera /><span>卡片与预览</span></div><div class="setting-row"><label>默认卡片宽度</label><el-input-number v-model="form.cardSize" :min="140" :max="320" :step="10" /><span>px</span></div><div class="setting-row"><label>悬浮延迟</label><el-input-number v-model="form.hoverDelayMs" :min="100" :max="3000" :step="50" /><span>ms</span></div><div class="setting-row"><label>图片轮播间隔</label><el-input-number v-model="form.slideshowIntervalMs" :min="500" :max="10000" :step="100" /><span>ms</span></div><div class="setting-row"><label>每页数量</label><el-input-number v-model="form.pageSize" :min="12" :max="200" :step="12" /></div></section>
      <section class="settings-card wide"><div class="settings-title"><span>扫描选项</span></div><div class="setting-row"><label>启动时自动扫描</label><el-switch v-model="form.autoScanOnStartup" /><span class="muted">默认关闭，避免外部磁盘未就绪时误判</span></div><el-form label-position="top"><el-form-item label="影片扩展名"><el-input :model-value="listText(form.videoExtensions)" @update:model-value="updateVideoExtensions" /></el-form-item><el-form-item label="图片扩展名"><el-input :model-value="listText(form.imageExtensions)" @update:model-value="updateImageExtensions" /></el-form-item><el-form-item label="忽略目录"><el-input type="textarea" :rows="3" :model-value="listText(form.ignoredDirectories)" @update:model-value="updateIgnoredDirectories" /></el-form-item></el-form></section>
      <section class="settings-card wide"><div class="settings-title"><span>可选 ffprobe / ffmpeg</span><span class="muted">MKV 兼容缓存会查找 ffprobe 同目录或系统 PATH 中的 ffmpeg</span></div><el-input v-model="form.ffprobePath" placeholder="留空则尝试使用 PATH 中的 ffprobe；MKV 预览还需要 ffmpeg"><template #append><el-button @click="testFfprobe">测试 ffprobe</el-button></template></el-input><p v-if="ffprobeResult" class="test-result">{{ ffprobeResult }}</p></section>
    </div>
  </div>
</template>

<style scoped>
.settings-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; max-width: 1000px; }.settings-card { padding: 20px; border: 1px solid var(--line); border-radius: 14px; background: rgba(21,24,33,.8); }.settings-card.wide { grid-column: 1 / -1; }.settings-title { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 20px; color: var(--ink); font-size: 13px; font-weight: 750; }.settings-title svg { width: 17px; color: var(--accent); }.data-row { display: grid; grid-template-columns: 92px 1fr; gap: 10px; margin: 12px 0; color: var(--muted); font-size: 11px; }.data-row code { overflow: hidden; color: #b9c1d0; text-overflow: ellipsis; white-space: nowrap; }.settings-actions { display: flex; gap: 8px; margin-top: 18px; }.settings-actions svg { width: 13px; margin-right: 5px; }.setting-row { display: flex; align-items: center; gap: 9px; margin: 14px 0; color: var(--muted); font-size: 12px; }.setting-row label { width: 120px; color: var(--ink); }.setting-row .el-input-number { width: 130px; }.setting-row .muted { margin-left: 8px; }.settings-card :deep(.el-form-item) { margin-bottom: 15px; }.test-result { margin: 11px 0 0; color: var(--accent); font-size: 12px; }
</style>
