import type Database from 'better-sqlite3';
import path from 'node:path';
import { DEFAULT_SETTINGS } from '../../../shared/enums';
import type { SettingsDto, SettingsUpdateInput } from '../../../shared/contracts';
import { isAllowedLanBindAddress } from '../../server/NetworkScope';

const LEGACY_DEFAULT_VIDEO_EXTENSIONS = ['mp4', 'mkv', 'mov', 'avi', 'webm', 'm4v', 'ts', 'flv', 'wmv'];

export class SettingsRepository {
  public constructor(private readonly db: Database.Database) {
    this.ensureDefaults();
    this.upgradeLegacyDefaultVideoExtensions();
  }

  public get(): SettingsDto {
    const settings = { ...DEFAULT_SETTINGS } as {
      cardSize: number;
      hoverDelayMs: number;
      hoverCloseDelayMs: number;
      slideshowIntervalMs: number;
      detailPlayerSeekStepSeconds: number;
      detailPlayerFineSeekStepSeconds: number;
      pageSize: number;
      videoExtensions: string[];
      imageExtensions: string[];
      ignoredDirectories: string[];
      autoScanOnStartup: boolean;
      autoLaunchOnStartup: boolean;
      launchToTray: boolean;
      minimizeToTray: boolean;
      ffprobePath: string;
      playbackCacheDirectory: string;
      playbackCacheLimitGb: number;
      lanServerEnabled: boolean;
      lanServerPort: number;
      lanServerBindMode: 'localhost' | 'lan';
      lanServerHost: string;
      lanRequireAuthentication: boolean;
    };
    const rows = this.db.prepare('SELECT key, value_json FROM app_setting').all() as Array<{ key: string; value_json: string }>;
    for (const row of rows) {
      if (!(row.key in settings)) continue;
      try {
        (settings as Record<string, unknown>)[row.key] = JSON.parse(row.value_json);
      } catch {
        // Keep the default if a setting was manually corrupted.
      }
    }
    return {
      cardSize: clamp(settings.cardSize, 140, 320, DEFAULT_SETTINGS.cardSize),
      hoverDelayMs: clamp(settings.hoverDelayMs, 100, 3000, DEFAULT_SETTINGS.hoverDelayMs),
      hoverCloseDelayMs: clampInteger(settings.hoverCloseDelayMs, 0, 5000, DEFAULT_SETTINGS.hoverCloseDelayMs),
      slideshowIntervalMs: clamp(settings.slideshowIntervalMs, 500, 10_000, DEFAULT_SETTINGS.slideshowIntervalMs),
      detailPlayerSeekStepSeconds: clampInteger(
        settings.detailPlayerSeekStepSeconds,
        1,
        60,
        DEFAULT_SETTINGS.detailPlayerSeekStepSeconds,
      ),
      detailPlayerFineSeekStepSeconds: clamp(
        settings.detailPlayerFineSeekStepSeconds,
        0.01,
        5,
        DEFAULT_SETTINGS.detailPlayerFineSeekStepSeconds,
      ),
      pageSize: clamp(settings.pageSize, 12, 200, DEFAULT_SETTINGS.pageSize),
      videoExtensions: normalizeList(settings.videoExtensions, DEFAULT_SETTINGS.videoExtensions),
      imageExtensions: normalizeList(settings.imageExtensions, DEFAULT_SETTINGS.imageExtensions),
      ignoredDirectories: normalizeList(settings.ignoredDirectories, DEFAULT_SETTINGS.ignoredDirectories),
      autoScanOnStartup: Boolean(settings.autoScanOnStartup),
      autoLaunchOnStartup: Boolean(settings.autoLaunchOnStartup),
      launchToTray: Boolean(settings.launchToTray),
      minimizeToTray: Boolean(settings.minimizeToTray),
      ffprobePath: typeof settings.ffprobePath === 'string' ? settings.ffprobePath.slice(0, 1000) : '',
      playbackCacheDirectory: normalizeCacheDirectory(settings.playbackCacheDirectory),
      playbackCacheLimitGb: clampInteger(
        settings.playbackCacheLimitGb,
        1,
        500,
        DEFAULT_SETTINGS.playbackCacheLimitGb,
      ),
      lanServerEnabled: Boolean(settings.lanServerEnabled),
      lanServerPort: clampInteger(settings.lanServerPort, 1024, 65_535, DEFAULT_SETTINGS.lanServerPort),
      lanServerBindMode: settings.lanServerBindMode === 'lan' ? 'lan' : 'localhost',
      lanServerHost: typeof settings.lanServerHost === 'string' && isAllowedLanBindAddress(settings.lanServerHost.trim())
        ? settings.lanServerHost.trim()
        : '',
      lanRequireAuthentication: settings.lanServerBindMode === 'lan' ? true : Boolean(settings.lanRequireAuthentication),
    };
  }

