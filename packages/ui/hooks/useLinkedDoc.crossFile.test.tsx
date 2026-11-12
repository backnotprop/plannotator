import { afterEach, describe, expect, test } from 'bun:test';
import React, { act, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useLinkedDoc, type UseLinkedDocReturn } from './useLinkedDoc';
import { AnnotationPanel } from '../components/AnnotationPanel';
import { groupAnnotationsByDocument, type AnnotationScope } from '../utils/annotationScope';
import { AnnotationType, type Annotation, type DocumentRenderAs, type ImageAttachment } from '../types';
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
  const [renderAs, setRenderAs] = useState<DocumentRenderAs>('markdown');
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

    expect(api!.linkedDoc.getDocAnnotations().get(ROOT_PATH)?.annotations).toEqual([]);
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
    const WIN_RAW = 'C:\\repo\\docs\\win.md';
    host = document.createElement('div');
    document.body.appendChild(host);
    await act(async () => {
      root = createRoot(host!);
      root.render(<Harness />);
    });
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
      accepted = api!.linkedDoc.updateStoredAnnotations('/repo//a.md', () => []);
    });

    expect(accepted).toBe(true);
    expect(api!.linkedDoc.getDocAnnotations().get(ROOT_PATH)?.annotations).toEqual([]);
  });

  test('the feedback split holds the root once and every other document once', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    await act(async () => {
      root = createRoot(host!);
      root.render(<Harness />);
    });
    let split = api!.linkedDoc.getFeedbackDocuments();
    expect(split.root).toBeNull();
    expect([...split.documents.keys()]).toEqual([]);

    await act(async () => { api!.linkedDoc.openLoaded({ filepath: OTHER_PATH, markdown: '# b' }); });
    await act(async () => { api!.setAnnotations([row('b1'), row('b2')]); });

    split = api!.linkedDoc.getFeedbackDocuments();
    expect(split.root?.annotations.map((a) => a.id)).toEqual(['a1']);
    expect([...split.documents.keys()]).toEqual([OTHER_PATH]);
    expect(split.documents.get(OTHER_PATH)?.annotations.map((a) => a.id)).toEqual(['b1', 'b2']);

    await act(async () => { api!.linkedDoc.back(); });
    split = api!.linkedDoc.getFeedbackDocuments();
    expect(split.root).toBeNull();
    expect([...split.documents.keys()]).toEqual([OTHER_PATH]);
  });

  test('comments on a self-opened copy of the root are exported, not dropped', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    await act(async () => {
      root = createRoot(host!);
      root.render(<Harness />);
    });
    await act(async () => { api!.linkedDoc.openLoaded({ filepath: ROOT_PATH, markdown: '# a' }); });
    await act(async () => { api!.setAnnotations([row('s1')]); });
    await act(async () => { api!.linkedDoc.openLoaded({ filepath: OTHER_PATH, markdown: '# b' }); });
    await act(async () => { api!.linkedDoc.back(); });

    expect(api!.linkedDoc.docAnnotationCount).toBe(1);
    const split = api!.linkedDoc.getFeedbackDocuments();
    const exported = [...split.documents.values()].flatMap((d) => d.annotations.map((a) => a.id));
    expect(exported).toEqual(['s1']);
    expect(split.documents.get(ROOT_PATH)?.annotations.map((a) => a.id)).toEqual(['s1']);
  });

  test('the active document is never written through the stored-document path', async () => {
    await mountWithTwoAnnotatedDocuments();
    let accepted = true;
    await act(async () => {
      accepted = api!.linkedDoc.updateStoredAnnotations(OTHER_PATH, () => []);
    });
    expect(accepted).toBe(false);
    expect(document.querySelector('[data-annotation-id="b1"]')).not.toBeNull();
  });
});
