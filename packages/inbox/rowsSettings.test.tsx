/**
 * Settings → Rows (components/RowsSettings.tsx, approval "inbox-rows-settings-page"): "Your list", the looks to start
 * from, the choices, the change line with Undo, and Reset, over the list's look (listLook.ts) with the server's save
 * stubbed (its round trip through a real Inbox is packages/server/inbox.test.ts's; every stored look through the
 * control model is rowsControls.test.ts's).
 * What this catches: the page writing on open (any saved look, the cookie included); a choice that takes two saves or
 * leaves a rival on; a preset that is not exactly its look, is a radio again (an arrow key would apply it), or stays
 * pressed for a look that matches none; Undo that does not step back one change at a time or Reset that is not the
 * defaults; the change line not said to a screen reader; Pull requests hidden by default, or its switch leaving the
 * mark on the rows; GitHub pictures on then off leaving project badges on (and it taking off badges the person had
 * saved); "Your list" drawing examples for someone with threads, or more than two rows pinned on a phone; the tint
 * missing from the part a small change moved, or drawn for a change that re-lays the whole row (the owner, 2026-11-10).
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const hasDom = typeof document !== 'undefined';
const { RowsSection, ROWS_PRESETS, ROWS_INTRO_PRESETS, rowsSummary } = (hasDom ? await import('./components/RowsSettings') : {}) as typeof import('./components/RowsSettings');
const { LIST_LOOK_DEFAULT, readListLook, resetListLookForTests, rowsFromLook, adoptSavedRows, ROWS_COOKIE } = await import('./listLook');
const { ROWS_MAIN_CONTROLS, ROWS_MORE_CONTROLS } = await import('./rowsControls');
import type { InboxListRow } from '@plannotator/core/inbox-types';
const { setStorageBackend, resetStorageBackend } = await import('@plannotator/ui/utils/storage');

const saves: unknown[][] = [];
let stored = new Map<string, string>();
const realFetch = globalThis.fetch;
let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  saves.length = 0;
  stored = new Map<string, string>();
  setStorageBackend({ getItem: (k) => stored.get(k) ?? null, setItem: (k, v) => void stored.set(k, v), removeItem: (k) => void stored.delete(k) });
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    const rows = (JSON.parse(init?.body ?? '{}') as { rows?: unknown[] }).rows;
    if (rows) saves.push(rows);
    return new Response(JSON.stringify({ rows }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  resetListLookForTests();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  resetStorageBackend();
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function render(phone = false, rows?: InboxListRow[]): HTMLElement {
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<RowsSection phone={phone} rows={rows?.map((row) => ({ row, drawn: row.section }))} />));
  return host;
}

async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 10));
  });
}

const scope = (el: HTMLElement, control: string) => el.querySelector<HTMLElement>(`[data-rows-control="${control}"]`)!;
/** Pick a choice by its words in a control row, or a look to start from (`preset`). */
async function pick(el: HTMLElement, control: string, words: string) {
  const target = control === 'preset' ? [...el.querySelectorAll<HTMLButtonElement>('.ib-rws-presets button[data-preset]')].find((b) => b.textContent === words) : [...scope(el, control).querySelectorAll('label')].find((l) => l.textContent === words)?.querySelector('input');
  if (!target) throw new Error(`${control}: no "${words}"`);
  act(() => target.click());
  await settle();
}
const sw = (el: HTMLElement, control: string) => scope(el, control).querySelector<HTMLButtonElement>('[role="switch"]')!;
async function flip(el: HTMLElement, control: string) {
  act(() => sw(el, control).click());
  await settle();
}
async function press(el: HTMLElement, selector: string) {
  act(() => el.querySelector<HTMLButtonElement>(selector)!.click());
  await settle();
}
const pressed = (el: HTMLElement) => [...el.querySelectorAll('.ib-rws-presets button[data-preset]')].filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.getAttribute('data-preset'));
const chosen = (el: HTMLElement, control: string) => [...scope(el, control).querySelectorAll('label')].filter((l) => l.querySelector('input')!.checked).map((l) => l.textContent);
const said = (el: HTMLElement) => el.querySelector('[data-rows-last] [role="status"]')!.textContent;
const on = () => rowsFromLook(readListLook());
/** The server's saved look, as a settings read brings it. */
const saved = (rows: string[]) => adoptSavedRows(rows, 1, -1);

