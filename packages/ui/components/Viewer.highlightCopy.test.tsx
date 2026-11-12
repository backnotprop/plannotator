/**
 * Ctrl+C / Cmd+C in the markdown Viewer once the yellow pending highlight is up, driven through
 * the REAL Viewer and web-highlighter (DOM-gated, DOM_TESTS=1).
 */
import { afterEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { EditorMode } from '../types';

const hasDom = typeof document !== 'undefined';
const viewerModule = hasDom ? await import('./Viewer') : null;
const parserModule = hasDom ? await import('../utils/parser') : null;
const richCopyPolicy = hasDom ? await import('../utils/richCopyPolicy') : null;

const MARKDOWN = 'The backoff is **two, four** and eight seconds.\n';

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  if (hasDom) {
    richCopyPolicy!.resetRichCopyEnabled();
    document.body.replaceChildren();
    window.getSelection()?.removeAllRanges();
  }
});

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });

const INBOX_MESSAGE = { textComments: true, answerOnly: true, clickAWord: false, maxWidth: null } as const;

async function mount(mode: EditorMode = 'selection', extra: Record<string, unknown> = {}) {
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
        onAddAnnotation={() => {}}
        onSelectAnnotation={() => {}}
        selectedAnnotationId={null}
        mode={mode}
        taterMode={false}
        stickyActions={false}
        disableCodePathValidation
        {...extra}
      />,
    );
  });
  await settle();
  return host!;
}

async function select(scope: HTMLElement) {
  const texts: Text[] = [];
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) texts.push(n as Text);
  const start = texts.find((t) => t.textContent!.includes('backoff'))!;
  const end = texts.find((t) => t.textContent!.includes('four'))!;
  const range = document.createRange();
  range.setStart(start, start.textContent!.indexOf('backoff'));
  range.setEnd(end, end.textContent!.indexOf('four') + 4);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  await act(async () => {
    (start.parentElement!.closest('article') ?? scope).dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
  });
  await settle();
}

function copyAt(target: EventTarget) {
  const data = new Map<string, string>();
  const event = new Event('copy', { bubbles: true, cancelable: true }) as ClipboardEvent;
  Object.defineProperty(event, 'clipboardData', { value: { setData: (k: string, v: string) => data.set(k, v), getData: (k: string) => data.get(k) ?? '' } });
  target.dispatchEvent(event);
  return { prevented: event.defaultPrevented, plain: data.get('text/plain'), html: data.get('text/html') };
}

async function openComposerFromToolbar(el: HTMLElement) {
  await select(el);
  const comment = document.querySelector<HTMLButtonElement>('.annotation-toolbar button.text-annotation-comment');
  if (!comment) throw new Error('no toolbar Comment button');
  await act(async () => comment.click());
  await settle();
  const area = document.querySelector<HTMLTextAreaElement>('[data-comment-popover] textarea');
  if (!area) throw new Error('no composer');
  return area;
}

const SELECTED = 'backoff is two, four';

test.skipIf(!hasDom)('toolbar up: Ctrl+C copies the highlighted text', async () => {
  const el = await mount();
  await select(el);
  expect(copyAt(document.body)).toMatchObject({ prevented: true, plain: SELECTED });
});

test.skipIf(!hasDom)('composer open, focus in its empty textarea: Ctrl+C copies the highlighted text', async () => {
  const el = await mount();
  const area = await openComposerFromToolbar(el);
  area.focus();
  expect(copyAt(area)).toMatchObject({ prevented: true, plain: SELECTED });
});

test.skipIf(!hasDom)('composer open, focus on the page outside it: Ctrl+C copies the highlighted text', async () => {
  const el = await mount();
  const area = await openComposerFromToolbar(el);
  area.blur();
  expect(copyAt(document.body)).toMatchObject({ prevented: true, plain: SELECTED });
});

test.skipIf(!hasDom)('Comment mode opens the composer with no toolbar; Ctrl+C there copies the highlighted text', async () => {
  const el = await mount('comment');
  await select(el);
  const area = document.querySelector<HTMLTextAreaElement>('[data-comment-popover] textarea')!;
  expect(document.querySelector('.annotation-toolbar')).toBeNull();
  expect(copyAt(area)).toMatchObject({ prevented: true, plain: SELECTED });
});

test.skipIf(!hasDom)('text the person selected in the textarea copies natively', async () => {
  const el = await mount();
  const area = await openComposerFromToolbar(el);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, 'Why three times?');
    area.dispatchEvent(new Event('input', { bubbles: true }));
  });
  area.focus();
  area.setSelectionRange(4, 15);
  expect(copyAt(area)).toMatchObject({ prevented: false, plain: undefined });
});

test.skipIf(!hasDom)('with rich copy on, the composer-stage copy is still plain text, as at the toolbar stage', async () => {
  richCopyPolicy!.setRichCopyEnabled(true);
  const el = await mount();
  const area = await openComposerFromToolbar(el);
  expect(copyAt(area)).toEqual({ prevented: true, plain: SELECTED, html: undefined });
});

test.skipIf(!hasDom)('with no highlight, Ctrl+C is the browser\'s own', async () => {
  await mount();
  expect(copyAt(document.body)).toMatchObject({ prevented: false, plain: undefined });
});

test.skipIf(!hasDom)('after the composer closes, Ctrl+C no longer copies the old highlight', async () => {
  const el = await mount();
  const area = await openComposerFromToolbar(el);
  await act(async () => {
    area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  });
  await settle();
  expect(document.querySelector('[data-comment-popover]')).toBeNull();
  expect(copyAt(document.body)).toMatchObject({ prevented: false, plain: undefined });
});

test.skipIf(!hasDom)('a field elsewhere on the page keeps its own copy while a composer with words stays open', async () => {
  const el = await mount();
  const area = await openComposerFromToolbar(el);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, 'Why three?');
    area.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const reply = document.createElement('textarea');
  document.body.appendChild(reply);
  reply.focus();
  expect(copyAt(reply)).toMatchObject({ prevented: false, plain: undefined });
  // Back in the composer, a caret after the typed words still copies the highlight.
  area.focus();
  area.setSelectionRange(10, 10);
  expect(copyAt(area)).toMatchObject({ prevented: true, plain: SELECTED });
});

test.skipIf(!hasDom)('an Inbox thread message (click-a-word off): toolbar and composer stages copy the highlighted text', async () => {
  const el = await mount('selection', INBOX_MESSAGE);
  await select(el);
  expect(copyAt(document.body)).toMatchObject({ prevented: true, plain: SELECTED });
  const comment = document.querySelector<HTMLButtonElement>('.annotation-toolbar button.text-annotation-comment');
  expect(comment).not.toBeNull();
  await act(async () => comment!.click());
  await settle();
  const area = document.querySelector<HTMLTextAreaElement>('[data-comment-popover] textarea')!;
  area.focus();
  expect(copyAt(area)).toMatchObject({ prevented: true, plain: SELECTED });
});
