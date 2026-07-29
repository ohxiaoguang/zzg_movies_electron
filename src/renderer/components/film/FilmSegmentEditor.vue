<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import type { FilmDetailDto, FilmSegmentDto } from '../../../shared/contracts';

const props = defineProps<{
  film: FilmDetailDto;
  currentSeconds: number;
  selectedPartId: string;
}>();
const emit = defineEmits<{
  change: [segments: FilmSegmentDto[]];
  play: [segment: FilmSegmentDto];
}>();

const saving = ref(false);
const segments = ref<FilmSegmentDto[]>([]);
const draft = reactive({
  startSeconds: 0,
  endSeconds: 0,
  title: '',
  comment: '',
  includeInPreview: true,
});

const availableParts = computed(() => props.film.parts.filter((part) => !part.missing));
const selectedPart = computed(() => availableParts.value.find((part) => part.id === props.selectedPartId) ?? null);
watch(() => props.film.id, () => {
  segments.value = [...props.film.segments];
  resetDraft();
}, { immediate: true });
watch(() => props.film.segments, (value) => { segments.value = [...value]; });

function markStart(): void {
  draft.startSeconds = roundSeconds(props.currentSeconds);
  if (draft.endSeconds <= draft.startSeconds) draft.endSeconds = roundSeconds(draft.startSeconds + 10);
}

function markEnd(): void {
  draft.endSeconds = roundSeconds(props.currentSeconds);
  if (draft.endSeconds <= draft.startSeconds) {
    ElMessage.warning('结束时间必须晚于开始时间');
  }
}

async function save(): Promise<void> {
  if (!props.selectedPartId || saving.value) return;
  if (!(draft.endSeconds > draft.startSeconds)) {
    ElMessage.warning('请先设置有效的开始和结束时间');
    return;
  }
  saving.value = true;
  try {
    const result = await window.filmLibrary.films.createSegment({
      filmId: props.film.id,
      filmFileId: props.selectedPartId,
      startSeconds: draft.startSeconds,
      endSeconds: draft.endSeconds,
      title: draft.title,
      comment: draft.comment,
      includeInPreview: draft.includeInPreview,
    });
    if (!result.ok) {
      ElMessage.error(result.error.message);
      return;
    }
    segments.value.push(result.data);
    sortSegments();
    emit('change', [...segments.value]);
    ElMessage.success('片段已添加');
    resetDraft();
  } finally {
    saving.value = false;
  }
}

async function togglePreview(segment: FilmSegmentDto, value: boolean): Promise<void> {
  const result = await window.filmLibrary.films.updateSegment({ id: segment.id, includeInPreview: value });
  if (!result.ok) {
    ElMessage.error(result.error.message);
    return;
  }
  const index = segments.value.findIndex((item) => item.id === segment.id);
  if (index >= 0) segments.value.splice(index, 1, result.data);
  emit('change', [...segments.value]);
}

async function remove(segment: FilmSegmentDto): Promise<void> {
  try {
    await ElMessageBox.confirm('删除这条片段标注？原始影片不会受到影响。', '删除片段', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    });
  } catch {
    return;
  }
  const result = await window.filmLibrary.films.deleteSegment(segment.id);
  if (!result.ok) {
    ElMessage.error(result.error.message);
    return;
  }
  segments.value = segments.value.filter((item) => item.id !== segment.id);
  emit('change', [...segments.value]);
}

function resetDraft(): void {
  Object.assign(draft, {
    startSeconds: roundSeconds(props.currentSeconds),
    endSeconds: roundSeconds(props.currentSeconds + 10),
    title: '',
    comment: '',
    includeInPreview: true,
  });
}

function sortSegments(): void {
  const partOrder = new Map(props.film.parts.map((part, index) => [part.id, index]));
  segments.value.sort((left, right) => (
    (partOrder.get(left.filmFileId) ?? 0) - (partOrder.get(right.filmFileId) ?? 0)
    || left.startSeconds - right.startSeconds
  ));
}

function formatTime(value: number): string {
  const seconds = Math.max(0, Math.round(value));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return [hours, minutes, rest].map((part) => String(part).padStart(2, '0')).join(':');
}

