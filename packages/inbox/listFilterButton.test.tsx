/**
 * The list's filter in the list (components/ListFilter.tsx, listFilter.ts): the header's funnel and its badge, the
 * menu's picks, Clear filters, and "No threads match" in the body.
 *
 * What this catches: anything but the funnel in the header (a token, a chip, a line), at rest or with picks; the funnel
 * not taking the accent colour or the count with picks, or keeping them after a clear; a pick that does not narrow the
 * rows, or a group whose band stays drawn with no rows left; Clear filters (the menu's or the empty state's) that
 * leaves a pick, the cookie, or focus nowhere; the empty words drawn in the header; a project's page that offers the
 * Project group or counts its picks; a reload that forgets the picks.
 *
 * The harness wires the list as App.tsx does (filter the sections, hand the list the rows before the filter).
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxListGroupId, InboxListRow, InboxListSection } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
const { InboxList } = (hasDom ? await import('./components/InboxList') : {}) as typeof import('./components/InboxList');
const { ListFilterEmpty, clearedFrom } = (hasDom ? await import('./components/ListFilter') : {}) as typeof import('./components/ListFilter');
const { SidebarProvider } = (hasDom ? await import('./shell/sidebar') : {}) as typeof import('./shell/sidebar');
const { LIST_FILTER_COOKIE, appliedFilter, filterListSections, pickCount, resetListFilterForTests, useListFilter } = await import('./listFilter');
const { setStorageBackend, resetStorageBackend } = await import('@plannotator/ui/utils/storage');

const stored = new Map<string, string>();
let root: Root | null = null;
let host: HTMLElement | null = null;
let sheet: HTMLStyleElement | null = null;

beforeEach(() => {
  stored.clear();
  setStorageBackend({ getItem: (k) => stored.get(k) ?? null, setItem: (k, v) => void stored.set(k, v), removeItem: (k) => void stored.delete(k) });
  resetListFilterForTests();
});

afterEach(() => {
  if (hasDom) act(() => root?.unmount());
  resetStorageBackend();
  resetListFilterForTests();
  if (!hasDom) return;
  host?.remove();
  sheet?.remove();
  for (const node of document.body.querySelectorAll('[data-base-ui-portal], [role="presentation"]')) node.remove();
  document.body.innerHTML = '';
  root = null;
  host = null;
  sheet = null;
});

const recent = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 3_600_000).toISOString();

function row(id: string, project: string, hoursAgo: number, agent: string, section: InboxListRow['section']): InboxListRow {
  return {
    thread_id: id,
    project: { id: `prj_${project}`, name: project },
    subject: `Thread ${id}`,
    thread_name: null,
    author: { kind: 'agent', host: agent, session: `s_${id}`, name: null },
    last_at: recent(hoursAgo),
    last_agent_at: recent(hoursAgo),
    last_author: 'agent',
    section,
    unread: section !== 'quiet',
    unseen: 0,
    questions: { open: 0, picked: 0, stopped: false, holds_up: [] },
    sent: null,
    resolved_at: null,
  } as unknown as InboxListRow;
}

function sections(by: Partial<Record<InboxListGroupId, InboxListRow[]>>): InboxListSection[] {
  const ids: InboxListGroupId[] = ['stopped', 'holding', 'waiting', 'new', 'sent', 'quiet', 'snoozed'];
  return ids.map((id) => ({ id, label: id, threads: by[id] ?? [] })) as InboxListSection[];
}

const LIST = sections({
  waiting: [row('w-billing', 'billing', 1, 'claude-code', 'waiting'), row('w-web', 'web', 2, 'codex', 'waiting')],
  new: [row('n-web', 'web', 3, 'codex', 'new'), row('n-docs-old', 'docs', 24 * 40, 'claude-code', 'new')],
});

/** App.tsx's wiring: the picks from this browser, the sections filtered, the rows before the filter for the menu. */
function Harness({ scoped }: { scoped: boolean }) {
  const [picks, setPicks] = useListFilter();
  const applied = appliedFilter(picks, scoped);
  const base = scoped ? LIST.map((s) => ({ ...s, threads: s.threads.filter((r) => r.project.id === 'prj_web') })) : LIST;
  const shown = filterListSections(base, applied, Date.now());
  const none = pickCount(applied) > 0 && shown.every((s) => s.threads.length === 0);
  return (
    <InboxList
      title={scoped ? 'web' : 'Inbox'}
      path={null}
      sections={shown}
      sort={{ epoch: 1, keep: null }}
      filtered={scoped}
      narrow={false}
      phone={false}
      selectedThreadId={null}
      notice={null}
      onShowNew={() => {}}
      onOpen={() => {}}
      empty={none ? <ListFilterEmpty onClear={() => setPicks(clearedFrom(picks, scoped))} /> : null}
      listFilter={{ rows: base.flatMap((s) => s.threads), scoped, names: new Map(), filter: picks, onChange: setPicks }}
    />
  );
}

