/**
 * Thread tags in the window (approval "inbox-thread-tags", step 1), drawn with a host in place of App (no server):
 * Add tag in the row's right-click menu (under Star thread, its list swapped in place with Back, ticks that keep the
 * menu open, untick, `New tag “…”` and Enter), Remove from <tag> in a tag's list, no Add tag on another machine's row;
 * the sidebar's Tags section (New tag's field, the waiting count, Show threads, Rename, Delete tag); and the rules that
 * decide when the section shows, what a tag's list holds and what its header says.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, expect, test } from 'bun:test';
import { act, useMemo, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxInitiative, InboxListRow, InboxListSection } from '@plannotator/core/inbox-types';
import { INBOX_SIDEBAR_DEFAULT } from '@plannotator/core/inbox-sidebar';
import { canTagThread, filterTagRows, rowTagsHere, tagListSummary, tagsSectionShown, tagWaitingCounts, ThreadTagsContext, type ThreadTagsHost } from './threadTags';
import { drawnSidebarItems } from './sidebarItems';
import { sidebarMenuItems } from './components/SidebarMenu';

const hasDom = typeof document !== 'undefined';
const { ThreadRowMenu } = (hasDom ? await import('./components/RowMenu') : {}) as typeof import('./components/RowMenu');
const { TagsSection } = (hasDom ? await import('./components/TagsSection') : {}) as typeof import('./components/TagsSection');

const tag = (id: string, name: string, by: 'person' | 'agent' = 'person'): InboxInitiative =>
  ({ id, name, created_at: '2026-11-12T09:00:00.000Z', created_by: by === 'person' ? { kind: 'person' } : { kind: 'agent', host: 'claude-code', session: 's', name: 'Claude Code' }, updated_at: '2026-11-12T09:00:00.000Z', deleted_at: null }) as InboxInitiative;
const RELEASE = tag('ini_release', 'Release');
const WINDOWS = tag('ini_windows', 'Windows');
const row = (id: string, tags: string[] = [], extra: Partial<InboxListRow> = {}) =>
  ({ thread_id: id, subject: id, section: 'new', unseen: 0, answered_not_sent: false, resolved_at: null, read_at: null, project: { id: `prj_${id}`, name: id }, tags, ...extra }) as unknown as InboxListRow;

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  document.body.innerHTML = '';
});

function draw(node: React.ReactNode) {
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(node);
  });
}

async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 60; i++) {
    if (check()) return;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 25));
    });
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function rightClick(el: Element) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 300, clientY: 200 }));
  });
}

async function press(el: Element | null | undefined) {
  if (!el) throw new Error('nothing to press');
  await act(async () => {
    (el as HTMLElement).click();
  });
}

async function key(el: Element, k: string) {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  });
}

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** A host that records what Add tag asks for, and keeps the threads' tags as App does (a write draws them again). */
function tagsHost(rows: InboxListRow[], listed: InboxInitiative | null, calls: string[]) {
  return function Hosted({ children }: { children: React.ReactNode }) {
    const [own, setOwn] = useState(() => new Map(rows.map((r) => [r.thread_id, [...(r.tags ?? [])]])));
    const value: ThreadTagsHost = {
      tags: [RELEASE, WINDOWS],
      tagsOf: (id) => own.get(id) ?? [],
      counts: new Map([[RELEASE.id, 3]]),
      can: (id) => !rows.find((r) => r.thread_id === id)?.machine,
      set: (id, t, on) => {
        calls.push(`${on ? 'add' : 'remove'} ${t.name} ${id}`);
        setOwn((now) => new Map(now).set(id, on ? [...(now.get(id) ?? []), t.id] : (now.get(id) ?? []).filter((x) => x !== t.id)));
      },
      createAndSet: (id, name) => calls.push(`create ${name} ${id}`),
      listed,
    };
    return <ThreadTagsContext.Provider value={value}>{children}</ThreadTagsContext.Provider>;
  };
}

function RowMenuWith({ rows, listed = null, calls = [] }: { rows: InboxListRow[]; listed?: InboxInitiative | null; calls?: string[] }) {
  // eslint-disable-next-line react-hooks/exhaustive-deps -- one host for the drawing
  const Hosted = useMemo(() => tagsHost(rows, listed, calls), []);
  return (
    <Hosted>
      <ThreadRowMenu className="ib-lbody" rowOf={(id) => rows.find((r) => r.thread_id === id) ?? null} pinnedOf={() => false} canMarkRead={false} held={false} onAction={() => {}} onTarget={() => {}}>
        {rows.map((r) => (
          <div key={r.thread_id} data-row={r.thread_id}>
            <button type="button" data-thread-id={r.thread_id}>
              {r.subject}
            </button>
          </div>
        ))}
      </ThreadRowMenu>
    </Hosted>
  );
}

