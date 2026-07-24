import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MediaCapabilityService,
  resolveMediaToolPaths,
  type BrowserPlaybackPlan,
  type MediaProbeResult,
} from '../src/main/media/MediaCapabilityService';
import type { FilmRepository, FilmPlaybackState } from '../src/main/database/repositories/FilmRepository';
import type { MediaAssetService } from '../src/main/services/MediaAssetService';
import {
  buildHlsTranscodeArgs,
  discoverSidecarSubtitleFiles,
  playbackCacheKey,
  playlistHasPlayableSegment,
  PlaybackSessionService,
} from '../src/main/services/PlaybackSessionService';
import { AppLogger } from '../src/main/system/AppLogger';
import { validatePlaybackProgress, validatePlaybackSessionCreate } from '../src/shared/playbackValidation';

const roots: string[] = [];

function createPlaybackRepository(partFilmId = '11111111-1111-4111-8111-111111111111'): FilmRepository {
  const states = new Map<string, FilmPlaybackState>();
  return {
    filmIdForPart: vi.fn(() => partFilmId),
    playbackState: vi.fn((filmId: string, partId: string | null = null) => {
      const state = states.get(filmId);
      if (!state) return null;
      return {
        ...state,
        positionSeconds: state.lastPartId === partId ? state.positionSeconds : 0,
        durationSeconds: state.lastPartId === partId ? state.durationSeconds : null,
      };
    }),
    markPlayed: vi.fn((filmId: string) => {
      const previous = states.get(filmId);
      states.set(filmId, previous ?? {
        filmId,
        lastPartId: null,
        positionSeconds: 0,
        durationSeconds: null,
        lastPlayedAt: new Date().toISOString(),
      });
    }),
    updatePlaybackProgress: vi.fn((
      filmId: string,
      partId: string | null,
      positionSeconds: number,
      durationSeconds?: number,
    ) => {
      const state: FilmPlaybackState = {
        filmId,
        lastPartId: partId,
        positionSeconds,
        durationSeconds: durationSeconds ?? null,
        lastPlayedAt: new Date().toISOString(),
      };
      states.set(filmId, state);
      return state;
    }),
  } as unknown as FilmRepository;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('web playback pipeline', () => {
  it('builds copy-only HLS remux and selective audio/video transcode commands', () => {
    const remux: BrowserPlaybackPlan = {
      mode: 'remux',
      reason: 'CONTAINER_REMUX_REQUIRED',
      videoMode: 'copy',
      audioMode: 'copy',
    };
    const remuxArgs = buildHlsTranscodeArgs('movie.mkv', 'cache', remux);
    expect(remuxArgs).toContain('copy');
    expect(remuxArgs).not.toContain('libx264');
    expect(remuxArgs).not.toContain('aac');
    expect(remuxArgs).toContain('independent_segments+temp_file');
    expect(remuxArgs.at(-1)).toBe(path.join('cache', 'index.m3u8'));

    const audioTranscode: BrowserPlaybackPlan = {
      mode: 'transcode',
      reason: 'AUDIO_TRANSCODE_REQUIRED',
      videoMode: 'copy',
      audioMode: 'transcode',
    };
    const audioArgs = buildHlsTranscodeArgs('movie.mkv', 'cache', audioTranscode);
    expect(audioArgs).toContain('aac');
    expect(audioArgs).not.toContain('libx264');

    const videoTranscode: BrowserPlaybackPlan = {
      mode: 'transcode',
      reason: 'VIDEO_TRANSCODE_REQUIRED',
      videoMode: 'transcode',
      audioMode: 'transcode',
    };
    const videoArgs = buildHlsTranscodeArgs('movie.mkv', 'cache', videoTranscode);
    expect(videoArgs).toContain('libx264');
    expect(videoArgs).toContain('yuv420p');
    expect(videoArgs).toContain('aac');

    const hardwareArgs = buildHlsTranscodeArgs('movie.mkv', 'cache', videoTranscode, 'nvenc');
    expect(hardwareArgs).toContain('h264_nvenc');
    expect(hardwareArgs).toContain('p4');
    expect(hardwareArgs).not.toContain('libx264');

    const cudaArgs = buildHlsTranscodeArgs('movie.mkv', 'cache', videoTranscode, 'cuda-nvenc');
    expect(cudaArgs).toContain('cuda');
    expect(cudaArgs).toContain('scale_cuda=w=\'min(1920,iw)\':h=-2:format=yuv420p');
    expect(cudaArgs).toContain('h264_nvenc');
    expect(cudaArgs).not.toContain('libx264');
  });

  it('keeps cache identity tied to source revisions and playback profile', () => {
    const plan: BrowserPlaybackPlan = {
      mode: 'remux',
      reason: 'CONTAINER_REMUX_REQUIRED',
      videoMode: 'copy',
      audioMode: 'copy',
    };
    const first = playbackCacheKey('C:\\Movies\\movie.mkv', 100, 1_000, plan);
    expect(playbackCacheKey('C:\\Movies\\movie.mkv', 100, 1_000, plan)).toBe(first);
    expect(playbackCacheKey('C:\\Movies\\movie.mkv', 101, 1_000, plan)).not.toBe(first);
    expect(playbackCacheKey('C:\\Movies\\movie.mkv', 100, 2_000, plan)).not.toBe(first);
    expect(playbackCacheKey('C:\\Movies\\movie.mkv', 100, 1_000, { ...plan, audioMode: 'transcode' })).not.toBe(first);
  });

  it('waits for the first referenced HLS segment to exist and manages the configured cache safely', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'film-playback-cache-'));
    roots.push(root);
    const cacheDirectory = path.join(root, 'playback-cache');
    fs.mkdirSync(cacheDirectory, { recursive: true });
    const playlistPath = path.join(cacheDirectory, 'index.m3u8');
    fs.writeFileSync(playlistPath, '#EXTM3U\n#EXTINF:4,\nsegment-000000.ts\n', 'utf8');
    expect(await playlistHasPlayableSegment(playlistPath)).toBe(false);
    fs.writeFileSync(path.join(cacheDirectory, 'segment-000000.ts'), 'segment');
    expect(await playlistHasPlayableSegment(playlistPath)).toBe(true);

    let maxBytes = 3 * 1024 * 1024 * 1024;
    const service = new PlaybackSessionService(
      { resolve: vi.fn() } as unknown as MediaAssetService,
      createPlaybackRepository(),
      new MediaCapabilityService(() => ''),
      new AppLogger(path.join(root, 'logs')),
      () => ({ directory: cacheDirectory, maxBytes }),
    );
    const before = await service.cacheInfo();
    expect(before).toMatchObject({
      directory: path.resolve(cacheDirectory),
      limitBytes: 3 * 1024 * 1024 * 1024,
      activeJobs: 0,
    });
    expect(before.sizeBytes).toBeGreaterThan(0);
    const cleared = await service.clearCache();
    expect(cleared.sizeBytes).toBe(0);
    expect(fs.existsSync(cacheDirectory)).toBe(true);
    expect(fs.existsSync(playlistPath)).toBe(false);
    for (const name of ['older', 'newer']) {
      const directory = path.join(cacheDirectory, name);
      fs.mkdirSync(directory);
      fs.writeFileSync(path.join(directory, 'segment.ts'), Buffer.alloc(700 * 1024));
    }
    maxBytes = 1024 * 1024;
    const trimmed = await service.applyCachePolicy();
    expect(trimmed.limitBytes).toBe(maxBytes);
    expect(trimmed.sizeBytes).toBeLessThanOrEqual(maxBytes);
    await service.stop();
  });

  it('discovers related sidecar subtitles without exposing unrelated files', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'film-sidecar-subtitles-'));
    roots.push(root);
    const videoPath = path.join(root, 'Example Movie-cd1.mkv');
    fs.writeFileSync(videoPath, 'video');
    fs.writeFileSync(path.join(root, 'Example Movie.zh-Hans.srt'), 'subtitle');
    fs.writeFileSync(path.join(root, 'Another Movie.srt'), 'unrelated');
    expect(await discoverSidecarSubtitleFiles(videoPath)).toEqual([{
      filePath: path.join(root, 'Example Movie.zh-Hans.srt'),
      codec: 'subrip',
      language: 'zh-Hans',
      title: 'Example Movie.zh-Hans.srt',
    }]);
  });

  it('tracks direct-play sessions, ownership and persistent playback progress', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'film-playback-session-'));
    roots.push(root);
    const filePath = path.join(root, 'movie.mp4');
    fs.writeFileSync(filePath, 'browser-compatible-fixture');
    const media = {
      resolve: vi.fn(async () => ({
        filePath,
        fileSize: fs.statSync(filePath).size,
        modifiedAt: fs.statSync(filePath).mtime,
        contentType: 'video/mp4',
      })),
    } as unknown as MediaAssetService;
    const capabilities = new MediaCapabilityService(() => '');
    const directPlan: BrowserPlaybackPlan = {
      mode: 'direct',
      reason: 'BROWSER_COMPATIBLE',
      videoMode: 'copy',
      audioMode: 'copy',
    };
    const directProbe: MediaProbeResult = {
      formats: ['mov', 'mp4'],
      durationSeconds: 90,
      bitRate: 1_000_000,
      video: { index: 0, codec: 'h264', language: null, title: null, width: 1280, height: 720 },
      audio: { index: 1, codec: 'aac', language: null, title: null, channels: 2 },
      subtitles: [{ index: 2, codec: 'subrip', language: 'chi', title: '中文' }],
    };
    vi.spyOn(capabilities, 'playbackPlan').mockResolvedValue({ probe: directProbe, plan: directPlan });
    const films = createPlaybackRepository();
    const service = new PlaybackSessionService(media, films, capabilities, new AppLogger(path.join(root, 'logs')), path.join(root, 'cache'));
    const filmId = '11111111-1111-4111-8111-111111111111';
    const created = await service.create({ filmId }, 'device-a');
    expect(created).toMatchObject({
      mode: 'direct',
      transport: 'direct',
      state: 'ready',
      url: `/media/v1/originals/${filmId}`,
      videoCodec: 'h264',
      audioCodec: 'aac',
      videoMode: 'copy',
      audioMode: 'copy',
      videoEncoder: 'copy',
      videoDecoder: 'copy',
      subtitleTracks: [{
        index: 2,
        codec: 'subrip',
        language: 'chi',
        title: '中文',
        source: 'embedded',
        url: expect.stringContaining('/subtitle-2.vtt'),
        supported: true,
      }],
    });
    expect(JSON.stringify(created)).not.toContain(root);
    expect(() => service.get(created.id, 'device-b')).toThrow('PLAYBACK_SESSION_NOT_FOUND');
    expect(service.updateProgress(created.id, 'device-a', { positionSeconds: 12.5, durationSeconds: 90 }))
      .toMatchObject({ playbackPositionSeconds: 12.5, durationSeconds: 90 });
    service.cancel(created.id, 'device-a');
    expect(() => service.get(created.id, 'device-a')).toThrow('PLAYBACK_SESSION_NOT_FOUND');
    const resumed = await service.create({ filmId }, 'device-a');
    expect(resumed).toMatchObject({ playbackPositionSeconds: 12.5, durationSeconds: 90 });
    service.cancel(resumed.id, 'device-a');
    await service.stop();
  });

  it('validates mutually exclusive database IDs and bounded playback progress', () => {
    const filmId = '11111111-1111-4111-8111-111111111111';
    const partId = '22222222-2222-4222-8222-222222222222';
    expect(validatePlaybackSessionCreate({ filmId })).toEqual({ filmId });
    expect(validatePlaybackSessionCreate({ partId })).toEqual({ partId });
    expect(() => validatePlaybackSessionCreate({ filmId, partId })).toThrow('INVALID_PLAYBACK_REQUEST');
    expect(() => validatePlaybackSessionCreate({ filmId: 'C:\\secret.mkv' })).toThrow('INVALID_PLAYBACK_REQUEST');
    expect(validatePlaybackProgress({ positionSeconds: 12.34567, durationSeconds: 100 }))
      .toEqual({ positionSeconds: 12.346, durationSeconds: 100 });
    expect(() => validatePlaybackProgress({ positionSeconds: -1 })).toThrow('INVALID_PLAYBACK_PROGRESS');
  });

  const localTools = resolveMediaToolPaths('');
  it.skipIf(!localTools.ffmpeg || !localTools.ffprobe)(
    'generates a playable HLS playlist and segment through a real ffmpeg remux',
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'film-playback-ffmpeg-'));
      roots.push(root);
      const sourcePath = path.join(root, 'fixture.mkv');
      const subtitlePath = path.join(root, 'fixture.srt');
      fs.writeFileSync(subtitlePath, '1\n00:00:00,000 --> 00:00:01,500\nLocal Film Library\n', 'utf8');
      const generated = spawnSync(localTools.ffmpeg!, [
        '-hide_banner',
        '-loglevel', 'error',
        '-y',
        '-f', 'lavfi',
        '-i', 'color=c=blue:s=320x180:r=24',
        '-f', 'lavfi',
        '-i', 'sine=frequency=440:sample_rate=48000',
        '-f', 'srt',
        '-i', subtitlePath,
        '-t', '2',
        '-map', '0:v:0',
        '-map', '1:a:0',
        '-map', '2:s:0',
        '-c:v', 'libx264',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-c:s', 'srt',
        '-shortest',
        sourcePath,
      ], { windowsHide: true, encoding: 'utf8' });
      expect(generated.status, generated.stderr).toBe(0);
      const stat = fs.statSync(sourcePath);
      const media = {
        resolve: vi.fn(async () => ({
          filePath: sourcePath,
          fileSize: stat.size,
          modifiedAt: stat.mtime,
          contentType: 'video/x-matroska',
        })),
      } as unknown as MediaAssetService;
      const service = new PlaybackSessionService(
        media,
        createPlaybackRepository(),
        new MediaCapabilityService(() => localTools.ffprobe!),
        new AppLogger(path.join(root, 'logs')),
        path.join(root, 'cache'),
      );
      const session = await service.create(
        { filmId: '11111111-1111-4111-8111-111111111111' },
        'ffmpeg-test-device',
      );
      expect(session).toMatchObject({ mode: 'remux', transport: 'hls' });
      expect(session.subtitleTracks).toHaveLength(2);
      expect(session.subtitleTracks[0]).toMatchObject({ codec: 'subrip', source: 'embedded', supported: true });
      expect(session.subtitleTracks[1]).toMatchObject({
        codec: 'subrip',
        source: 'sidecar',
        title: 'fixture.srt',
        supported: true,
      });
      const playlist = await service.resolvePlaybackFile(session.id, 'index.m3u8', 'ffmpeg-test-device');
      const playlistText = fs.readFileSync(playlist.filePath, 'utf8');
      expect(playlistText).toContain('#EXTM3U');
      expect(playlistText).toMatch(/segment-\d{6}\.ts/);
      const segmentName = playlistText.match(/segment-\d{6}\.ts/)![0];
      const segment = await service.resolvePlaybackFile(session.id, segmentName, 'ffmpeg-test-device');
      expect(segment.contentType).toBe('video/mp2t');
      expect(segment.fileSize).toBeGreaterThan(0);
      const subtitle = await service.resolvePlaybackFile(
        session.id,
        `subtitle-${session.subtitleTracks[0]!.index}.vtt`,
        'ffmpeg-test-device',
      );
      expect(subtitle.contentType).toContain('text/vtt');
      const embeddedVtt = fs.readFileSync(subtitle.filePath, 'utf8');
      expect(embeddedVtt).toContain('WEBVTT');
      expect(embeddedVtt).toContain('line:82% position:50% align:center size:88%');
      const sidecarSubtitle = await service.resolvePlaybackFile(
        session.id,
        `subtitle-${session.subtitleTracks[1]!.index}.vtt`,
        'ffmpeg-test-device',
      );
      expect(sidecarSubtitle.contentType).toContain('text/vtt');
      const sidecarVtt = fs.readFileSync(sidecarSubtitle.filePath, 'utf8');
      expect(sidecarVtt).toContain('WEBVTT');
      expect(sidecarVtt).toContain('line:82% position:50% align:center size:88%');
      service.cancel(session.id, 'ffmpeg-test-device');
      await service.stop();
    },
    30_000,
  );

  it.skipIf(!localTools.ffmpeg || !localTools.ffprobe)(
    'uses the runtime-verified encoder to produce HLS for incompatible video',
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'film-playback-hardware-'));
      roots.push(root);
      const sourcePath = path.join(root, 'mpeg2-source.mpg');
      const generated = spawnSync(localTools.ffmpeg!, [
        '-hide_banner',
        '-loglevel', 'error',
        '-y',
        '-f', 'lavfi',
        '-i', 'color=c=green:s=320x180:r=24',
        '-f', 'lavfi',
        '-i', 'sine=frequency=550:sample_rate=48000',
        '-t', '2',
        '-shortest',
        '-c:v', 'mpeg2video',
        '-c:a', 'mp2',
        '-f', 'mpeg',
        sourcePath,
      ], { windowsHide: true, encoding: 'utf8' });
      expect(generated.status, generated.stderr).toBe(0);
      const stat = fs.statSync(sourcePath);
      const media = {
        resolve: vi.fn(async () => ({
          filePath: sourcePath,
          fileSize: stat.size,
          modifiedAt: stat.mtime,
          contentType: 'video/mpeg',
        })),
      } as unknown as MediaAssetService;
      const capabilities = new MediaCapabilityService(() => localTools.ffprobe!);
      const preferredPipeline = await capabilities.preferredVideoTranscodePipeline();
      const service = new PlaybackSessionService(
        media,
        createPlaybackRepository(),
        capabilities,
        new AppLogger(path.join(root, 'logs')),
        path.join(root, 'cache'),
      );
      const session = await service.create(
        { filmId: '11111111-1111-4111-8111-111111111111' },
        'hardware-test-device',
      );
      expect(session).toMatchObject({
        mode: 'transcode',
        videoMode: 'transcode',
        audioMode: 'transcode',
        videoEncoder: preferredPipeline === 'software' ? 'libx264' : 'h264_nvenc',
        videoDecoder: preferredPipeline === 'cuda-nvenc' ? 'cuda' : 'software',
      });
      const playlist = await service.resolvePlaybackFile(session.id, 'index.m3u8', 'hardware-test-device');
      expect(fs.readFileSync(playlist.filePath, 'utf8')).toContain('#EXTM3U');
      service.cancel(session.id, 'hardware-test-device');
      await service.stop();
    },
    30_000,
  );
});
