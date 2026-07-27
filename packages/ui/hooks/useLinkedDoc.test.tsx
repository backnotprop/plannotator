import { afterEach, describe, expect, test } from 'bun:test';
import React, { useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { useLinkedDoc, type UseLinkedDocReturn } from './useLinkedDoc';
import type { ViewerHandle } from '../components/Viewer';
import type { Annotation, ImageAttachment } from '../types';

// Integration coverage for the diff-baseline seam useLinkedDoc gained for
// annotate folder sessions: a document's own previousPlan/versionInfo
// (captured from its /api/doc response) rides the same
// activate/cache/back lifecycle as its markdown and annotations, and
// survives re-opening a document the way those already did. The pure
// cache-selection logic itself is covered directly in
// useLinkedDoc.diffBaseline.test.ts — this file exercises it wired through
// the real stateful hook (open/back/re-open), which is where a wiring
// mistake (e.g. forgetting one of the cache-write call sites) would show up.

const hasDom = typeof document !== 'undefined';

const noopViewerHandle: ViewerHandle = {
  removeHighlight: () => {},
  clearAllHighlights: () => {},
  applySharedAnnotations: () => {},
};

function LinkedDocHarness(props: { onLatest: (v: UseLinkedDocReturn) => void }) {
  const [markdown, setMarkdown] = useState('root markdown');
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null);
  const [globalAttachments, setGlobalAttachments] = useState<ImageAttachment[]>([]);
  const [renderAs, setRenderAs] = useState<'markdown' | 'html'>('markdown');
  const [rawHtml, setRawHtml] = useState('');
  const [shareHtml, setShareHtml] = useState('');
  const viewerRef = useRef<ViewerHandle | null>(noopViewerHandle);

  const hook = useLinkedDoc({
    markdown,
    annotations,
    selectedAnnotationId,
    globalAttachments,
    setMarkdown,
    setAnnotations,
    setSelectedAnnotationId,
    setGlobalAttachments,
    renderAs,
    rawHtml,
    shareHtml,
    setRenderAs,
    setRawHtml,
    setShareHtml,
    viewerRef,
    sidebar: { open: () => {} },
  });

  props.onLatest(hook);
  return null;
}

let root: Root | null = null;
let host: HTMLElement | null = null;

async function mountHarness(): Promise<() => UseLinkedDocReturn> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);

  let latest: UseLinkedDocReturn | null = null;
  await act(async () => {
    root!.render(<LinkedDocHarness onLatest={(v) => { latest = v; }} />);
  });

  return () => {
    if (!latest) throw new Error('hook was not mounted');
    return latest;
  };
}

afterEach(async () => {
  if (root) {
    await act(async () => {
      root!.unmount();
    });
  }
  root = null;
  host?.remove();
  host = null;
});

const VERSION_INFO_A = { version: 2, totalVersions: 2, project: 'demo' };

describe('useLinkedDoc — per-document diff baseline', () => {
  test.skipIf(!hasDom)('opening a folder document with history fields flows diffPreviousPlan/diffVersionInfo', async () => {
    const current = await mountHarness();

    await act(async () => {
      current().openLoaded({
        filepath: '/root/docs/a.md',
        markdown: 'a v2',
        renderAs: 'markdown',
        previousPlan: 'a v1',
        versionInfo: VERSION_INFO_A,
      }, undefined, { notifyDocumentLoaded: false });
    });

    expect(current().isActive).toBe(true);
    expect(current().diffPreviousPlan).toBe('a v1');
    expect(current().diffVersionInfo).toEqual(VERSION_INFO_A);
  });

  test.skipIf(!hasDom)('opening a document with no history fields yields no diff baseline', async () => {
    const current = await mountHarness();

    await act(async () => {
      current().openLoaded({
        filepath: '/root/docs/b.md',
        markdown: 'b',
        renderAs: 'markdown',
      }, undefined, { notifyDocumentLoaded: false });
    });

    expect(current().isActive).toBe(true);
    expect(current().diffPreviousPlan).toBeNull();
    expect(current().diffVersionInfo).toBeNull();
  });

  test.skipIf(!hasDom)('no active document (root) reports no diff baseline from the hook itself', async () => {
    const current = await mountHarness();
    expect(current().isActive).toBe(false);
    expect(current().diffPreviousPlan).toBeNull();
    expect(current().diffVersionInfo).toBeNull();
  });

  test.skipIf(!hasDom)('back() then re-opening the same document without history fields reuses the cached baseline', async () => {
    const current = await mountHarness();

    await act(async () => {
      current().openLoaded({
        filepath: '/root/docs/a.md',
        markdown: 'a v2',
        renderAs: 'markdown',
        previousPlan: 'a v1',
        versionInfo: VERSION_INFO_A,
      }, undefined, { notifyDocumentLoaded: false });
    });
    expect(current().diffPreviousPlan).toBe('a v1');

    await act(async () => {
      current().back();
    });
    expect(current().isActive).toBe(false);

    // Re-open the SAME file without diff fields this time (simulating a
    // caller like the missing-on-disk openLoaded path, which never carries
    // /api/doc's history fields) — the cache from the first visit must
    // still supply them.
    await act(async () => {
      current().openLoaded({
        filepath: '/root/docs/a.md',
        markdown: 'a v2 (from cache)',
        renderAs: 'markdown',
      }, undefined, { notifyDocumentLoaded: false });
    });

    expect(current().diffPreviousPlan).toBe('a v1');
    expect(current().diffVersionInfo).toEqual(VERSION_INFO_A);
  });

  test.skipIf(!hasDom)('switching directly from a document with history to one without (no back() in between) does not leak the old baseline', async () => {
    const current = await mountHarness();

    await act(async () => {
      current().openLoaded({
        filepath: '/root/docs/a.md',
        markdown: 'a v2',
        renderAs: 'markdown',
        previousPlan: 'a v1',
        versionInfo: VERSION_INFO_A,
      }, undefined, { notifyDocumentLoaded: false });
    });
    expect(current().diffPreviousPlan).toBe('a v1');

    // Open a different document directly (activateDocument's "already
    // viewing a linked doc" branch, not back()).
    await act(async () => {
      current().openLoaded({
        filepath: '/root/docs/c.md',
        markdown: 'c',
        renderAs: 'markdown',
      }, undefined, { notifyDocumentLoaded: false });
    });

    expect(current().diffPreviousPlan).toBeNull();
    expect(current().diffVersionInfo).toBeNull();

    // And back to the first document — its baseline is still cached.
    await act(async () => {
      current().openLoaded({
        filepath: '/root/docs/a.md',
        markdown: 'a v2',
        renderAs: 'markdown',
      }, undefined, { notifyDocumentLoaded: false });
    });
    expect(current().diffPreviousPlan).toBe('a v1');
    expect(current().diffVersionInfo).toEqual(VERSION_INFO_A);
  });
});