  public update(input: SettingsUpdateInput): SettingsDto {
    const current = this.get();
    if (input.cardSize !== undefined && (!Number.isFinite(input.cardSize) || input.cardSize < 140 || input.cardSize > 320)) throw new Error('INVALID_CARD_SIZE');
    if (
      input.hoverCloseDelayMs !== undefined
      && (!Number.isInteger(input.hoverCloseDelayMs) || input.hoverCloseDelayMs < 0 || input.hoverCloseDelayMs > 5000)
    ) {
      throw new Error('INVALID_HOVER_CLOSE_DELAY');
    }
    if (
      input.detailPlayerSeekStepSeconds !== undefined
      && (!Number.isInteger(input.detailPlayerSeekStepSeconds) || input.detailPlayerSeekStepSeconds < 1 || input.detailPlayerSeekStepSeconds > 60)
    ) {
      throw new Error('INVALID_DETAIL_PLAYER_SEEK_STEP');
    }
    if (
      input.detailPlayerFineSeekStepSeconds !== undefined
      && (!Number.isFinite(input.detailPlayerFineSeekStepSeconds) || input.detailPlayerFineSeekStepSeconds < 0.01 || input.detailPlayerFineSeekStepSeconds > 5)
    ) {
      throw new Error('INVALID_DETAIL_PLAYER_FINE_SEEK_STEP');
    }
    if (
      input.playbackCacheLimitGb !== undefined
      && (!Number.isInteger(input.playbackCacheLimitGb) || input.playbackCacheLimitGb < 1 || input.playbackCacheLimitGb > 500)
    ) {
      throw new Error('INVALID_PLAYBACK_CACHE_LIMIT');
    }
    if (
      input.playbackCacheDirectory !== undefined
      && (typeof input.playbackCacheDirectory !== 'string' || !isValidCacheDirectory(input.playbackCacheDirectory))
    ) {
      throw new Error('INVALID_PLAYBACK_CACHE_DIRECTORY');
    }
    if (input.lanServerPort !== undefined && (!Number.isInteger(input.lanServerPort) || input.lanServerPort < 1024 || input.lanServerPort > 65_535)) {
      throw new Error('INVALID_LAN_SERVER_PORT');
    }
    if (input.lanServerBindMode !== undefined && input.lanServerBindMode !== 'localhost' && input.lanServerBindMode !== 'lan') {
      throw new Error('INVALID_LAN_BIND_MODE');
    }
    if (input.lanServerHost !== undefined && (typeof input.lanServerHost !== 'string' || !isAllowedLanBindAddress(input.lanServerHost.trim()))) {
      throw new Error('INVALID_LAN_SERVER_HOST');
    }
    const bindMode = input.lanServerBindMode ?? current.lanServerBindMode;
    const requireAuthentication = bindMode === 'lan' ? true : (input.lanRequireAuthentication ?? current.lanRequireAuthentication);
    const next: SettingsDto = {
      cardSize: input.cardSize ?? current.cardSize,
      hoverDelayMs: input.hoverDelayMs ?? current.hoverDelayMs,
      hoverCloseDelayMs: input.hoverCloseDelayMs ?? current.hoverCloseDelayMs,
      slideshowIntervalMs: input.slideshowIntervalMs ?? current.slideshowIntervalMs,
      detailPlayerSeekStepSeconds: input.detailPlayerSeekStepSeconds ?? current.detailPlayerSeekStepSeconds,
      detailPlayerFineSeekStepSeconds: input.detailPlayerFineSeekStepSeconds ?? current.detailPlayerFineSeekStepSeconds,
      pageSize: input.pageSize ?? current.pageSize,
      videoExtensions: input.videoExtensions ?? current.videoExtensions,
      imageExtensions: input.imageExtensions ?? current.imageExtensions,
      ignoredDirectories: input.ignoredDirectories ?? current.ignoredDirectories,
      autoScanOnStartup: input.autoScanOnStartup ?? current.autoScanOnStartup,
      autoLaunchOnStartup: input.autoLaunchOnStartup ?? current.autoLaunchOnStartup,
      launchToTray: input.launchToTray ?? current.launchToTray,
      minimizeToTray: input.minimizeToTray ?? current.minimizeToTray,
      ffprobePath: input.ffprobePath ?? current.ffprobePath,
      playbackCacheDirectory: input.playbackCacheDirectory?.trim() ?? current.playbackCacheDirectory,
      playbackCacheLimitGb: input.playbackCacheLimitGb ?? current.playbackCacheLimitGb,
      lanServerEnabled: input.lanServerEnabled ?? current.lanServerEnabled,
      lanServerPort: input.lanServerPort ?? current.lanServerPort,
      lanServerBindMode: bindMode,
      lanServerHost: input.lanServerHost?.trim() ?? current.lanServerHost,
      lanRequireAuthentication: requireAuthentication,
    };
    const statement = this.db.prepare(
      `INSERT INTO app_setting (key, value_json) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`,
    );
    this.db.transaction(() => {
      for (const [key, value] of Object.entries(next)) statement.run(key, JSON.stringify(value));
    })();
    return this.get();
  }

