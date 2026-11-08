/**
 * The thread's bottom bar, B1 (approval "inbox-reaction-tray", addendum 2026-11-07): its line shows only while
 * thread text scrolls under it. The thread all fits, or is scrolled to its end: no line. Scrolled anywhere above
 * the end, or grown past the view with no scroll (a message arrives, the reply box opens): the line. Also the
 * window's stylesheet: no line and no shadow without `data-under`, both with it, and what is open (the open
 * questions, the checklist) pushed to the bar's right.
 *
 * What regresses: a line drawn over nothing at the end of a thread, a line missing while text runs under the
 * bar, a line that never comes back after the thread grows, and the open things falling back beside Reply.
 *
 * happy-dom has no layout: the thread's body gets its scroll sizes from the test, and a stand-in
 * ResizeObserver reports a size change when the test says so.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAuthor, InboxMessageWire, InboxProject, InboxThread } from '@plannotator/core/inbox-types';
import { textUnderFoot } from './footLine';

const hasDom = typeof document !== 'undefined';
const { ThreadPane } = (hasDom ? await import('./components/Thread') : {}) as typeof import('./components/Thread');

describe('what counts as text under the bar', () => {
  test('below the view by more than a pixel; at the end, a fraction short of it, or all fitting, nothing', () => {
    expect(textUnderFoot({ scrollHeight: 600, clientHeight: 600, scrollTop: 0 })).toBe(false);
    expect(textUnderFoot({ scrollHeight: 3000, clientHeight: 600, scrollTop: 0 })).toBe(true);
    expect(textUnderFoot({ scrollHeight: 3000, clientHeight: 600, scrollTop: 1200 })).toBe(true);
    expect(textUnderFoot({ scrollHeight: 3000, clientHeight: 600, scrollTop: 2400 })).toBe(false);
    // A zoomed page stops a fraction short of the end.
    expect(textUnderFoot({ scrollHeight: 3000, clientHeight: 600, scrollTop: 2399.5 })).toBe(false);
    expect(textUnderFoot({ scrollHeight: 3000, clientHeight: 600, scrollTop: 2390 })).toBe(true);
  });
});

const PROJECT: InboxProject = { id: 'prj_1', key: 'ledger-abcdef', name: 'ledger', root: '/work/ledger', created_at: '2026-11-07T09:00:00.000Z' };
const AGENT: InboxAuthor = { kind: 'agent', host: 'claude-code', session: 'ses_a', name: 'Claude Code' };
const ROOT = 'msg_A1';

function message(id: string, seq: number, body: string): InboxMessageWire {
  return {
    id,
    project_id: PROJECT.id,
    thread_id: ROOT,
    reply_to: id === ROOT ? null : ROOT,
    author: AGENT,
    subject: id === ROOT ? 'Migration dry run' : null,
    body,
    created_at: `2026-11-07T10:${String(10 + seq).padStart(2, '0')}:00.000Z`,
    resolved_at: null,
    idempotency_key: null,
    seq,
  };
}

const threadOf = (...messages: InboxMessageWire[]): InboxThread => ({
  thread_id: ROOT,
  project: PROJECT,
  subject: 'Migration dry run',
  thread_name: null,
  resolved_at: null,
  messages,
});

/** The thread body's scroll sizes, as the test sets them. */
const view = { scrollHeight: 600, clientHeight: 600, scrollTop: 0 };
/** Each stand-in ResizeObserver and what it observes: a size change reaches only the observers of that element. */
const observers: { fire: () => void; observed: Set<Element> }[] = [];
const restore: (() => void)[] = [];
let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;

