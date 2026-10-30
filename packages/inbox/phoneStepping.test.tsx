/**
 * Stepping through a thread's files on a phone (approval
 * "mobile-file-stepping", toolbar-swipe): the toolbar's `2/5 ⌄` pill opens
 * every file in one tap, and a sideways swipe on the file steps.
 *
 * What is proved here, on the pane as the thread drives it: the pill's name,
 * place and one-tap sheet (focus back on it; a pick steps); a desktop keeps
 * its own N/M and inline peek; the swipe follows the finger and shows the
 * "Next · name" card, steps past a third of the width, springs back short of
 * it, resists at the last file and says the end note; and every case it
 * leaves alone: a vertical scroll, two fingers, selected text, a block that
 * scrolls sideways (and the same block at its edge, which steps), HTML pages,
 * a desktop, an open sheet (images follow the finger too: imageSwipe.test.tsx); a typed comment asks
 * first; reduced motion steps on release without following. The real-touch
 * proof is tests/e2e/inbox-phone-stepping.spec.ts.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeAll, expect, test } from 'bun:test';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAttachmentState, InboxMessageWire } from '@plannotator/core/inbox-types';
import { attachmentSequence, type AttachmentStep } from './stepping';
import { SWIPE_SLIDE_MS, fileSwipeMode } from './fileSwipe';

const hasDom = typeof document !== 'undefined';
const { AttachmentPane } = (hasDom ? await import('./components/AttachmentPane') : {}) as typeof import('./components/AttachmentPane');

let root: Root | null = null;
let host: HTMLElement | null = null;
const realFetch = globalThis.fetch;
const realMatchMedia = hasDom ? window.matchMedia : undefined;

beforeAll(() => {
  if (hasDom) (window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL('http://localhost:4000/');
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = realFetch;
  if (hasDom) {
    window.matchMedia = realMatchMedia!;
    window.getSelection()?.removeAllRanges();
    for (const stray of document.querySelectorAll('[data-test-stray], .pn-inbox')) stray.remove();
  }
});

const M1 = 'msg_01K7M1MMMMMMMMMMMMMMMMMMMM';
const M2 = 'msg_01K7M2MMMMMMMMMMMMMMMMMMMM';

function file(id: string, name: string, kind: string, messageId: string, extra: Partial<InboxAttachmentState> = {}): InboxAttachmentState {
  return {
    id,
    name,
    path: `/work/shop/${name}`,
    kind: kind as InboxAttachmentState['kind'],
    named_path: null,
    sent_sha256: 'a'.repeat(64),
    size: 1000,
    sent_at: '2026-10-10T10:42:00.000Z',
    sent_mtime: '2026-10-10T10:42:00.000Z',
    message_id: messageId,
    changed_since_sent: false,
    unavailable: null,
    current: { sha256: 'a'.repeat(64), size: 1000, mtime: '2026-10-10T10:42:00.000Z' },
    ...extra,
  };
}

const notes = file('att_01K7AAAAAAAAAAAAAAAAAAAAAA', 'notes.md', 'markdown', M1);
const plan = file('att_01K7BBBBBBBBBBBBBBBBBBBBBB', 'plan.txt', 'text', M1);
const shot = file('att_01K7CCCCCCCCCCCCCCCCCCCCCC', 'shot.png', 'image', M2, { media_type: 'image/png' });
const page = file('att_01K7DDDDDDDDDDDDDDDDDDDDDD', 'turnkey.html', 'html', M2);
const spec = file('att_01K7EEEEEEEEEEEEEEEEEEEEEE', 'spec.pdf', 'pdf', M2);
const ALL = [notes, plan, shot, page, spec];

function message(id: string, createdAt: string): InboxMessageWire {
  return { id, created_at: createdAt, author: { kind: 'agent', host: 'claude-code', session: 'ses_a', name: 'Claude' } } as unknown as InboxMessageWire;
}

const STEPS: AttachmentStep[] = attachmentSequence([message(M1, '2026-10-10T10:42:00.000Z'), message(M2, '2026-10-10T11:06:00.000Z')], ALL);

function stubViews() {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    const att = ALL.find((a) => url.includes(a.id));
    if (att && url.includes('/view')) {
      const html = att.kind === 'html' ? '<h1>Checkout</h1>' : null;
      return new Response(JSON.stringify({ attachment: att, version: 'current', text: html ?? `# ${att.name}\n\nShip it on Friday.\n`, html }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
}

/** The pane as the thread drives it on a phone (always full screen); a step opens the next file in place. */
function Pane({ start, phone = true, opened }: { start: InboxAttachmentState; phone?: boolean; opened: string[] }) {
  const [open, setOpen] = useState(start);
  const noop = () => {};
  return (
    <AttachmentPane
      attachment={open}
      attachments={ALL}
      records={[]}
      agent="Claude Code"
      projectName="shop"
      projectRoot="/work/shop"
      version="current"
      onVersion={noop}
      full
      fullLocked={phone}
      onToggleFull={noop}
      focusId={null}
      readOnly={false}
      onSaved={noop}
      onRemoved={noop}
      onOpenAt={noop}
      onClose={noop}
      strip={{ picks: 0, annotations: 0, onWriteReply: noop }}
      steps={STEPS}
      phone={phone}
      onStep={(id) => {
        opened.push(id);
        setOpen(ALL.find((a) => a.id === id)!);
      }}
    />
  );
}

