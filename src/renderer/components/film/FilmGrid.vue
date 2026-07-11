<script setup lang="ts">
import type { FilmSummaryDto } from '../../../shared/contracts';
import FilmCard from './FilmCard.vue';

defineProps<{
  films: FilmSummaryDto[];
  hoverDelay: number;
  slideshowInterval: number;
  cardWidth: number;
}>();
const emit = defineEmits<{ select: [film: FilmSummaryDto] }>();
</script>

<template>
  <div v-if="films.length" class="film-grid">
    <FilmCard v-for="film in films" :key="film.id" :film="film" :hover-delay="hoverDelay" :slideshow-interval="slideshowInterval" :width="cardWidth" @select="emit('select', $event)" />
  </div>
  <div v-else class="empty-state"><div>没有符合条件的影片<br /><span class="muted">添加来源并执行一次扫描即可开始</span></div></div>
</template>

<style scoped>
.film-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 26px 18px; align-items: start; }
</style>
