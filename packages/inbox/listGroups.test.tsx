/**
 * Every group in the list closes and opens by a click on its header
 * (approval "inbox-list-groups-close"). What is proved, on the window's own
 * InboxList: each group's header is a button with aria-expanded that hides and
 * shows its rows; its only chevron is a decorative one that shows at once
 * while the pointer is on the header, or on keyboard focus, never on a touch
 * (owner, 2026-11-08: no wait, as the sidebar's sections); for someone
 * who never closed one, Quiet and Snoozed start closed and every other group
 * open; the choice is this browser's (storage) and survives a remount, while
 * the tour's list ignores it; something new inside a closed group bolds its
 * count without opening it, and opening then closing again clears that;
 * closed Stopped and Holding up work keep the warning triangle; focus in a row
 * of the group that closes goes to its header; with cookies that are not kept,
 * a header still toggles its group. A closed header looks exactly as an open
 * one (owner's correction): same fill, words and weight, no outline; only a
 * count with something new goes bold. The list's keys: ↓ ↑ stop on the headers,
 * while Home End and J K (no thread open) go to threads only.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, jest, test } from 'bun:test';
import { act } from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxListGroupId, InboxListRow, InboxListSection, InboxSectionId } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
const { InboxList } = (hasDom ? await import('./components/InboxList') : {}) as typeof import('./components/InboxList');
const { SidebarProvider } = (hasDom ? await import('./shell/sidebar') : {}) as typeof import('./shell/sidebar');
const { LIST_GROUPS_COOKIE } = await import('./listGroups');
const { listKeyTarget } = await import('./listKeys');
const { loadCascade } = await import('./cssCascade.testing');
const CSS = readFileSync(join(import.meta.dir, 'inbox.css'), 'utf8');
const { setStorageBackend, resetStorageBackend } = await import('@plannotator/ui/utils/storage');

let root: Root | null = null;
let host: HTMLElement | null = null;
// The choice persists through Plannotator's storage (cookies in the app); a map stands in for them here.
const stored = new Map<string, string>();
beforeEach(() => {
  stored.clear();
  setStorageBackend({
    getItem: (key) => stored.get(key) ?? null,
    setItem: (key, value) => void stored.set(key, value),
    removeItem: (key) => void stored.delete(key),
  });
});
afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  document.body.innerHTML = '';
  resetStorageBackend();
});

const LONG_AGO = '2026-10-10T10:00:00.000Z';
function row(id: string, section: InboxSectionId, extra: Partial<InboxListRow> = {}): InboxListRow {
  return {
    thread_id: id,
    project_id: 'prj_1',
    subject: `Thread ${id}`,
    author: { kind: 'agent', host: 'claude-code', session: `ses_${id}`, name: null },
    created_at: LONG_AGO,
    last_at: LONG_AGO,
    last_agent_at: LONG_AGO,
    last_author: 'agent',
    message_count: 1,
    resolved_at: null,
    questions: { open: section === 'quiet' ? 0 : 1, picked: 0, stopped: section === 'stopped', holds_up: section === 'holding' ? ['x'] : [], prompt: null, actions: 0 },
    waiting_on_person: section !== 'quiet',
    project: { id: 'prj_1', name: 'alpha' },
    thread_name: null,
    section,
    unread: section !== 'quiet',
    answered_not_sent: false,
    waiting_since: null,
    unseen: 0,
    sent: null,
    guide: false,
    ...extra,
  } as InboxListRow;
}

const LABELS: Record<InboxListGroupId, string> = {
  stopped: 'Stopped on you',
  holding: 'Holding up work',
  waiting: 'Waiting on you',
  new: 'New since you looked',
  sent: 'Sent',
  quiet: 'Quiet',
  snoozed: 'Snoozed',
};
const GROUPS = Object.keys(LABELS) as InboxListGroupId[];
const section = (id: InboxListGroupId, threads: InboxListRow[]): InboxListSection => ({ id, label: LABELS[id], threads });
/** One row in every group (the Snoozed band's a snoozed Stopped row), plus `more` rows by group. */
function sections(more: Partial<Record<InboxListGroupId, InboxListRow[]>> = {}): InboxListSection[] {
  return GROUPS.map((id) => section(id, [row(`t_${id}`, id === 'snoozed' ? 'stopped' : id), ...(more[id] ?? [])]));
}

