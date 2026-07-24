import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import type {
  PlaybackCacheInfoDto,
  WebPlaybackCapabilityDto,
  WebPlaybackProgressInput,
  WebPlaybackSessionCreateInput,
  WebPlaybackSessionDto,
  WebPlaybackState,
} from '../../shared/contracts';
import type { AppLogger } from '../system/AppLogger';
import type { FilmRepository } from '../database/repositories/FilmRepository';
import type { MediaAssetService, ResolvedMediaAsset } from './MediaAssetService';
import {
  type BrowserPlaybackPlan,
  MediaCapabilityService,
  type MediaProbeResult,
  type MediaStreamProbe,
  type VideoTranscodePipeline,
} from '../media/MediaCapabilityService';

const DEFAULT_MAX_CONCURRENT_JOBS = 2;
const SESSION_IDLE_MS = 30 * 60 * 1000;
const PLAYLIST_WAIT_MS = 30 * 1000;
const HLS_SEGMENT_SECONDS = 4;
const DEFAULT_MAX_CACHE_BYTES = 20 * 1024 * 1024 * 1024;
const MAX_CACHE_AGE_MS = 24 * 60 * 60 * 1000;
const HLS_FILE_PATTERN = /^(?:index\.m3u8|segment-\d{6}\.ts)$/;
const SUBTITLE_FILE_PATTERN = /^subtitle-(\d+)\.vtt$/;
const TEXT_SUBTITLE_CODECS = new Set(['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'mov_text', 'text']);

interface PlaybackSession {
  id: string;
  ownerDeviceId: string | null;
  filmId: string;
  partId: string | null;
  source: WebPlaybackSessionCreateInput;
  sourceFilePath: string;
  directUrl: string | null;
  plan: BrowserPlaybackPlan;
  probe: MediaProbeResult | null;
  subtitleTracks: PlaybackSubtitleTrack[];
  jobKey: string | null;
  playbackPositionSeconds: number;
  playbackDurationSeconds: number | null;
  state: WebPlaybackState;
  errorCode: string | null;
  createdAt: number;
  lastAccessAt: number;
}

interface PlaybackSubtitleTrack {
  index: number;
  codec: string | null;
  language: string | null;
  title: string | null;
  source: 'embedded' | 'sidecar';
  sourceFilePath: string | null;
  supported: boolean;
}

interface PlaybackJob {
  mapKey: string;
  key: string;
  cacheRoot: string;
  maxCacheBytes: number;
  directory: string;
  playlistPath: string;
  process: ChildProcess | null;
  state: WebPlaybackState;
  progressSeconds: number;
  durationSeconds: number | null;
  errorCode: string | null;
  stderr: string;
  videoPipeline: 'copy' | 'cached' | VideoTranscodePipeline;
  consumers: Set<string>;
  lastAccessAt: number;
}

export interface PlaybackSessionServiceOptions {
  maxConcurrentJobs?: number;
}

export interface PlaybackCacheConfiguration {
  directory: string;
  maxBytes: number;
}

export class PlaybackSessionService {
  private readonly sessions = new Map<string, PlaybackSession>();
  private readonly jobs = new Map<string, PlaybackJob>();
  private readonly subtitleConversions = new Map<string, Promise<string>>();
  private readonly maxConcurrentJobs: number;
  private readonly cleanupTimer: ReturnType<typeof setInterval>;
  private readonly cacheConfigurationProvider: () => PlaybackCacheConfiguration;

  public constructor(
    private readonly media: MediaAssetService,
    private readonly films: FilmRepository,
    private readonly capabilities: MediaCapabilityService,
    private readonly logger: AppLogger,
    cacheConfiguration: string | (() => PlaybackCacheConfiguration),
    options: PlaybackSessionServiceOptions = {},
  ) {
    this.cacheConfigurationProvider = typeof cacheConfiguration === 'string'
      ? () => ({ directory: cacheConfiguration, maxBytes: DEFAULT_MAX_CACHE_BYTES })
      : cacheConfiguration;
    this.maxConcurrentJobs = Math.max(1, Math.min(4, Math.floor(options.maxConcurrentJobs ?? DEFAULT_MAX_CONCURRENT_JOBS)));
    this.cleanupTimer = setInterval(() => this.cleanupExpiredSessions(), 60_000);
    this.cleanupTimer.unref();
  }

  public capability(): WebPlaybackCapabilityDto {
    const tools = this.capabilities.toolStatus();
    return {
      ...tools,
      maxConcurrentJobs: this.maxConcurrentJobs,
      activeJobs: this.activeJobCount(),
    };
  }

  public async cacheInfo(): Promise<PlaybackCacheInfoDto> {
    const configuration = this.cacheConfiguration();
    await fs.promises.mkdir(configuration.directory, { recursive: true });
    return {
      directory: configuration.directory,
      sizeBytes: await directorySize(configuration.directory),
      limitBytes: configuration.maxBytes,
      activeJobs: this.activeCacheJobCount(configuration.directory),
    };
  }

  public async clearCache(): Promise<PlaybackCacheInfoDto> {
    const configuration = this.cacheConfiguration();
    const busy = [...this.jobs.values()].some((job) => (
      isInsideDirectory(configuration.directory, job.directory)
      && (job.process !== null || job.consumers.size > 0)
    ));
    if (busy || this.subtitleConversions.size > 0) throw new Error('PLAYBACK_CACHE_BUSY');
    await fs.promises.rm(configuration.directory, { recursive: true, force: true });
    await fs.promises.mkdir(configuration.directory, { recursive: true });
    for (const [mapKey, job] of this.jobs) {
      if (isInsideDirectory(configuration.directory, job.directory)) this.jobs.delete(mapKey);
    }
    this.logger.info('Web playback cache cleared', { cachePath: configuration.directory });
    return this.cacheInfo();
  }

  public async applyCachePolicy(): Promise<PlaybackCacheInfoDto> {
    const configuration = this.cacheConfiguration();
    await fs.promises.mkdir(configuration.directory, { recursive: true });
    await this.pruneCache(configuration);
    return this.cacheInfo();
  }

  public async create(input: WebPlaybackSessionCreateInput, ownerDeviceId: string | null): Promise<WebPlaybackSessionDto> {
    const sourceKind = input.filmId ? 'original' : 'part';
    const sourceId = input.filmId ?? input.partId!;
    const asset = await this.media.resolve(sourceKind, sourceId);
    const filmId = input.filmId ?? this.films.filmIdForPart(input.partId!);
    if (!filmId) throw new Error('FILM_NOT_FOUND');
    const partId = input.partId ?? null;
    const savedPlayback = this.films.playbackState(filmId, partId);
    const { probe, plan } = await this.capabilities.playbackPlan(asset.filePath);
    const subtitleTracks = await resolvePlaybackSubtitleTracks(
      asset.filePath,
      probe?.subtitles ?? [],
      Boolean(this.capabilities.toolPaths().ffmpeg),
    );
    const now = Date.now();
    const session: PlaybackSession = {
      id: randomUUID(),
      ownerDeviceId,
      filmId,
      partId,
      source: { ...input },
      sourceFilePath: asset.filePath,
      directUrl: plan.mode === 'direct'
        ? `/media/v1/${input.filmId ? 'originals' : 'parts'}/${encodeURIComponent(sourceId)}`
        : null,
      plan,
      probe,
      subtitleTracks,
      jobKey: null,
      playbackPositionSeconds: savedPlayback?.positionSeconds ?? 0,
      playbackDurationSeconds: savedPlayback?.durationSeconds ?? probe?.durationSeconds ?? null,
      state: plan.mode === 'direct' ? 'ready' : 'preparing',
      errorCode: null,
      createdAt: now,
      lastAccessAt: now,
    };
    this.sessions.set(session.id, session);

    try {
      if (plan.mode !== 'direct') {
        const job = await this.acquireHlsJob(session, asset);
        session.jobKey = job.mapKey;
        job.consumers.add(session.id);
        session.state = job.state === 'complete' ? 'complete' : 'ready';
      }
      this.films.markPlayed(filmId);
      this.logger.info('Web playback session created', {
        sessionId: session.id,
        deviceId: ownerDeviceId,
        playbackMode: plan.mode,
        reason: plan.reason,
        videoCodec: probe?.video?.codec ?? 'unknown',
        audioCodec: probe?.audio?.codec ?? 'unknown',
      });
      return this.toDto(session);
    } catch (error) {
      session.state = 'error';
      session.errorCode = errorCode(error);
      this.sessions.delete(session.id);
      throw error;
    }
  }

  public get(sessionId: string, ownerDeviceId: string | null): WebPlaybackSessionDto {
    const session = this.ownedSession(sessionId, ownerDeviceId);
    session.lastAccessAt = Date.now();
    return this.toDto(session);
  }

  public updateProgress(
    sessionId: string,
    ownerDeviceId: string | null,
    progress: WebPlaybackProgressInput,
  ): WebPlaybackSessionDto {
    const session = this.ownedSession(sessionId, ownerDeviceId);
    session.playbackPositionSeconds = progress.positionSeconds;
    if (progress.durationSeconds !== undefined) session.playbackDurationSeconds = progress.durationSeconds;
    session.lastAccessAt = Date.now();
    this.films.updatePlaybackProgress(
      session.filmId,
      session.partId,
      session.playbackPositionSeconds,
      session.playbackDurationSeconds ?? undefined,
    );
    return this.toDto(session);
  }

  public cancel(sessionId: string, ownerDeviceId: string | null): void {
    const session = this.ownedSession(sessionId, ownerDeviceId);
    session.state = 'cancelled';
    this.sessions.delete(session.id);
    this.releaseJob(session);
    this.logger.info('Web playback session cancelled', {
      sessionId: session.id,
      deviceId: ownerDeviceId,
      playbackMode: session.plan.mode,
    });
  }

  public async resolvePlaybackFile(
    sessionId: string,
    filename: string,
    ownerDeviceId: string | null,
  ): Promise<ResolvedMediaAsset> {
    const session = this.ownedSession(sessionId, ownerDeviceId);
    const subtitleMatch = filename.match(SUBTITLE_FILE_PATTERN);
    if (subtitleMatch) return this.resolveSubtitleFile(session, Number(subtitleMatch[1]));
    if (!HLS_FILE_PATTERN.test(filename)) throw new Error('PLAYBACK_MEDIA_NOT_FOUND');
    if (!session.jobKey) throw new Error('PLAYBACK_MEDIA_NOT_FOUND');
    const job = this.jobs.get(session.jobKey);
    if (!job) throw new Error('PLAYBACK_MEDIA_NOT_FOUND');
    session.lastAccessAt = Date.now();
    job.lastAccessAt = session.lastAccessAt;
    const filePath = path.join(job.directory, filename);
    assertInsideDirectory(job.directory, filePath);
    await waitForFile(filePath, job, filename === 'index.m3u8' ? 10_000 : 2_000);
    const stat = await fs.promises.stat(filePath).catch(() => null);
    if (!stat?.isFile()) throw new Error('PLAYBACK_MEDIA_NOT_FOUND');
    return {
      filePath,
      fileSize: stat.size,
      modifiedAt: stat.mtime,
      contentType: filename.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t',
    };
  }

  public async stop(): Promise<void> {
    await Promise.all([...this.jobs.values()].map((job) => this.stopJobProcess(job)));
    this.sessions.clear();
    this.jobs.clear();
  }

  private async acquireHlsJob(session: PlaybackSession, asset: ResolvedMediaAsset): Promise<PlaybackJob> {
    const tools = this.capabilities.toolPaths();
    if (!tools.ffmpeg) throw new Error('PLAYBACK_TOOLS_UNAVAILABLE');
    const sourceStat = await fs.promises.stat(asset.filePath);
    const key = playbackCacheKey(asset.filePath, sourceStat.size, sourceStat.mtimeMs, session.plan);
    const cacheConfiguration = this.cacheConfiguration();
    const directory = path.join(cacheConfiguration.directory, key);
    const mapKey = playbackJobMapKey(directory, key);
    const existing = this.jobs.get(mapKey);
    if (existing) {
      await waitUntilPlayable(existing);
      return existing;
    }

    const playlistPath = path.join(directory, 'index.m3u8');
    assertInsideDirectory(cacheConfiguration.directory, directory);
    if (await isCompletePlaylist(playlistPath)) {
      const cached: PlaybackJob = {
        mapKey,
        key,
        cacheRoot: cacheConfiguration.directory,
        maxCacheBytes: cacheConfiguration.maxBytes,
        directory,
        playlistPath,
        process: null,
        state: 'complete',
        progressSeconds: session.probe?.durationSeconds ?? 0,
        durationSeconds: session.probe?.durationSeconds ?? null,
        errorCode: null,
        stderr: '',
        videoPipeline: session.plan.videoMode === 'copy' ? 'copy' : 'cached',
        consumers: new Set(),
        lastAccessAt: Date.now(),
      };
      this.jobs.set(mapKey, cached);
      return cached;
    }

    if (this.activeJobCount() >= this.maxConcurrentJobs) throw new Error('PLAYBACK_BUSY');
    const preferredVideoPipeline = session.plan.videoMode === 'transcode'
      ? await this.capabilities.preferredVideoTranscodePipeline()
      : 'copy';
    await fs.promises.rm(directory, { recursive: true, force: true });
    await fs.promises.mkdir(directory, { recursive: true });
    const job: PlaybackJob = {
      mapKey,
      key,
      cacheRoot: cacheConfiguration.directory,
      maxCacheBytes: cacheConfiguration.maxBytes,
      directory,
      playlistPath,
      process: null,
      state: 'preparing',
      progressSeconds: 0,
      durationSeconds: session.probe?.durationSeconds ?? null,
      errorCode: null,
      stderr: '',
      videoPipeline: preferredVideoPipeline,
      consumers: new Set(),
      lastAccessAt: Date.now(),
    };
    this.jobs.set(mapKey, job);
    await this.startFfmpegWithFallback(job, tools.ffmpeg, asset.filePath, session.plan);
    if (job.state === 'preparing') job.state = 'ready';
    return job;
  }

  private async startFfmpegWithFallback(
    job: PlaybackJob,
    ffmpegPath: string,
    sourceFilePath: string,
    plan: BrowserPlaybackPlan,
  ): Promise<void> {
    const candidates = playbackPipelineCandidates(job.videoPipeline);
    for (let index = 0; index < candidates.length; index += 1) {
      job.videoPipeline = candidates[index]!;
      this.startFfmpeg(job, ffmpegPath, sourceFilePath, plan);
      try {
        await waitUntilPlayable(job);
        return;
      } catch (error) {
        if (index === candidates.length - 1) throw error;
        const failedPipeline = job.videoPipeline;
        const failedErrorCode = job.errorCode ?? errorCode(error);
        const failedStderr = job.stderr;
        await this.stopJobProcess(job);
        await fs.promises.rm(job.directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        await fs.promises.mkdir(job.directory, { recursive: true });
        job.state = 'preparing';
        job.progressSeconds = 0;
        job.errorCode = null;
        job.stderr = '';
        this.logger.warn('Playback hardware pipeline unavailable; falling back', {
          cacheKey: job.key,
          failedPipeline,
          nextPipeline: candidates[index + 1],
          errorCode: failedErrorCode,
          stderr: failedStderr,
        });
      }
    }
  }

  private startFfmpeg(job: PlaybackJob, ffmpegPath: string, sourceFilePath: string, plan: BrowserPlaybackPlan): void {
    const args = buildHlsTranscodeArgs(sourceFilePath, job.directory, plan, job.videoPipeline);
    const child = spawn(ffmpegPath, args, {
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    job.process = child;
    let progressBuffer = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      progressBuffer += chunk.toString('utf8');
      const lines = progressBuffer.split(/\r?\n/);
      progressBuffer = lines.pop() ?? '';
      for (const line of lines) {
        const [key, value] = line.split('=', 2);
        if (key === 'out_time_us' || key === 'out_time_ms') {
          const micros = Number(value);
          if (Number.isFinite(micros)) job.progressSeconds = Math.max(job.progressSeconds, micros / 1_000_000);
        }
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (job.stderr.length < 4000) job.stderr += chunk.toString('utf8').slice(0, 4000 - job.stderr.length);
    });
    child.once('error', (error) => {
      if (job.process !== child) return;
      job.state = 'error';
      job.errorCode = 'FFMPEG_START_FAILED';
      this.logger.warn('Web playback process failed to start', {
        cacheKey: job.key,
        error: error.message,
      });
    });
    child.once('close', (code, signal) => {
      if (job.process !== child) return;
      job.process = null;
      if (code === 0) {
        job.state = 'complete';
        if (job.durationSeconds !== null) job.progressSeconds = job.durationSeconds;
        this.logger.info('Web playback HLS cache ready', {
          cacheKey: job.key,
          playbackMode: plan.mode,
          videoPipeline: job.videoPipeline,
        });
        void this.pruneCache({ directory: job.cacheRoot, maxBytes: job.maxCacheBytes });
        return;
      }
      if (job.state === 'cancelled') return;
      job.state = 'error';
      job.errorCode = signal ? 'FFMPEG_CANCELLED' : `FFMPEG_EXIT_${code ?? 'UNKNOWN'}`;
      this.logger.warn('Web playback process failed', {
        cacheKey: job.key,
        playbackMode: plan.mode,
        videoPipeline: job.videoPipeline,
        errorCode: job.errorCode,
        stderr: job.stderr,
      });
    });
    this.logger.info('Web playback process started', {
      cacheKey: job.key,
      playbackMode: plan.mode,
      reason: plan.reason,
      videoMode: plan.videoMode,
      audioMode: plan.audioMode,
      videoPipeline: job.videoPipeline,
    });
  }

  private async stopJobProcess(job: PlaybackJob): Promise<void> {
    const child = job.process;
    if (!child) return;
    job.process = null;
    if (child.exitCode !== null) return;
    const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
    child.kill();
    await Promise.race([closed, delay(2_000)]);
  }

  private ownedSession(sessionId: string, ownerDeviceId: string | null): PlaybackSession {
    const session = this.sessions.get(sessionId);
    if (!session || session.ownerDeviceId !== ownerDeviceId) throw new Error('PLAYBACK_SESSION_NOT_FOUND');
    return session;
  }

  private toDto(session: PlaybackSession): WebPlaybackSessionDto {
    const job = session.jobKey ? this.jobs.get(session.jobKey) ?? null : null;
    const state = session.state === 'cancelled' || session.state === 'error'
      ? session.state
      : job?.state ?? session.state;
    const processPercent = job?.durationSeconds && job.durationSeconds > 0
      ? Math.min(100, Math.round((job.progressSeconds / job.durationSeconds) * 1000) / 10)
      : state === 'complete' ? 100 : null;
    return {
      id: session.id,
      mode: session.plan.mode,
      transport: session.plan.mode === 'direct' ? 'direct' : 'hls',
      state,
      url: session.directUrl ?? `/media/v1/playback/${session.id}/index.m3u8`,
      reason: session.plan.reason,
      videoCodec: session.probe?.video?.codec ?? null,
      audioCodec: session.probe?.audio?.codec ?? null,
      videoMode: session.plan.videoMode,
      audioMode: session.plan.audioMode,
      videoEncoder: playbackVideoEncoder(session.plan, job),
      videoDecoder: playbackVideoDecoder(session.plan, job),
      container: session.probe?.formats[0] ?? null,
      durationSeconds: session.playbackDurationSeconds ?? session.probe?.durationSeconds ?? null,
      processPercent,
      playbackPositionSeconds: session.playbackPositionSeconds,
      subtitleTracks: session.subtitleTracks.map((track) => ({
        index: track.index,
        codec: track.codec,
        language: track.language,
        title: track.title,
        source: track.source,
        url: `/media/v1/playback/${session.id}/subtitle-${track.index}.vtt`,
        supported: track.supported,
      })),
      errorCode: session.errorCode ?? job?.errorCode ?? null,
      expiresAt: new Date(session.lastAccessAt + SESSION_IDLE_MS).toISOString(),
    };
  }

  private async resolveSubtitleFile(session: PlaybackSession, streamIndex: number): Promise<ResolvedMediaAsset> {
    const subtitle = session.subtitleTracks.find((track) => track.index === streamIndex);
    if (!subtitle) throw new Error('PLAYBACK_MEDIA_NOT_FOUND');
    if (!subtitle.supported) throw new Error('SUBTITLE_UNSUPPORTED');
    const sourceFilePath = subtitle.sourceFilePath ?? session.sourceFilePath;
    const sourceStat = await fs.promises.stat(sourceFilePath);
    const key = subtitle.source === 'sidecar'
      ? sidecarSubtitleCacheKey(sourceFilePath, sourceStat.size, sourceStat.mtimeMs)
      : subtitleCacheKey(sourceFilePath, sourceStat.size, sourceStat.mtimeMs, streamIndex);
    const cacheConfiguration = this.cacheConfiguration();
    const directory = path.join(cacheConfiguration.directory, 'subtitles', key);
    const outputPath = path.join(directory, `subtitle-${streamIndex}.vtt`);
    assertInsideDirectory(cacheConfiguration.directory, directory);
    if (!await fileExists(outputPath)) {
      const conversionKey = `${path.resolve(directory)}\0${key}`;
      let conversion = this.subtitleConversions.get(conversionKey);
      if (!conversion) {
        conversion = subtitle.source === 'sidecar'
          ? convertSidecarSubtitle(
              this.capabilities.toolPaths().ffmpeg,
              sourceFilePath,
              directory,
              outputPath,
            )
          : convertEmbeddedSubtitle(
              requiredFfmpegPath(this.capabilities.toolPaths().ffmpeg),
              sourceFilePath,
              streamIndex,
              directory,
              outputPath,
            );
        conversion = conversion
          .finally(() => this.subtitleConversions.delete(conversionKey));
        this.subtitleConversions.set(conversionKey, conversion);
      }
      await conversion;
    }
    const stat = await fs.promises.stat(outputPath).catch(() => null);
    if (!stat?.isFile()) throw new Error('PLAYBACK_MEDIA_NOT_FOUND');
    return {
      filePath: outputPath,
      fileSize: stat.size,
      modifiedAt: stat.mtime,
      contentType: 'text/vtt; charset=utf-8',
    };
  }

  private releaseJob(session: PlaybackSession): void {
    if (!session.jobKey) return;
    const job = this.jobs.get(session.jobKey);
    if (!job) return;
    job.consumers.delete(session.id);
    if (job.consumers.size === 0 && job.process) {
      job.state = 'cancelled';
      job.process.kill();
    }
  }

  private cleanupExpiredSessions(): void {
    const cutoff = Date.now() - SESSION_IDLE_MS;
    for (const session of this.sessions.values()) {
      if (session.lastAccessAt >= cutoff) continue;
      this.sessions.delete(session.id);
      this.releaseJob(session);
    }
    for (const [key, job] of this.jobs) {
      if (job.consumers.size === 0 && !job.process && job.lastAccessAt < cutoff) this.jobs.delete(key);
    }
  }

  private activeJobCount(): number {
    return [...this.jobs.values()].filter((job) => job.process !== null && job.state !== 'cancelled' && job.state !== 'error').length;
  }

  private activeCacheJobCount(cacheDirectory: string): number {
    return [...this.jobs.values()].filter((job) => (
      isInsideDirectory(cacheDirectory, job.directory)
      && job.process !== null
      && job.state !== 'cancelled'
      && job.state !== 'error'
    )).length;
  }

  private cacheConfiguration(): PlaybackCacheConfiguration {
    const value = this.cacheConfigurationProvider();
    const directory = assertSafePlaybackCacheDirectory(value.directory);
    const maxBytes = Number.isFinite(value.maxBytes) && value.maxBytes >= 1024 * 1024
      ? Math.floor(value.maxBytes)
      : DEFAULT_MAX_CACHE_BYTES;
    return { directory, maxBytes };
  }

  private async pruneCache(configuration: PlaybackCacheConfiguration): Promise<void> {
    const protectedDirectories = new Set(
      [...this.jobs.values()]
        .filter((job) => (
          isInsideDirectory(configuration.directory, job.directory)
          && (job.process !== null || job.consumers.size > 0)
        ))
        .map((job) => path.resolve(job.directory).toLowerCase()),
    );
    if (this.subtitleConversions.size > 0) {
      protectedDirectories.add(path.resolve(configuration.directory, 'subtitles').toLowerCase());
    }
    await prunePlaybackCache(
      configuration.directory,
      protectedDirectories,
      configuration.maxBytes,
      this.logger,
    );
  }
}

const SIDECAR_SUBTITLE_EXTENSIONS = new Set(['.srt', '.vtt', '.ass', '.ssa']);
const SIDECAR_SUBTITLE_INDEX_BASE = 1_000_000;

export interface SidecarSubtitleFile {
  filePath: string;
  codec: string;
  language: string | null;
  title: string;
}

export async function discoverSidecarSubtitleFiles(videoFilePath: string): Promise<SidecarSubtitleFile[]> {
  try {
    const video = path.parse(videoFilePath);
    const entries = await fs.promises.readdir(video.dir, { withFileTypes: true });
    const candidates = entries
      .filter((entry) => entry.isFile() && SIDECAR_SUBTITLE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
      .map((entry) => {
        const parsed = path.parse(entry.name);
        return {
          filePath: path.join(video.dir, entry.name),
          stem: parsed.name,
          codec: sidecarSubtitleCodec(parsed.ext),
          language: inferSidecarSubtitleLanguage(parsed.name),
          title: entry.name,
        };
      })
      .sort((left, right) => left.title.localeCompare(right.title, undefined, { numeric: true }));
    const videoStems = new Set([
      video.name.toLowerCase(),
      stripMultipartSuffix(video.name).toLowerCase(),
    ]);
    const related = candidates.filter((candidate) => (
      [...videoStems].some((stem) => (
        candidate.stem.toLowerCase() === stem
        || candidate.stem.toLowerCase().startsWith(`${stem}.`)
        || candidate.stem.toLowerCase().startsWith(`${stem}-`)
        || candidate.stem.toLowerCase().startsWith(`${stem}_`)
        || candidate.stem.toLowerCase().startsWith(`${stem} `)
      ))
    ));
    const selected = related.length > 0 ? related : candidates.length === 1 ? candidates : [];
    return selected.map(({ stem: _stem, ...subtitle }) => subtitle);
  } catch {
    return [];
  }
}

async function resolvePlaybackSubtitleTracks(
  videoFilePath: string,
  embeddedTracks: MediaStreamProbe[],
  ffmpegAvailable: boolean,
): Promise<PlaybackSubtitleTrack[]> {
  const embedded = embeddedTracks.map((track) => ({
    ...track,
    source: 'embedded' as const,
    sourceFilePath: null,
    supported: ffmpegAvailable && Boolean(track.codec && TEXT_SUBTITLE_CODECS.has(track.codec)),
  }));
  const sidecars = await discoverSidecarSubtitleFiles(videoFilePath);
  return [
    ...embedded,
    ...sidecars.map((subtitle, index) => ({
      index: SIDECAR_SUBTITLE_INDEX_BASE + index,
      codec: subtitle.codec,
      language: subtitle.language,
      title: subtitle.title,
      source: 'sidecar' as const,
      sourceFilePath: subtitle.filePath,
      supported: subtitle.codec === 'webvtt' || ffmpegAvailable,
    })),
  ];
}

function stripMultipartSuffix(stem: string): string {
  return stem.replace(/(?:[.\s_-]*(?:cd|part|pt|disc|disk)[.\s_-]*\d+)$/i, '');
}

function sidecarSubtitleCodec(extension: string): string {
  if (extension.toLowerCase() === '.srt') return 'subrip';
  if (extension.toLowerCase() === '.vtt') return 'webvtt';
  return extension.toLowerCase().slice(1);
}

function inferSidecarSubtitleLanguage(stem: string): string | null {
  const token = stem.toLowerCase().match(/(?:^|[.\s_-])(zh-cn|zh-hans|chs|sc|zh-tw|zh-hant|cht|tc|zh|zho|chi|en|eng|ja|jpn|ko|kor)(?:$|[.\s_-])/)?.[1];
  if (!token) return null;
  if (token === 'chs' || token === 'sc' || token === 'zh-cn' || token === 'zh-hans') return 'zh-Hans';
  if (token === 'cht' || token === 'tc' || token === 'zh-tw' || token === 'zh-hant') return 'zh-Hant';
  if (token === 'zh' || token === 'zho' || token === 'chi') return 'zh';
  if (token === 'en' || token === 'eng') return 'en';
  if (token === 'ja' || token === 'jpn') return 'ja';
  return 'ko';
}

function playbackPipelineCandidates(
  preferred: PlaybackJob['videoPipeline'],
): PlaybackJob['videoPipeline'][] {
  if (preferred === 'cuda-nvenc') return ['cuda-nvenc', 'nvenc', 'software'];
  if (preferred === 'nvenc') return ['nvenc', 'software'];
  return [preferred];
}

function playbackVideoEncoder(
  plan: BrowserPlaybackPlan,
  job: PlaybackJob | null,
): WebPlaybackSessionDto['videoEncoder'] {
  if (plan.videoMode === 'copy') return 'copy';
  if (job?.videoPipeline === 'cached') return 'cached';
  if (job?.videoPipeline === 'cuda-nvenc' || job?.videoPipeline === 'nvenc') return 'h264_nvenc';
  return 'libx264';
}

function playbackVideoDecoder(
  plan: BrowserPlaybackPlan,
  job: PlaybackJob | null,
): WebPlaybackSessionDto['videoDecoder'] {
  if (plan.videoMode === 'copy') return 'copy';
  if (job?.videoPipeline === 'cached') return 'cached';
  return job?.videoPipeline === 'cuda-nvenc' ? 'cuda' : 'software';
}

export function buildHlsTranscodeArgs(
  sourceFilePath: string,
  outputDirectory: string,
  plan: BrowserPlaybackPlan,
  videoPipeline: 'copy' | 'cached' | VideoTranscodePipeline = 'software',
): string[] {
  const cudaPipeline = plan.videoMode === 'transcode' && videoPipeline === 'cuda-nvenc';
  const videoArgs = plan.videoMode === 'copy'
    ? ['-c:v', 'copy']
    : videoPipeline === 'cuda-nvenc'
      ? [
          '-c:v', 'h264_nvenc',
          '-preset', 'p4',
          '-tune', 'hq',
          '-rc', 'vbr',
          '-cq', '23',
          '-b:v', '0',
          '-vf', "scale_cuda=w='min(1920,iw)':h=-2:format=yuv420p",
          '-force_key_frames', `expr:gte(t,n_forced*${HLS_SEGMENT_SECONDS})`,
        ]
      : videoPipeline === 'nvenc'
        ? [
          '-c:v', 'h264_nvenc',
          '-preset', 'p4',
          '-tune', 'hq',
          '-rc', 'vbr',
          '-cq', '23',
          '-b:v', '0',
          '-pix_fmt', 'yuv420p',
          '-vf', "scale=w='min(1920,iw)':h=-2",
          '-force_key_frames', `expr:gte(t,n_forced*${HLS_SEGMENT_SECONDS})`,
        ]
        : [
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-crf', '23',
        '-pix_fmt', 'yuv420p',
        '-vf', "scale=w='min(1920,iw)':h=-2",
        '-force_key_frames', `expr:gte(t,n_forced*${HLS_SEGMENT_SECONDS})`,
      ];
  const audioArgs = plan.audioMode === 'none'
    ? ['-an']
    : plan.audioMode === 'copy'
      ? ['-c:a', 'copy']
      : ['-c:a', 'aac', '-b:a', '160k', '-ac', '2'];
  return [
    '-hide_banner',
    '-loglevel', 'warning',
    '-y',
    '-fflags', '+genpts',
    ...(cudaPipeline ? ['-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda'] : []),
    '-i', sourceFilePath,
    '-map', '0:v:0',
    ...(plan.audioMode === 'none' ? [] : ['-map', '0:a:0?']),
    '-sn',
    '-dn',
    '-map_metadata', '-1',
    '-avoid_negative_ts', 'make_zero',
    '-max_muxing_queue_size', '2048',
    ...videoArgs,
    ...audioArgs,
    '-progress', 'pipe:1',
    '-nostats',
    '-f', 'hls',
    '-hls_time', String(HLS_SEGMENT_SECONDS),
    '-hls_list_size', '0',
    '-hls_playlist_type', 'event',
    '-hls_flags', 'independent_segments+temp_file',
    '-hls_segment_filename', path.join(outputDirectory, 'segment-%06d.ts'),
    path.join(outputDirectory, 'index.m3u8'),
  ];
}

export function playbackCacheKey(
  filePath: string,
  fileSize: number,
  modifiedAtMs: number,
  plan: BrowserPlaybackPlan,
): string {
  return createHash('sha256')
    .update(path.resolve(filePath).toLowerCase())
    .update('\0')
    .update(String(fileSize))
    .update('\0')
    .update(String(Math.trunc(modifiedAtMs)))
    .update('\0')
    .update(`${plan.videoMode}:${plan.audioMode}:hls-v1`)
    .digest('hex');
}

function playbackJobMapKey(directory: string, cacheKey: string): string {
  return `${path.resolve(directory).toLowerCase()}\0${cacheKey}`;
}

export function subtitleCacheKey(
  filePath: string,
  fileSize: number,
  modifiedAtMs: number,
  streamIndex: number,
): string {
  return createHash('sha256')
    .update(path.resolve(filePath).toLowerCase())
    .update('\0')
    .update(String(fileSize))
    .update('\0')
    .update(String(Math.trunc(modifiedAtMs)))
    .update('\0')
    .update(`subtitle:${streamIndex}:webvtt-v2-fixed-cue`)
    .digest('hex');
}

export function sidecarSubtitleCacheKey(
  filePath: string,
  fileSize: number,
  modifiedAtMs: number,
): string {
  return createHash('sha256')
    .update(path.resolve(filePath).toLowerCase())
    .update('\0')
    .update(String(fileSize))
    .update('\0')
    .update(String(Math.trunc(modifiedAtMs)))
    .update('\0sidecar:webvtt-v2-fixed-cue')
    .digest('hex');
}

async function convertEmbeddedSubtitle(
  ffmpegPath: string,
  sourceFilePath: string,
  streamIndex: number,
  directory: string,
  outputPath: string,
): Promise<string> {
  await fs.promises.mkdir(directory, { recursive: true });
  const partialPath = `${outputPath}.${randomUUID()}.partial.vtt`;
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(ffmpegPath, [
        '-hide_banner',
        '-loglevel', 'error',
        '-y',
        '-i', sourceFilePath,
        '-map', `0:${streamIndex}`,
        '-c:s', 'webvtt',
        '-f', 'webvtt',
        partialPath,
      ], {
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error('SUBTITLE_CONVERSION_TIMEOUT'));
      }, 2 * 60 * 1000);
      child.stderr?.on('data', (chunk: Buffer) => {
        if (stderr.length < 2000) stderr += chunk.toString('utf8').slice(0, 2000 - stderr.length);
      });
      child.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once('close', (code) => {
        clearTimeout(timeout);
        if (code === 0) resolve();
        else reject(new Error(stderr.trim() || `SUBTITLE_CONVERSION_EXIT_${code ?? 'UNKNOWN'}`));
      });
    });
    await stabilizeWebVttCueLayout(partialPath);
    const stat = await fs.promises.stat(partialPath);
    if (!stat.isFile()) throw new Error('SUBTITLE_CONVERSION_FAILED');
    if (await fileExists(outputPath)) await fs.promises.rm(partialPath, { force: true });
    else await fs.promises.rename(partialPath, outputPath);
    return outputPath;
  } catch (error) {
    await fs.promises.rm(partialPath, { force: true }).catch(() => undefined);
    if (error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message)) throw error;
    throw new Error('SUBTITLE_CONVERSION_FAILED', { cause: error });
  }
}

