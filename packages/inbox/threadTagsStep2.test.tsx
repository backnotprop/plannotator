/**
 * Thread tags, step 2 (approval "inbox-thread-tags"), drawn with a tags host in place of App:
 * - the thread header's tag line: nothing for a thread in no tag; `#` once and the names as links to their lists;
 *   `+` opens Add tag's tick list (no Back row) and a tick puts the thread in or takes it out; no `+` where Add tag is
 *   not offered; a linked machine's thread shows and writes its tags by the window's rule, an older machine's none;
 * - the list's Filter: a Tag group, each name with the `#` mark, once a tag holds a listed thread (none for a person
 *   with no tags, none on a tag's own list), several tags widening, combined with the other groups, the badge counting;
 * - Search: tags are never results (the owner: "It can be a filter but nothing more"): with tags the results for
 *   `#rel` and `rel` are what they are without; the Tag chip after From offers the tags this Inbox's threads carry (not
 *   one only an older linked machine holds), picks several (each machine's id of each, sent as `tag`), reads "Tagged Release or Windows",
 *   narrows with the other chips, and is absent with no tags;
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
const { ThreadTagsContext, canTagThread, rowTagsHere, tagHref, tagsOnOwnRows, tagWrite, threadTagsHere } = await import('./threadTags');
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
    here: tagsOnOwnRows(tags, rows, 'self', rowTags),
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

test.skipIf(!hasDom)('header: `+` by keyboard puts focus in the field; it keeps it when typing moves the row under a resting mouse (#3393), so Enter makes the tag', async () => {
  const writes: string[] = [];
  line('msg_b', ROWS, writes);
  const add = $('[data-thread-tags-add]')!;
  add.focus();
  // Enter opens it as a click does: focus in the field, not on the first tag (letters would go to the menu's type-ahead).
  await act(async () => void add.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
  await settle();
  const menu = () => $('[data-thread-tags-menu]');
  const field = menu()!.querySelector<HTMLInputElement>('[data-tag-find]')!;
  const focusIs = () => [document.activeElement === field, document.activeElement?.tagName, document.activeElement?.getAttribute('role')];
  expect(focusIs()).toEqual([true, 'INPUT', null]);
  const typeIt = (value: string) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value);
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
  // The first letter adds a line above New tag "B" and moves it; a pointer resting there reads as leaving it for the
  // line, and the menu focuses its popup. The field takes focus back.
  await typeIt('B');
  const item = menu()!.querySelector('[data-tag-new]')!;
  const above = item.previousElementSibling!;
  await act(async () => {
    item.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, pointerType: 'mouse', relatedTarget: above }));
    above.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse', relatedTarget: item }));
  });
  expect(focusIs()).toEqual([true, 'INPUT', null]);
  await typeIt('Billing');
  await act(async () => void field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
  expect(writes).toEqual(['create Billing msg_b']);
});

test.skipIf(!hasDom)("header: an archived thread (not in the list) shows its tags from its own read's row", () => {
  const archived = row('msg_arc', 'web', 9, 'quiet', ['ini_windows']);
  const value = hostOf(ROWS, [RELEASE, WINDOWS, DOCS], []);
  // App's rule (useThreadTagsHost): the listed row, else the open thread's own read's row.
  draw(
    <ThreadTagsContext.Provider value={{ ...value, tagsOf: (id) => threadTagsHere(id, ROWS, archived, MACHINES, new Map()) }}>
      <ThreadTagLine threadId="msg_arc" phone={false} />
    </ThreadTagsContext.Provider>,
  );
  expect(texts('[data-thread-tag]')).toEqual(['Windows']);
  expect(threadTagsHere('msg_b', ROWS, archived, MACHINES, new Map())).toEqual(['ini_release', 'ini_windows']);
  expect(threadTagsHere('msg_gone', ROWS, archived, MACHINES, new Map())).toEqual([]);
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

test.skipIf(!hasDom)('filter: a Tag group, each name with the `#` mark and a count; several tags widen, another group narrows, the badge counts each', async () => {
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
  // Each name has the `#` in the icon column, as Agent and Project rows have their marks.
  for (const item of group.querySelectorAll('[data-list-filter-tag]')) expect(item.firstElementChild!.matches('svg.ib-ic')).toBe(true);
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

const PROJECT = { id: 'prj_web', name: 'web' };
/** The server's answer: a thread and a message for any words, so a result list is drawn. */
function answerFor(q: string) {
  const at = '2026-11-05T13:00:00Z';
  return {
    serverSession: 's',
    q,
    terms: q ? q.replace('#', '').split(/\s+/) : [],
    took_ms: 1,
    indexing: false,
    threads: 6,
    totals: q ? { threads: 1, messages: 1, files: 0, projects: 0 } : null,
    groups: q
      ? {
          threads: [{ type: 'thread', id: 'msg_b', thread_id: 'msg_b', project: PROJECT, section: 'new', archived: false, at, title: 'Release notes', title_marks: [], thread_name: null }],
          messages: [{ type: 'message', id: 'msg_b2', thread_id: 'msg_b', project: PROJECT, section: 'new', archived: false, at, author: { kind: 'agent', name: 'Claude Code' }, title: 'Release notes', snippet: { text: 'the #release checklist', marks: [[4, 8]] }, question: null }],
        }
      : null,
    recent: q ? null : [],
    recent_searches: [],
  };
}

