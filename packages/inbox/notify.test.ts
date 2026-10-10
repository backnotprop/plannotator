/**
 * The one-time notifications line: "moved" only when the Inbox changed port
 * under the same name. The tailnet address (another device, another name)
 * is another permission, so it gets the plain ask.
 */
import { describe, expect, test } from 'bun:test';
import { askKind } from './notify';

const saved = (allowed_origin: string | null) => ({ enabled: true, dismissed: false, allowed_origin });

describe('askKind', () => {
  test('a port change on this computer reads as moved', () => {
    expect(askKind(saved('http://localhost:52817'), 'default', 'http://localhost:61000')).toBe('moved');
    expect(askKind(saved('http://127.0.0.1:52817'), 'default', 'http://localhost:61000')).toBe('moved');
  });
  test('the tailnet address and back again are each a plain ask, not "moved"', () => {
    expect(askKind(saved('http://localhost:52817'), 'default', 'https://studio.tail0000.ts.net:52817')).toBe('ask');
    expect(askKind(saved('https://studio.tail0000.ts.net:52817'), 'default', 'http://localhost:52817')).toBe('ask');
  });
  test('nothing when the browser decided, the person said Not now, or turned them off', () => {
    expect(askKind(saved('http://localhost:1'), 'granted', 'https://studio.tail0000.ts.net:1')).toBeNull();
    expect(askKind({ ...saved(null), dismissed: true }, 'default', 'http://localhost:1')).toBeNull();
    expect(askKind({ ...saved(null), enabled: false }, 'default', 'http://localhost:1')).toBeNull();
    expect(askKind(saved(null), 'default', 'http://localhost:1')).toBe('ask');
  });
});
