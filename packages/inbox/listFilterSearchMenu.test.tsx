/**
 * The search in the list's filter menu, drawn (components/ListFilter.tsx, listFilterSearch.ts).
 *
 * What this catches: a field on a short menu, or a short menu that is no longer the plain menu; a long menu with no
 * field, or one that does not take focus on a click; typing that does not narrow, bold or count; arrows that do not
 * move the highlight while the field keeps focus, or stop at the end where the plain menu wraps; Enter that does not
 * tick the highlighted row; Space that ticks instead of typing; Escape that closes before it empties the field; a ticked
 * row that goes when it does not match; no line when nothing matches; Custom range… not opening its panel from the
 * search; the field taking focus (and a phone's keyboard) on a touch open; the count said on every key; focus not back on
 * the funnel after Escape closes the menu (the funnel is a detached trigger), or `aria-expanded` not following the menu;
 * the field on eight rows or missing on nine, on a fresh menu or the same mounted one; Tags, Agent, Pull request or the
 * Routine group left out of the narrowing; Home or End taken from the field's caret when it holds text, or not going to
 * the first and last row when it is empty; Tab not closing; Clear filters gone or dead while searching; the × hidden
 * from screen readers; a list of 200 tags that narrows wrong; a highlight left on a ticked row when nothing matches
 * (Enter would untick it); Enter or Escape during IME composition ticking or closing.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxListRow } from '@plannotator/core/inbox-types';
import type { InboxInitiative } from '@plannotator/core/inbox-types';
import type { InboxScheduledRow } from '@plannotator/core/inbox-scheduled-types';
import type { ListFilter } from './listFilter';
import type { ThreadTagsHost } from './threadTags';

const hasDom = typeof document !== 'undefined';
const { ListFilterButton } = (hasDom ? await import('./components/ListFilter') : {}) as typeof import('./components/ListFilter');
const { ThreadTagsContext } = await import('./threadTags');
const { NO_LIST_FILTER, resetListFilterForTests } = await import('./listFilter');
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

function row(id: string, project: string): InboxListRow {
  const at = new Date(NOW.getTime() - 3_600_000).toISOString();
  return {
    thread_id: id,
    project: { id: `prj_${project}`, name: project },
    subject: `Thread ${id}`,
    thread_name: null,
    author: { kind: 'agent', host: 'claude-code', session: `s_${id}`, name: null },
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

/** Ten projects: one more than the plain menu's longest section, so the search shows. */
const LONG = ['api', 'billing', 'docs', 'infra', 'ios', 'payments', 'rebill', 'search', 'web', 'worker'];
const rowsOf = (projects: readonly string[], tagNames: readonly string[] = []) =>
  projects.map((p, i) => ({ ...row(`t${i}`, p), tags: tagNames.map((_, n) => `tag_${n}`) }) as InboxListRow);
const tagsOf = (names: readonly string[]) => names.map((name, i) => ({ id: `tag_${i}`, name, created_at: NOW.toISOString() }) as unknown as InboxInitiative);
/** One of this computer's routines, running in `thread`. */
const routine = (thread: string) => ({ id: `sch_${thread}`, name: `Routine ${thread}`, thread_id: thread, state: 'off', last_run: null, last_change: null }) as unknown as InboxScheduledRow;

/** Swaps the mounted harness's rows (a project arriving while the window is open). */
let swapRows: ((rows: readonly InboxListRow[]) => void) | null = null;

function Harness({ rows: first, start, tagNames }: { rows: readonly InboxListRow[]; start: ListFilter; tagNames: readonly string[] }) {
  const [filter, setFilter] = useState(start);
  const [rows, setRows] = useState(first);
  swapRows = setRows;
  const tags = tagsOf(tagNames);
  const host: ThreadTagsHost | null =
    tagNames.length === 0 ? null : { tags, tagsOf: () => [], counts: new Map(), can: () => true, set: () => {}, createAndSet: () => {}, listed: null, rows, rowTags: (r) => r.tags ?? [] };
  return (
    <ThreadTagsContext.Provider value={host}>
    <ListFilterButton
      phone={false}
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

function render(projects: readonly string[], start: ListFilter = NO_LIST_FILTER, tagNames: readonly string[] = []) {
  picks = start;
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<Harness rows={rowsOf(projects, tagNames)} start={start} tagNames={tagNames} />));
}

