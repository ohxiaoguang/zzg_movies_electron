import { describe, expect, it } from 'vitest';
import { isApplicationUrl, isTrustedWindowUrl, trustWindow } from '../src/main/window/WindowTrust';

describe('application window trust', () => {
  const entries = ['file:///C:/app/index.html', 'http://localhost:5173/'];

  it('allows hash routing and diagnostic queries only on exact entry pages', () => {
    expect(isApplicationUrl('file:///C:/app/index.html#/library', entries)).toBe(true);
    expect(isApplicationUrl('http://localhost:5173/?reason=test#/settings', entries)).toBe(true);
    for (const url of [
      'file:///C:/Downloads/untrusted.html', 'file:///C:/app/other.html',
      'http://localhost:5174/', 'http://localhost:5173/other',
      'http://localhost:5173.evil.test/', 'http://user@localhost:5173/',
      'data:text/html,test', 'invalid',
    ]) expect(isApplicationUrl(url, entries)).toBe(false);
  });

  it('does not grant another window access to a trusted entry', () => {
    const owner = {};
    trustWindow(owner, entries);
    expect(isTrustedWindowUrl(owner, entries[0])).toBe(true);
    expect(isTrustedWindowUrl({}, entries[0])).toBe(false);
  });
});
