<script setup lang="ts">
import type { FilmSummaryDto } from '../../../shared/contracts';

defineProps<{ films: FilmSummaryDto[] }>();
const emit = defineEmits<{ select: [film: FilmSummaryDto] }>();
const statusLabel: Record<string, string> = { unorganized: '未整理', want: '想看', watching: '正在观看', watched: '已看' };
function selectRow(row: FilmSummaryDto): void { emit('select', row); }
</script>

<template>
  <el-table :data="films" class="film-table" @row-click="selectRow">
    <el-table-column label="影片" min-width="320">
      <template #default="{ row }"><div class="table-title"><div class="table-thumb"><img v-if="row.posterAssetId" :src="`film-media://asset/${row.posterAssetId}`" alt="" /></div><div><strong>{{ row.title }}</strong><small>{{ row.filename }}</small></div></div></template>
    </el-table-column>
    <el-table-column prop="year" label="年份" width="90" />
    <el-table-column label="状态" width="120"><template #default="{ row }"><el-tag size="small">{{ statusLabel[row.status] }}</el-tag></template></el-table-column>
    <el-table-column label="评分" width="100"><template #default="{ row }">{{ row.rating ? `★ ${row.rating.toFixed(1)}` : '—' }}</template></el-table-column>
    <el-table-column label="来源" min-width="160"><template #default="{ row }"><span class="muted">{{ row.sourceName }}</span></template></el-table-column>
    <el-table-column label="状态" width="85"><template #default="{ row }"><el-tag v-if="row.missing" type="danger" size="small">缺失</el-tag><span v-else class="ok-mark">可用</span></template></el-table-column>
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