async function settle() {
  for (let i = 0; i < 6; i += 1) await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))));
}
/**
 * Base UI opens on the pointer's press, as a person's click (or tap) does. A finger has a size and a pressure: Base UI
 * reads a 0×0 press as a screen reader's, which does focus the field.
 */
async function press(target: HTMLElement, pointerType = 'mouse') {
  const finger = pointerType === 'touch' ? { width: 20, height: 20, pressure: 0.5 } : {};
  await act(async () => {
    target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType, ...finger }));
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerType, ...finger }));
    target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
    // A tap's click counts one press (`detail` 1); `click()`'s 0 reads as a keyboard's.
    if (pointerType === 'touch') target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, detail: 1 }));
    else target.click();
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
async function type(text: string) {
  const input = field()!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
}

const $ = (selector: string) => document.querySelector<HTMLElement>(selector);
const funnel = () => $('[data-list-filter]')!;
const menu = () => $('[data-list-filter-menu]');
const field = () => document.querySelector<HTMLInputElement>('[data-list-filter-search]');
/** The rows drawn, in order, by their words. */
const rowWords = () => [...menu()!.querySelectorAll('.ib-pmi')].map((n) => n.querySelector('.ib-pmi-l')!.textContent);
const groups = () => [...menu()!.querySelectorAll('.ib-pm-glabel')].map((n) => n.textContent);
const highlighted = () => menu()!.querySelector('.ib-pmi[data-highlighted]')?.querySelector('.ib-pmi-l')?.textContent ?? null;
const status = () => $('[data-list-filter-search-status]')!.textContent;
/** The count is said once typing pauses (ListFilter.tsx `STATUS_WAIT_MS`); wait that out. */
async function pause() {
  await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 450))));
}

