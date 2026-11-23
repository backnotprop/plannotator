/**
 * Stepping a thread's files on a touch tablet (approval "inbox-touch-file-stepping", "Arrows plus a swipe"): the bar
 * under the open file with finger-sized ‹ ›, beside the thread and in full screen, and the phone's swipe on the file,
 * with the window's left edge left to the browser's Back (the owner's condition).
 *
 * What is proved here, on the pane as the thread drives it: the bar is there only on a touch screen without the
 * phone layout (a mouse keeps its stepper and no bar in full screen; a phone keeps its toolbar); ‹ › step in the
 * thread's order and stop at the ends with the end note; a swipe that starts within the left edge is never taken
 * (no move, no preventDefault), while one from the right edge or the middle steps; a block that scrolls sideways and
 * an HTML page keep their touches; the bar hides while the on-screen keyboard is up.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeAll, expect, test } from 'bun:test';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAttachmentState, InboxMessageWire, InboxProject, InboxThread } from '@plannotator/core/inbox-types';
import { fileEntryOp } from './fullScreenOrigin';
import { attachmentSequence, LAST_NOTE, FIRST_NOTE, type AttachmentStep } from './stepping';
import { PHONE_QUERY, TOUCH_QUERY } from './phone';
import { keyboardCovers } from './touchStepBar';

const hasDom = typeof document !== 'undefined';
const { AttachmentPane } = (hasDom ? await import('./components/AttachmentPane') : {}) as typeof import('./components/AttachmentPane');
const { ThreadPane } = (hasDom ? await import('./components/Thread') : {}) as typeof import('./components/Thread');

let root: Root | null = null;
let host: HTMLElement | null = null;
const realFetch = globalThis.fetch;
const realMatchMedia = hasDom ? window.matchMedia : undefined;
const realViewport = hasDom ? Object.getOwnPropertyDescriptor(window, 'visualViewport') : undefined;

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
    if (realViewport) Object.defineProperty(window, 'visualViewport', realViewport);
    else delete (window as { visualViewport?: unknown }).visualViewport;
    (document.activeElement as HTMLElement | null)?.blur?.();
    for (const stray of document.querySelectorAll('[data-test-stray], .pn-inbox')) stray.remove();
  }
});

const M1 = 'msg_01K7M1MMMMMMMMMMMMMMMMMMMM';
const M2 = 'msg_01K7M2MMMMMMMMMMMMMMMMMMMM';

function file(id: string, name: string, kind: string, messageId: string): InboxAttachmentState {
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
  };
}

const notes = file('att_01K7AAAAAAAAAAAAAAAAAAAAAA', 'notes.md', 'markdown', M1);
const plan = file('att_01K7BBBBBBBBBBBBBBBBBBBBBB', 'plan.txt', 'text', M1);
const page = file('att_01K7DDDDDDDDDDDDDDDDDDDDDD', 'turnkey.html', 'html', M2);
const spec = file('att_01K7EEEEEEEEEEEEEEEEEEEEEE', 'spec.md', 'markdown', M2);
const ALL = [notes, plan, page, spec];

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

type Device = 'tablet' | 'mouse' | 'phone';

/** What the window's media queries say on each device (reduced motion on, so a committed swipe steps on release). */
function device(kind: Device) {
  window.matchMedia = ((query: string) => ({
    matches:
      query.includes('prefers-reduced-motion') ||
      (query === TOUCH_QUERY && kind !== 'mouse') ||
      (query === PHONE_QUERY && kind === 'phone'),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

function Pane({ start, full, phone, opened }: { start: InboxAttachmentState; full: boolean; phone: boolean; opened: string[] }) {
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
      full={full}
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

async function render(start: InboxAttachmentState, { on = 'tablet' as Device, full = true } = {}): Promise<string[]> {
  device(on);
  const opened: string[] = [];
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(<Pane start={start} full={full} phone={on === 'phone'} opened={opened} />);
  });
  await settle();
  return opened;
}

const bar = () => host!.querySelector<HTMLElement>('.ib-vfoot');
const prev = () => host!.querySelector<HTMLButtonElement>('.ib-vfoot [data-step-prev]')!;
const next = () => host!.querySelector<HTMLButtonElement>('.ib-vfoot [data-step-next]')!;
const area = () => host!.querySelector<HTMLElement>('.ib-docarea')!;
const live = () => host!.querySelector('[data-step-live]')!.textContent;

/** An iPad's width in portrait for the file and the body around it (happy-dom lays nothing out). */
function sized(el: HTMLElement, width = 820) {
  for (const node of [el, el.parentElement!]) node.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: width, bottom: 1100, width, height: 1100, toJSON: () => ({}) }) as DOMRect;
}

function touchEvent(target: EventTarget, type: string, points: { x: number; y: number }[]): Event {
  const event = new Event(type, { bubbles: true, cancelable: true, composed: true });
  const list = points.map((p, i) => ({ identifier: i, clientX: p.x, clientY: p.y, target }));
  Object.defineProperty(event, 'touches', { value: type === 'touchend' ? [] : list });
  Object.defineProperty(event, 'changedTouches', { value: list });
  target.dispatchEvent(event);
  return event;
}

/** One finger from `x` by `dx` sideways, then lifted; whether any move was cancelled (a cancelled move is not the page's). */
async function swipe(target: EventTarget, x: number, dx: number): Promise<boolean> {
  let cancelled = false;
  await act(async () => {
    touchEvent(target, 'touchstart', [{ x, y: 500 }]);
    for (let i = 1; i <= 6; i++) cancelled = touchEvent(target, 'touchmove', [{ x: x + (dx * i) / 6, y: 500 }]).defaultPrevented || cancelled;
    touchEvent(target, 'touchend', [{ x: x + dx, y: 500 }]);
  });
  await settle(40);
  return cancelled;
}

test.skipIf(!hasDom)('the bar is a touch tablet\'s only: beside the thread and in full screen there; a mouse keeps its stepper (no bar in full screen); a phone keeps its toolbar', async () => {
  stubViews();
  await render(plan, { full: false });
  expect(bar()!.getAttribute('data-touch-bar')).toBe('shown');
  act(() => root?.unmount());
  host?.remove();

  await render(plan);
  expect(bar()!.getAttribute('data-touch-bar')).toBe('shown');
  // The bar names the file in full screen: no step chip over the file.
  expect(host!.querySelector('[data-full-view-chip]')).toBeNull();
  expect(area().getAttribute('data-file-swipe')).toBe('follow');
  act(() => root?.unmount());
  host?.remove();

  await render(plan, { on: 'mouse', full: false });
  expect(bar()).not.toBeNull();
  expect(bar()!.hasAttribute('data-touch-bar')).toBe(false);
  expect(area().hasAttribute('data-file-swipe')).toBe(false);
  act(() => root?.unmount());
  host?.remove();

  await render(plan, { on: 'mouse' });
  expect(bar()).toBeNull();
  expect(host!.querySelector('[data-full-view-chip]')).not.toBeNull();
  act(() => root?.unmount());
  host?.remove();

  await render(plan, { on: 'phone' });
  expect(bar()).toBeNull();
});

test.skipIf(!hasDom)('‹ › step in the thread\'s order and stop at the ends with the end note', async () => {
  stubViews();
  const opened = await render(notes);
  expect(prev().getAttribute('aria-disabled')).toBe('true');
  await act(async () => prev().click());
  await settle();
  expect(opened).toEqual([]);
  expect(live()).toBe(FIRST_NOTE);
  expect(host!.querySelector('[data-step-end-note]')!.textContent).toBe(FIRST_NOTE);
  for (let i = 0; i < 3; i++) {
    await act(async () => next().click());
    await settle();
  }
  expect(opened).toEqual([plan.id, page.id, spec.id]);
  expect(next().getAttribute('aria-disabled')).toBe('true');
  await act(async () => next().click());
  await settle();
  expect(opened).toEqual([plan.id, page.id, spec.id]);
  expect(live()).toBe(LAST_NOTE);
  expect(host!.querySelector('[data-step-end-note]')!.textContent).toBe(LAST_NOTE);
  await act(async () => prev().click());
  await settle();
  expect(opened).toEqual([plan.id, page.id, spec.id, page.id]);
});

test.skipIf(!hasDom)('a swipe that starts within either side edge is Safari\'s Back or Forward: never moved, never cancelled, no step; from the middle it steps', async () => {
  stubViews();
  const opened = await render(plan);
  sized(area());
  // Toward the previous file (the finger moves right), from 10 px in: Safari's Back.
  expect(await swipe(area(), 10, 300)).toBe(false);
  expect(opened).toEqual([]);
  expect(area().style.transform).toBe('');
  // Toward the next file (the finger moves left), from 10 px inside the right side: Safari's Forward.
  expect(await swipe(area(), window.innerWidth - 10, -300)).toBe(false);
  expect(opened).toEqual([]);
  expect(area().style.transform).toBe('');
  // The same swipes from the middle step.
  expect(await swipe(area(), 300, 300)).toBe(true);
  expect(opened).toEqual([notes.id]);
  sized(area());
  expect(await swipe(area(), 500, -300)).toBe(true);
  expect(opened).toEqual([notes.id, plan.id]);
});

test.skipIf(!hasDom)('a block that scrolls sideways keeps the swipe, and an HTML page takes none: the bar still steps', async () => {
  stubViews();
  const opened = await render(plan);
  sized(area());
  const wide = document.createElement('div');
  wide.style.overflowX = 'auto';
  Object.defineProperty(wide, 'scrollWidth', { value: 2400 });
  Object.defineProperty(wide, 'clientWidth', { value: 780 });
  Object.defineProperty(wide, 'scrollLeft', { value: 0 });
  area().appendChild(wide);
  expect(await swipe(wide, 400, -300)).toBe(false);
  expect(opened).toEqual([]);
  wide.remove();

  await act(async () => next().click());
  await settle();
  expect(opened).toEqual([page.id]);
  expect(area().getAttribute('data-file-swipe')).toBe('none');
  sized(area());
  expect(await swipe(area(), 400, -300)).toBe(false);
  expect(opened).toEqual([page.id]);
  await act(async () => next().click());
  await settle();
  expect(opened).toEqual([page.id, spec.id]);
});

test('the on-screen keyboard is a visual viewport short of the layout by more than a hardware keyboard\'s bar, unzoomed', () => {
  expect(keyboardCovers(null, 1180)).toBe(false);
  expect(keyboardCovers({ height: 1180, scale: 1 }, 1180)).toBe(false);
  expect(keyboardCovers({ height: 1120, scale: 1 }, 1180)).toBe(false);
  expect(keyboardCovers({ height: 760, scale: 1 }, 1180)).toBe(true);
  // A pinch-zoom shrinks the visual viewport too: never a keyboard.
  expect(keyboardCovers({ height: 590, scale: 2 }, 1180)).toBe(false);
});

test.skipIf(!hasDom)('the bar hides while the on-screen keyboard is up and comes back when it goes down', async () => {
  stubViews();
  const listeners = new Set<() => void>();
  const vv = { height: 1180, scale: 1, offsetTop: 0, addEventListener: (_: string, fn: () => void) => listeners.add(fn), removeEventListener: (_: string, fn: () => void) => listeners.delete(fn) };
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: vv });
  Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, value: 1180 });
  try {
    await render(plan);
    expect(bar()!.getAttribute('data-touch-bar')).toBe('shown');
    vv.height = 760;
    await act(async () => {
      for (const fn of listeners) fn();
    });
    await settle(40);
    expect(bar()!.getAttribute('data-touch-bar')).toBe('typing');
    vv.height = 1180;
    await act(async () => {
      for (const fn of listeners) fn();
    });
    await settle(40);
    expect(bar()!.getAttribute('data-touch-bar')).toBe('shown');
  } finally {
    delete (document.documentElement as { clientHeight?: number }).clientHeight;
  }
});

