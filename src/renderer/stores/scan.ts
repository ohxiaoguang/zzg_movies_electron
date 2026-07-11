import { ref } from 'vue';
import { defineStore } from 'pinia';
import type { ScanProgressDto, ScanStatusDto } from '../../shared/contracts';

export const useScanStore = defineStore('scan', () => {
  const progress = ref<ScanStatusDto | null>(null);
  const dialogVisible = ref(false);
  let dispose: (() => void) | null = null;

  function listen(): void {
    if (dispose) return;
    dispose = window.filmLibrary.scan.onProgress((value: ScanProgressDto) => {
      progress.value = value as ScanStatusDto;
      if (value.status !== 'running') dialogVisible.value = true;
    });
  }

  async function start(sourceIds: string[] = []): Promise<boolean> {
    listen();
    dialogVisible.value = true;
    const result = await window.filmLibrary.scan.start(sourceIds.length ? { sourceIds } : {});
    if (!result.ok) return false;
    return true;
  }

  async function cancel(): Promise<void> {
    await window.filmLibrary.scan.cancel();
  }

  function closeDialog(): void {
    if (progress.value?.status !== 'running') dialogVisible.value = false;
  }

  return { progress, dialogVisible, listen, start, cancel, closeDialog };
});