const menu = () => document.querySelector<HTMLElement>('[data-row-menu]');
const labels = () => [...(menu()?.querySelectorAll('[role="menuitem"], [role="menuitemcheckbox"]') ?? [])].map((el) => el.textContent?.trim());

test.skipIf(!hasDom)('Add tag sits under Star thread with the thread’s tag count, and opens its list in place: Back, a focused field, the tags ticked', async () => {
  const rows = [row('a', [RELEASE.id])];
  draw(<RowMenuWith rows={rows} />);
  await rightClick(document.querySelector('[data-thread-id="a"]')!);
  await until(() => !!menu(), 'the menu');
  expect(labels().slice(0, 2)).toEqual(['Star thread', 'Add tag1']);
  await press(menu()!.querySelector('[data-add-tag-item]'));
  await until(() => !!menu()?.querySelector('[data-add-tag-list]'), 'the tags');
  expect(menu()!.querySelector('[data-add-tag-back]')?.textContent).toBe('Add tag');
  await until(() => document.activeElement === menu()?.querySelector('[data-tag-find]'), 'focus in the field');
  const picks = [...menu()!.querySelectorAll('[data-tag-pick]')];
  expect(picks.map((el) => [el.textContent, el.getAttribute('aria-checked')])).toEqual([
    ['Release3', 'true'],
    ['Windows', 'false'],
  ]);
  // Back: the menu again, focus on Add tag.
  await press(menu()!.querySelector('[data-add-tag-back]'));
  await until(() => document.activeElement === menu()?.querySelector('[data-add-tag-item]'), 'focus back on Add tag');
});

test.skipIf(!hasDom)('a tick puts the thread in the tag and the menu stays open; untick takes it out', async () => {
  const rows = [row('a')];
  const calls: string[] = [];
  draw(<RowMenuWith rows={rows} calls={calls} />);
  await rightClick(document.querySelector('[data-thread-id="a"]')!);
  await until(() => !!menu(), 'the menu');
  await press(menu()!.querySelector('[data-add-tag-item]'));
  await until(() => !!menu()?.querySelector('[data-tag-pick]'), 'the tags');
  await press(menu()!.querySelector(`[data-tag-pick="${WINDOWS.id}"]`));
  await press(menu()!.querySelector(`[data-tag-pick="${RELEASE.id}"]`));
  expect(menu()).not.toBeNull();
  await press(menu()!.querySelector(`[data-tag-pick="${WINDOWS.id}"]`));
  expect(calls).toEqual(['add Windows a', 'add Release a', 'remove Windows a']);
});

test.skipIf(!hasDom)('a typed name that is no tag offers New tag “…”, and Enter makes it; a typed name that is one ticks it', async () => {
  const rows = [row('a')];
  const calls: string[] = [];
  draw(<RowMenuWith rows={rows} calls={calls} />);
  await rightClick(document.querySelector('[data-thread-id="a"]')!);
  await until(() => !!menu(), 'the menu');
  await press(menu()!.querySelector('[data-add-tag-item]'));
  await until(() => !!menu()?.querySelector('[data-tag-find]'), 'the field');
  const field = menu()!.querySelector<HTMLInputElement>('[data-tag-find]')!;
  await type(field, 'Bill');
  expect(menu()!.querySelector('[data-tag-new]')?.textContent).toBe('New tag “Bill”');
  expect(menu()!.querySelectorAll('[data-tag-pick]').length).toBe(0);
  await key(field, 'Enter');
  await type(field, 'windows');
  // A name that is a tag (case ignored): no New tag, and Enter ticks it.
  expect(menu()!.querySelector('[data-tag-new]')).toBeNull();
  await key(field, 'Enter');
  expect(calls).toEqual(['create Bill a', 'add Windows a']);
  // Letters stay in the field: the menu's type-ahead never takes them.
  await type(field, 'R');
  expect(field.value).toBe('R');
});

test.skipIf(!hasDom)('in a tag’s list a row in it offers Remove from <tag>; another machine’s row offers no Add tag', async () => {
  const rows = [row('a', [RELEASE.id]), row('b', [], { machine: 'ibx_other' } as Partial<InboxListRow>)];
  const calls: string[] = [];
  draw(<RowMenuWith rows={rows} listed={RELEASE} calls={calls} />);
  await rightClick(document.querySelector('[data-thread-id="a"]')!);
  await until(() => !!menu(), 'the menu');
  expect(labels().slice(0, 3)).toEqual(['Star thread', 'Add tag1', 'Remove from Release']);
  await press(menu()!.querySelector(`[data-tag-remove="${RELEASE.id}"]`));
  expect(calls).toEqual(['remove Release a']);
  await until(() => !menu(), 'the menu to close');
  await rightClick(document.querySelector('[data-thread-id="b"]')!);
  await until(() => menu()?.getAttribute('data-row-menu') === 'b', 'the other menu');
  expect(menu()!.querySelector('[data-add-tag-item]')).toBeNull();
  expect(menu()!.querySelector('[data-tag-remove]')).toBeNull();
});

