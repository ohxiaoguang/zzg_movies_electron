import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHoverPopupController } from '../src/renderer/composables/hoverPopupController';
import { calculatePopupPosition } from '../src/renderer/composables/hoverPopupGeometry';
import { claimHoverPopup, closeAllHoverPopups } from '../src/renderer/composables/hoverPopupManager';
import { claimPreview, releaseActivePreview, releasePreview } from '../src/renderer/composables/usePreviewManager';

afterEach(() => {
  vi.useRealTimers();
  closeAllHoverPopups();
  releaseActivePreview();
});

describe('film hover popup behavior', () => {
  it('opens after 450ms, keeps open when pointer transfers to popup, and closes after 180ms', () => {
    vi.useFakeTimers();
    let opened = 0;
    let closed = 0;
    const controller = createHoverPopupController({ openDelay: 450, closeDelay: 180, onOpen: () => { opened += 1; }, onClose: () => { closed += 1; } });

    controller.enterCard();
    vi.advanceTimersByTime(449);
    expect(opened).toBe(0);
    vi.advanceTimersByTime(1);
    expect(opened).toBe(1);

    controller.leaveCard();
    vi.advanceTimersByTime(179);
    controller.enterPopup();
    vi.advanceTimersByTime(1);
    expect(closed).toBe(0);

    controller.leavePopup();
    vi.advanceTimersByTime(180);
    expect(closed).toBe(1);
    controller.dispose();
  });

  it('prefers the right side, falls back to the left, and clamps at viewport edges', () => {
    expect(calculatePopupPosition({ left: 100, right: 300, top: 100 }, { width: 520, height: 340 }, { width: 1200, height: 800 })).toEqual({ left: 314, top: 100 });
    expect(calculatePopupPosition({ left: 900, right: 1100, top: 100 }, { width: 520, height: 340 }, { width: 1200, height: 800 })).toEqual({ left: 366, top: 100 });
    expect(calculatePopupPosition({ left: 0, right: 400, top: 700 }, { width: 520, height: 340 }, { width: 800, height: 800 })).toEqual({ left: 12, top: 448 });
  });

  it('keeps one video and releases the old element resources before reuse', () => {
    const first = fakeVideo();
    const second = fakeVideo();
    claimPreview('first', first.element);
    claimPreview('second', second.element);
    expect(first.calls).toEqual(['pause', 'removeAttribute', 'load']);
    expect(second.calls).toEqual([]);
    releasePreview('second', second.element);
    expect(second.calls).toEqual(['pause', 'removeAttribute', 'load']);
  });

  it('keeps only one popup owner at a time', () => {
    let firstClosed = 0;
    let secondClosed = 0;
    claimHoverPopup('first', () => { firstClosed += 1; });
    claimHoverPopup('second', () => { secondClosed += 1; });
    expect(firstClosed).toBe(1);
    expect(secondClosed).toBe(0);
    closeAllHoverPopups();
    expect(secondClosed).toBe(1);
  });
});

function fakeVideo(): { element: HTMLVideoElement; calls: string[] } {
  const calls: string[] = [];
  const element = {
    pause: () => calls.push('pause'),
    removeAttribute: () => calls.push('removeAttribute'),
    load: () => calls.push('load'),
  } as unknown as HTMLVideoElement;
  return { element, calls };
}
