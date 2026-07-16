import type { AssetType } from '../../shared/enums';
import type { MappedNfoFields } from '../metadata/NfoMapper';
import { physicalFileKey } from './PartNaming';
import type { FilmPartType } from './PartNaming';

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

export interface FilmFileCandidate {
  absolutePath: string;
  relativePath: string;
  filename: string;
  partType: FilmPartType;
  partNumber: number;
  isPrimary: boolean;
  fileSize: number;
  fileModifiedAt: string;
  fingerprint: string;
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
  logicalKey: string;
  partBaseName: string;
  files: FilmFileCandidate[];
}

export interface CandidatePathConflict {
  sourceId: string;
  relativePath: string;
  keptLogicalKey: string;
  discardedLogicalKeys: string[];
  reason: 'grouped-part-preferred' | 'duplicate-candidate';
}

export interface CandidateDeduplicationResult {
  candidates: FilmCandidate[];
  conflicts: CandidatePathConflict[];
}

/**
 * Removes duplicate physical files before a database transaction starts.
 * Grouped CD/Disc candidates win over a single-file candidate because the
 * grouped candidate is the more specific interpretation of the same file.
 */
export function dedupeFilmCandidates(sourceId: string, candidates: FilmCandidate[]): CandidateDeduplicationResult {
  const owners = new Map<string, { candidateIndex: number; file: FilmFileCandidate }>();
  const conflicts: CandidatePathConflict[] = [];

  const rank = (candidate: FilmCandidate): [number, string] => {
    const grouped = candidate.files.some((file) => file.partType === 'cd' || file.partType === 'disc') || candidate.files.length > 1;
    return [grouped ? 0 : 1, candidate.logicalKey];
  };

  const ordered = candidates
    .map((candidate, candidateIndex) => ({ candidate, candidateIndex }))
    .sort((left, right) => {
      const [leftRank, leftKey] = rank(left.candidate);
      const [rightRank, rightKey] = rank(right.candidate);
      return leftRank - rightRank || leftKey.localeCompare(rightKey);
    });

  for (const { candidate, candidateIndex } of ordered) {
    for (const file of candidate.files) {
      const key = physicalFileKey(sourceId, file.relativePath);
      const previous = owners.get(key);
      if (!previous) {
        owners.set(key, { candidateIndex, file });
        continue;
      }
      const previousCandidate = candidates[previous.candidateIndex]!;
      const previousRank = rank(previousCandidate)[0];
      const currentRank = rank(candidate)[0];
      const keepCurrent = currentRank < previousRank || (currentRank === previousRank && candidate.logicalKey < previousCandidate.logicalKey);
      const kept = keepCurrent ? candidate : previousCandidate;
      const discarded = keepCurrent ? previousCandidate : candidate;
      if (keepCurrent) owners.set(key, { candidateIndex, file });
      conflicts.push({
        sourceId,
        relativePath: file.relativePath,
        keptLogicalKey: kept.logicalKey,
        discardedLogicalKeys: [discarded.logicalKey],
        reason: currentRank !== previousRank ? 'grouped-part-preferred' : 'duplicate-candidate',
      });
    }
  }

  const result = candidates.flatMap((candidate, candidateIndex) => {
    const files = candidate.files.filter((file) => {
      const owner = owners.get(physicalFileKey(sourceId, file.relativePath));
      return owner?.candidateIndex === candidateIndex && owner.file === file;
    });
    if (!files.length) return [];
    const primary = files.find((file) => file.isPrimary) ?? files[0]!;
    return [{
      ...candidate,
      absolutePath: primary.absolutePath,
      relativePath: primary.relativePath,
      filename: primary.filename,
      fileSize: primary.fileSize,
      fileModifiedAt: primary.fileModifiedAt,
      fingerprint: primary.fingerprint,
      files: files.map((file) => ({ ...file, isPrimary: file.absolutePath === primary.absolutePath })),
    }];
  });

  assertUniqueIncomingPhysicalFiles(sourceId, result);
  return { candidates: result, conflicts };
}

export function assertUniqueIncomingPhysicalFiles(sourceId: string, candidates: FilmCandidate[]): void {
  const owners = new Map<string, string>();
  const duplicates: string[] = [];
  for (const candidate of candidates) {
    for (const file of candidate.files) {
      const key = physicalFileKey(sourceId, file.relativePath);
      const previous = owners.get(key);
      if (previous) duplicates.push(`${file.relativePath} (${previous} -> ${candidate.logicalKey})`);
      else owners.set(key, candidate.logicalKey);
    }
  }
  if (duplicates.length) throw new Error(`INCOMING_FILM_FILE_DUPLICATES:${duplicates.slice(0, 20).join('; ')}`);
}
