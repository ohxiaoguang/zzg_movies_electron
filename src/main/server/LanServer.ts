import fs from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type {
  ApiResult,
  LanAuthStatusDto,
  LanPairedDeviceDto,
  LanPairResultDto,
  LanServerBindMode,
  LanServerInfoDto,
  LanServerStatusDto,
  SettingsDto,
  WebHealthDto,
} from '../../shared/contracts';
import { isRecord } from '../../shared/validation';
import {
  validateCategoryCreate,
  validateCategoryRemove,
  validateCategoryRename,
  validateConfirmedRecordDelete,
  validateFilmBatchUpdate,
  validateFilmFavoriteUpdate,
  validateFilmNfoImport,
  validateFilmTaxonomyUpdate,
  validateFilmUpdate,
  validateScanStart,
} from '../../shared/filmManagementValidation';
import { validatePlaybackProgress, validatePlaybackSessionCreate } from '../../shared/playbackValidation';
import type { AppLogger } from '../system/AppLogger';
import type { FilmLibraryReadService } from '../services/FilmLibraryReadService';
import type { FilmLibraryManagementService } from '../services/FilmLibraryManagementService';
import type { MediaAssetKind, MediaAssetService, ResolvedMediaAsset } from '../services/MediaAssetService';
import type { PlaybackSessionService } from '../services/PlaybackSessionService';
import {
  authenticationCookie,
  clearAuthenticationCookie,
  tokenFromRequestHeaders,
  type LanAuthService,
} from '../services/LanAuthService';
import { parseRangeHeader } from '../media/RangeResponse';
import {
  ALL_IPV4_INTERFACES,
  isPrivateClientAddress,
  isTrustedHttpHost,
  isTrustedHttpOrigin,
  LOCALHOST_ADDRESS,
  resolveBindAddress,
  serverBaseUrls,
} from './NetworkScope';
import webIndex from './web/index.html?raw';
import webScript from './web/app.js?raw';
import webStyles from './web/styles.css?raw';
import hlsScript from 'hls.js/dist/hls.min.js?raw';

export const LAN_SERVER_HOST = LOCALHOST_ADDRESS;
export const DEFAULT_LAN_SERVER_PORT = 48765;

export interface LanServerConfiguration {
  enabled: boolean;
  port: number;
  bindMode: LanServerBindMode;
  host: string;
  requireAuthentication: boolean;
}

export function lanServerConfigurationFromSettings(settings: SettingsDto): LanServerConfiguration {
  return {
    enabled: settings.lanServerEnabled,
    port: settings.lanServerPort,
    bindMode: settings.lanServerBindMode,
    host: settings.lanServerHost,
    requireAuthentication: settings.lanRequireAuthentication,
  };
}

interface LanServerOptions {
  port?: number;
  version: string;
  databaseReady: () => boolean;
  detailPlayerSeekStepSeconds?: () => number;
  detailPlayerFineSeekStepSeconds?: () => number;
  configuration?: Partial<LanServerConfiguration>;
  auth?: LanAuthService;
  management?: FilmLibraryManagementService;
  playback?: PlaybackSessionService;
}

const FILM_QUERY_KEYS = new Set([
  'page',
  'pageSize',
  'search',
  'sourceId',
  'actor',
  'organizationState',
  'categoryIds',
  'categoryMatch',
  'nfoTagIds',
  'nfoTagMatch',
  'genreIds',
  'genreMatch',
  'minRating',
  'favoriteOnly',
  'missingOnly',
  'recordIssue',
  'allData',
  'availability',
  'sort',
]);

export class LanServer {
  private configuration: LanServerConfiguration;
  private server: Server | null = null;
  private startPromise: Promise<LanServerStatusDto> | null = null;
  private state: LanServerStatusDto['state'] = 'stopped';
  private actualPort: number | null = null;
  private actualBindAddress: string;
  private lastErrorCode: string | null = null;

  public constructor(
    private readonly library: FilmLibraryReadService,
    private readonly media: MediaAssetService,
    private readonly logger: AppLogger,
    private readonly options: LanServerOptions,
  ) {
    this.configuration = normalizeConfiguration({
      enabled: true,
      port: validPort(options.port) ? options.port : DEFAULT_LAN_SERVER_PORT,
      bindMode: 'localhost',
      host: '',
      requireAuthentication: false,
      ...options.configuration,
    });
    this.actualBindAddress = resolveBindAddress(this.configuration.bindMode, this.configuration.host);
  }

  public status(): LanServerStatusDto {
    const port = this.actualPort ?? this.configuration.port;
    const bindAddress = this.actualBindAddress;
    const baseUrls = this.state === 'running'
      ? serverBaseUrls(this.configuration.bindMode, bindAddress, port)
      : [];
    return {
      state: this.state,
      enabled: this.configuration.enabled,
      bindMode: this.configuration.bindMode,
      bindAddress,
      port,
      baseUrl: baseUrls[0] ?? null,
      baseUrls,
      authenticationRequired: this.authenticationRequired(),
      pairedDeviceCount: this.options.auth?.activeDeviceCount() ?? 0,
      lastErrorCode: this.lastErrorCode,
    };
  }

