/**
 * Consumer-surface contract for AnnotationPanel's host props:
 *   - readOnly hides every mutation affordance (delete/edit on all card kinds)
 *   - renderCardFooter renders a per-card slot whose interactions do NOT
 *     select the card
 * Both default to today's behavior (mutable, no footer).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';

import { AnnotationPanel } from './AnnotationPanel';
import { AnnotationType, type Annotation } from '../types';

const hasDom = typeof document !== 'undefined';

const annotation: Annotation = {
  id: 'a1',
  blockId: 'b1',
  startOffset: 0,
  endOffset: 5,
  type: AnnotationType.COMMENT,
  text: 'a note',
  originalText: 'hello',
  createdA: 1,
};

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
    await act(async () => {
      root!.unmount();
    });
    root = null;
  }
  host?.remove();
  host = null;
  if (hasDom) document.body.innerHTML = '';
});

const baseProps = {
  isOpen: true,
  annotations: [annotation],
  blocks: [],
  onSelect: () => {},
  onDelete: () => {},
  selectedId: null,
};

describe('AnnotationPanel consumer props', () => {
  test.skipIf(!hasDom)('default renders the delete affordance (today’s behavior)', async () => {
    await mount(<AnnotationPanel {...baseProps} />);
    expect(document.querySelector('button[title="Delete annotation"]')).not.toBeNull();
  });

  test.skipIf(!hasDom)('readOnly hides delete and edit affordances', async () => {
    await mount(
      <AnnotationPanel
        {...baseProps}
        readOnly
        onEdit={() => {}}
      />,
    );
    expect(document.querySelector('button[title="Delete annotation"]')).toBeNull();
    expect(document.querySelector('button[title="Edit annotation"]')).toBeNull();
  });

  test.skipIf(!hasDom)('renderCardFooter renders per-card and does not select the card', async () => {
    const selected: string[] = [];
    let footerClicks = 0;
    await mount(
      <AnnotationPanel
        {...baseProps}
        onSelect={(id) => selected.push(id)}
        renderCardFooter={(a) => (
          <button type="button" data-testid="reply" onClick={() => { footerClicks++; }}>
            reply to {a.id}
          </button>
        )}
      />,
    );

    const slot = document.querySelector('[data-annotation-card-footer="true"]');
    expect(slot).not.toBeNull();
    expect(slot!.textContent).toContain('reply to a1');

    const replyBtn = document.querySelector('[data-testid="reply"]') as HTMLButtonElement;
    await act(async () => {
      replyBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(footerClicks).toBe(1);
    // The click bubbled only to the slot wrapper, which stops propagation —
    // the card's onSelect must not fire.
    expect(selected).toHaveLength(0);
  });

  test.skipIf(!hasDom)('no footer prop → no slot rendered', async () => {
    await mount(<AnnotationPanel {...baseProps} />);
    expect(document.querySelector('[data-annotation-card-footer="true"]')).toBeNull();
  });
});
