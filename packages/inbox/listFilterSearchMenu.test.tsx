/**
 * The find fields of the list's filter menu, drawn (components/ListFilter.tsx, components/ListFilterSections.tsx,
 * listFilterSearch.ts): each long section (Agent, Tag, Project with more than eight rows) gets its own field and a
 * capped list that scrolls inside the menu; nothing sits at the menu's top.
 *
 * What this catches: a field on a section of eight rows, or anything at the menu's top; a long section with no field,
 * no scroll box, or the wrong words; a field taking focus on its own as the menu opens (a phone's keyboard would jump
 * up); typing that narrows another section, does not bold, or counts on every key; ticked rows not pinned above the
 * scroll, gone when they do not match, or a row ticked meanwhile jumping under the pointer; the nothing-matches line
 * missing or drawn in another section; ↓ from the field not reaching its first row, ↑ from that row not coming back, the
 * arrows stuck at the inner list's end instead of going on to the next section; letters, Space, Home or End taken from
 * the field by the menu's type-ahead or its row keys; the type-ahead gone from the plain rows; Escape closing before it
 * empties the field, or Escape on a row leaving the words; IME composition keys acting; the × without a name or leaving
 * focus nowhere; hover taking focus from the field, or a click on a row leaving focus on the row; a field appearing or
 * going while the menu is open; the menu's scroll not held as the rows run out.
 *
 * Scroll chaining at the inner list's ends, the phone's momentum and keyboard are browser checks:
 * tests/e2e/inbox-filter-section-fields.spec.ts.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxListRow } from '@plannotator/core/inbox-types';
import type { InboxInitiative } from '@plannotator/core/inbox-types';
import type { ListFilter } from './listFilter';
import type { ThreadTagsHost } from './threadTags';

const hasDom = typeof document !== 'undefined';
const { ListFilterButton } = (hasDom ? await import('./components/ListFilter') : {}) as typeof import('./components/ListFilter');
const { holdScroll } = (hasDom ? await import('./components/ListFilterSections') : {}) as typeof import('./components/ListFilterSections');
const { ThreadTagsContext } = await import('./threadTags');
const { NO_LIST_FILTER, resetListFilterForTests } = await import('./listFilter');
const { TITLE_FILTER_LABEL } = await import('./listTitleFilter');
const { resetScheduledForTests } = await import('./scheduled/store');
const { setStorageBackend, resetStorageBackend } = await import('@plannotator/ui/utils/storage');

const NOW = new Date(2026, 10, 5, 15, 0, 0);
const stored = new Map<string, string>();
let root: Root | null = null;
let host: HTMLElement | null = null;
/** The picks as the menu last set them. */
let picks: ListFilter = NO_LIST_FILTER;

beforeEach(() => {
  setSystemTime(NOW);
  stored.clear();
  setStorageBackend({ getItem: (k) => stored.get(k) ?? null, setItem: (k, v) => void stored.set(k, v), removeItem: (k) => void stored.delete(k) });
  resetListFilterForTests();
  resetScheduledForTests();
  picks = NO_LIST_FILTER;
});

afterEach(() => {
  setSystemTime();
  if (hasDom) act(() => root?.unmount());
  resetStorageBackend();
  resetListFilterForTests();
  resetScheduledForTests();
  if (!hasDom) return;
  host?.remove();
  document.body.innerHTML = '';
  root = null;
  host = null;
});

function row(id: string, project: string, agent = 'claude-code'): InboxListRow {
  const at = new Date(NOW.getTime() - 3_600_000).toISOString();
  return {
    thread_id: id,
    project: { id: `prj_${project}`, name: project },
    subject: `Thread ${id}`,
    thread_name: null,
    author: { kind: 'agent', host: agent, session: `s_${id}`, name: null },
    last_at: at,
    last_agent_at: at,
    last_author: 'agent',
    section: 'waiting',
    unread: true,
    unseen: 0,
    questions: { open: 0, picked: 0, stopped: false, holds_up: [] },
    sent: null,
    resolved_at: null,
  } as unknown as InboxListRow;
}

/** Ten projects: one more than a short section's most, so Project gets its field. */
const LONG = ['api', 'billing', 'docs', 'infra', 'ios', 'payments', 'rebill', 'search', 'web', 'worker'];
/** Nine tags: Tag gets its field too. */
const TAGS = ['billing-bugs', 'design', 'docs', 'mobile', 'ops', 'perf', 'release', 'stability', 'windows'];
const rowsOf = (projects: readonly string[], tagNames: readonly string[] = []) =>
  projects.map((p, i) => ({ ...row(`t${i}`, p), tags: tagNames.map((_, n) => `tag_${n}`) }) as InboxListRow);