/** On the thread's body only: every other element keeps happy-dom's own value. */
function stubOnBody(key: 'scrollHeight' | 'clientHeight' | 'scrollTop') {
  const saved = Object.getOwnPropertyDescriptor(Element.prototype, key) ?? Object.getOwnPropertyDescriptor(HTMLElement.prototype, key);
  const target = HTMLElement.prototype;
  const own = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, {
    configurable: true,
    get(this: HTMLElement) {
      if (this.classList?.contains('ib-pbody')) return view[key];
      return saved?.get ? saved.get.call(this) : 0;
    },
    set(this: HTMLElement, value: number) {
      if (this.classList?.contains('ib-pbody')) {
        if (key === 'scrollTop') view.scrollTop = value;
        return;
      }
      saved?.set?.call(this, value);
    },
  });
  restore.push(() => (own ? Object.defineProperty(target, key, own) : delete (target as unknown as Record<string, unknown>)[key]));
}

beforeEach(() => {
  if (!hasDom) return;
  Object.assign(view, { scrollHeight: 600, clientHeight: 600, scrollTop: 0 });
  observers.length = 0;
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.includes('/attachments')) return Response.json({ serverSession: 's', attachments: [], annotations: [] });
    if (path.includes('/sessions')) return Response.json({ serverSession: 's', home: '/home/me', project: PROJECT, sessions: [] });
    return Response.json({});
  }) as typeof fetch;
  for (const key of ['scrollHeight', 'clientHeight', 'scrollTop'] as const) stubOnBody(key);
  const savedRO = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver');
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    writable: true,
    value: class {
      live = true;
      observed = new Set<Element>();
      constructor(callback: () => void) {
        observers.push({ fire: () => this.live && callback(), observed: this.observed });
      }
      observe(el: Element) {
        this.observed.add(el);
      }
      unobserve(el: Element) {
        this.observed.delete(el);
      }
      disconnect() {
        this.live = false;
        this.observed.clear();
      }
    },
  });
  restore.push(() => (savedRO ? Object.defineProperty(globalThis, 'ResizeObserver', savedRO) : delete (globalThis as Record<string, unknown>).ResizeObserver));
});

afterEach(() => {
  if (!hasDom) return;
  try {
    act(() => root?.unmount());
    host?.remove();
  } finally {
    root = null;
    host = null;
    globalThis.fetch = savedFetch;
    for (const undo of restore.splice(0).reverse()) undo();
  }
});

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function render(thread: InboxThread) {
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(
      <ThreadPane
        thread={thread}
        onAck={() => {}}
        sent={null}
        lookSeq={9}
        onQuestions={() => {}}
        onChanged={async () => {}}
        onClose={() => {}}
        file={null}
        onOpenFile={() => {}}
        onOpenGuide={() => {}}
      />,
    );
  });
  await settle();
  return host;
}

const foot = () => document.querySelector<HTMLElement>('.ib-pfoot')!;
const lineShown = () => foot().hasAttribute('data-under');
const body = () => document.querySelector<HTMLElement>('.ib-pbody')!;

function scrollTo(top: number) {
  view.scrollTop = top;
  act(() => void body().dispatchEvent(new Event('scroll')));
}

/** `el` changed size (no scroll): the observers watching it hear of it, and no other. */
function resized(el: Element) {
  act(() => observers.filter((o) => o.observed.has(el)).forEach((o) => o.fire()));
}
/** What a message landing grows: the body's own box keeps its size, only its content (a child) gets taller. */
const content = () => body().lastElementChild!;

