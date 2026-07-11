export interface ByteRange {
  start: number;
  end: number;
}

export type RangeParseResult = { ok: true; range: ByteRange } | { ok: false; contentRange: string };

export function parseRangeHeader(header: string | null, size: number): RangeParseResult {
  if (!header) return { ok: true, range: { start: 0, end: Math.max(0, size - 1) } };
  if (size <= 0 || !header.toLowerCase().startsWith('bytes=')) return { ok: false, contentRange: `bytes */${size}` };
  const value = header.slice(header.indexOf('=') + 1).split(',')[0].trim();
  const separator = value.indexOf('-');
  if (separator < 0) return { ok: false, contentRange: `bytes */${size}` };
  const startValue = value.slice(0, separator).trim();
  const endValue = value.slice(separator + 1).trim();
  let start: number;
  let end: number;
  if (!startValue) {
    const suffixLength = Number(endValue);
    if (!Number.isInteger(suffixLength) || suffixLength <= 0) return { ok: false, contentRange: `bytes */${size}` };
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(startValue);
    end = endValue ? Number(endValue) : size - 1;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= size) {
      return { ok: false, contentRange: `bytes */${size}` };
    }
    end = Math.min(end, size - 1);
  }
  return { ok: true, range: { start, end } };
}
