<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import type { FilmDetailDto, FilmGifResultDto } from '../../../shared/contracts';
import { mediaUrl } from '../../api';

const props = defineProps<{
  modelValue: boolean;
  film: FilmDetailDto;
  snapshot: { partId: string; filename: string; currentSeconds: number; durationSeconds: number } | null;
}>();
const emit = defineEmits<{ 'update:modelValue': [value: boolean]; change: [detail: FilmDetailDto] }>();
const preview = ref<HTMLVideoElement | null>(null);
const busy = ref(false);
const cancelling = ref(false);
const percent = ref(0);
const requestId = ref('');
const result = ref<FilmGifResultDto | null>(null);
const error = ref('');
const compatibility = ref(false);
const rangeSeconds = ref(5);
const rangeTrack = ref<HTMLElement | null>(null);
let drag: { pointerId: number; x: number; start: number; width: number } | null = null;
const form = reactive({ startSeconds: 0, endSeconds: 5, width: 480, fps: 12, setAsCover: true });
const source = computed(() => props.snapshot ? mediaUrl(compatibility.value ? 'part' : 'original-part', props.snapshot.partId) : '');
const duration = computed(() => props.snapshot?.durationSeconds ?? 0);
const valid = computed(() => duration.value > 0 && form.startSeconds >= 0 && form.endSeconds <= duration.value
  && form.endSeconds > form.startSeconds && form.endSeconds - form.startSeconds <= 30);
const savedUrl = computed(() => result.value ? mediaUrl('asset', result.value.assetId) : '');

