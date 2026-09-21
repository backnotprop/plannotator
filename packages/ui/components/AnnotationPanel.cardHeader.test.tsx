/**
 * The `renderCardHeader` slot against the REAL AnnotationPanel (DOM-gated).
 *
 * What these catch: a header slot that lands outside the card's header row
 * (where a status stamp would sit under the quote instead of beside the
 * type word), a click inside it that selects the card underneath — the
 * defect `renderCardFooter` already guards against — a slot that disappears
 * on a read-only panel or in the All-files grouped view, and the one that
 * matters for Plannotator: a wrapper element existing when no host supplied
 * the prop.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { AnnotationPanel } from './AnnotationPanel';
import { AnnotationType, type Annotation } from '../types';

const hasDom = typeof document !== 'undefined';

const ann = (over: Partial<Annotation> & { id: string }): Annotation => ({
  blockId: 'b1',
  startOffset: 0,
  endOffset: 5,
  type: AnnotationType.COMMENT,
  originalText: 'hello world',
  createdA: 1700000000000,
  author: 'brave-yam-tater',
  ...over,
});

const CARDS: Annotation[] = [
  ann({ id: 'a1', text: 'a comment' }),
  ann({ id: 'a2', type: AnnotationType.DELETION, originalText: 'strike me', createdA: 1700000001000 }),
  ann({ id: 'a3', type: AnnotationType.GLOBAL_COMMENT, text: 'a global note', originalText: '', createdA: 1700000002000 }),
];

let root: Root | null = null;
let host: HTMLElement | null = null;

async function mount(ui: React.ReactElement) {
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(ui);
  });
  await act(async () => {});
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  host?.remove();
  host = null;
  if (hasDom) document.body.replaceChildren();
});

const baseProps = {
  isOpen: true,
  blocks: [],
  annotations: CARDS,
  onDelete: () => {},
  onEdit: () => {},
  selectedId: null,
};

const stamp = (a: Annotation) => (
  <button type="button" data-test-stamp={a.id}>
    Resolved
  </button>
);

function slots(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-annotation-card-header]'));
}

describe.if(hasDom)('AnnotationPanel renderCardHeader', () => {
  test('absent: no header-slot wrapper exists on any card', async () => {
    await mount(<AnnotationPanel {...baseProps} onSelect={() => {}} />);
    expect(document.querySelectorAll('[data-annotation-id]').length).toBe(3);
    expect(slots().length).toBe(0);
  });

  test('renders the host node inside each card header row, beside the type word', async () => {
    await mount(<AnnotationPanel {...baseProps} onSelect={() => {}} renderCardHeader={stamp} />);
    const cards = Array.from(document.querySelectorAll<HTMLElement>('[data-annotation-id]'));
    expect(cards.map((c) => c.getAttribute('data-annotation-id'))).toEqual(['a1', 'a2', 'a3']);
    for (const card of cards) {
      const slot = card.querySelector<HTMLElement>('[data-annotation-card-header]');
      expect(slot).not.toBeNull();
      expect(slot!.querySelector(`[data-test-stamp="${card.getAttribute('data-annotation-id')}"]`)).not.toBeNull();
      // The header row is the card's FIRST element child (type word, chips,
      // author · time). A slot rendered anywhere else would still be "in the
      // card" while looking nothing like a stamp.
      const headerRow = card.firstElementChild as HTMLElement;
      expect(slot!.parentElement).toBe(headerRow);
      // Deliberately after the timestamp: the stamp reads as part of the meta
      // line, and the built-in actions keep the right edge (ml-auto).
      const kids = Array.from(headerRow.children);
      expect(kids.indexOf(slot!)).toBeGreaterThan(0);
    }
  });

  test('a click inside the slot does not select the card', async () => {
    const selected: string[] = [];
    await mount(
      <AnnotationPanel {...baseProps} onSelect={(id) => selected.push(id)} renderCardHeader={stamp} />,
    );
    const button = document.querySelector<HTMLButtonElement>('[data-test-stamp="a1"]')!;
    await act(async () => { button.click(); });
    expect(selected).toEqual([]);
    // The card itself still selects, so the stopPropagation is scoped.
    const card = document.querySelector<HTMLElement>('[data-annotation-id="a1"]')!;
    await act(async () => { card.click(); });
    expect(selected).toEqual(['a1']);
  });

  test('renders under readOnly, where the built-in actions are gone', async () => {
    await mount(
      <AnnotationPanel {...baseProps} onSelect={() => {}} readOnly renderCardHeader={stamp} />,
    );
    expect(document.querySelector('button[title="Delete annotation"]')).toBeNull();
    expect(slots().length).toBe(3);
  });

  test('All-files view: the slot rides the open document’s cards', async () => {
    await mount(
      <AnnotationPanel
        {...baseProps}
        onSelect={() => {}}
        annotationScope="all"
        onAnnotationScopeChange={() => {}}
        documentGroups={[
          { path: '', label: 'notes.md', isCurrent: true, annotations: [CARDS[0]] },
          { path: 'other.md', label: 'other.md', isCurrent: false, annotations: [CARDS[1]] },
        ]}
        onSelectInDocument={() => {}}
        onDeleteInDocument={() => {}}
        onEditInDocument={() => {}}
        renderCardHeader={stamp}
      />,
    );
    // Same rule the footer slot follows: host slots are built for the open
    // document's state, so another document's cards do not get one.
    expect(slots().length).toBe(1);
    expect(document.querySelector('[data-test-stamp="a1"]')).not.toBeNull();
    expect(document.querySelector('[data-test-stamp="a2"]')).toBeNull();
  });

  test('a host returning null for a card renders no wrapper for it', async () => {
    await mount(
      <AnnotationPanel
        {...baseProps}
        onSelect={() => {}}
        renderCardHeader={(a) => (a.id === 'a1' ? stamp(a) : null)}
      />,
    );
    expect(slots().length).toBe(1);
  });
});