function draw(list: InboxListSection[], opts: { remember?: boolean } = {}): void {
  if (!host) {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  }
  act(() => {
    root!.render(
      <SidebarProvider>
        <div className="pn-inbox">
          <InboxList
            title="Inbox"
            path={null}
            sections={list}
            filtered={false}
            narrow={false}
            selectedThreadId={null}
            notice={null}
            onShowNew={() => {}}
            onOpen={() => {}}
            rememberLook={opts.remember}
          />
        </div>
      </SidebarProvider>,
    );
  });
}
function remount(list: InboxListSection[], opts: { remember?: boolean } = {}): void {
  act(() => root?.unmount());
  host?.remove();
  host = null;
  root = null;
  draw(list, opts);
}

const group = (id: InboxListGroupId) => host!.querySelector<HTMLElement>(`[data-section-id="${id}"]`)!;
const header = (id: InboxListGroupId) => group(id).querySelector<HTMLButtonElement>(':scope > .ib-band')!;
const isOpen = (id: InboxListGroupId) => header(id).getAttribute('aria-expanded') === 'true';
const rowsIn = (id: InboxListGroupId) => group(id).querySelectorAll('[data-thread-id]').length;
const count = (id: InboxListGroupId) => header(id).querySelector<HTMLElement>('.ib-n')!;
const click = (el: HTMLElement) => act(() => el.click());
/** What has focus, in words (a failed match on an element itself prints the whole DOM). */
function focused(): string {
  const el = document.activeElement;
  if (!el || el === document.body) return 'the page';
  const row = el.getAttribute('data-thread-id');
  if (row) return `row ${row}`;
  if (el.classList.contains('ib-band')) return `header ${el.closest('[data-section-id]')?.getAttribute('data-section-id')}`;
  return el.tagName;
}
/** The header's icons but the closed group's warning triangle and its decorative chevron. */
const otherIcons = (id: InboxListGroupId) => [...header(id).querySelectorAll('svg')].filter((svg) => !svg.closest('.ib-zband-tri') && !svg.classList.contains('ib-band-chev'));

test.skipIf(!hasDom)('every header is a button that closes and opens its group; defaults as before', () => {
  if (!hasDom) return;
  draw(sections());
  for (const id of GROUPS) {
    const band = header(id);
    expect(band.tagName).toBe('BUTTON');
    expect(band.getAttribute('type')).toBe('button');
    // One chevron, hidden from a screen reader (aria-expanded says open or closed); the only other icon a header
    // may hold is the closed group's warning triangle.
    expect(otherIcons(id)).toHaveLength(0);
    const chevs = band.querySelectorAll('svg.ib-band-chev');
    expect(chevs).toHaveLength(1);
    expect(chevs[0]!.getAttribute('aria-hidden')).toBe('true');
  }
  // Someone who never closed a group: Quiet and the Snoozed band closed, everything else open.
  expect(GROUPS.filter(isOpen)).toEqual(['stopped', 'holding', 'waiting', 'new', 'sent']);
  for (const id of GROUPS) {
    const was = isOpen(id);
    expect(rowsIn(id)).toBe(was ? 1 : 0);
    click(header(id));
    expect(isOpen(id)).toBe(!was);
    expect(rowsIn(id)).toBe(was ? 0 : 1);
    expect(otherIcons(id)).toHaveLength(0);
    click(header(id));
    expect(isOpen(id)).toBe(was);
    expect(rowsIn(id)).toBe(was ? 1 : 0);
  }
});

