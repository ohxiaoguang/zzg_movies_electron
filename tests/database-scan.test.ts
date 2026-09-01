import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseManager } from '../src/main/database/DatabaseManager';
import { FilmRepository } from '../src/main/database/repositories/FilmRepository';
import { SettingsRepository } from '../src/main/database/repositories/SettingsRepository';
import { SourceRepository } from '../src/main/database/repositories/SourceRepository';
import { ScanCoordinator } from '../src/main/scanner/ScanCoordinator';
import { AppLogger } from '../src/main/system/AppLogger';

const tempRoots: string[] = [];
const databases: DatabaseManager[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixtureRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'film-library-fixture-'));
  tempRoots.push(root);
  fs.mkdirSync(path.join(root, 'extrafanart'));
  fs.mkdirSync(path.join(root, 'comment'));
  fs.writeFileSync(path.join(root, 'Movie A.mkv'), 'small fake media file for tests');
  fs.writeFileSync(path.join(root, 'Movie A.nfo'), '<movie><title>测试电影</title><year>2026</year><genre>科幻</genre><actor>演员</actor></movie>');
  fs.writeFileSync(path.join(root, 'Movie A-poster.jpg'), 'poster');
  fs.writeFileSync(path.join(root, 'Movie A-fanart.jpg'), 'fanart');
  fs.writeFileSync(path.join(root, 'Movie A-preview.mp4'), 'preview');
  fs.writeFileSync(path.join(root, 'extrafanart', '2.jpg'), 'two');
  fs.writeFileSync(path.join(root, 'extrafanart', '10.jpg'), 'ten');
  fs.writeFileSync(path.join(root, 'comment', '1.jpg'), 'comment one');
  fs.writeFileSync(path.join(root, 'comment', '2.png'), 'comment two');
  fs.writeFileSync(path.join(root, 'ignored.llc'), 'ignore');
  return root;
}

async function waitForScan(scan: ScanCoordinator): Promise<NonNullable<ReturnType<ScanCoordinator['status']>>> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const status = scan.status();
    if (status && status.status !== 'running') return status;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('scan timeout');
}

function createContext(root: string) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'film-library-db-'));
  tempRoots.push(temp);
  const logger = new AppLogger(path.join(temp, 'logs'));
  const database = new DatabaseManager(path.join(temp, 'film-library.db'), logger);
  databases.push(database);
  const sources = new SourceRepository(database.db);
  const films = new FilmRepository(database.db);
  const settings = new SettingsRepository(database.db);
  const source = sources.create({ name: '测试来源', rootPath: root });
  const scan = new ScanCoordinator(database, sources, films, settings, logger);
  return { database, sources, films, settings, source, scan };
}

