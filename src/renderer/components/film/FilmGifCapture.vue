<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue';
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
const previewingRange = ref(false);
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
  form.startSeconds = Math.max(0, Math.min(current, duration.value - 0.1));
  form.endSeconds = Math.min(duration.value, form.startSeconds + 5);
  result.value = null;
  error.value = '';
  percent.value = 0;
  compatibility.value = false;
  previewingRange.value = false;
});
const unsubscribe = window.filmLibrary.films.onGifProgress((progress) => {
  if (progress.requestId === requestId.value) percent.value = progress.percent;
});
onBeforeUnmount(() => {
  unsubscribe();
  preview.value?.pause();
  if (busy.value && requestId.value) void window.filmLibrary.films.cancelGif(requestId.value);
});
function loaded(): void {
  if (preview.value) preview.value.currentTime = form.startSeconds;
}
function fallback(): void {
  if (!compatibility.value) compatibility.value = true;
  else error.value = '片段预览无法播放，仍可尝试生成 GIF';
}
function markStart(): void { if (preview.value) form.startSeconds = Math.round(preview.value.currentTime * 100) / 100; }
function markEnd(): void { if (preview.value) form.endSeconds = Math.min(duration.value, Math.round(preview.value.currentTime * 100) / 100); }
async function previewRange(): Promise<void> {
  if (!preview.value || !valid.value) return;
  preview.value.currentTime = form.startSeconds;
  previewingRange.value = true;
  await preview.value.play().catch(() => { previewingRange.value = false; });
}
function timeUpdate(): void {
  if (previewingRange.value && preview.value && preview.value.currentTime >= form.endSeconds) {
    preview.value.pause(); previewingRange.value = false;
  }
}
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
      <video v-if="source" ref="preview" :src="source" controls preload="metadata" @loadedmetadata="loaded" @error="fallback" @timeupdate="timeUpdate" />
      <div class="gif-range">
        <label>起点（秒）<el-input-number v-model="form.startSeconds" :min="0" :max="duration" :step="0.1" :precision="2" :disabled="busy" /></label>
        <el-button :disabled="busy" @click="markStart">当前画面设为起点</el-button>
        <label>终点（秒）<el-input-number v-model="form.endSeconds" :min="0" :max="duration" :step="0.1" :precision="2" :disabled="busy" /></label>
        <el-button :disabled="busy" @click="markEnd">当前画面设为终点</el-button>
      </div>
      <div class="gif-options">
        <label>宽度<el-select v-model="form.width" :disabled="busy"><el-option v-for="width in [320, 480, 640, 960, 1280]" :key="width" :label="`${width} 像素`" :value="width" /></el-select></label>
        <label>帧率<el-select v-model="form.fps" :disabled="busy"><el-option v-for="fps in [8, 10, 12, 15, 20, 24]" :key="fps" :label="`${fps} 帧/秒`" :value="fps" /></el-select></label>
        <el-checkbox v-model="form.setAsCover" :disabled="busy">生成后设为影片封面</el-checkbox>
      </div>
      <p class="gif-help">生成成功后，会将这段起止时间自动加入精彩片段，命名为“gif片段”。</p>
      <p v-if="!valid" class="gif-error">请选择有效的起点和终点，片段最长 30 秒。</p>
      <p v-else class="gif-help">截取 {{ (form.endSeconds - form.startSeconds).toFixed(2) }} 秒 · 保持原片比例，高度最大 720 像素 · 尺寸和帧率越大，生成越慢、文件越大。</p>
      <el-progress v-if="busy" :percentage="percent" :indeterminate="percent === 0" />
      <p v-if="error" class="gif-error" role="alert">{{ error }}</p>
      <div v-if="result" class="gif-result"><img :src="savedUrl" alt="生成的 GIF 预览" /><p>已保存：{{ result.filename }}</p></div>
    </div>
    <template #footer>
      <el-button v-if="busy" :loading="cancelling" @click="cancel">取消生成</el-button>
      <el-button v-else @click="emit('update:modelValue', false)">关闭</el-button>
      <el-button :disabled="!valid || busy" @click="previewRange">预览片段</el-button>
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
.gif-options .el-select { width: 140px; }
.gif-error { margin: 0; color: var(--el-color-danger); }
.gif-result img { display: block; max-width: 100%; max-height: 260px; margin: auto; }
.gif-result p { font-size: 12px; overflow-wrap: anywhere; }
</style>
