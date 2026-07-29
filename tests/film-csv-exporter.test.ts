import { describe, expect, it } from 'vitest';
import { buildFilmCsv, buildFilmCsvFilename } from '../src/main/export/FilmCsvExporter';

describe('film CSV exporter', () => {
  it('writes the requested Chinese columns with a UTF-8 BOM', () => {
    const csv = buildFilmCsv([{
      filename: 'Movie.mkv',
      nfoTitle: 'Movie',
      customCategories: ['Classic', 'Family'],
      actors: ['Actor One', 'Actor Two'],
      nfoSummary: 'Summary',
      highlights: [],
    }]);

    expect(csv).toBe('\uFEFF文件名,NFO标题,我的分类,演员,NFO 摘要,精彩片段\r\nMovie.mkv,Movie,Classic、Family,Actor One、Actor Two,Summary,[]\r\n');
  });

  it('quotes commas, double quotes, and line breaks without losing content', () => {
    const csv = buildFilmCsv([{
      filename: 'Movie, Part 1.mkv',
      nfoTitle: 'A "quoted" title',
      customCategories: [],
      actors: [],
      nfoSummary: 'Line one\r\nLine two',
      highlights: [],
    }]);

    expect(csv).toContain('"Movie, Part 1.mkv"');
    expect(csv).toContain('"A ""quoted"" title"');
    expect(csv).toContain(',"Line one\nLine two",[]\r\n');
  });

  it('writes multiple highlight titles and time ranges as JSON in one escaped CSV cell', () => {
    const highlights = [
      { fileName: 'Movie-CD1.mkv', relativePath: 'Movie/Movie-CD1.mkv', partLabel: 'CD 1', title: 'Opening, "Arrival"', startSeconds: 10, endSeconds: 13, timeRange: '00:00:10 → 00:00:13' },
      { fileName: 'Movie-CD2.mkv', relativePath: 'Movie/Movie-CD2.mkv', partLabel: 'CD 2', title: 'Finale', startSeconds: 3720.5, endSeconds: 3785, timeRange: '01:02:00.5 → 01:03:05' },
    ];
    const csv = buildFilmCsv([{
      filename: 'Movie.mkv',
      nfoTitle: 'Movie',
      customCategories: [],
      actors: [],
      nfoSummary: '',
      highlights,
    }]);
    const json = JSON.stringify(highlights);

    expect(csv).toContain(`,"${json.replaceAll('"', '""')}"\r\n`);
  });

  it('uses the Chinese page name and a local timestamp in exported filenames', () => {
    const exportedAt = new Date(2026, 6, 24, 12, 23, 45);

    expect(buildFilmCsvFilename('favorite', exportedAt)).toBe('收藏_20260724_122345.csv');
    expect(buildFilmCsvFilename('organized', exportedAt)).toBe('已整理_20260724_122345.csv');
  });
});
