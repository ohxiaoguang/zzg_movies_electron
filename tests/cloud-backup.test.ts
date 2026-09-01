import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseManager } from '../src/main/database/DatabaseManager';
import { FilmRepository } from '../src/main/database/repositories/FilmRepository';
import { AppLogger } from '../src/main/system/AppLogger';
import { CloudBackupConfigService, parseGitHubRepository } from '../src/main/services/CloudBackupConfigService';
import { CloudBackupService } from '../src/main/services/CloudBackupService';
import { LibraryDataBackupService } from '../src/main/services/LibraryDataBackupService';

const roots: string[] = [];
const databases: DatabaseManager[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('logical cloud backup', () => {
  it('round-trips compatibility Unicode filenames without changing their checksum', () => {
    const source = createDatabase();
    const sourceId = insertSource(source.database, 'source');
    const film = insertFilm(source.database, sourceId, '精选／ＡＢＣ.mkv', 123, 45);
    new FilmRepository(source.database.db).createSegment({
      filmId: film.filmId,
      filmFileId: film.partId,
      startSeconds: 1,
      endSeconds: 2,
      title: '片段',
    });
    const service = new LibraryDataBackupService(source.database, '1.0.0');
    const exported = service.exportDocument();

    const parsed = service.parseDocument(JSON.parse(JSON.stringify(exported)) as unknown);

    expect(parsed).toEqual(exported);
    expect(parsed.films[0]?.filename).toBe('精选／ＡＢＣ.mkv');
    expect(parsed.films[0]?.segments[0]?.fileName).toBe('精选／ＡＢＣ.mkv');
  });

  it('exports only portable user data and restores duplicate filenames using file size', () => {
    const source = createDatabase();
    const sourceId = insertSource(source.database, 'source');
    const alpha = insertFilm(source.database, sourceId, 'movie.mkv', 100, 90);
    const beta = insertFilm(source.database, sourceId, 'other.mp4', 300, 120);
    const sourceFilms = new FilmRepository(source.database.db);
    const category = sourceFilms.createCategory('珍藏');
    sourceFilms.updateFavorite(alpha.filmId, true);
    sourceFilms.updateCategories(alpha.filmId, [category.id]);
    sourceFilms.createSegment({
      filmId: alpha.filmId,
      filmFileId: alpha.partId,
      startSeconds: 10,
      endSeconds: 20,
      title: '精彩',
      comment: '测试',
      vrView: { yawDegrees: 35, pitchDegrees: -8, fovDegrees: 62 },
    });

    const document = new LibraryDataBackupService(source.database, '1.0.0').exportDocument();
    expect(document.counts).toEqual({ films: 2, favorites: 1, categories: 1, categoryLinks: 1, segments: 1 });
    expect(JSON.stringify(document)).not.toContain(source.root);
    expect(document.films.find((film) => film.filename === 'movie.mkv')).toMatchObject({
      fileSize: 100,
      durationSeconds: 90,
      favorite: true,
      categories: ['珍藏'],
    });

    const target = createDatabase();
    const firstTargetSource = insertSource(target.database, 'new-a');
    const secondTargetSource = insertSource(target.database, 'new-b');
    const matched = insertFilm(target.database, firstTargetSource, 'MOVIE.MKV', 100, 90);
    const duplicate = insertFilm(target.database, secondTargetSource, 'movie.mkv', 200, 90);
    const uniqueDifferentSize = insertFilm(target.database, firstTargetSource, 'other.mp4', 999, 120);
    const targetFilms = new FilmRepository(target.database.db);
    const oldCategory = targetFilms.createCategory('旧分类');
    targetFilms.updateCategories(matched.filmId, [oldCategory.id]);
    targetFilms.createSegment({
      filmId: matched.filmId,
      filmFileId: matched.partId,
      startSeconds: 1,
      endSeconds: 2,
      title: '旧片段',
    });

    const targetBackup = new LibraryDataBackupService(target.database, '2.0.0');
    const preview = targetBackup.preview(document, 'abcdef1');
    expect(preview).toMatchObject({ matchedFilms: 2, missingFilms: 0, ambiguousFilms: 0, restorableSegments: 1 });
    const restored = targetBackup.restore(document);
    expect(restored).toMatchObject({ matchedFilms: 2, favoritesRestored: 1, categoryLinksRestored: 1, segmentsRestored: 1 });
    expect(targetFilms.detail(matched.filmId)).toMatchObject({
      favorite: true,
      customCategories: [expect.objectContaining({ name: '珍藏' })],
      segments: [expect.objectContaining({
        title: '精彩',
        startSeconds: 10,
        endSeconds: 20,
        vrView: { yawDegrees: 35, pitchDegrees: -8, fovDegrees: 62 },
      })],
    });
    expect(targetFilms.detail(duplicate.filmId)).toMatchObject({ favorite: false, customCategories: [], segments: [] });
    expect(targetFilms.detail(uniqueDifferentSize.filmId)?.favorite).toBe(false);
    expect(targetFilms.detail(beta.filmId)).toBeNull();
  });

  it('uses duration after filename and size, and refuses many-to-one matches', () => {
    const source = createDatabase();
    const sourceOne = insertSource(source.database, 'one');
    const sourceTwo = insertSource(source.database, 'two');
    const first = insertFilm(source.database, sourceOne, 'same.mkv', 0, 91);
    insertFilm(source.database, sourceTwo, 'duplicate.mkv', 10, 50);
    insertFilm(source.database, sourceOne, 'duplicate.mkv', 10, 50);
    new FilmRepository(source.database.db).updateFavorite(first.filmId, true);
    const document = new LibraryDataBackupService(source.database, '1').exportDocument();

    const target = createDatabase();
    const targetOne = insertSource(target.database, 'target-one');
    const targetTwo = insertSource(target.database, 'target-two');
    insertFilm(target.database, targetOne, 'same.mkv', 0, 91);
    insertFilm(target.database, targetTwo, 'same.mkv', 0, 120);
    insertFilm(target.database, targetOne, 'duplicate.mkv', 10, 50);

    const preview = new LibraryDataBackupService(target.database, '2').preview(document, 'abcdef2');
    expect(preview.matchedFilms).toBe(1);
    expect(preview.ambiguousFilms).toBe(2);
  });

  it('validates GitHub repository URLs and keeps the token encrypted outside the backup', async () => {
    expect(parseGitHubRepository('https://github.com/owner/private-repo.git')).toEqual({ owner: 'owner', repository: 'private-repo' });
    expect(parseGitHubRepository('owner/private-repo')).toEqual({ owner: 'owner', repository: 'private-repo' });
    expect(() => parseGitHubRepository('https://example.com/owner/repo')).toThrow('CLOUD_BACKUP_REPOSITORY_INVALID');

    const root = createRoot();
    const config = new CloudBackupConfigService(
      path.join(root, 'config.json'),
      path.join(root, 'pending.json'),
      fakeSecrets,
    );
    await config.update({
      repositoryUrl: 'owner/private-repo',
      branch: '',
      token: 'github_pat_secret',
      autoBackupOnStartup: true,
      autoBackupOnQuit: true,
    });
    expect(await config.token()).toBe('github_pat_secret');
    const stored = fs.readFileSync(config.configFilePath, 'utf8');
    expect(stored).not.toContain('github_pat_secret');
    expect(config.status('ready')).toMatchObject({ configured: true, tokenConfigured: true });
  });

  it('uploads one JSON file through the GitHub contents API and removes the pending outbox', async () => {
    const context = createDatabase();
    const sourceId = insertSource(context.database, 'source');
    insertFilm(context.database, sourceId, 'movie.mkv', 123, 45);
    const config = new CloudBackupConfigService(
      path.join(context.root, 'cloud-config.json'),
      path.join(context.root, 'cloud-pending.json'),
      fakeSecrets,
    );
    await config.update({
      repositoryUrl: 'owner/private-repo',
      branch: 'main',
      token: 'github_pat_secret',
      autoBackupOnStartup: true,
      autoBackupOnQuit: true,
    });
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    let uploadedContent = '';
    const fetcher = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      requests.push({ url, init });
      if (url.endsWith('/repos/owner/private-repo')) return jsonResponse({ private: true, default_branch: 'main' });
      if (url.includes('/commits?')) return jsonResponse([{
        sha: 'abcdef1234567890',
        commit: { message: 'Backup library data', author: { date: '2026-08-25T00:00:00.000Z' } },
      }]);
      if (url.includes('/contents/library-backup.json?')) {
        return uploadedContent
          ? jsonResponse({ sha: 'blob-sha', encoding: 'base64', content: uploadedContent })
          : jsonResponse({ message: 'Not Found' }, 404);
      }
      if (url.endsWith('/contents/library-backup.json') && init?.method === 'PUT') {
        uploadedContent = (JSON.parse(String(init.body)) as { content: string }).content;
        return jsonResponse({ content: { sha: 'blob' }, commit: { sha: 'abcdef1234567890' } }, 201);
      }
      return jsonResponse({}, 500);
    };
    const service = new CloudBackupService(
      config,
      new LibraryDataBackupService(context.database, '1.0.0'),
      new AppLogger(path.join(context.root, 'logs')),
      fetcher,
    );
    const activities: string[] = [];
    const stopActivities = service.onActivity((activity) => activities.push(`${activity.trigger}:${activity.phase}`));
    const result = await service.runBackup('manual');
    stopActivities();
    expect(result).toMatchObject({ uploaded: true, skipped: false, commitSha: 'abcdef1234567890' });
    expect(activities).toEqual(['manual:running', 'manual:success']);
    expect(service.status().activity).toMatchObject({ trigger: 'manual', phase: 'success' });
    expect(fs.existsSync(config.pendingFilePath)).toBe(false);
    const upload = requests.find((request) => request.init?.method === 'PUT');
    expect(upload?.init?.headers).toMatchObject({ Authorization: 'Bearer github_pat_secret' });
    const body = JSON.parse(String(upload?.init?.body)) as { content: string };
    const uploaded = JSON.parse(Buffer.from(body.content, 'base64').toString('utf8')) as { films: unknown[] };
    expect(uploaded.films).toHaveLength(1);
    expect(await service.versions()).toEqual([{
      commitSha: 'abcdef1234567890',
      committedAt: '2026-08-25T00:00:00.000Z',
      message: 'Backup library data',
    }]);
    expect(await service.previewRestore('abcdef1234567890')).toMatchObject({ matchedFilms: 1, missingFilms: 0 });
  });
});

