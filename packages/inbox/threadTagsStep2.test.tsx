/**
 * Thread tags, step 2 (approval "inbox-thread-tags"), drawn with a tags host in place of App:
 * - the thread header's tag line: nothing for a thread in no tag; `#` once and the names as links to their lists;
 *   `+` opens Add tag's tick list (no Back row) and a tick puts the thread in or takes it out; no `+` where Add tag is
 *   not offered; a linked machine's thread shows and writes its tags by the window's rule, an older machine's none;
 * - the list's Filter: a Tag group of plain names once a tag holds a listed thread (none for a person with no tags,
 *   none on a tag's own list), several tags widening, combined with the other groups, the badge counting them;
 * - Search: `#name` leads with Tags and "Threads tagged …" (a linked machine's thread too), plain words find the tag
 *   under the results, a tag row opens its list;
 * - the Board-off preview of a sent `#name`: its threads (the one it sits in left out), "Show threads" to its list,
 *   a first tap previews and a second goes, a tag only a linked machine holds previews too.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, setSystemTime, test } from 'bun:test';
import { act, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxInitiative, InboxListGroupId, InboxListRow, InboxListSection } from '@plannotator/core/inbox-types';
import type { InitiativeTags } from './hashtags';
import type { MachinesModel } from './machines';
import type { ListTag, ThreadTagsHost } from './threadTags';

const hasDom = typeof document !== 'undefined';
const { ThreadTagsContext, canTagThread, rowTagsHere, tagHref, tagWrite } = await import('./threadTags');
const { ThreadTagLine } = (hasDom ? await import('./components/ThreadTagLine') : {}) as typeof import('./components/ThreadTagLine');
const { InboxList } = (hasDom ? await import('./components/InboxList') : {}) as typeof import('./components/InboxList');
const { SidebarProvider } = (hasDom ? await import('./shell/sidebar') : {}) as typeof import('./shell/sidebar');
const { default: SearchPalette } = (hasDom ? await import('./search/SearchPalette') : {}) as typeof import('./search/SearchPalette');
const { InitiativeTagsContext } = (hasDom ? await import('./hashtags') : {}) as typeof import('./hashtags');
const { useInitiativePeek } = (hasDom ? await import('./components/InitiativePeek') : {}) as typeof import('./components/InitiativePeek');
const { appliedFilter, filterListSections, pickCount, resetListFilterForTests, useListFilter } = await import('./listFilter');
const { withLiveTagPicks } = await import('./listFilterTags');
const { setStorageBackend, resetStorageBackend } = await import('@plannotator/ui/utils/storage');

const NOW = new Date(2026, 10, 5, 15, 0, 0);
const ago = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000).toISOString();
const tag = (id: string, name: string, machines?: Record<string, string>): ListTag => ({ id, name, created_at: '2026-11-01T09:00:00.000Z', created_by: { kind: 'person' }, updated_at: '2026-11-01T09:00:00.000Z', deleted_at: null, ...(machines ? { machines } : {}) }) as ListTag;
const RELEASE = tag('ini_release', 'Release', { self: 'ini_release', mini: 'ini_mini_release' });
const WINDOWS = tag('ini_windows', 'Windows');
/** A tag only the linked machine holds. */
const DOCS = tag('ini_mini_docs', 'Docs move', { mini: 'ini_mini_docs' });

function row(id: string, project: string, hoursAgo: number, section: InboxListGroupId, tags: string[], machine?: string): InboxListRow {
  return {
    thread_id: id,
    project: { id: `prj_${project}`, name: project },
    subject: `Thread ${id}`,
    thread_name: null,
    author: { kind: 'agent', host: section === 'waiting' ? 'codex' : 'claude-code', session: `s_${id}`, name: null },
    last_at: ago(hoursAgo),
    last_agent_at: ago(hoursAgo),
    last_author: 'agent',
    section,
    unread: section !== 'quiet',
    unseen: 0,
    questions: { open: 0, picked: 0, stopped: false, holds_up: [] },
    sent: null,
    resolved_at: null,
    ...(tags.length ? { tags } : {}),
    ...(machine ? { machine } : {}),
  } as unknown as InboxListRow;
}

