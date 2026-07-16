import { describe, expect, it } from 'vitest';
import { buildFilmCsv } from '../src/main/export/FilmCsvExporter';

describe('film CSV exporter', () => {
  it('writes the requested Chinese columns with a UTF-8 BOM', () => {
    const csv = buildFilmCsv([{
      filename: 'Movie.mkv',
      nfoTitle: 'Movie',
      customCategories: ['Classic', 'Family'],
      actors: ['Actor One', 'Actor Two'],
      nfoSummary: 'Summary',
    }]);

    expect(csv).toBe('\uFEFF文件名,NFO标题,我的分类,演员,NFO 摘要\r\nMovie.mkv,Movie,Classic、Family,Actor One、Actor Two,Summary\r\n');
  });

  it('quotes commas, double quotes, and line breaks without losing content', () => {
    const csv = buildFilmCsv([{
      filename: 'Movie, Part 1.mkv',
      nfoTitle: 'A "quoted" title',
      customCategories: [],
      actors: [],
      nfoSummary: 'Line one\r\nLine two',
    }]);

    expect(csv).toContain('"Movie, Part 1.mkv"');
    expect(csv).toContain('"A ""quoted"" title"');
    expect(csv).toContain(',"Line one\nLine two"\r\n');
  });
});
