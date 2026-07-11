import { ref } from 'vue';
import { defineStore } from 'pinia';
import type { MediaSourceDto } from '../../shared/contracts';

export const useSourceStore = defineStore('sources', () => {
  const sources = ref<MediaSourceDto[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);

  async function fetch(): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      const result = await window.filmLibrary.sources.list();
      if (result.ok) sources.value = result.data;
      else error.value = result.error.message;
    } catch (reason) {
      console.error('[sources] list failed', reason);
      error.value = '无法加载来源，请查看日志';
    } finally {
      loading.value = false;
    }
  }

  return { sources, loading, error, fetch };
});
