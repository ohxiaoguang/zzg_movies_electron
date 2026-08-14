import fs from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ApiResult, FilmDetailDto, FilmFilterDataDto, FilmPageDto, LanServerInfoDto, PublicMediaSourceDto } from '../src/shared/contracts';
import { DatabaseManager } from '../src/main/database/DatabaseManager';
import { FilmRepository } from '../src/main/database/repositories/FilmRepository';
import { SettingsRepository } from '../src/main/database/repositories/SettingsRepository';
import { SourceRepository } from '../src/main/database/repositories/SourceRepository';
import { LanDeviceRepository } from '../src/main/database/repositories/LanDeviceRepository';
import { ScanCoordinator } from '../src/main/scanner/ScanCoordinator';
import { LanServer } from '../src/main/server/LanServer';
import { FilmLibraryReadService } from '../src/main/services/FilmLibraryReadService';
import { MediaAssetService } from '../src/main/services/MediaAssetService';
import { LanAuthService } from '../src/main/services/LanAuthService';
import { AccountCredentialService } from '../src/main/services/AccountCredentialService';
import { FilmLibraryManagementService } from '../src/main/services/FilmLibraryManagementService';
import { PlaybackSessionService } from '../src/main/services/PlaybackSessionService';
import { MediaCapabilityService } from '../src/main/media/MediaCapabilityService';
import { AppLogger } from '../src/main/system/AppLogger';

const roots: string[] = [];
const databases: DatabaseManager[] = [];
const lanServers: LanServer[] = [];
const plainServers: Server[] = [];

