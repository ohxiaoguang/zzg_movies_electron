<script setup lang="ts">
import { computed } from 'vue';
import type { ScanStatusDto } from '../../../shared/contracts';

const props = defineProps<{ modelValue: boolean; progress: ScanStatusDto | null }>();
const emit = defineEmits<{ 'update:modelValue': [value: boolean]; cancel: []; close: [] }>();
const running = computed(() => props.progress?.status === 'running');
const progressPercent = computed(() => props.progress && props.progress.discovered > 0 ? Math.min(100, Math.round((props.progress.processed / props.progress.discovered) * 100)) : 0);
function close(): void { emit('update:modelValue', false); emit('close'); }
</script>

<template>
  <el-dialog :model-value="modelValue" width="520px" :close-on-click-modal="false" :show-close="!running" title="正在扫描影片来源" @close="close">
    <template v-if="progress">
      <div class="scan-status"><span class="pulse" :class="{ done: !running }" />{{ progress.message || (running ? '正在发现和解析影片…' : progress.status === 'completed' ? '扫描完成' : '扫描已停止') }}</div>
      <el-progress :percentage="progressPercent" :status="running ? undefined : progress.status === 'completed' ? 'success' : 'warning'" />
      <div class="scan-current"><span>{{ progress.currentSource || '—' }}</span><span>{{ progress.currentDirectory || '—' }}</span><strong>{{ progress.currentFilm || '等待中' }}</strong></div>
      <div class="scan-metrics"><div><strong>{{ progress.discovered }}</strong><span>已发现</span></div><div><strong>{{ progress.processed }}</strong><span>已处理</span></div><div><strong>{{ progress.created }}</strong><span>新增</span></div><div><strong>{{ progress.updated }}</strong><span>更新</span></div><div><strong>{{ progress.moved }}</strong><span>移动</span></div><div><strong>{{ progress.missing }}</strong><span>缺失</span></div><div><strong>{{ progress.nfoErrors }}</strong><span>NFO 错误</span></div><div><strong>{{ progress.ambiguousAssets }}</strong><span>资源歧义</span></div></div>
    </template>
    <el-empty v-else description="还没有扫描任务" />
    <template #footer><el-button v-if="running" @click="emit('cancel')">取消扫描</el-button><el-button v-else type="primary" @click="close">关闭</el-button></template>
  </el-dialog>
</template>

<style scoped>
.scan-status { display: flex; align-items: center; gap: 8px; margin-bottom: 18px; color: var(--ink); font-size: 13px; }
.pulse { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 5px rgba(152,227,194,.12); animation: pulse 1.3s infinite; }
.pulse.done { animation: none; background: var(--warm); }
.scan-current { display: grid; gap: 6px; margin-top: 18px; color: var(--muted); font-size: 12px; }
.scan-current strong { color: var(--ink); }
.scan-metrics { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-top: 18px; }
.scan-metrics div { padding: 11px 6px; border-radius: 8px; text-align: center; background: rgba(255,255,255,.04); }
.scan-metrics strong, .scan-metrics span { display: block; }
.scan-metrics strong { color: var(--accent); font-size: 18px; }
.scan-metrics span { margin-top: 4px; color: var(--muted); font-size: 10px; }
@keyframes pulse { 50% { box-shadow: 0 0 0 8px rgba(152,227,194,0); } }
</style>
