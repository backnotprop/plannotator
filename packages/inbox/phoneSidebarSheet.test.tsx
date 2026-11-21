/**
 * A phone's sidebar sheet, once open (approval "inbox-phone-sidebar-sheet", "Sheet 1 · Same sections, fixed").
 * What is proved on the window's own Sidebar, at a phone width and off it:
 * the sheet has one scroll (the places scroll with Starred, Agents and Projects, and nothing else in it scrolls);
 * each heading shows how many rows its section holds and folds it through the sidebar's own cookie; "Showing only"
 * names what narrows the list, in full, and Clear goes back to everything; Search and New message are not in the
 * sheet; Settings, Feedback and light/dark share one row; and off a phone the sidebar is drawn as it always was.
 * A starred thread that is also an agent's thread staying in both sections: agents/agentsSection.test.tsx.
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
import type { MachineView } from './api';

const hasDom = typeof document !== 'undefined';
const { Sidebar } = (hasDom ? await import('./components/Sidebar') : {}) as typeof import('./components/Sidebar');
const { SidebarProvider } = (hasDom ? await import('./shell/sidebar') : {}) as typeof import('./shell/sidebar');
const { PHONE_QUERY } = await import('./phone');
const { SIDEBAR_CLOSED_COOKIE } = await import('./sidebarSections');
const { machinesModel } = await import('./machines');
const { storage, setStorageBackend, resetStorageBackend } = await import('@plannotator/ui/utils/storage');

let root: Root | null = null;
let host: HTMLElement | null = null;
let sheet: HTMLStyleElement | null = null;
let phone = true;
let savedMatchMedia: typeof window.matchMedia | undefined;
const stored = new Map<string, string>();

beforeEach(() => {
  if (!hasDom) return;
  phone = true;
  stored.clear();
  setStorageBackend({
    getItem: (key) => stored.get(key) ?? null,
    setItem: (key, value) => void stored.set(key, value),
    removeItem: (key) => void stored.delete(key),
  });
  // The window is a phone while `phone` says so: the one query phone.ts asks.
  savedMatchMedia = window.matchMedia;
  window.matchMedia = ((query: string) => ({ media: query, matches: query === PHONE_QUERY && phone, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
});
afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  sheet?.remove();
  sheet = null;
  document.body.innerHTML = '';
  resetStorageBackend();
  if (savedMatchMedia) window.matchMedia = savedMatchMedia;
});

const LONG = 'acme-billing-reconciliation-service-with-a-long-name';
const folder = (id: string, name: string) => ({ id, key: `${id}-abc123`, name, root: `/tmp/${id}`, created_at: '2026-10-11T10:00:00.000Z', threads: 1, unread: 0, listed: 1 });
const PROJECTS = [folder('prj_a', 'alpha'), folder('prj_b', LONG)];
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
const PINS = [pin('t_stop', 'stopped'), pin('t_hold', 'holding'), pin('t_wait', 'waiting'), pin('t_new', 'new', { unseen: 1 }), pin('t_quiet', 'quiet')];
const SELF = `ibx_01K${'0'.repeat(22)}S`;
const MINI = `ibx_01K${'0'.repeat(22)}N`;
const view = (id: string, name: string): MachineView =>
  ({ id, name, self: id === SELF, state: 'online', since: '2026-11-09T08:00:00.000Z', reason: null, version: '0.29.0', address: null, both_ways: true, waiting: 0, list_cursor: 1, snoozes: true, launch: true }) as MachineView;

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
        {/* The sheet's own box (shell/sidebar.tsx), which the sheet's rules hang from. */}
        <div className={phone ? 'ib-sb-sheet-in' : 'ib-sb-inner'}>
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
            draftsCount={2}
            onDrafts={noop}
            onSearch={noop}
            onCompose={noop}
            onFeedback={noop}
            onInbox={noop}
            onProject={noop}
            onSettings={noop}
            onUpdate={noop}
            onWhatsNew={noop}
            {...over}
          />
        </div>
      </SidebarProvider>,
    ),
  );
}
const one = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector);
const header = (section: 'pinned' | 'agents' | 'projects') => one<HTMLButtonElement>(`[data-sidebar-section="${section}"]`)!;
const total = (section: 'pinned' | 'agents' | 'projects') => header(section).querySelector('[data-section-total]')?.textContent ?? null;
const click = (el: HTMLElement) => act(() => el.click());
/** The Feedback rows on screen, by their words (the Sidebar here opens no dialog and sends nothing). */
const feedbackRows = (scope: ParentNode = document) => [...scope.querySelectorAll<HTMLElement>('button.ib-nav')].filter((button) => button.textContent === 'Feedback');

