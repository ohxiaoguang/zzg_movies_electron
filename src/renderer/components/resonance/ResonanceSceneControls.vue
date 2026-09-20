<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import { useResonanceStore, type ResonanceScene } from '../../stores/resonance';

const emit = defineEmits<{
  capture: [];
  switchScene: [id: string | null];
  deleteScene: [id: string];
}>();
const resonance = useResonanceStore();
const visible = ref(false);
const mode = ref<'manage' | 'save' | 'rename' | 'copy' | 'delete'>('manage');
const selectedId = ref('');
const name = ref('');
const error = ref('');
const nameInput = ref<{ focus: () => void } | null>(null);
const title = computed(() => ({ manage: '管理共鸣场景', save: '保存为共鸣场景', rename: '重命名场景', copy: '复制场景', delete: '删除场景' })[mode.value]);

function open(action: typeof mode.value, scene?: ResonanceScene): void {
  mode.value = action;
  selectedId.value = scene?.id ?? '';
  name.value = scene ? (action === 'copy' ? `${scene.name} 副本`.slice(0, 60) : scene.name) : '';
  error.value = '';
  visible.value = true;
  void nextTick(() => nameInput.value?.focus());
}

function confirm(): void {
  error.value = '';
  try {
    emit('capture');
    if (mode.value === 'save') resonance.saveSceneAs(name.value);
    else if (mode.value === 'rename') resonance.renameScene(selectedId.value, name.value);
    else if (mode.value === 'copy') resonance.duplicateScene(selectedId.value, name.value);
    else if (mode.value === 'delete') {
      emit('deleteScene', selectedId.value);
      if (resonance.scenes.some((scene) => scene.id === selectedId.value)) return;
    }
    visible.value = false;
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : '场景保存失败，请重试';
  }
}

function loadScene(id: string): void {
  emit('switchScene', id);
  visible.value = false;
}

function selectScene(event: Event): void {
  const select = event.target as HTMLSelectElement;
  emit('switchScene', select.value || null);
  select.value = resonance.activeSceneId ?? '';
}

function retrySave(): void {
  emit('capture');
  try { resonance.flush(); } catch { /* Keep the visible storage error. */ }
}
</script>

<template>
  <div class="resonance-scene-controls">
    <label for="resonance-scene-select">场景</label>
    <select id="resonance-scene-select" :value="resonance.activeSceneId ?? ''" aria-label="切换共鸣场景" @change="selectScene">
      <option value="">临时场景</option>
      <option v-for="scene in resonance.scenes" :key="scene.id" :value="scene.id">{{ scene.name }}（{{ scene.videos.length }}）</option>
    </select>
    <el-button class="scene-save-as" size="small" @click="open('save')">保存为场景</el-button>
    <el-button class="scene-manage" size="small" @click="open('manage')">管理场景</el-button>
    <small v-if="!resonance.storageError" class="scene-autosave">自动保存</small>
    <button v-else class="scene-save-error" type="button" :title="resonance.storageError" @click="retrySave">保存失败 · 重试</button>
  </div>

  <el-dialog v-model="visible" :title="title" width="560px" :z-index="4000" append-to-body class="resonance-scene-dialog" @keydown.stop>
    <template v-if="mode === 'manage'">
      <p class="scene-description">每套场景独立保存视频列表、顺序、播放位置和 VR 视角，使用时自动保存。</p>
      <div v-if="!resonance.scenes.length" class="scene-empty">还没有保存的场景。先把当前视频“保存为场景”。</div>
      <div v-else class="scene-list">
        <div v-for="scene in resonance.scenes" :key="scene.id" class="scene-row">
          <div class="scene-row-info"><strong :title="scene.name">{{ scene.name }}</strong><small>{{ scene.videos.length }} 个视频{{ scene.id === resonance.activeSceneId ? ' · 当前场景' : '' }}</small></div>
          <div class="scene-row-actions">
            <el-button size="small" :disabled="scene.id === resonance.activeSceneId" @click="loadScene(scene.id)">切换</el-button>
            <el-button size="small" @click="open('rename', scene)">重命名</el-button>
            <el-button size="small" @click="open('copy', scene)">复制</el-button>
            <el-button size="small" type="danger" plain @click="open('delete', scene)">删除</el-button>
          </div>
        </div>
      </div>
    </template>
    <template v-else-if="mode === 'delete'">
      <p>确定删除场景“{{ name }}”？此操作不会删除影片文件。</p>
      <p v-if="selectedId === resonance.activeSceneId" class="scene-description">删除当前场景后会返回之前的临时场景。</p>
    </template>
    <template v-else>
      <label class="scene-name-label" for="resonance-scene-name">场景名称</label>
      <el-input id="resonance-scene-name" ref="nameInput" v-model="name" maxlength="60" show-word-limit placeholder="例如：今晚待看、镜头对比" @keydown.enter.prevent="confirm" />
      <p v-if="mode === 'save'" class="scene-description">保存当前 {{ resonance.count }} 个视频，并切换到新场景。之后的播放进度和视频增减会自动保存。</p>
      <p v-if="mode === 'copy'" class="scene-description">复制后的场景独立保存，修改副本不会影响原场景。</p>
    </template>
    <p v-if="error || resonance.storageError" class="scene-error" role="alert">{{ error || resonance.storageError }}</p>
    <template #footer>
      <el-button @click="visible = false">{{ mode === 'manage' ? '关闭' : '取消' }}</el-button>
      <el-button v-if="mode !== 'manage'" :type="mode === 'delete' ? 'danger' : 'primary'" class="scene-confirm" @click="confirm">{{ mode === 'delete' ? '删除场景' : '保存' }}</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.resonance-scene-controls { display: flex; min-width: 0; align-items: center; flex-wrap: wrap; gap: 7px; }
.resonance-scene-controls label, .scene-autosave { color: #8fa49e; font-size: 11px; }
.resonance-scene-controls select { width: 180px; max-width: 28vw; padding: 6px 9px; border: 1px solid #354a43; border-radius: 6px; color: #edf5f2; background: #151f23; font: inherit; font-size: 12px; }
.resonance-scene-controls :deep(.el-button) { margin: 0; }
.scene-save-error { border: 0; padding: 0; color: #ffb4ab; background: transparent; cursor: pointer; font-size: 11px; }
.scene-description { margin: 0 0 16px; color: var(--el-text-color-secondary); line-height: 1.7; }
.scene-list { display: grid; gap: 12px; max-height: 50vh; overflow-y: auto; }
.scene-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 0; border-bottom: 1px solid var(--el-border-color); }
.scene-row-info { display: grid; gap: 5px; min-width: 0; }
.scene-row-info strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.scene-row-info small { color: var(--el-text-color-secondary); }
.scene-row-actions { display: flex; flex-shrink: 0; gap: 5px; }
.scene-row-actions :deep(.el-button) { margin: 0; }
.scene-name-label { display: block; margin-bottom: 10px; }
.scene-name-label ~ .scene-description { margin-top: 12px; }
.scene-error { color: var(--el-color-danger); }
.scene-empty { padding: 30px 0; color: var(--el-text-color-secondary); text-align: center; }
</style>