  public currentConfiguration(): LanServerConfiguration {
    return { ...this.configuration };
  }

  public start(): Promise<LanServerStatusDto> {
    if (!this.configuration.enabled) return Promise.reject(new Error('LAN_SERVER_DISABLED'));
    if (this.authenticationRequired() && !this.options.auth) return Promise.reject(new Error('LAN_AUTH_UNAVAILABLE'));
    if (this.state === 'running') return Promise.resolve(this.status());
    if (this.startPromise) return this.startPromise;
    this.state = 'starting';
    this.lastErrorCode = null;
    this.startPromise = this.listen().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  public async reconfigure(configuration: LanServerConfiguration): Promise<LanServerStatusDto> {
    const next = normalizeConfiguration(configuration);
    const unchanged = configurationsEqual(this.configuration, next);
    if (unchanged) {
      if (next.enabled && this.state !== 'running' && this.state !== 'starting') return this.start();
      if (!next.enabled && this.state !== 'stopped') return this.stop();
      return this.status();
    }
    await this.stop();
    this.configuration = next;
    this.actualBindAddress = resolveBindAddress(next.bindMode, next.host);
    this.lastErrorCode = null;
    if (!next.enabled) return this.status();
    return this.start();
  }

  public async stop(): Promise<LanServerStatusDto> {
    if (this.startPromise) {
      try {
        await this.startPromise;
      } catch {
        // A failed start is already contained and reported through status.
      }
    }
    const activeServer = this.server;
    this.server = null;
    this.actualPort = null;
    await this.options.playback?.stop();
    if (activeServer?.listening) {
      await new Promise<void>((resolve) => {
        activeServer.close(() => resolve());
        activeServer.closeIdleConnections?.();
        activeServer.closeAllConnections?.();
      });
    }
    this.state = 'stopped';
    this.logger.info('Local web server stopped', { bindAddress: this.actualBindAddress });
    return this.status();
  }

  private authenticationRequired(): boolean {
    return this.configuration.bindMode === 'lan' || this.configuration.requireAuthentication;
  }

  private async listen(): Promise<LanServerStatusDto> {
    const candidate = createServer((request, response) => {
      void this.handle(request, response).catch((error: unknown) => {
        this.logger.error('Local web request failed', { errorCode: errorCode(error) });
        if (!response.headersSent) this.sendError(response, error);
        else response.destroy();
      });
    });
    const bindAddress = resolveBindAddress(this.configuration.bindMode, this.configuration.host);
    this.actualBindAddress = bindAddress;

    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => reject(error);
        candidate.once('error', onError);
        candidate.listen({ host: bindAddress, port: this.configuration.port, exclusive: true }, () => {
          candidate.removeListener('error', onError);
          resolve();
        });
      });
      candidate.on('error', (error) => {
        this.logger.error('Local web server runtime error', { errorCode: errorCode(error) });
      });
      this.server = candidate;
      this.actualPort = (candidate.address() as AddressInfo).port;
      this.state = 'running';
      this.lastErrorCode = null;
      const status = this.status();
      this.logger.info('Local web server started', {
        bindAddress: status.bindAddress,
        bindMode: status.bindMode,
        port: status.port,
        authenticationRequired: status.authenticationRequired,
        readOnly: !this.options.management,
      });
      return status;
    } catch (error) {
      if (candidate.listening) candidate.close();
      this.server = null;
      this.actualPort = null;
      this.state = 'error';
      this.lastErrorCode = errorCode(error);
      this.logger.error('Local web server failed to start', {
        bindAddress,
        bindMode: this.configuration.bindMode,
        port: this.configuration.port,
        errorCode: this.lastErrorCode,
      });
      const startError = new Error(this.lastErrorCode, { cause: error }) as Error & { code?: string };
      startError.code = this.lastErrorCode;
      throw startError;
    }
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    this.applySecurityHeaders(response);
    if (!this.isAllowedRemote(request.socket.remoteAddress)) {
      this.sendJson(response, 403, failure('NETWORK_SCOPE_DENIED', '请求不在允许的网络范围内'));
      return;
    }
    if (!isTrustedHttpHost(request.headers.host, this.configuration.bindMode)
      || !isTrustedHttpOrigin(request.headers.origin, this.configuration.bindMode)) {
      this.sendJson(response, 403, failure('UNTRUSTED_ORIGIN', '请求来源不受信任'));
      return;
    }

    const url = new URL(request.url ?? '/', `http://${LOCALHOST_ADDRESS}`);
    const method = request.method ?? 'GET';
    let authenticatedDevice: LanPairedDeviceDto | null = null;
    if (url.pathname.startsWith('/api/v1/') || url.pathname.startsWith('/media/v1/')) {
      response.once('finish', () => {
        this.logger.info('LAN HTTP request', {
          method,
          route: auditRoute(url.pathname),
          statusCode: response.statusCode,
          remoteAddress: request.socket.remoteAddress ?? '',
          deviceId: authenticatedDevice?.id ?? null,
          deviceRole: authenticatedDevice?.role ?? null,
        });
      });
    }

    if (url.pathname === '/') return this.sendStatic(response, method, 'text/html; charset=utf-8', webIndex);
    if (url.pathname === '/app.js') return this.sendStatic(response, method, 'text/javascript; charset=utf-8', webScript);
    if (url.pathname === '/styles.css') return this.sendStatic(response, method, 'text/css; charset=utf-8', webStyles);
    if (url.pathname === '/vendor/hls.min.js') return this.sendStatic(response, method, 'text/javascript; charset=utf-8', hlsScript);
    if (url.pathname === '/favicon.ico') {
      response.writeHead(204);
      response.end();
      return;
    }

    if (url.pathname === '/api/v1/auth/login') {
      await this.handleLogin(request, response, url);
      return;
    }
    if (url.pathname === '/api/v1/health' || url.pathname === '/api/v1/server-info' || url.pathname === '/api/v1/auth/status') {
      if (method !== 'GET') return this.methodNotAllowed(response, 'GET');
      this.handlePublicApi(response, url);
      return;
    }

    try {
      authenticatedDevice = this.authenticateRequest(request);
    } catch (error) {
      this.sendError(response, error);
      return;
    }

    if (url.pathname === '/api/v1/auth/me') {
      if (method !== 'GET') return this.methodNotAllowed(response, 'GET');
      this.assertNoQuery(url);
      const authStatus: LanAuthStatusDto = {
        authenticated: authenticatedDevice !== null,
        device: authenticatedDevice,
        canManage: authenticatedDevice?.role === 'admin' && Boolean(this.options.management),
      };
      this.sendJson(response, 200, success(authStatus));
      return;
    }

    if (url.pathname === '/api/v1/auth/refresh' || url.pathname === '/api/v1/auth/revoke' || url.pathname === '/api/v1/auth/logout') {
      await this.handleAuthenticatedAuth(request, response, url);
      return;
    }
    if (url.pathname === '/api/v1/playback/capabilities'
      || url.pathname === '/api/v1/playback/sessions'
      || /^\/api\/v1\/playback\/sessions\/[^/]+(?:\/progress)?$/.test(url.pathname)
      || /^\/media\/v1\/playback\/[^/]+\/[^/]+$/.test(url.pathname)) {
      await this.handlePlayback(request, response, url, authenticatedDevice);
      return;
    }
    if (isManagementRoute(url.pathname, method)) {
      await this.handleManagement(request, response, url, authenticatedDevice);
      return;
    }
    if (method !== 'GET' && method !== 'HEAD') {
      this.methodNotAllowed(response, 'GET, HEAD');
      return;
    }
    if (url.pathname.startsWith('/media/v1/')) {
      await this.handleMedia(request, response, url);
      return;
    }
    if (!url.pathname.startsWith('/api/v1/')) {
      this.sendJson(response, 404, failure('NOT_FOUND', '接口不存在'));
      return;
    }
    if (method !== 'GET') {
      this.methodNotAllowed(response, 'GET');
      return;
    }
    this.handleApi(response, url);
  }

  private isAllowedRemote(address: string | undefined): boolean {
    if (this.configuration.bindMode === 'localhost') {
      return address === LOCALHOST_ADDRESS || address === '::1' || address === `::ffff:${LOCALHOST_ADDRESS}`;
    }
    return isPrivateClientAddress(address);
  }

  private authenticateRequest(request: IncomingMessage): LanPairedDeviceDto | null {
    if (!this.authenticationRequired()) return null;
    const auth = this.options.auth;
    if (!auth) throw new Error('LAN_AUTH_UNAVAILABLE');
    const token = tokenFromRequestHeaders(
      headerValue(request.headers.authorization) ?? undefined,
      headerValue(request.headers.cookie) ?? undefined,
    );
    return auth.authenticate(token);
  }

  private async handleLogin(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    if (request.method !== 'POST') {
      this.methodNotAllowed(response, 'POST');
      return;
    }
    try {
      this.assertMutationRequest(request);
      this.assertNoQuery(url);
      const auth = this.options.auth;
      if (!auth || !this.authenticationRequired()) throw new Error('ACCOUNT_LOGIN_NOT_AVAILABLE');
      const payload = await readJsonObject(request);
      if (typeof payload.username !== 'string' || typeof payload.password !== 'string') throw new Error('INVALID_ACCOUNT_INPUT');
      const result = auth.login(
        { username: payload.username, password: payload.password },
        request.socket.remoteAddress ?? '',
      );
      this.sendJson(response, 200, success(result), {
        'Set-Cookie': authenticationCookie(result.token),
      });
    } catch (error) {
      this.sendError(response, error);
    }
  }

  private async handleAuthenticatedAuth(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    if (request.method !== 'POST') {
      this.methodNotAllowed(response, 'POST');
      return;
    }
    try {
      this.assertMutationRequest(request);
      this.assertNoQuery(url);
      const auth = this.options.auth;
      if (!auth) throw new Error('LAN_AUTH_UNAVAILABLE');
      const token = tokenFromRequestHeaders(
        headerValue(request.headers.authorization) ?? undefined,
        headerValue(request.headers.cookie) ?? undefined,
      );
      if (!token) throw new Error('UNAUTHORIZED');
      if (url.pathname === '/api/v1/auth/refresh') {
        const result: LanPairResultDto = auth.refresh(token);
        this.sendJson(response, 200, success(result), {
          'Set-Cookie': authenticationCookie(result.token),
        });
        return;
      }
      auth.revokeSelf(token);
      this.sendJson(response, 200, success(null), {
        'Set-Cookie': clearAuthenticationCookie(),
      });
    } catch (error) {
      this.sendError(response, error);
    }
  }

  private handlePublicApi(response: ServerResponse, url: URL): void {
    try {
      this.assertNoQuery(url);
      if (url.pathname === '/api/v1/health') {
        const health: WebHealthDto = {
          ok: true,
          service: 'local-film-library',
          version: this.options.version,
          databaseReady: this.options.databaseReady(),
          readOnly: !this.options.management,
        };
        this.sendJson(response, 200, success(health));
        return;
      }
      if (url.pathname === '/api/v1/auth/status') {
        this.sendJson(response, 200, success({ configured: this.options.auth?.accountConfigured() ?? false }));
        return;
      }
      this.sendJson(response, 200, success(this.serverInfo()));
    } catch (error) {
      this.sendError(response, error);
    }
  }

  private handleApi(response: ServerResponse, url: URL): void {
    try {
      if (url.pathname === '/api/v1/films') {
        this.assertQueryKeys(url, FILM_QUERY_KEYS);
        const query = filmQueryFromUrl(url);
        this.sendJson(response, 200, success(this.library.page(query, true)));
        return;
      }
      const filmMatch = url.pathname.match(/^\/api\/v1\/films\/([^/]+)$/);
      if (filmMatch) {
        this.assertNoQuery(url);
        this.sendJson(response, 200, success(this.library.detail(decodeURIComponent(filmMatch[1]))));
        return;
      }
      this.assertNoQuery(url);
      if (url.pathname === '/api/v1/filters/counts') {
        this.sendJson(response, 200, success(this.library.filterData()));
        return;
      }
      if (url.pathname === '/api/v1/categories') {
        this.sendJson(response, 200, success(this.library.listCategories()));
        return;
      }
      if (url.pathname === '/api/v1/tags') {
        this.sendJson(response, 200, success(this.library.listTags()));
        return;
      }
      if (url.pathname === '/api/v1/genres' || url.pathname === '/api/v1/types') {
        this.sendJson(response, 200, success(this.library.listGenres()));
        return;
      }
      if (url.pathname === '/api/v1/actors') {
        this.sendJson(response, 200, success(this.library.listActors()));
        return;
      }
      if (url.pathname === '/api/v1/sources') {
        this.sendJson(response, 200, success(this.library.listPublicSources()));
        return;
      }
      this.sendJson(response, 404, failure('NOT_FOUND', '接口不存在'));
    } catch (error) {
      this.sendError(response, error);
    }
  }

  private async handlePlayback(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    device: LanPairedDeviceDto | null,
  ): Promise<void> {
    try {
      const playback = this.options.playback;
      if (!playback) throw new Error('PLAYBACK_NOT_AVAILABLE');
      const method = request.method ?? 'GET';
      const ownerDeviceId = device?.id ?? null;
      this.assertNoQuery(url);

      if (url.pathname === '/api/v1/playback/capabilities') {
        if (method !== 'GET') return this.methodNotAllowed(response, 'GET');
        this.sendJson(response, 200, success(playback.capability()));
        return;
      }

      if (url.pathname === '/api/v1/playback/sessions') {
        if (method !== 'POST') return this.methodNotAllowed(response, 'POST');
        this.assertMutationRequest(request);
        const session = await playback.create(validatePlaybackSessionCreate(await readJsonObject(request)), ownerDeviceId);
        this.sendJson(response, 201, success(session));
        return;
      }

      const progressMatch = url.pathname.match(/^\/api\/v1\/playback\/sessions\/([^/]+)\/progress$/);
      if (progressMatch) {
        if (method !== 'PATCH') return this.methodNotAllowed(response, 'PATCH');
        this.assertMutationRequest(request);
        const session = playback.updateProgress(
          decodeURIComponent(progressMatch[1]),
          ownerDeviceId,
          validatePlaybackProgress(await readJsonObject(request)),
        );
        this.sendJson(response, 200, success(session));
        return;
      }

      const sessionMatch = url.pathname.match(/^\/api\/v1\/playback\/sessions\/([^/]+)$/);
      if (sessionMatch) {
        const sessionId = decodeURIComponent(sessionMatch[1]);
        if (method === 'GET') {
          this.sendJson(response, 200, success(playback.get(sessionId, ownerDeviceId)));
          return;
        }
        if (method === 'DELETE') {
          this.assertMutationRequest(request);
          playback.cancel(sessionId, ownerDeviceId);
          this.sendJson(response, 200, success(null));
          return;
        }
        return this.methodNotAllowed(response, 'GET, DELETE');
      }

      const mediaMatch = url.pathname.match(/^\/media\/v1\/playback\/([^/]+)\/([^/]+)$/);
      if (mediaMatch) {
        if (method !== 'GET' && method !== 'HEAD') return this.methodNotAllowed(response, 'GET, HEAD');
        const asset = await playback.resolvePlaybackFile(
          decodeURIComponent(mediaMatch[1]),
          decodeURIComponent(mediaMatch[2]),
          ownerDeviceId,
        );
        this.sendMedia(request, response, asset, 'playback');
        return;
      }

      this.sendJson(response, 404, failure('NOT_FOUND', '接口不存在'));
    } catch (error) {
      this.sendError(response, error);
    }
  }

  private async handleManagement(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    device: LanPairedDeviceDto | null,
  ): Promise<void> {
    try {
      if (!device || device.role !== 'admin') throw new Error('ADMIN_REQUIRED');
      const management = this.options.management;
      if (!management) throw new Error('MANAGEMENT_NOT_AVAILABLE');
      const method = request.method ?? 'GET';
      if (method !== 'GET') this.assertMutationRequest(request);

      const favoriteMatch = url.pathname.match(/^\/api\/v1\/films\/([^/]+)\/favorite$/);
      if (favoriteMatch) {
        if (method !== 'PATCH') return this.methodNotAllowed(response, 'PATCH');
        this.assertNoQuery(url);
        const payload = await readJsonObject(request);
        this.sendJson(response, 200, success(management.updateFavorite(validateFilmFavoriteUpdate({
          ...payload,
          id: decodeURIComponent(favoriteMatch[1]),
        }))));
        return;
      }

      const metadataMatch = url.pathname.match(/^\/api\/v1\/films\/([^/]+)\/metadata$/);
      if (metadataMatch) {
        if (method !== 'PATCH') return this.methodNotAllowed(response, 'PATCH');
        this.assertNoQuery(url);
        const payload = await readJsonObject(request);
        this.sendJson(response, 200, success(management.updateFilm(validateFilmUpdate({
          ...payload,
          id: decodeURIComponent(metadataMatch[1]),
        }))));
        return;
      }

      const taxonomyMatch = url.pathname.match(/^\/api\/v1\/films\/([^/]+)\/taxonomy$/);
      if (taxonomyMatch) {
        if (method !== 'PATCH') return this.methodNotAllowed(response, 'PATCH');
        this.assertNoQuery(url);
        const payload = await readJsonObject(request);
        this.sendJson(response, 200, success(management.updateTaxonomy(validateFilmTaxonomyUpdate({
          ...payload,
          id: decodeURIComponent(taxonomyMatch[1]),
        }))));
        return;
      }

      const filmRescanMatch = url.pathname.match(/^\/api\/v1\/films\/([^/]+)\/rescan$/);
      if (filmRescanMatch) {
        if (method !== 'POST') return this.methodNotAllowed(response, 'POST');
        this.assertNoQuery(url);
        this.assertEmptyJsonBody(request);
        this.sendJson(response, 202, success(management.rescanFilm(decodeURIComponent(filmRescanMatch[1]))));
        return;
      }

      const nfoImportMatch = url.pathname.match(/^\/api\/v1\/films\/([^/]+)\/nfo-import$/);
      if (nfoImportMatch) {
        if (method !== 'POST') return this.methodNotAllowed(response, 'POST');
        this.assertNoQuery(url);
        const payload = await readJsonObject(request);
        this.sendJson(response, 200, success(await management.importNfo(validateFilmNfoImport({
          ...payload,
          id: decodeURIComponent(nfoImportMatch[1]),
        }))));
        return;
      }

      const sourceRescanMatch = url.pathname.match(/^\/api\/v1\/sources\/([^/]+)\/rescan$/);
      if (sourceRescanMatch) {
        if (method !== 'POST') return this.methodNotAllowed(response, 'POST');
        this.assertNoQuery(url);
        this.assertEmptyJsonBody(request);
        this.sendJson(response, 202, success(management.rescanSource(decodeURIComponent(sourceRescanMatch[1]))));
        return;
      }
      if (url.pathname === '/api/v1/films/batch') {
        if (method !== 'POST') return this.methodNotAllowed(response, 'POST');
        this.assertNoQuery(url);
        this.sendJson(response, 200, success(management.batchUpdate(validateFilmBatchUpdate(await readJsonObject(request)))));
        return;
      }

      if (url.pathname === '/api/v1/records') {
        if (method !== 'DELETE') return this.methodNotAllowed(response, 'DELETE');
        this.assertNoQuery(url);
        management.deleteRecords(validateConfirmedRecordDelete(await readJsonObject(request)));
        this.sendJson(response, 200, success(null));
        return;
      }

      if (url.pathname === '/api/v1/scan') {
        if (method !== 'POST') return this.methodNotAllowed(response, 'POST');
        this.assertNoQuery(url);
        const payload = await readOptionalJsonObject(request);
        this.sendJson(response, 202, success(management.startScan(validateScanStart(payload))));
        return;
      }

      if (url.pathname === '/api/v1/scan/status') {
        if (method !== 'GET') return this.methodNotAllowed(response, 'GET');
        this.assertNoQuery(url);
        this.sendJson(response, 200, success(management.scanStatus()));
        return;
      }

      if (url.pathname === '/api/v1/categories') {
        if (method !== 'POST') return this.methodNotAllowed(response, 'POST');
        this.assertNoQuery(url);
        this.sendJson(response, 201, success(management.createCategory(validateCategoryCreate(await readJsonObject(request)))));
        return;
      }

      const categoryMatch = url.pathname.match(/^\/api\/v1\/categories\/([^/]+)$/);
      if (categoryMatch) {
        this.assertNoQuery(url);
        const id = decodeURIComponent(categoryMatch[1]);
        if (method === 'PATCH') {
          this.sendJson(response, 200, success(management.renameCategory(validateCategoryRename({
            ...await readJsonObject(request),
            id,
          }))));
          return;
        }
        if (method === 'DELETE') {
          const payload = await readJsonObject(request);
          if (payload.confirmation !== 'DELETE_CATEGORY') throw new Error('CONFIRMATION_REQUIRED');
          management.removeCategory(validateCategoryRemove({ id }));
          this.sendJson(response, 200, success(null));
          return;
        }
        return this.methodNotAllowed(response, 'PATCH, DELETE');
      }

      this.sendJson(response, 404, failure('NOT_FOUND', '接口不存在'));
    } catch (error) {
      this.sendError(response, error);
    }
  }

  private async handleMedia(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    try {
      this.assertNoQuery(url);
      const match = url.pathname.match(/^\/media\/v1\/(assets|images|posters|previews|originals|parts)\/([^/]+)$/);
      if (!match) {
        this.sendJson(response, 404, failure('MEDIA_NOT_FOUND', '媒体不存在'));
        return;
      }
      const collection = match[1];
      const kind: MediaAssetKind = collection === 'posters'
        ? 'poster'
        : collection === 'previews'
          ? 'preview'
          : collection === 'originals'
            ? 'original'
            : collection === 'parts'
              ? 'part'
              : 'asset';
      const abortController = new AbortController();
      request.once('aborted', () => abortController.abort());
      const asset = await this.media.resolve(kind, decodeURIComponent(match[2]), abortController.signal);
      this.sendMedia(request, response, asset, kind);
    } catch (error) {
      this.sendError(response, error);
    }
  }

  private sendMedia(
    request: IncomingMessage,
    response: ServerResponse,
    asset: ResolvedMediaAsset,
    kind: MediaAssetKind | 'playback',
  ): void {
    const parsedRange = parseRangeHeader(headerValue(request.headers.range), asset.fileSize);
    if (!parsedRange.ok) {
      response.writeHead(416, {
        'Accept-Ranges': 'bytes',
        'Content-Range': parsedRange.contentRange,
      });
      response.end();
      return;
    }
    const partial = request.headers.range !== undefined;
    const { start, end } = parsedRange.range;
    const headers: Record<string, string> = {
      'Accept-Ranges': 'bytes',
      'Content-Length': String(end - start + 1),
      'Content-Type': asset.contentType,
      'Cache-Control': kind === 'asset' || kind === 'poster' ? 'private, max-age=300' : 'no-store',
      ETag: `W/"${asset.fileSize}-${Math.floor(asset.modifiedAt.getTime())}"`,
    };
    if (partial) headers['Content-Range'] = `bytes ${start}-${end}/${asset.fileSize}`;
    response.writeHead(partial ? 206 : 200, headers);
    if (request.method === 'HEAD') {
      response.end();
      return;
    }
    const stream = fs.createReadStream(asset.filePath, { start, end });
    const release = (): void => {
      stream.destroy();
    };
    request.once('aborted', release);
    response.once('close', release);
    stream.once('error', () => response.destroy());
    stream.pipe(response);
  }

  private serverInfo(): LanServerInfoDto {
    const status = this.status();
    const fallbackUrl = `http://${status.bindAddress === ALL_IPV4_INTERFACES ? LOCALHOST_ADDRESS : status.bindAddress}:${status.port}`;
    return {
      service: 'local-film-library',
      version: this.options.version,
      apiVersion: 'v1',
      detailPlayerSeekStepSeconds: this.detailPlayerSeekStepSeconds(),
      detailPlayerFineSeekStepSeconds: this.detailPlayerFineSeekStepSeconds(),
      bindAddress: status.bindAddress,
      port: status.port,
      baseUrl: status.baseUrl ?? fallbackUrl,
      baseUrls: status.baseUrls,
      readOnly: !this.options.management,
      managementAvailable: Boolean(this.options.management),
      networkScope: status.bindMode,
      authenticationRequired: status.authenticationRequired,
    };
  }

  private detailPlayerSeekStepSeconds(): number {
    const value = this.options.detailPlayerSeekStepSeconds?.();
    return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 60 ? value : 1;
  }

  private detailPlayerFineSeekStepSeconds(): number {
    const value = this.options.detailPlayerFineSeekStepSeconds?.();
    return typeof value === 'number' && Number.isFinite(value) && value >= 0.01 && value <= 5 ? value : 0.1;
  }

  private assertNoQuery(url: URL): void {
    if ([...url.searchParams.keys()].length > 0) throw new Error('INVALID_QUERY');
  }

  private assertQueryKeys(url: URL, allowed: ReadonlySet<string>): void {
    for (const key of url.searchParams.keys()) {
      if (!allowed.has(key)) throw new Error('INVALID_PAGE_QUERY');
    }
  }

  private assertMutationRequest(request: IncomingMessage): void {
    if (headerValue(request.headers['x-film-library-request']) !== '1') throw new Error('CSRF_CHECK_FAILED');
  }

  private assertEmptyJsonBody(request: IncomingMessage): void {
    const contentLength = Number(headerValue(request.headers['content-length']) ?? '0');
    if (Number.isFinite(contentLength) && contentLength > 0) throw new Error('INVALID_REQUEST_BODY');
  }

  private methodNotAllowed(response: ServerResponse, allow: string): void {
    response.setHeader('Allow', allow);
    this.sendJson(response, 405, failure('METHOD_NOT_ALLOWED', '请求方法不受支持'));
  }

  private sendStatic(response: ServerResponse, method: string, contentType: string, body: string): void {
    if (method !== 'GET' && method !== 'HEAD') {
      this.methodNotAllowed(response, 'GET, HEAD');
      return;
    }
    const content = Buffer.from(body, 'utf8');
    response.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': String(content.length),
      'Cache-Control': 'no-store',
    });
    response.end(method === 'HEAD' ? undefined : content);
  }

  private sendError(response: ServerResponse, error: unknown): void {
    if (response.headersSent) {
      response.destroy();
      return;
    }
    const code = errorCode(error);
    const status = errorStatus(code);
    if (status === 401) response.setHeader('WWW-Authenticate', 'Bearer realm="Local Film Library"');
    if (status === 429) response.setHeader('Retry-After', code === 'PLAYBACK_BUSY' ? '5' : '60');
    if (status >= 500) this.logger.error('Local web route error', { errorCode: code });
    this.sendJson(response, status, failure(code, publicErrorMessage(status, code)));
  }

  private sendJson<T>(
    response: ServerResponse,
    status: number,
    result: ApiResult<T>,
    headers: Record<string, string> = {},
  ): void {
    const body = Buffer.from(JSON.stringify(result), 'utf8');
    response.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': String(body.length),
      'Cache-Control': 'no-store',
      ...headers,
    });
    response.end(body);
  }

  private applySecurityHeaders(response: ServerResponse): void {
    response.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; media-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
  }
}

