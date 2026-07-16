import type Database from 'better-sqlite3';
import { FilmFileOwnershipRepairService, type FilmRepairReport } from '../FilmFileOwnershipRepairService';

export const groupedFilmFilesRepairMigration = {
  version: 3,
  run(db: Database.Database): FilmRepairReport {
    const service = new FilmFileOwnershipRepairService(db);
    return service.repairExisting();
  },
};
