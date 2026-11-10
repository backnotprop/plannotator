/**
 * Starred threads as pills above the list (approval "inbox-starred-pills"): "Keep starred above the list" in the
 * list's ⋮ menu, the pills it draws, and the sidebar's Starred section it takes away.
 *
 * What this catches: the choice on in an untouched browser, or today's sidebar section changed while it is off; the
 * starred threads in both places at once, or in neither; a choice forgotten on the next load; a click on the star
 * that also opens its thread, or a click on the pill that unstars; Move left and Move right moving the wrong way or
 * offered past an end; a third line of pills instead of "+N", a "+N" with no dot while a hidden thread waits, or one
 * whose menu loses a thread; a pill a screen reader hears without its state or "starred"; an empty band of pills
 * with nothing starred; a touch on the star unstarring; a long press that opens the thread.
 *
 * The list and the sidebar are drawn over a small holder of the stars that applies each action the way the window
 * does (pins.ts `movePin`), so no Inbox runs. The real window over the real server, the pills' look and the phone's
 * sideways line are proved against the compiled binary by tests/e2e/inbox-starred-pills.spec.ts.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxListRow, InboxListSection } from '@plannotator/core/inbox-types';
import type { TidyController } from './components/Tidy';
import type { PinnedAction } from './components/PinnedRow';
import { tooltipOf } from './testing/tooltip';

const hasDom = typeof document !== 'undefined';
const { InboxList } = (hasDom ? await import('./components/InboxList') : {}) as typeof import('./components/InboxList');
const { Sidebar } = (hasDom ? await import('./components/Sidebar') : {}) as typeof import('./components/Sidebar');
const { SidebarProvider } = (hasDom ? await import('./shell/sidebar') : {}) as typeof import('./shell/sidebar');
const { movePin } = await import('./pins');
const { STARRED_ABOVE_COOKIE, STARRED_ABOVE_LABEL, fitPills, pillName, resetStarredAboveForTests } = await import('./starredPills');
const { setStorageBackend, resetStorageBackend } = await import('@plannotator/ui/utils/storage');

const stored = new Map<string, string>();
let root: Root | null = null;
let host: HTMLElement | null = null;
let restore: (() => void)[] = [];

beforeEach(() => {
  stored.clear();
  setStorageBackend({
    getItem: (key) => stored.get(key) ?? null,
    setItem: (key, value) => void stored.set(key, value),
    removeItem: (key) => void stored.delete(key),
  });
  resetStarredAboveForTests();
});

afterEach(() => {
  if (hasDom) unmount();
  for (const undo of restore.splice(0)) undo();
  resetStorageBackend();
  resetStarredAboveForTests();
  if (hasDom) document.body.innerHTML = '';
});

function unmount() {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
}

const TIDY: TidyController = { surface: 'list', scope: null, plan: null, run: null, start: async () => null, refresh: () => {} };
const noop = () => {};

function row(id: string, subject: string, section: InboxListRow['section'], extra: Record<string, unknown> = {}): InboxListRow {
  return {
    thread_id: id,
    project: { id: 'prj_a', name: 'billing-svc' },
    subject,
    thread_name: null,
    author: { kind: 'agent', host: 'claude-code', session: 'ses_1', name: null },
    last_at: '2026-11-09T10:00:00Z',
    last_agent_at: '2026-11-09T10:00:00Z',
    last_author: 'agent',
    section,
    unread: section !== 'quiet' && section !== 'sent',
    unseen: 0,
    questions: { open: 0, picked: 0, stopped: false, holds_up: [] },
    sent: null,
    resolved_at: null,
    pinned_at: '2026-11-08T09:00:00Z',
    ...extra,
  } as unknown as InboxListRow;
}

const QUIET = row('msg_quiet', 'Release train', 'quiet');
const WAIT = row('msg_wait', 'Invoice retries', 'waiting', { questions: { open: 3, picked: 0, stopped: false, holds_up: [] } });
const STOP = row('msg_stop', 'On-call handoff', 'stopped', { questions: { open: 1, picked: 0, stopped: true, holds_up: [] } });
const NEWS = row('msg_news', 'Rate limiter', 'new', { unseen: 1 });
const STARS = [QUIET, WAIT, STOP, NEWS];

function sections(rows: readonly InboxListRow[]): InboxListSection[] {
  const ids = ['stopped', 'holding', 'waiting', 'new', 'sent', 'quiet'] as const;
  return ids.map((id) => ({ id, label: id, threads: rows.filter((r) => r.section === id) })) as unknown as InboxListSection[];
}

interface Calls {
  opened: string[];
  actions: Array<[string, PinnedAction]>;
}

/** The window's part: it holds the stars and applies an action as App.tsx does (Unstar drops one, a move is `movePin`). */
function Window({ start, calls, phone, tour, open }: { start: readonly InboxListRow[]; calls: Calls; phone: boolean; tour: boolean; open: string | null }) {
  const [pins, setPins] = useState(start);
  const onAction = (r: InboxListRow, action: PinnedAction) => {
    calls.actions.push([r.thread_id, action]);
    if (action === 'unpin') setPins((now) => now.filter((p) => p.thread_id !== r.thread_id));
    if (action === 'up' || action === 'down') {
      setPins((now) => {
        const order = movePin(now.map((p) => p.thread_id), r.thread_id, action === 'up' ? -1 : 1);
        return order.map((id) => now.find((p) => p.thread_id === id)!);
      });
    }
  };
  const onOpen = (r: InboxListRow) => void calls.opened.push(r.thread_id);
  return (
    <SidebarProvider>
      <Sidebar
        page="inbox"
        projectId={null}
        inboxCount={0}
        projects={[] as never}
        projectCounts={new Map()}
        projectActivity={new Map()}
        update={null}
        restarting={false}
        updated={null}
        onInbox={noop}
        onProject={noop}
        onSettings={noop}
        onUpdate={noop}
        onWhatsNew={noop}
        pins={pins}
        openThreadId={open}
        onOpenPin={onOpen}
        onPinAction={onAction}
        rememberSections={!tour}
      />
      <InboxList
        title="Inbox"
        path={null}
        sections={sections(STARS)}
        sort={{ epoch: 1, keep: null }}
        filtered={false}
        narrow={false}
        phone={phone}
        selectedThreadId={open}
        notice={null}
        onShowNew={noop}
        onOpen={noop}
        tidy={TIDY}
        rememberLook={!tour}
        starred={{ rows: pins, onOpen, onAction }}
      />
    </SidebarProvider>
  );
}