/** The funnel's rules from the window's stylesheet (outside the phone block), with an accent to read back. */
function funnelRules(): string {
  const css = readFileSync(join(import.meta.dir, 'inbox.css'), 'utf8');
  const lines = css.split('\n').filter((line) => /^\.pn-inbox \.ib-lflt[\[:, {]/.test(line));
  return `.pn-inbox { --primary: rgb(1, 2, 3); --muted-foreground: rgb(9, 9, 9); --foreground: rgb(0, 0, 0); }\n${lines.join('\n')}`;
}

function render(scoped = false): HTMLElement {
  sheet = document.createElement('style');
  sheet.textContent = funnelRules();
  document.head.append(sheet);
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <SidebarProvider>
        <Harness scoped={scoped} />
      </SidebarProvider>,
    );
  });
  return host;
}

async function settle() {
  for (let i = 0; i < 6; i += 1) await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))));
}
/** Base UI opens on the pointer's press, as a person's click does. */
async function press(target: HTMLElement) {
  await act(async () => {
    target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }));
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerType: 'mouse' }));
    target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
    target.click();
  });
  await settle();
}
async function click(target: HTMLElement) {
  await act(async () => target.click());
  await settle();
}

const $ = (selector: string) => document.querySelector<HTMLElement>(selector);
const funnel = () => $('.ib-lhead [data-list-filter]')!;
const badge = () => funnel().querySelector('[data-list-filter-count]')?.textContent ?? null;
const rowIds = (el: HTMLElement) => [...el.querySelectorAll('.ib-lbody [data-thread-id]')].map((n) => n.getAttribute('data-thread-id'));
const bands = (el: HTMLElement) => [...el.querySelectorAll('.ib-lbody .ib-band')].map((n) => n.closest('[data-section-id]')!.getAttribute('data-section-id'));
/** The header's words: its title, and the funnel's count when it has one. A token, chip or line would add words. */
const headerWords = (el: HTMLElement) => el.querySelector('.ib-lhead')!.textContent;
/** A new page: unmount, forget what this page read, draw again from the cookie. */
function rerender(scoped = false): HTMLElement {
  act(() => root?.unmount());
  host?.remove();
  sheet?.remove();
  for (const node of document.body.querySelectorAll('[data-base-ui-portal], [role="presentation"]')) node.remove();
  resetListFilterForTests();
  return render(scoped);
}