function roundSeconds(value: number): number {
  return Math.round(Math.max(0, value) * 1000) / 1000;
}

defineExpose({ markStart, markEnd });
</script>

<template>
  <section class="segment-editor">
    <div class="segment-workspace">
      <div class="segment-compose">
        <div class="mark-controls">
          <el-button size="small" @click="markStart">设置起点 I</el-button>
          <span>{{ formatTime(draft.startSeconds) }}</span>
          <el-button size="small" @click="markEnd">设置终点 O</el-button>
          <span>{{ formatTime(draft.endSeconds) }}</span>
          <small>时长 {{ formatTime(Math.max(0, draft.endSeconds - draft.startSeconds)) }}</small>
        </div>

        <div class="segment-form">
          <el-input v-model="draft.title" size="small" maxlength="500" placeholder="片段标题，例如：精彩追逐戏" />
          <div class="segment-form-actions">
            <el-checkbox v-model="draft.includeInPreview">纳入精彩预览</el-checkbox>
            <span />
            <el-button type="primary" size="small" :loading="saving" :disabled="!selectedPart" @click="save">
              添加片段
            </el-button>
          </div>
        </div>
      </div>

      <div class="segment-list">
        <div v-for="segment in segments" :key="segment.id" class="segment-row">
          <button class="segment-main" type="button" @click="emit('play', segment)">
            <strong>{{ segment.title || '未命名片段' }}</strong>
            <span>{{ formatTime(segment.endSeconds - segment.startSeconds) }}</span>
            <em v-if="segment.sourceChanged">源文件已变化，请检查时间点</em>
          </button>
          <div class="segment-actions">
            <el-checkbox :model-value="segment.includeInPreview" @change="togglePreview(segment, Boolean($event))">预览</el-checkbox>
            <el-button text size="small" type="danger" @click="remove(segment)">删除</el-button>
          </div>
        </div>
        <p v-if="!segments.length" class="muted segment-empty">还没有片段。播放影片后，用 I/O 快速标记开始和结束。</p>
      </div>
    </div>
  </section>
</template>

<style scoped>
.segment-editor { display: grid; padding: 4px 0; }
.muted { overflow: hidden; color: var(--muted); text-overflow: ellipsis; white-space: nowrap; }
.segment-workspace { display: grid; grid-template-columns: minmax(300px, .8fr) minmax(380px, 1.2fr); align-items: start; gap: 10px; }
.segment-compose { display: grid; gap: 6px; }
.mark-controls { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.mark-controls > span { min-width: 68px; color: var(--accent); font-variant-numeric: tabular-nums; }
.mark-controls small { color: var(--muted); }
.segment-form { display: grid; gap: 6px; padding: 8px; border: 1px solid var(--line); border-radius: 8px; background: rgba(21,24,33,.5); }
.segment-form-actions { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 8px; }
.segment-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); max-height: 116px; gap: 5px; overflow: auto; }
.segment-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 5px; min-width: 0; padding: 4px 6px; border: 1px solid var(--line); border-radius: 7px; }
.segment-main { display: flex; min-width: 0; padding: 0; align-items: baseline; justify-content: space-between; gap: 6px; border: 0; color: inherit; background: none; text-align: left; cursor: pointer; }
.segment-main strong { overflow: hidden; font-size: 10px; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
.segment-main span { flex: 0 0 auto; color: var(--muted); font-size: 9px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.segment-main em { color: #f2b56b; font-size: 11px; font-style: normal; }
.segment-actions { display: flex; align-items: center; font-size: 9px; }
.segment-actions :deep(.el-checkbox) { height: 22px; margin-right: 2px; }
.segment-actions :deep(.el-checkbox__label) { padding-left: 3px; font-size: 9px; }
.segment-actions :deep(.el-button) { padding-inline: 3px; font-size: 9px; }
.segment-empty { grid-column: 1 / -1; padding: 12px 0; text-align: center; }
@media (max-width: 1100px) {
  .segment-workspace { align-items: stretch; grid-template-columns: 1fr; }
  .segment-list { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .segment-actions { justify-content: flex-end; }
}
</style>