function filmQueryFromUrl(url: URL): Record<string, unknown> {
  const query: Record<string, unknown> = {};
  for (const key of FILM_QUERY_KEYS) {
    if (key === 'categoryIds' || key === 'nfoTagIds' || key === 'genreIds') {
      const values = url.searchParams.getAll(key).flatMap((value) => value.split(',')).filter(Boolean);
      if (values.length > 0) query[key] = values;
      continue;
    }
    const values = url.searchParams.getAll(key);
    if (values.length > 1) throw new Error('INVALID_PAGE_QUERY');
    if (values.length === 1) query[key] = values[0];
  }
  return query;
}

async function readJsonObject(request: IncomingMessage): Promise<Record<string, unknown>> {
  const contentType = headerValue(request.headers['content-type']);
  if (!contentType?.toLowerCase().startsWith('application/json')) throw new Error('INVALID_REQUEST_BODY');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 64 * 1024) throw new Error('REQUEST_BODY_TOO_LARGE');
    chunks.push(buffer);
  }
  try {
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    if (!isRecord(payload)) throw new Error('INVALID_REQUEST_BODY');
    return payload;
  } catch (error) {
    if (error instanceof Error && error.message === 'INVALID_REQUEST_BODY') throw error;
    throw new Error('INVALID_REQUEST_BODY', { cause: error });
  }
}

