import { isIP } from 'node:net';
import os from 'node:os';
import type { LanServerBindMode } from '../../shared/contracts';

export const LOCALHOST_ADDRESS = '127.0.0.1';
export const ALL_IPV4_INTERFACES = '0.0.0.0';

export function isPrivateIpv4(address: string): boolean {
  if (isIP(address) !== 4) return false;
  const [first, second] = address.split('.').map(Number);
  return first === 10
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || (first === 169 && second === 254);
}

export function isLoopbackAddress(address: string | undefined): boolean {
  const normalized = normalizeRemoteAddress(address);
  return normalized === LOCALHOST_ADDRESS || normalized === '::1';
}

export function isPrivateClientAddress(address: string | undefined): boolean {
  const normalized = normalizeRemoteAddress(address);
  return normalized === LOCALHOST_ADDRESS || normalized === '::1' || isPrivateIpv4(normalized);
}

export function isAllowedLanBindAddress(address: string): boolean {
  return address === '' || address === ALL_IPV4_INTERFACES || isPrivateIpv4(address);
}

export function resolveBindAddress(bindMode: LanServerBindMode, configuredHost: string): string {
  if (bindMode === 'localhost') return LOCALHOST_ADDRESS;
  return configuredHost && isAllowedLanBindAddress(configuredHost) ? configuredHost : ALL_IPV4_INTERFACES;
}

export function listPrivateIpv4Addresses(): string[] {
  const addresses = new Set<string>();
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal && isPrivateIpv4(entry.address)) addresses.add(entry.address);
    }
  }
  return [...addresses].sort((left, right) => left.localeCompare(right, 'en'));
}

export function serverBaseUrls(bindMode: LanServerBindMode, bindAddress: string, port: number): string[] {
  if (bindMode === 'localhost') return [`http://${LOCALHOST_ADDRESS}:${port}`];
  const addresses = bindAddress === ALL_IPV4_INTERFACES ? listPrivateIpv4Addresses() : [bindAddress];
  return addresses.map((address) => `http://${address}:${port}`);
}

export function isTrustedHttpHost(hostHeader: string | undefined, bindMode: LanServerBindMode): boolean {
  if (!hostHeader) return false;
  const hostname = hostHeader.toLowerCase().replace(/:\d{1,5}$/, '');
  if (hostname === 'localhost' || hostname === LOCALHOST_ADDRESS) return true;
  return bindMode === 'lan' && isPrivateIpv4(hostname);
}

export function isTrustedHttpOrigin(origin: string | undefined, bindMode: LanServerBindMode): boolean {
  if (!origin) return true;
  try {
    const url = new URL(origin);
    if (url.protocol !== 'http:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return false;
    return isTrustedHttpHost(url.host, bindMode);
  } catch {
    return false;
  }
}

function normalizeRemoteAddress(address: string | undefined): string {
  if (!address) return '';
  return address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
}
