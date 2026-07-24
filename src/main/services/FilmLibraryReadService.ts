import type {
  ActorDto,
  CustomCategoryDto,
  FilmDetailDto,
  FilmFilterDataDto,
  FilmNavigationCountsDto,
  FilmPageDto,
  FilmPageQuery,
  GenreDto,
  MediaSourceDto,
  PublicMediaSourceDto,
  TagDto,
} from '../../shared/contracts';
import { validateFilmPageQuery } from '../../shared/filmQueryValidation';
import { isUuid } from '../../shared/validation';
import type { FilmRepository } from '../database/repositories/FilmRepository';
import type { SettingsRepository } from '../database/repositories/SettingsRepository';
import type { SourceRepository } from '../database/repositories/SourceRepository';

export class FilmLibraryReadService {
  public constructor(
    private readonly films: FilmRepository,
    private readonly sources: SourceRepository,
    private readonly settings: SettingsRepository,
  ) {}

  public page(payload: unknown, strict = false): FilmPageDto {
    return this.films.page(this.pageQuery(payload, strict));
  }

  public pageQuery(payload: unknown, strict = false): FilmPageQuery {
    return validateFilmPageQuery(payload, this.settings.get().pageSize, { strict });
  }

  public detail(id: unknown): FilmDetailDto {
    if (!isUuid(id)) throw new Error('INVALID_FILM_ID');
    const detail = this.films.detail(id);
    if (!detail) throw new Error('FILM_NOT_FOUND');
    return detail;
  }

  public navigationCounts(): FilmNavigationCountsDto {
    return this.films.navigationCounts();
  }

  public listSources(): MediaSourceDto[] {
    return this.sources.list();
  }

  public listPublicSources(): PublicMediaSourceDto[] {
    return this.listSources().map((source) => ({
      id: source.id,
      name: source.name,
      enabled: source.enabled,
      recursive: source.recursive,
      allowOriginalPreview: source.allowOriginalPreview,
      archived: source.archived,
      online: source.online,
      createdAt: source.createdAt,
      updatedAt: source.updatedAt,
      lastScanAt: source.lastScanAt,
      lastScanStatus: source.lastScanStatus,
      deletedAt: source.deletedAt,
    }));
  }

  public listCategories(): CustomCategoryDto[] {
    return this.films.listCategories();
  }

  public listTags(): TagDto[] {
    return this.films.listTags();
  }

  public listGenres(): GenreDto[] {
    return this.films.listGenres();
  }

  public listActors(): ActorDto[] {
    return this.films.listActors();
  }

  public filterData(): FilmFilterDataDto {
    return {
      navigation: this.navigationCounts(),
      categories: this.listCategories(),
      tags: this.listTags(),
      genres: this.listGenres(),
      actors: this.listActors(),
      sources: this.listPublicSources(),
    };
  }
}
