/**
 * The order of the sidebar's Projects, on the window's own Sidebar: no choice
 * draws the server's order and writes nothing; the first press goes A to Z, then
 * one button goes between most recent and A to Z, never back to the first order;
 * the choice survives a remount; A to Z ignores case and
 * accents and counts numbers; most recent reads the list's rows and puts a
 * project with none last; no toggle with one project or none, or while the
 * section is closed. tests/e2e/inbox-projects-sort.spec.ts proves the real
 * reload, the hover and the phone's target.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxListSection } from '@plannotator/core/inbox-types';
import type { SidebarProps } from './components/Sidebar';

const hasDom = typeof document !== 'undefined';
const { Sidebar } = (hasDom ? await import('./components/Sidebar') : {}) as typeof import('./components/Sidebar');
const { SidebarProvider } = (hasDom ? await import('./shell/sidebar') : {}) as typeof import('./shell/sidebar');
const { PROJECTS_SORT_COOKIE, projectActivity, sortProjects } = await import('./projectSort');
const { storage, setStorageBackend, resetStorageBackend } = await import('@plannotator/ui/utils/storage');

let root: Root | null = null;
let host: HTMLElement | null = null;
const stored = new Map<string, string>();
beforeEach(() => {
  stored.clear();
  setStorageBackend({
    getItem: (key) => stored.get(key) ?? null,
    setItem: (key, value) => void stored.set(key, value),
    removeItem: (key) => void stored.delete(key),
  });
});
function unmount() {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
}
afterEach(() => {
  unmount();
  document.body.innerHTML = '';
  resetStorageBackend();
});

const folder = (id: string, name: string, listed = 1) => ({ id, key: `${name}-abc123`, name, root: `/tmp/${name}`, created_at: '2026-10-11T10:00:00.000Z', threads: listed, unread: 0, listed });
// The server's order: oldest project first.
const PROJECTS = [folder('prj_z', 'zephyr'), folder('prj_a', 'Atlas'), folder('prj_m', 'billing-svc')];
const ACTIVITY = new Map([
  ['prj_a', '2026-11-01T09:00:00.000Z'],
  ['prj_m', '2026-11-03T09:00:00.000Z'],
  ['prj_z', '2026-10-20T09:00:00.000Z'],
]);
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
          inboxCount={0}
          projects={PROJECTS as never}
          projectCounts={new Map()}
          projectActivity={ACTIVITY}
          update={null}
          restarting={false}
          updated={null}
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

const names = () => [...host!.querySelectorAll('.ib-projs .ib-name')].map((el) => el.textContent);
const toggle = () => host!.querySelector<HTMLButtonElement>('[data-projects-sort]');
const press = () => act(() => toggle()!.click());

test("with no choice the list keeps the server's order, and nothing is written", () => {
  draw();
  expect(names()).toEqual(['zephyr', 'Atlas', 'billing-svc']);
  expect(toggle()?.dataset.projectsSort).toBe('added');
  expect(stored.has(PROJECTS_SORT_COOKIE)).toBe(false);
});

test("a cookie it does not know is the server's order", () => {
  storage.setItem(PROJECTS_SORT_COOKIE, 'sideways');
  draw();
  expect(names()).toEqual(['zephyr', 'Atlas', 'billing-svc']);
});

test('the first press goes A to Z, then one button goes between most recent and A to Z, never back to the first order', () => {
  draw();
  const first = toggle()!.getAttribute('aria-label');
  expect(first).toBeTruthy();
  act(() => toggle()!.focus());

  press();
  expect(names()).toEqual(['Atlas', 'billing-svc', 'zephyr']);
  expect(stored.get(PROJECTS_SORT_COOKIE)).toBe('name');
  const az = toggle()!.getAttribute('aria-label');
  expect(az).not.toBe(first);
  expect(document.activeElement).toBe(toggle());

  press();
  expect(names()).toEqual(['billing-svc', 'Atlas', 'zephyr']);
  expect(stored.get(PROJECTS_SORT_COOKIE)).toBe('recent');
  expect(toggle()!.getAttribute('aria-label')).not.toBe(az);

  press();
  expect(names()).toEqual(['Atlas', 'billing-svc', 'zephyr']);
  expect(stored.get(PROJECTS_SORT_COOKIE)).toBe('name');
  expect(toggle()!.getAttribute('aria-label')).toBe(az);
});

test('most recent also survives a remount', () => {
  storage.setItem(PROJECTS_SORT_COOKIE, 'recent');
  draw();
  expect(names()).toEqual(['billing-svc', 'Atlas', 'zephyr']);
  expect(toggle()?.dataset.projectsSort).toBe('recent');
});

test('the toggle names and draws the order on screen, then what a press does', () => {
  const sees = () => [toggle()!.getAttribute('aria-label'), toggle()!.querySelector('svg')!.getAttribute('data-icon')];
  draw();
  expect(sees()).toEqual(['Sorted by when added. Sort A to Z', 'sortList']);
  press();
  expect(sees()).toEqual(['Sorted A to Z. Sort by most recent', 'sortAZ']);
  press();
  expect(sees()).toEqual(['Sorted by most recent. Sort A to Z', 'sortRecent']);
});

test('the toggle going while it holds focus hands focus to the Projects header, not the page', () => {
  draw();
  act(() => toggle()!.focus());
  draw({ projects: [PROJECTS[0]!] as never });
  expect(toggle()).toBeNull();
  expect(document.activeElement).toBe(host!.querySelector('[data-sidebar-section="projects"]'));
});

test('the toggle going without focus leaves focus where it is', () => {
  draw();
  const inbox = host!.querySelector<HTMLElement>('.ib-nav-inbox')!;
  act(() => inbox.focus());
  draw({ projects: [PROJECTS[0]!] as never });
  expect(document.activeElement).toBe(inbox);
});

test('the choice survives a remount, and a press says the new order and never closes the section', () => {
  const said: string[] = [];
  draw({ announce: (text) => said.push(text) });
  press();
  expect(said).toHaveLength(1);
  expect(host!.querySelector('[data-sidebar-section="projects"]')!.getAttribute('aria-expanded')).toBe('true');
  unmount();
  draw();
  expect(names()).toEqual(['Atlas', 'billing-svc', 'zephyr']);
  expect(toggle()?.dataset.projectsSort).toBe('name');
});

test('A to Z goes by the name on screen', () => {
  storage.setItem(PROJECTS_SORT_COOKIE, 'name');
  // The window's name wins over the server's: "zephyr" reads "aardvark" here.
  draw({ projectNames: new Map([['prj_z', 'aardvark']]) });
  expect(names()).toEqual(['aardvark', 'Atlas', 'billing-svc']);
});

test('A to Z ignores case and accents and counts numbers', () => {
  const sorted = (list: string[]) => sortProjects(list.map((name) => ({ id: name, name })), 'name').map((p) => p.name);
  expect(sorted(['zebra', 'Apple', 'banana'])).toEqual(['Apple', 'banana', 'zebra']);
  expect(sorted(['Zeta', 'Émile', 'eagle', 'Fox'])).toEqual(['eagle', 'Émile', 'Fox', 'Zeta']);
  expect(sorted(['app10', 'app2', 'App1'])).toEqual(['App1', 'app2', 'app10']);
});

test('names that differ only by case or accent keep the order they came in', () => {
  const list = [{ id: 'one', name: 'résumé' }, { id: 'two', name: 'Resume' }];
  expect(sortProjects(list, 'name').map((p) => p.id)).toEqual(['one', 'two']);
});

test('most recent puts a project with no activity last, and a tie keeps the order they came in', () => {
  const list = [{ id: 'quiet', name: 'quiet' }, { id: 'tieA', name: 'tieA' }, { id: 'tieB', name: 'tieB' }, { id: 'new', name: 'new' }];
  const activity = new Map([
    ['tieA', '2026-11-01T00:00:00.000Z'],
    ['tieB', '2026-11-01T00:00:00.000Z'],
    ['new', '2026-11-04T00:00:00.000Z'],
  ]);
  expect(sortProjects(list, 'recent', activity).map((p) => p.id)).toEqual(['new', 'tieA', 'tieB', 'quiet']);
});

test("a project's activity is the newest row in any section of the list", () => {
  const row = (project: string, last_at: string) => ({ project: { id: project, name: project }, last_at });
  const sections = [
    { id: 'new', label: 'New', threads: [row('a', '2026-11-01T00:00:00.000Z'), row('b', '2026-10-01T00:00:00.000Z')] },
    { id: 'quiet', label: 'Quiet', threads: [row('a', '2026-11-05T00:00:00.000Z'), row('a', '2026-09-01T00:00:00.000Z')] },
  ] as unknown as InboxListSection[];
  expect(Object.fromEntries(projectActivity(sections))).toEqual({ a: '2026-11-05T00:00:00.000Z', b: '2026-10-01T00:00:00.000Z' });
});

test('no toggle with one project or none', () => {
  draw({ projects: [PROJECTS[0]!] as never });
  expect(names()).toEqual(['zephyr']);
  expect(toggle()).toBeNull();
  draw({ projects: [] });
  expect(toggle()).toBeNull();
});

test('no toggle when only one project is on screen, though more exist', () => {
  // The rest have nothing in the list, so they left the sidebar.
  draw({ projects: [PROJECTS[0]!, folder('prj_g', 'gone', 0), folder('prj_h', 'hidden', 0)] as never });
  expect(names()).toEqual(['zephyr']);
  expect(toggle()).toBeNull();
});

test('a closed Projects has no toggle', () => {
  draw();
  act(() => host!.querySelector<HTMLButtonElement>('[data-sidebar-section="projects"]')!.click());
  expect(toggle()).toBeNull();
});
