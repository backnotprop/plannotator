import { afterEach, describe, expect, test } from 'bun:test';
import React, { useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { useLinkedDoc, type UseLinkedDocReturn } from './useLinkedDoc';
import type { ViewerHandle } from '../components/Viewer';
import { AnnotationType, type Annotation, type DocumentRenderAs, type ImageAttachment } from '../types';

// Going back to the root document (or re-opening a cached one) re-applies its
// stored annotations through the Viewer's restore. Only text highlights may go
// through it: a comment made in the plan diff view (blockId `diff-block-N`)
// or a checkbox toggle (raw-markdown quote) finds no text in the normal view,
// so the restore would report it unanchored and the host would rewrite its
// blockId, breaking the diff view's markers and the export. Repro before the
// fix: comment in the diff view, turn the diff off, open a linked doc, Back.
//
// Ids are built at runtime: Tailwind scans this package's sources, and a
// literal that parses as a utility leaks a rule into the guides.show viewer.

const hasDom = typeof document !== 'undefined';

const blockId = (n: number) => ['block', n].join('-');
const diffBlockId = (n: number) => ['diff', 'block', n].join('-');

const ROOT_ANNOTATIONS: Annotation[] = [
  {
    id: 'textComment',
    blockId: blockId(1),
    startOffset: 0,
    endOffset: 5,
    type: AnnotationType.COMMENT,
    text: 'tighten',
    originalText: 'Alpha',
    createdA: 1,
  },
  {
    id: 'diffComment',
    blockId: diffBlockId(2),
    startOffset: 0,
    endOffset: 4,
    type: AnnotationType.COMMENT,
    text: 'why remove this?',
    originalText: 'Beta',
    createdA: 2,
    diffContext: 'removed',
  },
  {
    id: ['ann', 'checkbox', blockId(3), '1'].join('-'),
    blockId: blockId(3),
    startOffset: 0,
    endOffset: 9,
    type: AnnotationType.COMMENT,
    text: 'Marked done',
    originalText: '- [ ] task',
    createdA: 3,
  },
];

const applied: string[][] = [];

const recordingViewer: ViewerHandle = {
  removeHighlight: () => {},
  clearAllHighlights: () => {},
  applySharedAnnotations: (annotations) => { applied.push(annotations.map((a) => a.id)); },
};

function Harness(props: { onLatest: (v: UseLinkedDocReturn) => void }) {
  const [markdown, setMarkdown] = useState('Alpha\n\nBeta');
  const [annotations, setAnnotations] = useState<Annotation[]>(ROOT_ANNOTATIONS);
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null);
  const [globalAttachments, setGlobalAttachments] = useState<ImageAttachment[]>([]);
  const [renderAs, setRenderAs] = useState<DocumentRenderAs>('markdown');
  const [rawHtml, setRawHtml] = useState('');
  const [shareHtml, setShareHtml] = useState('');
  const viewerRef = useRef<ViewerHandle | null>(recordingViewer);
  const hook = useLinkedDoc({
    markdown, annotations, selectedAnnotationId, globalAttachments,
    setMarkdown, setAnnotations, setSelectedAnnotationId, setGlobalAttachments,
    renderAs, rawHtml, shareHtml, setRenderAs, setRawHtml, setShareHtml,
    viewerRef,
    sidebar: { open: () => {} },
  });
  props.onLatest(hook);
  return null;
}

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null;
  host?.remove();
  host = null;
  applied.length = 0;
});

const waitForReapply = () => act(async () => { await new Promise((r) => setTimeout(r, 150)); });

describe('useLinkedDoc re-applies only text highlights', () => {
  test.skipIf(!hasDom)('Back to the root skips diff-view comments and checkbox toggles', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    let latest: UseLinkedDocReturn | null = null;
    await act(async () => { root!.render(<Harness onLatest={(v) => { latest = v; }} />); });
    const current = () => latest!;

    await act(async () => {
      current().openLoaded(
        { filepath: '/root/docs/linked.md', markdown: 'Linked', renderAs: 'markdown' },
        undefined,
        { notifyDocumentLoaded: false },
      );
    });
    await waitForReapply();
    applied.length = 0;

    await act(async () => { current().back(); });
    await waitForReapply();

    expect(applied).toEqual([['textComment']]);
  });
});
