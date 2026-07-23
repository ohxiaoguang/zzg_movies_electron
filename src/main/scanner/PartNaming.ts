import path from 'node:path';

export type FilmPartType = 'single' | 'cd' | 'disc';

export interface ParsedFilmPartName {
  baseName: string;
  partType: Exclude<FilmPartType, 'single'>;
  partNumber: number;
}

const partPattern = /^(.*?)-cd(\d+)$/i;

export function parseFilmPartName(filename: string): ParsedFilmPartName | null {
  const stem = path.parse(filename).name;
  const match = partPattern.exec(stem);
  if (!match) return null;
  const baseName = match[1].trim();
  const partNumber = Number(match[2]);
  if (!baseName || !Number.isInteger(partNumber) || partNumber < 1) return null;
  return {
    baseName,
    partType: 'cd',
    partNumber,
  };
}

export function logicalFilmKey(relativeDirectory: string, filename: string): string {
  const parsed = parseFilmPartName(filename);
  const identity = parsed
    ? parsed.baseName.normalize('NFKC').toLocaleLowerCase()
    : filename.normalize('NFKC').toLocaleLowerCase();
  return `${parsed ? 'parts' : 'single'}:${normalizeRelativeDirectory(relativeDirectory)}:${identity}`;
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
