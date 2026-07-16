export const ASSET_TYPES = ['poster', 'fanart', 'thumb', 'extra_fanart', 'preview', 'trailer', 'sample'] as const;
export type AssetType = (typeof ASSET_TYPES)[number];

export const SCAN_STATUSES = ['running', 'completed', 'failed', 'database_failed', 'cancelled'] as const;
export type ScanStatus = (typeof SCAN_STATUSES)[number];

export const DEFAULT_VIDEO_EXTENSIONS = ['mp4', 'mkv', 'mov', 'avi', 'webm', 'm4v', 'ts', 'flv', 'wmv'];
export const DEFAULT_IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp'];
export const DEFAULT_IGNORED_DIRECTORIES = [
  '.git',
  'node_modules',
  '$RECYCLE.BIN',
  'System Volume Information',
];

export const DEFAULT_SETTINGS = {
  cardSize: 200,
  hoverDelayMs: 450,
  slideshowIntervalMs: 1200,
  pageSize: 60,
  videoExtensions: DEFAULT_VIDEO_EXTENSIONS,
  imageExtensions: DEFAULT_IMAGE_EXTENSIONS,
  ignoredDirectories: DEFAULT_IGNORED_DIRECTORIES,
  autoScanOnStartup: false,
  ffprobePath: '',
} as const;