async function convertSidecarSubtitle(
  ffmpegPath: string | null,
  sourceFilePath: string,
  directory: string,
  outputPath: string,
): Promise<string> {
  await fs.promises.mkdir(directory, { recursive: true });
  const partialPath = `${outputPath}.${randomUUID()}.partial.vtt`;
  try {
    if (path.extname(sourceFilePath).toLowerCase() === '.vtt') {
      await fs.promises.copyFile(sourceFilePath, partialPath);
    } else {
      const executable = requiredFfmpegPath(ffmpegPath);
      try {
        await runSidecarSubtitleConversion(executable, sourceFilePath, partialPath);
      } catch {
        await runSidecarSubtitleConversion(executable, sourceFilePath, partialPath, 'GB18030');
      }
    }
    await stabilizeWebVttCueLayout(partialPath);
    const stat = await fs.promises.stat(partialPath);
    if (!stat.isFile()) throw new Error('SUBTITLE_CONVERSION_FAILED');
    if (await fileExists(outputPath)) await fs.promises.rm(partialPath, { force: true });
    else await fs.promises.rename(partialPath, outputPath);
    return outputPath;
  } catch (error) {
    await fs.promises.rm(partialPath, { force: true }).catch(() => undefined);
    if (error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message)) throw error;
    throw new Error('SUBTITLE_CONVERSION_FAILED', { cause: error });
  }
}

