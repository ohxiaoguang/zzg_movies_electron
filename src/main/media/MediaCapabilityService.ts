import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const DIRECT_MP4_EXTENSIONS = new Set(['.mp4', '.m4v', '.mov']);
const DIRECT_WEBM_EXTENSIONS = new Set(['.webm']);
const MP4_VIDEO_CODECS = new Set(['h264']);
const MP4_AUDIO_CODECS = new Set(['aac', 'mp3']);
const WEBM_VIDEO_CODECS = new Set(['vp8', 'vp9', 'av1']);
const WEBM_AUDIO_CODECS = new Set(['opus', 'vorbis']);

interface ProbeOutput {
  format?: {
    format_name?: string;
    duration?: string;
    bit_rate?: string;
  };
  streams?: Array<{
    index?: number;
    codec_type?: string;
    codec_name?: string;
    width?: number;
    height?: number;
    channels?: number;
    tags?: { language?: string; title?: string };
  }>;
}

export interface MediaStreamProbe {
  index: number;
  codec: string | null;
  language: string | null;
  title: string | null;
}

export interface MediaProbeResult {
  formats: string[];
  durationSeconds: number | null;
  bitRate: number | null;
  video: (MediaStreamProbe & { width: number | null; height: number | null }) | null;
  audio: (MediaStreamProbe & { channels: number | null }) | null;
  subtitles: MediaStreamProbe[];
}

export type BrowserPlaybackMode = 'direct' | 'remux' | 'transcode';

export interface BrowserPlaybackPlan {
  mode: BrowserPlaybackMode;
  reason:
    | 'BROWSER_COMPATIBLE'
    | 'CONTAINER_REMUX_REQUIRED'
    | 'AUDIO_TRANSCODE_REQUIRED'
    | 'VIDEO_TRANSCODE_REQUIRED'
    | 'PROBE_UNAVAILABLE_DIRECT_FALLBACK'
    | 'PROBE_UNAVAILABLE_TRANSCODE_FALLBACK';
  videoMode: 'copy' | 'transcode';
  audioMode: 'none' | 'copy' | 'transcode';
}

export interface MediaToolPaths {
  ffmpeg: string | null;
  ffprobe: string | null;
}

export interface MediaToolStatus {
  ffmpegAvailable: boolean;
  ffprobeAvailable: boolean;
}

export type H264VideoEncoder = 'libx264' | 'h264_nvenc';
export type VideoTranscodePipeline = 'software' | 'nvenc' | 'cuda-nvenc';

export class MediaCapabilityService {
  private readonly probes = new Map<string, Promise<MediaProbeResult | null>>();
  private readonly pipelineProbes = new Map<string, Promise<VideoTranscodePipeline>>();

  public constructor(private readonly configuredFfprobePath: () => string) {}

  public toolPaths(): MediaToolPaths {
    return resolveMediaToolPaths(this.configuredFfprobePath());
  }

  public toolStatus(): MediaToolStatus {
    const tools = this.toolPaths();
    return {
      ffmpegAvailable: Boolean(tools.ffmpeg),
      ffprobeAvailable: Boolean(tools.ffprobe),
    };
  }

  public async inspect(filePath: string): Promise<MediaProbeResult | null> {
    const ffprobePath = this.toolPaths().ffprobe;
    if (!ffprobePath) return null;
    const stat = await fs.promises.stat(filePath);
    const key = `${path.resolve(filePath).toLowerCase()}\0${stat.size}\0${Math.trunc(stat.mtimeMs)}`;
    let pending = this.probes.get(key);
    if (!pending) {
      pending = probeMediaFile(ffprobePath, filePath).finally(() => {
        if (this.probes.size > 250) this.probes.delete(this.probes.keys().next().value as string);
      });
      this.probes.set(key, pending);
    }
    return pending;
  }