/** The header's chevron is showing (inbox.css fades it in on `data-chev`). */
const chevShown = (id: InboxListGroupId) => header(id).hasAttribute('data-chev');
// React's onPointerEnter and onPointerLeave listen for pointerover and pointerout, with where the pointer came from or went.
const pointer = (el: HTMLElement, type: 'pointerover' | 'pointerout', pointerType = 'mouse') =>
  act(() => {
    el.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerType, relatedTarget: document.body }));
  });
const wait = (ms: number) => act(() => jest.advanceTimersByTime(ms));

test.skipIf(!hasDom)('a header shows its chevron at once while the pointer is on it, at once on keyboard focus, never on a touch', () => {
  if (!hasDom) return;
  jest.useFakeTimers();
  try {
    draw(sections());
    const cascade = loadCascade(CSS);
    const chev = (id: InboxListGroupId) => header(id).querySelector('svg.ib-band-chev')!;
    // The pointer on the header: shown with no wait, and drawn (opacity 1), open or closed; gone on leave.
    pointer(header('waiting'), 'pointerover');
    expect(chevShown('waiting')).toBe(true);
    expect(cascade.resolved(chev('waiting'), 'opacity')).toBe('1');
    expect(chevShown('stopped')).toBe(false);
    click(header('waiting'));
    expect(isOpen('waiting')).toBe(false);
    expect(chevShown('waiting')).toBe(true);
    pointer(header('waiting'), 'pointerout');
    expect(chevShown('waiting')).toBe(false);
    pointer(header('quiet'), 'pointerover');
    expect(isOpen('quiet')).toBe(false);
    expect(chevShown('quiet')).toBe(true);
    pointer(header('quiet'), 'pointerout');
    // A touch shows nothing, however long.
    pointer(header('new'), 'pointerover', 'touch');
    wait(2000);
    expect(chevShown('new')).toBe(false);
    // Keyboard focus: at once; gone when focus leaves.
    act(() => header('sent').focus());
    expect(chevShown('sent')).toBe(true);
    act(() => header('sent').blur());
    expect(chevShown('sent')).toBe(false);
  } finally {
    jest.useRealTimers();
  }
});

test.skipIf(!hasDom)('the chevron is hidden until shown, and points right on a closed group and down on an open one', () => {
  if (!hasDom) return;
  draw(sections());
  const cascade = loadCascade(CSS);
  const chev = (id: InboxListGroupId) => header(id).querySelector('svg.ib-band-chev')!;
  expect(cascade.resolved(chev('stopped'), 'opacity')).toBe('0');
  expect(cascade.resolved(chev('stopped'), 'rotate')).toBe('90deg');
  expect(cascade.resolved(chev('quiet'), 'rotate') ?? 'none').not.toBe('90deg');
});

test.skipIf(!hasDom)('the closed groups are this browser’s, kept across a remount; the tour ignores them', () => {
  if (!hasDom) return;
  draw(sections());
  click(header('waiting'));
  click(header('new'));
  click(header('quiet'));
  expect(stored.get(LIST_GROUPS_COOKIE)).toMatch(/waiting:\d+/);
  remount(sections());
  expect(isOpen('waiting')).toBe(false);
  expect(isOpen('new')).toBe(false);
  expect(isOpen('quiet')).toBe(true);
  expect(isOpen('stopped')).toBe(true);
  expect(rowsIn('waiting')).toBe(0);
  expect(rowsIn('quiet')).toBe(1);
  // Opened again: the group is back to its default and leaves the cookie.
  click(header('waiting'));
  click(header('new'));
  expect(stored.get(LIST_GROUPS_COOKIE)).toBe('quiet:open');
  // The tour draws every group at its default whatever this browser chose, and does not keep its toggles.
  click(header('stopped'));
  const before = stored.get(LIST_GROUPS_COOKIE);
  remount(sections(), { remember: false });
  expect(GROUPS.filter(isOpen)).toEqual(['stopped', 'holding', 'waiting', 'new', 'sent']);
  click(header('waiting'));
  expect(isOpen('waiting')).toBe(false);
  expect(stored.get(LIST_GROUPS_COOKIE)).toBe(before);
});

