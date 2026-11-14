/**
 * Visible comment drafts (`configurePlannotatorUI({ visibleCommentDrafts })`), through the REAL Viewer and
 * web-highlighter (DOM_TESTS=1). Approval "inbox-comment-box": a floating "Draft" badge under the words.
 *
 * Failures to catch:
 * - a comment closed with words leaves no trace on the page (the words only come back on the exact same selection);
 * - the badge does not open the box again with the words, or stays after it opened;
 * - a box closed empty leaves a mark or a badge behind;
 * - a draft is gone once its document is taken off screen and shown again (another thread and back, a file closed);
 * - selecting other words while a box holds words throws its words' mark away with no badge;
 * - the same words picked again by hand make a second badge, one left over after the comment went;
 * - focus is lost (on the page) after a badge opened the box and Escape closed it again;
 * - the badge adds text to the document (a copy, a text search or a restore would meet "Draft");
 * - a host that does not opt in gets a mark or a badge (it must close exactly as before: highlight gone).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { resetCommentCardPolicy, setCommentCardEnabled, setVisibleCommentDrafts } from '../utils/commentCardPolicy';

const hasDom = typeof document !== 'undefined';
const viewerModule = hasDom ? await import('./Viewer') : null;
const parserModule = hasDom ? await import('../utils/parser') : null;

const PHRASE = 'waits for an event';
const OTHER = 'Another paragraph';
const MARKDOWN = ['# Routines', '', `The routine ${PHRASE} that only fires on a refund.`, '', `${OTHER}.`, ''].join('\n');

let root: Root | null = null;
let host: HTMLElement | null = null;
let originalRects: typeof HTMLElement.prototype.getClientRects | undefined;

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });

beforeEach(() => {
  if (!hasDom) return;
  // happy-dom lays nothing out: a highlight's pieces report one line, so the badge has an end to hang under.
  originalRects = HTMLElement.prototype.getClientRects;
  HTMLElement.prototype.getClientRects = function (this: HTMLElement) {
    if (this.tagName === 'MARK') return [new DOMRect(120, 40, 140, 20)] as unknown as DOMRectList;
    return originalRects!.call(this);
  };
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  resetCommentCardPolicy();
  if (hasDom) {
    if (originalRects) HTMLElement.prototype.getClientRects = originalRects;
    document.body.replaceChildren();
    window.getSelection()?.removeAllRanges();
  }
});

// Each test its own document path: the composer keeps words per path and selection for the whole run.
let docs = 0;
async function mountViewer(again = false): Promise<HTMLElement> {
  if (!again) docs += 1;
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
        mode="comment"
        inputMethod="drag"
        taterMode={false}
        stickyActions={false}
        disableCodePathValidation
        sourceInfo={`/docs/routines-${docs}.md`}
      />,
    );
  });
  await settle();
  return host!;
}

async function unmountViewer(): Promise<void> {
  await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
}

async function selectPhrase(container: HTMLElement, phrase = PHRASE): Promise<void> {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let node: Text | null = null;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.textContent?.includes(phrase)) { node = n as Text; break; }
  }
  if (!node) throw new Error('phrase not found');
  const start = node.textContent!.indexOf(phrase);
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, start + phrase.length);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  const article = node.parentElement!.closest('article') ?? container;
  await act(async () => { article.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true })); });
  await settle();
}

const popover = () => document.querySelector<HTMLElement>('[data-comment-popover]');
const badge = () => document.querySelector<HTMLButtonElement>('[data-comment-draft-badge]');
const badges = () => [...document.querySelectorAll<HTMLButtonElement>('[data-comment-draft-badge]')];
const draftMarks = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>('mark.annotation-highlight.comment-draft')];
const marks = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>('mark.annotation-highlight')];

async function type(words: string): Promise<void> {
  const field = popover()!.querySelector<HTMLTextAreaElement>('textarea')!;
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')?.set;
  await act(async () => {
    setter?.call(field, words);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function closeBox(): Promise<void> {
  const chevron = popover()!.querySelector<HTMLButtonElement>('[data-comment-card-close]')
    ?? popover()!.querySelector<HTMLButtonElement>('button[title="Close"]');
  await act(async () => chevron!.click());
  await settle();
}

describe.if(hasDom)('Viewer: visible comment drafts (the Inbox opts in)', () => {
  beforeEach(() => {
    setCommentCardEnabled(true);
    setVisibleCommentDrafts(true);
  });

  test('closing a comment with words leaves the words marked and a Draft badge; the badge opens it again', async () => {
    const container = await mountViewer();
    await selectPhrase(container);
    expect(popover()).not.toBeNull();
    await type('Say which plans.');
    await closeBox();

    expect(popover()).toBeNull();
    const kept = marks(container);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.every((m) => m.classList.contains('comment-draft'))).toBe(true);
    expect(kept.map((m) => m.textContent).join('')).toBe(PHRASE);
    const b = badge();
    expect(b).not.toBeNull();
    expect(b!.getAttribute('data-label')).toBe('Draft');
    expect(b!.getAttribute('aria-label')).toContain(PHRASE);
    // Placed under the words' end, in the column; and no text of its own in the document.
    expect(b!.closest('article')).not.toBeNull();
    expect(b!.textContent).toBe('');
    expect(container.querySelector('article')!.textContent).not.toContain('Draft');

    await act(async () => b!.click());
    await settle();
    expect(popover()).not.toBeNull();
    expect(popover()!.querySelector('textarea')!.value).toBe('Say which plans.');
    expect(badge()).toBeNull();
    expect(marks(container).some((m) => m.classList.contains('comment-draft'))).toBe(false);
  });

  test('a draft outlives its document leaving the screen: mounted again, its mark and badge are back and open with the words', async () => {
    let container = await mountViewer();
    await selectPhrase(container);
    await type('Say which plans.');
    await closeBox();
    expect(badges()).toHaveLength(1);

    await unmountViewer();
    container = await mountViewer(true);
    expect(badges()).toHaveLength(1);
    expect(draftMarks(container).map((m) => m.textContent).join('')).toBe(PHRASE);
    await act(async () => badge()!.click());
    await settle();
    expect(popover()!.querySelector('textarea')!.value).toBe('Say which plans.');
  });

  test('a box left open with words when its document leaves the screen comes back as a draft', async () => {
    let container = await mountViewer();
    await selectPhrase(container);
    await type('Half a thought');
    await unmountViewer();
    container = await mountViewer(true);
    expect(popover()).toBeNull();
    expect(badges()).toHaveLength(1);
    expect(draftMarks(container).map((m) => m.textContent).join('')).toBe(PHRASE);
  });

  test('selecting other words while the box holds words keeps it as a draft; the new words get their own box', async () => {
    const container = await mountViewer();
    await selectPhrase(container);
    await type('Keep me');
    await selectPhrase(container, OTHER);
    expect(badges()).toHaveLength(1);
    expect(draftMarks(container).map((m) => m.textContent).join('')).toBe(PHRASE);
    expect(popover()).not.toBeNull();
    expect(popover()!.querySelector('textarea')!.value).toBe('');
  });

  test('the same words picked again by hand: one badge, not two; Comment sends it and no badge is left', async () => {
    const container = await mountViewer();
    await selectPhrase(container);
    await type('Say which plans.');
    await closeBox();
    await selectPhrase(container);
    expect(popover()!.querySelector('textarea')!.value).toBe('Say which plans.');
    expect(badges()).toHaveLength(0);
    await closeBox();
    expect(badges()).toHaveLength(1);

    await act(async () => badge()!.click());
    await settle();
    await act(async () => popover()!.querySelector<HTMLButtonElement>('[data-comment-card-submit]')!.click());
    await settle();
    expect(badges()).toHaveLength(0);
    expect(draftMarks(container)).toHaveLength(0);
  });

  test('a badge opens the box; Escape closes it with the words and focus is back on the badge', async () => {
    const container = await mountViewer();
    await selectPhrase(container);
    await type('Say which plans.');
    await closeBox();
    badge()!.focus();
    await act(async () => badge()!.click());
    await settle();
    const field = popover()!.querySelector<HTMLTextAreaElement>('textarea')!;
    field.focus();
    await act(async () => { field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
    await settle();
    expect(popover()).toBeNull();
    expect(badges()).toHaveLength(1);
    expect(document.activeElement).toBe(badge());
    expect(draftMarks(container).length).toBeGreaterThan(0);
  });

  test('a comment closed empty leaves no mark and no badge', async () => {
    const container = await mountViewer();
    await selectPhrase(container);
    await closeBox();
    expect(badge()).toBeNull();
    expect(marks(container)).toHaveLength(0);
  });

  test('the bin drops the words: no badge, no mark', async () => {
    const container = await mountViewer();
    await selectPhrase(container);
    await type('Never mind');
    await act(async () => popover()!.querySelector<HTMLButtonElement>('[data-comment-card-discard]')!.click());
    await settle();
    expect(badge()).toBeNull();
    expect(marks(container)).toHaveLength(0);
  });
});

describe.if(hasDom)('Viewer without the opt-in', () => {
  test('a comment closed with words leaves no mark and no badge, as before', async () => {
    const container = await mountViewer();
    await selectPhrase(container);
    await type('Say which plans.');
    await closeBox();
    expect(popover()).toBeNull();
    expect(badge()).toBeNull();
    expect(marks(container)).toHaveLength(0);
  });
});
