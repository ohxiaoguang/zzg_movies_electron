import fs from 'node:fs';
import type { FilmRepository, MediaLocation } from '../database/repositories/FilmRepository';
import { resolveExistingSafeMediaPath } from '../media/MediaPathResolver';
import { resolveMimeType } from '../media/MimeTypeResolver';
import type { PreviewTranscoder } from '../media/PreviewTranscoder';
import { isUuid } from '../../shared/validation';

export type MediaAssetKind = 'asset' | 'poster' | 'preview' | 'original' | 'part';

export interface ResolvedMediaAsset {
  filePath: string;
  fileSize: number;
  modifiedAt: Date;
  contentType: string;
}

export class MediaAssetService {
  public constructor(
    private readonly films: FilmRepository,
    private readonly previewTranscoder?: PreviewTranscoder,
  ) {}

  public async resolve(kind: MediaAssetKind, id: unknown, signal?: AbortSignal): Promise<ResolvedMediaAsset> {
    if (!isUuid(id)) throw new Error('INVALID_MEDIA_ID');
    const location = this.location(kind, id);
    if (!location) throw new Error('MEDIA_NOT_FOUND');
    try {
      const sourceFilePath = await resolveExistingSafeMediaPath(location.rootPath, location.relativePath);
      const filePath = kind === 'preview' && this.previewTranscoder
        ? await this.previewTranscoder.preparePlayableFile(sourceFilePath, signal ?? new AbortController().signal)
        : sourceFilePath;
      const stat = await fs.promises.stat(filePath);
      if (!stat.isFile()) throw new Error('MEDIA_NOT_FOUND');
      return {
        filePath,
        fileSize: stat.size,
        modifiedAt: stat.mtime,
        contentType: resolveMimeType(filePath),
      };
    } catch (error) {
      if (error instanceof Error && error.message === 'MEDIA_PATH_OUTSIDE_SOURCE') throw error;
      throw new Error('MEDIA_NOT_FOUND', { cause: error });
    }
  }

  private location(kind: MediaAssetKind, id: string): MediaLocation | null {
    if (kind === 'asset') return this.films.assetLocation(id);
    if (kind === 'poster') return this.films.preferredAssetLocation(id, ['poster', 'thumb']);
    if (kind === 'preview') return this.films.previewLocation(id);
    if (kind === 'original') return this.films.filmLocation(id);
    return this.films.partLocation(id);
  }
}
