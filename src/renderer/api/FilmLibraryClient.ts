import type {
  ActorDto,
  ApiResult,
  CustomCategoryDto,
  FilmDetailDto,
  FilmPageDto,
  FilmPageQuery,
  GenreDto,
  PublicMediaSourceDto,
  TagDto,
} from '../../shared/contracts';

export interface FilmLibraryClient {
  page(query: FilmPageQuery): Promise<ApiResult<FilmPageDto>>;
  detail(id: string): Promise<ApiResult<FilmDetailDto>>;
  sources(): Promise<ApiResult<PublicMediaSourceDto[]>>;
  categories(): Promise<ApiResult<CustomCategoryDto[]>>;
  tags(): Promise<ApiResult<TagDto[]>>;
  genres(): Promise<ApiResult<GenreDto[]>>;
  actors(): Promise<ApiResult<ActorDto[]>>;
  mediaUrl(kind: 'asset' | 'poster', id: string): string;
}

export class ElectronFilmLibraryClient implements FilmLibraryClient {
  public page(query: FilmPageQuery): Promise<ApiResult<FilmPageDto>> {
    return window.filmLibrary.films.page(query);
  }

  public detail(id: string): Promise<ApiResult<FilmDetailDto>> {
    return window.filmLibrary.films.detail(id);
  }

  public sources(): Promise<ApiResult<PublicMediaSourceDto[]>> {
    return window.filmLibrary.sources.list();
  }

  public categories(): Promise<ApiResult<CustomCategoryDto[]>> {
    return window.filmLibrary.categories.list();
  }

  public tags(): Promise<ApiResult<TagDto[]>> {
    return window.filmLibrary.nfoTags.list();
  }

  public genres(): Promise<ApiResult<GenreDto[]>> {
    return Promise.resolve({ ok: true, data: [] });
  }

  public actors(): Promise<ApiResult<ActorDto[]>> {
    return window.filmLibrary.actors.list();
  }

  public mediaUrl(kind: 'asset' | 'poster', id: string): string {
    return `film-media://${kind}/${encodeURIComponent(id)}`;
  }
}

export class HttpFilmLibraryClient implements FilmLibraryClient {
  public constructor(private readonly baseUrl = window.location.origin) {}

  public page(query: FilmPageQuery): Promise<ApiResult<FilmPageDto>> {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') continue;
      if (Array.isArray(value)) value.forEach((item) => search.append(key, String(item)));
      else search.set(key, String(value));
    }
    return this.get(`/api/v1/films?${search.toString()}`);
  }

  public detail(id: string): Promise<ApiResult<FilmDetailDto>> {
    return this.get(`/api/v1/films/${encodeURIComponent(id)}`);
  }

  public sources(): Promise<ApiResult<PublicMediaSourceDto[]>> {
    return this.get('/api/v1/sources');
  }

  public categories(): Promise<ApiResult<CustomCategoryDto[]>> {
    return this.get('/api/v1/categories');
  }

  public tags(): Promise<ApiResult<TagDto[]>> {
    return this.get('/api/v1/tags');
  }

  public genres(): Promise<ApiResult<GenreDto[]>> {
    return this.get('/api/v1/genres');
  }

  public actors(): Promise<ApiResult<ActorDto[]>> {
    return this.get('/api/v1/actors');
  }

  public mediaUrl(kind: 'asset' | 'poster', id: string): string {
    const collection = kind === 'poster' ? 'posters' : 'assets';
    return new URL(`/media/v1/${collection}/${encodeURIComponent(id)}`, this.baseUrl).toString();
  }

  private async get<T>(path: string): Promise<ApiResult<T>> {
    try {
      const response = await fetch(new URL(path, this.baseUrl), { headers: { Accept: 'application/json' } });
      return await response.json() as ApiResult<T>;
    } catch {
      return { ok: false, error: { code: 'HTTP_UNAVAILABLE', message: '本机网页服务不可用' } };
    }
  }
}

export const filmLibraryClient: FilmLibraryClient = new ElectronFilmLibraryClient();
