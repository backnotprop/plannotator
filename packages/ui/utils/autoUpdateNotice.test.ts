import { describe, expect, test } from 'bun:test';
import { parseAutoUpdateNotice } from './autoUpdateNotice';

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