function draw(options: { start?: readonly InboxListRow[]; phone?: boolean; tour?: boolean; open?: string | null } = {}): { el: HTMLElement; calls: Calls } {
  const calls: Calls = { opened: [], actions: [] };
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<Window start={options.start ?? STARS} calls={calls} phone={options.phone ?? false} tour={options.tour ?? false} open={options.open ?? null} />));
  return { el: host, calls };
}

const settle = (ms = 0) => act(async () => void (await new Promise((resolve) => setTimeout(resolve, ms))));

async function tick(el: HTMLElement) {
  act(() => el.querySelector<HTMLButtonElement>('[data-tidy-menu]')!.click());
  await settle();
  const item = document.querySelector<HTMLElement>('[data-starred-above-option]');
  if (item) {
    act(() => item.click());
    await settle();
  }
  return item;
}

const pills = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>('li[data-pill-item]:not([data-over]) [data-starred-pill]')];
const pillIds = (el: HTMLElement) => pills(el).map((p) => p.dataset.starredPill);
const pill = (el: HTMLElement, id: string) => el.querySelector<HTMLElement>(`[data-starred-pill="${id}"]`)!;
const sidebarStars = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>('[data-pinned-section] [data-pinned-row]')].map((p) => p.dataset.pinnedRow);

async function menuOf(target: HTMLElement) {
  act(() => void target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 40, clientY: 40 })));
  await settle();
  return document.querySelector<HTMLElement>('[data-pill-menu]');
}

