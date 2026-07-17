import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { Readable } from 'node:stream';
import type { AppLogger } from '../system/AppLogger';

const execFileAsync = promisify(execFile);

export interface PreviewCodecs {
  video: string | null;
  audio: string | null;
}

interface ProbeOutput {
  streams?: Array<{ codec_type?: string; codec_name?: string }>;
}

export interface PreviewToolPaths {
  ffmpeg: string | null;
  ffprobe: string | null;
}

export class PreviewTranscoder {
  public constructor(
    private readonly logger: AppLogger,
    private readonly configuredFfprobePath: () => string,
  ) {}

  public shouldTranscode(filePath: string): boolean {
    return path.extname(filePath).toLowerCase() === '.mkv';
  }

  public async createResponse(filePath: string, request: Request): Promise<Response | null> {
    const tools = resolvePreviewToolPaths(this.configuredFfprobePath());
    if (!tools.ffmpeg) {
      this.logger.warn('MKV compatibility preview unavailable', {
        inputPath: filePath,
        reason: 'FFMPEG_NOT_FOUND',
      });
      return null;
    }
    if (request.method === 'HEAD') return streamingHeadersOnly();

    const codecs = tools.ffprobe ? await probeCodecs(tools.ffprobe, filePath, request.signal) : null;
    if (request.signal.aborted) return new Response(null, { status: 204, headers: streamingHeaders() });
    const args = buildPreviewTranscodeArgs(filePath, codecs);
    const child = spawn(tools.ffmpeg, args, {
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    let cancelled = false;
    const terminate = (): void => {
      if (child.exitCode !== null || child.killed) return;
      cancelled = true;
      child.kill();
    };
    const abort = (): void => terminate();
    if (request.signal.aborted) terminate();
    else request.signal.addEventListener('abort', abort, { once: true });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 3000) stderr += chunk.toString('utf8').slice(0, 3000 - stderr.length);
    });
    child.on('error', (error) => {
      this.logger.error('MKV compatibility preview failed to start', {
        inputPath: filePath,
        error: error.message,
      });
    });
    child.on('close', (code) => {
      request.signal.removeEventListener('abort', abort);
      if (!cancelled && code !== 0) {
        this.logger.warn('MKV compatibility preview ended with an error', {
          inputPath: filePath,
          exitCode: code,
          error: stderr.trim() || 'FFMPEG_TRANSCODE_FAILED',
        });
      }
    });
    child.stdout.once('close', terminate);

    const stream = Readable.toWeb(child.stdout) as unknown as ReadableStream;
    this.logger.info('MKV compatibility preview started', {
      inputPath: filePath,
      videoCodec: codecs?.video ?? 'unknown',
      audioCodec: codecs?.audio ?? 'unknown',
      videoMode: shouldCopyVideo(codecs) ? 'remux' : 'transcode',
      audioMode: shouldCopyAudio(codecs) ? 'remux' : 'transcode',
    });
    return new Response(stream, {
      status: 200,
      headers: streamingHeaders(),
    });
  }
}

export function resolvePreviewToolPaths(
  configuredFfprobePath: string,
  environmentPath = process.env.PATH ?? '',
  platform = process.platform,
): PreviewToolPaths {
  const executableSuffix = platform === 'win32' ? '.exe' : '';
  const configured = configuredFfprobePath.trim();
  const configuredProbe = configured && fs.existsSync(configured) ? path.resolve(configured) : null;
  const configuredFfmpeg = configuredProbe
    ? path.join(path.dirname(configuredProbe), `ffmpeg${executableSuffix}`)
    : null;
  return {
    ffmpeg: configuredFfmpeg && fs.existsSync(configuredFfmpeg)
      ? configuredFfmpeg
      : findOnPath(`ffmpeg${executableSuffix}`, environmentPath),
    ffprobe: configuredProbe ?? findOnPath(`ffprobe${executableSuffix}`, environmentPath),
  };
}

export function buildPreviewTranscodeArgs(filePath: string, codecs: PreviewCodecs | null): string[] {
  const videoArgs = shouldCopyVideo(codecs)
    ? ['-c:v', 'copy']
    : [
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-crf', '27',
        '-pix_fmt', 'yuv420p',
        '-vf', "scale=w='min(1280,iw)':h=-2",
      ];
  const audioArgs = shouldCopyAudio(codecs)
    ? ['-c:a', 'copy']
    : ['-c:a', 'aac', '-b:a', '128k'];
  return [
    '-hide_banner',
    '-loglevel', 'error',
    '-fflags', '+genpts',
    '-i', filePath,
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-sn',
    '-dn',
    '-map_metadata', '-1',
    ...videoArgs,
    ...audioArgs,
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    '-f', 'mp4',
    'pipe:1',
  ];
}

async function probeCodecs(ffprobePath: string, filePath: string, signal: AbortSignal): Promise<PreviewCodecs | null> {
  try {
    const { stdout } = await execFileAsync(
      ffprobePath,
      ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name', '-of', 'json', filePath],
      { encoding: 'utf8', timeout: 5000, windowsHide: true, signal, maxBuffer: 1024 * 1024 },
    );
    const parsed = JSON.parse(stdout) as ProbeOutput;
    return {
      video: parsed.streams?.find((stream) => stream.codec_type === 'video')?.codec_name?.toLowerCase() ?? null,
      audio: parsed.streams?.find((stream) => stream.codec_type === 'audio')?.codec_name?.toLowerCase() ?? null,
    };
  } catch {
    return null;
  }
}

function shouldCopyVideo(codecs: PreviewCodecs | null): boolean {
  return codecs?.video === 'h264';
}

function shouldCopyAudio(codecs: PreviewCodecs | null): boolean {
  return codecs?.audio === 'aac';
}

function findOnPath(executable: string, environmentPath: string): string | null {
  for (const directory of environmentPath.split(path.delimiter).map((item) => item.trim().replace(/^"|"$/g, '')).filter(Boolean)) {
    const candidate = path.join(directory, executable);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function streamingHeaders(): Headers {
  return new Headers({
    'Content-Type': 'video/mp4',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
}

function streamingHeadersOnly(): Response {
  return new Response(null, { status: 200, headers: streamingHeaders() });
}
