import type { DesktopPlaybackStateDto } from '../../shared/contracts';
import { validateDesktopPlaybackProgress } from '../../shared/playbackValidation';
import type { FilmRepository } from '../database/repositories/FilmRepository';

export class DesktopPlaybackService {
  public constructor(private readonly films: FilmRepository) {}

  public saveProgress(payload: unknown): DesktopPlaybackStateDto {
    const input = validateDesktopPlaybackProgress(payload);
    if (this.films.filmIdForPart(input.partId) !== input.filmId) throw new Error('INVALID_PART_ID');
    return this.films.updatePlaybackProgress(input.filmId, input.partId, input.positionSeconds, input.durationSeconds);
  }
}
