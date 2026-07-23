import type Database from 'better-sqlite3';
import { DEFAULT_SETTINGS } from '../../../shared/enums';
import type { SettingsDto, SettingsUpdateInput } from '../../../shared/contracts';

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
      slideshowIntervalMs: number;
      pageSize: number;
      videoExtensions: string[];
      imageExtensions: string[];
      ignoredDirectories: string[];
      autoScanOnStartup: boolean;
      ffprobePath: string;
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
      slideshowIntervalMs: clamp(settings.slideshowIntervalMs, 500, 10_000, DEFAULT_SETTINGS.slideshowIntervalMs),
      pageSize: clamp(settings.pageSize, 12, 200, DEFAULT_SETTINGS.pageSize),
      videoExtensions: normalizeList(settings.videoExtensions, DEFAULT_SETTINGS.videoExtensions),
      imageExtensions: normalizeList(settings.imageExtensions, DEFAULT_SETTINGS.imageExtensions),
      ignoredDirectories: normalizeList(settings.ignoredDirectories, DEFAULT_SETTINGS.ignoredDirectories),
      autoScanOnStartup: Boolean(settings.autoScanOnStartup),
      ffprobePath: typeof settings.ffprobePath === 'string' ? settings.ffprobePath.slice(0, 1000) : '',
    };
  }

  public update(input: SettingsUpdateInput): SettingsDto {
    const current = this.get();
    if (input.cardSize !== undefined && (!Number.isFinite(input.cardSize) || input.cardSize < 140 || input.cardSize > 320)) throw new Error('INVALID_CARD_SIZE');
    const next: SettingsDto = {
      cardSize: input.cardSize ?? current.cardSize,
      hoverDelayMs: input.hoverDelayMs ?? current.hoverDelayMs,
      slideshowIntervalMs: input.slideshowIntervalMs ?? current.slideshowIntervalMs,
      pageSize: input.pageSize ?? current.pageSize,
      videoExtensions: input.videoExtensions ?? current.videoExtensions,
      imageExtensions: input.imageExtensions ?? current.imageExtensions,
      ignoredDirectories: input.ignoredDirectories ?? current.ignoredDirectories,
      autoScanOnStartup: input.autoScanOnStartup ?? current.autoScanOnStartup,
      ffprobePath: input.ffprobePath ?? current.ffprobePath,
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
