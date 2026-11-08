/**
 * The notes-list look on the list's rows (the owner's picture, 2026-11-07; approval "inbox-customize-rows", addendum):
 * Time position "Under the preview" (`timeBelow`), Dividers (`dividers`) and Status mark (`statusMark`), from the Rows
 * look (config.json `inboxRows`, listLook.ts). All off by default.
 * What this catches: any of the three changing a row while off (nobody's look may change); the time left on line 1, or
 * the row's end left beside the preview, with the time under it; a wide row losing its columns to it; the status mark
 * saying the wrong state (waiting, done, nothing) for a row's section; a row with open questions or action items whose
 * count is lost (the approved record: they always show) or whose Stopped or Holds up triangle goes; the options
 * fighting the other options' rivals or surviving a preset; a divider drawn as a border or outline on a row.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { inboxRowsCanonical, type InboxListRow, type InboxListSection, type InboxRowsOption } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
const { InboxList } = (hasDom ? await import('./components/InboxList') : {}) as typeof import('./components/InboxList');
const { SidebarProvider } = (hasDom ? await import('./shell/sidebar') : {}) as typeof import('./shell/sidebar');
const { ROWS_PRESETS } = (hasDom ? await import('./components/RowsSettings') : {}) as typeof import('./components/RowsSettings');
const { rowStatus, rowStatusName, rowStatusWords } = await import('./components/RowStatus');
const { LIST_LOOK_DEFAULT, adoptSavedRows, lookWithChange, resetListLookForTests, rowsFromLook } = await import('./listLook');
const { setStorageBackend, resetStorageBackend } = await import('@plannotator/ui/utils/storage');

function row(id: string, extra: Partial<InboxListRow> = {}): InboxListRow {
  return {
    thread_id: id,
    project_id: 'prj_billing',
    subject: `Subject ${id}`,
    author: { kind: 'agent', host: 'claude-code', session: 'ses_a', name: null },
    created_at: '2026-10-10T10:00:00.000Z',
    last_at: '2026-10-10T10:00:00.000Z',
    last_author: 'agent',
    message_count: 1,
    resolved_at: null,
    questions: { open: 0, picked: 0, stopped: false, holds_up: [], prompt: null },
    waiting_on_person: false,
    project: { id: 'prj_billing', name: 'billing-svc' },
    thread_name: null,
    section: 'quiet',
    unread: false,
    answered_not_sent: false,
    waiting_since: null,
    unseen: 0,
    sent: null,
    guide: false,
    ...extra,
  };
}

const STOP = row('msg_stop', {
  thread_name: 'Postgres 17 migration',
  section: 'stopped',
  unread: true,
  waiting_on_person: true,
  questions: { open: 1, picked: 0, stopped: true, holds_up: [], prompt: null },
  waits: [{ message_id: 'msg_stop', key: 'q-1', position: 0, prompt: 'Rotate it?', stopped: 'the staging password expired', holds_up: [] }],
});
const HOLD = row('msg_hold', {
  thread_name: 'Fix login redirect',
  section: 'holding',
  unread: true,
  waiting_on_person: true,
  questions: { open: 1, picked: 0, stopped: false, holds_up: ['the install page'], prompt: null },
  waits: [{ message_id: 'msg_hold', key: 'q-1', position: 0, prompt: 'Which page?', stopped: null, holds_up: ['the install page'] }],
});
const WAIT = row('msg_wait', {
  thread_name: 'Checkout redesign',
  section: 'waiting',
  unread: true,
  waiting_on_person: true,
  questions: { open: 3, picked: 0, stopped: false, holds_up: [], prompt: null, actions: 1 },
});
const NEWS = row('msg_new', { section: 'new', unread: true, unseen: 1 });
const SENT = row('msg_sent', { section: 'sent', last_author: 'person', sent: { at: '2026-10-10T10:00:00.000Z', checked_at: null } });
const QUIET = row('msg_quiet', { thread_name: 'Tests pass on main', read_at: '2026-10-10T10:05:00.000Z' });
const ACKED = row('msg_acked', { thread_name: 'Docs typo', read_at: '2026-10-10T10:05:00.000Z', ack: { label: 'Looks good', at: '2026-10-10T10:05:00.000Z' } });
const WORKING = row('msg_working', { thread_name: 'Nightly build', run: 'working' });
const SECTIONS: InboxListSection[] = [
  { id: 'stopped', label: 'Stopped on you', threads: [STOP] },
  { id: 'holding', label: 'Holding up work', threads: [HOLD] },
  { id: 'waiting', label: 'Waiting on you', threads: [WAIT] },
  { id: 'new', label: 'New since you looked', threads: [NEWS] },
  { id: 'sent', label: 'Sent', threads: [SENT] },
  { id: 'quiet', label: 'Quiet', threads: [QUIET, ACKED, WORKING] },
];

const realFetch = globalThis.fetch;
let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  // Quiet starts closed (listGroups.ts): open it, so its done row draws.
  const stored = new Map<string, string>([['plannotator-inbox-list-groups', 'quiet:open']]);
  setStorageBackend({ getItem: (k) => stored.get(k) ?? null, setItem: (k, v) => void stored.set(k, v), removeItem: (k) => void stored.delete(k) });
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) =>
    new Response(JSON.stringify({ rows: (JSON.parse(init?.body ?? '{}') as { rows: unknown[] }).rows }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
  resetListLookForTests();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  resetStorageBackend();
  if (!hasDom) return;
  unmount();
});

function unmount() {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
}

/** The person's saved look: the defaults (smaller names) plus `on`. */
function look(...on: InboxRowsOption[]) {
  act(() => adoptSavedRows(['smallNames', ...on], 1));
}

