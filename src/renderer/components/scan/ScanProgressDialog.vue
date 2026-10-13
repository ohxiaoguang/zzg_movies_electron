<script setup lang="ts">
import { computed, ref } from 'vue';
import type { ScanStatusDto, ScanIssueType } from '../../../shared/contracts';

import ScanIssuesDialog from './ScanIssuesDialog.vue';

const issuesVisible = ref(false);
const issueType = ref<ScanIssueType | undefined>();
function openIssues(type?: ScanIssueType): void { issueType.value = type; issuesVisible.value = true; }
const props = defineProps<{ modelValue: boolean; progress: ScanStatusDto | null }>();
const emit = defineEmits<{ 'update:modelValue': [value: boolean]; cancel: []; close: [] }>();
const hasIssues = computed(() => !!props.progress && (props.progress.issueCount ?? props.progress.nfoErrors + props.progress.ambiguousAssets + props.progress.otherErrors + props.progress.missing) > 0);
const running = computed(() => props.progress?.status === 'running');
const progressPercent = computed(() => props.progress?.status === 'completed' && props.progress.otherErrors === 0 ? 100 : props.progress && props.progress.discovered > 0 ? Math.min(100, Math.round((props.progress.processed / props.progress.discovered) * 100)) : 0);
const statusText = computed(() => {
  const value = props.progress;
  if (!value) return '';
  if (running.value) return value.message || (value.phase === 'merging' ? '正在写入影库…' : value.phase === 'parsing' ? '正在解析影片资料…' : '正在发现影片文件…');
  if (value.status === 'completed' && hasIssues.value) return '扫描完成，有问题需要检查';
  return value.message || (value.status === 'completed' ? '扫描完成' : value.status === 'database_failed' ? '数据库合并失败' : '扫描已停止');
});
function close(): void { emit('update:modelValue', false); emit('close'); }
</script>

<template>
  <el-dialog :model-value="modelValue" width="520px" :close-on-click-modal="false" :show-close="!running" :title="running ? '正在扫描影片来源' : '扫描结果'" @close="close">
    <template v-if="progress">
      <div class="scan-status"><span class="pulse" :class="{ done: !running }" />{{ statusText }}</div>
      <el-progress :percentage="progressPercent" :status="running ? undefined : progress.status === 'completed' && !hasIssues ? 'success' : 'warning'" />
      <div v-if="running" class="scan-current"><span>{{ progress.currentSource || '—' }}</span><span>{{ progress.currentDirectory || '—' }}</span><strong>{{ progress.currentFilm || '等待中' }}</strong></div>
      <div class="scan-metrics"><div><strong>{{ progress.discovered }}</strong><span>已发现</span></div><div><strong>{{ progress.processed }}</strong><span>已处理</span></div><div><strong>{{ progress.created }}</strong><span>新增</span></div><div><strong>{{ progress.updated }}</strong><span>更新</span></div><div><strong>{{ progress.moved }}</strong><span>移动</span></div><button type="button" :disabled="running || !progress.missing" @click="openIssues('missing')"><strong>{{ progress.missing }}</strong><span>缺失 ↗</span></button><button type="button" :disabled="running || !progress.nfoErrors" @click="openIssues('nfo')"><strong>{{ progress.nfoErrors }}</strong><span>NFO 错误 ↗</span></button><button type="button" :disabled="running || !progress.ambiguousAssets" @click="openIssues('asset')"><strong>{{ progress.ambiguousAssets }}</strong><span>资源歧义 ↗</span></button><button type="button" :disabled="running || !progress.otherErrors" @click="openIssues()"><strong>{{ progress.otherErrors }}</strong><span>其他错误 ↗</span></button></div>
    </template>
    <el-empty v-else description="还没有扫描任务" />
    <template #footer><el-button v-if="progress && !running" @click="openIssues()">查看扫描问题</el-button><el-button v-if="running" @click="emit('cancel')">取消扫描</el-button><el-button v-else type="primary" @click="close">关闭</el-button></template>
  </el-dialog>
  <ScanIssuesDialog v-if="progress" v-model="issuesVisible" :job-id="progress.jobId" :initial-type="issueType" />
</template>

<style scoped>
.scan-status { display: flex; align-items: center; gap: 8px; margin-bottom: 18px; color: var(--ink); font-size: 13px; }
.pulse { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 5px rgba(152,227,194,.12); animation: pulse 1.3s infinite; }
.pulse.done { animation: none; background: var(--warm); }
.scan-current { display: grid; gap: 6px; margin-top: 18px; color: var(--muted); font-size: 12px; }
.scan-current strong { color: var(--ink); }
.scan-metrics { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-top: 18px; }
.scan-metrics div, .scan-metrics button { padding: 11px 6px; border-radius: 8px; text-align: center; background: rgba(255,255,255,.04); }
.scan-metrics button { border: 1px solid rgba(238,188,105,.25); cursor: pointer; color: inherit; font: inherit; }
.scan-metrics button:disabled { cursor: default; border-color: transparent; }
.scan-metrics button:not(:disabled):hover { background: rgba(238,188,105,.1); }
.scan-metrics strong, .scan-metrics span { display: block; }
.scan-metrics strong { color: var(--accent); font-size: 18px; }
.scan-metrics span { margin-top: 4px; color: var(--muted); font-size: 10px; }
@keyframes pulse { 50% { box-shadow: 0 0 0 8px rgba(152,227,194,0); } }
</style>