test.skipIf(!hasDom)('a step from the touch bar replaces the history entry (never pushes one), so Back after any number of steps closes the file', async () => {
  device('tablet');
  const PROJECT: InboxProject = { id: 'prj_01M4H6G73M9H3Z32T859E72DPZ', key: 'shop-abcdef', name: 'shop', root: '/work/shop', created_at: '2026-10-10T10:00:00.000Z' };
  const files = [notes, plan, spec].map((f) => ({ ...f, message_id: M1, media_type: 'text/markdown' }));
  const thread: InboxThread = {
    thread_id: M1,
    project: PROJECT,
    subject: 'Shop notes',
    thread_name: null,
    resolved_at: null,
    messages: [
      { ...message(M1, '2026-10-10T10:42:00.000Z'), project_id: PROJECT.id, thread_id: M1, reply_to: null, subject: 'Shop notes', body: 'Three files.', resolved_at: null, idempotency_key: null, attachments: files } as InboxMessageWire,
    ],
  };
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.includes('/attachments') && !path.includes('/attachments/')) return Response.json({ serverSession: 's', attachments: files, annotations: [] });
    if (path.includes('/artifact-pins')) return Response.json({ pins: [] });
    if (path.includes('/sessions')) return Response.json({ serverSession: 's', home: '/home/me', project: PROJECT, sessions: [] });
    const att = files.find((a) => path.includes(a.id));
    if (att && path.includes('/view')) return Response.json({ attachment: att, version: 'current', text: `# ${att.name}\n`, html: null });
    return Response.json({});
  }) as typeof fetch;
  const calls: { id: string | undefined; options: { move?: string; replace?: boolean; back?: boolean } | undefined }[] = [];
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  const at = { id: files[0]!.id, version: 'current' as const, focus: null, view: 'full' as const };
  await act(async () => {
    root = createRoot(host!);
    root.render(
      <ThreadPane thread={thread} sent={null} onQuestions={() => {}} onChanged={async () => {}} onClose={() => {}} file={at} onOpenFile={(file, options) => calls.push({ id: file?.id, options })} onOpenGuide={() => {}} />,
    );
  });
  await settle(120);
  expect(bar()!.getAttribute('data-touch-bar')).toBe('shown');
  await act(async () => next().click());
  await settle();
  expect(calls.at(-1)!.id).toBe(files[1]!.id);
  expect(calls.at(-1)!.options).toEqual({ replace: true });
  // What the window does with that request (App.tsx `onOpenFile`): it swaps the entry on screen, keeping its full-screen mark.
  const now = { hash: `#thread=${M1}&file=${files[0]!.id}&view=full`, state: null };
  expect(fileEntryOp(now, `#thread=${M1}&file=${files[1]!.id}&view=full`, calls.at(-1)!.options as { replace?: boolean }).kind).toBe('replace');
});
