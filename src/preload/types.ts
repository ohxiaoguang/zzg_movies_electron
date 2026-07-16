import type {
  ApiResult,
  ActorDto,
  AppHealthDto,
  AppInfoDto,
  CreateSourceInput,
  FilmPartDto,
  FilmDetailDto,
  FilmPageDto,
  FilmNavigationCountsDto,
  FilmCsvExportResultDto,
  FilmPageQuery,
  FilmUpdateInput,
  FilmUpdatePatch,
  FilmNfoImportMode,
  CustomCategoryDto,
  CustomCategoryCreateInput,
  CustomCategoryRenameInput,
  CustomCategoryRemoveInput,
  CustomCategoryReorderInput,
  FfprobeTestResult,
  MediaSourceDto,
  RemoveSourceInput,
  RestoreSourceInput,
  FindDeletedSourceInput,
  FilmRecordDeleteInput,
  FilmRecordDeleteBatchInput,
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
    restore(input: RestoreSourceInput): Promise<ApiResult<MediaSourceDto>>;
    findDeleted(input: FindDeletedSourceInput): Promise<ApiResult<MediaSourceDto | null>>;
  };
  films: {
    page(query: FilmPageQuery): Promise<ApiResult<FilmPageDto>>;
    navigationCounts(): Promise<ApiResult<FilmNavigationCountsDto>>;
    exportCsv(query: FilmPageQuery): Promise<ApiResult<FilmCsvExportResultDto>>;
    detail(id: string): Promise<ApiResult<FilmDetailDto>>;
    update(input: FilmUpdateInput): Promise<ApiResult<FilmDetailDto>>;
    updatePatch(id: string, patch: FilmUpdatePatch): Promise<ApiResult<FilmDetailDto>>;
    updateFavorite(id: string, favorite: boolean): Promise<ApiResult<FilmDetailDto>>;
    updateCategories(id: string, categoryIds: string[], newCategoryNames?: string[]): Promise<ApiResult<FilmDetailDto>>;
    open(id: string): Promise<ApiResult<null>>;
    showInFolder(id: string): Promise<ApiResult<null>>;
    importNfo(id: string, mode: FilmNfoImportMode): Promise<ApiResult<FilmDetailDto>>;
    rescan(id: string): Promise<ApiResult<ScanStartDto>>;
    partsList(filmId: string): Promise<ApiResult<FilmPartDto[]>>;
    partsOpen(partId: string): Promise<ApiResult<null>>;
    partsShowInFolder(partId: string): Promise<ApiResult<null>>;
    recordsPageAll(query: FilmPageQuery): Promise<ApiResult<FilmPageDto>>;
    recordsDelete(input: FilmRecordDeleteInput): Promise<ApiResult<null>>;
    recordsDeleteBatch(input: FilmRecordDeleteBatchInput): Promise<ApiResult<null>>;
  };
  nfoTags: {
    list(): Promise<ApiResult<TagDto[]>>;
  };
  actors: {
    list(): Promise<ApiResult<ActorDto[]>>;
  };
  categories: {
    list(): Promise<ApiResult<CustomCategoryDto[]>>;
    create(input: CustomCategoryCreateInput): Promise<ApiResult<CustomCategoryDto>>;
    rename(input: CustomCategoryRenameInput): Promise<ApiResult<CustomCategoryDto>>;
    remove(input: CustomCategoryRemoveInput): Promise<ApiResult<null>>;
    reorder(input: CustomCategoryReorderInput): Promise<ApiResult<CustomCategoryDto[]>>;
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
