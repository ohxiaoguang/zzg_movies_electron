<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { Delete, Edit, FolderOpened, Plus, Refresh, Operation } from '@element-plus/icons-vue';
import type { MediaSourceDto } from '../../shared/contracts';
import { useSourceStore } from '../stores/sources';
import { useScanStore } from '../stores/scan';

const sourceStore = useSourceStore();
const scan = useScanStore();
const dialogVisible = ref(false);
const removeVisible = ref(false);
const editingId = ref<string | null>(null);
const removing = ref<MediaSourceDto | null>(null);
const saving = ref(false);
const removeMode = ref<'archive' | 'delete'>('archive');
const form = reactive({ name: '', rootPath: '', enabled: true, recursive: true });

onMounted(() => void sourceStore.fetch());

function openCreate(): void { editingId.value = null; Object.assign(form, { name: '', rootPath: '', enabled: true, recursive: true }); dialogVisible.value = true; }
function openEdit(source: MediaSourceDto): void { editingId.value = source.id; Object.assign(form, { name: source.name, rootPath: source.rootPath, enabled: source.enabled, recursive: source.recursive }); dialogVisible.value = true; }
async function chooseDirectory(): Promise<void> {
  try {
    const result = await window.filmLibrary.sources.chooseDirectory();
    if (result.ok && result.data) { form.rootPath = result.data; if (!form.name) form.name = result.data.split(/[\\/]/).filter(Boolean).pop() || ''; }
  } catch (error) {
    console.error('[sources] directory chooser failed', error);
    ElMessage.error('无法打开目录选择器，请查看日志');
  }
}
async function save(): Promise<void> {
  if (!form.name.trim() || !form.rootPath.trim()) { ElMessage.warning('请填写名称并选择目录'); return; }
  saving.value = true;
  try {
    const sourceInput = { name: form.name, rootPath: form.rootPath, enabled: form.enabled, recursive: form.recursive };
    const result = editingId.value
      ? await window.filmLibrary.sources.update({ id: editingId.value, ...sourceInput })
      : await window.filmLibrary.sources.create(sourceInput);
    if (result.ok) { ElMessage.success(editingId.value ? '来源已更新' : '来源已添加'); dialogVisible.value = false; await sourceStore.fetch(); }
    else ElMessage.error(result.error.message);
  } catch (error) {
    console.error('[sources] save failed', error);
    ElMessage.error('保存来源失败，请查看日志');
  } finally {
    saving.value = false;
  }
}
function openRemove(source: MediaSourceDto): void { removing.value = source; removeMode.value = 'archive'; removeVisible.value = true; }
async function remove(): Promise<void> {
  if (!removing.value) return;
  const result = await window.filmLibrary.sources.remove({ id: removing.value.id, mode: removeMode.value });
  if (result.ok) { ElMessage.success(removeMode.value === 'archive' ? '来源已归档，影片记录保留' : '来源配置和影片记录已删除'); removeVisible.value = false; await sourceStore.fetch(); }
  else ElMessage.error(result.error.message);
}
async function scanSource(source: MediaSourceDto): Promise<void> {
  const started = await scan.start([source.id]);
  if (!started) ElMessage.error('无法启动扫描');
}
</script>

