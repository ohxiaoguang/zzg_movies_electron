<script setup lang="ts">
import { ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import type { ScanIssueType, ScanIssuesPageDto } from '../../../shared/contracts';
const props = defineProps<{ modelValue: boolean; jobId: string; initialType?: ScanIssueType }>();
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>();
const type = ref<ScanIssueType | ''>('');
const search = ref('');
const page = ref(1);
const loading = ref(false);
const error = ref('');
const opening = ref('');
const result = ref<ScanIssuesPageDto>({ items: [], total: 0, page: 1, pageSize: 20 });
const labels: Record<ScanIssueType, string> = { nfo: 'NFO 错误', asset: '资源歧义', filesystem: '文件读取错误', missing: '文件缺失', database: '数据库合并错误', source_offline: '来源离线' };
let request = 0;
async function load(): Promise<void> {
  const token = ++request;
  loading.value = true; error.value = '';
  try {
    const response = await window.filmLibrary.scan.issues({ jobId: props.jobId, page: page.value, pageSize: 20,
      ...(type.value ? { type: type.value } : {}), search: search.value });
    if (token !== request) return;
    if (response.ok) result.value = response.data; else error.value = response.error.message;
  } catch { if (token === request) error.value = '无法加载扫描问题，请重试'; }
  finally { if (token === request) loading.value = false; }
}
function filter(): void { page.value = 1; void load(); }
watch(() => [props.modelValue, props.jobId, props.initialType], () => {
  if (!props.modelValue) { request++; loading.value = false; return; }
  type.value = props.initialType ?? ''; page.value = 1; search.value = ''; void load();
}, { immediate: true });
async function open(id: string): Promise<void> {
  opening.value = id;
  try { const response = await window.filmLibrary.scan.openIssue(id); if (!response.ok) ElMessage.error(response.error.message); }
  finally { opening.value = ''; }
}
</script>

<template>
  <el-dialog :model-value="modelValue" append-to-body width="min(1100px, 95vw)" title="扫描问题明细" @update:model-value="emit('update:modelValue', $event)">
    <p class="issues-caption">本次扫描发现的问题与对应文件。资源歧义表示通用图片无法确定属于哪部影片，可按影片名称重命名相关资源后重新扫描。</p>
    <div class="issue-filters">
      <el-select v-model="type" aria-label="问题类型" @change="filter"><el-option label="全部问题" value="" /><el-option v-for="(label, key) in labels" :key="key" :label="label" :value="key" /></el-select>
      <el-input v-model="search" clearable placeholder="搜索影片、来源或文件路径" aria-label="搜索扫描问题" @keyup.enter="filter" @clear="filter" />
      <el-button @click="filter">查询</el-button>
    </div>
    <el-alert v-if="error" :title="error" type="error" :closable="false" />
    <el-table v-loading="loading" :data="result.items" max-height="480" empty-text="没有此类扫描问题">
      <el-table-column label="类型" width="130"><template #default="{ row }">{{ labels[row.type as ScanIssueType] || row.type }}</template></el-table-column>
      <el-table-column prop="sourceName" label="来源" width="120" show-overflow-tooltip />
      <el-table-column label="影片 / 文件" min-width="260"><template #default="{ row }"><strong>{{ row.filmTitle || '来源目录' }}</strong><div class="issue-path">{{ row.relativePath }}</div><details v-if="row.relatedPaths.length"><summary>相关文件（{{ row.relatedPaths.length }}）</summary><div v-for="file in row.relatedPaths" :key="file" class="issue-path">{{ file }}</div></details></template></el-table-column>
      <el-table-column prop="message" label="原因与处理建议" min-width="280" />
      <el-table-column label="操作" width="120"><template #default="{ row }"><el-button size="small" :loading="opening === row.id" :disabled="!!opening || !row.sourceId" @click="open(row.id)">打开文件夹</el-button></template></el-table-column>
    </el-table>
    <el-pagination v-if="result.total > 20" :current-page="page" :page-size="20" :total="result.total" layout="total, prev, pager, next" @current-change="page = $event; load()" />
    <template #footer><span class="issues-total">共 {{ result.total }} 项问题</span><el-button @click="emit('update:modelValue', false)">关闭</el-button></template>
  </el-dialog>
</template>
<style scoped>
.issues-caption { color: var(--muted); font-size: 12px; line-height: 1.7; margin: 0 0 14px; }
.issue-filters { display: flex; gap: 10px; margin-bottom: 14px; }
.issue-filters .el-select { width: 190px; flex-shrink: 0; }
.issue-path { color: var(--muted); font-size: 12px; overflow-wrap: anywhere; margin: 5px 0; }
details { font-size: 12px; } summary { cursor: pointer; }
.issues-total { color: var(--muted); margin-right: 14px; }
.el-pagination { margin-top: 14px; }
</style>
