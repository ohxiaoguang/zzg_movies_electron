import {
  createHash,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from 'node:crypto';
import type {
  LanPairInput,
  LanDeviceRole,
  LanPairedDeviceDto,
  LanPairingCodeDto,
  LanPairResultDto,
} from '../../shared/contracts';
import type { LanDeviceRepository } from '../database/repositories/LanDeviceRepository';
import type { AppLogger } from '../system/AppLogger';

const PAIRING_TTL_MS = 5 * 60_000;
const PAIRING_RATE_WINDOW_MS = 60_000;
const MAX_PAIRING_ATTEMPTS_PER_WINDOW = 5;
const MAX_PAIRING_SESSION_FAILURES = 10;
const TOKEN_BYTES = 32;

interface PairingSession {
  salt: string;
  codeHash: Buffer;
  expiresAtMs: number;
  failures: number;
  role: LanDeviceRole;
}

interface RateBucket {
  startedAtMs: number;
  attempts: number;
}

export class LanAuthService {
  private pairing: PairingSession | null = null;
  private readonly rateBuckets = new Map<string, RateBucket>();
  private readonly lastTouchedAt = new Map<string, number>();

  public constructor(
    private readonly devices: LanDeviceRepository,
    private readonly logger: AppLogger,
  ) {}

  public createPairingCode(role: LanDeviceRole = 'viewer'): LanPairingCodeDto {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const salt = randomBytes(16).toString('hex');
    const expiresAtMs = Date.now() + PAIRING_TTL_MS;
    this.pairing = {
      salt,
      codeHash: pairingHash(code, salt),
      expiresAtMs,
      failures: 0,
      role,
    };
    this.logger.info('LAN pairing code created', {
      expiresAt: new Date(expiresAtMs).toISOString(),
      role,
    });
    return { code, expiresAt: new Date(expiresAtMs).toISOString(), role };
  }

  public pair(input: LanPairInput, remoteAddress: string): LanPairResultDto {
    this.checkRateLimit(remoteAddress);
    if (!/^\d{6}$/.test(input.code)) throw new Error('INVALID_PAIRING_CODE');
    const session = this.pairing;
    if (!session || session.expiresAtMs <= Date.now()) {
      this.pairing = null;
      throw new Error('PAIRING_CODE_EXPIRED');
    }
    const candidate = pairingHash(input.code, session.salt);
    if (candidate.length !== session.codeHash.length || !timingSafeEqual(candidate, session.codeHash)) {
      session.failures += 1;
      if (session.failures >= MAX_PAIRING_SESSION_FAILURES) this.pairing = null;
      throw new Error('INVALID_PAIRING_CODE');
    }

    this.pairing = null;
    const token = createToken();
    const device = this.devices.create(input.deviceName, tokenHash(token), session.role);
    this.logger.info('LAN device paired', {
      deviceId: device.id,
      deviceName: device.name,
      remoteAddress,
    });
    return { token, device };
  }

  public authenticate(token: string | null): LanPairedDeviceDto {
    if (!token || token.length < 32 || token.length > 256) throw new Error('UNAUTHORIZED');
    const device = this.devices.findActiveByTokenHash(tokenHash(token));
    if (!device) throw new Error('UNAUTHORIZED');
    const now = Date.now();
    if ((this.lastTouchedAt.get(device.id) ?? 0) < now - 60_000) {
      this.devices.touch(device.id, new Date(now).toISOString());
      this.lastTouchedAt.set(device.id, now);
    }
    return device;
  }

  public refresh(token: string): LanPairResultDto {
    const device = this.authenticate(token);
    const nextToken = createToken();
    const updated = this.devices.rotateToken(device.id, tokenHash(nextToken));
    this.logger.info('LAN device token refreshed', { deviceId: device.id });
    return { token: nextToken, device: updated };
  }

  public revokeSelf(token: string): void {
    const device = this.authenticate(token);
    this.devices.revokeByTokenHash(tokenHash(token));
    this.lastTouchedAt.delete(device.id);
    this.logger.info('LAN device revoked itself', { deviceId: device.id });
  }

  public listDevices(): LanPairedDeviceDto[] {
    return this.devices.list();
  }

  public activeDeviceCount(): number {
    return this.devices.activeCount();
  }

  public revokeDevice(id: string): void {
    this.devices.revoke(id);
    this.lastTouchedAt.delete(id);
    this.logger.info('LAN device revoked from desktop', { deviceId: id });
  }

  private checkRateLimit(remoteAddress: string): void {
    const now = Date.now();
    const existing = this.rateBuckets.get(remoteAddress);
    if (!existing || existing.startedAtMs <= now - PAIRING_RATE_WINDOW_MS) {
      this.rateBuckets.set(remoteAddress, { startedAtMs: now, attempts: 1 });
      return;
    }
    existing.attempts += 1;
    if (existing.attempts > MAX_PAIRING_ATTEMPTS_PER_WINDOW) throw new Error('PAIRING_RATE_LIMITED');
  }
}

export function tokenFromRequestHeaders(
  authorization: string | undefined,
  cookieHeader: string | undefined,
): string | null {
  const bearer = authorization?.match(/^Bearer\s+([A-Za-z0-9_-]{32,256})$/i)?.[1];
  if (bearer) return bearer;
  for (const item of cookieHeader?.split(';') ?? []) {
    const [name, ...rest] = item.trim().split('=');
    if (name === 'film_library_token') return decodeURIComponent(rest.join('='));
  }
  return null;
}

export function authenticationCookie(token: string, maxAgeSeconds = 60 * 60 * 24 * 365): string {
  return `film_library_token=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}`;
}

export function clearAuthenticationCookie(): string {
  return 'film_library_token=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0';
}

function createToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function pairingHash(code: string, salt: string): Buffer {
  return createHash('sha256').update(`${salt}:${code}`, 'utf8').digest();
}
