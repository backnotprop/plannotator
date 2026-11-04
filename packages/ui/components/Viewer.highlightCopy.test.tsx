/**
 * Ctrl+C / Cmd+C in the markdown Viewer once the yellow pending highlight is
 * up, driven through the REAL Viewer and web-highlighter (DOM-gated,
 * DOM_TESTS=1).
 *
 * Failures to catch: with the selection's composer open (focus in its empty
 * textarea, or on the page outside it) the copy carries nothing; Comment mode
 * (composer with no toolbar) carries nothing; the toolbar stage stops copying;
 * the copy grows an html part (rich text is the toolbar's Copy button alone,
 * the owner's call on #2191); or text the person selected in the textarea is
 * overwritten by the highlight.
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

async function mount(mode: EditorMode = 'selection') {
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
      />,
    );
  });
  await settle();
  return host!;
}

/** Select from "backoff" through "four", then let the viewer hear the pointer go up. */
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

/** What a Ctrl+C at `target` puts on the clipboard (the browser fires `copy`). */
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