describe.skipIf(!hasDom)('the bar in the thread pane', () => {
  test('a short thread that all fits: no line', async () => {
    await render(threadOf(message(ROOT, 1, 'The dry run passed.')));
    expect(foot().querySelector('[data-reply-button]')).not.toBeNull();
    expect(lineShown()).toBe(false);
  });

  test('a long thread: the line while text is under the bar (the top, mid way), none at the end, back on the way up', async () => {
    Object.assign(view, { scrollHeight: 3000, clientHeight: 600, scrollTop: 0 });
    await render(threadOf(message(ROOT, 1, 'The full log.'), message('msg_A2', 2, 'Step 1 of 40.')));
    expect(lineShown()).toBe(true);
    scrollTo(1200);
    expect(lineShown()).toBe(true);
    scrollTo(2400);
    expect(lineShown()).toBe(false);
    scrollTo(2000);
    expect(lineShown()).toBe(true);
  });

  test('at the end, the thread grows past the view with no scroll (a message lands, the reply box opens): the line comes back', async () => {
    Object.assign(view, { scrollHeight: 3000, clientHeight: 600 });
    await render(threadOf(message(ROOT, 1, 'The full log.')));
    scrollTo(2400);
    expect(lineShown()).toBe(false);
    // A message lands below the end.
    view.scrollHeight = 3400;
    resized(content());
    expect(lineShown()).toBe(true);
    scrollTo(2800);
    expect(lineShown()).toBe(false);
    // The reply box opens: the thread's view (the body's own box) gets shorter.
    view.clientHeight = 400;
    resized(body());
    expect(lineShown()).toBe(true);
  });

  test('a short thread that grows to fill the view and more: the line comes then', async () => {
    await render(threadOf(message(ROOT, 1, 'Starting.')));
    expect(lineShown()).toBe(false);
    view.scrollHeight = 900;
    resized(content());
    expect(lineShown()).toBe(true);
  });

  test('a block added to the thread after it opened is watched too: its growing brings the line', async () => {
    await render(threadOf(message(ROOT, 1, 'Starting.')));
    const late = document.createElement('div');
    act(() => void body().appendChild(late));
    await settle();
    expect(lineShown()).toBe(false);
    view.scrollHeight = 900;
    resized(late);
    expect(lineShown()).toBe(true);
  });
});

// The window's stylesheet: happy-dom computes the cascade, not the layout.
test.skipIf(!hasDom)('the stylesheet: no line or shadow without text under the bar, both with it; the open things start the right group', async () => {
  const css = await Bun.file(new URL('./inbox.css', import.meta.url)).text();
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);
  const box = document.createElement('div');
  box.className = 'pn-inbox';
  const row = (buttons: string) => `<div class="ib-acts ib-footrow" data-foot-row=""><div class="ib-footbtns" data-foot-buttons="">${buttons}</div></div>`;
  const reply = '<button class="ib-btn" data-reply-button="">Reply</button>';
  const react = '<span class="ib-react"><button class="ib-btn ib-ack" data-ack="">Looks good</button></span>';
  const oq = '<button class="ib-btn ib-oq-btn" data-open-questions="">2 open questions</button>';
  const steps = '<button class="ib-btn ib-st-btn" data-steps-button="">3/6</button>';
  box.innerHTML = [
    `<div class="ib-pfoot" data-k="end">${row(reply + react)}</div>`,
    `<div class="ib-pfoot" data-under="" data-k="under">${row(reply + react)}</div>`,
    `<div class="ib-pfoot" data-k="both">${row(reply + oq + steps)}</div>`,
    `<div class="ib-pfoot" data-k="steps">${row(reply + react + steps)}</div>`,
  ].join('');
  document.body.appendChild(box);
  try {
    const at = (k: string) => box.querySelector<HTMLElement>(`[data-k="${k}"]`)!;
    const end = getComputedStyle(at('end'));
    const under = getComputedStyle(at('under'));
    expect(end.borderTopColor).toBe('transparent');
    // (happy-dom leaves the theme's color-mix() uncomputed: what it can read is that it is not hidden.)
    expect(under.borderTopColor).not.toBe('transparent');
    expect(['', 'none']).toContain(end.boxShadow);
    expect(under.boxShadow).toContain('18px');
    // The buttons fill the row, so an auto margin can push the open things to its right end.
    expect(getComputedStyle(at('end').querySelector('[data-foot-buttons]')!).flexGrow).toBe('1');
    const startOf = (k: string, sel: string) => getComputedStyle(at(k).querySelector(sel)!).marginInlineStart;
    expect(startOf('both', '[data-open-questions]')).toBe('auto');
    expect(startOf('both', '[data-steps-button]')).not.toBe('auto');
    expect(startOf('steps', '[data-steps-button]')).toBe('auto');
    expect(startOf('steps', '[data-reply-button]')).not.toBe('auto');
    expect(startOf('steps', '.ib-react')).not.toBe('auto');
  } finally {
    box.remove();
    style.remove();
  }
});
