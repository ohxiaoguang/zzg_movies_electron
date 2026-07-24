import { describe, expect, it } from 'vitest';
import {
  planBrowserPlayback,
  selectPreferredH264Encoder,
  selectPreferredVideoTranscodePipeline,
  type MediaProbeResult,
} from '../src/main/media/MediaCapabilityService';

function probe(video: string, audio: string | null, formats: string[] = ['matroska']): MediaProbeResult {
  return {
    formats,
    durationSeconds: 120,
    bitRate: 8_000_000,
    video: { index: 0, codec: video, language: null, title: null, width: 1920, height: 1080 },
    audio: audio ? { index: 1, codec: audio, language: 'chi', title: null, channels: 6 } : null,
    subtitles: [{ index: 2, codec: 'subrip', language: 'chi', title: '中文' }],
  };
}

describe('browser media capability planning', () => {
  it('prefers NVIDIA H.264 encoding only when the FFmpeg build exposes NVENC', () => {
    expect(selectPreferredH264Encoder(' V....D h264_nvenc NVIDIA NVENC H.264 encoder')).toBe('h264_nvenc');
    expect(selectPreferredH264Encoder(' V..... libx264 libx264 H.264 encoder')).toBe('libx264');
    expect(selectPreferredVideoTranscodePipeline('h264_nvenc', 'cuda\nqsv', ' ... scale_cuda V->V')).toBe('cuda-nvenc');
    expect(selectPreferredVideoTranscodePipeline('h264_nvenc', 'qsv', ' ... scale_cuda V->V')).toBe('nvenc');
    expect(selectPreferredVideoTranscodePipeline('libx264', 'cuda', ' ... scale_cuda V->V')).toBe('software');
  });

  it('direct-plays browser-compatible MP4 and WebM combinations', () => {
    expect(planBrowserPlayback('movie.mp4', probe('h264', 'aac', ['mov', 'mp4']))).toMatchObject({
      mode: 'direct',
      reason: 'BROWSER_COMPATIBLE',
      videoMode: 'copy',
      audioMode: 'copy',
    });
    expect(planBrowserPlayback('movie.webm', probe('vp9', 'opus', ['matroska', 'webm']))).toMatchObject({
      mode: 'direct',
      videoMode: 'copy',
      audioMode: 'copy',
    });
  });

  it('remuxes H.264/AAC in a browser-incompatible container without re-encoding', () => {
    expect(planBrowserPlayback('movie.mkv', probe('h264', 'aac'))).toEqual({
      mode: 'remux',
      reason: 'CONTAINER_REMUX_REQUIRED',
      videoMode: 'copy',
      audioMode: 'copy',
    });
  });

  it('only transcodes incompatible audio when H.264 video can be copied', () => {
    expect(planBrowserPlayback('movie.mkv', probe('h264', 'dts'))).toEqual({
      mode: 'transcode',
      reason: 'AUDIO_TRANSCODE_REQUIRED',
      videoMode: 'copy',
      audioMode: 'transcode',
    });
  });

  it('transcodes HEVC video and falls back safely when probing is unavailable', () => {
    expect(planBrowserPlayback('movie.mkv', probe('hevc', 'truehd'))).toMatchObject({
      mode: 'transcode',
      reason: 'VIDEO_TRANSCODE_REQUIRED',
      videoMode: 'transcode',
      audioMode: 'transcode',
    });
    expect(planBrowserPlayback('unknown.mp4', null)).toMatchObject({
      mode: 'direct',
      reason: 'PROBE_UNAVAILABLE_DIRECT_FALLBACK',
    });
    expect(planBrowserPlayback('unknown.mkv', null)).toMatchObject({
      mode: 'transcode',
      reason: 'PROBE_UNAVAILABLE_TRANSCODE_FALLBACK',
    });
  });
});