function mount(shape: 'wide' | 'narrow' | 'phone', pinned?: ReadonlySet<string>): HTMLElement {
  host = document.createElement('div');
  host.className = 'pn-inbox';
  host.setAttribute('data-pn-tooltip-root', '');
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <SidebarProvider>
        <InboxList title="Inbox" path={null} sections={SECTIONS} filtered={false} narrow={shape === 'narrow'} selectedThreadId={null} notice={null} onShowNew={() => {}} onOpen={() => {}} phone={shape === 'phone'} pinned={pinned as Set<string> | undefined} />
      </SidebarProvider>,
    ),
  );
  return host;
}

const rowOf = (el: HTMLElement, id: string) => el.querySelector<HTMLElement>(`[data-thread-id="${id}"]`)!;
const SHAPES = ['wide', 'narrow', 'phone'] as const;
/** Line 1, line 3 and the time's own line of a three-line or phone row. */
const lines = (r: HTMLElement) => ({ first: r.querySelector(':scope > .ib-l1, :scope > .ib-m1')!, third: r.querySelector(':scope > .ib-l3, :scope > .ib-m3'), foot: r.querySelector(':scope > .ib-l4, :scope > .ib-m4') });

describe('the status mark says waiting, done or nothing', () => {
  test('waiting while a question or action item is open, in every section that has one; done in Quiet or archived; nothing in New and Sent', () => {
    expect([STOP, HOLD, WAIT, NEWS, SENT, QUIET].map((r) => rowStatus(r))).toEqual(['waiting', 'waiting', 'waiting', null, null, 'done']);
    // Archived: done, even with a question still open (the row says "Archived", nothing waits on the person now).
    expect(rowStatus(row('a', { resolved_at: '2026-10-10T11:00:00.000Z', questions: { open: 1, picked: 0, stopped: false, holds_up: [], prompt: null } }))).toBe('done');
    // Back from the archive with a question open: waiting again.
    expect(rowStatus(row('b', { resolved_at: '2026-10-10T11:00:00.000Z', back_from_archive: true, section: 'waiting', questions: { open: 1, picked: 0, stopped: false, holds_up: [], prompt: null } }))).toBe('waiting');
  });

  // Review of #2872: a Mark read with a question open put the row in Quiet, where it showed "Read" and no count; the
  // mark said Waiting there. A Re-ask note waiting on the agent (Sent) showed no count either.
  test('done wins in Quiet even with a question still open; Sent has no mark, a Re-ask note waiting included', () => {
    const open = { open: 1, picked: 0, stopped: false, holds_up: [], prompt: null };
    expect(rowStatus(row('r', { read_at: '2026-10-10T10:05:00.000Z', questions: open }))).toBe('done');
    expect(rowStatus(row('s', { section: 'sent', reask_pending: true, questions: open }))).toBeNull();
  });

  test("a done row's name keeps why it is Quiet; its tooltip words stay \"Done\"", () => {
    expect([QUIET, ACKED, WORKING].map((r) => rowStatusName(r))).toEqual(['Done, read', 'Done, 👍 Looks good', 'Done']);
    expect(rowStatusName(row('a', { resolved_at: '2026-10-10T11:00:00.000Z' }))).toBe('Done, archived');
    expect(rowStatusWords(QUIET)).toBe('Done');
    expect(rowStatusName(WAIT)).toBe('Waiting on you: 2 questions, 1 action item');
  });

  test('its words keep the count: one question, several, action items', () => {
    expect(rowStatusWords(STOP)).toBe('Waiting on you: 1 question');
    expect(rowStatusWords(WAIT)).toBe('Waiting on you: 2 questions, 1 action item');
    expect(rowStatusWords(row('c', { section: 'waiting', questions: { open: 1, picked: 0, stopped: false, holds_up: [], prompt: null, actions: 1 } }))).toBe('Waiting on you: 1 action item');
    expect(rowStatusWords(QUIET)).toBe('Done');
    expect(rowStatusWords(NEWS)).toBeNull();
  });
});

