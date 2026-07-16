/**
 * Seam test: UploadTransport override (setUploadTransport / resetUploadTransport).
 *
 * Contract: after setUploadTransport(fake), getUploadTransport().upload routes
 * through the fake — NOT through `fetch('/api/upload')`. resetUploadTransport()
 * restores the default `/api/upload` transport.
 *
 * Function references are captured at module-load time so they remain valid even
 * when configure.test.ts's mock.module() replaces the module exports later.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import * as uploadModule from './upload';

const setUploadTransport = uploadModule.setUploadTransport;
const resetUploadTransport = uploadModule.resetUploadTransport;
const getUploadTransport = uploadModule.getUploadTransport;

afterEach(() => {
  resetUploadTransport();
});

function makeFile(name = 'pic.png'): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type: 'image/png' });
}

describe('UploadTransport seam', () => {
  it('routes upload through the installed fake transport (not /api/upload)', async () => {
    const uploaded: File[] = [];
    setUploadTransport({
      async upload(file) {
        uploaded.push(file);
        return { path: 'r2://workspace/abc123', originalName: file.name };
      },
    });

    const result = await getUploadTransport().upload(makeFile('login.png'));

    expect(uploaded).toHaveLength(1);
    expect(uploaded[0].name).toBe('login.png');
    expect(result.path).toBe('r2://workspace/abc123');
    expect(result.originalName).toBe('login.png');
  });

  it('resetUploadTransport restores the default (does not use the fake)', async () => {
    let fakeCalled = false;
    setUploadTransport({
      async upload() {
        fakeCalled = true;
        return { path: 'should-not-see-this' };
      },
    });
    resetUploadTransport();

    // The default transport calls fetch('/api/upload'); stub fetch so the default
    // path is exercised without a real server, and assert the fake is gone.
    const originalFetch = globalThis.fetch;
    let hitUrl: string | undefined;
    // @ts-expect-error minimal fetch stub for the test
    globalThis.fetch = async (url: string) => {
      hitUrl = String(url);
      return { json: async () => ({ path: '/tmp/upload-123.png', originalName: 'pic.png' }) };
    };
    try {
      const result = await getUploadTransport().upload(makeFile());
      expect(fakeCalled).toBe(false);
      expect(hitUrl).toBe('/api/upload');
      expect(result.path).toBe('/tmp/upload-123.png');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
