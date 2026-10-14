<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import type { FilmDetailDto, FilmSegmentDto, VrViewDto } from '../../../shared/contracts';

const props = defineProps<{
  film: FilmDetailDto;
  currentSeconds: number;
  selectedPartId: string;
  captureVrView?: () => VrViewDto | null;
}>();
const emit = defineEmits<{
  change: [segments: FilmSegmentDto[]];
  play: [segment: FilmSegmentDto];
}>();

const saving = ref(false);
const confirmingSourceId = ref<string | null>(null);
const segments = ref<FilmSegmentDto[]>([]);
const draft = reactive({
  startSeconds: 0,
  endSeconds: 0,
  title: '',
  comment: '',
  includeInPreview: true,
  vrView: null as VrViewDto | null,
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
  draft.vrView = props.captureVrView?.() ?? null;
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
    const vrView = copyVrView(draft.vrView ?? props.captureVrView?.() ?? null);
    const result = await window.filmLibrary.films.createSegment({
      filmId: props.film.id,
      filmFileId: props.selectedPartId,
      startSeconds: draft.startSeconds,
      endSeconds: draft.endSeconds,
      title: draft.title,
      comment: draft.comment,
      includeInPreview: draft.includeInPreview,
      vrView,
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
  } catch (error) {
    console.error('[segments] failed to create segment', error);
    ElMessage.error(error instanceof Error ? error.message : '片段保存失败，请重试');
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

async function handleSegmentCommand(segment: FilmSegmentDto, command: string): Promise<void> {
  try {
    if (command === 'preview') await togglePreview(segment, !segment.includeInPreview);
    else if (command === 'confirm-source') await confirmSource(segment);
    else if (command === 'delete') await remove(segment);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '片段操作失败，请重试');
  }
}

async function confirmSource(segment: FilmSegmentDto): Promise<void> {
  if (confirmingSourceId.value) return;
  const filmId = props.film.id;
  confirmingSourceId.value = segment.id;
  try {
    const result = await window.filmLibrary.films.updateSegment({ id: segment.id, confirmSource: true });
    if (!result.ok) { ElMessage.error(result.error.message); return; }
    if (props.film.id !== filmId) return;
    const index = segments.value.findIndex((item) => item.id === segment.id);
    if (index >= 0) segments.value.splice(index, 1, result.data);
    emit('change', [...segments.value]);
    ElMessage.success('已确认时间点，提示已清除');
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '确认失败，请重试');
  } finally { confirmingSourceId.value = null; }
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
    vrView: props.captureVrView?.() ?? null,
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

function copyVrView(view: VrViewDto | null): VrViewDto | null {
  if (!view) return null;
  return {
    yawDegrees: Number(view.yawDegrees),
    pitchDegrees: Number(view.pitchDegrees),
    fovDegrees: Number(view.fovDegrees),
  };
}

defineExpose({ markStart, markEnd });
</script>

<template>
  <section class="segment-editor">
    <div class="segment-workspace">
      <div class="segment-compose">
        <div class="mark-controls">
          <button type="button" class="mark-button" :disabled="!selectedPart" title="将当前播放位置设为片段起点，快捷键 I" @click="markStart"><span>起点</span><kbd>I</kbd><strong>{{ formatTime(draft.startSeconds) }}</strong></button>
          <span class="range-separator" aria-hidden="true">→</span>
          <button type="button" class="mark-button" :disabled="!selectedPart" title="将当前播放位置设为片段终点，快捷键 O" @click="markEnd"><span>终点</span><kbd>O</kbd><strong>{{ formatTime(draft.endSeconds) }}</strong></button>
          <small class="draft-duration">时长 <strong>{{ formatTime(Math.max(0, draft.endSeconds - draft.startSeconds)) }}</strong></small>
        </div>

        <div class="segment-form">
          <el-input v-model="draft.title" size="small" maxlength="500" aria-label="片段标题" placeholder="片段标题（可选）" />
          <div class="segment-form-actions">
            <el-checkbox v-model="draft.includeInPreview" title="将此片段纳入精彩预览">精彩预览</el-checkbox>
            <el-button type="primary" size="small" :loading="saving" :disabled="!selectedPart" @click="save">
              添加片段
            </el-button>
          </div>
        </div>
      </div>

      <div class="segment-list">
        <div v-for="segment in segments" :key="segment.id" class="segment-row">
          <button class="segment-main" type="button" :title="`${segment.title || '未命名片段'} · ${formatTime(segment.startSeconds)} → ${formatTime(segment.endSeconds)} · ${segment.includeInPreview ? '已纳入精彩预览' : '未纳入精彩预览'}`" @click="emit('play', segment)">
            <i class="preview-status" :class="{ included: segment.includeInPreview }" aria-hidden="true" />
            <strong>{{ segment.title || '未命名片段' }}</strong>
            <span>{{ formatTime(segment.endSeconds - segment.startSeconds) }}</span>
            <em v-if="segment.sourceChanged" title="源文件已变化，请检查时间点" aria-label="源文件已变化，请检查时间点">!</em>
          </button>
          <el-dropdown class="segment-actions" trigger="click" placement="bottom-end" popper-class="segment-actions-menu" @command="(command: string) => handleSegmentCommand(segment, command)">
            <button type="button" class="segment-more-button" :aria-label="`${segment.title || '未命名片段'}的更多操作`" title="更多片段操作">⋯</button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="preview">{{ segment.includeInPreview ? '移出精彩预览' : '纳入精彩预览' }}</el-dropdown-item>
                <el-dropdown-item v-if="segment.sourceChanged" command="confirm-source" :disabled="Boolean(confirmingSourceId) || !availableParts.some((part) => part.id === segment.filmFileId)">时间点无误，清除提示</el-dropdown-item>
                <el-dropdown-item command="delete" divided class="segment-delete-command">删除</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>
        <p v-if="!segments.length" class="muted segment-empty">播放时按 I 标记起点、O 标记终点，再点击“添加片段”。</p>
      </div>
    </div>
  </section>
</template>

<style scoped>
.segment-editor { height: 100%; min-height: 0; padding: 6px 0; min-width: 0; container-type: inline-size; }
.muted { color: var(--muted); }
.segment-workspace { display: grid; height: 100%; min-height: 0; grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr); gap: 6px; min-width: 0; }
.segment-compose { display: flex; min-width: 0; align-items: center; gap: 12px; }
.mark-controls { display: flex; flex: 0 0 auto; align-items: center; gap: 6px; }
.mark-button { display: inline-flex; height: 32px; padding: 0 8px; align-items: center; gap: 6px; border: 1px solid rgba(255,255,255,.15); border-radius: 6px; color: var(--ink); background: var(--panel-raised); font: inherit; font-size: 11px; cursor: pointer; white-space: nowrap; }
.mark-button strong { color: var(--accent); font-weight: 550; font-variant-numeric: tabular-nums; }
.mark-button kbd { padding: 1px 4px; border: 1px solid var(--line); border-radius: 3px; color: var(--muted); font: inherit; font-size: 10px; }
.mark-button:hover:not(:disabled) { border-color: var(--accent); }
.mark-button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.mark-button:disabled { opacity: .45; cursor: not-allowed; }
.range-separator { color: var(--subtle); font-size: 12px; }
.draft-duration { display: flex; align-items: center; gap: 5px; padding-left: 2px; color: var(--muted); font-size: 10px; white-space: nowrap; }
.draft-duration strong { font-weight: 500; font-variant-numeric: tabular-nums; }
.segment-form { display: flex; flex: 1 1 0; min-width: 0; align-items: center; gap: 10px; }
.segment-form :deep(.el-input) { min-width: 110px; flex: 1 1 0; }
.segment-form :deep(.el-input__wrapper) { height: 32px; border-radius: 6px; }
.segment-form-actions { display: flex; flex: 0 0 auto; align-items: center; gap: 10px; }
.segment-form-actions :deep(.el-checkbox) { height: 32px; margin: 0; }
.segment-form-actions :deep(.el-checkbox__label) { font-size: 11px; }
.segment-form-actions :deep(.el-button) { height: 32px; margin: 0; padding: 0 12px; border-radius: 6px; }
.segment-list { display: grid; min-width: 0; min-height: 0; grid-template-columns: repeat(auto-fill, minmax(min(100%, 200px), 1fr)); grid-auto-rows: 28px; align-content: start; gap: 4px 6px; overflow-x: hidden; overflow-y: auto; scrollbar-width: thin; }
.segment-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 5px; min-width: 0; padding: 2px 6px; border: 1px solid var(--line); border-radius: 7px; background: rgba(255,255,255,.025); }
.segment-row:hover { border-color: rgba(152,227,194,.35); }
.segment-main { display: flex; min-width: 0; padding: 0; align-items: center; gap: 5px; border: 0; color: inherit; background: none; text-align: left; cursor: pointer; }
.segment-main strong { min-width: 0; flex: 1 1 0; overflow: hidden; font-size: 11px; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
.segment-main span { flex: 0 0 auto; overflow: hidden; color: var(--muted); font-size: 10px; font-variant-numeric: tabular-nums; text-overflow: ellipsis; white-space: nowrap; }
.segment-main em { display: inline-flex; flex: 0 0 auto; width: 12px; height: 12px; align-items: center; justify-content: center; border: 1px solid #f2b56b; border-radius: 50%; color: #f2b56b; font-size: 9px; font-style: normal; font-weight: 700; }
.preview-status { width: 5px; height: 5px; flex: 0 0 auto; border-radius: 50%; background: var(--subtle); }
.preview-status.included { background: var(--accent); }
.segment-actions { display: inline-flex; align-items: center; }
.segment-more-button { display: inline-flex; width: 24px; height: 22px; padding: 0; align-items: center; justify-content: center; border: 0; border-radius: 4px; color: var(--muted); background: transparent; font: inherit; font-size: 18px; line-height: 1; cursor: pointer; }
.segment-more-button:hover, .segment-more-button[aria-expanded="true"] { color: var(--accent); background: rgba(152,227,194,.1); }
.segment-more-button:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
:global(.segment-actions-menu.el-popper), :global(.segment-actions-menu .el-dropdown-menu), :global(.segment-actions-menu .el-popper__arrow::before) { background: var(--panel-raised); border-color: var(--line); }
:global(.segment-actions-menu .el-dropdown-menu__item) { color: var(--ink); font-size: 12px; }
:global(.segment-actions-menu .el-dropdown-menu__item:not(.is-disabled):hover), :global(.segment-actions-menu .el-dropdown-menu__item:not(.is-disabled):focus) { color: var(--accent); background: rgba(152,227,194,.1); }
:global(.segment-actions-menu .el-dropdown-menu__item.is-disabled) { color: var(--subtle); }
:global(.segment-actions-menu .segment-delete-command) { color: #ff9b9b; }
:global(.segment-actions-menu .el-dropdown-menu__item--divided) { border-top-color: var(--line); }
.segment-empty { grid-column: 1 / -1; width: 100%; margin: 0; padding: 6px 8px; border: 1px dashed var(--line); border-radius: 7px; font-size: 11px; text-align: center; }
@container (max-width: 860px) {
  .segment-compose { flex-direction: column; align-items: stretch; gap: 6px; }
  .segment-form { flex: none; }
}
@container (max-width: 400px) {
  .mark-controls { flex-wrap: wrap; }
  .draft-duration { margin-left: auto; }
  .segment-form { flex-wrap: wrap; }
  .segment-form :deep(.el-input) { flex-basis: 100%; }
  .segment-form-actions { width: 100%; justify-content: space-between; }
}
</style>
