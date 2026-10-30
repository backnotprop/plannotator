/**
 * Pinned and Projects open and close like folders (owner's pick, direction C
 * "The section is the folder"). What is proved, on the window's own Sidebar:
 * a click on a header closes and opens its section (aria-expanded, and
 * aria-controls naming the rows), the choice is this browser's cookie and
 * survives a remount; closed, the current row stays (the project the list
 * shows, the open pinned thread); a closed Pinned counts the pins waiting on
 * the person and a closed Projects shows no count; Unpin from a closed
 * section moves focus to the next row on screen, then the Pinned header, then
 * Inbox; the onboarding tour's sidebar ignores the cookie. Pinning while
 * Pinned is closed opening it needs the window's pin write: pinnedThreads.test.tsx.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxListRow } from '@plannotator/core/inbox-types';
import type { SidebarProps } from './components/Sidebar';

const hasDom = typeof document !== 'undefined';
const { Sidebar } = (hasDom ? await import('./components/Sidebar') : {}) as typeof import('./components/Sidebar');
const { SidebarProvider } = (hasDom ? await import('./shell/sidebar') : {}) as typeof import('./shell/sidebar');
const { TourNavigation } = (hasDom ? await import('./tour/Tour') : {}) as typeof import('./tour/Tour');
const { parseTourFixture, tourStateAt, TOUR_THREAD } = await import('./tour/model');
const { SIDEBAR_CLOSED_COOKIE } = await import('./sidebarSections');
const { storage, setStorageBackend, resetStorageBackend } = await import('@plannotator/ui/utils/storage');

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
  act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  document.body.innerHTML = '';
  resetStorageBackend();
});

const folder = (id: string, name: string) => ({ id, key: `${name}-abc123`, name, root: `/tmp/${name}`, created_at: '2026-10-11T10:00:00.000Z', threads: 1, unread: 0, listed: 1 });
const PROJECTS = [folder('prj_a', 'alpha'), folder('prj_b', 'beta')];
function pin(id: string, section: string, extra: Record<string, unknown> = {}): InboxListRow {
  return {
    thread_id: id,
    subject: `Thread ${id}`,
    project: { id: 'prj_a', name: 'alpha' },
    author: { kind: 'agent', host: 'claude-code', session: 's', name: null },
    section,
    unread: false,
    unseen: 0,
    read_at: null,
    resolved_at: null,
    back_from_archive: false,
    questions: { open: section === 'waiting' ? 2 : 0, holds_up: section === 'holding' ? ['x'] : [] },
    ...extra,
  } as unknown as InboxListRow;
}
// Stopped, Holds and a question count wait on the person; news (a dot) and a quiet thread do not.
const PINS = [pin('t_stop', 'stopped'), pin('t_hold', 'holding'), pin('t_wait', 'waiting'), pin('t_new', 'new', { unseen: 1 }), pin('t_quiet', 'quiet')];

const noop = () => {};
function draw(over: Partial<SidebarProps> = {}) {
  if (!host) {
    host = document.createElement('div');
    host.className = 'pn-inbox';
    document.body.appendChild(host);
    root = createRoot(host);
  }
  act(() =>
    root!.render(
      <SidebarProvider>
        <Sidebar
          page="inbox"
          projectId={null}
          inboxCount={3}
          projects={PROJECTS as never}
          projectCounts={new Map([['prj_a', 1]])}
          update={null}
          restarting={false}
          updated={null}
          pins={PINS}
          onInbox={noop}
          onProject={noop}
          onSettings={noop}
          onUpdate={noop}
          onWhatsNew={noop}
          {...over}
        />
      </SidebarProvider>,
    ),
  );
}
function remount(over: Partial<SidebarProps> = {}) {
  act(() => root?.unmount());
  host?.remove();
  host = null;
  draw(over);
}

const header = (section: 'pinned' | 'projects') => document.querySelector<HTMLButtonElement>(`[data-sidebar-section="${section}"]`)!;
const pinIds = () => [...document.querySelectorAll('[data-pinned-row]')].map((el) => el.getAttribute('data-pinned-row'));
const projectNames = () => [...document.querySelectorAll('.ib-proj .ib-name')].map((el) => el.textContent);
const click = (el: HTMLElement) => act(() => el.click());

test.skipIf(!hasDom)('a header closes and opens its section, says so, and the choice is remembered across a remount', () => {
  draw();
  for (const section of ['pinned', 'projects'] as const) {
    const h = header(section);
    expect(h.tagName).toBe('BUTTON');
    expect(h.getAttribute('aria-expanded')).toBe('true');
    // aria-controls names the element that holds the section's rows; the section is labelled by its header.
    const body = document.getElementById(h.getAttribute('aria-controls')!)!;
    expect(body.getAttribute('aria-labelledby')).toBe(h.id);
  }
  expect(document.getElementById(header('pinned').getAttribute('aria-controls')!)!.querySelectorAll('[data-pinned-row]')).toHaveLength(5);
  expect(document.getElementById(header('projects').getAttribute('aria-controls')!)!.querySelectorAll('.ib-proj')).toHaveLength(2);

  click(header('projects'));
  expect(header('projects').getAttribute('aria-expanded')).toBe('false');
  expect(projectNames()).toEqual([]);
  expect(pinIds()).toHaveLength(5);
  expect(storage.getItem(SIDEBAR_CLOSED_COOKIE)).toBe('projects');
  click(header('pinned'));
  expect(pinIds()).toEqual([]);
  expect(storage.getItem(SIDEBAR_CLOSED_COOKIE)).toBe('pinned,projects');

  remount();
  expect(header('pinned').getAttribute('aria-expanded')).toBe('false');
  expect(header('projects').getAttribute('aria-expanded')).toBe('false');
  expect(pinIds()).toEqual([]);
  expect(projectNames()).toEqual([]);

  click(header('pinned'));
  click(header('projects'));
  expect(pinIds()).toHaveLength(5);
  expect(projectNames()).toEqual(['alpha', 'beta']);
  // Both open is the default: no cookie left behind.
  expect(storage.getItem(SIDEBAR_CLOSED_COOKIE)).toBeNull();
});

test.skipIf(!hasDom)('closed, a section still shows where the person is: the project the list shows and the open pinned thread', () => {
  storage.setItem(SIDEBAR_CLOSED_COOKIE, 'pinned,projects');
  draw({ projectId: 'prj_b', openThreadId: 't_new' });
  expect(projectNames()).toEqual(['beta']);
  expect(document.querySelector('.ib-proj')!.getAttribute('aria-current')).toBe('page');
  expect(pinIds()).toEqual(['t_new']);
  expect(document.querySelector('[data-pinned-row="t_new"]')!.getAttribute('aria-current')).toBe('true');
  // Off the list (Settings), nothing is current: the closed sections show their headers only.
  draw({ page: 'settings', projectId: 'prj_b', openThreadId: 't_new' });
  expect(projectNames()).toEqual([]);
  expect(pinIds()).toEqual([]);
});

test.skipIf(!hasDom)('a closed Pinned counts the pins waiting on the person; open, or with none waiting, it shows no count; Projects never does', () => {
  draw();
  expect(header('pinned').querySelector('.ib-n')).toBeNull();
  click(header('pinned'));
  click(header('projects'));
  // Stopped, Holds and the question count: 3. The news dot and the quiet thread are not on the person.
  // "N waiting on you" is pinned on purpose: it is the header's accessible name for a screen reader.
  expect(header('pinned').querySelector('.ib-n')!.textContent).toBe('3 waiting on you');
  expect(header('pinned').textContent).toContain('Pinned');
  expect(header('projects').querySelector('.ib-n')).toBeNull();
  draw({ pins: [PINS[3]!, PINS[4]!] });
  expect(header('pinned').querySelector('.ib-n')).toBeNull();
});

/** Base UI opens a menu on the pointer's press, as a person's click does. */
async function press(el: HTMLElement) {
  await act(async () => {
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }));
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerType: 'mouse' }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
    el.click();
  });
}

