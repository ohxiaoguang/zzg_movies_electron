export interface FilmCsvRow {
  filename: string;
  nfoTitle: string;
  customCategories: string[];
  actors: string[];
  nfoSummary: string;
}

export type FilmCsvScope = 'favorite' | 'organized';

const HEADERS = ['文件名', 'NFO标题', '我的分类', '演员', 'NFO 摘要'];
const SCOPE_LABELS: Record<FilmCsvScope, string> = {
  favorite: '收藏',
  organized: '已整理',
};

export function buildFilmCsvFilename(scope: FilmCsvScope, date = new Date()): string {
  const timestamp = [
    date.getFullYear(),
    twoDigits(date.getMonth() + 1),
    twoDigits(date.getDate()),
    '_',
    twoDigits(date.getHours()),
    twoDigits(date.getMinutes()),
    twoDigits(date.getSeconds()),
  ].join('');
  return `${SCOPE_LABELS[scope]}_${timestamp}.csv`;
}

export function buildFilmCsv(rows: FilmCsvRow[]): string {
  const lines = [HEADERS, ...rows.map((row) => [
    row.filename,
    row.nfoTitle,
    row.customCategories.join('、'),
    row.actors.join('、'),
    row.nfoSummary,
  ])];
  return `\uFEFF${lines.map((line) => line.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

function csvCell(value: string): string {
  const normalized = value.replace(/\r\n|\r/g, '\n');
  return /[",\n]/.test(normalized) ? `"${normalized.replaceAll('"', '""')}"` : normalized;
}

function twoDigits(value: number): string {
  return String(value).padStart(2, '0');
}
