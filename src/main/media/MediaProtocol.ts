import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { protocol } from 'electron';
import type { AppLogger } from '../system/AppLogger';
import type { FilmRepository, MediaLocation } from '../database/repositories/FilmRepository';
import { resolveExistingSafeMediaPath } from './MediaPathResolver';
import { resolveMimeType } from './MimeTypeResolver';
import { parseRangeHeader } from './RangeResponse';
import { isUuid } from '../../shared/validation';
import { PreviewTranscoder } from './PreviewTranscoder';

export class MediaProtocol {
  private readonly previewTranscoder: PreviewTranscoder;

  public constructor(
    private readonly films: FilmRepository,
    private readonly logger: AppLogger,
    configuredFfprobePath: () => string = () => '',
    previewCacheDirectory = path.join(process.cwd(), '.preview-cache'),
  ) {
    this.previewTranscoder = new PreviewTranscoder(logger, configuredFfprobePath, previewCacheDirectory);
  }

  public registerHandler(): void {
    protocol.handle('film-media', async (request) => this.handle(request));
  }

  private async handle(request: Request): Promise<Response> {
    try {
      if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method Not Allowed', { status: 405 });
      const route = parseMediaUrl(request.url);
      if (!route) return new Response('Not Found', { status: 404 });
      const location = this.resolveLocation(route.kind, route.id);
      if (!location) return new Response('Not Found', { status: 404 });
      if (!fs.existsSync(location.rootPath)) return new Response('Source Offline', { status: 409 });
      const sourceFilePath = await resolveExistingSafeMediaPath(location.rootPath, location.relativePath);
      const sourceStat = await fs.promises.stat(sourceFilePath);
      if (!sourceStat.isFile()) return new Response('Not Found', { status: 404 });
      let filePath = sourceFilePath;
      if (route.kind === 'preview' && this.previewTranscoder.shouldTranscode(sourceFilePath)) {
        const cachedPath = await this.previewTranscoder.prepareCachedFile(sourceFilePath, request.signal);
        if (request.signal.aborted) return new Response(null, { status: 204 });
        if (cachedPath) filePath = cachedPath;
      }
      const stat = filePath === sourceFilePath ? sourceStat : await fs.promises.stat(filePath);
      if (!stat.isFile()) return new Response('Not Found', { status: 404 });
      const rangeResult = parseRangeHeader(request.headers.get('range'), stat.size);
      if (!rangeResult.ok) {
        return new Response(null, {
          status: 416,
          headers: {
            'Accept-Ranges': 'bytes',
            'Content-Range': rangeResult.contentRange,
          },
        });
      }
      const { start, end } = rangeResult.range;
      const partial = Boolean(request.headers.get('range'));
      const headers = new Headers({
        'Accept-Ranges': 'bytes',
        'Content-Length': String(end - start + 1),
        'Content-Type': resolveMimeType(filePath),
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
      });
      if (partial) headers.set('Content-Range', `bytes ${start}-${end}/${stat.size}`);
      if (request.method === 'HEAD') return new Response(null, { status: partial ? 206 : 200, headers });
      const stream = fs.createReadStream(filePath, { start, end });
      return new Response(Readable.toWeb(stream) as unknown as ReadableStream, {
        status: partial ? 206 : 200,
        headers,
      });
    } catch (error) {
      this.logger.error('Media protocol request failed', { error: error instanceof Error ? error.message : 'unknown' });
      const code = error instanceof Error && error.message === 'MEDIA_PATH_OUTSIDE_SOURCE' ? 403 : 404;
      return new Response(code === 403 ? 'Forbidden' : 'Not Found', { status: code });
    }
  }

  private resolveLocation(kind: string, id: string): MediaLocation | null {
    if (kind === 'asset') return this.films.assetLocation(id);
    if (kind === 'preview') return this.films.previewLocation(id);
    if (kind === 'poster') return this.films.preferredAssetLocation(id, ['poster']);
    return null;
  }
}

export function parseMediaUrl(requestUrl: string): { kind: 'asset' | 'preview' | 'poster'; id: string } | null {
  try {
    const url = new URL(requestUrl);
    if (url.search || url.hash) return null;
    const kind = url.hostname as 'asset' | 'preview' | 'poster';
    const id = url.pathname.split('/').filter(Boolean);
    if (!['asset', 'preview', 'poster'].includes(kind) || id.length !== 1 || !isUuid(id[0])) return null;
    return { kind, id: id[0] };
  } catch {
    return null;
  }
}