/** This Inbox (self), a linked Mac mini that takes tags, and an older linked machine that does not. */
const MACHINES = { self: 'self', linked: [{ id: 'mini', marks: ['tags'] }, { id: 'old', marks: [] }] } as unknown as MachinesModel;
const ROWS = [
  row('msg_a', 'billing', 1, 'waiting', ['ini_release']),
  row('msg_b', 'web', 2, 'new', ['ini_release', 'ini_windows']),
  row('msg_c', 'web', 3, 'new', ['ini_windows']),
  row('msg_far', 'docs', 4, 'new', ['ini_release', 'ini_mini_docs'], 'mini'),
  row('msg_old', 'docs', 5, 'new', ['ini_release'], 'old'),
  row('msg_none', 'billing', 6, 'quiet', []),
];

/** App's host: the real rules for rows and machines, a write recorded as App would send it (by id here, by name there). */
function hostOf(rows: InboxListRow[], tags: ListTag[], writes: string[], listed: ListTag | null = null): ThreadTagsHost {
  const rowTags = (r: Pick<InboxListRow, 'thread_id' | 'tags' | 'machine'>) => rowTagsHere(r, MACHINES, new Map());
  const counts = new Map<string, number>();
  for (const r of rows) for (const id of rowTags(r)) counts.set(id, (counts.get(id) ?? 0) + 1);
  return {
    tags,
    tagsOf: (id) => {
      const r = rows.find((x) => x.thread_id === id);
      return r ? rowTags(r) : [];
    },
    counts,
    can: (id) => canTagThread(id, rows, MACHINES, rows.find((x) => x.thread_id === id)?.machine ?? null),
    set: (id, t, on) => writes.push(`${on ? 'add' : 'remove'} ${JSON.stringify(tagWrite(t, rows.find((x) => x.thread_id === id)?.machine ?? null, 'self'))} ${id}`),
    createAndSet: (id, name) => writes.push(`create ${name} ${id}`),
    listed,
    rows,
    rowTags,
    waiting: new Map([['ini_release', 1]]),
  };
}

const stored = new Map<string, string>();
let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch | null = null;

beforeEach(() => {
  setSystemTime(NOW);
  stored.clear();
  setStorageBackend({ getItem: (k) => stored.get(k) ?? null, setItem: (k, v) => void stored.set(k, v), removeItem: (k) => void stored.delete(k) });
  resetListFilterForTests();
});

afterEach(() => {
  if (hasDom) act(() => root?.unmount());
  setSystemTime();
  resetStorageBackend();
  resetListFilterForTests();
  if (savedFetch) globalThis.fetch = savedFetch;
  savedFetch = null;
  if (!hasDom) return;
  host?.remove();
  document.body.innerHTML = '';
  root = null;
  host = null;
  window.location.hash = '';
});

function draw(node: React.ReactNode) {
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(node));
}

async function settle() {
  for (let i = 0; i < 6; i += 1) await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))));
}
/** Base UI opens on the pointer's press, as a person's click does. */
async function press(target: Element) {
  await act(async () => {
    target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }));
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerType: 'mouse' }));
    target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
    (target as HTMLElement).click();
  });
  await settle();
}
async function click(target: Element) {
  await act(async () => (target as HTMLElement).click());
  await settle();
}
const $ = (selector: string) => document.querySelector<HTMLElement>(selector);
const texts = (selector: string) => [...document.querySelectorAll(selector)].map((n) => n.textContent);

// ── The thread header's tag line ──

function line(threadId: string, rows = ROWS, writes: string[] = []) {
  draw(
    <ThreadTagsContext.Provider value={hostOf(rows, [RELEASE, WINDOWS, DOCS], writes)}>
      <h2 className="ib-subject">Subject</h2>
      <ThreadTagLine threadId={threadId} phone={false} />
    </ThreadTagsContext.Provider>,
  );
}

test.skipIf(!hasDom)('header: a thread in no tag draws nothing, and nothing draws without a tags host (an older Inbox)', () => {
  line('msg_none');
  expect($('[data-thread-tags]')).toBeNull();
  act(() => root!.unmount());
  draw(<ThreadTagLine threadId="msg_a" phone={false} />);
  expect($('[data-thread-tags]')).toBeNull();
});