test.skipIf(!hasDom)('something new inside a closed group bolds its count and never opens it', () => {
  if (!hasDom) return;
  draw(sections());
  click(header('new'));
  click(header('waiting'));
  expect(count('new').hasAttribute('data-new')).toBe(false);
  const now = new Date(Date.now() + 1000).toISOString();
  // New: an agent's message after the close. Waiting: only an old row the person marked unread (no new message).
  draw(
    sections({
      new: [row('t_news', 'new', { last_at: now, last_agent_at: now })],
      waiting: [row('t_old', 'waiting', { last_at: now })],
    }),
  );
  expect(isOpen('new')).toBe(false);
  expect(rowsIn('new')).toBe(0);
  expect(count('new').hasAttribute('data-new')).toBe(true);
  expect(count('new').textContent).toContain('2');
  expect(count('waiting').hasAttribute('data-new')).toBe(false);
  // Read rows (not unread) arriving in a closed group are not news either.
  draw(sections({ quiet: [row('t_read', 'quiet', { last_at: now, last_agent_at: now })] }));
  expect(count('quiet').hasAttribute('data-new')).toBe(false);
  // Opened and closed again: counted from the new close, the bold goes.
  draw(sections({ new: [row('t_news', 'new', { last_at: now, last_agent_at: now })] }));
  expect(count('new').hasAttribute('data-new')).toBe(true);
  click(header('new'));
  expect(count('new').hasAttribute('data-new')).toBe(false);
  expect(rowsIn('new')).toBe(2);
});

test.skipIf(!hasDom)('closed Stopped and Holding up work keep the warning triangle; other closed groups have none', () => {
  if (!hasDom) return;
  draw(sections());
  const tri = (id: InboxListGroupId) => header(id).querySelector('[data-folded-blocker]');
  for (const id of ['stopped', 'holding', 'waiting'] as const) expect(tri(id)).toBeNull();
  for (const id of ['stopped', 'holding', 'waiting'] as const) click(header(id));
  expect(tri('stopped')?.hasAttribute('data-stopped')).toBe(true);
  expect(tri('holding')).not.toBeNull();
  expect(tri('holding')?.hasAttribute('data-stopped')).toBe(false);
  expect(tri('waiting')).toBeNull();
  // The Snoozed band keeps today's: a snoozed Stopped row draws the stopped triangle while it is folded.
  expect(header('snoozed').querySelector('[data-snooze-blocker][data-stopped]')).not.toBeNull();
});

test.skipIf(!hasDom)('focus in a row of the group that closes moves to its header', () => {
  if (!hasDom) return;
  draw(sections());
  const focusable = group('waiting').querySelector<HTMLElement>('[data-thread-id]')!;
  act(() => focusable.focus());
  expect(focused()).toBe('row t_waiting');
  // A click that does not move focus itself (Safari does not focus a clicked button).
  click(header('waiting'));
  expect(isOpen('waiting')).toBe(false);
  expect(focused()).toBe('header waiting');
  // Focus elsewhere stays where it is.
  const other = group('stopped').querySelector<HTMLElement>('[data-thread-id]')!;
  act(() => other.focus());
  click(header('new'));
  expect(focused()).toBe('row t_stopped');
});

test.skipIf(!hasDom)('with storage that keeps nothing (cookies blocked), a header still closes and opens its group', () => {
  if (!hasDom) return;
  setStorageBackend({ getItem: () => null, setItem: () => {}, removeItem: () => {} });
  draw(sections());
  click(header('waiting'));
  expect(isOpen('waiting')).toBe(false);
  expect(rowsIn('waiting')).toBe(0);
  click(header('waiting'));
  expect(isOpen('waiting')).toBe(true);
});