function thread(over: Partial<InboxListRow> & { thread_id: string }): InboxListRow {
  return {
    project_id: 'prj_a',
    author: { kind: 'agent', host: 'claude-code', session: 'ses_a', name: null },
    created_at: '2026-11-09T10:00:00.000Z',
    last_at: '2026-11-09T10:00:00.000Z',
    last_author: 'agent',
    message_count: 2,
    resolved_at: null,
    questions: { open: 0, picked: 0, stopped: false, holds_up: [], prompt: null },
    waiting_on_person: false,
    project: { id: 'prj_a', name: 'my-own-project' },
    thread_name: null,
    subject: `Subject of ${over.thread_id}`,
    section: 'new',
    unread: false,
    answered_not_sent: false,
    waiting_since: null,
    unseen: 0,
    sent: null,
    guide: false,
    ...over,
  };
}
const OWN = [thread({ thread_id: 't1' }), thread({ thread_id: 't2' }), thread({ thread_id: 't3', pulls: { count: 2, headline: { key: 'github.com/acme/app#7', state: 'open' } } }), thread({ thread_id: 't4' })];

describe.if(hasDom)('Settings → Rows', () => {
  test('opening the page writes nothing, whatever look is saved: no save, and the cookie is left as it was', async () => {
    for (const rows of [null, ['smallNames'], [], ['compact', 'smallNames', 'hidePulls'], ['highlight', 'roomy', 'unreadDot', 'marksProjects', 'githubPictures', 'timeBelow'], ROWS_PRESETS[1]!.look && rowsFromLook(ROWS_PRESETS[1]!.look)]) {
      resetListLookForTests();
      if (rows) saved(rows);
      const cookie = stored.get(ROWS_COOKIE);
      const before = on();
      for (const phone of [false, true]) {
        const el = render(phone, OWN);
        await settle();
        // Opening "More choices" is not a change either.
        await press(el, '[data-rows-more]');
        act(() => root!.unmount());
        el.remove();
        root = null;
      }
      expect([rows, saves, on(), stored.get(ROWS_COOKIE)]).toEqual([rows, [], before, cookie]);
    }
  });

  test('the defaults: Balanced pressed, eight choices first and nine folded, nothing to undo or reset, no change line', async () => {
    const el = render();
    expect(pressed(el)).toEqual(['balanced']);
    expect([...el.querySelectorAll('.ib-rws-presets button[data-preset]')].map((b) => b.getAttribute('data-preset'))).toEqual(['balanced', 'dense', 'minimal', 'detailed']);
    const more = el.querySelector<HTMLElement>('#ib-rows-more')!;
    expect(more.hidden).toBe(true);
    expect([...el.querySelectorAll('[data-rows-control]')].filter((row) => !more.contains(row)).map((row) => row.getAttribute('data-rows-control'))).toEqual(ROWS_MAIN_CONTROLS.map((c) => c.id));
    expect([...more.querySelectorAll('[data-rows-control]')].map((row) => row.getAttribute('data-rows-control'))).toEqual(ROWS_MORE_CONTROLS.map((c) => c.id));
    await press(el, '[data-rows-more]');
    expect([more.hidden, el.querySelector('[data-rows-more]')!.getAttribute('aria-expanded')]).toEqual([false, 'true']);
    expect([el.querySelector<HTMLButtonElement>('[data-rows-undo]')!.disabled, el.querySelector<HTMLButtonElement>('[data-rows-reset]')!.disabled, said(el), el.querySelector('[data-rows-undo-last]')]).toEqual([true, true, '', null]);
    // Pull requests, Agent icons and Project name read "shown".
    expect(['agents', 'project', 'pulls'].map((c) => sw(el, c).getAttribute('aria-checked'))).toEqual(['true', 'true', 'true']);
  });

  test('a three-way choice never leaves its rival on, and each pick is one save', async () => {
    const el = render();
    await pick(el, 'spacing', 'Roomy');
    await pick(el, 'spacing', 'Compact');
    await pick(el, 'preview', '2 lines');
    await pick(el, 'preview', 'None');
    await pick(el, 'newer', 'Dot');
    await pick(el, 'newer', 'Bigger name');
    expect(saves).toEqual([['smallNames', 'roomy'], ['compact', 'smallNames'], ['compact', 'smallNames', 'previewTwo'], ['compact', 'smallNames', 'hidePreview'], ['compact', 'smallNames', 'hidePreview', 'unreadDot'], ['compact', 'hidePreview']]);
    expect([chosen(el, 'spacing'), chosen(el, 'preview'), chosen(el, 'newer')]).toEqual([['Compact'], ['None'], ['Bigger name']]);
  });

  test('a switch that shows a part is on while the part shows; each is one save of its own name', async () => {
    const el = render();
    for (const control of ['agents', 'project', 'pulls', 'boldAll', 'pill', 'dividers']) await flip(el, control);
    expect(saves.map((rows) => rows.filter((name) => name !== 'smallNames'))).toEqual([['hideAgents'], ['hideAgents', 'hideProject'], ['hideAgents', 'hideProject', 'hidePulls'], ['hideAgents', 'hideProject', 'boldNames', 'hidePulls'], ['highlight', 'hideAgents', 'hideProject', 'boldNames', 'hidePulls'], ['highlight', 'hideAgents', 'hideProject', 'dividers', 'boldNames', 'hidePulls']]);
    expect(['agents', 'project', 'pulls', 'boldAll', 'pill', 'dividers'].map((c) => sw(el, c).getAttribute('aria-checked'))).toEqual(['false', 'false', 'false', 'true', 'true', 'true']);
    // The words under Pull requests describe the switch to a screen reader.
    expect(el.querySelector(`#${sw(el, 'pulls').getAttribute('aria-describedby')}`)!.textContent).toBe('Their state at the end of the row');
  });

  test('each look to start from is exactly its list in one save; a look that matches none has none pressed and no "Custom" tag', async () => {
    const el = render();
    for (const preset of [...ROWS_PRESETS].reverse()) {
      await pick(el, 'preset', preset.label);
      expect([saves.at(-1), pressed(el), rowsSummary(readListLook())]).toEqual([rowsFromLook(preset.look), [preset.id], preset.label]);
    }
    // Balanced was pressed last and is the look already: pressing it again saves nothing.
    await pick(el, 'preset', 'Balanced');
    expect(saves).toHaveLength(ROWS_PRESETS.length);
    await pick(el, 'time', '10m ago');
    expect([pressed(el), el.querySelector('.ib-rws-custom'), el.querySelector('.ib-rws')!.getAttribute('data-rows-preset')]).toEqual([[], null, 'none']);
  });

  test('the looks are buttons in a named group, never radios, so an arrow key cannot wipe a look', () => {
    const el = render();
    const group = el.querySelector('.ib-rws-presets')!;
    expect([group.getAttribute('role'), el.querySelector(`#${group.getAttribute('aria-labelledby')}`)!.textContent, group.querySelectorAll('input').length]).toEqual(['group', 'Start from', 0]);
    for (const button of group.querySelectorAll('button[data-preset]')) expect([button.getAttribute('type'), button.closest('.ib-rws-pic')]).toEqual(['button', null]);
    // A picture's rows are buttons themselves: none sits inside a look's button.
    expect(group.querySelectorAll('button button').length).toBe(0);
    // Their pictures are not announced and cannot be reached.
    for (const pic of group.querySelectorAll('.ib-rws-pic')) expect([pic.getAttribute('aria-hidden'), pic.hasAttribute('inert')]).toEqual(['true', true]);
  });

  test('every change is said in a polite live region with Undo beside it; Undo steps back one change at a time', async () => {
    const el = render();
    const status = el.querySelector('[data-rows-last] [role="status"]')!;
    expect(status.getAttribute('aria-live')).toBe('polite');
    await pick(el, 'spacing', 'Compact');
    expect(said(el)).toBe('Changed: Spacing → Compact');
    await pick(el, 'preset', 'Dense');
    expect(said(el)).toBe('Changed: Time → 10m ago, When a thread needs you → One mark, Lines between rows → on');
    await flip(el, 'pulls');
    expect(said(el)).toBe('Changed: Pull requests → off');
    await press(el, '[data-rows-undo-last]');
    expect([on(), said(el), el.querySelector('[data-rows-undo-last]')]).toEqual([rowsFromLook(ROWS_PRESETS[1]!.look), 'Undid: Pull requests → off', null]);
    await press(el, '[data-rows-undo]');
    expect(on()).toEqual(['compact', 'smallNames']);
    await press(el, '[data-rows-undo]');
    expect([on(), el.querySelector<HTMLButtonElement>('[data-rows-undo]')!.disabled]).toEqual([['smallNames'], true]);
    // Each undo is one save of the look it went back to.
    expect(saves.slice(3)).toEqual([rowsFromLook(ROWS_PRESETS[1]!.look), ['compact', 'smallNames'], ['smallNames']]);
  });

  test('Reset to default writes the defaults once, can be undone, and is off while the look is the defaults', async () => {
    saved(['highlight', 'compact', 'hidePulls']);
    const el = render();
    const reset = el.querySelector<HTMLButtonElement>('[data-rows-reset]')!;
    expect(reset.disabled).toBe(false);
    await press(el, '[data-rows-reset]');
    expect([saves, readListLook(), reset.disabled, pressed(el)]).toEqual([[['smallNames']], LIST_LOOK_DEFAULT, true, ['balanced']]);
    await press(el, '[data-rows-undo]');
    expect(on()).toEqual(['highlight', 'compact', 'hidePulls']);
  });

  test('a picture switch on then off is no change (Balanced again); project badges the person saved stay', async () => {
    const el = render();
    await flip(el, 'github');
    expect([on(), chosen(el, 'badges')]).toEqual([['smallNames', 'marksProjects', 'githubPictures'], ['Projects']]);
    await flip(el, 'github');
    expect([on(), pressed(el)]).toEqual([['smallNames'], ['balanced']]);
    // Both pictures on: badges go only with the last one off.
    await flip(el, 'logo');
    await flip(el, 'github');
    await flip(el, 'logo');
    expect(on()).toEqual(['smallNames', 'marksProjects', 'githubPictures']);
    await flip(el, 'github');
    expect(on()).toEqual(['smallNames']);
    // Badges picked by the person in between are theirs.
    await flip(el, 'github');
    await pick(el, 'badges', 'Both');
    await flip(el, 'github');
    expect(on()).toEqual(['smallNames', 'marksThreads', 'marksProjects']);
  });

  test('a saved look with project badges and a picture: turning the picture off keeps the badges, as before this page', async () => {
    saved(['smallNames', 'marksProjects', 'githubPictures']);
    const el = render();
    await flip(el, 'github');
    expect(on()).toEqual(['smallNames', 'marksProjects']);
    await flip(el, 'github');
    await flip(el, 'github');
    expect(on()).toEqual(['smallNames', 'marksProjects']);
  });

  test('Badge shape: none picked while badges are off, and picking one turns thread badges on in one save', async () => {
    const el = render();
    expect([chosen(el, 'badges'), chosen(el, 'shape')]).toEqual([['Off'], []]);
    await pick(el, 'shape', 'A dot');
    expect([saves, chosen(el, 'badges'), chosen(el, 'shape')]).toEqual([[['smallNames', 'marksThreads', 'markDot']], ['Threads'], ['A dot']]);
  });

  test('"Your list" is the person\'s own rows; with none, labelled examples; a phone pins two rows', () => {
    const list = (el: HTMLElement) => el.querySelector('[data-rows-preview]')!;
    let el = render(false, OWN);
    expect([list(el).getAttribute('data-rows-source'), list(el).querySelectorAll('[data-thread-id]').length, list(el).textContent!.includes('my-own-project'), el.querySelector('.ib-rws-empty')]).toEqual(['own', 4, true, null]);
    expect([list(el).hasAttribute('inert'), list(el).querySelector('section')!.getAttribute('aria-hidden')]).toEqual([true, 'true']);
    act(() => root!.unmount());
    el = render(false, []);
    expect([list(el).getAttribute('data-rows-source'), el.querySelector('.ib-rws-empty')!.textContent]).toEqual(['examples', 'You have no threads yet. These examples show the look.']);
    act(() => root!.unmount());
    el = render(true, OWN);
    expect([list(el).getAttribute('data-rows-preview'), [...list(el).querySelectorAll('[data-thread-id]')].map((row) => row.getAttribute('data-thread-id'))]).toEqual(['phone', ['t1', 't2']]);
  });

  test('Pull requests off takes the PR mark off the rows at once, and tints nothing that is gone; on puts it back, tinted', async () => {
    const el = render(false, OWN);
    const list = el.querySelector('[data-rows-preview]')!;
    expect(list.querySelectorAll('.ib-prmark').length).toBe(1);
    await flip(el, 'pulls');
    expect(list.querySelectorAll('.ib-prmark').length).toBe(0);
    // Only the row that had one says so, on its last line.
    expect([...list.querySelectorAll('[data-rows-flash]')].map((part) => [part.closest('[data-thread-id]')!.getAttribute('data-thread-id'), part.className])).toEqual([['t3', 'ib-l3']]);
    await flip(el, 'pulls');
    expect([...list.querySelectorAll('[data-rows-flash]')].map((part) => part.className)).toEqual(['ib-prmark']);
  });

  test('only a small change tints: Spacing, First on the row, Lines between rows, a look to start from, Reset and their Undo tint nothing, and still say the change', async () => {
    const el = render(false, OWN);
    const tinted = () => el.querySelectorAll('[data-rows-flash]').length;
    await press(el, '[data-rows-more]');
    await pick(el, 'time', '10m ago');
    expect(tinted()).toBe(OWN.length);
    for (const [control, words] of [['spacing', 'Roomy'], ['first', 'Thread name']] as const) {
      await pick(el, control, words);
      expect([control, tinted(), said(el).startsWith('Changed: ')]).toEqual([control, 0, true]);
    }
    await flip(el, 'dividers');
    expect([tinted(), said(el)]).toEqual([0, 'Changed: Lines between rows → on']);
    await pick(el, 'preset', 'Dense');
    expect(tinted()).toBe(0);
    // Undoing the look re-lays every row too; undoing a small change tints its part.
    await press(el, '[data-rows-undo]');
    expect([tinted(), said(el).startsWith('Undid: ')]).toEqual([0, true]);
    await flip(el, 'agents');
    await press(el, '[data-rows-undo]');
    expect(tinted()).toBeGreaterThan(0);
    await press(el, '[data-rows-reset]');
    expect([tinted(), said(el).startsWith('Changed: ')]).toEqual([0, true]);
  });

  test('a part that leaves tints the line it was on, never the whole row; letter badges are tinted themselves', async () => {
    const el = render(false, OWN);
    const tinted = () => [...new Set([...el.querySelectorAll('[data-rows-flash]')].map((part) => part.className.split(' ')[0]))];
    await flip(el, 'project');
    expect(tinted()).toEqual(['ib-from']);
    await flip(el, 'project');
    expect(tinted()).toEqual(['ib-p']);
    await press(el, '[data-rows-more]');
    await pick(el, 'badges', 'Projects');
    expect(tinted()).toEqual(['ib-lm']);
    await pick(el, 'badges', 'Off');
    expect(tinted()).toEqual([]);
  });

  test('a phone brings a row that shows the change into its two pinned rows', async () => {
    const el = render(true, OWN);
    await flip(el, 'pulls');
    await flip(el, 'pulls');
    const list = el.querySelector('[data-rows-preview]')!;
    expect([...list.querySelectorAll('[data-thread-id]')].map((row) => row.getAttribute('data-thread-id'))).toEqual(['t3', 't1']);
  });

  test('the one-time dialog keeps its three looks; Dense is on this page only', () => {
    expect(ROWS_INTRO_PRESETS.map((preset) => preset.id)).toEqual(['minimal', 'balanced', 'detailed']);
  });
});
