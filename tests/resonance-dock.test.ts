import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useResonanceDock } from '../src/renderer/composables/useResonanceDock';

let saved: string | null;
beforeEach(() => {
  saved = null;
  vi.stubGlobal('window', { innerWidth: 1200, innerHeight: 800, localStorage: {
    getItem: () => saved,
    setItem: (_key: string, value: string) => { saved = value; },
  } });
});
afterEach(() => vi.unstubAllGlobals());
function pointer(x: number, y: number): PointerEvent {
  return { isPrimary: true, button: 0, pointerId: 1, clientX: x, clientY: y,
    currentTarget: { setPointerCapture: vi.fn() } } as unknown as PointerEvent;
}

describe('resonance launcher docking', () => {
  it('distinguishes a click from dragging and restores the chosen edge and height', () => {
    const dock = useResonanceDock();
    dock.pointerDown(pointer(20, 300));
    dock.pointerMove(pointer(1100, 400));
    dock.pointerUp(pointer(1100, 400));
    expect(dock.shouldOpen({ detail: 1 } as MouseEvent)).toBe(false);
    expect(dock.side.value).toBe('right');
    expect(useResonanceDock().dockStyle.value).toEqual(dock.dockStyle.value);
    dock.pointerDown(pointer(1100, 400));
    dock.pointerMove(pointer(1102, 401));
    dock.pointerUp(pointer(1102, 401));
    expect(dock.shouldOpen({ detail: 1 } as MouseEvent)).toBe(true);
  });

  it('cancels a drag without saving and supports keyboard positioning', () => {
    const dock = useResonanceDock();
    const original = dock.dockStyle.value;
    dock.pointerDown(pointer(20, 300));
    dock.pointerMove(pointer(1000, 700));
    dock.pointerCancel();
    expect(dock.dockStyle.value).toEqual(original);
    expect(saved).toBeNull();
    const event = { key: 'ArrowRight', preventDefault: vi.fn() };
    dock.keydown(event as unknown as KeyboardEvent);
    expect(dock.side.value).toBe('right');
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(useResonanceDock().side.value).toBe('right');
  });

  it('clamps out-of-window drags and tolerates corrupt preferences', () => {
    saved = 'broken';
    const dock = useResonanceDock();
    dock.pointerDown(pointer(20, 300));
    dock.pointerMove(pointer(20, -5000));
    expect(dock.dockStyle.value['--dock-top']).toBe('0%');
    dock.pointerMove(pointer(20, 5000));
    expect(dock.dockStyle.value['--dock-top']).toBe('100%');
    dock.pointerUp(pointer(20, 5000));
    expect(dock.shouldOpen({ detail: 0 } as MouseEvent)).toBe(true);
  });
});
