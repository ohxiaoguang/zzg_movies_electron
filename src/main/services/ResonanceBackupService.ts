import { emptyResonanceState, type ResonanceState, type ResonanceVideo } from '../../shared/resonance';
import { parseResonanceBackup, type ResonanceBackupState, type ResonanceBackupVideo } from '../../shared/resonanceBackup';
import type { DatabaseManager } from '../database/DatabaseManager';
import { ResonanceRepository } from '../database/repositories/ResonanceRepository';

export class ResonanceBackupService {
  public constructor(private readonly database: DatabaseManager) {}

  public export(filmIds: string[]): ResonanceBackupState {
    const state = new ResonanceRepository(this.database).read() ?? emptyResonanceState();
    const indexes = new Map(filmIds.map((id, index) => [id, index]));
    const parts = new Map((this.database.db.prepare('SELECT id, film_id, filename, file_size FROM film_file').all() as
      Array<{ id: string; film_id: string; filename: string; file_size: number }>).map((part) => [part.id, part]));
    function video(item: ResonanceVideo): ResonanceBackupVideo {
      const part = parts.get(item.partId);
      const validPart = part?.film_id === item.filmId ? part : undefined;
      return {
        filmIndex: indexes.get(item.filmId) ?? null, fileSize: validPart?.file_size ?? null,
        filename: validPart?.filename ?? item.filename, currentSeconds: item.currentSeconds,
        durationSeconds: item.durationSeconds, aspectRatio: item.aspectRatio, isVr: item.isVr,
        vrView: item.vrView, addedAt: item.addedAt,
      };
    }
    return parseResonanceBackup({
      version: 1, activeSceneId: state.activeSceneId, draft: state.draft.map(video),
      scenes: state.scenes.map((scene) => ({ ...scene, videos: scene.videos.map(video) })),
    }, filmIds.length);
  }

  public resolve(backup: ResonanceBackupState, films: Map<number, { id: string }>): { state: ResonanceState; restored: number; skipped: number } {
    let restored = 0;
    let skipped = 0;
    const query = this.database.db.prepare(`SELECT file.id, file.filename, file.file_size, film.title
      FROM film_file file JOIN film ON film.id = file.film_id WHERE file.film_id = ?`);
    const cache = new Map<string, Array<{ id: string; filename: string; file_size: number; title: string }>>();
    function videos(input: ResonanceBackupVideo[]): ResonanceVideo[] {
      const seen = new Set<string>();
      return input.flatMap((video) => {
        const film = video.filmIndex === null ? undefined : films.get(video.filmIndex);
        if (!film) { skipped += 1; return []; }
        if (!cache.has(film.id)) cache.set(film.id, query.all(film.id) as Array<{ id: string; filename: string; file_size: number; title: string }>);
        const candidates = cache.get(film.id)!.filter((part) =>
          part.filename.normalize('NFKC').toLocaleLowerCase() === video.filename.normalize('NFKC').toLocaleLowerCase()
          && (video.fileSize === null || video.fileSize === 0 || part.file_size === video.fileSize));
        if (candidates.length !== 1 || seen.has(candidates[0].id)) { skipped += 1; return []; }
        const part = candidates[0];
        seen.add(part.id);
        restored += 1;
        return [{
          id: `${film.id}:${part.id}`, filmId: film.id, partId: part.id, title: part.title, filename: part.filename,
          currentSeconds: video.currentSeconds, durationSeconds: video.durationSeconds, aspectRatio: video.aspectRatio,
          isVr: video.isVr, vrView: video.vrView, vrModeKnown: true, addedAt: video.addedAt,
        }];
      });
    }
    const state: ResonanceState = {
      version: 1, activeSceneId: backup.activeSceneId,
      draft: videos(backup.draft), scenes: backup.scenes.map((scene) => ({ ...scene, videos: videos(scene.videos) })),
    };
    return { state, restored, skipped };
  }
}