afterEach(async () => {
  for (const server of lanServers.splice(0)) await server.stop();
  for (const server of plainServers.splice(0)) {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const database of databases.splice(0)) database.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('localhost read-only web server', () => {
  it('starts, stops, restarts and only advertises the IPv4 loopback address', async () => {
    const context = await createContext();
    const first = await context.server.start();
    expect(first).toMatchObject({
      state: 'running',
      bindAddress: '127.0.0.1',
      lastErrorCode: null,
    });
    expect(first.baseUrl).toBe(`http://127.0.0.1:${first.port}`);
    expect(await context.server.start()).toEqual(first);

    context.settings.update({ detailPlayerSeekStepSeconds: 12, detailPlayerFineSeekStepSeconds: 0.25 });
    const serverInfo = await api<LanServerInfoDto>(`${first.baseUrl}/api/v1/server-info`);
    expect(serverInfo.ok && serverInfo.data.detailPlayerSeekStepSeconds).toBe(12);
    expect(serverInfo.ok && serverInfo.data.detailPlayerFineSeekStepSeconds).toBe(0.25);

    const health = await api<{ databaseReady: boolean; readOnly: boolean }>(`${first.baseUrl}/api/v1/health`);
    expect(health).toMatchObject({ ok: true, data: { databaseReady: true, readOnly: true } });
    const stopped = await context.server.stop();
    expect(stopped).toMatchObject({ state: 'stopped', bindAddress: '127.0.0.1', baseUrl: null });
    await expect(fetch(`${first.baseUrl}/api/v1/health`)).rejects.toThrow();

    const restarted = await context.server.start();
    expect(restarted.state).toBe('running');
    expect(restarted.bindAddress).toBe('127.0.0.1');
  });

  it('returns the same film DTOs as the shared IPC service and validates API parameters', async () => {
    const context = await createContext();
    const status = await context.server.start();
    const baseUrl = status.baseUrl!;
    const expectedPage = context.library.page({ page: 1, pageSize: 20 });
    const pageResponse = await api<FilmPageDto>(`${baseUrl}/api/v1/films?page=1&pageSize=20`);
    expect(pageResponse).toEqual({ ok: true, data: expectedPage });

    const filmId = expectedPage.items[0]!.id;
    const expectedDetail = context.library.detail(filmId);
    expect(await api<FilmDetailDto>(`${baseUrl}/api/v1/films/${filmId}`)).toEqual({ ok: true, data: expectedDetail });

    const filters = await api<FilmFilterDataDto>(`${baseUrl}/api/v1/filters/counts`);
    expect(filters.ok && filters.data.categories.map((item) => item.name)).toContain('经典');
    expect(filters.ok && filters.data.tags.map((item) => item.name)).toContain('本机测试');
    expect(filters.ok && filters.data.actors).toEqual([{ name: '测试演员', filmCount: 1 }]);
    expect(filters.ok && filters.data.sources[0]).not.toHaveProperty('rootPath');

    const sources = await api<PublicMediaSourceDto[]>(`${baseUrl}/api/v1/sources`);
    expect(sources.ok && sources.data[0]).toMatchObject({ name: 'Web test source', online: true });
    expect(JSON.stringify(sources)).not.toContain(context.root);
    expect(await api(`${baseUrl}/api/v1/genres`)).toEqual({ ok: true, data: [] });
    expect(await api(`${baseUrl}/api/v1/types`)).toEqual({ ok: true, data: [] });

    expect((await fetch(`${baseUrl}/api/v1/films?page=invalid`)).status).toBe(400);
    expect((await fetch(`${baseUrl}/api/v1/films?pageSize=201`)).status).toBe(400);
    expect((await fetch(`${baseUrl}/api/v1/films?path=C%3A%5Csecret`)).status).toBe(400);
    expect((await fetch(`${baseUrl}/api/v1/films/not-a-uuid`)).status).toBe(400);
    expect((await fetch(`${baseUrl}/api/v1/films`, { method: 'POST' })).status).toBe(405);
  });

  it('serves indexed posters and images with GET/HEAD without accepting a disk path', async () => {
    const context = await createContext();
    const baseUrl = (await context.server.start()).baseUrl!;
    const film = context.library.page({ page: 1, pageSize: 20 }).items[0]!;
    expect(film.posterAssetId).not.toBeNull();
    const assetUrl = `${baseUrl}/media/v1/assets/${film.posterAssetId}`;

    const image = await fetch(assetUrl);
    expect(image.status).toBe(200);
    expect(image.headers.get('content-type')).toBe('image/jpeg');
    expect(await image.text()).toBe('poster-image');

    const head = await fetch(assetUrl, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe(String('poster-image'.length));
    expect(await head.text()).toBe('');

    const range = await fetch(assetUrl, { headers: { Range: 'bytes=0-5' } });
    expect(range.status).toBe(206);
    expect(range.headers.get('content-range')).toBe(`bytes 0-5/${'poster-image'.length}`);
    expect(await range.text()).toBe('poster');

    const poster = await fetch(`${baseUrl}/media/v1/posters/${film.id}`);
    expect(poster.status).toBe(200);
    expect(await poster.text()).toBe('poster-image');
    const preview = await fetch(`${baseUrl}/media/v1/previews/${film.id}`, {
      headers: { Range: 'bytes=0-6' },
    });
    expect(preview.status).toBe(206);
    expect(preview.headers.get('content-type')).toBe('video/mp4');
    expect(await preview.text()).toBe('preview');
    expect((await fetch(`${assetUrl}?path=${encodeURIComponent(context.root)}`)).status).toBe(400);
    expect((await fetch(`${baseUrl}/media/v1/assets/..%2F..%2Fsecret`)).status).toBe(400);
    const invalid = await fetch(`${baseUrl}/media/v1/assets/not-a-uuid`);
    expect(invalid.status).toBe(400);
    expect(await invalid.text()).not.toContain(context.root);
  });

  it('contains a port collision without closing the shared database or film service', async () => {
    const context = await createContext();
    const occupied = createServer((_request, response) => response.end('occupied'));
    plainServers.push(occupied);
    await new Promise<void>((resolve) => occupied.listen(0, '127.0.0.1', resolve));
    const occupiedPort = (occupied.address() as { port: number }).port;
    const colliding = new LanServer(context.library, context.media, context.logger, {
      port: occupiedPort,
      version: 'test',
      databaseReady: () => context.database.db.open,
    });
    lanServers.push(colliding);

    await expect(colliding.start()).rejects.toMatchObject({ code: 'EADDRINUSE' });
    expect(colliding.status()).toMatchObject({
      state: 'error',
      bindAddress: '127.0.0.1',
      port: occupiedPort,
      baseUrl: null,
      lastErrorCode: 'EADDRINUSE',
    });
    expect(context.database.db.open).toBe(true);
    expect(context.library.page({ page: 1, pageSize: 20 }).total).toBe(1);
  });

  it('serves a CSP-restricted browser client with the desktop-style navigation shell', async () => {
    const context = await createContext();
    const baseUrl = (await context.server.start()).baseUrl!;
    const page = await fetch(baseUrl);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toContain("default-src 'self'");
    const html = await page.text();
    expect(html).toContain('局域网影片库');
    expect(html).toContain('id="app-sidebar"');
    expect(html).toContain('data-library-mode="unorganized"');
    expect(html).toContain('data-library-mode="all-data"');
    expect(html).toContain('来源管理');
    expect(html).toContain('我的分类');
    expect(html).toContain('演员');
    expect(html).toContain('id="settings-view"');
    expect(html).toContain('id="menu-toggle"');
    expect(html).not.toContain('id="delete-selected"');
    expect(html).not.toContain('id="selected-count"');
    expect(html).not.toContain('id="admin-toolbar"');
    expect(html).not.toContain('id="batch-toolbar"');
    expect(html).not.toContain('id="export-csv"');
    expect(html).not.toContain('id="scan-all"');
    expect(html).not.toContain('id="scan-source"');
    expect(html).toContain('<option value="added">最近新增</option>');
    expect(html).toContain('<option value="played">最近观看</option>');
    expect(html).toContain('<script src="/vendor/hls.min.js" defer>');
    expect(html).toContain('<script src="/app.js" defer>');
    const script = await (await fetch(`${baseUrl}/app.js`)).text();
    expect(script).toContain('class HttpFilmLibraryClient');
    expect(script).toContain('/api/v1/films');
    expect(script).toContain("state.libraryMode === 'favorite'");
    expect(script).toContain("state.libraryMode === 'all-data'");
    expect(script).toContain('renderSources()');
    expect(script).toContain('renderCategories()');
    expect(script).toContain('renderActors()');
    expect(script).not.toContain('canSelectRecords()');
    expect(script).not.toContain('film-select');
    expect(script).not.toContain('deleteSelected');
    expect(script).toContain('createDetailHeader');
    expect(script).toContain('createMediaSection');
    expect(script).toContain('createUnifiedPlayback');
    expect(script).not.toContain('createSegmentPreviewPlayer');
    expect(script).not.toContain('createOriginalPlayback');
    expect(script).toContain("actionButton('图片图库'");
    expect(script).toContain("actionButton('精彩片段'");
    expect(script).not.toContain("actionButton('基本信息'");
    expect(script).not.toContain("actionButton('详细信息'");
    expect(script).toContain("createSidebarDisclosure('基本信息'");
    expect(script).toContain("createSidebarDisclosure('详细信息'");
    expect(script).not.toContain('原片播放器');
    expect(script).not.toContain('精彩片段是原片上的时间区间');
    expect(script).toContain("createElement('div', 'player-control-row')");
    expect(script).toContain("actionButton('播放 / 继续原片'");
    expect(script).not.toContain("actionButton('预览视频'");
    expect(script.match(/document\.createElement\('video'\)/g)).toHaveLength(1);
    expect(script).toContain('web-segment-timeline');
    expect(script).toContain('选择或输入新分类，回车添加');
    expect(script).toContain('newCategoryNames: [name]');
    expect(script).toContain('createLocalMetadataSection');
    expect(script).toContain('createNfoSummarySection');
    expect(script).toContain('createFileInfoSection');
    expect(script).toContain('client.rescanSource(source.id)');
    expect(script).not.toContain("client.media('previews'");
    expect(script).toContain('createPlaybackSession');
    expect(script).toContain('attachHls');
    expect(script).toContain('ensureCompletedHlsPlayback');
    expect(script).toContain('转码已完成，正在重新载入播放器');
    expect(script).not.toContain('toggleVideoPlayback');
    expect(script).not.toContain("'player-toggle'");
    expect(script).toContain('applyPlaybackPosition');
    expect(script).toContain('configureSubtitlePicker');
    expect(script).toContain("select.value = supported.length ? String(supported[0].index) : ''");
    expect(script).toContain('track.default = index === 0');
    expect(script).toContain("actionButton('后退'");
    expect(script).toContain("actionButton('前进'");
    expect(script).toContain('createDetailMediaNavigation');
    expect(script).toContain("elements.closeDetail.addEventListener('click', closeFilmDetail)");
    expect(script).toContain("elements.filmDetail.addEventListener('close', stopDetailPlayback)");
    expect(script).toContain("elements.filmDetail.addEventListener('cancel', stopDetailPlayback)");
    expect(script).toContain('function closeFilmDetail()');
    expect(script).toContain('function stopDetailPlayback()');
    expect(script).toContain("elements.detailContent.querySelectorAll('video')");
    expect(script).toContain("backTitle: '上一张'");
    expect(script).toContain("forwardTitle: '下一张'");
    expect(script).toContain("createElement('div', 'gallery-thumbnail-grid')");
    expect(script).toContain("createElement('div', 'gallery-lightbox')");
    expect(script).toContain("event.key === 'ArrowLeft'");
    expect(script).toContain('playback.seek(-configuredSeekStepSeconds())');
    expect(script).toContain('playback.seek(configuredSeekStepSeconds())');
    expect(script).toContain('function configuredSeekStepSeconds()');
    expect(script).toContain('function configuredFineSeekStepSeconds()');
    expect(script).toContain("video.addEventListener('keydown'");
    expect(script).toContain('Promise.all([client.film(id), client.serverInfo()])');
    expect(script).toContain('function seekVideoBy(video, deltaSeconds)');
    expect(script).toContain('video.currentTime = target');
    expect(script).toContain('NVIDIA 全硬件转码（CUDA 解码与缩放）');
    expect(script).toContain('NVIDIA 硬件编码（CPU 解码）');
    expect(script).toContain('仅转换音频（视频直拷）');
    expect(script).toContain('CPU 软件转码');
    expect(script).not.toContain('createManagementPanel');
    expect(script).not.toContain('client.scanAll');
    expect(script).not.toContain('client.rescanFilm');
    expect(script).not.toContain('downloadCsv');
    expect(script).not.toContain('batchUpdate');
    expect(script).not.toContain("actionButton('播放原片'");
    expect(script).not.toContain('detail-header-actions');
    expect(script).not.toContain('function createPlayback(');
    expect(script).not.toContain('window.filmLibrary');
    const hlsResponse = await fetch(`${baseUrl}/vendor/hls.min.js`);
    expect(hlsResponse.status).toBe(200);
    expect(hlsResponse.headers.get('content-type')).toContain('text/javascript');
    const styleResponse = await fetch(`${baseUrl}/styles.css`);
    expect(styleResponse.status).toBe(200);
    expect(styleResponse.headers.get('content-type')).toContain('text/css');
    const styles = fs.readFileSync(path.resolve(process.cwd(), 'src/main/server/web/styles.css'), 'utf8');
    expect(styles).toContain('grid-template-columns: 246px minmax(0, 1fr)');
    expect(styles).toContain('.app-sidebar.is-open');
    expect(styles).toContain('.web-playback video::cue');
    expect(styles).toContain('font-size: 16px');
    expect(styles).toContain('#film-detail { width: 100vw');
    expect(styles).toContain('grid-template-columns: minmax(190px, 1fr) minmax(0, 3fr)');
    expect(styles).toContain('.detail-main-column');
    expect(styles).toContain('grid-template-rows: minmax(0, 1fr) 128px');
    expect(styles).toContain('aspect-ratio: 16 / 9');
    expect(styles).toContain('.detail-header-controls');
    expect(styles).toContain('.detail-media-navigation');
    expect(styles).toContain('.detail-navigation-button');
    expect(styles).toContain('grid-template-columns: minmax(0, 1fr) 82px');
    expect(styles).toContain('.gallery-thumbnail-grid');
    expect(styles).toContain('.gallery-lightbox-stage');
    expect(styles).toContain('.player-control-row');
    expect(styles).toContain('max-height: 100%');
    expect(styles).toContain('@media (max-width: 760px)');
  });

  it('requires the shared account in LAN mode, rotates tokens and supports session revocation', async () => {
    const context = await createContext();
    const accountCredentials = new AccountCredentialService(path.join(context.root, 'account-credentials.json'));
    accountCredentials.setup({ username: 'movie-admin', password: 'correct-horse-42' }, 1);
    const accountAuth = new LanAuthService(
      new LanDeviceRepository(context.database.db),
      context.logger,
      accountCredentials,
    );
    const secured = new LanServer(context.library, context.media, context.logger, {
      version: 'test',
      databaseReady: () => context.database.db.open,
      auth: accountAuth,
      configuration: {
        enabled: true,
        port: 0,
        bindMode: 'lan',
        host: '0.0.0.0',
        requireAuthentication: true,
      },
    });
    lanServers.push(secured);
    const status = await secured.start();
    const baseUrl = `http://127.0.0.1:${status.port}`;
    expect(status).toMatchObject({
      bindMode: 'lan',
      bindAddress: '0.0.0.0',
      authenticationRequired: true,
    });
    expect((await fetch(`${baseUrl}/api/v1/server-info`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/api/v1/films`)).status).toBe(401);
    expect((await fetch(`${baseUrl}/media/v1/originals/${context.filmId}`)).status).toBe(401);

    const pairedResponse = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Film-Library-Request': '1' },
      body: JSON.stringify({ username: 'movie-admin', password: 'correct-horse-42' }),
    });
    expect(pairedResponse.status).toBe(200);
    const paired = await pairedResponse.json() as ApiResult<{ token: string; device: { id: string } }>;
    expect(paired.ok).toBe(true);
    if (!paired.ok) throw new Error('pairing failed');
    const cookie = pairedResponse.headers.get('set-cookie')?.split(';')[0];
    expect(cookie).toMatch(/^film_library_token=/);
    const tokenRow = context.database.db.prepare(
      'SELECT token_hash FROM lan_device WHERE id = ?',
    ).get(paired.data.device.id) as { token_hash: string };
    expect(tokenRow.token_hash).not.toContain(paired.data.token);
    expect(tokenRow.token_hash).toMatch(/^[0-9a-f]{64}$/);

    const authenticatedPage = await fetch(`${baseUrl}/api/v1/films`, {
      headers: { Cookie: cookie! },
    });
    expect(authenticatedPage.status).toBe(200);
    const original = await fetch(`${baseUrl}/media/v1/originals/${context.filmId}`, {
      headers: { Authorization: `Bearer ${paired.data.token}`, Range: 'bytes=0-2' },
    });
    expect(original.status).toBe(206);
    expect(original.headers.get('content-range')).toBe('bytes 0-2/5');
    expect(await original.text()).toBe('vid');

    const refresh = await fetch(`${baseUrl}/api/v1/auth/refresh`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${paired.data.token}`, 'X-Film-Library-Request': '1' },
    });
    const refreshed = await refresh.json() as ApiResult<{ token: string; device: { id: string } }>;
    expect(refreshed.ok).toBe(true);
    if (!refreshed.ok) throw new Error('refresh failed');
    expect(refreshed.data.token).not.toBe(paired.data.token);
    expect((await fetch(`${baseUrl}/api/v1/films`, {
      headers: { Authorization: `Bearer ${paired.data.token}` },
    })).status).toBe(401);
    expect((await fetch(`${baseUrl}/api/v1/films`, {
      headers: { Authorization: `Bearer ${refreshed.data.token}` },
    })).status).toBe(200);

    accountAuth.revokeDevice(refreshed.data.device.id);
    expect((await fetch(`${baseUrl}/api/v1/films`, {
      headers: { Authorization: `Bearer ${refreshed.data.token}` },
    })).status).toBe(401);
  });

  it('allows paired viewers to create isolated direct-play sessions and report progress', async () => {
    const context = await createContext();
    const directPath = path.join(context.root, 'browser-direct.mp4');
    fs.writeFileSync(directPath, 'direct-video-fixture');
    const playbackMedia = {
      resolve: async () => {
        const stat = fs.statSync(directPath);
        return {
          filePath: directPath,
          fileSize: stat.size,
          modifiedAt: stat.mtime,
          contentType: 'video/mp4',
        };
      },
    } as unknown as MediaAssetService;
    const playback = new PlaybackSessionService(
      playbackMedia,
      context.films,
      new MediaCapabilityService(() => ''),
      context.logger,
      path.join(context.root, 'playback-cache'),
    );
    const secured = new LanServer(context.library, context.media, context.logger, {
      version: 'test',
      databaseReady: () => context.database.db.open,
      auth: context.auth,
      playback,
      configuration: {
        enabled: true,
        port: 0,
        bindMode: 'lan',
        host: '0.0.0.0',
        requireAuthentication: true,
      },
    });
    lanServers.push(secured);
    const baseUrl = `http://127.0.0.1:${(await secured.start()).port}`;
    const viewerA = pairDevice(context.auth, 'viewer', 'Playback viewer A');
    const viewerB = pairDevice(context.auth, 'viewer', 'Playback viewer B');

    const csrfRejected = await fetch(`${baseUrl}/api/v1/playback/sessions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${viewerA.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ filmId: context.filmId }),
    });
    expect(csrfRejected.status).toBe(403);

    const createdResponse = await fetch(`${baseUrl}/api/v1/playback/sessions`, {
      method: 'POST',
      headers: authHeaders(viewerA.token),
      body: JSON.stringify({ filmId: context.filmId }),
    });
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json() as ApiResult<{ id: string; mode: string; transport: string; url: string }>;
    expect(created).toMatchObject({
      ok: true,
      data: {
        mode: 'direct',
        transport: 'direct',
        url: `/media/v1/originals/${context.filmId}`,
      },
    });
    if (!created.ok) throw new Error('playback session failed');

    expect((await fetch(`${baseUrl}/api/v1/playback/sessions/${created.data.id}`, {
      headers: { Authorization: `Bearer ${viewerB.token}` },
    })).status).toBe(404);
    const progress = await api<{ playbackPositionSeconds: number }>(
      `${baseUrl}/api/v1/playback/sessions/${created.data.id}/progress`,
      {
        method: 'PATCH',
        headers: authHeaders(viewerA.token),
        body: JSON.stringify({ positionSeconds: 8.5, durationSeconds: 60 }),
      },
    );
    expect(progress).toMatchObject({ ok: true, data: { playbackPositionSeconds: 8.5 } });
    expect((await fetch(`${baseUrl}/api/v1/playback/sessions/${created.data.id}`, {
      method: 'DELETE',
      headers: authHeaders(viewerA.token),
    })).status).toBe(200);

    const resumedResponse = await fetch(`${baseUrl}/api/v1/playback/sessions`, {
      method: 'POST',
      headers: authHeaders(viewerA.token),
      body: JSON.stringify({ filmId: context.filmId }),
    });
    const resumed = await resumedResponse.json() as ApiResult<{ id: string; playbackPositionSeconds: number }>;
    expect(resumed).toMatchObject({ ok: true, data: { playbackPositionSeconds: 8.5 } });
    if (resumed.ok) {
      expect((await fetch(`${baseUrl}/api/v1/playback/sessions/${resumed.data.id}`, {
        method: 'DELETE',
        headers: authHeaders(viewerA.token),
      })).status).toBe(200);
    }
  });

  it('isolates viewer/admin permissions and protects web writes with CSRF and confirmations', async () => {
    const context = await createContext();
    const secured = new LanServer(context.library, context.media, context.logger, {
      version: 'test',
      databaseReady: () => context.database.db.open,
      auth: context.auth,
      management: context.management,
      configuration: {
        enabled: true,
        port: 0,
        bindMode: 'lan',
        host: '0.0.0.0',
        requireAuthentication: true,
      },
    });
    lanServers.push(secured);
    const status = await secured.start();
    const baseUrl = `http://127.0.0.1:${status.port}`;

    const viewer = pairDevice(context.auth, 'viewer', 'Viewer');
    const admin = pairDevice(context.auth, 'admin', 'Admin');
    const viewerHeaders = authHeaders(viewer.token);
    const adminHeaders = authHeaders(admin.token);
    const nfoPath = path.join(context.root, 'Web Movie.nfo');
    const nfoBefore = fs.readFileSync(nfoPath, 'utf8');

    const me = await api<{ canManage: boolean; device: { role: string } }>(`${baseUrl}/api/v1/auth/me`, {
      headers: { Authorization: `Bearer ${admin.token}` },
    });
    expect(me).toMatchObject({ ok: true, data: { canManage: true, device: { role: 'admin' } } });

    const viewerWrite = await fetch(`${baseUrl}/api/v1/films/${context.filmId}/favorite`, {
      method: 'PATCH',
      headers: viewerHeaders,
      body: JSON.stringify({ favorite: true }),
    });
    expect(viewerWrite.status).toBe(403);
    expect(await viewerWrite.json()).toMatchObject({ error: { code: 'ADMIN_REQUIRED' } });

    const csrfRejected = await fetch(`${baseUrl}/api/v1/films/${context.filmId}/favorite`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${admin.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ favorite: true }),
    });
    expect(csrfRejected.status).toBe(403);
    expect(await csrfRejected.json()).toMatchObject({ error: { code: 'CSRF_CHECK_FAILED' } });

    const favorite = await api<FilmDetailDto>(`${baseUrl}/api/v1/films/${context.filmId}/favorite`, {
      method: 'PATCH',
      headers: adminHeaders,
      body: JSON.stringify({ favorite: true }),
    });
    expect(favorite.ok && favorite.data.favorite).toBe(true);

    const categoryResponse = await api<{ id: string; name: string }>(`${baseUrl}/api/v1/categories`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ name: 'Web 管理' }),
    });
    expect(categoryResponse.ok).toBe(true);
    if (!categoryResponse.ok) throw new Error('category creation failed');
    const category = categoryResponse.data;
    const taxonomy = await api<FilmDetailDto>(`${baseUrl}/api/v1/films/${context.filmId}/taxonomy`, {
      method: 'PATCH',
      headers: adminHeaders,
      body: JSON.stringify({
        tagNames: ['管理员标签'],
        genreNames: ['剧情'],
        categoryIds: [category.id],
      }),
    });
    expect(taxonomy.ok && taxonomy.data.nfoTags.map((item) => item.name)).toEqual(['管理员标签']);
    expect(taxonomy.ok && taxonomy.data.genres.map((item) => item.name)).toEqual(['剧情']);
    const genreId = taxonomy.ok ? taxonomy.data.genres[0]!.id : '';
    const genrePage = await api<FilmPageDto>(`${baseUrl}/api/v1/films?page=1&pageSize=20&genreIds=${genreId}`, {
      headers: { Authorization: `Bearer ${admin.token}` },
    });
    expect(genrePage.ok && genrePage.data.total).toBe(1);

    const batch = await api<FilmDetailDto[]>(`${baseUrl}/api/v1/films/batch`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        ids: [context.filmId],
        favorite: false,
        tagNames: ['批量标签'],
        genreNames: ['剧情'],
        categoryIds: [category.id],
      }),
    });
    expect(batch.ok && batch.data[0]?.favorite).toBe(false);
    expect(batch.ok && batch.data[0]?.nfoTags.map((item) => item.name)).toEqual(['批量标签']);

    await api(`${baseUrl}/api/v1/films/${context.filmId}/metadata`, {
      method: 'PATCH',
      headers: adminHeaders,
      body: JSON.stringify({ title: '用户保护标题', rating: 8.5, notes: '网页管理备注' }),
    });
    const rescan = await api<{ jobId: string }>(`${baseUrl}/api/v1/films/${context.filmId}/rescan`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${admin.token}`, 'X-Film-Library-Request': '1' },
    });
    expect(rescan.ok).toBe(true);
    await waitForScan(context.scan);
    expect(context.library.detail(context.filmId).title).toBe('用户保护标题');
    expect(context.library.detail(context.filmId).nfoTags.map((item) => item.name)).toEqual(['批量标签']);
    expect(fs.readFileSync(nfoPath, 'utf8')).toBe(nfoBefore);

    const imported = await api<FilmDetailDto>(`${baseUrl}/api/v1/films/${context.filmId}/nfo-import`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ mode: 'supplement' }),
    });
    expect(imported.ok).toBe(true);
    expect(fs.readFileSync(nfoPath, 'utf8')).toBe(nfoBefore);

    const sourceScan = await api<{ jobId: string }>(`${baseUrl}/api/v1/sources/${context.library.detail(context.filmId).sourceId}/rescan`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${admin.token}`, 'X-Film-Library-Request': '1' },
    });
    expect(sourceScan.ok).toBe(true);
    await waitForScan(context.scan);
    const fullScan = await api<{ jobId: string }>(`${baseUrl}/api/v1/scan`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({}),
    });
    expect(fullScan.ok).toBe(true);
    await waitForScan(context.scan);

    const csv = await fetch(`${baseUrl}/api/v1/export/csv`, {
      headers: { Authorization: `Bearer ${admin.token}` },
    });
    expect(csv.status).toBe(404);
    expect(await csv.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });

    const missingConfirmation = await fetch(`${baseUrl}/api/v1/records`, {
      method: 'DELETE',
      headers: adminHeaders,
      body: JSON.stringify({ ids: [context.filmId] }),
    });
    expect(missingConfirmation.status).toBe(409);
    expect(await missingConfirmation.json()).toMatchObject({ error: { code: 'CONFIRMATION_REQUIRED' } });

    const deleted = await api(`${baseUrl}/api/v1/records`, {
      method: 'DELETE',
      headers: adminHeaders,
      body: JSON.stringify({ ids: [context.filmId], confirmation: 'DELETE_RECORDS' }),
    });
    expect(deleted).toEqual({ ok: true, data: null });
    expect(fs.existsSync(path.join(context.root, 'Web Movie.mkv'))).toBe(true);
    expect(fs.readFileSync(nfoPath, 'utf8')).toBe(nfoBefore);
    expect(context.films.detail(context.filmId)).toBeNull();
    expect((await fetch(`${baseUrl}/api/v1/films/${context.filmId}`, {
      headers: { Authorization: `Bearer ${admin.token}` },
    })).status).toBe(404);
  });

  it('rate-limits pairing attempts and rejects untrusted origins in LAN mode', async () => {
    const context = await createContext();
    const pairing = context.auth.createPairingCode();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(() => context.auth.pair(
        { code: pairing.code === '000000' ? '111111' : '000000', deviceName: 'Bad Client' },
        '192.168.1.20',
      )).toThrow('INVALID_PAIRING_CODE');
    }
    expect(() => context.auth.pair(
      { code: pairing.code, deviceName: 'Bad Client' },
      '192.168.1.20',
    )).toThrow('PAIRING_RATE_LIMITED');

    const secured = new LanServer(context.library, context.media, context.logger, {
      version: 'test',
      databaseReady: () => context.database.db.open,
      auth: context.auth,
      configuration: {
        enabled: true,
        port: 0,
        bindMode: 'lan',
        host: '0.0.0.0',
        requireAuthentication: true,
      },
    });
    lanServers.push(secured);
    const status = await secured.start();
    expect((await fetch(`http://127.0.0.1:${status.port}/api/v1/health`, {
      headers: { Origin: 'https://evil.example' },
    })).status).toBe(403);
  });

  it('reconfigures between stopped localhost and authenticated LAN states', async () => {
    const context = await createContext();
    const disabled = new LanServer(context.library, context.media, context.logger, {
      version: 'test',
      databaseReady: () => context.database.db.open,
      auth: context.auth,
      configuration: {
        enabled: false,
        port: 0,
        bindMode: 'localhost',
        host: '',
        requireAuthentication: false,
      },
    });
    lanServers.push(disabled);
    expect(disabled.status()).toMatchObject({ state: 'stopped', enabled: false, bindMode: 'localhost' });
    await expect(disabled.start()).rejects.toThrow('LAN_SERVER_DISABLED');
    const running = await disabled.reconfigure({
      enabled: true,
      port: 0,
      bindMode: 'lan',
      host: '0.0.0.0',
      requireAuthentication: false,
    });
    expect(running).toMatchObject({
      state: 'running',
      enabled: true,
      bindMode: 'lan',
      authenticationRequired: true,
    });
    const stopped = await disabled.reconfigure({
      enabled: false,
      port: 48765,
      bindMode: 'localhost',
      host: '',
      requireAuthentication: false,
    });
    expect(stopped).toMatchObject({ state: 'stopped', enabled: false, bindMode: 'localhost' });
  });
});

