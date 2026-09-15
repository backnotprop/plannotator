/**
 * Cross-file annotation mutations from the panel's "All files" view (DOM-gated).
 *
 * This wires the real pieces the app wires — useLinkedDoc's per-document store,
 * groupAnnotationsByDocument, and AnnotationPanel — because the interesting
 * behaviour only exists at their seam.
 *
 * Failures to catch:
 *  - Deleting a card that belongs to another document mutating the OPEN
 *    document's live annotations (the same id can be absent there, so the
 *    delete silently does nothing and the comment still ships in the export).
 *  - The mutation not reaching `getDocAnnotations()`, which is what the export
 *    and the feedback payload read: a delete the user saw but the agent still
 *    receives.
 *  - The session total the decision control runs on (`annotations.length +
 *    docAnnotationCount`) moving when the reviewer only changed which
 *    documents the panel shows.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useLinkedDoc, type UseLinkedDocReturn } from './useLinkedDoc';
import { AnnotationPanel } from '../components/AnnotationPanel';
import { groupAnnotationsByDocument, type AnnotationScope } from '../utils/annotationScope';
import { AnnotationType, type Annotation, type ImageAttachment } from '../types';
import type { ViewerHandle } from '../components/Viewer';

const hasDom = typeof document !== 'undefined';

const ROOT_PATH = '/repo/a.md';
const OTHER_PATH = '/repo/b.md';

function row(id: string): Annotation {
  return {
    id,
    blockId: 'b1',
    startOffset: 0,
    endOffset: 4,
    type: AnnotationType.COMMENT,
    text: `note ${id}`,
    originalText: 'quoted',
    createdA: 1,
  };
}

interface HarnessApi {
  linkedDoc: UseLinkedDocReturn;
  setAnnotations: (a: Annotation[]) => void;
  sessionTotal: number;
  setScope: (s: AnnotationScope) => void;
}

let api: HarnessApi | null = null;

const Harness: React.FC = () => {
  const [markdown, setMarkdown] = useState('# a');
  const [annotations, setAnnotations] = useState<Annotation[]>([row('a1')]);
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null);
  const [globalAttachments, setGlobalAttachments] = useState<ImageAttachment[]>([]);
  const [renderAs, setRenderAs] = useState<'markdown' | 'html'>('markdown');
  const [rawHtml, setRawHtml] = useState('');
  const [shareHtml, setShareHtml] = useState('');
  const [scope, setScope] = useState<AnnotationScope>('current');
  const viewerRef = useRef<ViewerHandle | null>(null);

  const linkedDoc = useLinkedDoc({
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
    sourceFilePath: ROOT_PATH,
  });

  const currentPath = linkedDoc.filepath ?? ROOT_PATH;
  const byPath = new Map<string, readonly Annotation[]>();
  for (const [path, entry] of linkedDoc.getDocAnnotations()) byPath.set(path, entry.annotations);
  byPath.set(currentPath, annotations);
  const groups = groupAnnotationsByDocument(
    Array.from(byPath, ([path, anns]) => ({ path, annotations: anns })),
    currentPath,
    ['/repo'],
  );

  // What App feeds the decision control: the session, not the view.
  const sessionTotal = annotations.length + linkedDoc.docAnnotationCount;
  api = { linkedDoc, setAnnotations, sessionTotal, setScope };

  return (
    <AnnotationPanel
      isOpen
      annotations={annotations}
      blocks={[]}
      selectedId={selectedAnnotationId}
      onSelect={setSelectedAnnotationId}
      onDelete={(id) => setAnnotations((prev) => prev.filter((a) => a.id !== id))}
      annotationScope={scope}
      onAnnotationScopeChange={setScope}
      documentGroups={groups}
      onDeleteInDocument={(path, id) => {
        linkedDoc.updateStoredAnnotations(path, (anns) => anns.filter((a) => a.id !== id));
      }}
      onEditInDocument={(path, id, updates) => {
        linkedDoc.updateStoredAnnotations(path, (anns) => anns.map((a) => (a.id === id ? { ...a, ...updates } : a)));
      }}
    />
  );
};

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  if (root) {
    await act(async () => { root!.unmount(); });
    root = null;
  }
  host?.remove();
  host = null;
  api = null;
  if (hasDom) document.body.replaceChildren();
});

/** Root document has a1; after this the other document is open with b1, b2. */
async function mountWithTwoAnnotatedDocuments(): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(<Harness />);
  });
  await act(async () => {
    api!.linkedDoc.openLoaded({ filepath: OTHER_PATH, markdown: '# b' });
  });
  await act(async () => {
    api!.setAnnotations([row('b1'), row('b2')]);
  });
  await act(async () => { api!.setScope('all'); });
}

