import type Database from 'better-sqlite3';
import { DEFAULT_SETTINGS } from '../../../shared/enums';
import type { SettingsDto, SettingsUpdateInput } from '../../../shared/contracts';

export class SettingsRepository {
  public constructor(private readonly db: Database.Database) {
    this.ensureDefaults();
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
      cardSize: clamp(settings.cardSize, 160, 360, DEFAULT_SETTINGS.cardSize),
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
    for (const [key, value] of Object.entries(next)) statement.run(key, JSON.stringify(value));
    return this.get();
  }

  private ensureDefaults(): void {
    const statement = this.db.prepare('INSERT OR IGNORE INTO app_setting (key, value_json) VALUES (?, ?)');
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) statement.run(key, JSON.stringify(value));
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
