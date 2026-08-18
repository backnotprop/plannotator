/**
 * Broken markdown images must resolve to a stable, accessible fallback instead
 * of leaving the browser's native broken-image glyph in document content.
 *
 * Requires DOM (happy-dom) — run with DOM_TESTS=1 bun test.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { InlineMarkdown } from './InlineMarkdown';

const hasDom = typeof document !== 'undefined';
const DATA_IMAGE = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';

let mountedRoot: Root | null = null;

afterEach(async () => {
  if (!hasDom) return;
  if (mountedRoot) {
    await act(async () => mountedRoot?.unmount());
    mountedRoot = null;
  }
  document.body.innerHTML = '';
});

async function render(element: React.ReactElement): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  mountedRoot = createRoot(host);
  await act(async () => mountedRoot?.render(element));
  return host;
}

describe('InlineMarkdown image failure fallback', () => {
  test.skipIf(!hasDom)('keeps successful images clickable for the lightbox', async () => {
    const opened: Array<{ src: string; alt: string }> = [];
    const host = await render(
      <InlineMarkdown
        text={`![Atlas release map](${DATA_IMAGE})`}
        onImageClick={(src, alt) => opened.push({ src, alt })}
      />,
    );

    const image = host.querySelector('img');
    expect(image).not.toBeNull();
    expect(image?.className).toContain('cursor-zoom-in');

    await act(async () => {
      image?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(opened).toEqual([
      { src: DATA_IMAGE, alt: 'Atlas release map' },
    ]);
  });

  test.skipIf(!hasDom)('replaces a failed image with a safe, themed status block', async () => {
    const host = await render(
      <InlineMarkdown text="![Atlas release map](assets/diagram.png)" />,
    );
    const image = host.querySelector('img');

    await act(async () => {
      image?.dispatchEvent(new Event('error'));
    });

    const fallback = host.querySelector<HTMLElement>('[data-image-unavailable="true"]');
    expect(fallback).not.toBeNull();
    expect(host.querySelector('img')).toBeNull();
    expect(fallback?.getAttribute('role')).toBe('img');
    // Deliberate UX copy: the fallback must explain the failure without
    // leaking the source path or presenting browser-specific error text.
    expect(fallback?.getAttribute('aria-label')).toBe('Atlas release map. Image unavailable');
    expect(fallback?.textContent).toContain('Atlas release map');
    expect(fallback?.textContent).toContain('Image unavailable');
    expect(fallback?.className).toContain('border-border');
    expect(fallback?.className).toContain('bg-muted/40');
    expect(fallback?.className).not.toContain('cursor-zoom-in');
    expect(host.innerHTML).not.toContain('assets/diagram.png');
  });

  test.skipIf(!hasDom)('gives an empty-alt failure one useful accessible label', async () => {
    const host = await render(<InlineMarkdown text="![](missing.png)" />);
    const image = host.querySelector('img');

    await act(async () => {
      image?.dispatchEvent(new Event('error'));
    });

    const fallback = host.querySelector<HTMLElement>('[data-image-unavailable="true"]');
    expect(fallback?.getAttribute('aria-label')).toBe('Image unavailable');
    expect(fallback?.textContent).toBe('Image unavailable');
  });

  test.skipIf(!hasDom)('wraps a long authored description without exposing the source', async () => {
    const alt = 'A very long release-map description that must remain readable inside a narrow document column';
    const host = await render(<InlineMarkdown text={`![${alt}](private/path/diagram.png)`} />);
    const image = host.querySelector('img');

    await act(async () => {
      image?.dispatchEvent(new Event('error'));
    });

    const fallback = host.querySelector<HTMLElement>('[data-image-unavailable="true"]');
    const copy = fallback?.querySelector('[class*="overflow-wrap"]');
    expect(fallback?.textContent).toContain(alt);
    expect(copy?.className).toContain('[overflow-wrap:anywhere]');
    expect(host.innerHTML).not.toContain('private/path/diagram.png');
  });

  test.skipIf(!hasDom)('does not retry automatically and resets only when the image source changes', async () => {
    const host = await render(<InlineMarkdown text="![First](missing-one.png)" />);
    const firstImage = host.querySelector('img');

    await act(async () => {
      firstImage?.dispatchEvent(new Event('error'));
    });
    expect(host.querySelector('img')).toBeNull();

    await act(async () => {
      mountedRoot?.render(<InlineMarkdown text="![First](missing-one.png)" />);
    });
    expect(host.querySelector('img')).toBeNull();

    await act(async () => {
      mountedRoot?.render(<InlineMarkdown text={`![Second](${DATA_IMAGE})`} />);
    });
    expect(host.querySelector('img')?.getAttribute('alt')).toBe('Second');
    expect(host.querySelector('[data-image-unavailable="true"]')).toBeNull();
  });
});