/** Unpin the open pinned thread from its ⋯ (the only pinned row a closed Pinned shows), then draw the pins without it. */
async function unpinFromMenu(id: string, rest: InboxListRow[], over: Partial<SidebarProps>) {
  const more = document.querySelector<HTMLElement>(`[data-pin-more="${id}"]`)!;
  more.focus();
  await press(more);
  for (let i = 0; i < 40 && !document.querySelector(`[data-pin-menu="${id}"]`); i++) await act(() => new Promise((r) => setTimeout(r, 25)));
  await act(async () => document.querySelector<HTMLElement>(`[data-pin-menu="${id}"] [data-pin-action="unpin"]`)!.click());
  draw({ ...over, pins: rest, openThreadId: null });
  await act(() => new Promise((r) => setTimeout(r, 0)));
}

test.skipIf(!hasDom)('Unpin in a closed section: focus goes to the next row on screen, then the Pinned header, then Inbox', async () => {
  const unpinned: string[] = [];
  const onPinAction = (row: InboxListRow) => void unpinned.push(row.thread_id);
  storage.setItem(SIDEBAR_CLOSED_COOKIE, 'pinned');
  // Pinned closed, Projects open: the next row on screen is the first project.
  draw({ openThreadId: 't_stop', onPinAction });
  await unpinFromMenu('t_stop', PINS.slice(1), { onPinAction });
  expect(unpinned).toEqual(['t_stop']);
  expect(document.activeElement?.textContent).toContain('alpha');

  // Both closed, no project current: no row on screen, so the Pinned header.
  storage.setItem(SIDEBAR_CLOSED_COOKIE, 'pinned,projects');
  remount({ openThreadId: 't_hold', onPinAction, pins: PINS.slice(1) });
  await unpinFromMenu('t_hold', PINS.slice(2), { onPinAction });
  expect(document.activeElement).toBe(header('pinned'));

  // The last pin: Pinned goes with it, so Inbox.
  remount({ openThreadId: 't_quiet', onPinAction, pins: [PINS[4]!] });
  await unpinFromMenu('t_quiet', [], { onPinAction });
  expect(document.querySelector('[data-sidebar-section="pinned"]')).toBeNull();
  expect(document.activeElement?.hasAttribute('data-inbox-nav')).toBe(true);
});

