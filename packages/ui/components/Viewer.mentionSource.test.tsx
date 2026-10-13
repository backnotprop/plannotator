/**
 * `mentionSource` threaded through the REAL Viewer (DOM-gated).
 *
 * What these catch: a `mentionSource` that reaches only one of the viewer's
 * two composers (the text-selection one and the global/code-block one), a
 * submit that drops the picked ids on the floor instead of putting them on the
 * annotation `onAddAnnotation` receives, and — the one that matters for
 * Plannotator, which passes no source — an annotation that grows a `mentions`
 * key, or a composer that grows an `@` menu, when no host supplied one.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Annotation } from '../types';
import type { MentionPerson, MentionSource } from '../utils/mentions';

const hasDom = typeof document !== 'undefined';
// Viewer and the parser read the DOM at module scope; load lazily so this file
// stays inert in the DOM-less default `bun test` run.
const viewerModule = hasDom ? await import('./Viewer') : null;
const parserModule = hasDom ? await import('../utils/parser') : null;

const PEOPLE: MentionPerson[] = [
  { id: 'user_1', kind: 'user', label: 'Marcus Chen', detail: 'marcus@example.com', canOpen: true },
  { id: 'user_2', kind: 'user', label: 'Dana Ruiz', detail: 'dana@example.com', canOpen: true },
];

const MARKDOWN = '# Actions\n\nAnnotate this paragraph.\n';

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  if (hasDom) {
    document.body.replaceChildren();
    window.getSelection()?.removeAllRanges();
  }
});

async function mountViewer(
  mentionSource: MentionSource | undefined,
  added: Annotation[],
): Promise<HTMLElement> {
  const Viewer = viewerModule!.Viewer;
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(
      <Viewer
        blocks={parserModule!.parseMarkdownToBlocks(MARKDOWN)}
        markdown={MARKDOWN}
        annotations={[]}
        onAddAnnotation={(ann) => added.push(ann)}
        onSelectAnnotation={() => {}}
        selectedAnnotationId={null}
        mode="comment"
        inputMethod="drag"
        taterMode={false}
        stickyActions={false}
        disableCodePathValidation
        vimModeEnabled
        mentionSource={mentionSource}
      />,
    );
  });
  return host!;
}

function keydown(target: HTMLElement, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

/**
 * Open the TEXT-SELECTION composer the way the keyboard does in the real app:
 * `m` opens the shared annotation toolbar on the Vim target, and typing a
 * letter at it is the toolbar's type-to-comment gesture. This is the composer
 * `useAnnotationHighlighter` owns (Viewer's first CommentPopover mount).
 */
async function openSelectionComposer(container: HTMLElement): Promise<void> {
  const article = container.querySelector<HTMLElement>('[data-vim-mode="enabled"]');
  if (!article) throw new Error('Vim article missing');
  await act(async () => { article.focus(); });
  await act(async () => { keydown(article, 'm'); });
  await act(async () => { keydown(article, 'x'); });
}

/** Open the GLOBAL composer (Viewer's second CommentPopover mount). */
async function openGlobalComposer(container: HTMLElement): Promise<void> {
  const button = container.querySelector<HTMLButtonElement>('button[title="Add global comment"]');
  if (!button) throw new Error('Global comment button missing');
  await act(async () => { button.click(); });
}

function textarea(): HTMLTextAreaElement {
  const el = document.querySelector<HTMLTextAreaElement>('[data-comment-popover] textarea');
  if (!el) throw new Error('CommentPopover textarea did not render');
  return el;
}

async function type(el: HTMLTextAreaElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
  await act(async () => {
    if (setter) setter.call(el, value);
    else el.value = value;
    el.selectionStart = el.selectionEnd = value.length;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { key: value.slice(-1) || 'a', bubbles: true }));
  });
}

async function press(el: HTMLTextAreaElement, key: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  await act(async () => { el.dispatchEvent(event); });
  return event;
}

function picker(): Element | null {
  return document.querySelector('[data-mention-picker]');
}

/** Type `@dan`, pick Dana Ruiz from the menu, and submit the composer. */
async function mentionAndSubmit(): Promise<void> {
  const el = textarea();
  await type(el, 'ask @dan');
  expect(picker()).not.toBeNull();
  await press(el, 'ArrowDown');
  await press(el, 'Enter');
  expect(el.value).toBe('ask @Dana Ruiz ');
  await press(el, 'Enter', { metaKey: true });
}

describe.if(hasDom)('Viewer mentionSource', () => {
  test('the selection composer opens the picker and puts the ids on the annotation', async () => {
    const added: Annotation[] = [];
    const container = await mountViewer({ people: PEOPLE }, added);
    await openSelectionComposer(container);
    await mentionAndSubmit();

    expect(added).toHaveLength(1);
    expect(added[0]?.mentions).toEqual(['user_2']);
    // The body carries the readable token; the id is what the host reads.
    expect(added[0]?.text).toContain('@Dana Ruiz');
  });

  test('the global composer opens the picker and puts the ids on the annotation', async () => {
    const added: Annotation[] = [];
    const container = await mountViewer({ people: PEOPLE }, added);
    await openGlobalComposer(container);
    await mentionAndSubmit();

    expect(added).toHaveLength(1);
    expect(added[0]?.mentions).toEqual(['user_2']);
    // The body carries the readable token; the id is what the host reads.
    expect(added[0]?.text).toContain('@Dana Ruiz');
  });

  test('deleting the token before submit untags that person', async () => {
    const added: Annotation[] = [];
    const container = await mountViewer({ people: PEOPLE }, added);
    await openGlobalComposer(container);
    const el = textarea();
    await type(el, 'ask @dan');
    await press(el, 'ArrowDown');
    await press(el, 'Enter');
    await type(el, 'never mind');
    await press(el, 'Enter', { metaKey: true });

    // Zero surviving ids must not become an empty array on the annotation:
    // the key is present only when a person is actually named.
    expect(added).toHaveLength(1);
    expect('mentions' in (added[0] as object)).toBe(false);
  });

  test('WITHOUT a source both composers stay as they were: no menu, no mentions key', async () => {
    const added: Annotation[] = [];
    const container = await mountViewer(undefined, added);

    await openSelectionComposer(container);
    const selectionEl = textarea();
    await type(selectionEl, 'ask @dan');
    expect(picker()).toBeNull();
    await press(selectionEl, 'Enter', { metaKey: true });

    await openGlobalComposer(container);
    const globalEl = textarea();
    await type(globalEl, 'ask @dan');
    expect(picker()).toBeNull();
    await press(globalEl, 'Enter', { metaKey: true });

    expect(added).toHaveLength(2);
    for (const ann of added) expect('mentions' in (ann as object)).toBe(false);
  });

  test('the default Viewer renders no mention DOM at all', async () => {
    const added: Annotation[] = [];
    const container = await mountViewer(undefined, added);
    await openGlobalComposer(container);

    // Sentinel for "the composer mounted", so the absence assertions below
    // are about the mention surface and not about an empty render.
    expect(document.querySelector('[data-comment-popover]')).not.toBeNull();
    expect(document.querySelector('[data-mention-picker]')).toBeNull();
    expect(document.querySelector('[data-mention-option]')).toBeNull();
    expect(document.querySelector('[data-mention-empty]')).toBeNull();
    expect(container.querySelector('[data-mention-picker]')).toBeNull();
  });
});
