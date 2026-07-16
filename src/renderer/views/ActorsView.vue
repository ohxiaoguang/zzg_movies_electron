<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { Refresh, User } from '@element-plus/icons-vue';
import type { ActorDto } from '../../shared/contracts';

const router = useRouter();
const actors = ref<ActorDto[]>([]);
const search = ref('');
const loading = ref(false);
const visibleActors = computed(() => {
  const query = search.value.trim().toLocaleLowerCase();
  return query ? actors.value.filter((actor) => actor.name.toLocaleLowerCase().includes(query)) : actors.value;
});

async function load(): Promise<void> {
  loading.value = true;
  try {
    const result = await window.filmLibrary.actors.list();
    if (result.ok) actors.value = result.data;
    else ElMessage.error(result.error.message);
  } finally {
    loading.value = false;
  }
}

function viewActor(actor: ActorDto): void {
  void router.push({ path: '/library', query: { actor: actor.name } });
}

onMounted(() => void load());
</script>

<template>
  <div class="page-wrap actors-page">
    <div class="page-heading">
      <div><div class="eyebrow">NFO CAST INDEX</div><h1 class="page-title">演员</h1><p class="page-caption">来自 NFO，只读。点击演员可查看其全部影片。</p></div>
      <el-button :loading="loading" @click="load"><Refresh />刷新</el-button>
    </div>
    <div class="actors-toolbar"><el-input v-model="search" clearable placeholder="搜索演员…" /><span>{{ visibleActors.length }} 位演员</span></div>
    <div v-if="visibleActors.length" class="actor-grid">
      <button v-for="actor in visibleActors" :key="actor.name" type="button" class="actor-card" @click="viewActor(actor)">
        <span class="actor-icon"><User /></span><span class="actor-copy"><strong>{{ actor.name }}</strong><small>{{ actor.filmCount }} 部影片</small></span>
      </button>
    </div>
    <div v-else class="empty-state"><div><User :size="38" /><p>{{ actors.length ? '没有匹配的演员' : 'NFO 中暂无演员信息' }}</p></div></div>
  </div>
</template>

<style scoped>
.page-heading .el-button svg { width: 15px; margin-right: 5px; }.actors-toolbar { display: flex; align-items: center; gap: 14px; margin-bottom: 18px; }.actors-toolbar .el-input { width: min(360px, 100%); }.actors-toolbar span { color: var(--muted); font-size: 11px; }.actor-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; }.actor-card { display: flex; min-width: 0; padding: 15px; align-items: center; gap: 11px; border: 1px solid var(--line); border-radius: 12px; color: inherit; background: rgba(21,24,33,.8); text-align: left; cursor: pointer; }.actor-card:hover { border-color: rgba(152,227,194,.42); background: rgba(29,34,45,.9); }.actor-icon { display: grid; width: 34px; height: 34px; place-items: center; flex: 0 0 auto; border-radius: 50%; color: var(--accent); background: rgba(152,227,194,.1); }.actor-icon svg { width: 17px; }.actor-copy { min-width: 0; }.actor-copy strong, .actor-copy small { display: block; }.actor-copy strong { overflow-wrap: anywhere; font-size: 13px; line-height: 1.45; }.actor-copy small { margin-top: 3px; color: var(--muted); font-size: 10px; }
</style>
