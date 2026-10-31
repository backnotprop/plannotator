/**
 * An open Markdown document shows its Contents (contents.ts, ContentsPanel.tsx).
 * On a desktop, Side by side and Full screen alike: ui's contents rail (the
 * ticks in the page's right gutter, the panel opening left over the page),
 * never in the comments column and never moving the page. Where the rail
 * yields (its gutter rule), until it has drawn, and on a phone: a Contents
 * button over the file opens the rail's headings (levels 1 to 4) as a sheet.
 * Fewer than 4 headings: neither. The rail's Hide is remembered and leaves a
 * button that shows it again; focus moves to what replaces each. The sheet
 * mounted mid-document marks the section being read (the rail's scroll math),
 * holds focus and takes Escape first; an open rail panel takes Escape before
 * full screen does. The phone surface has the same button and sheet.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeAll, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAttachmentState } from '@plannotator/core/inbox-types';
import { CONTENTS_COOKIE } from './contents';

const hasDom = typeof document !== 'undefined';
// The pane pulls in the Viewer, which reads `window` at module-eval time.
const { AttachmentPane } = (hasDom ? await import('./components/AttachmentPane') : {}) as typeof import('./components/AttachmentPane');
const { storage } = (hasDom ? await import('@plannotator/ui/utils/storage') : {}) as typeof import('@plannotator/ui/utils/storage');
// Loaded here so the pane's lazy rail resolves at once.
if (hasDom) await import('@plannotator/ui/components/MarkdownContentsRail');

let root: Root | null = null;
let host: HTMLElement | null = null;
const realFetch = globalThis.fetch;

beforeAll(() => {
  // A page on localhost, as the Inbox is served: about:blank keeps no readable cookies (the hide choice is one).
  if (hasDom) (window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL('http://localhost:4000/');
});

const cleanups: (() => void)[] = [];
/** Run `cleanup` after this test (afterEach). */
function afterThis(cleanup: () => void) {
  cleanups.push(cleanup);
}

afterEach(() => {
  act(() => root?.unmount());
  for (const cleanup of cleanups.splice(0)) cleanup();
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = realFetch;
  if (hasDom) storage.removeItem(CONTENTS_COOKIE);
});

const DOC_SCROLL = '.ib-docscroll, .sf-docscroll';
function docScroll(within: ParentNode = host!): HTMLElement {
  if (within instanceof HTMLElement && within.matches(DOC_SCROLL)) return within;
  return within.querySelector<HTMLElement>(DOC_SCROLL)!;
}

/**
 * Lay the document's headings out: `tops` gives each heading's top, px below the scroll's top, at the scroll
 * position now; a later scroll (`scrollBy`) moves them up by as much.
 */
function layOut(tops: Record<string, number>, within: ParentNode = host!) {
  const scroll = docScroll(within);
  const at = scroll.scrollTop;
  for (const heading of within.querySelectorAll<HTMLElement>('[data-block-type="heading"]')) {
    const top = tops[heading.textContent ?? ''];
    if (top !== undefined) heading.getBoundingClientRect = () => new DOMRect(0, top - (scroll.scrollTop - at), 600, 30);
  }
}

/** Scroll the document `dy` px down, then let the scroll-spy's frame run. */
async function scrollBy(dy: number, within: ParentNode = host!) {
  const scroll = docScroll(within);
  await act(async () => {
    scroll.scrollTop += dy;
    scroll.dispatchEvent(new Event('scroll'));
    await new Promise((resolve) => setTimeout(resolve, 40));
  });
}

/** Halfway into "Design": every heading above it is read past; "Design" is above the 80 px activation line. */
const MID_DESIGN = { 'Refund worker': -900, Context: -520, Design: -140, 'Idempotency keys': 420, Rollout: 940 };
/** The top of the document: the title just below the 80 px activation line (the first heading is current). */
const AT_TOP = { 'Refund worker': 90, Context: 340, Design: 640, 'Idempotency keys': 940, Rollout: 1240 };

/**
 * Lay the file's page out (happy-dom lays nothing out): the document scroll `width` px wide from x 0, the page's
 * reading column (the Viewer's article) ending at `contentRight`; then let the rail measure again.
 */
async function layOutPage(width: number, contentRight: number) {
  const scroll = host!.querySelector<HTMLElement>('.ib-docscroll')!;
  scroll.getBoundingClientRect = () => new DOMRect(0, 0, width, 800);
  const article = scroll.querySelector<HTMLElement>('[data-doc-text-root]')!;
  article.getBoundingClientRect = () => new DOMRect(contentRight - 640, 0, 640, 2000);
  layOut(AT_TOP);
  await settle();
}