const fakeSecrets = {
  async encryptStringAsync(value: string): Promise<Buffer> {
    return Buffer.from(`protected:${Buffer.from(value).toString('base64')}`);
  },
  async decryptStringAsync(value: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }> {
    const encoded = value.toString().replace(/^protected:/, '');
    return { result: Buffer.from(encoded, 'base64').toString(), shouldReEncrypt: false };
  },
};

function createDatabase(): { root: string; database: DatabaseManager } {
  const root = createRoot();
  const database = new DatabaseManager(path.join(root, 'library.db'));
  databases.push(database);
  return { root, database };
}

function createRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'film-cloud-backup-'));
  roots.push(root);
  return root;
}

function insertSource(database: DatabaseManager, name: string): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  database.db.prepare(
    `INSERT INTO media_source (id, name, root_path, enabled, recursive, archived, created_at, updated_at)
     VALUES (?, ?, ?, 1, 1, 0, ?, ?)`,
  ).run(id, name, path.join(path.dirname(database.databasePath), name), now, now);
  return id;
}

function insertFilm(
  database: DatabaseManager,
  sourceId: string,
  filename: string,
  fileSize: number,
  durationSeconds: number | null,
): { filmId: string; partId: string } {
  const filmId = randomUUID();
  const partId = randomUUID();
  const now = new Date().toISOString();
  database.db.prepare(
    `INSERT INTO film (
       id, source_id, relative_path, filename, file_size, title, runtime_seconds,
       country_json, director_json, actors_json, status, favorite, rating, notes,
       nfo_status, missing, archived, imported_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, '[]', '[]', '[]', 'unorganized', 0, 0, '', 'missing', 0, 0, ?, ?)`,
  ).run(filmId, sourceId, filename, filename, fileSize, filename, durationSeconds, now, now);
  database.db.prepare(
    `INSERT INTO film_file (
       id, film_id, source_id, relative_path, filename, part_type, part_number, is_primary,
       file_size, missing, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, 'single', 1, 1, ?, 0, ?, ?)`,
  ).run(partId, filmId, sourceId, filename, filename, fileSize, now, now);
  return { filmId, partId };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