/** The window's rules for the sidebar's boxes, the phone block's unwrapped (the window is a phone here). */
function sidebarRules(): string {
  const css = readFileSync(join(import.meta.dir, 'inbox.css'), 'utf8');
  return css
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^(\.pn-inbox )?\.(ib-sb-sheet-in|ib-sidescroll|ib-side|ib-projs|ib-pins|ib-sheet-sec|ib-agents-body)( [>.a-z-]+)* \{[^}]*overflow(-y)?:/.test(line))
    .join('\n');
}

test.skipIf(!hasDom)("a phone's sheet has one scroll: the places and every section are in it, and nothing else in the sheet scrolls", () => {
  sheet = document.createElement('style');
  sheet.textContent = sidebarRules();
  document.head.append(sheet);
  draw();
  const scroll = one('.ib-sidescroll')!;
  // The places (Inbox, Drafts) scroll with Starred, Agents and Projects.
  for (const selector of ['[data-inbox-nav]', '[data-drafts-nav]', '[data-sidebar-section="pinned"]', '[data-pinned-row]', '[data-sidebar-section="projects"]', '.ib-projs .ib-proj']) {
    expect(one(selector)).not.toBeNull();
    expect(scroll.contains(one(selector))).toBe(true);
  }
  // The head and the foot stay put.
  expect(scroll.contains(one('.ib-brand'))).toBe(false);
  expect(scroll.contains(one('.ib-side-foot'))).toBe(false);
  // One box scrolls, and only one.
  const scrolling = [...one('.ib-sb-sheet-in')!.querySelectorAll<HTMLElement>('aside, div, section')].filter((el) => /auto|scroll/.test(getComputedStyle(el).overflowY));
  expect(scrolling.map((el) => el.className)).toEqual(['ib-sidescroll']);
});

test.skipIf(!hasDom)("a heading shows how many rows its section holds and folds it, through the sidebar's own cookie", () => {
  draw();
  expect(total('pinned')).toBe('5');
  expect(total('projects')).toBe('2');
  expect(header('pinned').getAttribute('aria-expanded')).toBe('true');
  expect(document.querySelectorAll('[data-pinned-row]')).toHaveLength(5);

  click(header('pinned'));
  expect(header('pinned').getAttribute('aria-expanded')).toBe('false');
  expect(document.querySelectorAll('[data-pinned-row]')).toHaveLength(0);
  // Folded, the count stays, and Starred says how many of its rows wait on the person (Stopped, Holds, a question).
  expect(total('pinned')).toBe('5');
  expect(header('pinned').querySelector('.ib-n')?.textContent).toBe('3 waiting on you');
  expect(storage.getItem(SIDEBAR_CLOSED_COOKIE)).toBe('pinned');

  click(header('projects'));
  expect(document.querySelectorAll('.ib-projs .ib-proj')).toHaveLength(0);
  expect(total('projects')).toBe('2');
  expect(storage.getItem(SIDEBAR_CLOSED_COOKIE)).toBe('pinned,projects');
});