/** Let the deferred rail load and measure (a resize asks it to measure again). */
async function settle() {
  await act(async () => {
    window.dispatchEvent(new Event('resize'));
    await new Promise((resolve) => setTimeout(resolve, 60));
  });
}

function marked(list: Element | null): string[] {
  return [...(list?.querySelectorAll('nav button[aria-current="location"]') ?? [])].map((b) => b.textContent ?? '');
}

function key(target: EventTarget, init: KeyboardEventInit) {
  act(() => void target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })));
}

const PLAN = [
  '# Refund worker',
  '',
  'Move refunds to a background worker.',
  '',
  '## Context',
  '',
  'Refunds run inline today.',
  '',
  '## Design',
  '',
  'A worker claims each job.',
  '',
  '### Idempotency keys',
  '',
  'One key per charge.',
  '',
  '## Rollout',
  '',
  'A shadow week first.',
  '',
].join('\n');

const HEADINGS = ['Refund worker', 'Context', 'Design', 'Idempotency keys', 'Rollout'];

const attachment: InboxAttachmentState = {
  id: 'att_01K7ZZZZZZZZZZZZZZZZZZZZZZ',
  path: '/work/api/refund-plan.md',
  named_path: null,
  name: 'refund-plan.md',
  kind: 'markdown',
  sent_sha256: 'a'.repeat(64),
  size: PLAN.length,
  sent_at: '2026-10-10T10:00:00.000Z',
  sent_mtime: '2026-10-10T10:00:00.000Z',
  message_id: 'msg_01K7ZZZZZZZZZZZZZZZZZZZZZZ',
  current: { sha256: 'a'.repeat(64), size: PLAN.length, mtime: '2026-10-10T10:00:00.000Z' },
  changed_since_sent: false,
  unavailable: null,
};

/** The pane for the attachment whose view route answers `text`, once its document has drawn. */
async function renderPane(
  text: string,
  layout: { full?: boolean; phone?: boolean } = {},
  on: { toggleFull?: () => void; close?: () => void } = {},
): Promise<void> {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ serverSession: 's', attachment, version: 'current', text, html: null }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch;
  const noop = () => {};
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(
      <AttachmentPane
        attachment={attachment}
        attachments={[attachment]}
        records={[]}
        agent="Claude Code"
        projectName="api"
        projectRoot="/work/api"
        version="current"
        onVersion={noop}
        full={layout.full === true}
        phone={layout.phone}
        onToggleFull={on.toggleFull ?? noop}
        focusId={null}
        readOnly={false}
        onSaved={noop}
        onRemoved={noop}
        onOpenAt={noop}
        onClose={on.close ?? noop}
        strip={{ picks: 0, annotations: 0, onWriteReply: noop }}
      />,
    );
  });
  await act(async () => {
    for (let i = 0; i < 200 && !host!.querySelector('.ib-docscroll article')?.textContent?.includes('Refund worker'); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  });
}

function entries(list: Element | null): string[] {
  return [...(list?.querySelectorAll('nav[aria-label="Table of contents"] button') ?? [])].map((b) => b.textContent ?? '');
}

function railOf(): HTMLElement | null {
  return host!.querySelector<HTMLElement>('nav[aria-label="Document contents"]');
}

function ticks(): HTMLButtonElement[] {
  return [...(railOf()?.querySelectorAll<HTMLButtonElement>('[data-contents-index]') ?? [])];
}

/** Records the document scroll's scrollTo calls; the heading named `text` reads at `top` px below the scroll's top. */
function watchScroll(text: string, top: number): ScrollToOptions[] {
  const scroll = host!.querySelector<HTMLElement>('.ib-docscroll')!;
  const calls: ScrollToOptions[] = [];
  scroll.scrollTo = ((options: ScrollToOptions) => void calls.push(options)) as typeof scroll.scrollTo;
  const heading = [...scroll.querySelectorAll<HTMLElement>('[data-block-type="heading"]')].find((h) => h.textContent === text)!;
  heading.getBoundingClientRect = () => new DOMRect(0, top, 600, 30);
  return calls;
}

function click(el: Element | null | undefined) {
  expect(el).toBeTruthy();
  act(() => (el as HTMLElement).click());
}

