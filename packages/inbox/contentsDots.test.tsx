/**
 * Settings' "Annotation minimap" (data/contentsDots.ts, parts/ContentsDotsRow.tsx): on by default, the Inbox's contents rail
 * (parts/FileContentsRail.tsx, which a file beside a thread and a plan's page both mount) draws a file's comments as
 * dots beside its ticks; off, no dot, and the ticks stay. Settings' switch and a rail on screen agree at once, and
 * the choice is kept.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeAll, expect, mock, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AnnotationType, type Annotation } from '@plannotator/ui/types';
import { CONTENTS_DOTS_COOKIE, setContentsDotsShown } from './data/contentsDots';

const hasDom = typeof document !== 'undefined';
const { FileContentsRail } = (hasDom ? await import('./parts/FileContentsRail') : {}) as typeof import('./parts/FileContentsRail');
const { ContentsDotsRow } = (hasDom ? await import('./parts/ContentsDotsRow') : {}) as typeof import('./parts/ContentsDotsRow');
const { buildMarkdownContentsModel } = (hasDom
  ? await import('@plannotator/ui/components/MarkdownContentsRail')
  : {}) as typeof import('@plannotator/ui/components/MarkdownContentsRail');
const { storage } = (hasDom ? await import('@plannotator/ui/utils/storage') : {}) as typeof import('@plannotator/ui/utils/storage');
const { parseMarkdownToBlocks } = (hasDom ? await import('@plannotator/ui/utils/parser') : {}) as typeof import('@plannotator/ui/utils/parser');

const PLAN = ['# Refund worker', '', 'Intro.', '', '## Context', '', 'Context text.', '', '## Design', '', 'Design text.', '', '## Rollout', '', 'Rollout text.', ''].join('\n');

const note = (id: string, originalText: string): Annotation => ({
  id,
  blockId: '',
  startOffset: 0,
  endOffset: 0,
  type: AnnotationType.COMMENT,
  text: `About ${originalText}`,
  originalText,
  createdA: Date.now() - 60_000,
  author: 'Ada Novak',
});
/** Each comment's highlight sits under this heading (by index). */
const ANNOTATIONS = [note('c1', 'Context text'), note('c2', 'Design text'), note('c3', 'Rollout text')];
const SECTION_OF: Record<string, number> = { c1: 1, c2: 2, c3: 3 };

let root: Root | null = null;
let frame: HTMLElement | null = null;

beforeAll(() => {
  // A page on localhost, as the Inbox is served: about:blank keeps no readable cookies.
  if (hasDom) (window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL('http://localhost:4000/');
});

afterEach(() => {
  act(() => root?.unmount());
  frame?.remove();
  root = null;
  frame = null;
  if (hasDom) storage.removeItem(CONTENTS_DOTS_COOKIE);
});

/** A laid-out document page (happy-dom lays nothing out) with its rail and, below it, Settings' row. */
function mount(): void {
  frame = document.createElement('div');
  const viewport = document.createElement('div');
  const content = document.createElement('article');
  const mountAt = document.createElement('div');
  content.dataset.docTextRoot = '';
  viewport.append(content);
  frame.append(viewport, mountAt);
  document.body.append(frame);
  viewport.getBoundingClientRect = () => new DOMRect(0, 0, 1000, 600);
  content.getBoundingClientRect = () => new DOMRect(100, 0, 640, 1200);
  Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 600 });
  Object.defineProperty(viewport, 'scrollHeight', { configurable: true, value: 1200 });
  Object.defineProperty(viewport, 'scrollTo', { configurable: true, value: mock(() => {}) });
  buildMarkdownContentsModel(PLAN).forEach((item, index) => {
    const heading = document.createElement(`h${item.level}`);
    heading.dataset.blockType = 'heading';
    heading.dataset.blockId = item.blockId;
    heading.textContent = item.label;
    heading.getBoundingClientRect = () => new DOMRect(100, 40 + index * 260 - viewport.scrollTop, 500, 32);
    content.append(heading);
    const paragraph = document.createElement('p');
    for (const annotation of ANNOTATIONS) {
      if (SECTION_OF[annotation.id] !== index) continue;
      const mark = document.createElement('mark');
      mark.dataset.highlightId = annotation.id;
      mark.textContent = annotation.originalText;
      paragraph.append(mark);
    }
    content.append(paragraph);
  });
  root = createRoot(mountAt);
  act(() =>
    root!.render(
      <>
        <FileContentsRail
          blocks={parseMarkdownToBlocks(PLAN)}
          scrollViewport={viewport}
          onHide={() => {}}
          annotations={ANNOTATIONS}
          selectedAnnotationId={null}
          onSelectAnnotation={() => {}}
        />
        <ContentsDotsRow />
      </>,
    ),
  );
}

/** Let the deferred rail load and measure (twice: the first resize can land before the lazy rail has mounted). */
async function settle() {
  for (let round = 0; round < 2; round++) {
    await act(async () => {
      window.dispatchEvent(new Event('resize'));
      await new Promise((resolve) => setTimeout(resolve, 60));
    });
  }
}

const ticks = () => document.querySelectorAll('nav[aria-label="Document contents"] [data-contents-index]').length;
const dots = () => document.querySelectorAll('nav[aria-label="Document contents"] [data-mark-id]').length;
const settingSwitch = () => document.querySelector<HTMLButtonElement>('[data-settings-contents-dots] [role="switch"]')!;

test.skipIf(!hasDom)('on by default: the rail draws a dot for each comment beside its ticks', async () => {
  mount();
  await settle();
  expect(ticks()).toBe(4);
  expect(dots()).toBe(3);
  expect(settingSwitch().getAttribute('aria-checked')).toBe('true');
});

test.skipIf(!hasDom)("Settings' switch off: the rail on screen drops its dots and keeps its ticks; on again, they return", async () => {
  mount();
  await settle();
  expect(dots()).toBe(3);

  act(() => settingSwitch().click());
  await settle();
  expect(settingSwitch().getAttribute('aria-checked')).toBe('false');
  expect(storage.getItem(CONTENTS_DOTS_COOKIE)).toBe('hidden');
  expect(ticks()).toBe(4);
  expect(dots()).toBe(0);

  act(() => settingSwitch().click());
  await settle();
  expect(storage.getItem(CONTENTS_DOTS_COOKIE)).toBe('shown');
  expect(dots()).toBe(3);
});

test.skipIf(!hasDom)('turned off earlier: a rail opened later draws no dots, ticks only', async () => {
  setContentsDotsShown(false);
  mount();
  await settle();
  expect(ticks()).toBe(4);
  expect(dots()).toBe(0);
  expect(settingSwitch().getAttribute('aria-checked')).toBe('false');
});