async function choose(menu: HTMLElement, action: string) {
  act(() => menu.querySelector<HTMLElement>(`[data-pill-action="${action}"]`)!.click());
  await settle();
}

/** happy-dom has no layout: every pill is `each` wide in a list `width` wide, "+N" is `more` wide. */
function layout(each: number, more: number, width: number) {
  const proto = HTMLElement.prototype;
  const offset = Object.getOwnPropertyDescriptor(proto, 'offsetWidth');
  const client = Object.getOwnPropertyDescriptor(proto, 'clientWidth');
  Object.defineProperty(proto, 'offsetWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return this.hasAttribute('data-pill-more') ? more : this.hasAttribute('data-pill-item') ? each : 0;
    },
  });
  Object.defineProperty(proto, 'clientWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains('ib-stars-l') ? width : 0;
    },
  });
  restore.push(() => {
    if (offset) Object.defineProperty(proto, 'offsetWidth', offset);
    else delete (proto as unknown as Record<string, unknown>).offsetWidth;
    if (client) Object.defineProperty(proto, 'clientWidth', client);
    else delete (proto as unknown as Record<string, unknown>).clientWidth;
  });
}

describe('the choice', () => {
  test.skipIf(!hasDom)("off in an untouched browser: no pills, the sidebar's Starred section as it was, nothing stored", async () => {
    const { el } = draw();
    expect(el.querySelector('[data-starred-pills]')).toBeNull();
    expect(sidebarStars(el)).toEqual(STARS.map((r) => r.thread_id));
    expect(stored.has(STARRED_ABOVE_COOKIE)).toBe(false);
    // The item is there to turn on, unchecked, a checkbox a screen reader hears with its state.
    act(() => el.querySelector<HTMLButtonElement>('[data-tidy-menu]')!.click());
    await settle();
    const item = document.querySelector<HTMLElement>('[data-starred-above-option]')!;
    expect(item.getAttribute('role')).toBe('menuitemcheckbox');
    expect(item.getAttribute('aria-checked')).toBe('false');
    expect(item.textContent).toBe(STARRED_ABOVE_LABEL);
  });

  test.skipIf(!hasDom)('on: the pills in star order above the list, and no Starred section in the sidebar; off again puts it back', async () => {
    const { el } = draw();
    const item = await tick(el);
    expect(item!.getAttribute('aria-checked')).toBe('true');
    expect(pillIds(el)).toEqual(STARS.map((r) => r.thread_id));
    expect(el.querySelector('[data-pinned-section]')).toBeNull();
    // Above the list's rows, under its header.
    const nav = el.querySelector('[data-starred-pills]')!;
    expect(nav.previousElementSibling?.classList.contains('ib-lhead')).toBe(true);
    expect(nav.compareDocumentPosition(el.querySelector('.ib-lbody')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    act(() => document.querySelector<HTMLElement>('[data-starred-above-option]')!.click());
    await settle();
    expect(el.querySelector('[data-starred-pills]')).toBeNull();
    expect(sidebarStars(el)).toEqual(STARS.map((r) => r.thread_id));
    expect(stored.has(STARRED_ABOVE_COOKIE)).toBe(false);
  });

  test.skipIf(!hasDom)('remembered by this browser: the next load draws the pills, never the section first', async () => {
    const first = draw();
    await tick(first.el);
    expect(stored.get(STARRED_ABOVE_COOKIE)).toBe('1');
    unmount();
    resetStarredAboveForTests();
    const { el } = draw();
    expect(pillIds(el)).toEqual(STARS.map((r) => r.thread_id));
    expect(el.querySelector('[data-pinned-section]')).toBeNull();
  });

  test.skipIf(!hasDom)('on with nothing starred: nothing is drawn above the list, and the item stays to turn it off', async () => {
    stored.set(STARRED_ABOVE_COOKIE, '1');
    const { el } = draw({ start: [] });
    expect(el.querySelector('[data-starred-pills]')).toBeNull();
    expect(el.querySelector('.ib-lhead')!.nextElementSibling?.classList.contains('ib-lbody')).toBe(true);
    expect(el.querySelector('[data-pinned-section]')).toBeNull();
    act(() => el.querySelector<HTMLButtonElement>('[data-tidy-menu]')!.click());
    await settle();
    expect(document.querySelector('[data-starred-above-option]')!.getAttribute('aria-checked')).toBe('true');
  });

  test.skipIf(!hasDom)("the tour ignores this browser's choice: its sidebar keeps the section and its list has no pills and no item", async () => {
    stored.set(STARRED_ABOVE_COOKIE, '1');
    const { el } = draw({ tour: true });
    expect(el.querySelector('[data-starred-pills]')).toBeNull();
    expect(sidebarStars(el)).toEqual(STARS.map((r) => r.thread_id));
    act(() => el.querySelector<HTMLButtonElement>('[data-tidy-menu]')!.click());
    await settle();
    expect(document.querySelector('[data-starred-above-option]')).toBeNull();
  });
});

describe('a pill', () => {
  beforeEach(() => void stored.set(STARRED_ABOVE_COOKIE, '1'));

  test.skipIf(!hasDom)('says its name, project, state and "starred"; shows its state; the open thread\'s is current', () => {
    const { el } = draw({ open: WAIT.thread_id });
    expect(el.querySelector('[data-starred-pills]')!.getAttribute('aria-label')).toBe('Starred');
    expect(pills(el).map((p) => p.getAttribute('aria-label'))).toEqual([
      'Release train, billing-svc, Quiet, starred',
      'Invoice retries, billing-svc, 3 questions, starred',
      'On-call handoff, billing-svc, Stopped, starred',
      'Rate limiter, billing-svc, New, starred',
    ]);
    expect(pill(el, WAIT.thread_id).querySelector('.ib-star-q')!.textContent).toBe('3');
    expect(pill(el, STOP.thread_id).querySelector('.ib-spill')!.getAttribute('data-k')).toBe('stop');
    expect(pill(el, NEWS.thread_id).querySelector('.ib-pdot')).not.toBeNull();
    expect(pill(el, QUIET.thread_id).querySelector('.ib-star-q, .ib-spill, .ib-pdot')).toBeNull();
    // Waiting pills stand out; a quiet one steps back.
    expect(pills(el).map((p) => p.hasAttribute('data-wake'))).toEqual([false, true, true, true]);
    expect(pills(el).map((p) => p.getAttribute('aria-current'))).toEqual([null, 'true', null, null]);
    // No agent mark on a pill: the star takes its place.
    expect(el.querySelector('[data-starred-pills] li[data-pill-item] .ib-mk')).toBeNull();
  });

  test.skipIf(!hasDom)('one open question reads "1 question", and a state with no words leaves no empty part in the name', () => {
    // The list's own count is empty for exactly one question (a row shows its glyph alone).
    const one = row('msg_one', 'Diff style', 'waiting', { questions: { open: 1, picked: 0, stopped: false, holds_up: [] } });
    const { el } = draw({ start: [one, ...STARS] });
    expect(pill(el, 'msg_one').getAttribute('aria-label')).toBe('Diff style, billing-svc, 1 question, starred');
    for (const p of pills(el)) expect(p.getAttribute('aria-label')).not.toMatch(/, ,|,\s*,/);
    const quiet = { kind: 'quiet', words: '', n: 0, calm: true } as const;
    expect(pillName({ row: one, label: 'Diff style', project: 'billing-svc', twin: false, state: quiet })).toBe('Diff style, billing-svc, starred');
    expect(pillName({ row: one, label: 'Diff style', project: '', twin: false, state: quiet })).toBe('Diff style, starred');
  });

  test.skipIf(!hasDom)('a click on the pill opens its thread and unstars nothing', () => {
    const { el, calls } = draw();
    act(() => pill(el, STOP.thread_id).click());
    expect(calls.opened).toEqual([STOP.thread_id]);
    expect(calls.actions).toEqual([]);
  });

  test.skipIf(!hasDom)('a click on the star unstars and never opens the thread; the star is out of the tab order', () => {
    const { el, calls } = draw();
    const star = el.querySelector<HTMLButtonElement>(`[data-pill-unstar="${WAIT.thread_id}"]`)!;
    expect(star.getAttribute('aria-label')).toBe('Unstar Invoice retries');
    expect(star.tabIndex).toBe(-1);
    // Not inside the pill's button: a press on it cannot reach the pill.
    expect(pill(el, WAIT.thread_id).contains(star)).toBe(false);
    act(() => star.click());
    expect(calls.actions).toEqual([[WAIT.thread_id, 'unpin']]);
    expect(calls.opened).toEqual([]);
    expect(pillIds(el)).toEqual([QUIET.thread_id, STOP.thread_id, NEWS.thread_id]);
  });

  test.skipIf(!hasDom)("a touch on the star opens the thread: on a touch screen the star is not a target of its own", () => {
    const { el, calls } = draw({ phone: true });
    const star = el.querySelector<HTMLButtonElement>(`[data-pill-unstar="${WAIT.thread_id}"]`)!;
    act(() => {
      star.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }));
      star.click();
    });
    expect(calls.actions).toEqual([]);
    expect(calls.opened).toEqual([WAIT.thread_id]);
  });

  test.skipIf(!hasDom)("the tooltip names the agent and its project, which the pill no longer shows", async () => {
    const { el } = draw();
    const tip = await tooltipOf(pill(el, QUIET.thread_id));
    expect(tip).toContain('Release train');
    expect(tip).toContain('Claude Code in billing-svc');
  });

  test.skipIf(!hasDom)("the label is the list row's bold line: the thread's name, never a subject that starts with it", async () => {
    // The sidebar's Starred row shows this thread's subject (it starts with the name); the pill and the list row do not.
    const named = row('msg_named', 'Highlight fixes: three highlighting bugs found and fixed', 'new', { thread_name: 'Highlight fixes', unseen: 1 });
    const { el } = draw({ start: [named, QUIET] });
    const target = pill(el, 'msg_named');
    expect(target.querySelector('.ib-star-n')!.textContent).toBe('Highlight fixes');
    expect(target.getAttribute('aria-label')).toBe('Highlight fixes, billing-svc, New, starred');
    // A thread with no name falls back as its row does, to the subject.
    expect(pill(el, QUIET.thread_id).querySelector('.ib-star-n')!.textContent).toBe('Release train');
    // The subject is the tooltip's second line, above the agent.
    const tip = await tooltipOf(target);
    expect(tip).toContain('Highlight fixes: three highlighting bugs found and fixed');
    expect(tip).toContain('Claude Code in billing-svc');
  });

  test.skipIf(!hasDom)('"+N" names a hidden thread the same way', async () => {
    layout(100, 50, 330);
    const rows = Array.from({ length: 9 }, (_, i) => row(`msg_n${i}`, `Stream ${i}: notes for the week`, 'quiet', { thread_name: `Stream ${i}` }));
    const { el } = draw({ start: rows });
    await settle();
    act(() => el.querySelector<HTMLButtonElement>('[data-pills-more]')!.click());
    await settle();
    expect(document.querySelector('[data-pills-more-item="msg_n8"] .ib-star-mi-l')!.textContent).toBe('Stream 8');
  });

  test.skipIf(!hasDom)('two pills with one name both show their project', () => {
    const twin = row('msg_twin', 'Release train', 'quiet', { project: { id: 'prj_b', name: 'docs-site' } });
    const { el } = draw({ start: [QUIET, twin, WAIT] });
    expect(pills(el).map((p) => p.querySelector('.ib-star-proj')?.textContent ?? null)).toEqual(['billing-svc', 'docs-site', null]);
  });
});

