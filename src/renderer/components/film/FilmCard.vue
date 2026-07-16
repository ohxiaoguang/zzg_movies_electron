<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { Star, VideoCamera } from '@element-plus/icons-vue';
import type { FilmSummaryDto } from '../../../shared/contracts';
import { mediaUrl } from '../../api';
import { createHoverPopupController } from '../../composables/hoverPopupController';
import { claimHoverPopup, releaseHoverPopup } from '../../composables/hoverPopupManager';
import FilmHoverPopup from './FilmHoverPopup.vue';

const props = defineProps<{
  film: FilmSummaryDto;
  hoverDelay: number;
  slideshowInterval: number;
}>();

const emit = defineEmits<{
  select: [film: FilmSummaryDto];
  updated: [];
}>();

const root = ref<HTMLElement | null>(null);
const popupVisible = ref(false);
const posterFailed = ref(false);
const favorite = ref(props.film.favorite);
const favoriteSaving = ref(false);
let observer: IntersectionObserver | null = null;

const posterSource = computed(() => (props.film.posterAssetId ? mediaUrl('asset', props.film.posterAssetId) : null));
const visibleCategories = computed(() => props.film.customCategories.slice(0, 2));
const hiddenCategoryCount = computed(() => Math.max(0, props.film.customCategories.length - visibleCategories.value.length));
const availabilityLabel = computed(() => props.film.availability === 'partial_missing'
  ? `部分缺失 ${props.film.missingFileCount}/${props.film.totalFileCount}`
  : props.film.availability === 'source_offline' ? '来源离线'
    : props.film.availability === 'source_removed' ? '来源已删除' : '缺失');

function closePopup(): void {
  popupVisible.value = false;
  releaseHoverPopup(props.film.id, closePopup);
}

function openPopup(): void {
  claimHoverPopup(props.film.id, closePopup);
  popupVisible.value = true;
}

const hoverController = createHoverPopupController({
  openDelay: props.hoverDelay,
  closeDelay: 180,
  onOpen: openPopup,
  onClose: closePopup,
});

function enterCard(): void { hoverController.enterCard(); }
function leaveCard(): void { hoverController.leaveCard(); }
function enterPopup(): void { hoverController.enterPopup(); }
function leavePopup(): void { hoverController.leavePopup(); }
function forceClose(): void { hoverController.closeNow(); }
function selectFromPopup(): void {
  closePopup();
  emit('select', props.film);
}
function onPosterError(): void { posterFailed.value = true; }
async function toggleFavorite(): Promise<void> {
  if (favoriteSaving.value) return;
  const confirmed = favorite.value;
  favorite.value = !confirmed;
  favoriteSaving.value = true;
  const result = await window.filmLibrary.films.updateFavorite(props.film.id, favorite.value);
  if (!result.ok) {
    favorite.value = confirmed;
    ElMessage.error(result.error.message);
  } else emit('updated');
  favoriteSaving.value = false;
}

watch(() => props.film.favorite, (value) => { favorite.value = value; });

onMounted(() => {
  observer = new IntersectionObserver((entries) => {
    if (!entries[0]?.isIntersecting) forceClose();
  }, { threshold: 0.05 });
  if (root.value) observer.observe(root.value);
});

onBeforeUnmount(() => {
  hoverController.dispose();
  observer?.disconnect();
  observer = null;
  closePopup();
});
</script>

<template>
  <article ref="root" class="film-card" @mouseenter="enterCard" @mouseleave="leaveCard" @click="emit('select', film)">
    <div class="film-poster">
      <div v-if="!posterSource || posterFailed" class="poster-placeholder">
        <VideoCamera :size="32" />
        <span>{{ film.title.slice(0, 1) }}</span>
      </div>
      <img v-else class="poster-image" :src="posterSource" :alt="film.title" @error="onPosterError" />
      <div class="film-card-topline">
        <el-tag v-if="film.availability !== 'available'" size="small" type="warning">{{ availabilityLabel }}</el-tag>
        <button class="favorite-button" :class="{ active: favorite }" :disabled="favoriteSaving" :aria-label="favorite ? '取消收藏' : '收藏'" @click.stop="toggleFavorite"><Star /></button>
      </div>
      <div class="film-card-bottomline">
        <span v-if="film.organizationState === 'unorganized'" class="organization-chip">未整理</span>
        <span v-else class="category-chips"><span v-for="category in visibleCategories" :key="category.id">{{ category.name }}</span><span v-if="hiddenCategoryCount">+{{ hiddenCategoryCount }}</span></span>
        <span v-if="film.rating > 0" class="rating-chip">★ {{ film.rating.toFixed(1) }}</span>
      </div>
    </div>
    <div class="film-card-info">
      <div class="film-card-title" :title="film.title">{{ film.title }}</div>
      <div class="film-card-meta"><span>{{ film.year || '—' }}</span><span>{{ film.sourceName }}</span></div>
    </div>
    <FilmHoverPopup
      v-if="popupVisible"
      :key="film.id"
      :film="film"
      :anchor="root"
      :slideshow-interval="slideshowInterval"
      @enter="enterPopup"
      @leave="leavePopup"
      @close="forceClose"
      @select="selectFromPopup"
      @updated="emit('updated')"
    />
  </article>
</template>

<style scoped>
.film-card { width: 100%; min-width: 0; cursor: pointer; transition: filter .25s ease; }
.film-card:hover { filter: brightness(1.04); }
.film-poster { position: relative; aspect-ratio: 2 / 3; overflow: hidden; border-radius: 13px; background: #202532; box-shadow: 0 14px 32px rgba(0, 0, 0, .22); }
.poster-image { display: block; width: 100%; height: 100%; object-fit: cover; }
.poster-placeholder { display: flex; width: 100%; height: 100%; flex-direction: column; align-items: center; justify-content: center; gap: 10px; color: #778096; background: linear-gradient(155deg, #242a38, #171a24); }
.poster-placeholder span { color: #9fa7b8; font-size: 38px; font-weight: 800; }
.film-card-topline, .film-card-bottomline { position: absolute; right: 10px; left: 10px; display: flex; align-items: center; justify-content: space-between; }
.film-card-topline { top: 10px; }
.film-card-bottomline { bottom: 10px; }
.favorite-button { display: grid; width: 30px; height: 30px; padding: 0; margin-left: auto; place-items: center; border: 1px solid rgba(255,255,255,.16); border-radius: 50%; color: #e8edf4; background: rgba(9,12,16,.72); cursor: pointer; backdrop-filter: blur(8px); }.favorite-button svg { width: 15px; }.favorite-button.active { border-color: rgba(255,217,139,.55); color: #ffd98b; background: rgba(62,45,15,.78); }.favorite-button:disabled { cursor: wait; opacity: .65; }
.organization-chip, .category-chips > span, .rating-chip { padding: 4px 7px; border-radius: 6px; color: #eef3f1; background: rgba(9, 12, 16, .68); font-size: 10px; backdrop-filter: blur(8px); }.category-chips { display: flex; min-width: 0; gap: 4px; overflow: hidden; }.category-chips > span { max-width: 76px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.organization-chip { color: #ffd19e; }
.rating-chip { color: #ffe1a1; }
.film-card-info { padding: 10px 2px 4px; }
.film-card-title { overflow: hidden; color: var(--ink); font-size: 14px; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
.film-card-meta { display: flex; justify-content: space-between; gap: 10px; margin-top: 5px; overflow: hidden; color: var(--muted); font-size: 11px; }
.film-card-meta span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
