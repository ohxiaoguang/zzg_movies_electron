import fs from 'node:fs';
import path from 'node:path';
import type {
  CustomCategoryCreateInput,
  CustomCategoryRemoveInput,
  CustomCategoryRenameInput,
  FilmBatchUpdateInput,
  FilmCategoriesUpdateInput,
  FilmDetailDto,
  FilmFavoriteUpdateInput,
  FilmNfoImportInput,
  FilmPageQuery,
  FilmRecordDeleteConfirmedInput,
  FilmTaxonomyUpdateInput,
  FilmUpdateInput,
  ScanStartDto,
  ScanStartInput,
  ScanStatusDto,
  WebCsvExportDto,
} from '../../shared/contracts';
import type { DatabaseManager } from '../database/DatabaseManager';
import type { FilmRepository } from '../database/repositories/FilmRepository';
import type { SourceRepository } from '../database/repositories/SourceRepository';
import { buildFilmCsv, buildFilmCsvFilename } from '../export/FilmCsvExporter';
import { resolveExistingSafeMediaPath } from '../media/MediaPathResolver';
import { mapNfoMetadata } from '../metadata/NfoMapper';
import { parseNfo } from '../metadata/NfoParser';
import type { ScanCoordinator } from '../scanner/ScanCoordinator';
import type { AppLogger } from '../system/AppLogger';
import type { FilmLibraryReadService } from './FilmLibraryReadService';

export class FilmLibraryManagementService {
  public constructor(
    private readonly database: DatabaseManager,
    private readonly films: FilmRepository,
    private readonly sources: SourceRepository,
    private readonly read: FilmLibraryReadService,
    private readonly scan: ScanCoordinator,
    private readonly logger: AppLogger,
  ) {}

  public updateFilm(input: FilmUpdateInput): FilmDetailDto {
    return this.films.update(input);
  }

  public updateFavorite(input: FilmFavoriteUpdateInput): FilmDetailDto {
    return this.films.updateFavorite(input.id, input.favorite);
  }

  public updateCategories(input: FilmCategoriesUpdateInput): FilmDetailDto {
    return this.films.updateCategories(input.id, input.categoryIds, input.newCategoryNames);
  }

  public updateTaxonomy(input: FilmTaxonomyUpdateInput): FilmDetailDto {
    const { id, ...taxonomy } = input;
    return this.films.updateTaxonomy(id, taxonomy);
  }

  public batchUpdate(input: FilmBatchUpdateInput): FilmDetailDto[] {
    return this.database.transaction(() => input.ids.map((id) => {
      if (input.favorite !== undefined) this.films.updateFavorite(id, input.favorite);
      if (input.tagNames !== undefined
        || input.genreNames !== undefined
        || input.categoryIds !== undefined
        || input.newCategoryNames !== undefined) {
        this.films.updateTaxonomy(id, {
          tagNames: input.tagNames,
          genreNames: input.genreNames,
          categoryIds: input.categoryIds,
          newCategoryNames: input.newCategoryNames,
        });
      }
      return this.read.detail(id);
    }));
  }

  public createCategory(input: CustomCategoryCreateInput) {
    return this.films.createCategory(input.name);
  }

  public renameCategory(input: CustomCategoryRenameInput) {
    return this.films.renameCategory(input.id, input.name);
  }

  public removeCategory(input: CustomCategoryRemoveInput): void {
    this.films.removeCategory(input.id);
  }

  public async importNfo(input: FilmNfoImportInput): Promise<FilmDetailDto> {
    const detail = this.read.detail(input.id);
    if (!detail.nfoRelativePath) throw new Error('NFO_NOT_FOUND');
    const source = this.sources.findById(detail.sourceId);
    if (!source) throw new Error('SOURCE_NOT_FOUND');
    const nfoPath = await resolveExistingSafeMediaPath(source.rootPath, detail.nfoRelativePath);
    const xml = await fs.promises.readFile(nfoPath, 'utf8');
    const mapped = mapNfoMetadata(parseNfo(xml), detail.title);
    const now = new Date().toISOString();
    return input.mode === 'supplement'
      ? this.films.supplementFromMappedNfo(detail.id, mapped, now)
      : this.films.forceImportNfo(detail.id, mapped, now, input.mode === 'force-merge' ? 'merge' : 'replace');
  }

  public rescanFilm(id: string): ScanStartDto {
    const detail = this.read.detail(id);
    return this.scan.startDirectory(detail.sourceId, path.dirname(detail.relativePath));
  }

  public rescanSource(id: string): ScanStartDto {
    if (!this.sources.findById(id)) throw new Error('SOURCE_NOT_FOUND');
    return this.scan.start({ sourceIds: [id] });
  }

  public startScan(input: ScanStartInput): ScanStartDto {
    return this.scan.start(input);
  }

  public scanStatus(): ScanStatusDto | null {
    return this.scan.status();
  }

  public exportCsv(query: FilmPageQuery): WebCsvExportDto {
    const rows = this.films.csvRows(query);
    return {
      filename: buildFilmCsvFilename(
        query.favoriteOnly && query.organizationState !== 'organized' ? 'favorite' : 'organized',
      ),
      content: buildFilmCsv(rows),
      rowCount: rows.length,
    };
  }

  public deleteRecords(input: FilmRecordDeleteConfirmedInput): void {
    for (const id of input.ids) this.read.detail(id);
    this.films.deleteRecords(input.ids);
    this.logger.warn('Film database records deleted from web management', {
      recordCount: input.ids.length,
      deletesMediaFiles: false,
      writesExternalNfo: false,
    });
  }
}