test.skipIf(!hasDom)('"Showing only" names the project in full, Clear goes back to everything, and the filtered row carries the fill', () => {
  let cleared = 0;
  draw({ onInbox: () => void cleared++ });
  expect(one('[data-sheet-showing]')).toBeNull();

  draw({ projectId: 'prj_b', onInbox: () => void cleared++ });
  const line = one('[data-sheet-showing]')!;
  expect(line.getAttribute('data-sheet-showing')).toBe('project');
  expect(line.querySelector('bdi')?.textContent).toBe(LONG);
  // At the top of the sheet: above the scroll, not in it.
  expect(one('.ib-sidescroll')!.contains(line)).toBe(false);
  expect(line.compareDocumentPosition(one('.ib-sidescroll')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  const row = [...document.querySelectorAll<HTMLElement>('.ib-projs .ib-proj')].find((el) => el.textContent?.includes(LONG))!;
  expect(row.classList.contains('ib-on')).toBe(true);
  expect(row.getAttribute('aria-current')).toBe('page');
  // Inbox is not where the person is while a project narrows the list.
  expect(one('[data-inbox-nav]')!.getAttribute('aria-current')).toBeNull();

  click(one('[data-sheet-clear]')!);
  expect(cleared).toBe(1);

  // A machine narrows the list the same way; another page shows no line.
  const machines = machinesModel([view(SELF, 'This Mac'), view(MINI, 'Studio Mac mini')]);
  draw({ machineId: MINI, machines });
  expect(one('[data-sheet-showing]')!.getAttribute('data-sheet-showing')).toBe('machine');
  expect(one('[data-sheet-showing] bdi')?.textContent).toBe('Studio Mac mini');
  // So does an agent (its row's name), and its Clear is the same Clear.
  draw({ agentFilter: { id: 'ses_a', name: 'Invoice retries' }, onInbox: () => void cleared++ });
  expect(one('[data-sheet-showing]')!.getAttribute('data-sheet-showing')).toBe('agent');
  expect(one('[data-sheet-showing] bdi')?.textContent).toBe('Invoice retries');
  expect(one('[data-inbox-nav]')!.getAttribute('aria-current')).toBeNull();
  click(one('[data-sheet-clear]')!);
  expect(cleared).toBe(2);
  draw({ page: 'settings', projectId: 'prj_b' });
  expect(one('[data-sheet-showing]')).toBeNull();
});

test.skipIf(!hasDom)('Search and New message are not in the sheet on a phone; Settings, Feedback and light/dark share one row', () => {
  draw();
  expect(one('[data-open-search]')).toBeNull();
  expect(one('[data-open-compose]')).toBeNull();
  const foot = one('.ib-side-foot .ib-setrow')!;
  expect(feedbackRows(foot)).toHaveLength(1);
  expect(feedbackRows()).toHaveLength(1);
  expect(foot.querySelector('[data-theme-toggle]')).not.toBeNull();
  // The way out at a width the sheet fills.
  expect(one('[data-sheet-close]')).not.toBeNull();
});

test.skipIf(!hasDom)('off a phone the sidebar is as it was: the places above the scroll, no counts beside the headings, Feedback a row of its own', () => {
  phone = false;
  draw({ projectId: 'prj_b' });
  const scroll = one('.ib-sidescroll')!;
  expect(scroll.contains(one('[data-inbox-nav]'))).toBe(false);
  expect(scroll.contains(one('[data-drafts-nav]'))).toBe(false);
  // Search and New message lead the sidebar, as before.
  expect(one('[data-open-search]')).not.toBeNull();
  expect(one('[data-open-compose]')).not.toBeNull();
  // The sections are the scroll's own children: no block around them, no row around Starred's heading.
  expect(header('pinned').parentElement).toBe(scroll);
  expect(one('.ib-pins')!.parentElement).toBe(scroll);
  expect(one('.ib-projs')!.parentElement).toBe(scroll);
  expect(document.querySelectorAll('[data-section-total], [data-sheet-showing], [data-sheet-close], .ib-sheet-sec, .ib-pin-sub')).toHaveLength(0);
  // Feedback is its own row above Settings, not in Settings' row.
  expect(feedbackRows(one('.ib-setrow')!)).toHaveLength(0);
  expect(feedbackRows(one('.ib-side-foot')!)).toHaveLength(1);
  // A folded Starred still says its waiting count to a screen reader only, as before.
  click(header('pinned'));
  expect(header('pinned').querySelector('.ib-n')?.textContent).toBe('3 waiting on you');
  expect(header('pinned').querySelector('.ib-n .ib-sr')?.textContent).toBe(' waiting on you');
});

test.skipIf(!hasDom)("a starred row on a phone says its project and its state in words under its name; one open question has words too", () => {
  draw({ pins: [pin('t_one', 'waiting', { questions: { open: 1, holds_up: [] } }), pin('t_stop', 'stopped'), pin('t_quiet', 'quiet')], projectNames: new Map([['prj_a', 'alpha']]) });
  const sub = (id: string) => one(`[data-pinned-row="${id}"] .ib-pin-sub`)!;
  expect(sub('t_one').querySelector('.ib-pin-proj')?.textContent).toBe('alpha');
  expect(sub('t_one').querySelector('.ib-pin-st')?.textContent).toBe('1 question');
  expect(sub('t_stop').querySelector('.ib-spill')?.textContent).toBe('Stopped');
  // Nothing waits: the project alone, with no dangling dot.
  expect(sub('t_quiet').textContent).toBe('alpha');
});