const tagsOf = (names: readonly string[]) => names.map((name, i) => ({ id: `tag_${i}`, name, created_at: NOW.toISOString() }) as unknown as InboxInitiative);

/** Swaps the mounted harness's rows (a project arriving while the window is open). */
let swapRows: ((rows: readonly InboxListRow[]) => void) | null = null;

function Harness({ rows: first, start, tagNames, phone }: { rows: readonly InboxListRow[]; start: ListFilter; tagNames: readonly string[]; phone: boolean }) {
  const [filter, setFilter] = useState(start);
  const [rows, setRows] = useState(first);
  swapRows = setRows;
  const tags = tagsOf(tagNames);
  const host: ThreadTagsHost | null =
    tagNames.length === 0 ? null : { tags, tagsOf: () => [], counts: new Map(), can: () => true, set: () => {}, createAndSet: () => {}, listed: null, rows, rowTags: (r) => r.tags ?? [] };
  return (
    <ThreadTagsContext.Provider value={host}>
      <ListFilterButton
        phone={phone}
        source={{
          rows,
          scoped: false,
          names: new Map(),
          filter,
          onChange: (next) => {
            picks = next;
            setFilter(next);
          },
        }}
      />
    </ThreadTagsContext.Provider>
  );
}

function render(projects: readonly string[], start: ListFilter = NO_LIST_FILTER, tagNames: readonly string[] = [], phone = false, rows?: readonly InboxListRow[]) {
  picks = start;
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<Harness rows={rows ?? rowsOf(projects, tagNames)} start={start} tagNames={tagNames} phone={phone} />));
}

async function settle() {
  for (let i = 0; i < 6; i += 1) await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))));
}
async function wait(ms: number) {
  await act(async () => void (await new Promise((resolve) => setTimeout(resolve, ms))));
}
/** Base UI opens on the pointer's press, as a person's click does. */
async function press(target: HTMLElement) {
  await act(async () => {
    target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }));
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
    target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerType: 'mouse' }));
    target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
    target.click();
  });
  await settle();
}
/** A key on whatever has focus; returns whether the browser's own action went ahead (false: prevented). */
async function key(name: string): Promise<boolean> {
  let went = true;
  await act(async () => {
    const target = (document.activeElement as HTMLElement | null) ?? document.body;
    went = target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
  });
  await settle();
  return went;
}
/** A keyboard open: Enter on the focused funnel, whose click the browser then fires with no pointer. */
async function keyOpen() {
  await act(async () => {
    funnel().focus();
    funnel().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    funnel().click();
  });
  await settle();
}
/** A key pressed while an IME is composing (the browser's `isComposing`, keyCode 229). */
async function composingKey(name: string) {
  await act(async () => {
    const event = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, isComposing: true });
    Object.defineProperty(event, 'keyCode', { value: 229 });
    document.activeElement!.dispatchEvent(event);
  });
  await settle();
}
async function focusOn(el: HTMLElement) {
  await act(async () => el.focus());
  await settle();
}
async function type(section: string, text: string) {
  const input = field(section)!;
  await focusOn(input);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
}

const $ = (selector: string) => document.querySelector<HTMLElement>(selector);
const funnel = () => $('[data-list-filter]')!;
const menu = () => $('[data-list-filter-menu]');
const field = (section: string) => document.querySelector<HTMLInputElement>(`[data-list-filter-find="${section}"]`);
const fields = () => [...document.querySelectorAll<HTMLInputElement>('[data-list-filter-find]')];
const group = (section: string) => $(`[data-list-filter-long="${section}"]`)!;
const words = (el: Element | null) => [...(el?.querySelectorAll('.ib-pmi') ?? [])].map((n) => n.querySelector('.ib-pmi-l')!.textContent);
/** The rows drawn, in order, by their words. */
const rowWords = () => words(menu());
const pinned = (section: string) => words(group(section).querySelector('[data-list-filter-pins]'));
const scrolling = (section: string) => words(group(section).querySelector('[data-list-filter-scroll]'));
const groups = () => [...menu()!.querySelectorAll('.ib-pm-glabel')].map((n) => n.textContent);
const highlighted = () => menu()!.querySelector('.ib-pmi[data-highlighted]')?.querySelector('.ib-pmi-l')?.textContent ?? null;
const focusedRow = () => (document.activeElement as HTMLElement | null)?.querySelector?.('.ib-pmi-l')?.textContent ?? null;
const rowEl = (label: string) => [...menu()!.querySelectorAll<HTMLElement>('.ib-pmi')].find((n) => n.querySelector('.ib-pmi-l')!.textContent === label)!;
const status = () => $('[data-list-filter-find-status]')!.textContent;
/** The count is said once typing pauses (saidAfterPause.ts `STATUS_WAIT_MS`); wait that out. */
const pause = () => wait(450);
const PLAIN = [TITLE_FILTER_LABEL, 'Not seen', 'Recent activity', 'Today', 'Last 3 days', 'Last 7 days', 'Last 30 days', 'Custom range…'];