  private ensureDefaults(): void {
    const statement = this.db.prepare('INSERT OR IGNORE INTO app_setting (key, value_json) VALUES (?, ?)');
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) statement.run(key, JSON.stringify(value));
  }

  private upgradeLegacyDefaultVideoExtensions(): void {
    const row = this.db.prepare("SELECT value_json FROM app_setting WHERE key = 'videoExtensions'").get() as { value_json: string } | undefined;
    if (!row) return;
    try {
      const value = JSON.parse(row.value_json) as unknown;
      if (!Array.isArray(value) || !sameExtensionSet(value, LEGACY_DEFAULT_VIDEO_EXTENSIONS)) return;
      this.db.prepare("UPDATE app_setting SET value_json = ? WHERE key = 'videoExtensions'")
        .run(JSON.stringify(DEFAULT_SETTINGS.videoExtensions));
    } catch {
      // get() will fall back to the current defaults for corrupted settings.
    }
  }
}

function clamp(value: number, min: number, max: number, fallback: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function clampInteger(value: number, min: number, max: number, fallback: number): number {
  return Number.isInteger(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function normalizeList(value: unknown, fallback: readonly string[]): string[] {
  if (!Array.isArray(value)) return [...fallback];
  const list = value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim().replace(/^\./, '').slice(0, 100))
    .filter(Boolean);
  return list.length ? [...new Set(list)] : [...fallback];
}

function sameExtensionSet(value: unknown[], expected: readonly string[]): boolean {
  const normalized = value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim().replace(/^\./, '').toLowerCase())
    .filter(Boolean);
  return normalized.length === expected.length
    && new Set(normalized).size === expected.length
    && expected.every((extension) => normalized.includes(extension));
}

function normalizeCacheDirectory(value: unknown): string {
  if (typeof value !== 'string') return '';
  const directory = value.trim().slice(0, 1000);
  return isValidCacheDirectory(directory) ? directory : '';
}

function isValidCacheDirectory(directory: string): boolean {
  if (!directory) return true;
  if (!path.isAbsolute(directory)) return false;
  const resolved = path.resolve(directory);
  return resolved !== path.parse(resolved).root
    && path.basename(resolved).toLowerCase() === 'local film library playback cache';
}
