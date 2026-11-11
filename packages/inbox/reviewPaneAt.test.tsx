import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { buildGuideSnapshot } from '@plannotator/core/guide-format';
import type { InboxMessageWire, InboxProject, InboxThread } from '@plannotator/core/inbox-types';
import type { ReviewAt } from './shape/review';
import type { ShapeHost } from '@plannotator/ui/components/shape';
import type { InboxShapes } from './shape/useInboxShapes';

const NO_BOARDS: InboxShapes = { shapes: null, byThread: new Map(), changed: 0, rowShown: false, subscribe: () => () => {}, refresh: () => {} };

type ReaderProps = { mode?: string; reveal?: { path: string } | null; highlight?: { path: string; start: number; end: number; side?: 'old' } | null; snapshot?: { guide: { sections: { diffs: { file: string }[] }[] } } };
let reader: ReaderProps | null = null;
const hasDom = typeof document !== 'undefined';
if (hasDom) {
  mock.module('#guide-reader', () => ({
    default: (props: ReaderProps) => {
      reader = props;
      const lit = props.highlight;
      return (
        <>
          {props.snapshot?.guide.sections.map((_, i) => <div key={i} data-guide-section={i} />)}
          {lit && (
            <div data-guide-file-shell={lit.path}>
              <div data-line={lit.start} data-selected-line="" />
            </div>
          )}
        </>
      );
    },
  }));
}
const { ReviewPane } = (hasDom ? await import('./components/ReviewPane') : {}) as typeof import('./components/ReviewPane');
const { lineScrollBy } = (hasDom ? await import('./components/reviewLineInView') : {}) as typeof import('./components/reviewLineInView');

const PROJECT: InboxProject = { id: 'prj_1', key: 'kettle-abcdef', name: 'kettle', root: '/work/kettle', created_at: '2026-11-05T10:00:00.000Z' };
const REVIEW = 'msg_01M4H6G73M9H3Z32T859E7KETL';
const patch = ['src/kettle.ts', 'src/settings.ts', 'src/timer.ts'].map((f) => `diff --git a/${f} b/${f}\n--- a/${f}\n+++ b/${f}\n@@ -1,2 +1,2 @@\n-old\n+new\n keep\n`).join('');
const snapshot = buildGuideSnapshot({
  guide: {
    title: 'Kettle',
    intent: 'One whistle.',
    sections: [
      { title: 'The whistle', overview: '', diffs: [{ file: 'src/kettle.ts', summary: '' }] },
      { title: 'The setting', overview: '', diffs: [{ file: 'src/settings.ts', summary: '' }] },
    ],
  },
  reviewed: [false, false],
  review: { rawPatch: patch, gitRef: 'main...HEAD', source: { kind: 'local' } },
  exportedAt: '2026-11-05T10:40:00.000Z',
});
const stackSnapshot = buildGuideSnapshot({
  guide: {
    title: 'Kettle',
    intent: 'One whistle.',
    sections: [
      { title: '#11 · The whistle', overview: '', diffs: [{ file: 'src/kettle.ts', summary: '' }] },
      { title: '#12 · The setting', overview: '', diffs: [{ file: 'src/settings.ts', summary: '' }, { file: 'src/timer.ts', summary: '' }] },
    ],
  },
  reviewed: [false, false],
  review: { rawPatch: patch, gitRef: 'main...HEAD', source: { kind: 'local' } },
  exportedAt: '2026-11-05T10:40:00.000Z',
});
let served = snapshot;
const message = {
  id: REVIEW,
  project_id: PROJECT.id,
  thread_id: REVIEW,
  reply_to: null,
  author: { kind: 'agent', host: 'claude-code', session: 'ses_review', name: null },
  subject: 'Kettle',
  body: 'I wrote a review.',
  created_at: '2026-11-05T10:41:00.000Z',
  resolved_at: null,
  idempotency_key: null,
  wakes: true,
  guide: { sha256: 'a', input_sha256: 'b', bytes: 1, title: 'Kettle', sections: 2, files: 3, additions: 3, deletions: 3, review: true, chapters: ['The whistle', 'The setting'] },
} as InboxMessageWire;
const thread: InboxThread = { thread_id: REVIEW, project: PROJECT, subject: 'Kettle', thread_name: null, resolved_at: null, messages: [message] };