describe.skipIf(!hasDom)('short sections', () => {
  test('eight projects: no field, no scroll box, nothing at the top; the plain menu', async () => {
    render(LONG.slice(0, 8));
    await press(funnel());
    expect(fields().length).toBe(0);
    expect(menu()!.querySelector('[data-list-filter-scroll]')).toBeNull();
    expect(menu()!.hasAttribute('data-list-filter-fields')).toBe(false);
    expect(menu()!.getAttribute('role')).toBe('menu');
    expect(groups()).toEqual(['Updated', 'Project']);
    expect(rowWords()).toEqual([...PLAIN, ...LONG.slice(0, 8)]);
  });

  test('Escape closes it and puts focus back on the funnel; aria-expanded follows the menu', async () => {
    render(['api', 'web']);
    expect(funnel().getAttribute('aria-expanded')).toBe('false');
    await press(funnel());
    expect(funnel().getAttribute('aria-expanded')).toBe('true');
    await key('Escape');
    expect(menu()).toBeNull();
    expect(funnel().getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement === funnel()).toBe(true);
  });

  test("a letter jumps to the first row it starts (the menu's type-ahead)", async () => {
    render(['api', 'web']);
    await press(funnel());
    await key('w');
    expect(highlighted()).toBe('web');
  });
});

