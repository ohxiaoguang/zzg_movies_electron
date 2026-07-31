export interface ResonanceLayoutItem {
  id: string;
  aspectRatio: number;
}

export interface ResonanceLayoutRect {
  id: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

interface RowPartition {
  start: number;
  end: number;
}

export function computeResonanceLayout(
  items: ResonanceLayoutItem[],
  width: number,
  height: number,
  gap = 8,
): ResonanceLayoutRect[] {
  if (!items.length || width <= 0 || height <= 0) return [];
  const safeRatios = items.map((item) => clampRatio(item.aspectRatio));
  const maxRows = Math.min(items.length, 8);
  let bestRows: RowPartition[] = [{ start: 0, end: items.length }];
  let bestScore = Number.POSITIVE_INFINITY;

  for (let rowCount = 1; rowCount <= maxRows; rowCount += 1) {
    const result = partitionRows(safeRatios, rowCount, width, height, gap);
    if (result && result.score < bestScore) {
      bestScore = result.score;
      bestRows = result.rows;
    }
  }

  const usableHeight = Math.max(1, height - gap * (bestRows.length - 1));
  const rowHeight = usableHeight / bestRows.length;
  const rectangles: ResonanceLayoutRect[] = [];
  bestRows.forEach((row, rowIndex) => {
    const ratios = safeRatios.slice(row.start, row.end);
    const usableWidth = Math.max(1, width - gap * (ratios.length - 1));
    const ratioTotal = ratios.reduce((sum, ratio) => sum + ratio, 0);
    let left = 0;
    ratios.forEach((ratio, itemIndex) => {
      const globalIndex = row.start + itemIndex;
      const itemWidth = itemIndex === ratios.length - 1
        ? width - left
        : usableWidth * (ratio / ratioTotal);
      rectangles.push({
        id: items[globalIndex]!.id,
        left,
        top: rowIndex * (rowHeight + gap),
        width: Math.max(1, itemWidth),
        height: Math.max(1, rowHeight),
      });
      left += itemWidth + gap;
    });
  });
  return rectangles;
}

function partitionRows(
  ratios: number[],
  rowCount: number,
  width: number,
  height: number,
  gap: number,
): { rows: RowPartition[]; score: number } | null {
  const itemCount = ratios.length;
  const rowHeight = Math.max(1, (height - gap * (rowCount - 1)) / rowCount);
  const costs = Array.from({ length: rowCount + 1 }, () => Array<number>(itemCount + 1).fill(Number.POSITIVE_INFINITY));
  const previous = Array.from({ length: rowCount + 1 }, () => Array<number>(itemCount + 1).fill(-1));
  costs[0]![0] = 0;

  for (let rows = 1; rows <= rowCount; rows += 1) {
    for (let end = rows; end <= itemCount; end += 1) {
      for (let start = rows - 1; start < end; start += 1) {
        const prior = costs[rows - 1]![start]!;
        if (!Number.isFinite(prior)) continue;
        const rowRatios = ratios.slice(start, end);
        const usableWidth = Math.max(1, width - gap * (rowRatios.length - 1));
        const ratioTotal = rowRatios.reduce((sum, ratio) => sum + ratio, 0);
        const aspectScale = usableWidth / (rowHeight * ratioTotal);
        const cropPenalty = Math.log(Math.max(0.001, aspectScale)) ** 2;
        const densityPenalty = rowRatios.length > 6 ? (rowRatios.length - 6) ** 2 * 0.12 : 0;
        const cost = prior + cropPenalty * rowRatios.length + densityPenalty;
        if (cost < costs[rows]![end]!) {
          costs[rows]![end] = cost;
          previous[rows]![end] = start;
        }
      }
    }
  }

  const score = costs[rowCount]![itemCount]!;
  if (!Number.isFinite(score)) return null;
  const rows: RowPartition[] = [];
  let end = itemCount;
  for (let row = rowCount; row > 0; row -= 1) {
    const start = previous[row]![end]!;
    if (start < 0) return null;
    rows.unshift({ start, end });
    end = start;
  }
  return { rows, score };
}

function clampRatio(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.min(4, Math.max(0.25, value)) : 16 / 9;
}