async function settle(ms = 60) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function render(start: InboxAttachmentState, phone = true): Promise<string[]> {
  const opened: string[] = [];
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(<Pane start={start} phone={phone} opened={opened} />);
  });
  await settle();
  return opened;
}

const pill = () => host!.querySelector<HTMLButtonElement>('[data-full-view-bar] [data-full-view-position]');
const area = () => host!.querySelector<HTMLElement>('.ib-docarea')!;
const live = () => host!.querySelector('[data-step-live]')!.textContent;
const card = () => host!.querySelector<HTMLElement>('[data-file-swipe-card]');

/** The phone's width for the file and the body around it, where the swipe is heard (happy-dom lays nothing out). */
function sized(el: HTMLElement, width = 390) {
  for (const node of [el, el.parentElement!]) node.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: width, bottom: 700, width, height: 700, toJSON: () => ({}) }) as DOMRect;
}

function reducedMotion(on: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: on && query.includes('prefers-reduced-motion'),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

/** A touch event as a phone sends it (happy-dom has no Touch constructor). */
function touchEvent(target: EventTarget, type: string, points: { x: number; y: number }[]): Event {
  const event = new Event(type, { bubbles: true, cancelable: true, composed: true });
  const list = points.map((p, i) => ({ identifier: i, clientX: p.x, clientY: p.y, target }));
  Object.defineProperty(event, 'touches', { value: type === 'touchend' ? [] : list });
  Object.defineProperty(event, 'changedTouches', { value: list });
  target.dispatchEvent(event);
  return event;
}

/** One finger from (200, 300) by (dx, dy), in `moves` moves, then lifted (unless `lift` is false). */
async function drag(target: EventTarget, dx: number, dy = 0, { moves = 6, lift = true, fingers = 1 } = {}) {
  const from = { x: 200, y: 300 };
  const extra = (p: { x: number; y: number }) => (fingers === 2 ? [p, { x: p.x + 60, y: p.y }] : [p]);
  await act(async () => {
    touchEvent(target, 'touchstart', extra(from));
    for (let i = 1; i <= moves; i++) touchEvent(target, 'touchmove', extra({ x: from.x + (dx * i) / moves, y: from.y + (dy * i) / moves }));
  });
  if (lift) {
    await act(async () => {
      touchEvent(target, 'touchend', [{ x: from.x + dx, y: from.y + dy }]);
    });
  }
}

test('which files take the swipe', () => {
  expect(fileSwipeMode('markdown', false)).toBe('follow');
  expect(fileSwipeMode('text', false)).toBe('follow');
  expect(fileSwipeMode('code', false)).toBe('follow');
  expect(fileSwipeMode('pdf', false)).toBe('follow');
  expect(fileSwipeMode('file', false)).toBe('follow');
  // A text file too large to show is the download card.
  expect(fileSwipeMode('html', true)).toBe('follow');
  expect(fileSwipeMode('image', false)).toBe('follow');
  for (const kind of ['html', 'mermaid', 'graphviz', 'video'] as const) expect(fileSwipeMode(kind, false)).toBe('none');
});

test.skipIf(!hasDom)('the pill: named "2/5: file 2 of 5, plan.txt. Show every file" (its visible text first), after the count; one tap opens the sheet, Escape puts focus back on it, a pick steps', async () => {
  stubViews();
  const opened = await render(plan);
  const button = pill()!;
  expect(button).not.toBeNull();
  expect(button.getAttribute('aria-label')).toBe('2/5: file 2 of 5, plan.txt. Show every file');
  expect(button.classList.contains('ib-fvpill')).toBe(true);
  expect(button.textContent).toBe('2/5');
  expect(button.getAttribute('aria-haspopup')).toBe('grid');
  expect(button.getAttribute('aria-expanded')).toBe('false');
  // No inline peek on a phone: one tap opens the bottom sheet in the Inbox's root.
  await act(async () => button.click());
  await settle();
  expect(button.getAttribute('aria-expanded')).toBe('true');
  const grid = document.querySelector<HTMLElement>('.pn-inbox-peek [role="grid"]')!;
  expect(grid).not.toBeNull();
  expect(button.getAttribute('aria-controls')).toBe(grid.id);
  expect(host!.querySelector('.ib-fvpeek')).toBeNull();
  await act(async () => grid.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  await settle(80);
  expect(document.querySelector('.pn-inbox-peek [role="grid"]')).toBeNull();
  expect(document.activeElement).toBe(pill());
  // A pick in the sheet steps there.
  await act(async () => pill()!.click());
  await settle();
  const cell = [...document.querySelectorAll<HTMLElement>('.pn-inbox-peek [role="gridcell"]')].find((c) => c.textContent?.includes('spec.pdf'))!;
  await act(async () => cell.click());
  await settle();
  expect(opened).toEqual([spec.id]);
  expect(pill()!.getAttribute('aria-label')).toBe('5/5: file 5 of 5, spec.pdf. Show every file');
});

test.skipIf(!hasDom)('a desktop keeps its own N/M (named by the file) and the inline peek; no swipe there', async () => {
  stubViews();
  await render(plan, false);
  const button = pill()!;
  expect(button.classList.contains('ib-fvpill')).toBe(false);
  expect(button.getAttribute('aria-label')).toBe('2 of 5, plan.txt. Show every file in this thread');
  await act(async () => button.click());
  await settle();
  expect(host!.querySelector('.ib-fvpeek [role="grid"]')).not.toBeNull();
  expect(document.querySelector('.pn-inbox-peek')).toBeNull();
  expect(area().hasAttribute('data-file-swipe')).toBe(false);
});

test.skipIf(!hasDom)('a swipe on a document follows the finger with the "Next · name" card and steps past a third of the width', async () => {
  stubViews();
  reducedMotion(false);
  const opened = await render(notes);
  expect(area().getAttribute('data-file-swipe')).toBe('follow');
  sized(area());
  await drag(area(), -180, 6, { lift: false });
  // The file follows the finger; the card names what comes in.
  expect(area().style.transform).toBe('translateX(-180px)');
  expect(card()!.getAttribute('data-file-swipe-card')).toBe('next');
  expect(card()!.textContent).toContain('Next');
  expect(card()!.textContent).toContain('plan.txt');
  expect(card()!.getAttribute('aria-hidden')).toBe('true');
  await act(async () => {
    touchEvent(area(), 'touchend', [{ x: 20, y: 306 }]);
  });
  // It slides out, then the next file opens and slides in.
  expect(opened).toEqual([]);
  await settle(SWIPE_SLIDE_MS + 60);
  expect(opened).toEqual([plan.id]);
  expect(card()).toBeNull();
  // The step is said once in the live region, as any step.
  await settle(400);
  expect(live()).toContain('2 of 5, plan.txt');
  // And back: a swipe the other way names the previous file.
  sized(area());
  await drag(area(), 180, 0, { lift: false });
  expect(card()!.getAttribute('data-file-swipe-card')).toBe('previous');
  expect(card()!.textContent).toContain('notes.md');
  await act(async () => {
    touchEvent(area(), 'touchend', [{ x: 380, y: 300 }]);
  });
  await settle(SWIPE_SLIDE_MS + 60);
  expect(opened).toEqual([plan.id, notes.id]);
});

test.skipIf(!hasDom)('a finger that comes back while the file is still sliding away is heard: that step lands at once and the next swipe starts from it', async () => {
  stubViews();
  reducedMotion(false);
  const opened = await render(notes);
  sized(area());
  await drag(area(), -200, 0);
  // Still sliding off toward plan.txt; the file is off to the left, so the next finger lands on the body around it.
  expect(area().style.transform).toBe('translateX(-390px)');
  expect(opened).toEqual([]);
  const body = area().parentElement!;
  await act(async () => touchEvent(body, 'touchstart', [{ x: 200, y: 300 }]));
  expect(opened).toEqual([plan.id]);
  expect(area().style.transform).toBe('');
  await act(async () => {
    for (let i = 1; i <= 6; i++) touchEvent(body, 'touchmove', [{ x: 200 - (200 * i) / 6, y: 300 }]);
  });
  expect(area().style.transform).toBe('translateX(-200px)');
  await act(async () => touchEvent(body, 'touchend', [{ x: 0, y: 300 }]));
  await settle(SWIPE_SLIDE_MS + 60);
  expect(opened).toEqual([plan.id, shot.id]);
});

test.skipIf(!hasDom)('short of the line it springs back; a vertical scroll and two fingers are left alone', async () => {
  stubViews();
  reducedMotion(false);
  const opened = await render(notes);
  sized(area());
  // 30 px: under the flick's 40 px and a third of the width.
  await drag(area(), -30, 0);
  await settle(SWIPE_SLIDE_MS + 60);
  expect(opened).toEqual([]);
  expect(area().style.transform).toBe('');
  // More down than across: a scroll, never a swipe (and never cancelled).
  let moved: Event | null = null;
  await act(async () => {
    touchEvent(area(), 'touchstart', [{ x: 200, y: 300 }]);
    moved = touchEvent(area(), 'touchmove', [{ x: 170, y: 360 }]);
    touchEvent(area(), 'touchmove', [{ x: 100, y: 420 }]);
    touchEvent(area(), 'touchend', [{ x: 100, y: 420 }]);
  });
  await settle(SWIPE_SLIDE_MS + 60);
  expect(moved!.defaultPrevented).toBe(false);
  expect(opened).toEqual([]);
  expect(area().style.transform).toBe('');
  // Two fingers: a pinch.
  await drag(area(), -200, 0, { fingers: 2 });
  await settle(SWIPE_SLIDE_MS + 60);
  expect(opened).toEqual([]);
  expect(card()).toBeNull();
});

test.skipIf(!hasDom)('at the last file it resists, shows no card, and a release past the line says "Last file in this thread"', async () => {
  stubViews();
  reducedMotion(false);
  const opened = await render(spec);
  expect(area().getAttribute('data-file-swipe')).toBe('follow');
  sized(area());
  await drag(area(), -210, 0, { lift: false });
  expect(area().style.transform).toBe('translateX(-70px)');
  expect(card()).toBeNull();
  await act(async () => {
    touchEvent(area(), 'touchend', [{ x: -10, y: 300 }]);
  });
  await settle(80);
  expect(opened).toEqual([]);
  expect(area().style.transform).toBe('');
  expect(live()).toBe('Last file in this thread');
  expect(host!.querySelector('[data-full-view-chip]')!.textContent).toContain('Last file in this thread');
});

test.skipIf(!hasDom)('selected text and a block that scrolls sideways keep the touch; the same block at its edge steps', async () => {
  stubViews();
  reducedMotion(true);
  const opened = await render(notes);
  sized(area());
  const words = document.createElement('p');
  words.textContent = 'A sentence the person selected.';
  area().appendChild(words);
  const range = document.createRange();
  range.selectNodeContents(words);
  window.getSelection()!.addRange(range);
  await drag(words, -200);
  await settle(80);
  expect(opened).toEqual([]);
  window.getSelection()!.removeAllRanges();
  // A wide code line or table: it scrolls sideways, so the touch is its own.
  const wide = document.createElement('div');
  wide.style.overflowX = 'auto';
  Object.defineProperty(wide, 'scrollWidth', { value: 1200 });
  Object.defineProperty(wide, 'clientWidth', { value: 360 });
  let left = 0;
  Object.defineProperty(wide, 'scrollLeft', { get: () => left });
  area().appendChild(wide);
  await drag(wide, -200);
  await settle(80);
  expect(opened).toEqual([]);
  // Scrolled to its end, it has nothing more that way: next steps.
  left = 840;
  await drag(wide, -200);
  await settle(80);
  expect(opened).toEqual([plan.id]);
});

test.skipIf(!hasDom)('reduced motion: nothing follows the finger, the step happens on release', async () => {
  stubViews();
  reducedMotion(true);
  const opened = await render(notes);
  sized(area());
  await drag(area(), -180, 0, { lift: false });
  expect(area().style.transform).toBe('');
  // The card still says where a release goes (no motion: it only appears).
  expect(card()!.textContent).toContain('plan.txt');
  await act(async () => {
    touchEvent(area(), 'touchend', [{ x: 20, y: 300 }]);
  });
  await settle(20);
  expect(opened).toEqual([plan.id]);
});

test.skipIf(!hasDom)('an HTML page takes no swipe from the pane; an image takes the pane\'s swipe (approval "inbox-image-swipe"); an open sheet stops it', async () => {
  stubViews();
  reducedMotion(true);
  const opened = await render(page);
  expect(area().getAttribute('data-file-swipe')).toBe('none');
  sized(area());
  await drag(area(), -200);
  await settle(80);
  expect(opened).toEqual([]);
  act(() => root?.unmount());
  host?.remove();

  const fromImage = await render(shot);
  expect(area().getAttribute('data-file-swipe')).toBe('follow');
  sized(area());
  // Anywhere over the image's area, as over a document (its own touchend-only swipe is off here).
  await drag(area(), -200);
  await settle(80);
  expect(fromImage).toEqual([page.id]);
  act(() => root?.unmount());
  host?.remove();

  // The pill's sheet open over a document: the swipe waits.
  const withSheet = await render(notes);
  sized(area());
  await act(async () => pill()!.click());
  await settle();
  await drag(area(), -200);
  await settle(80);
  expect(withSheet).toEqual([]);
});

test.skipIf(!hasDom)('a typed comment: the swipe springs back and the question row asks first', async () => {
  stubViews();
  reducedMotion(false);
  const opened = await render(notes);
  sized(area());
  const popover = document.createElement('div');
  popover.setAttribute('data-comment-popover', '');
  popover.setAttribute('data-test-stray', '');
  const box = document.createElement('textarea');
  box.value = 'Say why this ships on Friday.';
  popover.appendChild(box);
  document.body.appendChild(popover);
  await drag(area(), -200);
  await settle(80);
  expect(opened).toEqual([]);
  expect(area().style.transform).toBe('');
  expect(host!.querySelector('[data-step-guard]')).not.toBeNull();
  expect(host!.querySelector('[data-guard-discard]')!.textContent).toContain('plan.txt');
});

/** The phone's file sheet, opened from the toolbar's pill. */
async function openSheet() {
  await act(async () => pill()!.click());
  await settle();
  return document.querySelector<HTMLElement>('[data-image-peek-sheet]')!;
}
const prevButton = () => document.querySelector<HTMLButtonElement>('[data-peek-step-prev]');
const nextButton = () => document.querySelector<HTMLButtonElement>('[data-peek-step-next]');

test.skipIf(!hasDom)('the sheet the pill opens leads with ‹ Previous and Next ›, named with the file they go to; one tap steps and closes the sheet, focus back on the pill', async () => {
  stubViews();
  const opened = await render(plan);
  const sheet = await openSheet();
  const header = sheet.querySelector('[data-peek-sheet-header]')!;
  expect(header).not.toBeNull();
  // Above the grid and outside it (a grid holds only rows).
  expect(header.compareDocumentPosition(sheet.querySelector('[role="grid"]')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(sheet.querySelector('[role="grid"] [data-peek-step]')).toBeNull();
  expect(prevButton()!.getAttribute('aria-label')).toBe('Previous file: notes.md');
  expect(nextButton()!.getAttribute('aria-label')).toBe('Next file: shot.png');
  expect(prevButton()!.textContent).toBe('Previous');
  expect(nextButton()!.textContent).toBe('Next');
  expect(prevButton()!.hasAttribute('aria-disabled')).toBe(false);
  expect(header.querySelector('.ib-peekstep-n')!.textContent).toBe('2 of 5');
  await act(async () => nextButton()!.click());
  await settle(80);
  expect(opened).toEqual([shot.id]);
  // The sheet closes with the step: the new file is what you see.
  expect(document.querySelector('[data-image-peek-sheet]')).toBeNull();
  expect(document.activeElement).toBe(pill());
  expect(live()).toContain('3 of 5, shot.png');
});

test.skipIf(!hasDom)('Previous and Next show on every file, an HTML page included; at an end the button is aria-disabled, keeps focus and the sheet, and says the end', async () => {
  stubViews();
  const opened = await render(page);
  await openSheet();
  expect(prevButton()!.getAttribute('aria-label')).toBe('Previous file: shot.png');
  expect(nextButton()!.getAttribute('aria-label')).toBe('Next file: spec.pdf');
  await act(async () => prevButton()!.click());
  await settle(80);
  expect(opened).toEqual([shot.id]);
  act(() => root?.unmount());
  host?.remove();

  const fromLast = await render(spec);
  await openSheet();
  const next = nextButton()!;
  expect(next.getAttribute('aria-disabled')).toBe('true');
  expect(next.getAttribute('aria-label')).toBe('Next file: this is the last');
  next.focus();
  await act(async () => next.click());
  await settle(80);
  expect(fromLast).toEqual([]);
  expect(document.querySelector('[data-image-peek-sheet]')).not.toBeNull();
  expect(document.activeElement).toBe(next);
  expect(live()).toBe('Last file in this thread');
  // Escape in the header closes the sheet, focus back on the pill.
  await act(async () => next.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  await settle(80);
  expect(document.querySelector('[data-image-peek-sheet]')).toBeNull();
  expect(document.activeElement).toBe(pill());
});

test.skipIf(!hasDom)('focus never leaves the open sheet for the page behind: Shift+Tab out of Previous closes it (as Tab out of the grid does), focus back on the pill; Shift+Tab from Next stays inside', async () => {
  stubViews();
  await render(plan);
  await openSheet();
  // From Next, Shift+Tab is the browser's own move to Previous: nothing closes.
  const fromNext = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
  await act(async () => nextButton()!.dispatchEvent(fromNext));
  expect(fromNext.defaultPrevented).toBe(false);
  expect(document.querySelector('[data-image-peek-sheet]')).not.toBeNull();
  // From Previous (the sheet's first control), Shift+Tab would land behind the backdrop: the sheet closes instead.
  prevButton()!.focus();
  const fromPrev = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
  await act(async () => prevButton()!.dispatchEvent(fromPrev));
  await settle(80);
  expect(fromPrev.defaultPrevented).toBe(true);
  expect(document.querySelector('[data-image-peek-sheet]')).toBeNull();
  expect(document.activeElement).toBe(pill());
  // Tab out of the grid still closes it too.
  await openSheet();
  await act(async () => document.querySelector<HTMLElement>('.pn-inbox-peek [role="grid"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })));
  await settle(80);
  expect(document.querySelector('[data-image-peek-sheet]')).toBeNull();
  expect(document.activeElement).toBe(pill());
});

test.skipIf(!hasDom)('ImagePeek without a header is the sheet it was: no header, and Shift+Tab from the grid still closes it', async () => {
  const { ImagePeek } = await import('@plannotator/ui/components/ImagePeek');
  const closed: string[] = [];
  host = document.createElement('div');
  document.body.appendChild(host);
  const rows = [{ key: 'm1', label: '9:41 AM', items: [{ key: 'a', name: 'a.md', thumb: null, tile: 'MD' }] }];
  await act(async () => {
    root = createRoot(host!);
    root.render(<ImagePeek rows={rows} current="a" label="Files" variant="sheet" onClose={(r) => closed.push(r)} onPick={() => {}} />);
  });
  expect(document.querySelector('[data-peek-sheet-header]')).toBeNull();
  const grid = document.querySelector<HTMLElement>('[role="grid"]')!;
  expect(grid.className).toContain('rounded-t-[12px]');
  await act(async () => grid.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true })));
  expect(closed).toEqual(['key']);
  // With a header, Shift+Tab moves up into it instead of closing.
  closed.length = 0;
  await act(async () => {
    root!.render(<ImagePeek rows={rows} current="a" label="Files" variant="sheet" onClose={(r) => closed.push(r)} onPick={() => {}} sheetHeader={<button type="button">Prev</button>} />);
  });
  await act(async () => document.querySelector<HTMLElement>('[role="grid"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true })));
  expect(closed).toEqual([]);
});

test.skipIf(!hasDom)('a decided swipe cancels its moves (no scroll under it); the moves before the decision and a vertical scroll are left to the browser', async () => {
  stubViews();
  reducedMotion(false);
  await render(notes);
  sized(area());
  const moves: Event[] = [];
  await act(async () => {
    touchEvent(area(), 'touchstart', [{ x: 200, y: 300 }]);
    // Under the 10 px decision: not the swipe's yet.
    moves.push(touchEvent(area(), 'touchmove', [{ x: 196, y: 301 }]));
    // Decided: a swipe. This move and every one after it are cancelled, vertical drift included.
    moves.push(touchEvent(area(), 'touchmove', [{ x: 160, y: 304 }]));
    moves.push(touchEvent(area(), 'touchmove', [{ x: 120, y: 330 }]));
  });
  expect(moves.map((m) => m.defaultPrevented)).toEqual([false, true, true]);
  await act(async () => {
    touchEvent(area(), 'touchend', [{ x: 120, y: 330 }]);
  });
  await settle(SWIPE_SLIDE_MS + 60);
});

test.skipIf(!hasDom)('the code viewer draws the line under the finger again mid-gesture: a swipe whose first target left the page still steps', async () => {
  stubViews();
  reducedMotion(true);
  const opened = await render(notes);
  sized(area());
  // A line the viewer replaces once the finger is down: its later touch events fire at the detached node and bubble nowhere.
  const line = document.createElement('div');
  line.textContent = 'export function retry() {}';
  area().appendChild(line);
  await act(async () => {
    touchEvent(line, 'touchstart', [{ x: 200, y: 300 }]);
  });
  line.remove();
  const reached: string[] = [];
  const spy = (event: Event) => reached.push(event.type);
  area().addEventListener('touchmove', spy);
  let moved: Event | null = null;
  await act(async () => {
    touchEvent(line, 'touchmove', [{ x: 180, y: 301 }]);
    moved = touchEvent(line, 'touchmove', [{ x: 20, y: 304 }]);
    touchEvent(line, 'touchend', [{ x: 20, y: 304 }]);
  });
  area().removeEventListener('touchmove', spy);
  // Nothing reached the file itself: the swipe heard it on the line it started on.
  expect(reached).toEqual([]);
  expect(moved!.defaultPrevented).toBe(true);
  await settle(20);
  expect(opened).toEqual([plan.id]);
});

test.skipIf(!hasDom)('the file carries no inline transition once a spring-back or a slide-in has run', async () => {
  stubViews();
  reducedMotion(false);
  const opened = await render(notes);
  sized(area());
  await drag(area(), -30, 0);
  expect(area().style.transition).toContain('transform');
  await settle(320);
  expect(area().style.transition).toBe('');
  expect(area().style.transform).toBe('');
  sized(area());
  await drag(area(), -200, 0);
  await settle(SWIPE_SLIDE_MS + 60);
  expect(opened).toEqual([plan.id]);
  await settle(SWIPE_SLIDE_MS + 200);
  expect(area().style.transition).toBe('');
  expect(area().style.transform).toBe('');
  expect(area().style.opacity).toBe('');
});
