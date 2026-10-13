import type { DesktopPlaybackProgressInput, DesktopPlaybackStateDto, FilmPartDto } from '../../shared/contracts';

// Loading metadata alone must never create a viewing record.
export function resumablePlayback(state: DesktopPlaybackStateDto | null | undefined, parts: FilmPartDto[]): { partId: string; seconds: number } | null {
  if (!state?.lastPartId || !parts.some((part) => part.id === state.lastPartId && !part.missing)) return null;
  const seconds = state.positionSeconds;
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  if (state.durationSeconds !== null && seconds >= state.durationSeconds - 1) return { partId: state.lastPartId, seconds: 0 };
  return { partId: state.lastPartId, seconds };
}

export class DesktopPlaybackTracker {
  private pending: DesktopPlaybackProgressInput | null = null;
  private running: Promise<void> | null = null;
  private lastSavedAt = -Infinity;

  public constructor(private readonly save: (input: DesktopPlaybackProgressInput) => Promise<void>) {}

  public record(input: DesktopPlaybackProgressInput, force = false): Promise<void> {
    this.pending = { ...input };
    if (force || Date.now() - this.lastSavedAt >= 5000) return this.flush();
    return Promise.resolve();
  }

  public async flush(): Promise<void> {
    while (this.running || this.pending) {
      if (this.running) { await this.running; continue; }
      const snapshot = this.pending!;
      this.pending = null;
      this.lastSavedAt = Date.now();
      const operation = this.save(snapshot).catch((error: unknown) => {
        this.pending ??= snapshot;
        throw error;
      });
      this.running = operation;
      try { await operation; }
      finally { if (this.running === operation) this.running = null; }
    }
  }
}