describe.skipIf(!hasDom)('the funnel', () => {
  test('at rest: the funnel alone, no count, the quiet colour, named "Filter"', () => {
    const el = render();
    expect(el.querySelectorAll('.ib-lhead [data-list-filter]')).toHaveLength(1);
    expect(headerWords(el)).toBe('Inbox');
    expect(badge()).toBeNull();
    expect(funnel().getAttribute('aria-label')).toBe('Filter');
    expect(getComputedStyle(funnel()).color).toBe('rgb(9, 9, 9)');
  });

  test('picks narrow the rows, drop an emptied band, and turn the funnel accent with their count; nothing else joins the header', async () => {
    const el = render();
    await press(funnel());
    await click($('[data-list-filter-project="prj_web"]')!);
    await click($('[data-list-filter-updated="7d"]')!);
    expect(rowIds(el)).toEqual(['w-web', 'n-web']);
    await click($('[data-list-filter-agent="Claude Code"]')!);
    // web and Claude Code: nothing; Codex too widens the agents again.
    await click($('[data-list-filter-agent="Codex"]')!);
    expect(rowIds(el)).toEqual(['w-web', 'n-web']);
    expect(badge()).toBe('4');
    expect(funnel().getAttribute('aria-label')).toBe('Filter, 4 active');
    expect(headerWords(el)).toBe('Inbox4');
    // A pick that empties a group takes its band away.
    await click($('[data-list-filter-project="prj_web"]')!);
    await click($('[data-list-filter-project="prj_billing"]')!);
    expect(rowIds(el)).toEqual(['w-billing']);
    expect(bands(el)).toEqual(['waiting']);
  });

  test('with picks the funnel takes the accent colour and their count, at rest', () => {
    stored.set(LIST_FILTER_COOKIE, JSON.stringify({ projects: [], updated: '30d', agents: ['Codex'] }));
    const el = render();
    expect(funnel().hasAttribute('data-popup-open')).toBe(false);
    expect(getComputedStyle(funnel()).color).toBe('rgb(1, 2, 3)');
    expect(badge()).toBe('2');
    expect(headerWords(el)).toBe('Inbox2');
  });

  test('Clear filters in the menu drops every pick, the count, the colour and the cookie', async () => {
    const el = render();
    await press(funnel());
    await click($('[data-list-filter-project="prj_docs"]')!);
    await click($('[data-list-filter-updated="7d"]')!);
    expect(stored.has(LIST_FILTER_COOKIE)).toBe(true);
    await click($('[data-list-filter-clear]')!);
    expect(rowIds(el)).toEqual(['w-billing', 'w-web', 'n-web', 'n-docs-old']);
    expect(badge()).toBeNull();
    expect(funnel().hasAttribute('data-set')).toBe(false);
    expect(stored.has(LIST_FILTER_COOKIE)).toBe(false);
    // The next page draws the quiet funnel (the open menu holds the hover colour on this one).
    rerender();
    expect(getComputedStyle(funnel()).color).toBe('rgb(9, 9, 9)');
  });

  test('nothing matches: "No threads match" in the body, not the header; its Clear filters brings the rows back and focus to the funnel', async () => {
    const el = render();
    await press(funnel());
    await click($('[data-list-filter-project="prj_docs"]')!);
    await click($('[data-list-filter-updated="today"]')!);
    const empty = el.querySelector<HTMLElement>('[data-list-filter-empty]')!;
    expect(empty.closest('.ib-lbody')).not.toBeNull();
    expect(el.querySelector('.ib-lhead [data-list-filter-empty]')).toBeNull();
    expect(rowIds(el)).toEqual([]);
    await act(async () => void $('[data-list-filter-menu]')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    await settle();
    await click(el.querySelector<HTMLElement>('[data-list-filter-empty-clear]')!);
    await act(async () => void (await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))));
    expect(rowIds(el)).toEqual(['w-billing', 'w-web', 'n-web', 'n-docs-old']);
    expect(badge()).toBeNull();
    expect(document.activeElement).toBe(funnel());
  });

  test('a project\'s page: no Project group, its Project picks neither filter nor count; Clear filters keeps them for Inbox', async () => {
    stored.set(LIST_FILTER_COOKIE, JSON.stringify({ projects: ['prj_billing'], updated: 'today', agents: [] }));
    const el = render(true);
    expect(rowIds(el)).toEqual(['w-web', 'n-web']);
    expect(badge()).toBe('1');
    await press(funnel());
    expect($('[data-list-filter-project]')).toBeNull();
    await click($('[data-list-filter-clear]')!);
    expect(JSON.parse(stored.get(LIST_FILTER_COOKIE)!)).toEqual({ projects: ['prj_billing'], updated: null, agents: [] });
  });

  test('a reload keeps the picks (this browser\'s cookie)', async () => {
    const first = render();
    await press(funnel());
    await click($('[data-list-filter-agent="Codex"]')!);
    expect(rowIds(first)).toEqual(['w-web', 'n-web']);
    const el = rerender();
    expect(rowIds(el)).toEqual(['w-web', 'n-web']);
    expect(badge()).toBe('1');
  });
});