describe.skipIf(!hasDom)('the filter menu with short lists', () => {
  test('no field: the plain menu, its rows as always, focus in the menu', async () => {
    render(['api', 'web']);
    await press(funnel());
    expect(menu()).not.toBeNull();
    expect(field()).toBeNull();
    expect(menu()!.hasAttribute('data-list-filter-searchable')).toBe(false);
    expect(menu()!.getAttribute('role')).toBe('menu');
    expect(groups()).toEqual(['Updated', 'Project']);
    expect(rowWords()).toEqual(['Not seen', 'Recent activity', 'Today', 'Last 3 days', 'Last 7 days', 'Last 30 days', 'Custom range…', 'api', 'web']);
  });

  test('Escape closes it and puts focus back on the funnel; aria-expanded follows the menu', async () => {
    render(['api', 'web']);
    expect(funnel().getAttribute('aria-expanded')).toBe('false');
    await press(funnel());
    expect(funnel().getAttribute('aria-expanded')).toBe('true');
    await key('Escape');
    expect(menu()).toBeNull();
    expect(funnel().getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(funnel());
  });

  test('eight projects is still short: no field; a ninth brings it', async () => {
    render(LONG.slice(0, 8));
    await press(funnel());
    expect(field()).toBeNull();
    await key('Escape');
    act(() => root?.unmount());
    host?.remove();
    render(LONG.slice(0, 9));
    await press(funnel());
    expect(field()).not.toBeNull();
  });

  test("a letter still jumps to the first row it starts (the menu's type-ahead)", async () => {
    render(['api', 'web']);
    await press(funnel());
    await key('w');
    expect(highlighted()).toBe('web');
  });
});

describe.skipIf(!hasDom)('the filter menu with a long list', () => {
  test('a click opens it with the field focused at the top, and every row as before', async () => {
    render(LONG);
    await press(funnel());
    expect(funnel().getAttribute('aria-expanded')).toBe('true');
    expect(field()).not.toBeNull();
    expect(document.activeElement).toBe(field());
    expect(rowWords()).toEqual(['Not seen', 'Recent activity', 'Today', 'Last 3 days', 'Last 7 days', 'Last 30 days', 'Custom range…', ...LONG]);
    expect(status()).toBe('');
  });

  test('typing narrows every section at once, bolds the match, counts it, and highlights the first match', async () => {
    render(LONG);
    await press(funnel());
    await type('bil');
    expect(groups()).toEqual(['Project']);
    expect(rowWords()).toEqual(['billing', 'rebill']);
    expect([...menu()!.querySelectorAll('.ib-lflt-hit')].map((n) => n.textContent)).toEqual(['bil', 'bil']);
    // Not on every key: the count waits for typing to pause.
    expect(status()).toBe('');
    await pause();
    expect(status()).toBe('2 matches');
    expect(highlighted()).toBe('billing');
    const active = field()!.getAttribute('aria-activedescendant');
    expect(active && document.getElementById(active)?.textContent).toContain('billing');
    expect(document.activeElement).toBe(field());
  });

  test('arrows move the highlight while the field keeps focus, and wrap at the ends as the plain menu does', async () => {
    render(LONG);
    await press(funnel());
    await type('bil');
    await key('ArrowDown');
    expect(highlighted()).toBe('rebill');
    expect(document.activeElement).toBe(field());
    await key('ArrowDown');
    expect(highlighted()).toBe('billing');
    await key('ArrowUp');
    expect(highlighted()).toBe('rebill');
  });

  test('Enter ticks the highlighted row and the menu stays open; a ticked row stays when it no longer matches', async () => {
    render(LONG);
    await press(funnel());
    await type('bil');
    await key('ArrowDown');
    await key('Enter');
    expect(picks.projects).toEqual(['prj_rebill']);
    expect(menu()).not.toBeNull();
    expect(document.activeElement).toBe(field());
    await type('web');
    expect(rowWords()).toEqual(['web', 'rebill', 'Clear filters']);
    expect(highlighted()).toBe('web');
    await pause();
    expect(status()).toBe('1 match');
  });

  test('Space types into the field and ticks nothing', async () => {
    render(LONG);
    await press(funnel());
    await type('bil');
    expect(await key(' ')).toBe(true);
    expect(picks).toEqual(NO_LIST_FILTER);
  });

  test('nothing matches: the line says so, no row is highlighted, and Enter ticks nothing', async () => {
    render(LONG, { ...NO_LIST_FILTER, projects: ['prj_web'] });
    await press(funnel());
    await type('zzz');
    expect($('[data-list-filter-none]')!.textContent).toBe('Nothing matches “zzz”');
    await pause();
    expect(status()).toBe('Nothing matches “zzz”');
    // The ticked project stays so it can be unticked, and Clear filters stays.
    expect(rowWords()).toEqual(['web', 'Clear filters']);
    expect(highlighted()).toBeNull();
    await key('Enter');
    expect(picks.projects).toEqual(['prj_web']);
  });

  test('Escape empties the field first, then closes and puts focus back on the funnel', async () => {
    render(LONG);
    await press(funnel());
    await type('bil');
    await key('Escape');
    expect(menu()).not.toBeNull();
    expect(field()!.value).toBe('');
    expect(rowWords()).toHaveLength(7 + LONG.length);
    await key('Escape');
    expect(menu()).toBeNull();
    expect(funnel().getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(funnel());
  });

  test('the clear button empties the field', async () => {
    render(LONG);
    await press(funnel());
    await type('bil');
    await press($('[data-list-filter-search-clear]')!);
    expect(field()!.value).toBe('');
    expect(rowWords()).toHaveLength(7 + LONG.length);
    expect($('[data-list-filter-search-clear]')).toBeNull();
  });

  test('Custom range… found by the search still opens its panel', async () => {
    render(LONG);
    await press(funnel());
    await type('custom');
    expect(rowWords()).toEqual(['Custom range…']);
    await key('Enter');
    await settle();
    expect($('[data-list-filter-range]')).not.toBeNull();
  });

  test('a touch open leaves the field unfocused, so a phone keyboard stays down', async () => {
    render(LONG);
    await press(funnel(), 'touch');
    expect(field()).not.toBeNull();
    expect(document.activeElement === field()).toBe(false);
  });

  test('Home and End: with text in the field they move its caret, not the highlight', async () => {
    render(LONG);
    await press(funnel());
    await type('bil');
    expect(highlighted()).toBe('billing');
    expect(await key('End')).toBe(true);
    expect(highlighted()).toBe('billing');
    await key('ArrowDown');
    expect(highlighted()).toBe('rebill');
    expect(await key('Home')).toBe(true);
    expect(highlighted()).toBe('rebill');
    expect(document.activeElement).toBe(field());
  });

  test('Home and End: with the field empty they go to the first and last row', async () => {
    render(LONG);
    await keyOpen();
    expect(document.activeElement).toBe(field());
    expect(highlighted()).toBe('Not seen');
    await key('End');
    expect(highlighted()).toBe('worker');
    await key('Home');
    expect(highlighted()).toBe('Not seen');
    expect(document.activeElement).toBe(field());
  });

  test('Tab: focus leaving for the page closes the menu', async () => {
    render(LONG);
    const after = document.createElement('button');
    document.body.append(after);
    await press(funnel());
    await type('bil');
    // Base UI leaves Tab to the browser (its default is not prevented); the browser then moves focus to the next
    // control, firing focusout on the field with that control as `relatedTarget`, as here.
    expect(await key('Tab')).toBe(true);
    await act(async () => {
      field()!.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: after }));
      after.focus();
    });
    await settle();
    expect(menu()).toBeNull();
    expect(funnel().getAttribute('aria-expanded')).toBe('false');
    after.remove();
  });

  test('the × has a name, and Clear filters stays at the foot while searching and clears every pick', async () => {
    render(LONG, { ...NO_LIST_FILTER, projects: ['prj_web'], notSeen: true });
    await press(funnel());
    await type('bil');
    const clear = $('[data-list-filter-search-clear]')!;
    // Reachable by a screen reader's touch or virtual cursor (Base UI hides its clear button by default).
    expect(clear.getAttribute('aria-hidden')).not.toBe('true');
    expect(clear.closest('[aria-hidden="true"]')).toBeNull();
    expect(clear.getAttribute('aria-label')).toBe('Clear search');
    expect(rowWords().at(-1)).toBe('Clear filters');
    await press($('[data-list-filter-clear]')!);
    expect(picks).toEqual(NO_LIST_FILTER);
  });
});