describe('SQLite migrations and scanning', () => {
  it('creates migrated tables, scans NFO/assets, and supports paging', async () => {
    const root = fixtureRoot();
    const context = createContext(root);
    expect(context.database.db.pragma('user_version', { simple: true })).toBe(14);
    expect(context.database.hasTable('film_segment')).toBe(true);
    expect(context.database.hasTable('film_playback_state')).toBe(true);
    expect(context.database.hasTable('lan_device')).toBe(true);
    expect(context.database.db.pragma('table_info(lan_device)')).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'role', dflt_value: "'viewer'" })]),
    );
    expect(context.database.db.prepare('SELECT name FROM sqlite_master WHERE type = \'table\' AND name = \'film_file\'').get()).toBeTruthy();
    expect(context.database.db.pragma('table_info(film_file)')).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'is_vr', dflt_value: '0' })]),
    );
    const start = context.scan.start({});
    expect(start.jobId).toMatch(/[0-9a-f-]{36}/);
    const status = await waitForScan(context.scan);
    expect(status.status).toBe('completed');
    const page = context.films.page({ page: 1, pageSize: 60, search: '测试电影' });
    expect(page.total).toBe(1);
    expect(page.items[0].previewAssetId).not.toBeNull();
    expect(page.items[0].allowOriginalPreview).toBe(false);
    expect(page.items[0].previewImageAssetIds).toHaveLength(3);
    expect(page.items[0].commentImageAssetIds).toHaveLength(2);
    expect(page.items[0].commentImageCount).toBe(2);
    expect(context.films.detail(page.items[0].id)?.images.filter((image) => image.assetType === 'comment')).toHaveLength(2);
    expect(context.films.page({ page: 1, pageSize: 60, commentImages: 'with' }).total).toBe(1);
    expect(context.films.page({ page: 1, pageSize: 60, commentImages: 'without' }).total).toBe(0);
    context.sources.update({ id: context.source.id, allowOriginalPreview: true });
    expect(context.films.page({ page: 1, pageSize: 60 }).items[0].allowOriginalPreview).toBe(true);
    expect(context.films.previewLocation(page.items[0].id)?.relativePath).toBe('Movie A-preview.mp4');
    expect(context.database.db.prepare('SELECT COUNT(*) AS count FROM film_genre').get()).toEqual({ count: 0 });

    fs.rmSync(path.join(root, 'comment'), { recursive: true });
    context.scan.start({});
    expect((await waitForScan(context.scan)).status).toBe('completed');
    expect(context.films.page({ page: 1, pageSize: 60 }).items[0].commentImageCount).toBe(0);
    expect(context.films.page({ page: 1, pageSize: 60, commentImages: 'without' }).total).toBe(1);
  });

  it('filters non-native playback records with the same rules as the player', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'film-library-playback-filter-'));
    tempRoots.push(root);
    const fixtures = [
      { name: 'Direct MP4.mp4', video: 'h264', audio: 'aac' },
      { name: 'Direct WebM.webm', video: 'vp9', audio: 'opus' },
      { name: 'Remux MKV.mkv', video: 'h264', audio: 'aac' },
      { name: 'Transcode HEVC.mp4', video: 'hevc', audio: 'aac' },
    ];
    for (const fixture of fixtures) {
      const stem = path.parse(fixture.name).name;
      fs.writeFileSync(path.join(root, fixture.name), 'media');
      fs.writeFileSync(
        path.join(root, `${stem}.nfo`),
        `<movie><title>${stem}</title><fileinfo><streamdetails><video><codec>${fixture.video}</codec></video><audio><codec>${fixture.audio}</codec></audio></streamdetails></fileinfo></movie>`,
      );
    }
    const context = createContext(root);
    context.scan.start({});
    expect((await waitForScan(context.scan)).status).toBe('completed');

    const filtered = context.films.page({
      page: 1,
      pageSize: 20,
      allData: true,
      playbackCompatibility: 'non-native',
      sort: 'file',
    });
    expect(filtered.total).toBe(2);
    expect(filtered.items.map((film) => film.filename)).toEqual(['Remux MKV.mkv', 'Transcode HEVC.mp4']);
  });

  it('is idempotent, preserves user fields, and treats a renamed file as a new film', async () => {
    const root = fixtureRoot();
    const context = createContext(root);
    context.scan.start({});
    await waitForScan(context.scan);
    const first = context.films.page({ page: 1, pageSize: 60 });
    const film = first.items[0];
    context.films.update({ id: film.id, title: '用户标题', rating: 8.5, notes: '用户备注' });
    context.films.updateFavorite(film.id, true);
    context.scan.start({});
    const secondStatus = await waitForScan(context.scan);
    expect(secondStatus.status).toBe('completed');
    expect(context.films.page({ page: 1, pageSize: 60 }).total).toBe(1);
    expect(context.films.detail(film.id)?.title).toBe('用户标题');
    expect(context.films.detail(film.id)?.favorite).toBe(true);
    fs.renameSync(path.join(root, 'Movie A.mkv'), path.join(root, 'Renamed Movie.mkv'));
    context.scan.start({});
    const renamedStatus = await waitForScan(context.scan);
    expect(renamedStatus.moved).toBe(0);
    expect(renamedStatus.created).toBe(1);
    const available = context.films.page({ page: 1, pageSize: 60 });
    expect(available.items[0].filename).toBe('Renamed Movie.mkv');
    expect(available.items[0].title).toBe('Renamed Movie');
    expect(available.items[0].id).not.toBe(film.id);
    const allRecords = context.films.page({ page: 1, pageSize: 60, allData: true });
    expect(allRecords.total).toBe(2);
    expect(allRecords.items.find((item) => item.id === film.id)?.availability).toBe('missing');
    expect(context.films.detail(film.id)?.title).toBe('用户标题');
  });

  it('keeps identical videos with different filenames as separate films', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'film-library-identical-videos-'));
    tempRoots.push(root);
    const identicalContent = Buffer.alloc(180_000, 7);
    fs.writeFileSync(path.join(root, 'Twin-A.mp4'), identicalContent);
    fs.writeFileSync(path.join(root, 'Twin_A.mp4'), identicalContent);
    const context = createContext(root);

    context.scan.start({});
    expect((await waitForScan(context.scan)).status).toBe('completed');

    const page = context.films.page({ page: 1, pageSize: 20, sort: 'file' });
    expect(page.total).toBe(2);
    expect(page.items.map((film) => film.filename).sort()).toEqual(['Twin-A.mp4', 'Twin_A.mp4'].sort());
    expect(page.items.every((film) => context.films.detail(film.id)?.parts.length === 1)).toBe(true);
    expect(context.database.db.prepare('SELECT COUNT(*) AS count FROM film_file WHERE fingerprint IS NOT NULL').get()).toEqual({ count: 0 });
  });

  it('repairs an automatic no-NFO title on rescan but preserves a manually edited title', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'film-library-title-repair-'));
    tempRoots.push(root);
    fs.writeFileSync(path.join(root, 'Current Filename.mp4'), 'media');
    const context = createContext(root);
    context.scan.start({});
    await waitForScan(context.scan);
    const film = context.films.page({ page: 1, pageSize: 20 }).items[0]!;

    context.database.db.prepare('UPDATE film SET title = ?, sort_title = ?, title_user_edited = 0 WHERE id = ?')
      .run('Previously Misassociated Name', 'Previously Misassociated Name', film.id);
    const mismatches = context.films.page({ page: 1, pageSize: 20, allData: true, recordIssue: 'title-mismatch' });
    expect(mismatches.total).toBe(1);
    expect(mismatches.items[0]?.id).toBe(film.id);
    context.scan.start({});
    await waitForScan(context.scan);
    expect(context.films.detail(film.id)?.title).toBe('Current Filename');
    expect(context.films.page({ page: 1, pageSize: 20, allData: true, recordIssue: 'title-mismatch' }).total).toBe(0);

    context.films.update({ id: film.id, title: 'My Local Title' });
    expect(context.database.db.prepare('SELECT title_user_edited FROM film WHERE id = ?').get(film.id)).toEqual({ title_user_edited: 1 });
    expect(context.films.page({ page: 1, pageSize: 20, allData: true, recordIssue: 'title-mismatch' }).total).toBe(0);
    context.scan.start({});
    await waitForScan(context.scan);
    expect(context.films.detail(film.id)?.title).toBe('My Local Title');
  });

  it('keeps newly added, recently updated, and recently played orders distinct', async () => {
    const root = fixtureRoot();
    const context = createContext(root);
    context.scan.start({});
    await waitForScan(context.scan);
    const original = context.films.page({ page: 1, pageSize: 60, sort: 'recent' }).items[0]!;
    const originalUpdatedAt = original.updatedAt;

    await new Promise((resolve) => setTimeout(resolve, 5));
    fs.writeFileSync(path.join(root, 'Newest Movie.mpg'), 'legacy MPEG media fixture');
    context.scan.start({});
    expect((await waitForScan(context.scan)).status).toBe('completed');

    const added = context.films.page({ page: 1, pageSize: 60, sort: 'added' });
    expect(added.items.map((film) => film.filename)).toEqual(['Newest Movie.mpg', 'Movie A.mkv']);
    expect(context.films.page({ page: 1, pageSize: 60 }).items.map((film) => film.filename))
      .toEqual(['Newest Movie.mpg', 'Movie A.mkv']);
    expect(added.items.find((film) => film.id === original.id)?.updatedAt).toBe(originalUpdatedAt);

    context.films.update({ id: original.id, notes: 'updated after the new import' });
    expect(context.films.page({ page: 1, pageSize: 60, sort: 'recent' }).items[0]?.id).toBe(original.id);
    expect(context.films.page({ page: 1, pageSize: 60, sort: 'added' }).items[0]?.filename).toBe('Newest Movie.mpg');

    context.films.markPlayed(original.id, '2030-01-01T00:00:00.000Z');
    expect(context.films.page({ page: 1, pageSize: 60, sort: 'played' }).items[0]?.id).toBe(original.id);
  });

  it('persists exact playback progress and isolates it between film and part playback', async () => {
    const root = fixtureRoot();
    const context = createContext(root);
    context.scan.start({});
    await waitForScan(context.scan);
    const film = context.films.page({ page: 1, pageSize: 20 }).items[0]!;
    const partId = context.films.detail(film.id)?.parts[0]?.id;
    expect(partId).toBeTruthy();

    context.films.updatePlaybackProgress(film.id, partId!, 42.5, 100, '2030-01-02T03:04:05.000Z');
    expect(context.films.playbackState(film.id, partId!)).toMatchObject({
      lastPartId: partId,
      positionSeconds: 42.5,
      durationSeconds: 100,
      lastPlayedAt: '2030-01-02T03:04:05.000Z',
    });
    expect(context.films.playbackState(film.id, null)).toMatchObject({
      positionSeconds: 0,
      durationSeconds: null,
    });

    const databasePath = context.database.databasePath;
    context.database.close();
    databases.splice(databases.indexOf(context.database), 1);
    const reopened = new DatabaseManager(databasePath);
    databases.push(reopened);
    expect(new FilmRepository(reopened.db).playbackState(film.id, partId!)).toMatchObject({
      positionSeconds: 42.5,
      durationSeconds: 100,
    });
  });

  it('adds MPG and MPEG to an unchanged legacy default extension setting', () => {
    const root = fixtureRoot();
    const context = createContext(root);
    context.database.db.prepare("UPDATE app_setting SET value_json = ? WHERE key = 'videoExtensions'")
      .run(JSON.stringify(['mp4', 'mkv', 'mov', 'avi', 'webm', 'm4v', 'ts', 'flv', 'wmv']));

    const upgraded = new SettingsRepository(context.database.db).get().videoExtensions;
    expect(upgraded).toContain('mpg');
    expect(upgraded).toContain('mpeg');
  });

  it('does not mark films missing when the source is offline', async () => {
    const root = fixtureRoot();
    const context = createContext(root);
    context.scan.start({});
    await waitForScan(context.scan);
    const offlineRoot = root + '-offline';
    fs.renameSync(root, offlineRoot);
    context.scan.start({});
    const status = await waitForScan(context.scan);
    expect(status.status).toBe('completed');
    expect(status.message).toContain('离线');
    expect(context.films.page({ page: 1, pageSize: 60 }).items[0].missing).toBe(false);
    fs.renameSync(offlineRoot, root);
  });

  it('stores bare same-name JPG posters for films sharing one directory', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'film-library-multi-film-posters-'));
    tempRoots.push(root);
    for (const title of ['Alpha', 'Beta']) {
      fs.writeFileSync(path.join(root, `${title}.mkv`), `${title} media`);
      fs.writeFileSync(path.join(root, `${title}.jpg`), `${title} poster`);
    }
    const context = createContext(root);
    context.scan.start({});
    expect((await waitForScan(context.scan)).status).toBe('completed');

    for (const title of ['Alpha', 'Beta']) {
      const film = context.films.page({ page: 1, pageSize: 10, search: title }).items[0]!;
      expect(film.posterAssetId).not.toBeNull();
      expect(film.allowOriginalPreview).toBe(false);
      expect(context.films.previewLocation(film.id)).toBeNull();
      const poster = context.films.detail(film.id)?.assets.find((asset) => asset.assetType === 'poster');
      expect(poster?.relativePath).toBe(`${title}.jpg`);
    }

    const updatedSource = context.sources.update({ id: context.source.id, allowOriginalPreview: true });
    expect(updatedSource.allowOriginalPreview).toBe(true);
    const alpha = context.films.page({ page: 1, pageSize: 10, search: 'Alpha' }).items[0]!;
    expect(alpha.allowOriginalPreview).toBe(true);
    expect(context.films.previewLocation(alpha.id)).toEqual({ rootPath: root, relativePath: 'Alpha.mkv' });
  });

  it('rescans only one film directory and scopes missing markers to that directory', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'film-library-directory-rescan-'));
    tempRoots.push(root);
    for (const directory of ['Film A', 'Film B']) {
      fs.mkdirSync(path.join(root, directory));
      fs.writeFileSync(path.join(root, directory, `${directory}.mkv`), directory);
      fs.writeFileSync(path.join(root, directory, `${directory}.nfo`), `<movie><title>${directory}</title><tag>${directory} old tag</tag></movie>`);
    }
    const context = createContext(root);
    context.scan.start({});
    await waitForScan(context.scan);
    const filmA = context.films.page({ page: 1, pageSize: 20, search: 'Film A' }).items[0]!;
    const filmB = context.films.page({ page: 1, pageSize: 20, search: 'Film B' }).items[0]!;

    fs.writeFileSync(path.join(root, 'Film A', 'Film A.nfo'), '<movie><title>Film A refreshed</title><tag>Film A refreshed tag</tag></movie>');
    fs.writeFileSync(path.join(root, 'Film B', 'Film B.nfo'), '<movie><title>Film B not refreshed</title><tag>Film B not refreshed tag</tag></movie>');
    context.scan.startDirectory(context.source.id, 'Film A');
    expect((await waitForScan(context.scan)).status).toBe('completed');
    expect(context.films.detail(filmA.id)?.nfoTags.map((tag) => tag.name)).toEqual(['Film A refreshed tag']);
    expect(context.films.detail(filmB.id)?.nfoTags.map((tag) => tag.name)).toEqual(['Film B old tag']);

    fs.unlinkSync(path.join(root, 'Film A', 'Film A.mkv'));
    fs.unlinkSync(path.join(root, 'Film B', 'Film B.mkv'));
    context.scan.startDirectory(context.source.id, 'Film A');
    const missingStatus = await waitForScan(context.scan);
    expect(missingStatus.missing).toBe(1);
    expect(context.films.detail(filmA.id)?.missing).toBe(true);
    expect(context.films.detail(filmB.id)?.missing).toBe(false);
    expect(() => context.scan.startDirectory(context.source.id, '../outside')).toThrow('MEDIA_PATH_OUTSIDE_SOURCE');
  });

  it('archives a source without touching external files', () => {
    const root = fixtureRoot();
    const context = createContext(root);
    const before = fs.readFileSync(path.join(root, 'Movie A.mkv'), 'utf8');
    context.database.transaction(() => context.sources.remove({ id: context.source.id, mode: 'keep-records' }));
    expect(fs.readFileSync(path.join(root, 'Movie A.mkv'), 'utf8')).toBe(before);
    expect(context.sources.findById(context.source.id)?.deletedAt).not.toBeNull();
    expect(context.sources.list()).toHaveLength(0);
  });
});