async function readOptionalJsonObject(request: IncomingMessage): Promise<Record<string, unknown>> {
  return request.headers['content-type'] ? readJsonObject(request) : {};
}

function success<T>(data: T): ApiResult<T> {
  return { ok: true, data };
}

function failure(code: string, message: string): ApiResult<never> {
  return { ok: false, error: { code, message } };
}

function errorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') return error.code;
  if (error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message)) return error.message;
  return 'HTTP_SERVER_ERROR';
}

function errorStatus(code: string): number {
  if (code === 'UNAUTHORIZED' || code === 'INVALID_ACCOUNT_CREDENTIALS') return 401;
  if (code === 'PAIRING_RATE_LIMITED' || code === 'PLAYBACK_BUSY') return 429;
  if (code === 'MEDIA_PATH_OUTSIDE_SOURCE' || code === 'NETWORK_SCOPE_DENIED' || code === 'UNTRUSTED_ORIGIN'
    || code === 'ADMIN_REQUIRED' || code === 'CSRF_CHECK_FAILED') return 403;
  if (code === 'PAIRING_NOT_AVAILABLE' || code === 'ACCOUNT_LOGIN_NOT_AVAILABLE' || code === 'ACCOUNT_SETUP_REQUIRED'
    || code === 'LAN_SERVER_DISABLED' || code === 'MANAGEMENT_NOT_AVAILABLE'
    || code === 'PLAYBACK_NOT_AVAILABLE' || code === 'PLAYBACK_TOOLS_UNAVAILABLE') return 409;
  if (code.endsWith('_NOT_FOUND') || code === 'FILM_NOT_FOUND') return 404;
  if (code === 'CONFIRMATION_REQUIRED') return 409;
  if (code.startsWith('INVALID_') || code === 'REQUEST_BODY_TOO_LARGE') return 400;
  return 500;
}

