/**
 * Seam test: ImageSrcResolver override (setImageSrcResolver / resetImageSrcResolver).
 *
 * Contract: after setImageSrcResolver(fake), getImageSrc() (and thus the
 * rendered <ImageThumbnail> img src) uses the fake resolver instead of the
 * default /api/image endpoint.
 *
 * Primary assertion is via getImageSrc() (no DOM needed for the core contract).
 * The DOM render assertion validates that the component wires getImageSrc.
 *
 * IMPORTANT: function references are captured at module-load time (top-level)
 * so they remain valid even when configure.test.ts's mock.module() replaces
 * the module exports later during test execution.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as ImageThumbnailModule from './ImageThumbnail';

// Capture real function references at import time (before configure.test.ts's
// mock.module() runs and replaces setImageSrcResolver with a no-op spy).
const setImageSrcResolver = ImageThumbnailModule.setImageSrcResolver;
const resetImageSrcResolver = ImageThumbnailModule.resetImageSrcResolver;
const getImageSrc = ImageThumbnailModule.getImageSrc;

const hasDom = typeof document !== 'undefined';

afterEach(() => {
  resetImageSrcResolver();
  if (hasDom) document.body.innerHTML = '';
});

describe('ImageSrcResolver seam', () => {
  test('fake resolver is called with the image path (via getImageSrc)', () => {
    const calls: string[] = [];
    const fakeResolver = (p: string) => {
      calls.push(p);
      return `https://cdn.example.com/images/${encodeURIComponent(p)}`;
    };

    setImageSrcResolver(fakeResolver);

    const result = getImageSrc('/foo/img.png');

    expect(calls).toContain('/foo/img.png');
    expect(result).toContain('cdn.example.com');
    expect(result).toContain(encodeURIComponent('/foo/img.png'));
  });

  test('fake resolver receives the base parameter when provided', () => {
    const calls: Array<{ path: string; base?: string }> = [];
    const fake = (p: string, b?: string) => {
      calls.push({ path: p, base: b });
      return `https://cdn.example.com/${p}`;
    };

    setImageSrcResolver(fake);
    getImageSrc('relative/img.png', '/base/dir');

    expect(calls[0]).toEqual({ path: 'relative/img.png', base: '/base/dir' });
  });

  test('resetImageSrcResolver restores the default /api/image behavior', () => {
    const fake = (p: string) => `https://cdn.example.com/${p}`;
    setImageSrcResolver(fake);
    resetImageSrcResolver();

    // After reset, the default resolver builds /api/image?path=... URLs for local paths.
    const result = getImageSrc('/my/photo.jpg');

    expect(result).toContain('/api/image');
    expect(result).toContain(encodeURIComponent('/my/photo.jpg'));
    expect(result).not.toContain('cdn.example.com');
  });

  test('default resolver passes through remote URLs unchanged', () => {
    // resetImageSrcResolver already called in afterEach; still on default after reset.
    const remote = 'https://upload.example.com/images/foo.png';
    const result = getImageSrc(remote);
    expect(result).toBe(remote);
  });

  test.skipIf(!hasDom)('rendered <ImageThumbnail> img src reflects the installed fake resolver', async () => {
    const React = (await import('react')).default;
    const { createRoot } = await import('react-dom/client');
    const { act } = await import('react');
    const { ImageThumbnail } = await import('./ImageThumbnail');

    const calls: string[] = [];
    setImageSrcResolver((p) => { calls.push(p); return `https://cdn.test/${encodeURIComponent(p)}`; });

    const host = document.createElement('div');
    document.body.appendChild(host);
    await act(async () => {
      const root = createRoot(host);
      root.render(React.createElement(ImageThumbnail, { path: '/foo/img.png' }));
    });

    const img = host.querySelector('img');
    const src = img?.getAttribute('src') ?? '';

    expect(calls).toContain('/foo/img.png');
    expect(src).toContain('cdn.test');
  });
});