<template>
  <div class="page-wrap">
    <div class="page-heading"><div><div class="eyebrow">MEDIA SOURCES</div><h1 class="page-title">来源管理</h1><p class="page-caption">管理外部影片目录。应用不会复制、改写或删除来源中的任何文件。</p></div><div class="heading-actions"><el-button @click="sourceStore.fetch"><Refresh />刷新</el-button><el-button type="primary" @click="openCreate"><Plus />添加目录</el-button></div></div>
    <div class="source-safety"><span class="safety-icon">✓</span><div><strong>只读安全边界</strong><p>扫描只读取文件元数据和旁路资源；删除来源时只处理本地数据库记录，不会操作外部媒体文件。</p></div></div>
    <el-alert v-if="sourceStore.error" :title="sourceStore.error" type="error" show-icon :closable="false" class="source-error" />
    <div v-if="sourceStore.sources.length" class="source-list">
      <div v-for="source in sourceStore.sources" :key="source.id" class="source-card" :class="{ archived: source.archived }">
        <div class="source-icon"><FolderOpened /></div><div class="source-main"><div class="source-title"><strong>{{ source.name }}</strong><el-tag v-if="source.archived" size="small" type="info">已归档</el-tag><span v-else :class="['online-state', source.online ? 'online' : 'offline']"><i />{{ source.online ? '在线' : '离线' }}</span></div><div class="source-path text-mono">{{ source.rootPath }}</div><div class="source-meta"><span>{{ source.recursive ? '递归扫描' : '仅当前目录' }}</span><span>上次扫描：{{ source.lastScanAt ? new Date(source.lastScanAt).toLocaleString() : '从未扫描' }}</span><span>{{ source.lastScanStatus || '待扫描' }}</span></div></div><div class="source-actions"><el-button circle text :disabled="source.archived" title="扫描" @click="scanSource(source)"><Operation /></el-button><el-button circle text title="编辑" @click="openEdit(source)"><Edit /></el-button><el-button circle text type="danger" title="删除" @click="openRemove(source)"><Delete /></el-button></div>
      </div>
    </div>
    <div v-else class="empty-state source-empty"><div><FolderOpened :size="38" /><h3>还没有影片来源</h3><p>添加一个外部目录，然后执行扫描。</p><el-button type="primary" @click="openCreate">添加第一个来源</el-button></div></div>

    <el-dialog v-model="dialogVisible" :title="editingId ? '编辑来源' : '添加影片来源'" width="520px"><el-form label-position="top"><el-form-item label="名称"><el-input v-model="form.name" placeholder="例如：主盘电影" /></el-form-item><el-form-item label="根目录"><el-input v-model="form.rootPath" placeholder="选择外部影片目录"><template #append><el-button @click="chooseDirectory">选择目录</el-button></template></el-input></el-form-item><el-form-item label="扫描选项"><el-switch v-model="form.enabled" active-text="启用来源" /><el-switch v-model="form.recursive" active-text="递归扫描" style="margin-left: 24px" /></el-form-item></el-form><template #footer><el-button @click="dialogVisible = false">取消</el-button><el-button type="primary" :loading="saving" @click="save">保存</el-button></template></el-dialog>
    <el-dialog v-model="removeVisible" title="删除来源" width="500px"><p>请选择如何处理“{{ removing?.name }}”在本地数据库中的记录。外部媒体文件始终不会被操作。</p><el-radio-group v-model="removeMode" class="remove-options"><el-radio value="archive">仅删除来源配置，保留影片记录并归档</el-radio><el-radio value="delete">删除来源配置和数据库影片记录</el-radio></el-radio-group><template #footer><el-button @click="removeVisible = false">取消</el-button><el-button :type="removeMode === 'delete' ? 'danger' : 'primary'" @click="remove">确认</el-button></template></el-dialog>
  </div>
</template>

<style scoped>
.heading-actions { display: flex; gap: 9px; }
.heading-actions svg { width: 15px; margin-right: 5px; }
.source-safety { display: flex; gap: 13px; padding: 16px 18px; margin-bottom: 22px; border: 1px solid rgba(152, 227, 194, .16); border-radius: 13px; background: rgba(152, 227, 194, .05); }
.safety-icon { display: grid; width: 26px; height: 26px; place-items: center; flex: 0 0 auto; border-radius: 50%; color: #112019; background: var(--accent); font-weight: 800; }
.source-safety strong { color: var(--accent); font-size: 13px; }
.source-safety p { margin: 5px 0 0; color: var(--muted); font-size: 12px; }
.source-list { display: grid; gap: 12px; }
.source-card { display: flex; align-items: center; gap: 15px; padding: 18px; border: 1px solid var(--line); border-radius: 14px; background: rgba(21,24,33,.8); }
.source-card.archived { opacity: .65; }
.source-icon { display: grid; width: 42px; height: 42px; place-items: center; flex: 0 0 auto; border-radius: 11px; color: var(--accent); background: rgba(152,227,194,.1); }
.source-main { min-width: 0; flex: 1; }
.source-title { display: flex; align-items: center; gap: 9px; }
.source-title strong { font-size: 15px; }
.online-state { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; }
.online-state i { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); }
.online-state.offline { color: #f2a3a3; }.online-state.offline i { background: #ed8787; }
.source-path { margin-top: 7px; overflow: hidden; color: var(--muted); text-overflow: ellipsis; white-space: nowrap; }
.source-meta { display: flex; gap: 18px; margin-top: 11px; color: var(--subtle); font-size: 11px; }
.source-actions { display: flex; gap: 2px; }
.source-empty { text-align: center; }.source-empty h3 { margin: 13px 0 5px; color: var(--ink); }.source-empty p { margin: 0 0 17px; }
.remove-options { display: grid; gap: 15px; }
</style>