function publicErrorMessage(status: number, code: string): string {
  if (code === 'PLAYBACK_BUSY') return '服务器当前的播放处理任务已满，请稍后重试';
  if (code === 'PLAYBACK_TOOLS_UNAVAILABLE') return '服务器未找到可用的 ffmpeg，无法处理该视频格式';
  if (code.startsWith('FFMPEG_') || code.startsWith('PLAYBACK_PREPARATION_')) return '服务器无法准备该视频的兼容播放流';
  if (status === 400) return '请求参数无效';
  if (code === 'INVALID_ACCOUNT_CREDENTIALS') return '账号或密码错误';
  if (code === 'ACCOUNT_SETUP_REQUIRED') return '请先在服务器电脑的客户端中设置账号和密码';
  if (status === 401) return '登录已失效，请重新输入账号和密码';
  if (status === 403) return '请求不在允许的安全范围内';
  if (status === 404) return '请求的资源不存在';
  if (status === 409) return '当前服务状态不允许此操作';
  if (status === 429) return '登录尝试过于频繁，请稍后再试';
  return '服务暂时不可用';
}

function validPort(port: number | undefined): port is number {
  return typeof port === 'number' && Number.isInteger(port) && port >= 0 && port <= 65_535;
}

function normalizeConfiguration(input: LanServerConfiguration): LanServerConfiguration {
  const bindMode: LanServerBindMode = input.bindMode === 'lan' ? 'lan' : 'localhost';
  return {
    enabled: Boolean(input.enabled),
    port: validPort(input.port) ? input.port : DEFAULT_LAN_SERVER_PORT,
    bindMode,
    host: typeof input.host === 'string' ? input.host.trim() : '',
    requireAuthentication: bindMode === 'lan' ? true : Boolean(input.requireAuthentication),
  };
}