describe('the options in the look', () => {
  test('all off by default', () => {
    for (const key of ['timeBelow', 'dividers', 'statusMark', 'boldNames'] as const) expect(LIST_LOOK_DEFAULT[key]).toBe(false);
  });

  test('no rival of theirs: the other rivals settle without touching them, and they never turn another option off', () => {
    const notes = lookWithChange(LIST_LOOK_DEFAULT, { timeBelow: true, dividers: true, statusMark: true, boldNames: true, roomy: true, previewTwo: true, titleFirst: true, hideAgents: true, hideProject: true });
    for (const change of [{ compact: true }, { hidePreview: true }, { unreadDot: true }, { smallNames: false }, { marksThreads: true, markDot: true }] as const) {
      const next = lookWithChange(notes, change);
      expect([next.timeBelow, next.dividers, next.statusMark, next.boldNames]).toEqual([true, true, true, true]);
    }
    // Turning them off keeps every other option as it was.
    expect(lookWithChange(notes, { timeBelow: false, dividers: false, statusMark: false, boldNames: false })).toEqual({ ...notes, timeBelow: false, dividers: false, statusMark: false, boldNames: false });
    expect(inboxRowsCanonical(['compact', 'timeBelow', 'dividers', 'statusMark', 'boldNames'])).toEqual(['compact', 'timeBelow', 'dividers', 'statusMark', 'boldNames']);
  });

  test.if(hasDom)('no preset turns one on (presets come later), so picking a preset turns them off', () => {
    for (const preset of ROWS_PRESETS) expect([preset.look.timeBelow, preset.look.dividers, preset.look.statusMark, preset.look.boldNames]).toEqual([false, false, false, false]);
  });
});