for (const full of [false, true]) {
  test.skipIf(!hasDom)(`${full ? 'full screen' : 'side by side'}: the rail sits in the page's right gutter; a tick opens the panel; a pick scrolls the document`, async () => {
    await renderPane(PLAN, { full });
    // A 1000 px page with its 640 px column centred: a 180 px gutter.
    await layOutPage(1000, 820);
    const nav = railOf();
    expect(nav).not.toBeNull();
    // In the file area, never in the comments column; no Contents button while the rail shows.
    expect(nav!.closest('.ib-docarea')).not.toBeNull();
    expect(host!.querySelector('.ib-apanel [data-contents], .ib-apanel nav[aria-label="Document contents"]')).toBeNull();
    expect(host!.querySelector('[data-contents-open], [data-contents-show]')).toBeNull();
    // The dock 24 px right of the column: the nav box is [panel 256][gap 6][dock 36].
    expect(nav!.style.left).toBe(`${820 + 24 - 6 - 256}px`);
    // Every heading of levels 1 to 4, each named by its breadcrumb.
    expect(ticks().map((t) => t.getAttribute('aria-label'))).toEqual([
      'Open document contents at Refund worker',
      'Open document contents at Refund worker / Context',
      'Open document contents at Refund worker / Design',
      'Open document contents at Refund worker / Design / Idempotency keys',
      'Open document contents at Refund worker / Rollout',
    ]);
    expect(ticks()[0]!.getAttribute('aria-current')).toBe('location');

    click(ticks()[4]);
    expect(nav!.dataset.revealed).toBe('');
    expect([...nav!.querySelectorAll('.pn-contents-rail-label')].map((l) => l.textContent)).toEqual(HEADINGS);
    const calls = watchScroll('Rollout', 900);
    key(ticks()[4]!, { key: 'Enter' });
    // The 80 px activation line (TableOfContents' offset too): the heading's top less 80 px.
    expect(calls).toEqual([{ top: 820, behavior: 'smooth' }]);
    // Marked at once, while the smooth scroll is in flight.
    expect(nav!.querySelector('[aria-current="location"] .pn-contents-rail-label')?.textContent).toBe('Rollout');
  });
}

test.skipIf(!hasDom)('where the gutter is short the rail yields and the Contents button opens the sheet', async () => {
  await renderPane(PLAN);
  // A 676 px page, its column ending 24 px from the edge: under the rail's 68 px.
  await layOutPage(676, 652);
  expect(railOf()).toBeNull();
  click(host!.querySelector('[data-contents-open]'));
  const sheet = document.querySelector('[data-contents="sheet"][role="dialog"]');
  expect(entries(sheet)).toEqual(HEADINGS);

  // The window grows: the rail measures again, shows, and the button goes.
  click(sheet!.querySelector('[aria-label="Close contents"]'));
  await layOutPage(1000, 820);
  expect(railOf()).not.toBeNull();
  expect(host!.querySelector('[data-contents-open]')).toBeNull();
});

test.skipIf(!hasDom)('a document with fewer than 4 headings has no Contents', async () => {
  await renderPane('# Refund worker\n\nShort.\n\n## Context\n\nStill short.\n\n## Design\n\nA worker.\n');
  await layOutPage(1000, 820);
  expect(railOf()).toBeNull();
  expect(host!.querySelector('[data-contents-open], [data-contents-show], [data-contents]')).toBeNull();
});

test.skipIf(!hasDom)('Hide in the open panel is remembered for the next file; the Contents button shows the rail again', async () => {
  await renderPane(PLAN, { full: true });
  await layOutPage(1000, 820);
  click(ticks()[0]);
  click(railOf()!.querySelector('[data-contents-hide]'));
  expect(railOf()).toBeNull();
  expect(storage.getItem(CONTENTS_COOKIE)).toBe('hidden');
  // Plan review's own setting is not this one.
  expect(storage.getItem('plannotator-toc-enabled')).toBeNull();
  expect(host!.querySelector('[data-contents-show]')).not.toBeNull();

  act(() => root?.unmount());
  host!.remove();
  await renderPane(PLAN, { full: true });
  await layOutPage(1000, 820);
  expect(railOf()).toBeNull();
  click(host!.querySelector('[data-contents-show]'));
  expect(railOf()).not.toBeNull();
  expect(storage.getItem(CONTENTS_COOKIE)).toBe('shown');
});

test.skipIf(!hasDom)('full screen: Escape closes the open rail panel, not full screen', async () => {
  let left = 0;
  await renderPane(PLAN, { full: true }, { toggleFull: () => left++, close: () => left++ });
  await layOutPage(1000, 820);
  click(ticks()[1]);
  expect(railOf()!.dataset.revealed).toBe('');
  key(document.body, { key: 'Escape' });
  expect(railOf()!.dataset.revealed).toBeUndefined();
  expect(left).toBe(0);
  key(document.body, { key: 'Escape' });
  expect(left).toBe(1);
});

