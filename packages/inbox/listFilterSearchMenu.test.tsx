/**
 * The search in the list's filter menu, drawn (components/ListFilter.tsx, listFilterSearch.ts).
 *
 * What this catches: a field on a short menu, or a short menu that is no longer the plain menu; a long menu with no
 * field, or one that does not take focus on a click; typing that does not narrow, bold or count; arrows that do not
 * move the highlight while the field keeps focus, or stop at the end where the plain menu wraps; Enter that does not
 * tick the highlighted row; Space that ticks instead of typing; Escape that closes before it empties the field; a ticked
 * row that goes when it does not match; no line when nothing matches; Custom range… not opening its panel from the
 * search; the field taking focus (and a phone's keyboard) on a touch open.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxListRow } from '@plannotator/core/inbox-types';
import type { ListFilter } from './listFilter';

const hasDom = typeof document !== 'undefined';
const { ListFilterButton } = (hasDom ? await import('./components/ListFilter') : {}) as typeof import('./components/ListFilter');
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
const rowsOf = (projects: readonly string[]) => projects.map((p, i) => row(`t${i}`, p));

function Harness({ rows, start }: { rows: readonly InboxListRow[]; start: ListFilter }) {
  const [filter, setFilter] = useState(start);
  return (
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
  );
}

function render(projects: readonly string[], start: ListFilter = NO_LIST_FILTER) {
  picks = start;
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<Harness rows={rowsOf(projects)} start={start} />));
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

describe.skipIf(!hasDom)('the filter menu with short lists', () => {
  test('no field: the plain menu, its rows as always, focus in the menu', async () => {
    render(['api', 'web']);
    await press(funnel());
    expect(menu()).not.toBeNull();
    expect(field()).toBeNull();
    expect(menu()!.hasAttribute('data-list-filter-searchable')).toBe(false);
    expect(menu()!.getAttribute('role')).toBe('menu');
    expect(groups()).toEqual(['Updated', 'Project']);
    expect(rowWords()).toEqual(['Not seen', 'Today', 'Last 3 days', 'Last 7 days', 'Last 30 days', 'Custom range…', 'api', 'web']);
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
    expect(field()).not.toBeNull();
    expect(document.activeElement).toBe(field());
    expect(field()!.getAttribute('placeholder')).toBe('Find a project, tag or agent');
    expect(field()!.getAttribute('aria-label')).toBe('Find a project, tag or agent');
    expect(rowWords()).toEqual(['Not seen', 'Today', 'Last 3 days', 'Last 7 days', 'Last 30 days', 'Custom range…', ...LONG]);
    expect(status()).toBe('');
  });

  test('typing narrows every section at once, bolds the match, counts it, and highlights the first match', async () => {
    render(LONG);
    await press(funnel());
    await type('bil');
    expect(groups()).toEqual(['Project']);
    expect(rowWords()).toEqual(['billing', 'rebill']);
    expect([...menu()!.querySelectorAll('.ib-lflt-hit')].map((n) => n.textContent)).toEqual(['bil', 'bil']);
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
    expect(status()).toBe('Nothing matches “zzz”');
    // The ticked project stays so it can be unticked, and Clear filters stays.
    expect(rowWords()).toEqual(['web', 'Clear filters']);
    expect(highlighted()).toBeNull();
    await key('Enter');
    expect(picks.projects).toEqual(['prj_web']);
  });

  test('Escape empties the field first, then closes', async () => {
    render(LONG);
    await press(funnel());
    await type('bil');
    await key('Escape');
    expect(menu()).not.toBeNull();
    expect(field()!.value).toBe('');
    expect(rowWords()).toHaveLength(6 + LONG.length);
    await key('Escape');
    expect(menu()).toBeNull();
  });

  test('the clear button empties the field', async () => {
    render(LONG);
    await press(funnel());
    await type('bil');
    await press($('[data-list-filter-search-clear]')!);
    expect(field()!.value).toBe('');
    expect(rowWords()).toHaveLength(6 + LONG.length);
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
});
