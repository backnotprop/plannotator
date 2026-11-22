/**
 * The order of the sidebar's Tags, on the window's own Sidebar: no choice draws
 * the server's order (oldest tag first) and writes nothing; the first press goes
 * A to Z, then one button goes between most recent and A to Z, never back to the
 * first order; the choice survives a remount and is kept apart from Projects';
 * most recent reads the tags' threads in the list (a linked machine's by the
 * window's merged ids) and puts a tag with none last; no toggle with one tag or
 * while the section is closed. The rules themselves are Projects'
 * (projectSort.test.tsx).
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxInitiative, InboxListRow } from '@plannotator/core/inbox-types';
import type { SidebarProps } from './components/Sidebar';
import type { RowTags } from './threadTags';

const hasDom = typeof document !== 'undefined';
const { Sidebar } = (hasDom ? await import('./components/Sidebar') : {}) as typeof import('./components/Sidebar');
const { SidebarProvider } = (hasDom ? await import('./shell/sidebar') : {}) as typeof import('./shell/sidebar');
const { TAGS_SORT_COOKIE, tagActivity } = await import('./tagSort');
const { PROJECTS_SORT_COOKIE } = await import('./projectSort');
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

const tag = (id: string, name: string, made: string): InboxInitiative => ({ id, name, created_at: made, created_by: { kind: 'person' }, updated_at: made, deleted_at: null });
const TAGS = [tag('ini_z', 'zephyr', '2026-10-01T09:00:00.000Z'), tag('ini_a', 'Atlas', '2026-10-02T09:00:00.000Z'), tag('ini_r', 'release', '2026-10-03T09:00:00.000Z'), tag('ini_q', 'quiet', '2026-10-04T09:00:00.000Z')];
const row = (thread_id: string, tags: string[], last_at: string) => ({ thread_id, tags, last_at }) as unknown as InboxListRow;
const ROWS = [row('t1', ['ini_a'], '2026-11-01T09:00:00.000Z'), row('t2', ['ini_r', 'ini_z'], '2026-11-03T09:00:00.000Z'), row('t3', ['ini_z'], '2026-10-20T09:00:00.000Z')];
const ACTIVITY = tagActivity(ROWS, (r) => r.tags ?? []);
const noop = () => {};

function draw(over: { tags?: readonly InboxInitiative[]; activity?: ReadonlyMap<string, string> } = {}, rest: Partial<SidebarProps> = {}) {
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
          projects={[]}
          projectCounts={new Map()}
          update={null}
          restarting={false}
          updated={null}
          onInbox={noop}
          onProject={noop}
          onSettings={noop}
          onUpdate={noop}
          onWhatsNew={noop}
          tags={{ tags: over.tags ?? TAGS, waiting: new Map(), tagId: null, shown: true, activity: over.activity ?? ACTIVITY, onOpen: noop, onCreate: async () => null, onRename: async () => true, onDelete: noop }}
          {...rest}
        />
      </SidebarProvider>,
    ),
  );
}

const names = () => [...host!.querySelectorAll('.ib-tags [data-tag-row] .ib-name')].map((el) => el.textContent);
const toggle = () => host!.querySelector<HTMLButtonElement>('[data-tags-sort]');
const press = () => act(() => toggle()!.click());

test.skipIf(!hasDom)("with no choice the Tags keep the server's order, and nothing is written", () => {
  draw();
  expect(names()).toEqual(['zephyr', 'Atlas', 'release', 'quiet']);
  expect(toggle()?.dataset.tagsSort).toBe('added');
  expect(stored.has(TAGS_SORT_COOKIE)).toBe(false);
});

test.skipIf(!hasDom)('the first press goes A to Z, then one button goes between most recent and A to Z, never back to the first order', () => {
  const said: string[] = [];
  draw({}, { announce: (text) => said.push(text) });
  press();
  expect(names()).toEqual(['Atlas', 'quiet', 'release', 'zephyr']);
  expect(stored.get(TAGS_SORT_COOKIE)).toBe('name');
  press();
  expect(names()).toEqual(['zephyr', 'release', 'Atlas', 'quiet']);
  expect(stored.get(TAGS_SORT_COOKIE)).toBe('recent');
  press();
  expect(names()).toEqual(['Atlas', 'quiet', 'release', 'zephyr']);
  expect(said).toEqual(['Tags: Sorted A to Z.', 'Tags: Sorted by most recent.', 'Tags: Sorted A to Z.']);
  expect(host!.querySelector('[data-sidebar-section="tags"]')!.getAttribute('aria-expanded')).toBe('true');
});

test.skipIf(!hasDom)("the choice survives a remount, and is the Tags' own, not Projects'", () => {
  storage.setItem(PROJECTS_SORT_COOKIE, 'name');
  draw();
  expect(names()).toEqual(['zephyr', 'Atlas', 'release', 'quiet']);
  press();
  press();
  expect(stored.get(PROJECTS_SORT_COOKIE)).toBe('name');
  unmount();
  draw();
  expect(names()).toEqual(['zephyr', 'release', 'Atlas', 'quiet']);
  expect(toggle()?.dataset.tagsSort).toBe('recent');
});

test.skipIf(!hasDom)("most recent follows the list: a new message moves its tag up", () => {
  storage.setItem(TAGS_SORT_COOKIE, 'recent');
  draw();
  expect(names()).toEqual(['zephyr', 'release', 'Atlas', 'quiet']);
  draw({ activity: tagActivity([...ROWS, row('t4', ['ini_q'], '2026-11-05T09:00:00.000Z')], (r) => r.tags ?? []) });
  expect(names()).toEqual(['quiet', 'zephyr', 'release', 'Atlas']);
});

test.skipIf(!hasDom)("a tag's activity is its newest thread, read through the window's tags of a row", () => {
  const far = row('t9', ['far_rel'], '2026-11-09T09:00:00.000Z');
  const merged: RowTags = (r) => (r.tags ?? []).map((id) => (id === 'far_rel' ? 'ini_r' : id));
  expect(Object.fromEntries(tagActivity([...ROWS, far], merged))).toEqual({
    ini_a: '2026-11-01T09:00:00.000Z',
    ini_r: '2026-11-09T09:00:00.000Z',
    ini_z: '2026-11-03T09:00:00.000Z',
  });
});

test.skipIf(!hasDom)('no toggle with one tag, or while Tags is closed', () => {
  draw({ tags: [TAGS[0]!] });
  expect(toggle()).toBeNull();
  draw();
  expect(toggle()).not.toBeNull();
  act(() => host!.querySelector<HTMLButtonElement>('[data-sidebar-section="tags"]')!.click());
  expect(toggle()).toBeNull();
});

test.skipIf(!hasDom)('the toggle sits beside New tag, not in place of it', () => {
  draw();
  const head = host!.querySelector('[data-tags-head]')!;
  expect(head.querySelector('[data-tags-sort]')).not.toBeNull();
  expect(head.querySelector('[data-tags-add]')).not.toBeNull();
});