test.skipIf(!hasDom)('on a phone a Contents button opens the list as a sheet; a pick scrolls there and closes it', async () => {
  await renderPane(PLAN, { phone: true });
  await layOutPage(390, 380);
  expect(railOf()).toBeNull();
  click(host!.querySelector('[data-contents-open]'));
  const sheet = document.querySelector('[data-contents="sheet"][role="dialog"]');
  expect(entries(sheet)).toEqual(HEADINGS);

  const calls = watchScroll('Design', 500);
  click([...sheet!.querySelectorAll('nav button')].find((b) => b.textContent === 'Design'));
  expect(calls).toEqual([{ top: 420, behavior: 'smooth' }]);
  expect(document.querySelector('[data-contents="sheet"]')).toBeNull();
});

test.skipIf(!hasDom)('a sheet opened mid-document marks the section being read, and follows the scroll', async () => {
  await renderPane(PLAN, { phone: true });
  layOut(MID_DESIGN);
  click(host!.querySelector('[data-contents-open]'));
  const sheet = document.querySelector('[data-contents="sheet"]');
  expect(marked(sheet)).toEqual(['Design']);

  // A scroll brings "Rollout" (940 px down) past the line: the mark follows it.
  await scrollBy(900);
  expect(marked(sheet)).toEqual(['Rollout']);
  // Back up, in one jump: no heading crosses the line on the way, and the mark still follows.
  await scrollBy(-900);
  expect(marked(sheet)).toEqual(['Design']);

  // Closed, scrolled on, and opened again: it marks where the reader is now.
  click(sheet!.querySelector('[aria-label="Close contents"]'));
  layOut({ ...MID_DESIGN, Design: -700, 'Idempotency keys': -200, Rollout: 300 });
  click(host!.querySelector('[data-contents-open]'));
  expect(marked(document.querySelector('[data-contents="sheet"]'))).toEqual(['Idempotency keys']);
});

test.skipIf(!hasDom)('the sheet scrolls its own list to the marked heading, at once', async () => {
  await renderPane(PLAN, { phone: true });
  layOut(AT_TOP);
  click(host!.querySelector('[data-contents-open]'));
  const list = document.querySelector<HTMLElement>('[data-contents="sheet"] .ib-contents-list')!;
  // inbox.css lets it scroll; happy-dom lays nothing out, so the sizes are given here:
  // a 100 px list of 300 px of entries, "Idempotency keys" drawn 130 px down.
  list.style.overflowY = 'auto';
  Object.defineProperty(list, 'clientHeight', { configurable: true, value: 100 });
  Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 300 });
  list.getBoundingClientRect = () => new DOMRect(0, 0, 300, 100);
  const keys = [...list.querySelectorAll<HTMLElement>('nav button')].find((b) => b.textContent === 'Idempotency keys')!;
  keys.getBoundingClientRect = () => new DOMRect(0, 130 - list.scrollTop, 300, 30);
  // "Idempotency keys" (940 px down) past the line.
  await scrollBy(900);
  const pageScroll = docScroll().scrollTop;
  expect(marked(list)).toEqual(['Idempotency keys']);
  // Just enough to show it (its bottom at the list's bottom); the document does not move.
  expect(list.scrollTop).toBe(60);
  expect(docScroll().scrollTop).toBe(pageScroll);
});

test.skipIf(!hasDom)('the sheet holds focus: Tab wraps inside it, Escape closes it before full screen sees the key, focus goes back', async () => {
  let left = 0;
  await renderPane(PLAN, { full: true }, { toggleFull: () => left++, close: () => left++ });
  // Full screen with no room for the rail: the button and the sheet.
  await layOutPage(676, 652);
  const opener = host!.querySelector<HTMLElement>('[data-contents-open]')!;
  click(opener);
  const sheet = document.querySelector<HTMLElement>('[data-contents="sheet"]')!;
  expect(sheet.getAttribute('aria-modal')).toBe('true');
  const close = sheet.querySelector<HTMLElement>('[aria-label="Close contents"]')!;
  const last = [...sheet.querySelectorAll<HTMLElement>('nav button')].at(-1)!;
  expect(document.activeElement).toBe(close);

  // Tab past the last entry comes back to Close; Shift+Tab from Close goes to the last entry.
  act(() => last.focus());
  key(last, { key: 'Tab' });
  expect(document.activeElement).toBe(close);
  key(close, { key: 'Tab', shiftKey: true });
  expect(document.activeElement).toBe(last);

  // Focus off the sheet (a click on the page's chrome behind it): Escape still closes the sheet, not full screen.
  act(() => last.blur());
  key(document.body, { key: 'Escape' });
  expect(document.querySelector('[data-contents="sheet"]')).toBeNull();
  expect(document.activeElement).toBe(opener);
  expect(left).toBe(0);
  // The next Escape is full screen's again (its ladder's last rung leaves it).
  key(document.body, { key: 'Escape' });
  expect(left).toBe(1);
});

