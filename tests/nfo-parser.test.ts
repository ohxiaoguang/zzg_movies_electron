import { describe, expect, it } from 'vitest';
import { parseNfo } from '../src/main/metadata/NfoParser';

describe('NFO parser', () => {
  it('normalizes multiple genres, directors, actors and ratings', () => {
    const result = parseNfo(
      '<movie>' +
        '<title>示例电影</title><originaltitle>Example Film</originaltitle><year>2026</year><premiered>2026-03-01</premiered>' +
        '<genre>科幻</genre><genre><name>剧情</name></genre>' +
        '<director>导演甲</director><director><name>导演乙</name></director>' +
        '<actor><name>演员甲</name></actor><actor>演员乙</actor>' +
        '<tag>收藏</tag><country>中国</country>' +
        '<ratings><rating name="imdb"><value>8.3</value></rating></ratings>' +
        '<userrating>9</userrating><watched>true</watched>' +
        '<fileinfo><streamdetails><video><codec>h264</codec><width>1920</width><height>1080</height></video><audio><codec>aac</codec></audio></streamdetails></fileinfo>' +
      '</movie>',
    );
    expect(result.title).toBe('示例电影');
    expect(result.genres).toEqual(['科幻', '剧情']);
    expect(result.directors).toEqual(['导演甲', '导演乙']);
    expect(result.actors).toEqual(['演员甲', '演员乙']);
    expect(result.userRating).toBe(9);
    expect(result.watched).toBe(true);
    expect(result.width).toBe(1920);
    expect(result.audioCodec).toBe('aac');
  });

  it('tolerates missing optional fields and scalar values', () => {
    const result = parseNfo('<movie><title>Only title</title><genre>Drama</genre><actor>One</actor></movie>');
    expect(result.title).toBe('Only title');
    expect(result.genres).toEqual(['Drama']);
    expect(result.actors).toEqual(['One']);
    expect(result.plot).toBeNull();
    expect(result.watched).toBe(false);
  });

  it('throws for empty or malformed XML without crashing the caller', () => {
    expect(() => parseNfo('')).toThrow('NFO_EMPTY');
    expect(() => parseNfo('<movie><title>broken')).toThrow();
  });
});
