import type { AssetType, ScanStatus } from './enums';

export interface ApiError {
  code: string;
  message: string;
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiError };

export interface MediaSourceDto {
  id: string;
  name: string;
  rootPath: string;
  enabled: boolean;
  recursive: boolean;
  allowOriginalPreview: boolean;
  archived: boolean;
  online: boolean;
  createdAt: string;
  updatedAt: string;
  lastScanAt: string | null;
  lastScanStatus: string | null;
  deletedAt: string | null;
}

export interface CreateSourceInput {
  name: string;
  rootPath: string;
  enabled?: boolean;
  recursive?: boolean;
  allowOriginalPreview?: boolean;
}

export interface UpdateSourceInput {
  id: string;
  name?: string;
  rootPath?: string;
  enabled?: boolean;
  recursive?: boolean;
  allowOriginalPreview?: boolean;
}

export interface RemoveSourceInput {
  id: string;
  mode: 'keep-records' | 'delete-records';
}

export interface RestoreSourceInput {
  id: string;
}

export interface FindDeletedSourceInput {
  rootPath: string;
}

export interface FilmAssetDto {
  id: string;
  assetType: AssetType;
  relativePath: string;
  sortOrder: number;
  fileSize: number | null;
  fileModifiedAt: string | null;
  missing: boolean;
}

export interface FilmPartDto {
  id: string;
  partType: 'single' | 'cd' | 'disc';
  partNumber: number;
  filename: string;
  relativePath: string;
  fileSize: number;
  fileModifiedAt: string | null;
  missing: boolean;
}

export interface FilmImageDto extends FilmAssetDto {
  assetType: 'poster' | 'fanart' | 'thumb' | 'extra_fanart';
}

export type FilmAvailability =
  | 'available'
  | 'partial_missing'
  | 'missing'
  | 'source_offline'
  | 'source_removed'
  | 'archived';

export type OrganizationState = 'unorganized' | 'organized';

export interface CustomCategoryDto {
  id: string;
  name: string;
  sortOrder: number;
  filmCount?: number;
}

export interface ActorDto {
  name: string;
  filmCount: number;
}

export interface FilmSummaryDto {
  id: string;
  sourceId: string;
  sourceName: string;
  relativePath: string;
  filename: string;
  title: string;
  originalTitle: string | null;
  year: number | null;
  favorite: boolean;
  organizationState: OrganizationState;
  customCategories: CustomCategoryDto[];
  rating: number;
  missing: boolean;
  posterAssetId: string | null;
  previewAssetId: string | null;
  allowOriginalPreview: boolean;
  previewImageAssetIds: string[];
  updatedAt: string;
  availability: FilmAvailability;
  totalFileCount: number;
  existingFileCount: number;
  missingFileCount: number;
  sourceDeleted: boolean;
}

export interface FilmDetailDto extends FilmSummaryDto {
  sortTitle: string | null;
  releaseDate: string | null;
  runtimeSeconds: number | null;
  plot: string | null;
  outline: string | null;
  tagline: string | null;
  contentRating: string | null;
  studio: string | null;
  countries: string[];
  directors: string[];
  actors: string[];
  nfoTags: TagDto[];
  notes: string;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  containerFormat: string | null;
  nfoRelativePath: string | null;
  nfoStatus: string | null;
  nfoError: string | null;
  archived: boolean;
  importedAt: string;
  lastSeenAt: string | null;
  assets: FilmAssetDto[];
  parts: FilmPartDto[];
  images: FilmImageDto[];
  availability: FilmAvailability;
}

export interface FilmPageQuery {
  page: number;
  pageSize: number;
  search?: string;
  sourceId?: string;
  actor?: string;
  organizationState?: OrganizationState | 'all';
  categoryIds?: string[];
  categoryMatch?: 'any' | 'all';
  nfoTagIds?: string[];
  nfoTagMatch?: 'any' | 'all';
  minRating?: number;
  favoriteOnly?: boolean;
  missingOnly?: boolean;
  allData?: boolean;
  availability?: FilmAvailability | 'all';
  sort?: 'recent' | 'title' | 'year' | 'rating' | 'file';
}

export interface FilmPageDto {
  items: FilmSummaryDto[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface FilmNavigationCountsDto {
  all: number;
  unorganized: number;
  organized: number;
  favorite: number;
  allData: number;
}

export interface FilmCsvExportResultDto {
  saved: boolean;
  rowCount: number;
  filePath?: string;
}

export interface FilmUpdateInput {
  id: string;
  title?: string;
  originalTitle?: string;
  rating?: number;
  notes?: string;
}

export type FilmUpdatePatch = Omit<FilmUpdateInput, 'id'>;

export interface FilmUpdatePatchInput {
  id: string;
  patch: FilmUpdatePatch;
}

export interface FilmFavoriteUpdateInput {
  id: string;
  favorite: boolean;
}

export interface FilmCategoriesUpdateInput {
  id: string;
  categoryIds: string[];
  newCategoryNames?: string[];
}

export type FilmNfoImportMode = 'supplement' | 'force-merge' | 'force-replace';

export interface TagDto {
  id: string;
  name: string;
  filmCount: number;
}

export interface CustomCategoryCreateInput { name: string; }
export interface CustomCategoryRenameInput { id: string; name: string; }
export interface CustomCategoryRemoveInput { id: string; }
export interface CustomCategoryReorderInput { ids: string[]; }

export interface FilmRecordDeleteInput {
  id: string;
}

export interface FilmRecordDeleteBatchInput {
  ids: string[];
}

export interface ScanStartInput {
  sourceIds?: string[];
}

export interface ScanStartDto {
  jobId: string;
}

export interface ScanProgressDto {
  jobId: string;
  status: ScanStatus;
  currentSource: string | null;
  currentDirectory: string | null;
  currentFilm: string | null;
  discovered: number;
  processed: number;
  created: number;
  updated: number;
  moved: number;
  missing: number;
  nfoErrors: number;
  ambiguousAssets: number;
  otherErrors: number;
  message: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface ScanStatusDto extends ScanProgressDto {
  sourceCount: number;
  cancelled: boolean;
}

export interface AppInfoDto {
  version: string;
  dataDirectory: string;
  databasePath: string;
  logsDirectory: string;
}

export interface AppHealthDto {
  ok: true;
  appVersion: string;
  databaseReady: boolean;
  ipcReady: boolean;
}

export interface SettingsDto {
  cardSize: number;
  hoverDelayMs: number;
  slideshowIntervalMs: number;
  pageSize: number;
  videoExtensions: string[];
  imageExtensions: string[];
  ignoredDirectories: string[];
  autoScanOnStartup: boolean;
  ffprobePath: string;
}

export type SettingsUpdateInput = Partial<SettingsDto>;

export interface FfprobeTestResult {
  ok: boolean;
  message: string;
  version: string | null;
}
