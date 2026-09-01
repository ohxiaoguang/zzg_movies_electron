import type {
  ApiResult,
  AccountAuthStatusDto,
  AccountCredentialsInput,
  ActorDto,
  AppHealthDto,
  AppInfoDto,
  CorrectSourceTransferInput,
  CloudBackupConfigUpdateInput,
  CloudBackupActivityDto,
  CloudBackupRestoreInput,
  CloudBackupRestorePreviewDto,
  CloudBackupRestoreResultDto,
  CloudBackupRunResultDto,
  CloudBackupStatusDto,
  CloudBackupVersionDto,
  CreateSourceInput,
  DesktopSubtitleTrackDto,
  FilmPartDto,
  FilmDetailDto,
  FilmPageDto,
  FilmNavigationCountsDto,
  FilmCsvExportResultDto,
  FilmPageQuery,
  FilmUpdateInput,
  FilmUpdatePatch,
  FilmNfoImportMode,
  FilmSegmentCreateInput,
  FilmSegmentDto,
  FilmSegmentUpdateInput,
  CustomCategoryDto,
  CustomCategoryCreateInput,
  CustomCategoryRenameInput,
  CustomCategoryRemoveInput,
  CustomCategoryReorderInput,
  FfprobeTestResult,
  LanServerStatusDto,
  MediaSourceDto,
  PlaybackCacheInfoDto,
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
  SourceTransferRecordDto,
  TagDto,
  TransferSourceInput,
  TransferSourceResultDto,
  UpdateSourceInput,
} from '../shared/contracts';

export interface FilmLibraryApi {
  account: {
    status(): Promise<ApiResult<AccountAuthStatusDto>>;
    setup(input: AccountCredentialsInput): Promise<ApiResult<AccountAuthStatusDto>>;
    login(input: AccountCredentialsInput): Promise<ApiResult<AccountAuthStatusDto>>;
    logout(): Promise<ApiResult<AccountAuthStatusDto>>;
  };
  sources: {
    list(): Promise<ApiResult<MediaSourceDto[]>>;
    chooseDirectory(): Promise<ApiResult<string | null>>;
    create(input: CreateSourceInput): Promise<ApiResult<MediaSourceDto>>;
    update(input: UpdateSourceInput): Promise<ApiResult<MediaSourceDto>>;
    remove(input: RemoveSourceInput): Promise<ApiResult<null>>;
    transfer(input: TransferSourceInput): Promise<ApiResult<TransferSourceResultDto>>;
    transferHistory(): Promise<ApiResult<SourceTransferRecordDto[]>>;
    correctTransfer(input: CorrectSourceTransferInput): Promise<ApiResult<TransferSourceResultDto>>;
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
    updatePartVr(partId: string, isVr: boolean): Promise<ApiResult<FilmPartDto>>;
    subtitleTracks(partId: string): Promise<ApiResult<DesktopSubtitleTrackDto[]>>;
    subtitleContent(partId: string, index: number): Promise<ApiResult<string>>;
    cancelPreview(partId: string): Promise<ApiResult<boolean>>;
    createSegment(input: FilmSegmentCreateInput): Promise<ApiResult<FilmSegmentDto>>;
    updateSegment(input: FilmSegmentUpdateInput): Promise<ApiResult<FilmSegmentDto>>;
    deleteSegment(id: string): Promise<ApiResult<null>>;
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
  lanServer: {
    status(): Promise<ApiResult<LanServerStatusDto>>;
    start(): Promise<ApiResult<LanServerStatusDto>>;
    stop(): Promise<ApiResult<LanServerStatusDto>>;
  };
  settings: {
    get(): Promise<ApiResult<SettingsDto>>;
    update(input: SettingsUpdateInput): Promise<ApiResult<SettingsDto>>;
    testFfprobe(path: string): Promise<ApiResult<FfprobeTestResult>>;
    cacheInfo(): Promise<ApiResult<PlaybackCacheInfoDto>>;
    chooseCacheDirectory(): Promise<ApiResult<string | null>>;
    openCacheDirectory(): Promise<ApiResult<null>>;
    clearCache(): Promise<ApiResult<PlaybackCacheInfoDto>>;
  };
  cloudBackup: {
    status(): Promise<ApiResult<CloudBackupStatusDto>>;
    updateConfig(input: CloudBackupConfigUpdateInput): Promise<ApiResult<CloudBackupStatusDto>>;
    testConnection(): Promise<ApiResult<CloudBackupStatusDto>>;
    run(force?: boolean): Promise<ApiResult<CloudBackupRunResultDto>>;
    versions(): Promise<ApiResult<CloudBackupVersionDto[]>>;
    previewRestore(commitSha: string): Promise<ApiResult<CloudBackupRestorePreviewDto>>;
    restore(input: CloudBackupRestoreInput): Promise<ApiResult<CloudBackupRestoreResultDto>>;
    onActivity(listener: (activity: CloudBackupActivityDto) => void): () => void;
  };
}

declare global {
  interface Window {
    filmLibrary: FilmLibraryApi;
  }
}