test.skipIf(!hasDom)('the focused current row going away under a closed header (Escape closed the thread) moves focus to that header, not the page', () => {
  storage.setItem(SIDEBAR_CLOSED_COOKIE, 'pinned,projects');
  draw({ openThreadId: 't_hold', projectId: 'prj_b' });
  act(() => document.querySelector<HTMLElement>('[data-pinned-row="t_hold"]')!.focus());
  draw({ openThreadId: null, projectId: 'prj_b' });
  expect(pinIds()).toEqual([]);
  expect(document.activeElement).toBe(header('pinned'));
  // The project the list showed, left by Back: the Projects header.
  act(() => document.querySelector<HTMLElement>('.ib-proj')!.focus());
  draw({ openThreadId: null, projectId: null });
  expect(projectNames()).toEqual([]);
  expect(document.activeElement).toBe(header('projects'));
});

test.skipIf(!hasDom)("the onboarding tour's sidebar ignores the cookie: Projects is open with the tour's project", () => {
  storage.setItem(SIDEBAR_CLOSED_COOKIE, 'pinned,projects');
  const fixture = parseTourFixture(JSON.parse(readFileSync(join(import.meta.dir, 'tour/content/fixture.json'), 'utf8')));
  const real = fixture.threads.find((t) => t.id === TOUR_THREAD)!.real_answer!;
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <SidebarProvider>
        <TourNavigation fixture={fixture} state={tourStateAt(1, real, fixture)} dispatch={noop} say={noop} onCompose={noop} onSettings={noop} />
      </SidebarProvider>,
    ),
  );
  expect(header('projects').getAttribute('aria-expanded')).toBe('true');
  expect(projectNames()).toEqual([fixture.project]);
  // A toggle there is the tour's own: the person's choice stays as it was.
  click(header('projects'));
  expect(header('projects').getAttribute('aria-expanded')).toBe('false');
  expect(storage.getItem(SIDEBAR_CLOSED_COOKIE)).toBe('pinned,projects');
});