function Section(props: { onCreate?: (name: string) => Promise<string | null>; onRename?: (id: string, name: string) => Promise<boolean>; onDelete?: (t: InboxInitiative) => void; onOpen?: (id: string) => void; tagId?: string | null; closed?: boolean }) {
  return (
    <TagsSection
      tags={[RELEASE, WINDOWS]}
      waiting={new Map([[RELEASE.id, 2]])}
      tagId={props.tagId ?? null}
      closed={props.closed ?? false}
      onToggle={() => {}}
      header={<button type="button" data-sidebar-section="tags">Tags</button>}
      labelId="tags-l"
      bodyId="tags-b"
      phone={false}
      pick={(go) => go}
      onOpen={props.onOpen ?? (() => {})}
      onCreate={props.onCreate ?? (async () => null)}
      onRename={props.onRename ?? (async () => true)}
      onDelete={props.onDelete ?? (() => {})}
    />
  );
}

const tagRow = (id: string) => document.querySelector<HTMLElement>(`[data-tag-row="${id}"]`);
const tagMenu = () => document.querySelector<HTMLElement>('[data-tag-menu]');

test.skipIf(!hasDom)('the sidebar’s tags: plain names, the waiting count, a quieter name when none waits, the shown tag filled; closed keeps only that one', async () => {
  draw(<Section tagId={WINDOWS.id} />);
  expect(tagRow(RELEASE.id)!.textContent).toBe('Release2 waiting on you');
  expect(tagRow(RELEASE.id)!.classList.contains('ib-proj-quiet')).toBe(false);
  expect(tagRow(WINDOWS.id)!.textContent).toBe('Windows');
  expect(tagRow(WINDOWS.id)!.classList.contains('ib-proj-quiet')).toBe(true);
  expect(tagRow(WINDOWS.id)!.classList.contains('ib-on')).toBe(true);
  act(() => root!.render(<Section tagId={WINDOWS.id} closed />));
  expect([...document.querySelectorAll('[data-tag-row]')].map((el) => el.getAttribute('data-tag-row'))).toEqual([WINDOWS.id]);
  // `+` stays on the heading, closed or open.
  expect(document.querySelector('[data-tags-add]')).not.toBeNull();
});

test.skipIf(!hasDom)('`+` makes a tag from a field in the section: Enter makes it and focus lands on its row; Escape leaves nothing', async () => {
  const made: string[] = [];
  // The made tag's id: here one the section already draws.
  const onCreate = async (name: string) => {
    made.push(name);
    return WINDOWS.id;
  };
  draw(<Section onCreate={onCreate} />);
  await press(document.querySelector('[data-tags-add]'));
  const field = document.querySelector<HTMLInputElement>('[data-tag-name-field]')!;
  expect(document.activeElement).toBe(field);
  expect(field.placeholder).toBe('New tag');
  await type(field, '  Billing  ');
  await key(field, 'Enter');
  await until(() => !document.querySelector('[data-tag-name-field]'), 'the field to close');
  expect(made).toEqual(['Billing']);
  expect(document.activeElement).toBe(tagRow(WINDOWS.id));
  await press(document.querySelector('[data-tags-add]'));
  await key(document.querySelector('[data-tag-name-field]')!, 'Escape');
  expect(document.querySelector('[data-tag-name-field]')).toBeNull();
  expect(made).toEqual(['Billing']);
});

test.skipIf(!hasDom)('right-click a tag: Show threads, Rename in place, Delete tag', async () => {
  const done: string[] = [];
  draw(
    <Section
      onOpen={(id) => done.push(`open ${id}`)}
      onRename={async (id, name) => {
        done.push(`rename ${id} ${name}`);
        return true;
      }}
      onDelete={(t) => done.push(`delete ${t.id}`)}
    />,
  );
  await rightClick(tagRow(RELEASE.id)!);
  await until(() => !!tagMenu(), 'the tag menu');
  expect([...tagMenu()!.querySelectorAll('[role="menuitem"]')].map((el) => el.textContent?.trim())).toEqual(['Show threads', 'Rename', 'Delete tag']);
  await press(tagMenu()!.querySelector('[data-tag-action="open"]'));
  await until(() => !tagMenu(), 'the menu to close');
  await rightClick(tagRow(RELEASE.id)!);
  await until(() => !!tagMenu(), 'the tag menu');
  await press(tagMenu()!.querySelector('[data-tag-action="rename"]'));
  await until(() => document.activeElement?.hasAttribute('data-tag-name-field') === true, 'the rename field');
  const field = document.activeElement as HTMLInputElement;
  expect(field.value).toBe('Release');
  await type(field, 'Ship 0.29');
  await key(field, 'Enter');
  await until(() => !document.querySelector('[data-tag-name-field]'), 'the field to close');
  await rightClick(tagRow(WINDOWS.id)!);
  await until(() => !!tagMenu(), 'the tag menu');
  await press(tagMenu()!.querySelector('[data-tag-action="delete"]'));
  expect(done).toEqual([`open ${RELEASE.id}`, `rename ${RELEASE.id} Ship 0.29`, `delete ${WINDOWS.id}`]);
});

