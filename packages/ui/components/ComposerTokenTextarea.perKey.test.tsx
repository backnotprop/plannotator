/**
 * What one key costs the composer's textarea (ComposerTokenTextarea, the comment composer's and the Inbox's).
 *
 *  - The words are the textarea's value, never also its text child. React 19 wrote the whole text there on every key
 *    when only `value` was given: a DOM mutation per key, which in Chrome ends the browser's undo step, so ⌘Z took
 *    back one character at a time. happy-dom has no undo; the mutation it records is the cause.
 *  - The text is scanned for skill names once a change, not twice.
 *  - The mirror's scroll is read in the next frame, not in the key's own task (a read there lays out the whole text).
 *
 * DOM-gated (DOM_TESTS=1), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SkillCatalogEntry } from '../utils/skillReferences';

const hasDom = typeof document !== 'undefined';

// Every scan of the text for skill names, counted: both ways the module offers to do one.
let scans = 0;
if (hasDom) {
  const real = await import('../utils/skillReferences');
  const { findSkillReferenceTokens, extractSkillReferences } = real;
  mock.module('../utils/skillReferences', () => ({
    ...real,
    findSkillReferenceTokens: (...args: Parameters<typeof findSkillReferenceTokens>) => {
      scans++;
      return findSkillReferenceTokens(...args);
    },
    extractSkillReferences: (...args: Parameters<typeof extractSkillReferences>) => {
      scans++;
      return extractSkillReferences(...args);
    },
  }));
}
const { CommentPopover } = (hasDom ? await import('./CommentPopover') : {}) as typeof import('./CommentPopover');
const skillCatalog = (hasDom ? await import('../utils/skillCatalog') : {}) as typeof import('../utils/skillCatalog');

const catalog: SkillCatalogEntry[] = [
  { name: 'write-better', root: 'claude', description: 'Improve prose', humanOnly: false },
  { name: 'review-only', root: 'claude', description: 'People only', humanOnly: true },
];

let root: Root | null = null;
let host: HTMLElement | null = null;

async function mount(initialText?: string) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <CommentPopover
        anchorRect={new DOMRect(100, 100, 60, 20)}
        contextText="selected text"
        isGlobal={false}
        onSubmit={() => {}}
        onClose={() => {}}
        initialText={initialText}
        skillReferences
      />,
    );
  });
  await act(async () => {}); // the catalog's fetch
}

const textarea = () => document.querySelector<HTMLTextAreaElement>('[data-comment-popover] textarea')!;
const overlay = () => document.querySelector<HTMLElement>('[data-skill-ref-overlay]')!;
const frame = () => act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

/** One key as the browser gives it: the value changes, then `input`. */
function press(el: HTMLTextAreaElement, next: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  setter.call(el, next);
  el.selectionStart = el.selectionEnd = next.length;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
const key = (el: HTMLTextAreaElement, next: string) => act(async () => press(el, next));
/** The key's own task alone: React's commit and its effects, and no frame after it (happy-dom runs a frame as a task). */
const keyTask = (el: HTMLTextAreaElement, next: string) => act(() => press(el, next));

async function typeRun(el: HTMLTextAreaElement, words: string) {
  const start = el.value;
  for (let i = 1; i <= words.length; i++) await key(el, start + words.slice(0, i));
}

beforeEach(() => {
  if (!hasDom) return;
  skillCatalog.resetSkillCatalogCache();
  skillCatalog.setSkillCatalogTransport(async () => catalog);
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  host?.remove();
  host = null;
  if (hasDom) {
    skillCatalog.resetSkillCatalogTransport();
    skillCatalog.resetSkillCatalogCache();
  }
});

describe.if(hasDom)('one key in the composer', () => {
  test('typing never writes the words into the textarea as its text child', async () => {
    await mount();
    const el = textarea();
    const records: MutationRecord[] = [];
    const observer = new MutationObserver((list) => records.push(...list));
    observer.observe(el, { childList: true, characterData: true, subtree: true });
    await typeRun(el, 'use /write-better on this');
    await act(async () => {});
    observer.disconnect();
    expect(el.value).toBe('use /write-better on this');
    expect(records).toHaveLength(0);
    expect(el.textContent).toBe('');
    // The mirror still paints every word, the skill as its chip.
    expect(overlay().textContent).toBe('use /write-better on this\n');
    expect(overlay().querySelector('[data-skill-ref-token="write-better"]')?.textContent).toBe('/write-better');
  });

  test('words the box opens with stay its value, and the first key typed after them writes no text child either', async () => {
    await mount('kept draft ');
    const el = textarea();
    expect(el.value).toBe('kept draft ');
    expect(el.textContent).toBe('');
    const records: MutationRecord[] = [];
    const observer = new MutationObserver((list) => records.push(...list));
    observer.observe(el, { childList: true, characterData: true, subtree: true });
    await typeRun(el, 'and more');
    await act(async () => {});
    observer.disconnect();
    expect(el.value).toBe('kept draft and more');
    expect(records).toHaveLength(0);
  });

  test('the text is scanned for skill names once a key', async () => {
    await mount();
    const el = textarea();
    await key(el, 'use $review-only');
    scans = 0;
    await typeRun(el, ' and /write-better');
    expect(scans).toBe(' and /write-better'.length);
    // What the two scans gave is still given: the people-only notice names the skill once.
    expect(document.body.textContent).toContain('review-only');
  });

  test("the mirror's scroll is read in the next frame, not in the key's own task", async () => {
    await mount();
    const el = textarea();
    let reads = 0;
    let top = 0;
    Object.defineProperty(el, 'scrollTop', {
      configurable: true,
      get: () => {
        reads++;
        return top;
      },
      set: (next: number) => {
        top = next;
      },
    });
    await frame();
    top = 40;
    reads = 0;
    keyTask(el, 'a word');
    keyTask(el, 'a word and');
    expect(reads).toBe(0);
    await frame();
    // One read for both keys, and the mirror where the textarea is, before that frame is drawn.
    expect(reads).toBe(1);
    expect(overlay().scrollTop).toBe(40);
  });
});