describe.skipIf(!hasDom)('a long section', () => {
  test('nine projects: Project gets its own field under its heading and a scrolling list; nothing at the top; a short Tag list stays plain', async () => {
    render(LONG.slice(0, 9), NO_LIST_FILTER, ['ops', 'release']);
    await press(funnel());
    expect(fields().map((f) => f.getAttribute('data-list-filter-find'))).toEqual(['projects']);
    const input = field('projects')!;
    expect(input.placeholder).toBe('Find a project');
    expect(input.getAttribute('aria-label')).toBe('Find a project');
    // Under the heading, inside the section's group.
    const g = group('projects');
    expect(g.querySelector('.ib-pm-glabel')!.textContent).toBe('Project');
    expect(g.querySelector('.ib-pm-glabel')!.nextElementSibling!.contains(input)).toBe(true);
    expect(scrolling('projects')).toEqual(LONG.slice(0, 9));
    expect(input.getAttribute('aria-controls')).toBe(g.querySelector('[data-list-filter-scroll]')!.id);
    // Nothing above the first row but the sheet's hidden title.
    expect(menu()!.querySelector('.ib-pmi')!.hasAttribute('data-list-filter-title')).toBe(true);
    expect(menu()!.querySelector('input') === input).toBe(true);
    expect($('[data-list-filter-group="tags"] [data-list-filter-find]')).toBeNull();
    // A click open leaves focus in the menu, not in a field.
    expect(document.activeElement === input).toBe(false);
  });

  test('Tag, Project and Agent each get theirs when long; each has its own words', async () => {
    const hosts = ['claude-code', 'codex', 'opencode', 'pi', 'gemini', 'amp', 'goose', 'aider', 'cline'];
    const rows = rowsOf(LONG, TAGS).map((r, i) => ({ ...r, author: { ...r.author, host: hosts[i % hosts.length]! } }) as InboxListRow);
    render(LONG, NO_LIST_FILTER, TAGS, false, rows);
    await press(funnel());
    expect(fields().map((f) => [f.getAttribute('data-list-filter-find'), f.placeholder])).toEqual([
      ['agents', 'Find an agent'],
      ['tags', 'Find a tag'],
      ['projects', 'Find a project'],
    ]);
  });

  test('typing narrows only its own section and bolds the match; the count is said once typing pauses', async () => {
    render(LONG, NO_LIST_FILTER, TAGS);
    await press(funnel());
    await type('projects', 'bil');
    expect(scrolling('projects')).toEqual(['billing', 'rebill']);
    expect([...group('projects').querySelectorAll('.ib-lflt-hit')].map((n) => n.textContent)).toEqual(['bil', 'bil']);
    // The Tag section, "billing-bugs" in it, is as it was.
    expect(scrolling('tags')).toEqual(TAGS);
    expect(group('tags').querySelector('.ib-lflt-hit')).toBeNull();
    expect(rowWords().slice(0, PLAIN.length)).toEqual(PLAIN);
    expect(status()).toBe('');
    await pause();
    expect(status()).toBe('2 matches');
    expect(document.activeElement === field('projects')).toBe(true);
  });

  test('ticked rows sit pinned above the scroll whatever is typed; a row ticked meanwhile stays put until the words change', async () => {
    render(LONG, { ...NO_LIST_FILTER, projects: ['prj_web'] });
    await press(funnel());
    expect(pinned('projects')).toEqual(['web']);
    expect(scrolling('projects')).toEqual(LONG.filter((p) => p !== 'web'));
    await type('projects', 'bil');
    expect(pinned('projects')).toEqual(['web']);
    expect(scrolling('projects')).toEqual(['billing', 'rebill']);
    await press(rowEl('rebill'));
    expect(picks.projects).toEqual(['prj_web', 'prj_rebill']);
    // Ticked under the pointer, it stays where it was.
    expect(scrolling('projects')).toEqual(['billing', 'rebill']);
    await type('projects', 'bill');
    // Pinned in the list's own order.
    expect(pinned('projects')).toEqual(['rebill', 'web']);
    expect(scrolling('projects')).toEqual(['billing']);
  });

  test('nothing matches: a line in that section only, its pinned rows kept, and it is said', async () => {
    render(LONG, { ...NO_LIST_FILTER, projects: ['prj_web'] }, TAGS);
    await press(funnel());
    await type('projects', 'zzz');
    const none = group('projects').querySelector('[data-list-filter-none]')!;
    expect(none.textContent).toBe('No projects match “zzz”');
    expect(document.querySelectorAll('[data-list-filter-none]')).toHaveLength(1);
    expect(pinned('projects')).toEqual(['web']);
    expect(scrolling('projects')).toEqual([]);
    expect(scrolling('tags')).toEqual(TAGS);
    await pause();
    expect(status()).toBe('No projects match “zzz”');
    await type('tags', 'qq');
    expect(group('tags').querySelector('[data-list-filter-none]')!.textContent).toBe('No tags match “qq”');
  });

  test('the × has a name, empties the field and leaves focus in it', async () => {
    render(LONG);
    await press(funnel());
    await type('projects', 'bil');
    const clear = group('projects').querySelector<HTMLElement>('[data-list-filter-find-clear]')!;
    expect(clear.getAttribute('aria-label')).toBe('Clear search');
    await press(clear);
    expect(field('projects')!.value).toBe('');
    expect(scrolling('projects')).toEqual(LONG);
    expect(group('projects').querySelector('[data-list-filter-find-clear]')).toBeNull();
    expect(document.activeElement === field('projects')).toBe(true);
  });

  test('a long name: a match past the cut drops the start ("…") so the bold shows; the row keeps its full name', async () => {
    const NAME = `reports-and-exports-for-the-${'x'.repeat(40)}-quarterly-review`;
    render([...LONG, NAME]);
    await press(funnel());
    await type('projects', 'quarterly');
    const item = menu()!.querySelector<HTMLElement>(`[data-list-filter-project="prj_${NAME}"]`)!;
    expect(item.querySelector('.ib-pmi-l')!.textContent!.startsWith('…')).toBe(true);
    expect(item.querySelector('.ib-lflt-hit')!.textContent).toBe('quarterly');
    expect(item.getAttribute('aria-label')).toBe(`${NAME} 1`);
  });

  test('200 tags: only Tag gets a field; typing finds the few, a ticked one pinned above them', async () => {
    const many = Array.from({ length: 200 }, (_, i) => `tag-${String(i).padStart(3, '0')}`);
    many[17] = 'Billing ✨';
    many[150] = 'rebilled';
    render(['api', 'web'], { ...NO_LIST_FILTER, tags: ['tag_3'] }, many);
    await press(funnel());
    expect(fields().map((f) => f.getAttribute('data-list-filter-find'))).toEqual(['tags']);
    await type('tags', 'BIL');
    expect(pinned('tags')).toEqual(['tag-003']);
    expect(scrolling('tags')).toEqual(['Billing ✨', 'rebilled']);
    await pause();
    expect(status()).toBe('2 matches');
  });
});