let root: Root | null = null;
let el: HTMLElement | null = null;
let savedFetch: typeof fetch;
beforeEach(() => {
  if (!hasDom) return;
  reader = null;
  savedFetch = globalThis.fetch;
  window.localStorage.clear();
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.includes('/guide')) return Response.json({ message_id: REVIEW, guide: message.guide, snapshot: served });
    if (path.includes('/attachments')) return Response.json({ serverSession: 's', attachments: [], annotations: [] });
    if (path.includes('/sessions')) return Response.json({ serverSession: 's', home: '/home/me', project: PROJECT, sessions: [], asker: { session: 'ses_review', live: true } });
    return Response.json({});
  }) as typeof fetch;
});
afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  el?.remove();
  root = null;
  el = null;
  globalThis.fetch = savedFetch;
  served = snapshot;
});

async function open(at: ReviewAt | null, codeReview = true): Promise<{ landed: () => number }> {
  let landed = 0;
  el = document.createElement('div');
  document.body.appendChild(el);
  act(() => {
    root = createRoot(el!);
    root.render(
      <div className="pn-inbox">
        <ReviewPane thread={thread} message={message} codeReview={codeReview} onBack={() => {}} onClose={() => {}} onSent={() => {}} shapeHost={{} as ShapeHost} shapes={NO_BOARDS} board={null} onBoard={() => {}} at={at} onLanded={() => (landed += 1)} />
      </div>,
    );
  });
  for (let i = 0; i < 6; i++) await act(() => new Promise((r) => setTimeout(r, 0)));
  return { landed: () => landed };
}
const chapterName = () => document.querySelector('[data-review-jump]')?.textContent ?? '';

test.skipIf(!hasDom)("a board's file:line opens the review at that file's chapter, the line painted, and lets the place go", async () => {
  const { landed } = await open({ path: 'src/settings.ts', line: 2 });
  expect(reader?.mode).toBe('walkthrough');
  expect(reader?.reveal?.path).toBe('src/settings.ts');
  expect(reader?.highlight).toMatchObject({ path: 'src/settings.ts', start: 2, end: 2 });
  expect(chapterName()).toContain('The setting');
  expect(landed()).toBe(1);
});

test.skipIf(!hasDom)("a context note's removed lines open on the removed side: their numbers are the old side's", async () => {
  await open({ path: 'src/settings.ts', line: 2, side: 'old' });
  expect(reader?.highlight).toMatchObject({ path: 'src/settings.ts', start: 2, end: 2, side: 'old' });
  act(() => root?.unmount());
  root = null;
  el?.remove();
  await open({ path: 'src/settings.ts', line: 2 });
  expect(reader?.highlight?.side).toBeUndefined();
});

test.skipIf(!hasDom)('a file no chapter holds opens in All files', async () => {
  await open({ path: 'src/timer.ts', line: 1 });
  expect(reader?.mode).toBe('files');
  expect(reader?.reveal?.path).toBe('src/timer.ts');
});

test.skipIf(!hasDom)("a guide step opens that step's chapter", async () => {
  await open({ step: 2 });
  expect(reader?.mode).toBe('walkthrough');
  expect(reader?.reveal?.path).toBe('src/settings.ts');
  expect(chapterName()).toContain('The setting');
});

test.skipIf(!hasDom)('Full review opens All files; Guided review opens the walkthrough at its top', async () => {
  const full = await open({ files: true });
  expect(reader?.mode).toBe('files');
  expect(full.landed()).toBe(1);
  act(() => root?.unmount());
  el?.remove();
  const guided = await open(null);
  expect(reader?.mode).toBe('walkthrough');
  expect(reader?.reveal ?? null).toBeNull();
  expect(reader?.highlight ?? null).toBeNull();
  expect(guided.landed()).toBe(0);
});

test.skipIf(!hasDom)('with Code review off, the review opens at the file with the line painted, or at a step\'s first file', async () => {
  const line = await open({ path: 'src/settings.ts', line: 2 }, false);
  expect(reader?.reveal?.path).toBe('src/settings.ts');
  expect(reader?.highlight).toMatchObject({ path: 'src/settings.ts', start: 2, end: 2 });
  expect(line.landed()).toBe(1);
  act(() => root?.unmount());
  el?.remove();
  await open({ step: 2 }, false);
  expect(reader?.reveal?.path).toBe('src/settings.ts');
  expect(reader?.highlight ?? null).toBeNull();
});

/**
 * happy-dom lays nothing out: the review's body is a window from y=100 to y=900, and the painted row sits at `rowAt`
 * in the page, so it moves up as the body scrolls (the line is far below the fold, as the reviewer measured: y=1082).
 */