test.skipIf(!hasDom)('the phone surface: a Contents button opens the sheet at the section being read; a pick scrolls there and closes it', async () => {
  const { SurfaceDocument } = await import('./surface/SurfaceDocument');
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(
      <SurfaceDocument
        open={{ v: 1, type: 'open_attachment', attachment, version: 'current', text: PLAN, html: null, annotations: [], focus: null }}
        records={[]}
        interact={false}
      />,
    );
  });
  const scroll = host.querySelector<HTMLElement>('.sf-docscroll')!;
  expect(scroll.querySelector('article')?.textContent).toContain('Refund worker');
  layOut(MID_DESIGN, scroll);
  click(host.querySelector('[data-contents-open]'));
  const sheet = host.querySelector('[data-contents="sheet"][role="dialog"]');
  expect(entries(sheet)).toEqual(HEADINGS);
  expect(marked(sheet)).toEqual(['Design']);

  const calls: ScrollToOptions[] = [];
  scroll.scrollTo = ((options: ScrollToOptions) => void calls.push(options)) as typeof scroll.scrollTo;
  click([...sheet!.querySelectorAll('nav button')].find((b) => b.textContent === 'Rollout'));
  // "Rollout" reads 940 px down: TableOfContents' offset leaves 80 px above it.
  expect(calls).toEqual([{ top: 860, behavior: 'smooth' }]);
  expect(host.querySelector('[data-contents="sheet"]')).toBeNull();
});

test.skipIf(!hasDom)('a file whose sections are level 4 lists them in the sheet too (the rail\'s levels)', async () => {
  await renderPane('# Refund worker\n\nIntro.\n\n#### Context\n\nA.\n\n#### Design\n\nB.\n\n#### Rollout\n\nC.\n');
  await layOutPage(676, 652);
  click(host!.querySelector('[data-contents-open]'));
  expect(entries(document.querySelector('[data-contents="sheet"]'))).toEqual(['Refund worker', 'Context', 'Design', 'Rollout']);
});

test.skipIf(!hasDom)('a rail that never draws leaves the Contents button and sheet', async () => {
  // The deferred rail waits for an idle moment that never comes.
  const idle = window as unknown as Record<'requestIdleCallback' | 'cancelIdleCallback', unknown>;
  const real = { request: idle.requestIdleCallback, cancel: idle.cancelIdleCallback };
  idle.requestIdleCallback = () => 0;
  idle.cancelIdleCallback = () => {};
  // Restored after the pane unmounts (afterEach unmounts first): the rail's cleanup cancels its idle wait.
  afterThis(() => {
    idle.requestIdleCallback = real.request;
    idle.cancelIdleCallback = real.cancel;
  });
  await renderPane(PLAN);
  await layOutPage(1000, 820);
  expect(railOf()).toBeNull();
  // While the rail may still be on its way, no stand-in flashes.
  expect(host!.querySelector('[data-contents-open], [data-contents-show]')).toBeNull();
  // Past the rail's wait (its 2 s idle cap and a measure): the button and the sheet.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 2_600));
  });
  click(host!.querySelector('[data-contents-open]'));
  expect(entries(document.querySelector('[data-contents="sheet"]'))).toEqual(HEADINGS);
}, 10_000);

test.skipIf(!hasDom)('Hide and Show move focus to the control that takes their place', async () => {
  await renderPane(PLAN, { full: true });
  await layOutPage(1000, 820);
  click(ticks()[0]);
  const hide = railOf()!.querySelector<HTMLElement>('[data-contents-hide]')!;
  act(() => hide.focus());
  click(hide);
  expect(railOf()).toBeNull();
  expect(document.activeElement).toBe(host!.querySelector('[data-contents-show]'));
  click(host!.querySelector('[data-contents-show]'));
  // The rail's current tick (its one tab stop).
  expect(document.activeElement).toBe(ticks()[0]!);
  expect(ticks()[0]!.getAttribute('aria-current')).toBe('location');
});