const asked: URLSearchParams[] = [];
function palette(value: ThreadTagsHost | null) {
  asked.length = 0;
  savedFetch ??= globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const params = new URL(String(input), 'http://127.0.0.1:1').searchParams;
    asked.push(params);
    return new Response(JSON.stringify(answerFor(params.get('q') ?? '')), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  const node = <SearchPalette open phone={false} currentProject={null} projects={[{ id: 'prj_web', name: 'web', root: '/code/web' }] as never} onClose={() => {}} onOpenResult={() => {}} />;
  draw(value ? <ThreadTagsContext.Provider value={value}>{node}</ThreadTagsContext.Provider> : node);
}
async function typeIn(value: string) {
  await act(async () => {
    const el = $('[role="combobox"]') as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  for (let i = 0; i < 40 && !document.querySelector('[data-result]'); i += 1) await act(async () => void (await new Promise((r) => setTimeout(r, 20))));
  await settle();
}
/** What the results draw: every group's heading and rows, as text. */
const resultsText = () => [...document.querySelectorAll('[data-search-group]')].map((g) => g.textContent);
const chips = () => [...document.querySelectorAll('[data-chip]')].map((c) => c.getAttribute('data-chip'));
const lastAsked = () => asked[asked.length - 1]!;

test.skipIf(!hasDom)('search: tags are never results: `#rel` and `rel` draw the same results with tags as without, and ask the same', async () => {
  const drawn: Record<string, string[]> = {};
  const sent: Record<string, string> = {};
  for (const withTags of [false, true]) {
    for (const words of ['#rel', 'rel', 'move']) {
      palette(withTags ? hostOf(ROWS, [RELEASE, WINDOWS, DOCS], []) : null);
      await typeIn(words);
      drawn[`${withTags}:${words}`] = resultsText();
      sent[`${withTags}:${words}`] = lastAsked().toString();
      act(() => root!.unmount());
      document.body.innerHTML = '';
    }
  }
  for (const words of ['#rel', 'rel', 'move']) {
    expect(drawn[`true:${words}`]).toEqual(drawn[`false:${words}`]);
    expect(sent[`true:${words}`]).toEqual(sent[`false:${words}`]);
  }
  // Nothing of a tag is drawn as a result: no Tags group, no "Threads tagged".
  expect(drawn['true:#rel']!.join(' ')).not.toContain('Threads tagged');
  expect(drawn['true:#rel']).toHaveLength(2);
});

test.skipIf(!hasDom)('search: the Tag chip after From offers this Inbox\'s tags, picks several (the menu stays open), sends each machine\'s id of each, narrows with the other chips; none with no tags', async () => {
  palette(hostOf(ROWS, [RELEASE, WINDOWS, DOCS], []));
  await typeIn('notes');
  expect(chips()).toEqual(['type', 'project', 'status', 'from', 'tag']);
  const chip = () => $('[data-chip="tag"]')!;
  expect(chip().textContent).toBe('Any tag');
  await click(chip());
  const menu = () => $('.ib-sp-menu[aria-label="Tag"]')!;
  expect([...menu().querySelectorAll('.ib-sp-mi')].map((n) => [n.textContent, n.getAttribute('role'), n.getAttribute('aria-checked')])).toEqual([
    ['Any tag', 'menuitemradio', 'true'],
    ['Release', 'menuitemcheckbox', 'false'],
    ['Windows', 'menuitemcheckbox', 'false'],
  ]);
  // "Docs move" is only on the Mac mini's threads, and this mini's search does not say it takes the filter: not offered.
  await click(menu().querySelectorAll('.ib-sp-mi')[1]!);
  await settle();
  expect(menu()).not.toBeNull();
  // Release is held here and on the Mac mini: each machine's id goes, once, so each filters by its own.
  expect(lastAsked().getAll('tag')).toEqual(['ini_release', 'ini_mini_release']);
  await click(menu().querySelectorAll('.ib-sp-mi')[2]!);
  await settle();
  expect(lastAsked().getAll('tag')).toEqual(['ini_release', 'ini_mini_release', 'ini_windows']);
  expect(chip().textContent).toBe('Tagged Release or Windows');
  expect(menu().querySelectorAll('[aria-checked="true"]')).toHaveLength(2);
  // Unticking takes it out.
  await click(menu().querySelectorAll('.ib-sp-mi')[1]!);
  await settle();
  expect(lastAsked().getAll('tag')).toEqual(['ini_windows']);
  expect(chip().textContent).toBe('Tagged Windows');
  // With another chip: both are sent ("and").
  await click($('[data-chip="from"]')!);
  await click([...document.querySelectorAll('.ib-sp-menu .ib-sp-mi')].find((n) => n.textContent === 'Me')!);
  await settle();
  expect([lastAsked().get('from'), lastAsked().getAll('tag')]).toEqual(['me', ['ini_windows']]);
  // Its × clears the tags alone.
  await click($('[data-unset="tag"]')!);
  await settle();
  expect([lastAsked().get('from'), lastAsked().getAll('tag')]).toEqual(['me', []]);
  expect(chip().textContent).toBe('Any tag');
  act(() => root!.unmount());
  document.body.innerHTML = '';
  palette(hostOf(ROWS, [], []));
  expect(chips()).toEqual(['type', 'project', 'status', 'from']);
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