test.skipIf(!hasDom)('header: `#` once, the names plain, each a link to its list; `+` opens the tick list without Back, and a tick writes', async () => {
  const writes: string[] = [];
  line('msg_b', ROWS, writes);
  const el = $('[data-thread-tags]')!;
  expect(el.querySelectorAll('svg')).toHaveLength(2); // the one `#`, and the `+`
  expect(texts('[data-thread-tag]')).toEqual(['Release', 'Windows']);
  expect([...el.querySelectorAll('[data-thread-tag]')].map((a) => a.getAttribute('href'))).toEqual([tagHref('ini_release'), tagHref('ini_windows')]);
  expect(el.querySelector('ul')!.getAttribute('aria-label')).toBe('Tags');
  const add = el.querySelector('[data-thread-tags-add]')!;
  expect(add.getAttribute('aria-label')).toBe('Add tag');
  await press(add);
  const menu = $('[data-thread-tags-menu]')!;
  expect(menu).not.toBeNull();
  expect(menu.querySelector('[data-add-tag-back]')).toBeNull();
  expect(menu.querySelector('[data-tag-find]')).not.toBeNull();
  expect([...menu.querySelectorAll('[data-tag-pick]')].map((n) => [n.getAttribute('data-tag-pick'), n.getAttribute('aria-checked')])).toEqual([
    ['ini_release', 'true'],
    ['ini_windows', 'true'],
    ['ini_mini_docs', 'false'],
  ]);
  await click(menu.querySelector('[data-tag-pick="ini_windows"]')!);
  expect(writes).toEqual(['remove {"tag":"ini_windows"} msg_b']);
  // A tick keeps the menu open (several tags).
  expect($('[data-thread-tags-menu]')).not.toBeNull();
});

test.skipIf(!hasDom)("header: a linked machine's thread shows its tags and writes by name; an older machine's thread shows none", async () => {
  const writes: string[] = [];
  line('msg_far', ROWS, writes);
  expect(texts('[data-thread-tag]')).toEqual(['Release', 'Docs move']);
  await press($('[data-thread-tags-add]')!);
  await click($('[data-thread-tags-menu] [data-tag-pick="ini_windows"]')!);
  expect(writes).toEqual(['add {"name":"Windows"} msg_far']);
  act(() => root!.unmount());
  line('msg_old');
  // Its `row.tags` are that machine's own ids: never read here, and it takes no tag from here.
  expect($('[data-thread-tags]')).toBeNull();
});

test.skipIf(!hasDom)('header: no `+` where Add tag is not offered', () => {
  const rows = [row('msg_x', 'web', 1, 'new', ['ini_release'], 'gone')];
  draw(
    <ThreadTagsContext.Provider value={{ ...hostOf(rows, [RELEASE], []), tagsOf: () => ['ini_release'], can: () => false }}>
      <ThreadTagLine threadId="msg_x" phone={false} />
    </ThreadTagsContext.Provider>,
  );
  expect(texts('[data-thread-tag]')).toEqual(['Release']);
  expect($('[data-thread-tags-add]')).toBeNull();
});

// ── The list's Filter ──

const LIST: InboxListSection[] = (['stopped', 'holding', 'waiting', 'new', 'sent', 'quiet'] as InboxListGroupId[]).map((id) => ({ id, label: id, threads: ROWS.filter((r) => r.section === id) })) as InboxListSection[];

/** App's wiring (app/useListView.ts): the picks resolved against the live tags, the rows' tags by the window's rule. */
function FilterHarness({ value, tagList = false }: { value: ThreadTagsHost; tagList?: boolean }) {
  const [picks, setPicks] = useListFilter();
  const applied = withLiveTagPicks(appliedFilter(picks, false, tagList), value.tags);
  const shown = filterListSections(LIST, applied, Date.now(), undefined, value.rowTags);
  return (
    <ThreadTagsContext.Provider value={tagList ? { ...value, listed: RELEASE } : value}>
      <SidebarProvider>
        <InboxList
          title="Inbox"
          path={null}
          sections={shown}
          sort={{ epoch: 1, keep: null }}
          filtered={false}
          narrow={false}
          phone={false}
          selectedThreadId={null}
          notice={null}
          onShowNew={() => {}}
          onOpen={() => {}}
          listFilter={{ rows: LIST.flatMap((s) => s.threads), scoped: false, names: new Map(), filter: picks, onChange: setPicks }}
        />
      </SidebarProvider>
      <span data-applied={pickCount(applied)} />
    </ThreadTagsContext.Provider>
  );
}
const funnel = () => $('.ib-lhead [data-list-filter]')!;
const rowIds = () => [...document.querySelectorAll('.ib-lbody [data-thread-id]')].map((n) => n.getAttribute('data-thread-id'));
const groupsOf = () => [...document.querySelectorAll('[data-list-filter-menu] [data-list-filter-group]')].map((g) => g.getAttribute('data-list-filter-group'));

