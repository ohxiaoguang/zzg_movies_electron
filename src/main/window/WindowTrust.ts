const trustedWindows = new WeakMap<object, readonly string[]>();

export function trustWindow(webContents: object, entryUrls: readonly string[]): void {
  trustedWindows.set(webContents, [...entryUrls]);
}

export function isTrustedWindowUrl(webContents: object, candidate: string): boolean {
  return isApplicationUrl(candidate, trustedWindows.get(webContents) ?? []);
}

export function isApplicationUrl(candidate: string, entries: readonly string[]): boolean {
  try {
    const url = new URL(candidate);
    if (!['file:', 'http:', 'https:'].includes(url.protocol) || url.username || url.password) return false;
    url.hash = '';
    url.search = '';
    return entries.some((entry) => {
      const allowed = new URL(entry);
      allowed.hash = '';
      allowed.search = '';
      return url.href === allowed.href;
    });
  } catch {
    return false;
  }
}
