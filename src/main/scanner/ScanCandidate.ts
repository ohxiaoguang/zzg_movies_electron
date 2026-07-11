import type { AssetType } from '../../shared/enums';
import type { MappedNfoFields } from '../metadata/NfoMapper';

export interface ScanFileEntry {
  absolutePath: string;
  relativePath: string;
  name: string;
}

export interface MatchedAsset {
  assetType: AssetType;
  entry: ScanFileEntry;
  sortOrder: number;
  fileSize: number | null;
  fileModifiedAt: string | null;
  missing: boolean;
}

export interface FilmCandidate extends MappedNfoFields {
  sourceId: string;
  sourceRootPath: string;
  absolutePath: string;
  relativePath: string;
  filename: string;
  fileSize: number;
  fileModifiedAt: string;
  fingerprint: string;
  nfoRelativePath: string | null;
  nfoModifiedAt: string | null;
  nfoHash: string | null;
  nfoStatus: 'ok' | 'missing' | 'error';
  nfoError: string | null;
  assets: MatchedAsset[];
  ambiguousAssets: number;
}