test('the Tags section shows once a live tag holds a listed thread or the person made a tag, never for an agent’s card initiative alone', () => {
  const agents = tag('ini_agent', 'Docs', 'agent');
  expect(tagsSectionShown([], [row('a')])).toBe(false);
  expect(tagsSectionShown([agents], [row('a')])).toBe(false);
  expect(tagsSectionShown([agents], [row('a', [agents.id])])).toBe(true);
  expect(tagsSectionShown([RELEASE], [])).toBe(true);
  // What this window just set counts before the list reads it.
  expect(tagsSectionShown([agents], [row('a')], () => [agents.id])).toBe(true);
});

test('a tag’s list keeps every group with only the tag’s rows; the count is the rows waiting on the person; the header says threads and projects', () => {
  const sections = [
    { id: 'stopped', label: 'Stopped', threads: [row('a', [RELEASE.id])] },
    { id: 'new', label: 'New', threads: [row('b', [RELEASE.id]), row('c', [WINDOWS.id])] },
  ] as unknown as InboxListSection[];
  const listed = filterTagRows(sections, RELEASE.id);
  expect(listed.map((s) => [s.id, s.threads.map((r) => r.thread_id)])).toEqual([
    ['stopped', ['a']],
    ['new', ['b']],
  ]);
  // Untick seen at once: the patched row leaves the list before the server's read.
  expect(filterTagRows(sections, RELEASE.id, (r) => (r.thread_id === 'b' ? [] : (r.tags ?? []))).flatMap((s) => s.threads.map((r) => r.thread_id))).toEqual(['a']);
  expect([...tagWaitingCounts(sections)]).toEqual([[RELEASE.id, 1]]);
  expect(tagListSummary(listed.flatMap((s) => s.threads))).toBe('2 threads · 2 projects');
  expect(tagListSummary([row('a')])).toBe('1 thread · 1 project');
});

test('another machine’s thread is never offered Add tag and never listed in a tag, whatever tags its row carries', () => {
  const self = 'ibx_self';
  const mine = row('a', [RELEASE.id], { machine: self } as Partial<InboxListRow>);
  const plain = row('b', [RELEASE.id]);
  // A newer linked Inbox sends its own rows' tags: never this Inbox's tags, even naming the same id.
  const theirs = row('c', [RELEASE.id], { machine: 'ibx_other' } as Partial<InboxListRow>);
  const rows = [mine, plain, theirs];
  const patches = new Map([['c', [RELEASE.id]]]);
  expect(canTagThread('a', rows, self, null)).toBe(true);
  expect(canTagThread('b', rows, self, null)).toBe(true);
  expect(canTagThread('c', rows, self, null)).toBe(false);
  // A thread opened from a link or search with no row here, which a linked machine owns (the thread's ⋯).
  expect(canTagThread('d', rows, self, 'ibx_other')).toBe(false);
  expect(canTagThread('d', rows, self, null)).toBe(true);
  expect(rowTagsHere(theirs, self, patches)).toEqual([]);
  const sections = [{ id: 'new', label: 'New', threads: rows }] as unknown as InboxListSection[];
  const tagsOf = (r: Pick<InboxListRow, 'thread_id' | 'tags' | 'machine'>) => rowTagsHere(r, self, patches);
  expect(filterTagRows(sections, RELEASE.id, tagsOf).flatMap((s) => s.threads.map((r) => r.thread_id))).toEqual(['a', 'b']);
});

test('Tags is in the sidebar’s menu and Customize only while the section is drawn, just above Agents', () => {
  const base = { board: false, reviews: false, shape: false, usage: false, phone: false, agents: true };
  expect(drawnSidebarItems(base).has('tags')).toBe(false);
  const drawn = drawnSidebarItems({ ...base, tags: true });
  const items = sidebarMenuItems(INBOX_SIDEBAR_DEFAULT, drawn);
  expect(items.indexOf('tags')).toBe(items.indexOf('agents') - 1);
});