function layOut(rowAt: number, drawn: () => boolean = () => true): () => void {
  const saved = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'getBoundingClientRect');
  Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value(this: HTMLElement) {
      const body = document.querySelector<HTMLElement>('.ib-gbody');
      if (this === body) return new DOMRect(0, 100, 1440, 800);
      if (this.hasAttribute('data-selected-line') && drawn()) return new DOMRect(0, rowAt - (body?.scrollTop ?? 0), 900, 20);
      return new DOMRect(0, 0, 0, 0);
    },
  });
  return () => {
    if (saved) Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', saved);
    else delete (HTMLElement.prototype as { getBoundingClientRect?: unknown }).getBoundingClientRect;
  };
}
const frames = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)));

test.skipIf(!hasDom)("a board's file:line scrolls the review until the painted line is in view", async () => {
  const restore = layOut(1500);
  try {
    await open({ path: 'src/settings.ts', line: 2 });
    await frames(600);
    const body = document.querySelector<HTMLElement>('.ib-gbody')!;
    const top = 1500 - body.scrollTop;
    expect(top).toBeGreaterThanOrEqual(100 + 72);
    expect(top).toBeLessThan(900 / 2);
  } finally {
    restore();
  }
});

test.skipIf(!hasDom)('the person scrolling first keeps their scroll; a line already in view does not move', async () => {
  let drawn = false;
  const restore = layOut(1500, () => drawn);
  try {
    await open({ path: 'src/settings.ts', line: 2 });
    document.querySelector('.ib-gbody')!.dispatchEvent(new Event('wheel', { bubbles: true }));
    drawn = true;
    await frames(600);
    expect(document.querySelector<HTMLElement>('.ib-gbody')!.scrollTop).toBe(0);
  } finally {
    restore();
  }
  act(() => root?.unmount());
  el?.remove();
  const inView = layOut(400);
  try {
    await open({ path: 'src/settings.ts', line: 2 });
    await frames(600);
    expect(document.querySelector<HTMLElement>('.ib-gbody')!.scrollTop).toBe(0);
  } finally {
    inView();
  }
});

test.skipIf(!hasDom)('the line lands clear of the corner card: above its top, on a desktop and on a phone', () => {
  const view = { top: 100, bottom: 900 };
  for (const [bottom, card] of [[900, 622], [844, 470]] as const) {
    const by = lineScrollBy({ top: 1500, bottom: 1520 }, { top: view.top, bottom }, card);
    expect(1500 - by).toBeGreaterThanOrEqual(view.top + 72);
    expect(1520 - by).toBeLessThanOrEqual(card);
  }
  expect(lineScrollBy({ top: 700, bottom: 720 }, view, 622)).toBeGreaterThan(0);
  expect(lineScrollBy({ top: 300, bottom: 320 }, view, 622)).toBe(0);
  expect(lineScrollBy({ top: 1500, bottom: 2600 }, view, 622)).toBe(1500 - (100 + 72));
});

test.skipIf(!hasDom)("a stack badge's \"Read it in the review\" shows the PR's chapter with only the part's files, until Show the whole stack", async () => {
  served = stackSnapshot;
  await open({ step: 2, narrow: { part: 'The timer', pr: 12, title: 'The setting', hue: 72, files: ['src/timer.ts'] } });
  const files = () => reader?.snapshot?.guide.sections.map((s) => s.diffs.map((d) => d.file));
  expect(files()).toEqual([['src/kettle.ts'], ['src/timer.ts']]);
  const bar = document.querySelector('[data-review-narrow]');
  expect(bar?.textContent).toContain('Back to the board');
  expect(bar?.textContent).toContain('The timer');
  expect(bar?.textContent).toContain('1 of the 2 files in this chapter');
  const pr = bar?.querySelector<HTMLElement>('.ib-rv-narrow-pr');
  expect(pr?.hasAttribute('data-hue')).toBe(true);
  expect(pr?.style.getPropertyValue('--shp-h')).toBe('72');
  for (let i = 0; i < 20 && reader?.reveal?.path !== 'src/timer.ts'; i++) await act(async () => new Promise((r) => setTimeout(r, 20)));
  expect(reader?.reveal?.path).toBe('src/timer.ts');
  expect(document.activeElement).toBe(document.querySelector('[data-review-narrow-back]'));
  await act(async () => (document.querySelector('[data-review-narrow-all]') as HTMLButtonElement).click());
  expect(document.querySelector('[data-review-narrow]')).toBeNull();
  expect(files()).toEqual([['src/kettle.ts'], ['src/settings.ts', 'src/timer.ts']]);
});