/** What a list key reaches from `from`, in words. */
function described(el: Element | null): string {
  if (!el) return 'nothing';
  const row = el.getAttribute('data-thread-id');
  if (row) return `row ${row}`;
  return `header ${el.closest('[data-section-id]')?.getAttribute('data-section-id')}`;
}
const rowEl = (id: string) => host!.querySelector<HTMLElement>(`.ib-lbody [data-thread-id="${id}"]`)!;
const press = (key: string) =>
  act(() => {
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
// happy-dom has no layout: every element counts as drawn (`listStops` keeps what has a box).
const drawnRects = () => {
  const real = Element.prototype.getClientRects;
  Element.prototype.getClientRects = function () {
    return [{ width: 1, height: 1 }] as unknown as DOMRectList;
  };
  return () => void (Element.prototype.getClientRects = real);
};

test.skipIf(!hasDom)('↓ ↑ stop on the headers; Home and End go to the first and last thread, past the closed groups’ headers', () => {
  if (!hasDom) return;
  const restore = drawnRects();
  try {
    draw(sections());
    act(() => rowEl('t_waiting').focus());
    press('End');
    // Quiet and the Snoozed band are closed below Sent: their headers are not threads.
    expect(focused()).toBe('row t_sent');
    press('Home');
    expect(focused()).toBe('row t_stopped');
    press('ArrowDown');
    expect(focused()).toBe('header holding');
    press('ArrowUp');
    expect(focused()).toBe('row t_stopped');
    press('ArrowUp');
    expect(focused()).toBe('header stopped');
  } finally {
    restore();
  }
});

test.skipIf(!hasDom)('J K with no thread open go along the threads only: over a header, and from a header to its first thread', () => {
  if (!hasDom) return;
  const restore = drawnRects();
  try {
    draw(sections());
    const body = host!.querySelector<HTMLElement>('.ib-lbody')!;
    expect(described(listKeyTarget(body, rowEl('t_stopped'), 'j'))).toBe('row t_holding');
    expect(described(listKeyTarget(body, rowEl('t_holding'), 'k'))).toBe('row t_stopped');
    expect(described(listKeyTarget(body, header('waiting'), 'j'))).toBe('row t_waiting');
    expect(described(listKeyTarget(body, header('waiting'), 'k'))).toBe('row t_holding');
    // No wrap, and nothing past the last thread (closed Quiet and Snoozed below it).
    expect(described(listKeyTarget(body, rowEl('t_stopped'), 'k'))).toBe('nothing');
    expect(described(listKeyTarget(body, rowEl('t_sent'), 'j'))).toBe('nothing');
    // ↓ from the last thread still reaches the closed Quiet's header.
    expect(described(listKeyTarget(body, rowEl('t_sent'), 'down'))).toBe('header quiet');
  } finally {
    restore();
  }
});

test.skipIf(!hasDom)('a closed header looks as an open one: same fill, words, weight and no outline; only a new count is bold', () => {
  if (!hasDom) return;
  draw(sections());
  click(header('waiting'));
  click(header('new'));
  const now = new Date(Date.now() + 1000).toISOString();
  draw(sections({ new: [row('t_news', 'new', { last_at: now, last_agent_at: now })] }));
  expect(isOpen('stopped')).toBe(true);
  const cascade = loadCascade(CSS);
  const look = (el: Element) =>
    ['background', 'background-color', 'color', 'font-weight', 'box-shadow', 'border', 'outline', 'opacity'].map((prop) => `${prop}: ${cascade.resolved(el, prop) ?? '-'}`);
  // Closed by the person (Waiting), closed by default (Quiet), and with something new inside (New), against open Stopped.
  for (const id of ['waiting', 'quiet', 'new'] as const) {
    expect(isOpen(id)).toBe(false);
    expect(look(header(id))).toEqual(look(header('stopped')));
  }
  expect(look(count('waiting'))).toEqual(look(count('stopped')));
  expect(cascade.resolved(count('new'), 'font-weight')).toBe('700');
  expect(cascade.resolved(count('stopped'), 'font-weight')).not.toBe('700');
});
