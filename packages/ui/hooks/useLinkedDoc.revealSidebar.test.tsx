/**
 * Opening a linked document reveals the sidebar, because the sidebar's "Viewing / Back to …"
 * header is the markdown surface's only way back.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { useLinkedDoc, type UseLinkedDocReturn } from './useLinkedDoc';
import type { ViewerHandle } from '../components/Viewer';
import type { Annotation, DocumentRenderAs, ImageAttachment } from '../types';

const hasDom = typeof document !== 'undefined';

const noopViewerHandle: ViewerHandle = {
  removeHighlight: () => {},
  clearAllHighlights: () => {},
  applySharedAnnotations: () => {},
};

type SidebarOpenCall = string | undefined;

function Harness(props: {
  onLatest: (v: UseLinkedDocReturn) => void;
  opens: SidebarOpenCall[];
}) {
  const [markdown, setMarkdown] = useState('root markdown');
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null);
  const [globalAttachments, setGlobalAttachments] = useState<ImageAttachment[]>([]);
  const [renderAs, setRenderAs] = useState<DocumentRenderAs>('markdown');
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
    sidebar: { open: (tab) => { props.opens.push(tab); } },
  });

  props.onLatest(hook);
  return null;
}

let root: Root | null = null;
let host: HTMLElement | null = null;

async function mountHarness(opens: SidebarOpenCall[]): Promise<() => UseLinkedDocReturn> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  let latest: UseLinkedDocReturn | null = null;
  await act(async () => {
    root!.render(<Harness onLatest={(v) => { latest = v; }} opens={opens} />);
  });
  return () => {
    if (!latest) throw new Error('hook was not mounted');
    return latest;
  };
}

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null;
  host?.remove();
  host = null;
});

describe.if(hasDom)('useLinkedDoc sidebar reveal', () => {
  test('a markdown document opens the Contents tab, as it always has', async () => {
    const opens: SidebarOpenCall[] = [];
    const get = await mountHarness(opens);
    await act(async () => {
      get().openLoaded({ filepath: '/site/notes.md', markdown: '# Notes', renderAs: 'markdown' });
    });
    expect(opens).toEqual(['toc']);
    expect(get().filepath).toBe('/site/notes.md');
  });

  test('revealSidebar: false opens the document without touching the sidebar', async () => {
    const opens: SidebarOpenCall[] = [];
    const get = await mountHarness(opens);
    await act(async () => {
      get().openLoaded(
        { filepath: '/site/01-entry-point.html', rawHtml: '<h1>Entry</h1>', renderAs: 'html' },
        undefined,
        { revealSidebar: false },
      );
    });
    expect(opens).toEqual([]);
    expect(get().filepath).toBe('/site/01-entry-point.html');
    expect(get().isActive).toBe(true);
  });

  test('back() does not reveal the sidebar either', async () => {
    const opens: SidebarOpenCall[] = [];
    const get = await mountHarness(opens);
    await act(async () => {
      get().openLoaded(
        { filepath: '/site/01-entry-point.html', rawHtml: '<h1>Entry</h1>', renderAs: 'html' },
        undefined,
        { revealSidebar: false },
      );
    });
    await act(async () => { get().back(); });
    expect(opens).toEqual([]);
    expect(get().isActive).toBe(false);
  });
});
