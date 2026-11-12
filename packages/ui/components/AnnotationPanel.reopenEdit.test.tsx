import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { AnnotationPanel } from './AnnotationPanel';
import { AnnotationType, type Annotation, type CodeAnnotation } from '../types';

const hasDom = typeof document !== 'undefined';

const card = (id: string, text: string): Annotation => ({
  id,
  blockId: 'b1',
  startOffset: 0,
  endOffset: 5,
  type: AnnotationType.COMMENT,
  text,
  originalText: `quote ${id}`,
  createdA: 1700000000000 + id.length,
  author: 'brave-yam-tater',
});
const CARDS = [card('first', 'first saved'), card('second', 'second saved')];
const CODE: CodeAnnotation = { id: 'codeOne', type: 'comment' as never, filePath: 'a.ts', lineStart: 2, lineEnd: 2, side: 'new', text: 'code saved', createdAt: 1 } as CodeAnnotation;

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  host?.remove();
  host = null;
  if (hasDom) document.body.replaceChildren();
});

function panel(reopenEdit: { id: string; text: string } | null | undefined, edits: Array<[string, Partial<Annotation>]>) {
  return (
    <AnnotationPanel
      isOpen
      blocks={[]}
      annotations={CARDS}
      codeAnnotations={[CODE]}
      selectedId={null}
      onSelect={() => {}}
      onDelete={() => {}}
      onEdit={(id, updates) => { edits.push([id, updates]); }}
      onEditCodeAnnotation={(id, updates) => { edits.push([id, { text: updates.text }]); }}
      reopenEdit={reopenEdit}
    />
  );
}

async function mount(node: React.ReactElement) {
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(node);
  });
  await act(async () => {});
  return (next: React.ReactElement) => act(async () => { root!.render(next); });
}

const box = (id: string) => document.querySelector<HTMLTextAreaElement>(`[data-annotation-id="${id}"] textarea`);
const press = (el: HTMLTextAreaElement, key: string, init: KeyboardEventInit = {}) =>
  act(async () => { el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })); });

describe.if(hasDom)('AnnotationPanel reopenEdit', () => {
  test('the named card opens its edit box holding the words, caret after them; Save edits it; the other card stays shut', async () => {
    const edits: Array<[string, Partial<Annotation>]> = [];
    const request = { id: 'second', text: 'second, rewritten' };
    const rerender = await mount(panel(request, edits));
    const el = box('second');
    expect(el?.value).toBe('second, rewritten');
    expect(el!.selectionStart).toBe('second, rewritten'.length);
    expect(el!.selectionEnd).toBe('second, rewritten'.length);
    expect(box('first')).toBeNull();
    expect(edits).toEqual([]);

    await press(el!, 'Enter', { metaKey: true, ctrlKey: true });
    expect(edits).toEqual([['second', { text: 'second, rewritten' }]]);
    expect(box('second')).toBeNull();
    await rerender(panel(request, edits));
    expect(box('second')).toBeNull();
  });

  test('a code card opens the same way', async () => {
    const edits: Array<[string, Partial<Annotation>]> = [];
    await mount(panel({ id: 'codeOne', text: 'code, rewritten' }, edits));
    expect(box('codeOne')?.value).toBe('code, rewritten');
    expect(edits).toEqual([]);
  });

  test('without the prop no card opens by itself', async () => {
    const edits: Array<[string, Partial<Annotation>]> = [];
    await mount(panel(undefined, edits));
    expect(document.querySelector('[data-annotation-id] textarea')).toBeNull();
  });
});