function deleteButtonOf(id: string): HTMLButtonElement | undefined {
  const card = document.querySelector<HTMLElement>(`[data-annotation-id="${id}"]`);
  return Array.from(card?.querySelectorAll<HTMLButtonElement>('button') ?? [])
    .find((b) => b.getAttribute('title') === 'Delete annotation');
}

describe.if(hasDom)('cross-file annotation mutations', () => {
  test('the All files view shows both documents once one is open and the other is stored', async () => {
    await mountWithTwoAnnotatedDocuments();

    expect(document.querySelector('[data-annotation-id="b1"]')).not.toBeNull();
    expect(document.querySelector('[data-annotation-id="a1"]')).not.toBeNull();
    const sections = Array.from(document.querySelectorAll('[data-annotation-group]'))
      .map((el) => el.getAttribute('data-annotation-group'));
    expect(sections).toEqual([OTHER_PATH, ROOT_PATH]);
  });

  test('deleting another document\'s card removes it from THAT document\'s store', async () => {
    await mountWithTwoAnnotatedDocuments();
    expect(api!.linkedDoc.getDocAnnotations().get(ROOT_PATH)?.annotations.map((a) => a.id)).toEqual(['a1']);

    await act(async () => deleteButtonOf('a1')!.click());

    // The stored document lost it — this map is what the export reads.
    expect(api!.linkedDoc.getDocAnnotations().get(ROOT_PATH)?.annotations).toEqual([]);
    // The open document is untouched.
    expect(api!.linkedDoc.getDocAnnotations().get(OTHER_PATH)?.annotations.map((a) => a.id)).toEqual(['b1', 'b2']);
    expect(document.querySelector('[data-annotation-id="a1"]')).toBeNull();
    expect(document.querySelector('[data-annotation-id="b1"]')).not.toBeNull();
  });

  test('a cross-file delete lowers the session total; the scope toggle never does', async () => {
    await mountWithTwoAnnotatedDocuments();
    expect(api!.sessionTotal).toBe(3);

    await act(async () => { api!.setScope('current'); });
    expect(api!.sessionTotal).toBe(3);
    await act(async () => { api!.setScope('all'); });
    expect(api!.sessionTotal).toBe(3);

    await act(async () => deleteButtonOf('a1')!.click());
    expect(api!.sessionTotal).toBe(2);
  });

  test('a stored document is reached by its normalized spelling (Windows cache keys)', async () => {
    // The cache is keyed by the RAW path the server sent; the panel addresses
    // documents by the normalized path `groupAnnotationsByDocument` emits. On
    // Windows those differ (`C:\\repo\\win.md` vs `C:/repo/win.md`), and the
    // raw lookup missed every time: Edit and Delete on a cross-file card were
    // silent no-ops and the comment still shipped in the export.
    const WIN_RAW = 'C:\\repo\\docs\\win.md';
    host = document.createElement('div');
    document.body.appendChild(host);
    await act(async () => {
      root = createRoot(host!);
      root.render(<Harness />);
    });
    // Open the Windows-spelled document, annotate it, then leave it: that is
    // what puts it in the cache under its raw key.
    await act(async () => { api!.linkedDoc.openLoaded({ filepath: WIN_RAW, markdown: '# win' }); });
    await act(async () => { api!.setAnnotations([row('w1'), row('w2')]); });
    await act(async () => { api!.linkedDoc.openLoaded({ filepath: OTHER_PATH, markdown: '# b' }); });

    let accepted = false;
    await act(async () => {
      accepted = api!.linkedDoc.updateStoredAnnotations(
        'C:/repo/docs/win.md',
        (anns) => anns.filter((a) => a.id !== 'w1'),
      );
    });

    expect(accepted).toBe(true);
    expect(api!.linkedDoc.getDocAnnotations().get(WIN_RAW)?.annotations.map((a) => a.id)).toEqual(['w2']);
  });

  test('the stashed source document is reached by its normalized spelling too', async () => {
    await mountWithTwoAnnotatedDocuments();

    let accepted = false;
    await act(async () => {
      // Same path as ROOT_PATH, differently spelled.
      accepted = api!.linkedDoc.updateStoredAnnotations('/repo//a.md', () => []);
    });

    expect(accepted).toBe(true);
    expect(api!.linkedDoc.getDocAnnotations().get(ROOT_PATH)?.annotations).toEqual([]);
  });

  test('the active document is never written through the stored-document path', async () => {
    await mountWithTwoAnnotatedDocuments();
    // App routes open-document cards to its own handlers; the store refuses the
    // active document outright so a mis-route cannot write a doomed copy.
    let accepted = true;
    await act(async () => {
      accepted = api!.linkedDoc.updateStoredAnnotations(OTHER_PATH, () => []);
    });
    expect(accepted).toBe(false);
    expect(document.querySelector('[data-annotation-id="b1"]')).not.toBeNull();
  });
});
