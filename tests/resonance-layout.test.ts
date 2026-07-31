import { describe, expect, it } from 'vitest';
import { computeResonanceLayout } from '../src/renderer/composables/resonanceLayout';

describe('resonance layout', () => {
  it('returns no rectangles without usable items or space', () => {
    expect(computeResonanceLayout([], 1200, 700)).toEqual([]);
    expect(computeResonanceLayout([{ id: 'a', aspectRatio: 16 / 9 }], 0, 700)).toEqual([]);
  });

  it('fills the stage without overlaps for mixed video aspect ratios', () => {
    const width = 1280;
    const height = 654;
    const gap = 8;
    const rectangles = computeResonanceLayout([
      { id: 'wide', aspectRatio: 2.4 },
      { id: 'portrait', aspectRatio: 9 / 16 },
      { id: 'standard', aspectRatio: 16 / 9 },
      { id: 'square', aspectRatio: 1 },
      { id: 'classic', aspectRatio: 4 / 3 },
    ], width, height, gap);

    expect(rectangles).toHaveLength(5);
    for (const rect of rectangles) {
      expect(rect.width).toBeGreaterThan(0);
      expect(rect.height).toBeGreaterThan(0);
      expect(rect.left).toBeGreaterThanOrEqual(0);
      expect(rect.top).toBeGreaterThanOrEqual(0);
      expect(rect.left + rect.width).toBeLessThanOrEqual(width + 0.001);
      expect(rect.top + rect.height).toBeLessThanOrEqual(height + 0.001);
    }
    for (let leftIndex = 0; leftIndex < rectangles.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < rectangles.length; rightIndex += 1) {
        expect(overlapArea(rectangles[leftIndex]!, rectangles[rightIndex]!)).toBe(0);
      }
    }
    const occupiedArea = rectangles.reduce((sum, rect) => sum + rect.width * rect.height, 0);
    expect(occupiedArea / (width * height)).toBeGreaterThan(0.96);
  });

  it('gives wider videos proportionally more width when they share a row', () => {
    const rectangles = computeResonanceLayout([
      { id: 'cinema', aspectRatio: 2.4 },
      { id: 'portrait', aspectRatio: 0.6 },
    ], 1200, 360, 8);
    const cinema = rectangles.find((item) => item.id === 'cinema')!;
    const portrait = rectangles.find((item) => item.id === 'portrait')!;
    expect(cinema.top).toBe(portrait.top);
    expect(cinema.width / portrait.width).toBeGreaterThan(3.8);
  });
});

function overlapArea(
  first: { left: number; top: number; width: number; height: number },
  second: { left: number; top: number; width: number; height: number },
): number {
  const width = Math.max(0, Math.min(first.left + first.width, second.left + second.width) - Math.max(first.left, second.left));
  const height = Math.max(0, Math.min(first.top + first.height, second.top + second.height) - Math.max(first.top, second.top));
  return width * height;
}