describe.if(hasDom)('the notes-list look on the rows', () => {
  test('off by default: every shape draws as before (time on line 1, counts beside the preview, no mark, no divider class)', () => {
    for (const shape of SHAPES) {
      const el = mount(shape);
      const column = el.querySelector('.ib-listcol')!;
      for (const cls of ['ib-lk-tbelow', 'ib-lk-div', 'ib-lk-stm', 'ib-lk-bold']) expect(column.classList.contains(cls)).toBe(false);
      expect(el.querySelectorAll('.ib-stm, .ib-l4, .ib-m4').length).toBe(0);
      // The open counts as today: `?N` and the action pill.
      expect(rowOf(el, 'msg_wait').querySelector('.ib-qn')!.getAttribute('data-open-count')).toBe('2');
      expect(rowOf(el, 'msg_wait').querySelector('[data-action-count="1"]')).not.toBeNull();
      if (shape !== 'wide') {
        const { first, third } = lines(rowOf(el, 'msg_wait'));
        expect(first.querySelector('.ib-t')).not.toBeNull();
        expect(third!.querySelector('.ib-qn')).not.toBeNull();
      }
      unmount();
    }
  });

  test('Time under the preview: the time leaves line 1 for its own line, first, with the row\'s end at its right; the preview line keeps only the preview', () => {
    for (const first of [[], ['titleFirst']] as InboxRowsOption[][]) {
      look('timeBelow', ...first);
      for (const shape of ['narrow', 'phone'] as const) {
        const el = mount(shape);
        expect(el.querySelector('.ib-listcol')!.classList.contains('ib-lk-tbelow')).toBe(true);
        for (const r of [STOP, WAIT, QUIET]) {
          const { first: l1, third, foot } = lines(rowOf(el, r.thread_id));
          expect(l1.querySelector('.ib-t')).toBeNull();
          expect(foot!.firstElementChild!.classList.contains('ib-t')).toBe(true);
          expect(third!.querySelector('.ib-badge, .ib-c')).toBeNull();
        }
        // The Stopped mark and the counts moved to the time's line, nothing lost.
        expect(lines(rowOf(el, 'msg_stop')).foot!.querySelector('.ib-qn[data-wait-step="stop"]')).not.toBeNull();
        expect(lines(rowOf(el, 'msg_wait')).foot!.querySelector('.ib-qn')).not.toBeNull();
        unmount();
      }
    }
  });

  test('Time under the preview leaves a wide row\'s columns alone', () => {
    look('timeBelow');
    const el = mount('wide');
    const wide = rowOf(el, 'msg_wait');
    expect(wide.querySelector(':scope > .ib-t')).not.toBeNull();
    expect(wide.querySelector(':scope > .ib-cq .ib-qn')).not.toBeNull();
    expect(el.querySelectorAll('.ib-l4, .ib-m4').length).toBe(0);
  });

  test('Status mark on every shape: one mark in place of the counts, waiting / done / nothing by section', () => {
    look('statusMark');
    for (const shape of SHAPES) {
      const el = mount(shape);
      const mark = (id: string) => rowOf(el, id).querySelector('.ib-stm')?.getAttribute('data-status') ?? null;
      expect(['msg_stop', 'msg_hold', 'msg_wait', 'msg_new', 'msg_sent', 'msg_quiet', 'msg_acked', 'msg_working'].map(mark)).toEqual(['waiting', 'waiting', 'waiting', null, null, 'done', 'done', 'done']);
      // In place of the counts: no open `?N`, no open action pill, on any row (a blocked row keeps its filled mark).
      expect(el.querySelectorAll('.ib-qn[data-wait-step="open"], [data-action-count][data-wait-step="open"]').length).toBe(0);
      expect(rowOf(el, 'msg_wait').querySelectorAll('.ib-qn, [data-action-count]').length).toBe(0);
      if (shape === 'wide') expect(rowOf(el, 'msg_wait').querySelector(':scope > .ib-cq .ib-stm')).not.toBeNull();
      else expect(lines(rowOf(el, 'msg_wait')).third!.querySelector('.ib-stm')).not.toBeNull();
      unmount();
    }
  });

  test('Status mark: questions and action items still show, the count in its name; Stopped and Holds up keep their filled marks', () => {
    look('statusMark', 'timeBelow');
    for (const shape of SHAPES) {
      const el = mount(shape);
      expect(rowOf(el, 'msg_wait').querySelector('.ib-stm .ib-sr')!.textContent!.trim()).toBe('Waiting on you: 2 questions, 1 action item');
      expect(rowOf(el, 'msg_wait').querySelector('.ib-stm')!.getAttribute('data-status-count')).toBe('3');
      expect(rowOf(el, 'msg_stop').querySelector('.ib-qn[data-wait-step="stop"]')).not.toBeNull();
      const hold = rowOf(el, 'msg_hold').querySelector('.ib-qn[data-wait-step="hold"]')!;
      expect(hold.querySelector('.ib-sr')!.textContent!.trim()).toBe('Holding up work: 1 question');
      // Before the status mark.
      expect(hold.compareDocumentPosition(rowOf(el, 'msg_hold').querySelector('.ib-stm')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      // The mark is never hidden from a screen reader: it is the count.
      expect(rowOf(el, 'msg_wait').querySelector('.ib-stm')!.closest('[aria-hidden="true"]')).toBeNull();
      // With the time under the preview it sits on the time's line, after the time, and not beside the preview.
      if (shape !== 'wide') {
        const { third, foot } = lines(rowOf(el, 'msg_wait'));
        expect(third?.querySelector('.ib-stm') ?? null).toBeNull();
        const stm = foot!.querySelector('.ib-stm')!;
        expect(foot!.querySelector('.ib-t')!.compareDocumentPosition(stm) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      }
      unmount();
    }
  });

  test('Dividers: only a class on the list column, and its rules draw a line between rows, never a border or outline on one', () => {
    look('dividers');
    for (const shape of SHAPES) {
      const el = mount(shape);
      expect(el.querySelector('.ib-listcol')!.classList.contains('ib-lk-div')).toBe(true);
      unmount();
    }
    const css = readFileSync(new URL('./inbox.css', import.meta.url), 'utf8');
    const rules = [...css.matchAll(/([^{}]*\.ib-lk-div[^{}]*)\{([^}]*)\}/g)];
    expect(rules.length).toBeGreaterThan(0);
    for (const [, , body] of rules) {
      expect(body).not.toMatch(/\b(border|outline|box-shadow)\s*:/);
      expect(body).toMatch(/background-(image|size)/);
    }
  });
  test('Status mark on a done row: the tick alone, no "Read" or "👍 Looks good"; other words stay; off, the words are back', () => {
    const words = (el: HTMLElement, id: string) => [...rowOf(el, id).querySelectorAll('[data-count-words]')].map((w) => w.getAttribute('data-count-words'));
    for (const shape of SHAPES) {
      look();
      let el = mount(shape);
      expect([words(el, 'msg_quiet'), words(el, 'msg_acked'), words(el, 'msg_working')]).toEqual([['Read'], ['👍 Looks good'], ['Working']]);
      unmount();
      look('statusMark');
      el = mount(shape);
      expect([words(el, 'msg_quiet'), words(el, 'msg_acked'), words(el, 'msg_working')]).toEqual([[], [], ['Working']]);
      expect(rowOf(el, 'msg_acked').querySelector('.ib-stm')!.getAttribute('data-status')).toBe('done');
      unmount();
      resetListLookForTests();
    }
  });

  test('Bold names: a class on the list column, off by default, whose rule outranks the read, Sent and Quiet weights', () => {
    let el = mount('narrow');
    expect(el.querySelector('.ib-listcol')!.classList.contains('ib-lk-bold')).toBe(false);
    unmount();
    look('boldNames');
    el = mount('narrow');
    expect(el.querySelector('.ib-listcol')!.classList.contains('ib-lk-bold')).toBe(true);
    // The rules that set a name's weight back to 400 (a read row, a Sent row, a phone's name): the bold rule has at
    // least their specificity (three classes) and comes after every one, so it wins in each.
    const css = readFileSync(new URL('./inbox.css', import.meta.url), 'utf8');
    const bold = css.indexOf('.ib-lk-bold :is(.ib-row, .ib-nrow) .ib-title, .ib-lk-bold .ib-mrow .ib-m2 { font-weight: 600; }');
    expect(bold).toBeGreaterThan(0);
    for (const rule of ['.ib-row.ib-sent .ib-p, .ib-row.ib-sent .ib-title {', '.ib-nrow.ib-sent .ib-p, .ib-nrow.ib-sent .ib-title {', '.ib-nrow .ib-title { display: block;', '  .ib-m2 { display: block;']) {
      const at = css.indexOf(rule);
      expect(at).toBeGreaterThan(0);
      expect(at).toBeLessThan(bold);
    }
  });

  test('a pinned row on a phone with the time under the preview keeps its pin with the row\'s end, never on line 1', () => {
    // The New row has no preview, badge or count: by default its pin sits on line 1, before the time.
    const pinned = new Set(['msg_new']);
    let el = mount('phone', pinned);
    expect(lines(rowOf(el, 'msg_new')).first.querySelector('[data-pin-mark]')).not.toBeNull();
    unmount();
    look('timeBelow');
    el = mount('phone', pinned);
    const { first, foot } = lines(rowOf(el, 'msg_new'));
    expect(first.querySelector('[data-pin-mark]')).toBeNull();
    expect(foot!.querySelector('[data-pin-mark]')).not.toBeNull();
  });
});

/**
 * The owner (2026-11-07): folding the empty second line "shouldn't change how I work today, hopefully not at all". A row
 * with the agents or the project shown keeps its exact lines, in the default look, every preset and name first; only a
 * name-first row with both off folds the line, and it keeps the agents' names for a screen reader.
 */
describe.if(hasDom)('the empty second line folds only when nothing shows on it', () => {
  /** A three-line or phone row's lines: each direct child's class, with where the time is. */
  const shapeOf = (r: HTMLElement) => [...r.children].filter((c) => !c.classList.contains('ib-sr') && !c.classList.contains('ib-lm-av')).map((c) => `${c.className}${c.querySelector('.ib-t') ? ' +time' : ''}${c.hasAttribute('data-lead-empty') ? ' +folded' : ''}`);
  const NARROW_PROJECT_FIRST = ['ib-l1 +time', 'ib-l2', 'ib-l3'];
  const NARROW_NAME_FIRST = ['ib-l1 +time', 'ib-l2 ib-l2-lead', 'ib-l3'];
  const PHONE_PROJECT_FIRST = ['ib-m1 +time', 'ib-m2', 'ib-m3'];
  const PHONE_NAME_FIRST = ['ib-m1 +time', 'ib-m1 ib-m1-lead', 'ib-m3'];
  // The options are read inside each test: the presets come from a DOM-only import, absent where the file only loads.
  const preset = (id: string) => () => rowsFromLook(ROWS_PRESETS.find((p) => p.id === id)!.look);
  const looks: [string, () => InboxRowsOption[], string[], string[]][] = [
    // The owner's own look (rows-bold-1357.png): the defaults, the agents and the project on line 1.
    ['the defaults', () => [], NARROW_PROJECT_FIRST, PHONE_PROJECT_FIRST],
    // Detailed's names in their pill: a phone's line 2 is the pill.
    ['Detailed', preset('detailed'), NARROW_PROJECT_FIRST, ['ib-m1 +time', 'ib-key ib-rowkey', 'ib-m3']],
    ['Minimal (compact, agents off)', preset('minimal'), ['ib-l1 +time', 'ib-l3'], ['ib-m1 +time', 'ib-m3']],
    ['name first', () => ['titleFirst'], NARROW_NAME_FIRST, PHONE_NAME_FIRST],
    ['name first, agents off', () => ['titleFirst', 'hideAgents'], NARROW_NAME_FIRST, PHONE_NAME_FIRST],
    ['name first, project off', () => ['titleFirst', 'hideProject'], NARROW_NAME_FIRST, PHONE_NAME_FIRST],
  ];
  for (const [name, options, narrow, phone] of looks) {
    test(`${name}: every row keeps its lines, nothing folded`, () => {
      const on = options();
      act(() => adoptSavedRows(on.length ? on : ['smallNames'], 1));
      for (const [shape, expected] of [['narrow', narrow], ['phone', phone]] as const) {
        const el = mount(shape);
        for (const r of [STOP, WAIT, NEWS]) expect(shapeOf(rowOf(el, r.thread_id))).toEqual(expected);
        expect(el.querySelectorAll('[data-lead-empty]').length).toBe(0);
        unmount();
      }
    });
  }

  test('name first with agents and project both off: the second line is folded, and still names the agents', () => {
    look('titleFirst', 'hideAgents', 'hideProject');
    for (const shape of ['narrow', 'phone'] as const) {
      const el = mount(shape);
      const lead = rowOf(el, 'msg_wait').querySelector('[data-lead-empty]')!;
      expect(lead.classList.contains(shape === 'narrow' ? 'ib-l2-lead' : 'ib-m1-lead')).toBe(true);
      expect(lead.querySelector('[aria-label]')!.getAttribute('aria-label')).toContain('Claude Code');
      unmount();
    }
  });
});