describe("a pill's menu", () => {
  beforeEach(() => void stored.set(STARRED_ABOVE_COOKIE, '1'));

  test.skipIf(!hasDom)('a right-click offers Unstar, Move left, Move right and Copy link, and opens nothing', async () => {
    const { el, calls } = draw();
    const menu = (await menuOf(pill(el, WAIT.thread_id)))!;
    expect(menu.getAttribute('data-pill-menu')).toBe(WAIT.thread_id);
    expect([...menu.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent)).toEqual(['Unstar', 'Move left', 'Move right', 'Copy link']);
    expect(calls.opened).toEqual([]);
    await choose(menu, 'copy-link');
    expect(calls.actions).toEqual([[WAIT.thread_id, 'copy-link']]);
  });

  test.skipIf(!hasDom)('Move right and Move left change the order the stars are kept in; an end offers no move past it', async () => {
    const { el, calls } = draw();
    const ids = STARS.map((r) => r.thread_id);
    await choose((await menuOf(pill(el, ids[0]!)))!, 'right');
    expect(pillIds(el)).toEqual([ids[1], ids[0], ids[2], ids[3]]);
    await choose((await menuOf(pill(el, ids[3]!)))!, 'left');
    expect(pillIds(el)).toEqual([ids[1], ids[0], ids[3], ids[2]]);
    // The sidebar's own moves: the same order is what the Starred section shows with the choice off.
    expect(calls.actions).toEqual([
      [ids[0], 'down'],
      [ids[3], 'up'],
    ]);
    const first = (await menuOf(pill(el, ids[1]!)))!;
    expect(first.querySelector('[data-pill-action="left"]')!.hasAttribute('data-disabled')).toBe(true);
    expect(first.querySelector('[data-pill-action="right"]')!.hasAttribute('data-disabled')).toBe(false);
    await choose(first, 'copy-link');
    const last = (await menuOf(pill(el, ids[2]!)))!;
    expect(last.querySelector('[data-pill-action="right"]')!.hasAttribute('data-disabled')).toBe(true);
  });

  test.skipIf(!hasDom)('the menu key and Shift+F10 on a focused pill open it, so Unstar is reachable without a pointer', async () => {
    const { el, calls } = draw();
    const target = pill(el, STOP.thread_id);
    act(() => {
      target.focus();
      target.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true }));
    });
    await settle();
    const menu = document.querySelector<HTMLElement>('[data-pill-menu]')!;
    expect(menu.getAttribute('data-pill-menu')).toBe(STOP.thread_id);
    await choose(menu, 'unpin');
    expect(calls.actions).toEqual([[STOP.thread_id, 'unpin']]);
    expect(calls.opened).toEqual([]);
    expect(pillIds(el)).not.toContain(STOP.thread_id);
  });

  test.skipIf(!hasDom)('a long press on a touch screen opens the same items with Unstar first, and the lift opens no thread', async () => {
    const { el, calls } = draw({ phone: true });
    const target = pill(el, WAIT.thread_id);
    act(() => void target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch', clientX: 20, clientY: 20 })));
    await settle(520);
    const sheet = document.querySelector<HTMLElement>('[data-pill-sheet]')!;
    expect(sheet.getAttribute('data-pill-sheet')).toBe(WAIT.thread_id);
    expect(sheet.querySelector('[role="menuitem"]')!.textContent).toBe('Unstar');
    act(() => {
      target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'touch' }));
      target.click();
    });
    expect(calls.opened).toEqual([]);
    await choose(sheet, 'unpin');
    expect(calls.actions).toEqual([[WAIT.thread_id, 'unpin']]);
  });

  test.skipIf(!hasDom)('a finger that moves (a sideways scroll) is no long press: a tap after it opens the thread', async () => {
    const { el, calls } = draw({ phone: true });
    const target = pill(el, WAIT.thread_id);
    act(() => {
      target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch', clientX: 20, clientY: 20 }));
      target.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'touch', clientX: 60, clientY: 20 }));
    });
    await settle(520);
    expect(document.querySelector('[data-pill-sheet]')).toBeNull();
    act(() => target.click());
    expect(calls.opened).toEqual([WAIT.thread_id]);
  });
});