  public async playbackPlan(filePath: string): Promise<{ probe: MediaProbeResult | null; plan: BrowserPlaybackPlan }> {
    const probe = await this.inspect(filePath);
    return { probe, plan: planBrowserPlayback(filePath, probe) };
  }

  public async preferredH264Encoder(): Promise<H264VideoEncoder> {
    return await this.preferredVideoTranscodePipeline() === 'software' ? 'libx264' : 'h264_nvenc';
  }

  public async preferredVideoTranscodePipeline(): Promise<VideoTranscodePipeline> {
    const ffmpegPath = this.toolPaths().ffmpeg;
    if (!ffmpegPath) return 'software';
    const key = path.resolve(ffmpegPath).toLowerCase();
    let pending = this.pipelineProbes.get(key);
    if (!pending) {
      pending = inspectVideoTranscodePipeline(ffmpegPath);
      this.pipelineProbes.set(key, pending);
    }
    return pending;
  }
}

export function planBrowserPlayback(filePath: string, probe: MediaProbeResult | null): BrowserPlaybackPlan {
  const extension = path.extname(filePath).toLowerCase();
  if (!probe?.video?.codec) {
    const directFallback = DIRECT_MP4_EXTENSIONS.has(extension) || DIRECT_WEBM_EXTENSIONS.has(extension);
    return {
      mode: directFallback ? 'direct' : 'transcode',
      reason: directFallback ? 'PROBE_UNAVAILABLE_DIRECT_FALLBACK' : 'PROBE_UNAVAILABLE_TRANSCODE_FALLBACK',
      videoMode: directFallback ? 'copy' : 'transcode',
      audioMode: directFallback ? 'copy' : 'transcode',
    };
  }

  const videoCodec = probe.video.codec;
  const audioCodec = probe.audio?.codec ?? null;
  const audioAbsent = probe.audio === null;
  const directMp4 = DIRECT_MP4_EXTENSIONS.has(extension)
    && MP4_VIDEO_CODECS.has(videoCodec)
    && (audioAbsent || (audioCodec !== null && MP4_AUDIO_CODECS.has(audioCodec)));
  const directWebm = DIRECT_WEBM_EXTENSIONS.has(extension)
    && WEBM_VIDEO_CODECS.has(videoCodec)
    && (audioAbsent || (audioCodec !== null && WEBM_AUDIO_CODECS.has(audioCodec)));
  if (directMp4 || directWebm) {
    return {
      mode: 'direct',
      reason: 'BROWSER_COMPATIBLE',
      videoMode: 'copy',
      audioMode: audioAbsent ? 'none' : 'copy',
    };
  }

  if (videoCodec === 'h264') {
    const audioCompatible = audioAbsent || (audioCodec !== null && MP4_AUDIO_CODECS.has(audioCodec));
    return {
      mode: audioCompatible ? 'remux' : 'transcode',
      reason: audioCompatible ? 'CONTAINER_REMUX_REQUIRED' : 'AUDIO_TRANSCODE_REQUIRED',
      videoMode: 'copy',
      audioMode: audioAbsent ? 'none' : audioCompatible ? 'copy' : 'transcode',
    };
  }

  return {
    mode: 'transcode',
    reason: 'VIDEO_TRANSCODE_REQUIRED',
    videoMode: 'transcode',
    audioMode: audioAbsent ? 'none' : 'transcode',
  };
}

