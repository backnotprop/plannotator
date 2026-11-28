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
 * going while the menu is open; the menu's scroll not held as the rows run out; with forty ticked rows, the row Enter
 * acts on left out of view, or a held Enter flipping it on and off; the phone's viewport listener left behind when the
 * sheet closes with the field focused.
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
const { holdScroll, bringUp, showFirstMatch } = (hasDom ? await import('./components/ListFilterSections') : {}) as typeof import('./components/ListFilterSections');
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
/** The section's rows under its ticked ones, inside its capped scroll. */
const scrolling = (section: string) => words(group(section).querySelector('[data-list-filter-rows]'));
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
    // A search field to a screen reader, not a plain text box among menu rows.
    expect(input.getAttribute('role')).toBe('searchbox');
    // Nothing above the first row but the sheet's hidden title.
    expect(menu()!.querySelector('.ib-pmi')!.hasAttribute('data-list-filter-title')).toBe(true);
    expect(menu()!.querySelector('input') === input).toBe(true);
    expect($('[data-list-filter-group="tags"] [data-list-filter-find]')).toBeNull();
    // A click open leaves focus in the menu, not in a field, once Base UI's opening focus has landed (a frame on;
    // happy-dom finds no field to focus, so the browser check is tests/e2e/inbox-filter-section-fields.spec.ts).
    await wait(60);
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

  test('forty ticked tags stay inside the capped scroll, so the section never grows past its cap', async () => {
    const many = Array.from({ length: 60 }, (_, i) => `tag-${String(i).padStart(2, '0')}`);
    const ticked = many.slice(0, 40).map((_, i) => `tag_${i}`);
    render(['api', 'web'], { ...NO_LIST_FILTER, tags: ticked }, many);
    await press(funnel());
    const scroll = group('tags').querySelector('[data-list-filter-scroll]')!;
    const pins = group('tags').querySelector('[data-list-filter-pins]')!;
    expect(pinned('tags')).toEqual(many.slice(0, 40));
    // Every row of the section, ticked ones first, is inside the one capped scroll; nothing of it outside.
    expect(scroll.contains(pins)).toBe(true);
    expect(words(scroll)).toEqual(many);
    expect(words(group('tags'))).toEqual(many);
    expect(scroll.firstElementChild === pins).toBe(true);
  });

  test('forty ticked tags and words typed: the row Enter acts on is the one marked to be kept in view', async () => {
    const many = Array.from({ length: 60 }, (_, i) => `tag-${String(i).padStart(2, '0')}`);
    render(['api', 'web'], { ...NO_LIST_FILTER, tags: many.slice(0, 40).map((_, i) => `tag_${i}`) }, many);
    await press(funnel());
    const marked = () => [...group('tags').querySelectorAll('[data-list-filter-first]')].map((n) => n.querySelector('.ib-pmi-l')!.textContent);
    expect(marked()).toEqual([]);
    // Below all forty ticked rows: the first match that is not ticked.
    await type('tags', 'tag-5');
    expect(pinned('tags')).toHaveLength(40);
    expect(marked()).toEqual(['tag-50']);
    await key('Enter');
    expect(picks.tags).toContain('tag_50');
    // A ticked row that matches comes first, and is the one marked.
    await type('tags', 'tag-07');
    expect(marked()).toEqual(['tag-07']);
    await key('Enter');
    expect(picks.tags).not.toContain('tag_7');
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
    for (const name of ['r', ' ', 'Home', 'End']) {
      expect(await key(name)).toBe(true);
      expect(document.activeElement === field('projects')).toBe(true);
    }
    expect(picks).toEqual(NO_LIST_FILTER);
    expect(menu()).not.toBeNull();
  });

  test('Enter in a field ticks or unticks its first match; focus and the words stay', async () => {
    render(LONG);
    await press(funnel());
    await type('projects', 'bil');
    expect(await key('Enter')).toBe(false);
    expect(picks.projects).toEqual(['prj_billing']);
    expect(field('projects')!.value).toBe('bil');
    expect(document.activeElement === field('projects')).toBe(true);
    expect(menu()).not.toBeNull();
    // Ticked here, it stays where it was: Enter again unticks it.
    await key('Enter');
    expect(picks.projects).toEqual([]);
    expect(document.activeElement === field('projects')).toBe(true);
  });

  test('a held Enter acts once: its repeats do not flip the row back and forth', async () => {
    render(LONG);
    await press(funnel());
    await type('projects', 'bil');
    await key('Enter');
    expect(picks.projects).toEqual(['prj_billing']);
    for (let i = 0; i < 3; i += 1) {
      await act(async () => {
        document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', repeat: true, bubbles: true, cancelable: true }));
      });
      await settle();
    }
    expect(picks.projects).toEqual(['prj_billing']);
    expect(document.activeElement === field('projects')).toBe(true);
  });

  test('Enter: a matching ticked row is the first match; with no words or no match it does nothing', async () => {
    render(LONG, { ...NO_LIST_FILTER, projects: ['prj_rebill'] });
    await press(funnel());
    await focusOn(field('projects')!);
    await key('Enter');
    expect(picks.projects).toEqual(['prj_rebill']);
    await type('projects', 'zzz');
    await key('Enter');
    expect(picks.projects).toEqual(['prj_rebill']);
    await type('projects', 'bil');
    await key('Enter');
    expect(picks.projects).toEqual([]);
    expect(menu()).not.toBeNull();
  });

  test('opened from the keyboard (↓ or Enter on the funnel), focus is on the first row, not the menu or a field', async () => {
    for (const name of ['ArrowDown', 'Enter']) {
      render(LONG, NO_LIST_FILTER, TAGS);
      await act(async () => {
        funnel().focus();
        funnel().dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
        if (name === 'Enter') funnel().click();
      });
      await settle();
      // Base UI's opening focus lands a frame on.
      await wait(60);
      expect(menu()).not.toBeNull();
      expect(document.activeElement === menu()!.querySelector('.ib-pmi')).toBe(true);
      await key('Escape');
      act(() => root!.unmount());
      root = null;
      host!.remove();
    }
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

describe.skipIf(!hasDom)('the first match kept in view as the words change', () => {
  /** A list 247 px tall (seven rows and a half) of 33 px rows, the separator 8 px more after `pins` of them. */
  function list(count: number, pins: number, target: number) {
    const el = document.createElement('div');
    let top = 0;
    Object.defineProperty(el, 'scrollTop', { get: () => top, set: (v: number) => (top = v) });
    Object.defineProperty(el, 'clientHeight', { get: () => 247 });
    el.getBoundingClientRect = () => ({ top: 100, height: 247 }) as DOMRect;
    const rows: HTMLElement[] = [];
    for (let i = 0; i < count; i += 1) {
      const r = document.createElement('div');
      r.className = 'ib-pmi';
      if (i === target) r.setAttribute('data-list-filter-first', '');
      const at = i * 33 + (i >= pins && pins > 0 ? 8 : 0);
      r.getBoundingClientRect = () => ({ top: 100 + at - top, height: 32 }) as DOMRect;
      el.append(r);
      rows.push(r);
    }
    const shown = (i: number) => {
      const at = rows[i]!.getBoundingClientRect().top - 100;
      return at >= 0 && at + 32 <= 247;
    };
    return { el, shown, scroll: () => top, setScroll: (v: number) => (top = v) };
  }

  test('forty ticked rows above it: the first match below the cut comes into full view, half the row above it showing', () => {
    const l = list(60, 40, 40);
    expect(l.shown(40)).toBe(false);
    showFirstMatch(l.el);
    expect(l.shown(40)).toBe(true);
    // The last ticked row's lower half shows above the separator and the match.
    expect(l.scroll()).toBe(39 * 33 + 16);
  });

  test('already in full view: the list does not move; above the view (scrolled past it) it comes back', () => {
    const l = list(60, 4, 4);
    showFirstMatch(l.el);
    expect(l.scroll()).toBe(0);
    l.setScroll(600);
    showFirstMatch(l.el);
    expect(l.shown(4)).toBe(true);
    const first = list(20, 0, 0);
    first.setScroll(300);
    showFirstMatch(first.el);
    expect(first.scroll()).toBe(0);
  });
});

describe.skipIf(!hasDom)("a phone's field brought to the sheet's top", () => {
  /** A sheet whose section sits 200 px below its top at scroll 0, a field in it, and a visual viewport 800 px tall. */
  function sheet() {
    const menuEl = document.createElement('div');
    menuEl.setAttribute('data-list-filter-menu', '');
    const groupEl = document.createElement('div');
    groupEl.setAttribute('data-list-filter-long', 'projects');
    const box = document.createElement('div');
    box.setAttribute('data-list-filter-find-box', '');
    const input = document.createElement('input');
    const row = document.createElement('div');
    box.append(input);
    groupEl.append(box, row);
    menuEl.append(groupEl);
    document.body.append(menuEl);
    let top = 0;
    Object.defineProperty(menuEl, 'scrollTop', { get: () => top, set: (v: number) => (top = v), configurable: true });
    menuEl.getBoundingClientRect = () => ({ top: 100 }) as DOMRect;
    groupEl.getBoundingClientRect = () => ({ top: 300 - top }) as DOMRect;
    const viewport = Object.assign(new EventTarget(), { height: 800 });
    const resize = async (height: number) => {
      viewport.height = height;
      viewport.dispatchEvent(new Event('resize'));
      await wait(200);
    };
    return { menuEl, input, row, viewport, resize, scroll: () => top, scrollTo: (v: number) => (top = v), done: () => menuEl.remove() };
  }

  test('on focus, and as the keyboard rises (in steps too), the section comes to the top; again on the next rise', async () => {
    const s = sheet();
    bringUp(s.input, s.viewport);
    expect(s.scroll()).toBe(200);
    s.scrollTo(0);
    await act(async () => {
      for (const height of [700, 600, 450]) {
        s.viewport.height = height;
        s.viewport.dispatchEvent(new Event('resize'));
      }
    });
    await wait(200);
    expect(s.scroll()).toBe(200);
    // Down, then up again: lifted again.
    await s.resize(800);
    s.scrollTo(0);
    await s.resize(450);
    expect(s.scroll()).toBe(200);
    s.done();
  });

  test('a suggestion bar coming or going is not the keyboard: the sheet stays where it is', async () => {
    const s = sheet();
    bringUp(s.input, s.viewport);
    await s.resize(450);
    s.scrollTo(260);
    await s.resize(410);
    expect(s.scroll()).toBe(260);
    await s.resize(450);
    expect(s.scroll()).toBe(260);
    s.done();
  });

  test('once the person scrolls the sheet it is theirs: the keyboard rising does not snap it back', async () => {
    const s = sheet();
    bringUp(s.input, s.viewport);
    s.row.dispatchEvent(new Event('touchstart', { bubbles: true }));
    s.scrollTo(320);
    await s.resize(450);
    expect(s.scroll()).toBe(320);
    s.done();
  });

  test('the sheet closing with the field focused lets go of the viewport, though no blur comes (WebKit)', async () => {
    const listening = new Set<unknown>();
    const fake = { height: 800, addEventListener: (_: string, fn: unknown) => void listening.add(fn), removeEventListener: (_: string, fn: unknown) => void listening.delete(fn) };
    const was = Object.getOwnPropertyDescriptor(window, 'visualViewport');
    Object.defineProperty(window, 'visualViewport', { value: fake, configurable: true });
    try {
      render(LONG, NO_LIST_FILTER, [], true);
      await press(funnel());
      const before = new Set(listening);
      await focusOn(field('projects')!);
      // The field's own listener (the sheet's keyboard watch, phone.ts, has its own).
      const own = [...listening].filter((fn) => !before.has(fn));
      expect(own).toHaveLength(1);
      // The menu goes with focus still in the field (no blur reaches it, as in WebKit).
      await act(async () => root!.unmount());
      root = null;
      expect(listening.has(own[0])).toBe(false);
    } finally {
      if (was) Object.defineProperty(window, 'visualViewport', was);
      else delete (window as { visualViewport?: unknown }).visualViewport;
    }
  });

  test('a touch on the field itself is not the person scrolling; after blur nothing moves it', async () => {
    const s = sheet();
    bringUp(s.input, s.viewport);
    s.input.dispatchEvent(new Event('touchstart', { bubbles: true }));
    s.scrollTo(0);
    await s.resize(450);
    expect(s.scroll()).toBe(200);
    s.input.dispatchEvent(new FocusEvent('blur'));
    s.scrollTo(0);
    await s.resize(300);
    expect(s.scroll()).toBe(0);
    s.done();
  });
});