watch(() => props.modelValue, (visible) => {
  if (!visible) {
    preview.value?.pause();
    if (busy.value && requestId.value) void window.filmLibrary.films.cancelGif(requestId.value);
    return;
  }
  if (busy.value) return;
  const current = props.snapshot?.currentSeconds ?? 0;
  rangeSeconds.value = Math.min(5, duration.value);
  moveRange(current);
  result.value = null;
  error.value = '';
  percent.value = 0;
  compatibility.value = false;

});
const unsubscribe = window.filmLibrary.films.onGifProgress((progress) => {
  if (progress.requestId === requestId.value) percent.value = progress.percent;
});
onMounted(() => window.addEventListener('keydown', handleKeydown, true));
onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleKeydown, true);
  unsubscribe();
  preview.value?.pause();
  if (busy.value && requestId.value) void window.filmLibrary.films.cancelGif(requestId.value);
});
function moveRange(start: number): void {
  const length = Math.max(0, Math.min(30, duration.value, Number(rangeSeconds.value) || 0));
  form.startSeconds = Math.max(0, Math.min(Number.isFinite(start) ? start : 0, duration.value - length));
  form.endSeconds = form.startSeconds + length;
}
watch(rangeSeconds, () => moveRange(form.startSeconds));
watch(() => [form.startSeconds, form.endSeconds], () => {
  if (props.modelValue && preview.value?.readyState) preview.value.currentTime = form.startSeconds;
});
function loaded(): void {
  if (!preview.value || !props.modelValue || busy.value || !valid.value) return;
  preview.value.currentTime = form.startSeconds;
  void preview.value.play().catch(() => undefined);
}
function fallback(): void {
  if (!compatibility.value) compatibility.value = true;
  else error.value = '片段预览无法播放，仍可尝试生成 GIF';
}
function timeUpdate(): void {
  const element = preview.value;
  if (!element || !props.modelValue || busy.value || !valid.value) return;
  if (element.currentTime >= form.endSeconds || element.currentTime < form.startSeconds) element.currentTime = form.startSeconds;
}
function ended(): void {
  if (!props.modelValue || busy.value || !valid.value || !preview.value) return;
  preview.value.currentTime = form.startSeconds;
  void preview.value.play().catch(() => undefined);
}
function togglePreview(): void {
  if (!preview.value || busy.value || !valid.value) return;
  if (preview.value.paused) void preview.value.play().catch(() => undefined);
  else preview.value.pause();
}
function handleKeydown(event: KeyboardEvent): void {
  if (!props.modelValue || !['Space', 'ArrowLeft', 'ArrowRight'].includes(event.code)) return;
  const target = event.target as HTMLElement | null;
  if (target?.closest('input, textarea, select, [contenteditable="true"], .el-select')) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (busy.value) return;
  if (event.code === 'Space') { if (!event.repeat) togglePreview(); }
  else moveRange(form.startSeconds + (event.code === 'ArrowLeft' ? -0.5 : 0.5));
}
function pointerDown(event: PointerEvent): void {
  if (busy.value || !valid.value || event.button !== 0 || !rangeTrack.value) return;
  const rect = rangeTrack.value.getBoundingClientRect();
  if (!rect.width) return;
  rangeTrack.value.focus();
  rangeTrack.value.setPointerCapture(event.pointerId);
  if (!(event.target as HTMLElement).closest('.gif-range-window')) moveRange((event.clientX - rect.left) / rect.width * duration.value - rangeSeconds.value / 2);
  drag = { pointerId: event.pointerId, x: event.clientX, start: form.startSeconds, width: rect.width };
  event.preventDefault();
}
function pointerMove(event: PointerEvent): void {
  if (!drag || drag.pointerId !== event.pointerId || busy.value) return;
  moveRange(Math.round((drag.start + (event.clientX - drag.x) / drag.width * duration.value) * 2) / 2);
}
function pointerEnd(): void { drag = null; }
async function generate(): Promise<void> {
  if (!valid.value || !props.snapshot || busy.value) return;
  preview.value?.pause();
  busy.value = true;
  cancelling.value = false;
  error.value = '';
  result.value = null;
  percent.value = 0;
  requestId.value = crypto.randomUUID();
  try {
    const response = await window.filmLibrary.films.createGif({ ...form, requestId: requestId.value,
      filmId: props.film.id, partId: props.snapshot.partId });
    if (!response.ok) {
      if (response.error.code === 'GIF_CANCELLED') ElMessage.info(response.error.message);
      else error.value = response.error.message;
      return;
    }
    result.value = response.data;
    emit('change', response.data.detail);
    ElMessage.success(form.setAsCover ? 'GIF 已保存并设为影片封面，已添加精彩片段“gif片段”' : 'GIF 已保存，已添加精彩片段“gif片段”');
  } catch { error.value = '截取请求失败，请重试'; }
  finally { busy.value = false; cancelling.value = false; requestId.value = ''; }
}
async function cancel(): Promise<void> {
  cancelling.value = true;
  const response = await window.filmLibrary.films.cancelGif(requestId.value);
  if (!response.ok) { cancelling.value = false; error.value = response.error.message; }
}
function close(done: () => void): void { if (!busy.value) done(); }
</script>

<template>
  <el-dialog
    :model-value="modelValue" title="截取 GIF" width="min(760px, 94vw)" top="5vh" append-to-body destroy-on-close
    :before-close="close" :close-on-click-modal="!busy" :close-on-press-escape="!busy" :show-close="!busy"
    @update:model-value="emit('update:modelValue', $event)">
    <div class="gif-capture">
      <p class="gif-help">{{ snapshot?.filename }} · 从原片截取，保存到当前影片文件的同级目录。VR 影片截取原始全景画面。</p>
      <video v-if="source" ref="preview" :src="source" controls preload="metadata" @loadedmetadata="loaded" @error="fallback" @timeupdate="timeUpdate" @seeked="timeUpdate" @ended="ended" />
      <div class="gif-range">
        <label>总时长（秒）<el-input-number v-model="rangeSeconds" :min="Math.min(0.1, duration)" :max="Math.min(30, duration)" :step="0.5" :precision="2" :disabled="busy" /></label>
        <span class="gif-help">{{ form.startSeconds.toFixed(2) }} → {{ form.endSeconds.toFixed(2) }} 秒</span>
      </div>
      <div
