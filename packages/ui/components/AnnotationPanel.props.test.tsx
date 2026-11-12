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

  test.skipIf(!hasDom)('readOnly hides direct-edit discard but keeps the host footer slot', async () => {
    await mount(
      <AnnotationPanel
        {...baseProps}
        readOnly
        directEdits={[{
          id: 'plan',
          added: 1,
          removed: 0,
          diffText: '@@ -1 +1 @@\n-old\n+new',
          onDiscard: () => {},
        }]}
        renderCardFooter={() => <button type="button">Reply</button>}
      />,
    );
    expect(document.body.textContent).not.toContain('Discard');
    expect(document.querySelector('[data-annotation-card-footer="true"]')).not.toBeNull();
    expect(document.body.textContent).toContain('Reply');
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
    expect(selected).toHaveLength(0);
  });

  test.skipIf(!hasDom)('no footer prop → no slot rendered', async () => {
    await mount(<AnnotationPanel {...baseProps} />);
    expect(document.querySelector('[data-annotation-card-footer="true"]')).toBeNull();
  });

  test.skipIf(!hasDom)('embedded presentation keeps the timeline and omits panel chrome', async () => {
    await mount(<AnnotationPanel {...baseProps} presentation="embedded" />);
    const panel = document.querySelector<HTMLElement>('[data-annotation-panel="true"]');
    expect(panel?.className).toContain('h-full min-h-0 w-full flex-1');
    expect(document.body.textContent).not.toContain('Annotations');
    expect(document.querySelector('[data-annotation-id="a1"]')).not.toBeNull();
    expect(document.querySelector('.fixed.inset-0')).toBeNull();
  });
});

describe('AnnotationPanel host section at the timeline foot', () => {
  const base = { isOpen: true, blocks: [], onSelect: () => {}, onDelete: () => {}, selectedId: null };

  test.skipIf(!hasDom)('timelineFooter sits inside the scroll area, after the cards, so they scroll as one', async () => {
    await mount(<AnnotationPanel {...base} annotations={[annotation]} timelineFooter={<div data-host-foot="" />} />);
    const foot = host!.querySelector('[data-host-foot]')!;
    const card = host!.querySelector('[data-annotation-id="a1"]')!;
    expect(foot.parentElement === card.closest('.flex-col.gap-1\\.5')).toBe(true);
    expect(Boolean(card.compareDocumentPosition(foot) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
  });

  test.skipIf(!hasDom)('hideEmptyMessage drops the empty message and keeps the way to other files; absent, the message stays', async () => {
    await mount(<AnnotationPanel {...base} annotations={[]} />);
    expect(host!.textContent).toContain('No annotations yet');
    act(() => root?.unmount());
    host?.remove();

    await mount(<AnnotationPanel {...base} annotations={[]} hideEmptyMessage />);
    expect(host!.textContent).not.toContain('No annotations yet');
    act(() => root?.unmount());
    host?.remove();

    const other = { path: '/other.md', label: 'other.md', isCurrent: false, annotations: [annotation] };
    await mount(<AnnotationPanel {...base} annotations={[]} hideEmptyMessage annotationScope="current" onAnnotationScopeChange={() => {}} documentGroups={[other] as never} />);
    expect(host!.textContent).not.toContain('No annotations yet');
    expect(host!.querySelector('[data-annotation-view-all]') === null).toBe(false);
  });
});