describe.skipIf(!hasDom)('keys', () => {
  test('↓ from the field goes to its first row (a pinned one first), ↑ from that row back to the field', async () => {
    render(LONG, { ...NO_LIST_FILTER, projects: ['prj_web'] });
    await press(funnel());
    await focusOn(field('projects')!);
    expect(await key('ArrowDown')).toBe(false);
    expect(focusedRow()).toBe('web');
    expect(highlighted()).toBe('web');
    await key('ArrowDown');
    expect(focusedRow()).toBe('api');
    await key('ArrowUp');
    expect(focusedRow()).toBe('web');
    await key('ArrowUp');
    expect(document.activeElement === field('projects')).toBe(true);
  });

  test('the arrows go on past the inner list\'s ends to the next section, through its field', async () => {
    render(LONG, NO_LIST_FILTER, TAGS);
    await press(funnel());
    await focusOn(field('projects')!);
    // ↑ from Project's field: the last tag row, at the end of Tag's own scroll.
    await key('ArrowUp');
    expect(focusedRow()).toBe('windows');
    // ↓ from there: on to Project's field, then its first row.
    await key('ArrowDown');
    expect(document.activeElement === field('projects')).toBe(true);
    await key('ArrowDown');
    expect(focusedRow()).toBe('api');
    // ↑ from the first tag row back to Tag's field, ↑ again to the row above the section.
    await focusOn(rowEl('billing-bugs'));
    await key('ArrowUp');
    expect(document.activeElement === field('tags')).toBe(true);
    await key('ArrowUp');
    expect(focusedRow()).toBe('Custom range…');
  });

  test('↓ from a field whose rows all went goes on to what follows', async () => {
    render(LONG, NO_LIST_FILTER, TAGS);
    await press(funnel());
    await type('tags', 'zzz');
    await key('ArrowDown');
    expect(document.activeElement === field('projects')).toBe(true);
  });

  test("in the field, letters, Space, Home and End are the field's: no type-ahead, no tick, no row moved to", async () => {
    render(LONG);
    await press(funnel());
    await type('projects', 'bil');
    for (const name of ['r', ' ', 'Home', 'End', 'Enter']) {
      expect(await key(name)).toBe(true);
      expect(document.activeElement === field('projects')).toBe(true);
    }
    expect(picks).toEqual(NO_LIST_FILTER);
    expect(menu()).not.toBeNull();
  });

  test('on a long menu the plain rows keep the type-ahead', async () => {
    render(LONG);
    await keyOpen();
    await key('r');
    expect(highlighted()).toBe('Recent activity');
  });

  test('Escape empties the field first, then closes and puts focus back on the funnel', async () => {
    render(LONG);
    await press(funnel());
    await type('projects', 'bil');
    expect(await key('Escape')).toBe(false);
    expect(menu()).not.toBeNull();
    expect(field('projects')!.value).toBe('');
    expect(scrolling('projects')).toEqual(LONG);
    await key('Escape');
    expect(menu()).toBeNull();
    expect(funnel().getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement === funnel()).toBe(true);
  });

  test('Escape on a row of a section with words typed empties them and goes back to its field', async () => {
    render(LONG);
    await press(funnel());
    await type('projects', 'bil');
    await key('ArrowDown');
    expect(focusedRow()).toBe('billing');
    await key('Escape');
    expect(menu()).not.toBeNull();
    expect(field('projects')!.value).toBe('');
    expect(document.activeElement === field('projects')).toBe(true);
  });

  test('during IME composition Enter, Escape and the arrows are the IME\'s: nothing ticks, empties, moves or closes', async () => {
    render(LONG);
    await press(funnel());
    await type('projects', 'bil');
    for (const name of ['Enter', 'Escape', 'ArrowDown']) await composingKey(name);
    expect(menu()).not.toBeNull();
    expect(field('projects')!.value).toBe('bil');
    expect(document.activeElement === field('projects')).toBe(true);
    expect(picks).toEqual(NO_LIST_FILTER);
  });

  test('Tab is left to the browser; focus leaving for the page closes the menu', async () => {
    render(LONG);
    const after = document.createElement('button');
    document.body.append(after);
    await press(funnel());
    await type('projects', 'bil');
    expect(await key('Tab')).toBe(true);
    await act(async () => {
      field('projects')!.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: after }));
      after.focus();
    });
    await settle();
    expect(menu()).toBeNull();
    after.remove();
  });
});