describe.skipIf(!hasDom)('nothing matches after something did', () => {
  test('a ticked row that was the first match loses its highlight, and Enter leaves it ticked', async () => {
    render(LONG, { ...NO_LIST_FILTER, projects: ['prj_web'] });
    await press(funnel());
    await type('w');
    await type('we');
    expect(highlighted()).toBe('web');
    await type('wez');
    expect($('[data-list-filter-none]')).not.toBeNull();
    expect(highlighted()).toBeNull();
    const active = field()!.getAttribute('aria-activedescendant');
    expect(active ? document.getElementById(active) : null).toBeNull();
    await key('Enter');
    expect(picks.projects).toEqual(['prj_web']);
    expect(menu()).not.toBeNull();
  });

  test('Not seen ticked, a keyboard open, then a query with no match: Enter leaves Not seen ticked', async () => {
    render(LONG, { ...NO_LIST_FILTER, notSeen: true });
    await keyOpen();
    expect(highlighted()).toBe('Not seen');
    await type('z');
    await type('zz');
    await type('zzz');
    expect(highlighted()).toBeNull();
    await key('Enter');
    expect(picks.notSeen).toBe(true);
  });

  test('Clear filters highlighted before nothing matched: End then Enter clears nothing', async () => {
    render(LONG, { ...NO_LIST_FILTER, projects: ['prj_web'] });
    await press(funnel());
    await type('w');
    await type('we');
    await key('ArrowDown');
    expect(highlighted()).toBe('Clear filters');
    await type('wez');
    expect($('[data-list-filter-none]')).not.toBeNull();
    expect(highlighted()).toBeNull();
    await key('End');
    await key('Enter');
    expect(picks.projects).toEqual(['prj_web']);
    expect(menu()).not.toBeNull();
  });

  test('an arrow onto a kept row is a choice: then Enter unticks it', async () => {
    render(LONG, { ...NO_LIST_FILTER, projects: ['prj_web'] });
    await press(funnel());
    await type('w');
    await type('wez');
    await key('ArrowDown');
    expect(highlighted()).toBe('web');
    await key('Enter');
    expect(picks.projects).toEqual([]);
  });
});

describe.skipIf(!hasDom)('an IME composing in the field', () => {
  test('Enter that commits the composition ticks nothing; Escape that cancels it neither empties the field nor closes', async () => {
    render(LONG);
    await press(funnel());
    await type('bil');
    expect(highlighted()).toBe('billing');
    await composingKey('Enter');
    expect(picks).toEqual(NO_LIST_FILTER);
    await composingKey('Escape');
    expect(menu()).not.toBeNull();
    expect(field()!.value).toBe('bil');
  });
});

