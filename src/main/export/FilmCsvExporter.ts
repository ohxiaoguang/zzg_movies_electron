export interface FilmCsvRow {
  filename: string;
  nfoTitle: string;
  customCategories: string[];
  actors: string[];
  nfoSummary: string;
}

const HEADERS = ['文件名', 'NFO标题', '我的分类', '演员', 'NFO 摘要'];

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
