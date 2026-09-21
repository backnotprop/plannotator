/**
 * AnnotationPanel cross-file ("All files") view (DOM-gated).
 *
 * Failures to catch:
 *  - The All files view showing only the open document's cards, which is the
 *    bug the whole view exists to fix.
 *  - Edit/Delete on a card that belongs to another document routing to the open
 *    document's mutators — that would delete the wrong comment (or nothing).
 *  - Clicking an other-file card selecting in place instead of asking the host
 *    to navigate, leaving the reviewer on a document that has no such comment.
 *  - A file with no feedback of its own offering no way out of "No annotations
 *    yet" while feedback exists elsewhere.
 *  - The compatibility guard: a host that passes none of the new props must get
 *    the previous panel, legacy "+N in M other files" affordance included.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AnnotationPanel } from './AnnotationPanel';
import { AnnotationType, type Annotation } from '../types';
import type { AnnotationDocumentGroup } from '../utils/annotationScope';

const hasDom = typeof document !== 'undefined';

function row(id: string, text: string): Annotation {
  return {
    id,
    blockId: 'b1',
    startOffset: 0,
    endOffset: 5,
    type: AnnotationType.COMMENT,
    text,
    originalText: 'quoted',
    createdA: 1,
  };
}

const OPEN_PATH = '/repo/docs/open.md';
const OTHER_PATH = '/repo/docs/other.md';
const openAnnotations = [row('open-1', 'on the open file')];
const otherAnnotations = [row('other-1', 'on the other file'), row('other-2', 'also other')];

function groups(): AnnotationDocumentGroup[] {
  return [
    { path: OPEN_PATH, label: 'docs/open.md', annotations: openAnnotations, isCurrent: true },
    { path: OTHER_PATH, label: 'docs/other.md', annotations: otherAnnotations, isCurrent: false },
  ];
}

let root: Root | null = null;
let host: HTMLElement | null = null;

async function mount(ui: React.ReactElement): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(ui);
  });
}

afterEach(async () => {
  if (root) {
    await act(async () => { root!.unmount(); });
    root = null;
  }
  host?.remove();
  host = null;
  if (hasDom) document.body.replaceChildren();
});

function card(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-annotation-id="${id}"]`);
}

function deleteButtonOf(id: string): HTMLButtonElement | undefined {
  return Array.from(card(id)?.querySelectorAll<HTMLButtonElement>('button') ?? [])
    .find((b) => b.getAttribute('title') === 'Delete annotation');
}

function scopeButton(scope: 'current' | 'all'): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(`[data-annotation-scope="${scope}"]`);
}

describe.if(hasDom)('AnnotationPanel all-files view', () => {
  test('renders cards from every document, grouped, open document first', async () => {
    await mount(
      <AnnotationPanel
        isOpen
        annotations={openAnnotations}
        blocks={[]}
        selectedId={null}
        onSelect={() => {}}
        onDelete={() => {}}
        annotationScope="all"
        onAnnotationScopeChange={() => {}}
        documentGroups={groups()}
      />,
    );

    expect(card('open-1')).not.toBeNull();
    expect(card('other-1')).not.toBeNull();
    expect(card('other-2')).not.toBeNull();

    const sections = Array.from(document.querySelectorAll('[data-annotation-group]'))
      .map((el) => el.getAttribute('data-annotation-group'));
    expect(sections).toEqual([OPEN_PATH, OTHER_PATH]);
  });

  test('deleting an other-file card mutates that document, never the open one', async () => {
    const onDelete = mock(() => {});
    const onDeleteInDocument = mock((_path: string, _id: string) => {});
    await mount(
      <AnnotationPanel
        isOpen
        annotations={openAnnotations}
        blocks={[]}
        selectedId={null}
        onSelect={() => {}}
        onDelete={onDelete}
        onDeleteInDocument={onDeleteInDocument}
        annotationScope="all"
        onAnnotationScopeChange={() => {}}
        documentGroups={groups()}
      />,
    );

    await act(async () => deleteButtonOf('other-1')!.click());
    expect(onDeleteInDocument).toHaveBeenCalledTimes(1);
    expect(onDeleteInDocument.mock.calls[0]).toEqual([OTHER_PATH, 'other-1']);
    expect(onDelete).not.toHaveBeenCalled();

    // A card in the open document keeps the incumbent path.
    await act(async () => deleteButtonOf('open-1')!.click());
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onDeleteInDocument).toHaveBeenCalledTimes(1);
  });

  test('clicking an other-file card asks the host to jump to its document', async () => {
    const onSelect = mock((_id: string) => {});
    const onSelectInDocument = mock((_path: string, _id: string) => {});
    await mount(
      <AnnotationPanel
        isOpen
        annotations={openAnnotations}
        blocks={[]}
        selectedId={null}
        onSelect={onSelect}
        onDelete={() => {}}
        onSelectInDocument={onSelectInDocument}
        annotationScope="all"
        onAnnotationScopeChange={() => {}}
        documentGroups={groups()}
      />,
    );

    await act(async () => card('other-2')!.click());
    expect(onSelectInDocument.mock.calls[0]).toEqual([OTHER_PATH, 'other-2']);
    expect(onSelect).not.toHaveBeenCalled();

    await act(async () => card('open-1')!.click());
    expect(onSelect.mock.calls[0]).toEqual(['open-1']);
  });

  test('a group collapses and its cards leave the DOM', async () => {
    await mount(
      <AnnotationPanel
        isOpen
        annotations={openAnnotations}
        blocks={[]}
        selectedId={null}
        onSelect={() => {}}
        onDelete={() => {}}
        annotationScope="all"
        onAnnotationScopeChange={() => {}}
        documentGroups={groups()}
      />,
    );

    const header = document.querySelector<HTMLButtonElement>(`[data-annotation-group="${OTHER_PATH}"] button`)!;
    expect(header.getAttribute('aria-expanded')).toBe('true');
    await act(async () => header.click());
    expect(card('other-1')).toBeNull();
    // The open document is untouched by a collapse elsewhere.
    expect(card('open-1')).not.toBeNull();
  });

  test('the scope toggle only reports the choice; it never mutates annotations', async () => {
    const onAnnotationScopeChange = mock((_scope: 'current' | 'all') => {});
    const onDelete = mock(() => {});
    const onEdit = mock(() => {});
    await mount(
      <AnnotationPanel
        isOpen
        annotations={openAnnotations}
        blocks={[]}
        selectedId={null}
        onSelect={() => {}}
        onDelete={onDelete}
        onEdit={onEdit}
        annotationScope="current"
        onAnnotationScopeChange={onAnnotationScopeChange}
        documentGroups={groups()}
      />,
    );

    // "This file" is the live view: only the open document's card is rendered.
    expect(card('other-1')).toBeNull();
    await act(async () => scopeButton('all')!.click());
    expect(onAnnotationScopeChange.mock.calls).toEqual([['all']]);
    expect(onDelete).not.toHaveBeenCalled();
    expect(onEdit).not.toHaveBeenCalled();
  });

  test('a file with no feedback of its own offers the way to the rest', async () => {
    const onAnnotationScopeChange = mock((_scope: 'current' | 'all') => {});
    await mount(
      <AnnotationPanel
        isOpen
        annotations={[]}
        blocks={[]}
        selectedId={null}
        onSelect={() => {}}
        onDelete={() => {}}
        annotationScope="current"
        onAnnotationScopeChange={onAnnotationScopeChange}
        documentGroups={[{ path: OTHER_PATH, label: 'docs/other.md', annotations: otherAnnotations, isCurrent: false }]}
      />,
    );

    const viewAll = document.querySelector<HTMLButtonElement>('[data-annotation-view-all="true"]');
    expect(viewAll).not.toBeNull();
    await act(async () => viewAll!.click());
    expect(onAnnotationScopeChange.mock.calls).toEqual([['all']]);
  });

  test('hosts that pass none of the new props keep the previous panel', async () => {
    const onOtherFileAnnotationsClick = mock(() => {});
    await mount(
      <AnnotationPanel
        isOpen
        annotations={openAnnotations}
        blocks={[]}
        selectedId={null}
        onSelect={() => {}}
        onDelete={() => {}}
        otherFileAnnotations={{ count: 2, files: 1 }}
        onOtherFileAnnotationsClick={onOtherFileAnnotationsClick}
      />,
    );

    expect(document.querySelector('[data-annotation-scope-toggle]')).toBeNull();
    expect(document.querySelector('[data-annotation-group]')).toBeNull();
    const legacy = Array.from(document.querySelectorAll('button'))
      .find((b) => b.textContent?.includes('in 1 other file'));
    expect(legacy).toBeDefined();
    await act(async () => legacy!.click());
    expect(onOtherFileAnnotationsClick).toHaveBeenCalledTimes(1);
  });
});
