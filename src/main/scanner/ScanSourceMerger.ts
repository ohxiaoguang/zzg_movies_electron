import { randomUUID } from 'node:crypto';
import type { MediaSourceDto, ScanIssueDto } from '../../shared/contracts';
import type { DatabaseManager } from '../database/DatabaseManager';
import type { FilmRepository } from '../database/repositories/FilmRepository';
import type { AppLogger } from '../system/AppLogger';
import { assertUniqueIncomingPhysicalFiles, dedupeFilmCandidates, type FilmCandidate } from './ScanCandidate';
import type { ScanCancellation } from './ScanCancellation';

export class ScanSourceMerger {
  public constructor(private readonly database: DatabaseManager, private readonly films: FilmRepository, private readonly logger: Pick<AppLogger, 'warn'>) {}
  public merge(source: MediaSourceDto, candidates: FilmCandidate[], relativeDirectory: string | null = null, cancellation?: ScanCancellation): { created: number; updated: number; moved: number; missing: number; errors: number; issues: ScanIssueDto[] } {
    const now = new Date().toISOString();
    let created = 0;
    let updated = 0;
    let moved = 0;
    let errors = 0;
    const issues: ScanIssueDto[] = [];
    const deduplicated = dedupeFilmCandidates(source.id, candidates);
    for (const conflict of deduplicated.conflicts) {
      errors++;
      issues.push({ id: randomUUID(), type: 'database', sourceId: source.id, sourceName: source.name, filmTitle: '', relativePath: conflict.relativePath, relatedPaths: [], message: `同一物理文件匹配到多个影片分组，已保留 ${conflict.keptLogicalKey}，忽略重复分组` });
      this.logger.warn('Duplicate physical file in scan candidates', {
        sourceId: conflict.sourceId,
        relativeFile: conflict.relativePath,
        keptLogicalKey: conflict.keptLogicalKey,
        discardedLogicalKeys: conflict.discardedLogicalKeys,
        reason: conflict.reason,
      });
    }
    assertUniqueIncomingPhysicalFiles(source.id, deduplicated.candidates);
    const missing = this.database.transaction(() => this.films.withScanPathLookup(source.id, () => {
      const previouslyAvailable = new Set((this.database.db.prepare(
        'SELECT id FROM film WHERE source_id = ? AND archived = 0 AND missing = 0',
      ).all(source.id) as Array<{ id: string }>).map((film) => film.id));
      const previouslyExistingFiles = new Set((this.database.db.prepare('SELECT id FROM film_file WHERE source_id = ? AND missing = 0').all(source.id) as Array<{ id: string }>).map((file) => file.id));
      if (relativeDirectory) this.films.markDirectoryMissing(source.id, relativeDirectory, now);
      else this.films.markSourceMissing(source.id, now);
      for (const candidate of deduplicated.candidates) {
        cancellation?.throwIfCancelled();
        const result = this.films.upsertCandidate(candidate, now);
        if (result.created) created += 1;
        else if (result.moved) moved += 1;
        else updated += 1;
      }
      const missingRows = (this.database.db.prepare(
        'SELECT id, title, relative_path FROM film WHERE source_id = ? AND archived = 0 AND missing = 1',
      ).all(source.id) as Array<{ id: string; title: string; relative_path: string }>).filter((film) => previouslyAvailable.has(film.id));
      for (const film of missingRows) issues.push({ id: randomUUID(), type: 'missing', sourceId: source.id, sourceName: source.name, filmTitle: film.title, relativePath: film.relative_path, relatedPaths: [], message: '成功扫描后未找到影片文件，已标记缺失；可检查文件是否改名或移动' });
      const fullyMissing = new Set(missingRows.map((film) => film.id));
      const partialRows = this.database.db.prepare(`SELECT ff.id, ff.film_id, ff.relative_path, f.title FROM film_file ff JOIN film f ON f.id = ff.film_id
        WHERE ff.source_id = ? AND ff.missing = 1 AND f.archived = 0 AND f.missing = 0`).all(source.id) as Array<{ id: string; film_id: string; relative_path: string; title: string }>;
      for (const file of partialRows) if (previouslyExistingFiles.has(file.id) && !fullyMissing.has(file.film_id)) {
        issues.push({ id: randomUUID(), type: 'missing', sourceId: source.id, sourceName: source.name, filmTitle: file.title,
          relativePath: file.relative_path, relatedPaths: [], message: '影片的部分分段文件未找到，其余分段仍可播放；请检查文件是否改名或移动' });
      }
      return missingRows.length;
    }));
    return { created, updated, moved, missing, errors, issues };
  }

}