test.skipIf(!hasDom)('filter: a Tag group of plain names with counts; several tags widen, another group narrows, the badge counts each', async () => {
  draw(<FilterHarness value={hostOf(ROWS, [RELEASE, WINDOWS, DOCS], [])} />);
  await press(funnel());
  expect(groupsOf()).toContain('tags');
  const group = $('[data-list-filter-group="tags"]')!;
  expect(group.querySelector('[role="group"] > *, .ib-pm-glabel')!.textContent).toBe('Tag');
  // The older machine's row reads no tag: Release counts a, b and the Mac mini's thread.
  expect([...group.querySelectorAll('[data-list-filter-tag]')].map((n) => [n.querySelector('.ib-pmi-l')!.textContent, n.querySelector('.ib-pmi-n')!.textContent])).toEqual([
    ['Release', '3'],
    ['Windows', '2'],
    ['Docs move', '1'],
  ]);
  // Plain names: no mark before them (the `#` is the heading's, once).
  expect(group.querySelector('[data-list-filter-tag] svg:not(.ib-pc-tick svg)')).toBeNull();
  await click($('[data-list-filter-tag="ini_release"]')!);
  expect(rowIds()).toEqual(['msg_a', 'msg_b', 'msg_far']);
  await click($('[data-list-filter-tag="ini_windows"]')!);
  expect(rowIds()).toEqual(['msg_a', 'msg_b', 'msg_c', 'msg_far']);
  await click($('[data-list-filter-not-seen]')!);
  await click($('[data-list-filter-project="prj_web"]')!);
  expect(rowIds()).toEqual(['msg_b', 'msg_c']);
  expect(funnel().getAttribute('aria-label')).toBe('Filter, 4 active');
  expect(JSON.parse(stored.get('plannotator-inbox-list-filter')!).tags).toEqual(['ini_release', 'ini_windows']);
});

test.skipIf(!hasDom)("filter: nothing new for a person with no tags, and no Tag group on a tag's own list (its picks step aside)", async () => {
  const untagged = ROWS.map((r) => ({ ...r, tags: undefined }));
  draw(<FilterHarness value={hostOf(untagged, [], [])} />);
  await press(funnel());
  expect(groupsOf()).not.toContain('tags');
  act(() => root!.unmount());
  document.body.innerHTML = '';
  stored.set('plannotator-inbox-list-filter', JSON.stringify({ tags: ['ini_release'] }));
  resetListFilterForTests();
  draw(<FilterHarness value={hostOf(ROWS, [RELEASE, WINDOWS], [])} tagList />);
  expect($('[data-applied]')!.getAttribute('data-applied')).toBe('0');
  expect(funnel().getAttribute('aria-label')).toBe('Filter');
  await press(funnel());
  expect(groupsOf()).not.toContain('tags');
});

// ── Search ──

const NO_ANSWER = { serverSession: 's', q: '', terms: [], took_ms: 1, indexing: false, threads: 6, totals: null, groups: null, recent: [], recent_searches: [] };

