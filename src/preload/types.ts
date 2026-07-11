import type {
  ApiResult,
  AppHealthDto,
  AppInfoDto,
  CreateSourceInput,
  FilmDetailDto,
  FilmPageDto,
  FilmPageQuery,
  FilmUpdateInput,
  FfprobeTestResult,
  MediaSourceDto,
  RemoveSourceInput,
  ScanProgressDto,
  ScanStartDto,
  ScanStartInput,
  ScanStatusDto,
  SettingsDto,
  SettingsUpdateInput,
  TagDto,
  UpdateSourceInput,
} from '../shared/contracts';

export interface FilmLibraryApi {
  sources: {
    list(): Promise<ApiResult<MediaSourceDto[]>>;
    chooseDirectory(): Promise<ApiResult<string | null>>;
    create(input: CreateSourceInput): Promise<ApiResult<MediaSourceDto>>;
    update(input: UpdateSourceInput): Promise<ApiResult<MediaSourceDto>>;
    remove(input: RemoveSourceInput): Promise<ApiResult<null>>;
  };
  films: {
    page(query: FilmPageQuery): Promise<ApiResult<FilmPageDto>>;
    detail(id: string): Promise<ApiResult<FilmDetailDto>>;
    update(input: FilmUpdateInput): Promise<ApiResult<FilmDetailDto>>;
    open(id: string): Promise<ApiResult<null>>;
    showInFolder(id: string): Promise<ApiResult<null>>;
    importNfo(id: string, mode: 'supplement' | 'force'): Promise<ApiResult<FilmDetailDto>>;
    rescan(id: string): Promise<ApiResult<ScanStartDto>>;
  };
  tags: {
    list(): Promise<ApiResult<TagDto[]>>;
  };
  scan: {
    start(input: ScanStartInput): Promise<ApiResult<ScanStartDto>>;
    cancel(): Promise<ApiResult<null>>;
    status(): Promise<ApiResult<ScanStatusDto | null>>;
    onProgress(listener: (progress: ScanProgressDto) => void): () => void;
  };
  app: {
    info(): Promise<ApiResult<AppInfoDto>>;
    health(): Promise<ApiResult<AppHealthDto>>;
    openDataFolder(): Promise<ApiResult<null>>;
    openLogsFolder(): Promise<ApiResult<null>>;
  };
  settings: {
    get(): Promise<ApiResult<SettingsDto>>;
    update(input: SettingsUpdateInput): Promise<ApiResult<SettingsDto>>;
    testFfprobe(path: string): Promise<ApiResult<FfprobeTestResult>>;
  };
}

declare global {
  interface Window {
    filmLibrary: FilmLibraryApi;
  }
}