function configurationsEqual(left: LanServerConfiguration, right: LanServerConfiguration): boolean {
  return left.enabled === right.enabled
    && left.port === right.port
    && left.bindMode === right.bindMode
    && left.host === right.host
    && left.requireAuthentication === right.requireAuthentication;
}

function headerValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function auditRoute(pathname: string): string {
  return pathname
    .replace(/^\/api\/v1\/films\/[^/]+(\/(?:favorite|metadata|taxonomy|rescan|nfo-import))?$/, '/api/v1/films/:id$1')
    .replace(/^\/api\/v1\/sources\/[^/]+\/rescan$/, '/api/v1/sources/:id/rescan')
    .replace(/^\/api\/v1\/categories\/[^/]+$/, '/api/v1/categories/:id')
    .replace(/^\/api\/v1\/playback\/sessions\/[^/]+(\/progress)?$/, '/api/v1/playback/sessions/:id$1')
    .replace(/^\/media\/v1\/playback\/[^/]+\/[^/]+$/, '/media/v1/playback/:id/:file')
    .replace(/^\/media\/v1\/(assets|images|posters|previews|originals|parts)\/[^/]+$/, '/media/v1/$1/:id');
}

function isManagementRoute(pathname: string, method: string): boolean {
  return pathname === '/api/v1/films/batch'
    || pathname === '/api/v1/records'
    || pathname === '/api/v1/scan'
    || pathname === '/api/v1/scan/status'
    || (pathname === '/api/v1/categories' && method !== 'GET')
    || /^\/api\/v1\/categories\/[^/]+$/.test(pathname)
    || /^\/api\/v1\/films\/[^/]+\/(?:favorite|metadata|taxonomy|rescan|nfo-import)$/.test(pathname)
    || /^\/api\/v1\/sources\/[^/]+\/rescan$/.test(pathname);
}