describe('"+N"', () => {
  beforeEach(() => void stored.set(STARRED_ABOVE_COOKIE, '1'));

  const many = (count: number, waitingAt: number | null) =>
    Array.from({ length: count }, (_, i) =>
      i === waitingAt ? row(`msg_m${i}`, `Thread ${i}`, 'waiting', { questions: { open: 2, picked: 0, stopped: false, holds_up: [] } }) : row(`msg_m${i}`, `Thread ${i}`, 'quiet'),
    );

  test.skipIf(!hasDom)('every pill while they fit on two lines, and no "+N" in reach', async () => {
    layout(100, 50, 330);
    const { el } = draw({ start: many(6, null) });
    await settle();
    expect(pills(el)).toHaveLength(6);
    const more = el.querySelector<HTMLElement>('li[data-pill-more]')!;
    expect(more.hasAttribute('data-over')).toBe(true);
    expect(more.getAttribute('aria-hidden')).toBe('true');
  });

  test.skipIf(!hasDom)('past two lines the rest go behind "+N", which opens them as a menu; a hidden waiting thread gives it a dot', async () => {
    // Three 100 px pills a line (two gaps of 6): two lines hold 6, or 5 and "+N".
    layout(100, 50, 330);
    const rows = many(25, 20);
    const { el, calls } = draw({ start: rows });
    await settle();
    expect(pillIds(el)).toEqual(rows.slice(0, 5).map((r) => r.thread_id));
    const more = el.querySelector<HTMLButtonElement>('[data-pills-more]')!;
    expect(more.textContent).toBe('+20');
    expect(more.getAttribute('aria-label')).toBe('20 more starred, 1 waiting on you');
    expect(more.querySelector('[data-pills-more-dot]')).not.toBeNull();
    // The hidden pills are out of the tab order and the accessibility tree; the menu is the way to them.
    expect(pill(el, rows[9]!.thread_id).tabIndex).toBe(-1);
    act(() => more.click());
    await settle();
    const items = [...document.querySelectorAll<HTMLElement>('[data-pills-more-item]')];
    expect(items.map((item) => item.dataset.pillsMoreItem)).toEqual(rows.slice(5).map((r) => r.thread_id));
    expect(items[15]!.getAttribute('aria-label')).toBe('Thread 20, billing-svc, 2 questions, starred');
    act(() => items[15]!.click());
    expect(calls.opened).toEqual([rows[20]!.thread_id]);
  });

  test.skipIf(!hasDom)('a row of the "+N" menu has the star too: it unstars and opens nothing, the menu stays open and the count drops', async () => {
    layout(100, 50, 330);
    const rows = many(9, null);
    const { el, calls } = draw({ start: rows });
    await settle();
    const more = () => el.querySelector<HTMLButtonElement>('[data-pills-more]')!;
    expect(more().textContent).toBe('+4');
    act(() => more().click());
    await settle();
    const menu = document.querySelector<HTMLElement>('[data-pills-more-menu]')!;
    // The star takes the agent mark's place, as on a pill, and is not inside the row's item.
    expect(menu.querySelector('.ib-mk')).toBeNull();
    const star = menu.querySelector<HTMLButtonElement>(`[data-pills-more-unstar="${rows[6]!.thread_id}"]`)!;
    expect(star.getAttribute('aria-label')).toBe('Unstar Thread 6');
    expect(star.getAttribute('role')).toBe('menuitem');
    expect(menu.querySelector(`[data-pills-more-item="${rows[6]!.thread_id}"]`)!.contains(star)).toBe(false);
    act(() => star.click());
    await settle();
    expect(calls.actions).toEqual([[rows[6]!.thread_id, 'unpin']]);
    expect(calls.opened).toEqual([]);
    // Still open, without that row; "+N" counts one fewer; focus is on the row now in its place.
    const left = [...document.querySelectorAll<HTMLElement>('[data-pills-more-item]')];
    expect(left.map((item) => item.dataset.pillsMoreItem)).toEqual([rows[5], rows[7], rows[8]].map((r) => r!.thread_id));
    expect(more().textContent).toBe('+3');
    expect(document.activeElement).toBe(left[1]!);
    // The rest of a row still opens its thread.
    act(() => left[2]!.click());
    expect(calls.opened).toEqual([rows[8]!.thread_id]);
  });

  test.skipIf(!hasDom)('the star in a row is reached from its row with the left arrow, and the arrows leave it for the rows', async () => {
    layout(100, 50, 330);
    const rows = many(9, null);
    const { el, calls } = draw({ start: rows });
    await settle();
    act(() => el.querySelector<HTMLButtonElement>('[data-pills-more]')!.click());
    await settle();
    const item = (i: number) => document.querySelector<HTMLElement>(`[data-pills-more-item="${rows[i]!.thread_id}"]`)!;
    const star = (i: number) => document.querySelector<HTMLElement>(`[data-pills-more-unstar="${rows[i]!.thread_id}"]`)!;
    const key = (target: HTMLElement, name: string) => act(() => void target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true })));
    act(() => item(6).focus());
    key(item(6), 'ArrowLeft');
    expect(document.activeElement).toBe(star(6));
    key(star(6), 'ArrowRight');
    expect(document.activeElement).toBe(item(6));
    key(item(6), 'ArrowLeft');
    key(star(6), 'ArrowDown');
    expect(document.activeElement).toBe(item(7));
    expect(calls.actions).toEqual([]);
  });

  test.skipIf(!hasDom)('unstarring the last hidden thread closes the menu: "+N" is gone with it', async () => {
    layout(100, 50, 330);
    const rows = many(7, null);
    const { el } = draw({ start: rows });
    await settle();
    // Seven pills: five and "+2". One unstarred leaves six, which fit on two lines.
    act(() => el.querySelector<HTMLButtonElement>('[data-pills-more]')!.click());
    await settle();
    act(() => document.querySelector<HTMLButtonElement>(`[data-pills-more-unstar="${rows[6]!.thread_id}"]`)!.click());
    await settle();
    expect(document.querySelector('[data-pills-more-menu]')).toBeNull();
    expect(pills(el)).toHaveLength(6);
    expect(el.querySelector('li[data-pill-more]')!.hasAttribute('data-over')).toBe(true);
  });

  test.skipIf(!hasDom)('no dot while every hidden thread is quiet', async () => {
    layout(100, 50, 330);
    const { el } = draw({ start: many(9, 1) });
    await settle();
    const more = el.querySelector<HTMLButtonElement>('[data-pills-more]')!;
    expect(more.textContent).toBe('+4');
    expect(more.getAttribute('aria-label')).toBe('4 more starred');
    expect(more.querySelector('[data-pills-more-dot]')).toBeNull();
  });

  test.skipIf(!hasDom)("a phone's line scrolls sideways instead: every pill, no \"+N\"", async () => {
    layout(100, 50, 330);
    const { el } = draw({ start: many(25, 20), phone: true });
    await settle();
    expect(pills(el)).toHaveLength(25);
    expect(el.querySelector('[data-pills-more]')).toBeNull();
    expect(el.querySelector('[data-starred-pills]')!.hasAttribute('data-phone')).toBe(true);
  });

  test('the fit: whole lines of pills, "+N" at the end of the last line, never fewer than one pill', () => {
    // 3 per line at 330 (100 + 6 + 100 + 6 + 100 = 312).
    expect(fitPills([100, 100, 100, 100, 100, 100], 50, 330, 6)).toBe(6);
    expect(fitPills([100, 100, 100, 100, 100, 100, 100], 50, 330, 6)).toBe(5);
    // "+N" that does not fit beside the fifth pill takes one more pill with it.
    expect(fitPills([100, 100, 100, 100, 100, 100, 100], 130, 330, 6)).toBe(4);
    // Uneven widths wrap where a pill no longer fits its line.
    expect(fitPills([200, 150, 120, 60, 300], 40, 330, 6)).toBe(3);
    // A list narrower than one pill still shows one (it is cut by its own ellipsis).
    expect(fitPills([200, 200, 200], 50, 120, 6)).toBe(1);
    expect(fitPills([], 50, 330, 6)).toBe(0);
  });
});