describe.skipIf(!hasDom)('the pointer while a field has focus', () => {
  test('hovering a row leaves focus in the field', async () => {
    render(LONG);
    await press(funnel());
    await type('projects', 'bil');
    // A real move (Base UI ignores a WebKit move of 0 px, which a list scrolling under a still pointer sends).
    const move = new MouseEvent('mousemove', { bubbles: true });
    Object.defineProperty(move, 'movementX', { value: 3 });
    Object.defineProperty(move, 'movementY', { value: 3 });
    await act(async () => void rowEl('rebill').dispatchEvent(move));
    await settle();    expect(document.activeElement === field('projects')).toBe(true);
  });

  test('a click on one of its rows ticks it and gives focus back to the field, so typing goes on', async () => {
    render(LONG);
    await press(funnel());
    await type('projects', 'bil');
    await press(rowEl('rebill'));
    await wait(40);
    expect(picks.projects).toEqual(['prj_rebill']);
    expect(document.activeElement === field('projects')).toBe(true);
  });
});

describe.skipIf(!hasDom)('the same mounted menu', () => {
  test('a ninth project arriving while the menu is shut brings the field on the next open; back to eight takes it away', async () => {
    render(LONG.slice(0, 8));
    await press(funnel());
    expect(fields().length).toBe(0);
    await key('Escape');
    await act(async () => swapRows!(rowsOf(LONG.slice(0, 9))));
    await press(funnel());
    expect(field('projects')).not.toBeNull();
    await key('Escape');
    expect(document.activeElement === funnel()).toBe(true);
    await act(async () => swapRows!(rowsOf(LONG.slice(0, 8))));
    await press(funnel());
    expect(fields().length).toBe(0);
  });

  test('no field comes or goes while the menu is open, even when a row arrives', async () => {
    render(LONG.slice(0, 8));
    await press(funnel());
    await act(async () => swapRows!(rowsOf(LONG.slice(0, 9))));
    await settle();
    expect(fields().length).toBe(0);
    expect(rowWords()).toContain('search');
  });

  test('the words start empty on each open', async () => {
    render(LONG);
    await press(funnel());
    await type('projects', 'bil');
    await focusOn(rowEl('billing'));
    await key('Escape');
    await key('Escape');
    expect(menu()).toBeNull();
    await press(funnel());
    expect(field('projects')!.value).toBe('');
  });
});

describe.skipIf(!hasDom)('the scroll held as rows run out', () => {
  /** A menu 600 px tall (610 with its border) over `content` px, scrolled to `at`. */
  function box(content: number, at: number) {
    const menuEl = document.createElement('div');
    Object.defineProperty(menuEl, 'scrollHeight', { get: () => content, configurable: true });
    Object.defineProperty(menuEl, 'clientHeight', { get: () => (menuEl.style.maxHeight ? parseFloat(menuEl.style.maxHeight) - 10 : 600) });
    Object.defineProperty(menuEl, 'offsetHeight', { get: () => (menuEl.style.maxHeight ? parseFloat(menuEl.style.maxHeight) : 610) });
    let top = at;
    Object.defineProperty(menuEl, 'scrollTop', { get: () => top, set: (v: number) => (top = v) });
    return menuEl;
  }

  test('a desktop menu grows shorter from its foot instead of pulling the scroll back; it grows again when rows return', () => {
    const menuEl = box(900, 0);
    holdScroll(menuEl, 500, null);
    expect(menuEl.style.maxHeight).toBe('410px');
    expect(menuEl.scrollTop).toBe(500);
    // Enough rows again: the menu's own height.
    Object.defineProperty(menuEl, 'scrollHeight', { get: () => 2000 });
    holdScroll(menuEl, 500, null);
    expect(menuEl.style.maxHeight).toBe('');
  });

  test("a phone's sheet keeps its height: a spacer at its foot takes the rows' place", () => {
    const menuEl = box(900, 0);
    const spacer = document.createElement('div');
    holdScroll(menuEl, 500, spacer);
    expect(spacer.style.height).toBe('200px');
    expect(menuEl.style.maxHeight).toBe('');
    expect(menuEl.scrollTop).toBe(500);
  });
});