async function createContext() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'film-library-web-media-'));
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'film-library-web-data-'));
  roots.push(root, dataRoot);
  fs.writeFileSync(path.join(root, 'Web Movie.mkv'), 'video');
  fs.writeFileSync(path.join(root, 'Web Movie-poster.jpg'), 'poster-image');
  fs.writeFileSync(path.join(root, 'Web Movie-fanart.jpg'), 'fanart-image');
  fs.writeFileSync(path.join(root, 'Web Movie-preview.mp4'), 'preview-video');
  fs.writeFileSync(
    path.join(root, 'Web Movie.nfo'),
    '<movie><title>Web 电影</title><tag>本机测试</tag><actor>测试演员</actor><plot>浏览器详情</plot></movie>',
  );
  const logger = new AppLogger(path.join(dataRoot, 'logs'));
  const database = new DatabaseManager(path.join(dataRoot, 'film-library.db'), logger);
  databases.push(database);
  const sources = new SourceRepository(database.db);
  const films = new FilmRepository(database.db);
  const settings = new SettingsRepository(database.db);
  const devices = new LanDeviceRepository(database.db);
  const auth = new LanAuthService(devices, logger);
  sources.create({ name: 'Web test source', rootPath: root });
  const scan = new ScanCoordinator(database, sources, films, settings, logger);
  scan.start({});
  await waitForScan(scan);
  const film = films.page({ page: 1, pageSize: 20 }).items[0]!;
  const category = films.createCategory('经典');
  films.updateCategories(film.id, [category.id]);
  const library = new FilmLibraryReadService(films, sources, settings);
  const media = new MediaAssetService(films);
  const management = new FilmLibraryManagementService(database, films, sources, library, scan, logger);
  const server = new LanServer(library, media, logger, {
    port: 0,
    version: 'test',
    databaseReady: () => database.db.open,
    detailPlayerSeekStepSeconds: () => settings.get().detailPlayerSeekStepSeconds,
    detailPlayerFineSeekStepSeconds: () => settings.get().detailPlayerFineSeekStepSeconds,
  });
  lanServers.push(server);
  return { root, database, library, media, server, logger, auth, management, scan, films, settings, filmId: film.id };
}

async function waitForScan(scan: ScanCoordinator): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (scan.status()?.status !== 'running') return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('scan timeout');
}

async function api<T = unknown>(url: string, options?: RequestInit): Promise<ApiResult<T>> {
  const response = await fetch(url, options);
  return await response.json() as ApiResult<T>;
}

function pairDevice(auth: LanAuthService, role: 'viewer' | 'admin', name: string) {
  const pairing = auth.createPairingCode(role);
  return auth.pair({ code: pairing.code, deviceName: name }, `192.168.1.${role === 'admin' ? '41' : '40'}`);
}

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'X-Film-Library-Request': '1',
  };
}
