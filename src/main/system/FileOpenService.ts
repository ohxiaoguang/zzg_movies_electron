import fs from 'node:fs';
import { shell } from 'electron';
import type { FilmRepository } from '../database/repositories/FilmRepository';
import { resolveExistingSafeMediaPath } from '../media/MediaPathResolver';

export class FileOpenService {
  public constructor(private readonly films: FilmRepository) {}

  public async openFilm(filmId: string): Promise<string> {
    const location = this.films.filmLocation(filmId);
    if (!location) throw new Error('FILM_NOT_FOUND');
    const filePath = await resolveExistingSafeMediaPath(location.rootPath, location.relativePath);
    const result = await shell.openPath(filePath);
    if (result) throw new Error('FILE_OPEN_FAILED');
    return filePath;
  }

  public async showFilmInFolder(filmId: string): Promise<void> {
    const location = this.films.filmLocation(filmId);
    if (!location) throw new Error('FILM_NOT_FOUND');
    const filePath = await resolveExistingSafeMediaPath(location.rootPath, location.relativePath);
    if (!fs.existsSync(filePath)) throw new Error('FILM_MISSING');
    shell.showItemInFolder(filePath);
  }
}
