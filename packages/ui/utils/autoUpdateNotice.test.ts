import { describe, expect, test } from 'bun:test';
import { describeAutoUpdateNotice, parseAutoUpdateNotice } from './autoUpdateNotice';

describe('parseAutoUpdateNotice', () => {
  const valid = {
    id: '0.28.0@1',
    kind: 'updated',
    version: '0.28.0',
    releaseUrl: 'https://github.com/backnotprop/plannotator/releases/tag/v0.28.0',
  };

  test('accepts the shape the server sends', () => {
    expect(parseAutoUpdateNotice(valid)?.kind).toBe('updated');
    expect(parseAutoUpdateNotice({ ...valid, kind: 'failed', logPath: '/x/update.log' })?.logPath).toBe('/x/update.log');
  });

  test('absent or malformed payloads (old servers, hosts) show nothing', () => {
    expect(parseAutoUpdateNotice(undefined)).toBeUndefined();
    expect(parseAutoUpdateNotice({ ...valid, kind: 'other' })).toBeUndefined();
    expect(parseAutoUpdateNotice({ ...valid, id: '' })).toBeUndefined();
  });

  test('the toast link can only point at GitHub', () => {
    expect(parseAutoUpdateNotice({ ...valid, releaseUrl: 'javascript:alert(1)' })).toBeUndefined();
    expect(parseAutoUpdateNotice({ ...valid, releaseUrl: 'https://evil.example/' })).toBeUndefined();
  });
});

describe('safe-update failure reasons', () => {
  const failed = {
    id: '0.28.33@mismatch',
    kind: 'failed',
    version: '0.28.33',
    releaseUrl: 'https://github.com/backnotprop/plannotator/releases/tag/v0.28.33',
    logPath: '/x/update.log',
  };

  test('a known reason is kept; an unknown one is dropped (the generic toast)', () => {
    expect(parseAutoUpdateNotice({ ...failed, reason: 'mismatch' })?.reason).toBe('mismatch');
    expect(parseAutoUpdateNotice({ ...failed, reason: 'download' })?.reason).toBe('download');
    expect(parseAutoUpdateNotice({ ...failed, reason: 'prepare' })?.reason).toBe('prepare');
    expect(parseAutoUpdateNotice({ ...failed, reason: 'other' })?.reason).toBeUndefined();
  });

  test('a temp folder that could not hold the update is not called a download failure', () => {
    const text = describeAutoUpdateNotice(parseAutoUpdateNotice({ ...failed, reason: 'prepare' })!);
    expect(text.title).toBe("Couldn't prepare the update");
    expect(text.description).toContain('temp folder');
    expect(text.description).not.toContain('download');
  });

  test('a mismatch says nothing changed and offers no install command', () => {
    const text = describeAutoUpdateNotice(parseAutoUpdateNotice({ ...failed, reason: 'mismatch' })!);
    expect(text.title).toBe('Update to v0.28.33 stopped');
    expect(text.description).toContain('Nothing was changed');
    expect(text.description).not.toContain('curl');
  });
});