async function stabilizeWebVttCueLayout(filePath: string): Promise<void> {
  const source = await fs.promises.readFile(filePath, 'utf8');
  const lines = source.split(/\r?\n/).map((line) => {
    if (!line.includes('-->')) return line;
    const withoutConflictingSettings = line.replace(/\s+(?:line|position|size|align):\S+/g, '');
    return `${withoutConflictingSettings.trimEnd()} line:82% position:50% align:center size:88%`;
  });
  await fs.promises.writeFile(filePath, lines.join('\n'), 'utf8');
}

function runSidecarSubtitleConversion(
  ffmpegPath: string,
  sourceFilePath: string,
  outputPath: string,
  characterEncoding?: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, [
      '-hide_banner',
      '-loglevel', 'error',
      '-y',
      ...(characterEncoding ? ['-sub_charenc', characterEncoding] : []),
      '-i', sourceFilePath,
      '-c:s', 'webvtt',
      '-f', 'webvtt',
      outputPath,
    ], {
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('SUBTITLE_CONVERSION_TIMEOUT'));
    }, 2 * 60 * 1000);
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 2000) stderr += chunk.toString('utf8').slice(0, 2000 - stderr.length);
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `SUBTITLE_CONVERSION_EXIT_${code ?? 'UNKNOWN'}`));
    });
  });
}

