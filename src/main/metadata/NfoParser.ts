import { XMLParser, XMLValidator } from 'fast-xml-parser';

export interface NfoMetadata {
  title: string | null;
  originalTitle: string | null;
  sortTitle: string | null;
  year: number | null;
  releaseDate: string | null;
  runtimeSeconds: number | null;
  plot: string | null;
  outline: string | null;
  tagline: string | null;
  contentRating: string | null;
  studio: string | null;
  countries: string[];
  directors: string[];
  actors: string[];
  tags: string[];
  genres: string[];
  rating: number | null;
  userRating: number | null;
  playCount: number | null;
  watched: boolean;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  containerFormat: string | null;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  parseTagValue: true,
  trimValues: true,
  removeNSPrefix: true,
});

export function parseNfo(xml: string): NfoMetadata {
  if (!xml.trim()) throw new Error('NFO_EMPTY');
  const validation = XMLValidator.validate(xml);
  if (validation !== true) throw new Error('NFO_INVALID_XML');
  const document = parser.parse(xml) as Record<string, unknown>;
  const movie = (document.movie ?? document.Movie ?? document) as Record<string, unknown>;
  if (!movie || typeof movie !== 'object') throw new Error('NFO_INVALID_ROOT');

  const playCount = numberValue(movie.playcount);
  const watched = booleanValue(movie.watched) || Boolean(playCount && playCount > 0);
  const streamDetails = recordValue(recordValue(movie.fileinfo)?.streamdetails ?? movie.streamdetails);
  const video = firstRecord(streamDetails?.video);
  const audio = firstRecord(streamDetails?.audio);
  const ratings = recordValue(movie.ratings);

  return {
    title: textValue(movie.title),
    originalTitle: textValue(movie.originaltitle),
    sortTitle: textValue(movie.sorttitle),
    year: integerValue(movie.year),
    releaseDate: textValue(movie.premiered) ?? textValue(movie.releasedate),
    runtimeSeconds: integerValue(movie.runtimeinseconds) ?? integerValue(movie.runtime),
    plot: textValue(movie.plot),
    outline: textValue(movie.outline),
    tagline: textValue(movie.tagline),
    contentRating: textValue(movie.mpaa) ?? textValue(movie.contentrating),
    studio: textValue(movie.studio),
    countries: listValue(movie.country),
    directors: listValue(movie.director),
    actors: actorList(movie.actor),
    tags: listValue(movie.tag),
    genres: listValue(movie.genre),
    rating: numberValue(movie.rating) ?? numberValue(ratings?.rating),
    userRating: numberValue(movie.userrating) ?? ratingValue(ratings),
    playCount,
    watched,
    width: integerValue(video?.width),
    height: integerValue(video?.height),
    videoCodec: textValue(video?.codec),
    audioCodec: textValue(audio?.codec),
    containerFormat: textValue(video?.container) ?? textValue(movie.container),
  };
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function firstRecord(value: unknown): Record<string, unknown> | null {
  if (Array.isArray(value)) return value.map(recordValue).find(Boolean) ?? null;
  return recordValue(value);
}

function textValue(value: unknown): string | null {
  if (Array.isArray(value)) return textValue(value[0]);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return textValue(record['#text'] ?? record.name ?? record.value);
  }
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text || null;
}

function listValue(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => listValue(entry)).filter((item, index, items) => items.indexOf(item) === index);
  }
  const text = textValue(value);
  return text ? [text] : [];
}

function actorList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => actorList(entry)).filter((item, index, items) => items.indexOf(item) === index);
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return listValue(record.name ?? record.actor ?? record['#text']);
  }
  return listValue(value);
}

function numberValue(value: unknown): number | null {
  const text = textValue(value);
  if (!text) return null;
  const numeric = Number(text);
  return Number.isFinite(numeric) ? numeric : null;
}

function integerValue(value: unknown): number | null {
  const numeric = numberValue(value);
  return numeric === null ? null : Math.round(numeric);
}

function booleanValue(value: unknown): boolean {
  const text = textValue(value)?.toLowerCase();
  return text === 'true' || text === 'yes' || text === '1';
}

function ratingValue(ratings: Record<string, unknown> | null): number | null {
  if (!ratings) return null;
  const values = Object.values(ratings);
  for (const value of values) {
    const record = recordValue(value);
    const numeric = numberValue(record?.value ?? value);
    if (numeric !== null) return numeric;
  }
  return null;
}
