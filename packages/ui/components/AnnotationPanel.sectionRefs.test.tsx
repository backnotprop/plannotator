/**
 * `#Heading` links in comment text (DOM-gated), wired the way the editor app
 * wires them: panel `onNavigateAnchor` → Viewer handle `scrollToAnchor`.
 *
 * Failures to catch: a link that scrolls nowhere (panel and Viewer disagree on
 * the anchor), a click that also selects the card, and links appearing for a
 * host that did not opt in.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ScrollViewportProvider } from '../hooks/useScrollViewport';
import { AnnotationType, type Annotation, type Block } from '../types';

const hasDom = typeof document !== 'undefined';
const viewerModule = hasDom ? await import('./Viewer') : null;
const panelModule = hasDom ? await import('./AnnotationPanel') : null;
const Viewer = viewerModule?.Viewer as typeof import('./Viewer')['Viewer'];
const AnnotationPanel = panelModule?.AnnotationPanel as typeof import('./AnnotationPanel')['AnnotationPanel'];
type ViewerHandle = import('./Viewer').ViewerHandle;

const blocks: Block[] = [
  { id: 'h1', type: 'heading', content: 'Plan', level: 1, order: 0, startLine: 1 },
  { id: 'p1', type: 'paragraph', content: 'Body text.', order: 1, startLine: 3 },
  { id: 'h2', type: 'heading', content: 'Rollout steps', level: 2, order: 2, startLine: 5 },
];

const comment: Annotation = {
  id: 'a1',
  blockId: 'p1',
  startOffset: 0,
  endOffset: 4,
  type: AnnotationType.COMMENT,
  text: 'This conflicts with #Rollout steps below.',
  originalText: 'Body',
  createdA: 1,
};

let root: Root | null = null;
let host: HTMLElement | null = null;

async function mount(ui: React.ReactElement): Promise<HTMLElement> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(ui));
  return host;
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  host = null;
  if (hasDom) document.body.replaceChildren();
});

describe.if(hasDom)('AnnotationPanel #Heading links', () => {
  test('clicking the link scrolls the document to the heading and does not select the card', async () => {
    const viewport = document.createElement('div');
    document.body.appendChild(viewport);
    const viewerRef = createRef<ViewerHandle>();
    const selected: string[] = [];

    const el = await mount(
      <ScrollViewportProvider viewport={viewport}>
        <Viewer
          ref={viewerRef}
          blocks={blocks}
          markdown={'# Plan\n\nBody text.\n\n## Rollout steps'}
          annotations={[]}
          onAddAnnotation={() => {}}
          onSelectAnnotation={() => {}}
          selectedAnnotationId={null}
          mode="selection"
          inputMethod="drag"
          taterMode={false}
          stickyActions={false}
          disableCodePathValidation
        />
        <AnnotationPanel
          isOpen
          annotations={[comment]}
          blocks={blocks}
          selectedId={null}
          onSelect={(id) => selected.push(id)}
          onDelete={() => {}}
          onNavigateAnchor={(hash) => viewerRef.current?.scrollToAnchor?.(hash)}
        />
      </ScrollViewportProvider>,
    );

    const target = document.getElementById('rollout-steps');
    if (!target) throw new Error('Expected the Viewer to render the heading anchor');
    viewport.getBoundingClientRect = () => new DOMRect(0, 0, 800, 600);
    target.getBoundingClientRect = () => new DOMRect(0, 450, 400, 30);
    let requestedTop: number | undefined;
    viewport.scrollTo = (options?: ScrollToOptions | number, y?: number) => {
      requestedTop = typeof options === 'number' ? y : options?.top;
    };

    const link = el.querySelector<HTMLAnchorElement>('a[href="#rollout-steps"]');
    if (!link) throw new Error('Expected a link for #Rollout steps');
    expect(link.textContent).toBe('Rollout steps');
    expect(link.closest('p')?.textContent).toBe('This conflicts with Rollout steps below.');
    const hashBefore = window.location.hash;

    await act(async () => link.click());

    expect(requestedTop).toBe(450);
    expect(selected).toEqual([]);
    expect(window.location.hash).toBe(hashBefore);
  });

  test('a host without onNavigateAnchor gets plain comment text', async () => {
    const el = await mount(
      <AnnotationPanel
        isOpen
        annotations={[comment]}
        blocks={blocks}
        selectedId={null}
        onSelect={() => {}}
        onDelete={() => {}}
      />,
    );
    const body = Array.from(el.querySelectorAll('p')).find((p) => p.textContent === comment.text);
    expect(body).toBeTruthy();
    expect(body!.querySelector('a')).toBeNull();
  });

  test("another file's comment in the all-files view gets no link", async () => {
    const other: Annotation = { ...comment, id: 'o1' };
    const el = await mount(
      <AnnotationPanel
        isOpen
        annotations={[comment]}
        blocks={blocks}
        selectedId={null}
        onSelect={() => {}}
        onDelete={() => {}}
        onNavigateAnchor={() => {}}
        annotationScope="all"
        onAnnotationScopeChange={() => {}}
        documentGroups={[
          { path: 'open.md', label: 'open.md', annotations: [comment], isCurrent: true },
          { path: 'other.md', label: 'other.md', annotations: [other], isCurrent: false },
        ]}
      />,
    );
    const card = (id: string) => el.querySelector(`[data-annotation-id="${id}"]`);
    expect(card('a1')?.querySelector('a[href="#rollout-steps"]')).toBeTruthy();
    expect(card('o1')).toBeTruthy();
    expect(card('o1')!.querySelector('a')).toBeNull();
  });
});