function requiredFfmpegPath(ffmpegPath: string | null): string {
  if (!ffmpegPath) throw new Error('PLAYBACK_TOOLS_UNAVAILABLE');
  return ffmpegPath;
}

async function waitUntilPlayable(job: PlaybackJob): Promise<void> {
  const deadline = Date.now() + PLAYLIST_WAIT_MS;
  while (Date.now() < deadline) {
    if (job.state === 'error') throw new Error(job.errorCode ?? 'PLAYBACK_PREPARATION_FAILED');
    if (await playlistHasPlayableSegment(job.playlistPath)) return;
    await delay(100);
  }
  if (job.process) {
    job.state = 'cancelled';
    job.process.kill();
  }
  throw new Error('PLAYBACK_PREPARATION_TIMEOUT');
}

async function waitForFile(filePath: string, job: PlaybackJob, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fileExists(filePath)) return;
    if (job.state === 'error' || job.state === 'cancelled') break;
    await delay(75);
  }
}

export async function playlistHasPlayableSegment(playlistPath: string): Promise<boolean> {
  try {
    const playlist = await fs.promises.readFile(playlistPath, 'utf8');
    const segmentName = playlist.match(/segment-\d{6}\.ts/)?.[0];
    if (!segmentName) return false;
    const segmentPath = path.join(path.dirname(playlistPath), segmentName);
    assertInsideDirectory(path.dirname(playlistPath), segmentPath);
    const stat = await fs.promises.stat(segmentPath);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

async function isCompletePlaylist(playlistPath: string): Promise<boolean> {
  try {
    const playlist = await fs.promises.readFile(playlistPath, 'utf8');
    return playlist.includes('#EXT-X-ENDLIST') && await playlistHasPlayableSegment(playlistPath);
  } catch {
    return false;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

function assertInsideDirectory(root: string, candidate: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    if (path.resolve(root) === path.resolve(candidate)) return;
    throw new Error('PLAYBACK_MEDIA_NOT_FOUND');
  }
}

export function assertSafePlaybackCacheDirectory(directory: string): string {
  if (!path.isAbsolute(directory)) throw new Error('INVALID_PLAYBACK_CACHE_DIRECTORY');
  const resolved = path.resolve(directory);
  if (resolved === path.parse(resolved).root) throw new Error('INVALID_PLAYBACK_CACHE_DIRECTORY');
  return resolved;
}

function isInsideDirectory(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function prunePlaybackCache(
  cacheDirectory: string,
  protectedDirectories: ReadonlySet<string>,
  maxCacheBytes: number,
  logger: AppLogger,
): Promise<void> {
  try {
    const names = await fs.promises.readdir(cacheDirectory);
    const entries = (await Promise.all(names.map(async (name) => {
      const directory = path.join(cacheDirectory, name);
      const stat = await fs.promises.stat(directory);
      if (!stat.isDirectory()) return null;
      const size = await directorySize(directory);
      return { directory, size, modifiedAt: stat.mtimeMs };
    }))).filter((entry): entry is NonNullable<typeof entry> => entry !== null)
      .sort((left, right) => left.modifiedAt - right.modifiedAt);
    let total = entries.reduce((sum, entry) => sum + entry.size, 0);
    const cutoff = Date.now() - MAX_CACHE_AGE_MS;
    for (const entry of entries) {
      if (protectedDirectories.has(path.resolve(entry.directory).toLowerCase())) continue;
      if (entry.modifiedAt >= cutoff && total <= maxCacheBytes) continue;
      assertInsideDirectory(cacheDirectory, entry.directory);
      await fs.promises.rm(entry.directory, { recursive: true, force: true });
      total -= entry.size;
    }
  } catch (error) {
    logger.warn('Web playback cache cleanup failed', {
      cachePath: cacheDirectory,
      error: error instanceof Error ? error.message : 'CACHE_CLEANUP_FAILED',
    });
  }
}

async function directorySize(directory: string): Promise<number> {
  let size = 0;
  const entries = await fs.promises.readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
    if (filesystemErrorCode(error) === 'ENOENT') return [];
    throw error;
  });
  for (const entry of entries) {
    const filePath = path.join(directory, entry.name);
    try {
      if (entry.isDirectory()) size += await directorySize(filePath);
      else if (entry.isFile()) size += (await fs.promises.stat(filePath)).size;
    } catch (error) {
      if (filesystemErrorCode(error) !== 'ENOENT') throw error;
    }
  }
  return size;
}

function filesystemErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function errorCode(error: unknown): string {
  if (error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message)) return error.message;
  return 'PLAYBACK_PREPARATION_FAILED';
}