function palette(value: ThreadTagsHost, opened: string[]) {
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const q = new URL(String(input), 'http://127.0.0.1:1').searchParams.get('q') ?? '';
    return new Response(JSON.stringify({ ...NO_ANSWER, q, recent: q ? null : [], totals: { threads: 0, messages: 0, files: 0, projects: 0 }, groups: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  draw(
    <ThreadTagsContext.Provider value={value}>
      <SearchPalette open phone={false} currentProject={null} projects={[]} onClose={() => {}} onOpenResult={(hash) => opened.push(hash)} />
    </ThreadTagsContext.Provider>,
  );
}
async function typeIn(value: string) {
  await act(async () => {
    const el = $('[role="combobox"]') as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  for (let i = 0; i < 40 && !document.querySelector('[data-search-group]'); i += 1) await act(async () => void (await new Promise((r) => setTimeout(r, 20))));
  await settle();
}
const headings = () => [...document.querySelectorAll('[data-search-group]')].map((g) => g.getAttribute('data-search-group'));

test.skipIf(!hasDom)("search: `#rel` leads with the tag and its threads, a linked machine's too; Enter opens the tag's list", async () => {
  const opened: string[] = [];
  palette(hostOf(ROWS, [RELEASE, WINDOWS, DOCS], []), opened);
  await typeIn('#rel');
  expect(headings()).toEqual(['tags', 'tagged']);
  expect(texts('[data-search-group="tagged"] .ib-sp-gh')).toEqual(['Threads tagged Release']);
  expect(texts('[data-result="tag"] .ib-sp-p')).toEqual(['Release']);
  expect($('[data-result="tag"] .ib-sp-time')!.textContent).toBe(', 3 threads · 1 waiting on you');
  // The latest first; the older machine's thread is in no tag here.
  expect([...document.querySelectorAll('[data-result="tagged"]')].map((n) => n.getAttribute('data-result-id'))).toEqual(['msg_a', 'msg_b', 'msg_far']);
  await act(async () => {
    $('[role="combobox"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  });
  expect(opened).toEqual([tagHref('ini_release')]);
});

test.skipIf(!hasDom)('search: plain words find a tag by a word of its name, under the results, with no thread list; no tags, no group', async () => {
  palette(hostOf(ROWS, [RELEASE, WINDOWS, DOCS], []), []);
  await typeIn('move');
  expect(headings()).toEqual(['tags']);
  expect(texts('[data-result="tag"] .ib-sp-p')).toEqual(['Docs move']);
  act(() => root!.unmount());
  globalThis.fetch = savedFetch!;
  palette(hostOf(ROWS, [], []), []);
  await typeIn('#rel');
  expect(headings()).toEqual([]);
});

// ── The Board-off preview of a sent tag ──

function Body() {
  const ref = useRef<HTMLDivElement>(null);
  const peek = useInitiativePeek(ref);
  return (
    <div
      ref={ref}
      onClickCapture={(event) => {
        const link = (event.target as Element).closest('a[href^="#tag="]');
        if (!link || (event.target as Element).closest('[data-tag-peek]')) return;
        event.preventDefault();
        if (peek.tapOpens(link)) return;
        window.location.hash = link.getAttribute('href')!;
      }}
    >
      {peek.node}
      <p>
        Part of <a href={tagHref('ini_release')}>#Release</a> and <a href={tagHref('ini_mini_docs')}>#DocsMove</a>
      </p>
    </div>
  );
}
function BoardOff({ value }: { value: ThreadTagsHost }) {
  const [tags] = useState<InitiativeTags>(() => ({ initiatives: [RELEASE as InboxInitiative], counts: new Map(), cards: [], rows: new Map(), projects: new Map([['prj_web', 'web']]), mentions: new Map(), href: tagHref }));
  return (
    <InitiativeTagsContext.Provider value={tags}>
      <ThreadTagsContext.Provider value={value}>
        <Body />
      </ThreadTagsContext.Provider>
    </InitiativeTagsContext.Provider>
  );
}
function tap(el: Element) {
  act(() => {
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }));
    (el as HTMLElement).click();
  });
}

test.skipIf(!hasDom)("preview, Board off: the tag's threads but the one it sits in, Show threads to its list; a first tap previews, a second goes", () => {
  window.location.hash = '#thread=msg_b';
  draw(<BoardOff value={hostOf(ROWS, [RELEASE, WINDOWS, DOCS], [])} />);
  const link = document.querySelector(`a[href="${tagHref('ini_release')}"]`)!;
  tap(link);
  const peek = $('[data-tag-peek]')!;
  expect(peek.getAttribute('aria-label')).toBe('Tag Release');
  expect(link.getAttribute('aria-expanded')).toBe('true');
  expect(peek.querySelector('[data-tag-peek-meta]')!.textContent).toBe('Tag · billing, web, docs · 3 threads');
  expect([...peek.querySelectorAll('[data-tag-peek-threads] a')].map((a) => a.getAttribute('href'))).toEqual(['#thread=msg_a', '#thread=msg_far']);
  expect(peek.querySelector('[data-tag-peek-list]')!.getAttribute('href')).toBe(tagHref('ini_release'));
  expect(peek.querySelector('[data-tag-peek-list]')!.textContent).toBe('Show threads');
  // Nothing of the Board: no column badges, no "Open on Board".
  expect(peek.querySelector('[data-tag-peek-columns], [data-tag-peek-open]')).toBeNull();
  expect(window.location.hash).toBe('#thread=msg_b');
  tap(link);
  expect(window.location.hash).toBe(tagHref('ini_release'));
});

test.skipIf(!hasDom)('preview, Board off: a tag only a linked machine holds previews its thread there', () => {
  window.location.hash = '#thread=msg_a';
  draw(<BoardOff value={hostOf(ROWS, [RELEASE, WINDOWS, DOCS], [])} />);
  tap(document.querySelector(`a[href="${tagHref('ini_mini_docs')}"]`)!);
  const peek = $('[data-tag-peek]')!;
  expect(peek.querySelector('[data-tag-peek-title]')!.textContent).toBe('Docs move');
  expect([...peek.querySelectorAll('[data-tag-peek-threads] a')].map((a) => a.getAttribute('href'))).toEqual(['#thread=msg_far']);
});
