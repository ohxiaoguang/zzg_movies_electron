<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { ArrowDown, ArrowUp, CollectionTag, Delete, Edit, Plus, Refresh } from '@element-plus/icons-vue';
import type { CustomCategoryDto } from '../../shared/contracts';

const router = useRouter();
const categories = ref<CustomCategoryDto[]>([]);
const loading = ref(false);

async function load(): Promise<void> {
  loading.value = true;
  try {
    const result = await window.filmLibrary.categories.list();
    if (result.ok) categories.value = result.data;
    else ElMessage.error(result.error.message);
  } finally {
    loading.value = false;
  }
}

async function create(): Promise<void> {
  try {
    const prompt = await ElMessageBox.prompt('输入新的“我的分类”名称', '新建分类', { inputPattern: /\S+/, inputErrorMessage: '分类名称不能为空' });
    const result = await window.filmLibrary.categories.create({ name: prompt.value });
    if (!result.ok) { ElMessage.error(result.error.message); return; }
    await load();
    notifyChanged();
  } catch (error) {
    if (error !== 'cancel') console.error('[categories] create failed', error);
  }
}

async function rename(category: CustomCategoryDto): Promise<void> {
  try {
    const prompt = await ElMessageBox.prompt('输入新的分类名称', '重命名分类', { inputValue: category.name, inputPattern: /\S+/, inputErrorMessage: '分类名称不能为空' });
    const result = await window.filmLibrary.categories.rename({ id: category.id, name: prompt.value });
    if (!result.ok) { ElMessage.error(result.error.message); return; }
    await load();
    notifyChanged();
  } catch (error) {
    if (error !== 'cancel') console.error('[categories] rename failed', error);
  }
}

async function remove(category: CustomCategoryDto): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `删除分类“${category.name}”？\n\n该操作只会删除分类及其与影片的关联，不会删除影片数据库记录，也不会修改任何外部影片或 NFO。`,
      '删除分类',
      { type: 'warning', confirmButtonText: '删除分类' },
    );
    const result = await window.filmLibrary.categories.remove({ id: category.id });
    if (!result.ok) { ElMessage.error(result.error.message); return; }
    await load();
    notifyChanged();
  } catch (error) {
    if (error !== 'cancel') console.error('[categories] remove failed', error);
  }
}

async function move(index: number, direction: -1 | 1): Promise<void> {
  const target = index + direction;
  if (target < 0 || target >= categories.value.length) return;
  const ordered = [...categories.value];
  [ordered[index], ordered[target]] = [ordered[target]!, ordered[index]!];
  categories.value = ordered;
  const result = await window.filmLibrary.categories.reorder({ ids: ordered.map((item) => item.id) });
  if (!result.ok) { ElMessage.error(result.error.message); await load(); return; }
  categories.value = result.data;
  notifyChanged();
}

function viewFilms(category: CustomCategoryDto): void {
  void router.push({ path: '/library', query: { category: category.id } });
}

function notifyChanged(): void {
  window.dispatchEvent(new Event('film-library:changed'));
}

onMounted(() => void load());
</script>

<template>
  <div class="page-wrap">
    <div class="page-heading">
      <div><div class="eyebrow">PERSONAL TAXONOMY</div><h1 class="page-title">我的分类</h1><p class="page-caption">完全由你维护，与来自 NFO 的只读标签互不影响。</p></div>
      <div class="heading-actions"><el-button :loading="loading" @click="load"><Refresh />刷新</el-button><el-button type="primary" @click="create"><Plus />新建分类</el-button></div>
    </div>
    <div v-if="categories.length" class="category-grid">
      <article v-for="(category, index) in categories" :key="category.id" class="category-card" @click="viewFilms(category)">
        <div class="category-icon"><CollectionTag /></div>
        <div class="category-copy"><strong>{{ category.name }}</strong><span>{{ category.filmCount ?? 0 }} 部影片</span></div>
        <div class="category-actions">
          <el-button text circle :icon="ArrowUp" :disabled="index === 0" title="上移" aria-label="上移" @click.stop="move(index, -1)" />
          <el-button text circle :icon="ArrowDown" :disabled="index === categories.length - 1" title="下移" aria-label="下移" @click.stop="move(index, 1)" />
          <span class="action-spacer" />
          <el-button text size="small" :icon="Edit" title="重命名" @click.stop="rename(category)">重命名</el-button>
          <el-button text size="small" type="danger" :icon="Delete" title="删除" @click.stop="remove(category)">删除</el-button>
        </div>
      </article>
    </div>
    <div v-else class="empty-state"><div><CollectionTag :size="38" /><p>还没有“我的分类”，可以先创建“经典”或“值得重看”。</p></div></div>
  </div>
</template>

<style scoped>
.heading-actions { display: flex; gap: 9px; }.heading-actions svg { width: 15px; margin-right: 5px; }
.category-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 13px; }
.category-card { display: grid; grid-template-columns: 34px minmax(0, 1fr); align-items: start; gap: 12px; min-width: 0; padding: 17px; border: 1px solid var(--line); border-radius: 13px; background: rgba(21,24,33,.8); cursor: pointer; }
.category-card:hover { border-color: rgba(152,227,194,.38); }.category-icon { display: grid; width: 34px; height: 34px; place-items: center; flex: 0 0 auto; border-radius: 9px; color: var(--accent); background: rgba(152,227,194,.1); }
.category-copy { min-width: 0; }.category-copy strong, .category-copy span { display: block; }.category-copy strong { color: var(--ink); font-size: 13px; line-height: 1.5; overflow-wrap: anywhere; white-space: normal; }.category-copy span { margin-top: 4px; color: var(--muted); font-size: 11px; }.category-actions { display: flex; grid-column: 1 / -1; align-items: center; gap: 2px; padding-top: 10px; border-top: 1px solid rgba(255,255,255,.06); }.action-spacer { flex: 1; }.category-actions :deep(.el-button) { margin-left: 0; }.category-actions :deep(.el-icon) { width: 16px; height: 16px; font-size: 16px; }.category-actions :deep(.el-icon svg) { width: 16px; height: 16px; }
</style>
