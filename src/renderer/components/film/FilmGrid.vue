<script setup lang="ts">
import { computed } from 'vue';
import type { FilmSummaryDto } from '../../../shared/contracts';
import FilmCard from './FilmCard.vue';

const emit = defineEmits<{ select: [film: FilmSummaryDto]; updated: [] }>();
const props = defineProps<{
  films: FilmSummaryDto[];
  hoverDelay: number;
  slideshowInterval: number;
  cardWidth: number;
}>();
const gridStyle = computed(() => ({ '--film-card-width': `${Math.max(140, Math.min(320, props.cardWidth))}px` }));
</script>

<template>
  <div v-if="props.films.length" class="film-grid" :style="gridStyle">
    <FilmCard v-for="film in props.films" :key="film.id" :film="film" :hover-delay="props.hoverDelay" :slideshow-interval="props.slideshowInterval" @select="emit('select', $event)" @updated="emit('updated')" />
  </div>
  <div v-else class="empty-state"><div>没有符合条件的影片<br /><span class="muted">添加来源并执行一次扫描即可开始</span></div></div>
</template>

<style scoped>
.film-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(var(--film-card-width), 100%), var(--film-card-width))); gap: 20px; align-items: start; justify-content: start; }
</style>