describe.skipIf(!hasDom)('the field on the same mounted menu', () => {
  test('a ninth project arriving while the menu is shut brings the field on the next open; back to eight takes it away', async () => {
    render(LONG.slice(0, 8));
    await press(funnel());
    expect(field()).toBeNull();
    await key('Escape');
    expect(menu()).toBeNull();
    await act(async () => swapRows!(rowsOf(LONG.slice(0, 9))));
    await press(funnel());
    expect(field()).not.toBeNull();
    expect(document.activeElement).toBe(field());
    await key('Escape');
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(funnel());
    await act(async () => swapRows!(rowsOf(LONG.slice(0, 8))));
    await press(funnel());
    expect(field()).toBeNull();
    expect(menu()!.getAttribute('role')).toBe('menu');
    await key('Escape');
    expect(document.activeElement).toBe(funnel());
  });

  test('the field stays as it was while the menu is open, even when a row arrives', async () => {
    render(LONG.slice(0, 8));
    await press(funnel());
    await act(async () => swapRows!(rowsOf(LONG.slice(0, 9))));
    await settle();
    expect(field()).toBeNull();
    expect(rowWords()).toContain('search');
  });
});

describe.skipIf(!hasDom)('a long name', () => {
  const NAME = `reports-and-exports-for-the-${'x'.repeat(40)}-quarterly-review`;
  test('a match past the cut drops the start ("…"), so the bold shows; the row keeps its full name', async () => {
    render([...LONG, NAME]);
    await press(funnel());
    await type('quarterly');
    const item = menu()!.querySelector<HTMLElement>(`[data-list-filter-project="prj_${NAME}"]`)!;
    const words = item.querySelector('.ib-pmi-l')!.textContent!;
    expect(words.startsWith('…')).toBe(true);
    expect(words.length).toBeLessThan(30);
    expect(item.querySelector('.ib-lflt-hit')!.textContent).toBe('quarterly');
    // Its name: the whole label and the count, as a row drawn whole is read.
    expect(item.getAttribute('aria-label')).toBe(`${NAME} 1`);
  });

  test('a match near the start draws the whole name, with no name of its own', async () => {
    render([...LONG, NAME]);
    await press(funnel());
    await type('reports');
    const item = menu()!.querySelector<HTMLElement>(`[data-list-filter-project="prj_${NAME}"]`)!;
    expect(item.querySelector('.ib-pmi-l')!.textContent).toBe(NAME);
    expect(item.hasAttribute('aria-label')).toBe(false);
  });
});

describe.skipIf(!hasDom)('the search covers every section', () => {
  test('a long Tag list alone brings the field, and typing narrows the tags with the projects', async () => {
    const TAGS = ['billing-bugs', 'mobile', 'stability', 'docs', 'perf', 'design', 'ops', 'api', 'release'];
    render(['billing', 'web'], NO_LIST_FILTER, TAGS);
    await press(funnel());
    expect(field()).not.toBeNull();
    await type('bil');
    expect(groups()).toEqual(['Tag', 'Project']);
    expect(rowWords()).toEqual(['billing-bugs', 'mobile', 'stability', 'billing']);
  });

  test('the Routine group and Updated narrow like the rest', async () => {
    resetScheduledForTests([routine('t0')]);
    render(LONG);
    await press(funnel());
    await type('threads');
    expect(groups()).toEqual(['Routine']);
    expect(rowWords()).toEqual(['Routine threads', 'Other threads']);
    await type('days');
    expect(groups()).toEqual(['Updated']);
  });

  test('Agent and Pull request narrow like the rest', async () => {
    const rows = rowsOf(LONG).map((r, i) =>
      ({ ...r, author: { ...r.author, host: i % 2 ? 'codex' : 'claude-code' }, pulls: i % 3 === 0 ? { count: 1, headline: { state: 'open', number: i } } : undefined }) as unknown as InboxListRow,
    );
    render(LONG);
    await act(async () => swapRows!(rows));
    await press(funnel());
    expect(groups()).toContain('Agent');
    expect(groups()).toContain('Pull request');
    await type('codex');
    expect(groups()).toEqual(['Agent']);
    expect(rowWords()).toEqual(['Codex']);
    await type(' pr');
    expect(groups()).toEqual(['Pull request']);
    expect(rowWords()).toEqual(['Has a PR', 'No PR']);
  });

  test('200 tags: typing narrows to the few that match, a ticked one kept after them', async () => {
    const TAGS = Array.from({ length: 200 }, (_, i) => `tag-${String(i).padStart(3, '0')}`);
    TAGS[17] = 'Billing ✨';
    TAGS[150] = 'rebilled';
    render(['api', 'web'], { ...NO_LIST_FILTER, tags: ['tag_3'] }, TAGS);
    await press(funnel());
    await type('BIL');
    expect(groups()).toEqual(['Tag']);
    expect(rowWords()).toEqual(['Billing ✨', 'rebilled', 'tag-003', 'Clear filters']);
    await pause();
    expect(status()).toBe('2 matches');
  });
});