export function resolveMediaToolPaths(
  configuredFfprobePath: string,
  environmentPath = process.env.PATH ?? '',
  platform = process.platform,
): MediaToolPaths {
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

export async function probeMediaFile(ffprobePath: string, filePath: string): Promise<MediaProbeResult | null> {
  try {
    const { stdout } = await execFileAsync(
      ffprobePath,
      [
        '-v', 'error',
        '-show_entries',
        'format=format_name,duration,bit_rate:stream=index,codec_type,codec_name,width,height,channels:stream_tags=language,title',
        '-of', 'json',
        filePath,
      ],
      { encoding: 'utf8', timeout: 10_000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 },
    );
    const parsed = JSON.parse(stdout) as ProbeOutput;
    const streams = parsed.streams ?? [];
    const video = streams.find((stream) => stream.codec_type === 'video');
    const audio = streams.find((stream) => stream.codec_type === 'audio');
    return {
      formats: parsed.format?.format_name?.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean) ?? [],
      durationSeconds: finiteNumber(parsed.format?.duration),
      bitRate: finiteNumber(parsed.format?.bit_rate),
      video: video
        ? {
            ...streamProbe(video),
            width: finiteNumber(video.width),
            height: finiteNumber(video.height),
          }
        : null,
      audio: audio
        ? {
            ...streamProbe(audio),
            channels: finiteNumber(audio.channels),
          }
        : null,
      subtitles: streams.filter((stream) => stream.codec_type === 'subtitle').map(streamProbe),
    };
  } catch {
    return null;
  }
}

export function selectPreferredH264Encoder(encoderOutput: string): H264VideoEncoder {
  return /^\s*V\S*\s+h264_nvenc\s+/m.test(encoderOutput) ? 'h264_nvenc' : 'libx264';
}

export function selectPreferredVideoTranscodePipeline(
  encoder: H264VideoEncoder,
  hardwareAccelerationOutput: string,
  filterOutput: string,
): VideoTranscodePipeline {
  if (encoder === 'libx264') return 'software';
  const cudaAvailable = /^\s*cuda\s*$/mi.test(hardwareAccelerationOutput);
  const cudaScaleAvailable = /^\s*\S*\s*scale_cuda\s+/m.test(filterOutput);
  return cudaAvailable && cudaScaleAvailable ? 'cuda-nvenc' : 'nvenc';
}

async function inspectVideoTranscodePipeline(ffmpegPath: string): Promise<VideoTranscodePipeline> {
  try {
    const { stdout, stderr } = await execFileAsync(
      ffmpegPath,
      ['-hide_banner', '-encoders'],
      { encoding: 'utf8', timeout: 5_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
    );
    const encoder = selectPreferredH264Encoder(`${stdout}\n${stderr}`);
    if (encoder !== 'h264_nvenc') return 'software';
    await execFileAsync(
      ffmpegPath,
      [
        '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'color=c=black:s=320x180:d=0.05',
        '-frames:v', '1',
        '-an',
        '-c:v', 'h264_nvenc',
        '-f', 'null', '-',
      ],
      { encoding: 'utf8', timeout: 10_000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 },
    );
    const [hardwareAcceleration, filters] = await Promise.all([
      execFileAsync(
        ffmpegPath,
        ['-hide_banner', '-hwaccels'],
        { encoding: 'utf8', timeout: 5_000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 },
      ),
      execFileAsync(
        ffmpegPath,
        ['-hide_banner', '-filters'],
        { encoding: 'utf8', timeout: 5_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      ),
    ]);
    return selectPreferredVideoTranscodePipeline(
      encoder,
      `${hardwareAcceleration.stdout}\n${hardwareAcceleration.stderr}`,
      `${filters.stdout}\n${filters.stderr}`,
    );
  } catch {
    return 'software';
  }
}

function streamProbe(stream: NonNullable<ProbeOutput['streams']>[number]): MediaStreamProbe {
  return {
    index: Number.isInteger(stream.index) ? Number(stream.index) : 0,
    codec: stream.codec_name?.toLowerCase() ?? null,
    language: stream.tags?.language?.slice(0, 20) ?? null,
    title: stream.tags?.title?.slice(0, 200) ?? null,
  };
}

function finiteNumber(value: unknown): number | null {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function findOnPath(executable: string, environmentPath: string): string | null {
  for (const directory of environmentPath.split(path.delimiter).map((item) => item.trim().replace(/^"|"$/g, '')).filter(Boolean)) {
    const candidate = path.join(directory, executable);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}
