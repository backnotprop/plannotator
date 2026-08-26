/**
 * Panel threading (DOM-gated): a reply renders indented directly under its
 * parent regardless of interleaving timestamps, an orphan reply renders as
 * a top-level card, and a list without replies renders no reply wrapper
 * (the additive-field guarantee).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AnnotationType, type Annotation } from '../types';

const hasDom = typeof document !== 'undefined';
const panelModule = hasDom ? await import('./AnnotationPanel') : null;
const AnnotationPanel = panelModule?.AnnotationPanel as NonNullable<typeof panelModule>['AnnotationPanel'];

function ann(id: string, createdA: number, extra: Partial<Annotation> = {}): Annotation {
  return { id, blockId: 'blk-a', startOffset: 0, endOffset: 3, type: AnnotationType.COMMENT, text: `text ${id}`, originalText: 'abc', createdA, ...extra };
}

let root: Root | null = null;
let host: HTMLElement | null = null;

async function render(annotations: Annotation[]) {
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(
      <AnnotationPanel isOpen annotations={annotations} blocks={[]} onSelect={() => {}} onDelete={() => {}} selectedId={null} />,
    );
  });
  return host;
}

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
});

describe.skipIf(!hasDom)('AnnotationPanel inReplyTo threading', () => {
  test('a reply sits right under its parent, indented, even when another comment was created in between', async () => {
    const el = await render([ann('p', 1), ann('other', 2), ann('r', 3, { inReplyTo: 'p' })]);
    const ids = [...el.querySelectorAll('[data-annotation-id]')].map((n) => n.getAttribute('data-annotation-id'));
    expect(ids).toEqual(['p', 'r', 'other']);
    const reply = el.querySelector('[data-annotation-reply="true"]');
    expect(reply?.querySelector('[data-annotation-id="r"]')).not.toBeNull();
    expect(el.querySelectorAll('[data-annotation-reply="true"]').length).toBe(1);
  });

  test('an orphan reply renders as a top-level card', async () => {
    const el = await render([ann('a', 1), ann('r', 2, { inReplyTo: 'gone' })]);
    expect(el.querySelectorAll('[data-annotation-reply="true"]').length).toBe(0);
    expect([...el.querySelectorAll('[data-annotation-id]')].map((n) => n.getAttribute('data-annotation-id'))).toEqual(['a', 'r']);
  });

  test('without replies there is no reply wrapper and the order is creation order', async () => {
    const el = await render([ann('b', 2), ann('a', 1)]);
    expect(el.querySelectorAll('[data-annotation-reply="true"]').length).toBe(0);
    expect([...el.querySelectorAll('[data-annotation-id]')].map((n) => n.getAttribute('data-annotation-id'))).toEqual(['a', 'b']);
  });
});
