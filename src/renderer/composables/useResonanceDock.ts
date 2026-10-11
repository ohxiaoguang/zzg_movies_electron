import { computed, ref } from 'vue';

const STORAGE_KEY = 'local-film-library:resonance-dock';
type DockSide = 'left' | 'right';

export function useResonanceDock() {
  const side = ref<DockSide>('left');
  const heightRatio = ref(0.72);
  try {
    const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || 'null');
    if (saved?.side === 'left' || saved?.side === 'right') side.value = saved.side;
    if (typeof saved?.heightRatio === 'number' && Number.isFinite(saved.heightRatio)) {
      heightRatio.value = Math.max(0, Math.min(1, saved.heightRatio));
    }
  } catch { /* An unavailable preference store should not hide the launcher. */ }

  let gesture: { id: number; x: number; y: number; ratio: number; side: DockSide; moved: boolean } | null = null;
  let suppressClick = false;
  const dragging = ref(false);
  const dockStyle = computed(() => ({
    '--dock-top': `${heightRatio.value * 100}%`,
    left: side.value === 'left' ? '0' : 'auto',
    right: side.value === 'right' ? '0' : 'auto',
  }));

  function save(): void {
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ side: side.value, heightRatio: heightRatio.value })); }
    catch { /* Keep the current position for this session. */ }
  }

  function pointerDown(event: PointerEvent): void {
    if (!event.isPrimary || event.button !== 0) return;
    suppressClick = false;
    gesture = { id: event.pointerId, x: event.clientX, y: event.clientY, ratio: heightRatio.value, side: side.value, moved: false };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }

  function pointerMove(event: PointerEvent): void {
    if (!gesture || gesture.id !== event.pointerId) return;
    if (Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > 5) gesture.moved = true;
    if (!gesture.moved) return;
    dragging.value = true;
    heightRatio.value = Math.max(0, Math.min(1, gesture.ratio + (event.clientY - gesture.y) / Math.max(1, window.innerHeight)));
    side.value = event.clientX < window.innerWidth / 2 ? 'left' : 'right';
  }

  function pointerUp(event: PointerEvent): void {
    if (!gesture || gesture.id !== event.pointerId) return;
    suppressClick = gesture.moved;
    if (gesture.moved) save();
    gesture = null;
    dragging.value = false;
  }

  function pointerCancel(): void {
    if (gesture) { heightRatio.value = gesture.ratio; side.value = gesture.side; }
    gesture = null;
    dragging.value = false;
    suppressClick = false;
  }

  function shouldOpen(event: MouseEvent): boolean {
    const allowed = !suppressClick || event.detail === 0;
    suppressClick = false;
    return allowed;
  }

  function keydown(event: KeyboardEvent): void {
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') side.value = event.key === 'ArrowLeft' ? 'left' : 'right';
    else heightRatio.value = Math.max(0, Math.min(1, heightRatio.value + (event.key === 'ArrowUp' ? -0.05 : 0.05)));
    save();
  }

  return { side, dragging, dockStyle, pointerDown, pointerMove, pointerUp, pointerCancel, shouldOpen, keydown };
}
