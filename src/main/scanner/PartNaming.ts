import path from 'node:path';

export type FilmPartType = 'single' | 'cd' | 'disc';

export interface ParsedFilmPartName {
  baseName: string;
  partType: Exclude<FilmPartType, 'single'>;
  partNumber: number;
}

const partPattern = /^(.*?)[ ._-](cd|disc)[ ._-]?(\d+)$/i;

export function parseFilmPartName(filename: string): ParsedFilmPartName | null {
  const stem = path.parse(filename).name;
  const match = partPattern.exec(stem);
  if (!match) return null;
  const baseName = match[1].trim();
  const partNumber = Number(match[3]);
  if (!baseName || !Number.isInteger(partNumber) || partNumber < 1) return null;
  return {
    baseName,
    partType: match[2].toLowerCase() as Exclude<FilmPartType, 'single'>,
    partNumber,
  };
}

export function logicalFilmKey(relativeDirectory: string, filename: string): string {
  const parsed = parseFilmPartName(filename);
  const stem = parsed?.baseName ?? path.parse(filename).name;
  const kind = parsed ? 'parts' : 'single';
  return `${kind}:${normalizeRelativeDirectory(relativeDirectory)}:${normalizeFilmName(stem)}`;
}

export function normalizeFilmName(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[._-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Returns the comparison form of a source-relative path. The original path
 * remains in the DTO/database for display and opening the media file.
 */
export function normalizeRelativePath(value: string): string {
  const normalized = normalizeRelativeDirectory(value);
  if (!normalized) {
    throw new Error('INVALID_RELATIVE_PATH');
  }
  return normalized;
}

function normalizeRelativeDirectory(value: string): string {
  const replaced = value.replaceAll('\\', '/').replace(/^\.\//, '');
  const normalized = path.posix.normalize(replaced).replace(/^\.\//, '');
  if (normalized === '.' || normalized === '') return '';
  if (normalized === '..' || normalized.startsWith('../') || normalized.startsWith('/')) {
    throw new Error('INVALID_RELATIVE_PATH');
  }
  return normalized.replace(/\/+/g, '/').toLocaleLowerCase();
}

export function physicalFileKey(sourceId: string, relativePath: string): string {
  return `${sourceId}:${normalizeRelativePath(relativePath)}`;
}