ref="rangeTrack" class="gif-range-track" :class="{ disabled: busy }" role="slider" :tabindex="busy ? -1 : 0"
        aria-label="移动 GIF 截取区间" :aria-valuemin="0" :aria-valuemax="Math.max(0, duration - rangeSeconds)"
        :aria-valuenow="form.startSeconds" :aria-valuetext="`${form.startSeconds.toFixed(2)} 到 ${form.endSeconds.toFixed(2)} 秒`" :aria-disabled="busy"
        @pointerdown="pointerDown" @pointermove="pointerMove" @pointerup="pointerEnd" @pointercancel="pointerEnd" @lostpointercapture="pointerEnd">
        <div class="gif-range-window" :style="{ left: `${duration ? form.startSeconds / duration * 100 : 0}%`, width: `${duration ? (form.endSeconds - form.startSeconds) / duration * 100 : 0}%` }"><i /><i /></div>
      </div>
      <p class="gif-help">拖动区间整体移动 · 自动循环播放 · 空格暂停 / 继续 · ← / → 每次移动 0.5 秒</p>
      <div class="gif-options">
        <label>宽度<el-select v-model="form.width" :disabled="busy"><el-option v-for="width in [320, 480, 640, 960, 1280]" :key="width" :label="`${width} 像素`" :value="width" /></el-select></label>
        <label>帧率<el-select v-model="form.fps" :disabled="busy"><el-option v-for="fps in [8, 10, 12, 15, 20, 24]" :key="fps" :label="`${fps} 帧/秒`" :value="fps" /></el-select></label>
        <el-checkbox v-model="form.setAsCover" :disabled="busy">生成后设为影片封面</el-checkbox>
      </div>
      <p class="gif-help">生成成功后，会将这段起止时间自动加入精彩片段，命名为“gif片段”。</p>
      <p v-if="!valid" class="gif-error">请填写有效的总时长，最长 30 秒且不能超过影片时长。</p>
      <p v-else class="gif-help">截取 {{ (form.endSeconds - form.startSeconds).toFixed(2) }} 秒 · 保持原片比例，高度最大 720 像素 · 尺寸和帧率越大，生成越慢、文件越大。</p>
      <el-progress v-if="busy" :percentage="percent" :indeterminate="percent === 0" />
      <p v-if="error" class="gif-error" role="alert">{{ error }}</p>
      <div v-if="result" class="gif-result"><img :src="savedUrl" alt="生成的 GIF 预览" /><p>已保存：{{ result.filename }}</p></div>
    </div>
    <template #footer>
      <el-button v-if="busy" :loading="cancelling" @click="cancel">取消生成</el-button>
      <el-button v-else @click="emit('update:modelValue', false)">关闭</el-button>
      <el-button type="primary" :disabled="!valid || busy" :loading="busy" @click="generate">{{ busy ? '正在生成' : '生成 GIF' }}</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.gif-capture { display: grid; gap: 14px; max-height: 65vh; overflow: auto; padding-right: 4px; }
.gif-capture video { width: 100%; max-height: 300px; background: #000; }
.gif-help { margin: 0; color: var(--subtle); font-size: 12px; overflow-wrap: anywhere; }
.gif-range, .gif-options { display: flex; align-items: end; flex-wrap: wrap; gap: 12px; }
.gif-range label, .gif-options label { display: grid; gap: 6px; }
.gif-range-track { position: relative; height: 28px; margin: 0 7px; border-radius: 6px; background: var(--el-fill-color-dark); cursor: pointer; touch-action: none; }
.gif-range-track:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: 3px; }
.gif-range-track.disabled { opacity: .5; cursor: not-allowed; }
.gif-range-window { position: absolute; top: 0; bottom: 0; background: var(--el-color-primary-light-5); border-radius: 4px; cursor: grab; }
.gif-range-window i { position: absolute; top: -3px; bottom: -3px; width: 8px; border-radius: 3px; background: var(--el-color-primary); transform: translateX(-50%); }
.gif-range-window i:last-child { left: 100%; }
.gif-options .el-select { width: 140px; }
.gif-error { margin: 0; color: var(--el-color-danger); }
.gif-result img { display: block; max-width: 100%; max-height: 260px; margin: auto; }
.gif-result p { font-size: 12px; overflow-wrap: anywhere; }
</style>
