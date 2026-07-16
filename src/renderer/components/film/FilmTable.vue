<script setup lang="ts">
import type { FilmSummaryDto } from '../../../shared/contracts';

defineProps<{ films: FilmSummaryDto[]; allData?: boolean }>();
const emit = defineEmits<{
  select: [film: FilmSummaryDto];
  selectionChange: [films: FilmSummaryDto[]];
  deleteRow: [film: FilmSummaryDto];
}>();
function selectRow(row: FilmSummaryDto): void { emit('select', row); }
function categoryNames(row: FilmSummaryDto): string { return row.customCategories.map((item) => item.name).join(' · '); }
function availabilityLabel(value: FilmSummaryDto['availability']): string {
  return { available: '正常', partial_missing: '部分缺失', missing: '完全缺失', source_offline: '来源离线', source_removed: '来源已删除', archived: '已归档' }[value];
}
</script>

<template>
  <el-table :data="films" class="film-table" @row-click="selectRow" @selection-change="emit('selectionChange', $event)">
    <el-table-column v-if="allData" type="selection" width="48" />
    <el-table-column label="影片" min-width="320">
      <template #default="{ row }"><div class="table-title"><div class="table-thumb"><img v-if="row.posterAssetId" :src="`film-media://asset/${row.posterAssetId}`" alt="" /></div><div><strong>{{ row.title }}</strong><small>{{ row.filename }}</small></div></div></template>
    </el-table-column>
    <el-table-column prop="year" label="年份" width="90" />
    <el-table-column label="我的分类" min-width="180"><template #default="{ row }"><span v-if="row.customCategories.length">{{ categoryNames(row) }}</span><el-tag v-else size="small" type="warning">未整理</el-tag></template></el-table-column>
    <el-table-column label="收藏" width="80"><template #default="{ row }">{{ row.favorite ? '♥' : '—' }}</template></el-table-column>
    <el-table-column label="评分" width="100"><template #default="{ row }">{{ row.rating ? `★ ${row.rating.toFixed(1)}` : '—' }}</template></el-table-column>
    <el-table-column label="来源" min-width="160"><template #default="{ row }"><span class="muted">{{ row.sourceName }}</span></template></el-table-column>
    <el-table-column v-if="allData" label="文件数量" width="100"><template #default="{ row }">{{ row.existingFileCount }} / {{ row.totalFileCount }}</template></el-table-column>
    <el-table-column label="文件可用性" width="110"><template #default="{ row }"><el-tag :type="row.availability === 'available' ? 'success' : 'warning'" size="small">{{ availabilityLabel(row.availability) }}</el-tag></template></el-table-column>
    <el-table-column v-if="allData" label="数据库更新时间" min-width="170"><template #default="{ row }">{{ new Date(row.updatedAt).toLocaleString() }}</template></el-table-column>
    <el-table-column v-if="allData" label="操作" width="80"><template #default="{ row }"><el-button text type="danger" @click.stop="emit('deleteRow', row)">删除</el-button></template></el-table-column>
  </el-table>
</template>

<style scoped>
.film-table { cursor: pointer; }
.table-title { display: flex; align-items: center; gap: 12px; }
.table-thumb { width: 34px; height: 50px; flex: 0 0 auto; overflow: hidden; border-radius: 5px; background: #252b38; }
.table-thumb img { width: 100%; height: 100%; object-fit: cover; }
.table-title strong { display: block; max-width: 330px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.table-title small { display: block; max-width: 330px; margin-top: 5px; overflow: hidden; color: var(--muted); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.ok-mark { color: var(--accent); font-size: 12px; }
</style>
