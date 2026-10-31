/**
 * The agents in a list row. A wide row (approval "list-rows-mail-icons",
 * 2026-10-30): one bare mark per agent host before the project (the owner,
 * 2026-10-31), first to join first; a host with two or more sessions is one
 * mark and "×N"; past three hosts, two marks and "+N" counting the sessions
 * not drawn; the marks in a slot as wide as the list's widest marks, so the
 * projects line up (pixels: tests/e2e/inbox-row-badges.spec.ts). A three-line or
 * phone row (approval "inbox-list-row-v2", 2026-10-30): the agents' tiles
 * drawn before the project, one per agent, at most two, then a "+N" tile
 * counting the other agents; the project on one line that never wraps, cut
 * with "…". Every row: one accessible name that lists every agent, the hidden
 * ones too, read after the project, and no agent name drawn as words. The
 * failures this catches: a repeated logo for two sessions of one host (in a
 * wide row, or a tile that hides a different agent behind "+N"), a cap that
 * drops an agent from the row's name, more than two tiles pushing the project
 * off its line, a project that wraps, a screen reader hearing every agent
 * before the project, an agent name in visible text, and a narrow row's title
 * cut instead of wrapped. Pixels (1440 beside a thread, a phone, a long project with five
 * agents) are proved in tests/e2e/inbox-row-lead.spec.ts.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxListRow, InboxListSection, InboxParticipant } from '@plannotator/core/inbox-types';
import { loadCascade } from './cssCascade.testing';

const hasDom = typeof document !== 'undefined';
const { InboxList } = (hasDom ? await import('./components/InboxList') : {}) as typeof import('./components/InboxList');
const { SidebarProvider } = (hasDom ? await import('./shell/sidebar') : {}) as typeof import('./shell/sidebar');
const { rowAgentsSlot } = (hasDom ? await import('./components/RowAgents') : {}) as typeof import('./components/RowAgents');

const CSS = readFileSync(join(import.meta.dir, 'inbox.css'), 'utf8');

const session = (host: string | null, n: number): InboxParticipant => ({ host, session: `ses_${host ?? 'none'}_${n}` });

function row(id: string, participants?: InboxParticipant[], extra: Partial<InboxListRow> = {}): InboxListRow {
  const first = participants?.[0] ?? session('claude-code', 0);
  return {
    thread_id: id,
    project_id: 'prj_1',
    subject: `Subject ${id}`,
    author: { kind: 'agent', host: first.host, session: first.session, name: null },
    created_at: '2026-10-10T10:00:00.000Z',
    last_at: '2026-10-10T10:00:00.000Z',
    last_author: 'agent',
    message_count: 1,
    resolved_at: null,
    questions: { open: 1, picked: 0, stopped: false, holds_up: [], prompt: null },
    waiting_on_person: true,
    project: { id: 'prj_1', name: 'billing-svc' },
    thread_name: null,
    section: 'waiting',
    unread: false,
    answered_not_sent: false,
    waiting_since: null,
    unseen: 0,
    sent: null,
    guide: false,
    ...(participants ? { participants } : {}),
    ...extra,
  };
}

/** One agent: no `participants` (the server sends them only with two or more sessions). */
const ONE = row('msg_one', undefined, { author: { kind: 'agent', host: 'codex', session: 'ses_codex', name: null } });
/** Two Claude Code sessions: one mark, "×2". */
const TWICE = row('msg_twice', [session('claude-code', 1), session('claude-code', 2)]);
/** Three hosts: all three marks, no "+N". */
const THREE = row('msg_three', [session('claude-code', 1), session('opencode', 1), session('codex', 1)]);
/** Four hosts, Codex twice: two marks (Claude Code, Codex ×2), then "+2" for OpenCode and Pi. */
const FOUR = row('msg_four', [session('claude-code', 1), session('codex', 1), session('opencode', 1), session('codex', 2), session('pi', 1)]);
/** Two spellings of one host are one mark. */
const ALIAS = row('msg_alias', [session('claude', 1), session('claude-code', 2)]);
/** A person-started thread: the agent it is addressed to. */
const ADDRESSED = row('msg_to', undefined, { author: { kind: 'person' }, addressee: { host: 'pi', session: 'ses_pi' } });
const LONG_NAME = 'ledger-reconciliation-dry-run-before-the-quarterly-close-and-the-external-audit';
const NAMED = row('msg_named', undefined, { thread_name: LONG_NAME });
/** Five hosts, one session each, on a very long project: two tiles, then "+3". */
const LONG_PROJECT = 'acme-global-payments-ledger-reconciliation-and-settlement-platform-monorepo';
const FIVE = row('msg_five', [session('claude-code', 1), session('codex', 1), session('opencode', 1), session('pi', 1), session('cursor', 1)], { project_id: 'prj_2', project: { id: 'prj_2', name: LONG_PROJECT } });
/** Claude Code twice, then Codex: two agents, so one Claude tile and a Codex tile, never two Claude tiles and "+1". */
const REPEAT = row('msg_repeat', [session('claude-code', 1), session('claude-code', 2), session('codex', 1)]);
const SECTIONS: InboxListSection[] = [{ id: 'waiting', label: 'Waiting on you', threads: [ONE, TWICE, THREE, FOUR, ALIAS, ADDRESSED, NAMED, FIVE, REPEAT] }];

type Shape = 'wide' | 'narrow' | 'phone';
const LEAD_SHAPES: Shape[] = ['narrow', 'phone'];

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function render(shape: Shape, filtered = false): HTMLElement {
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <SidebarProvider>
        <InboxList title="Inbox" path={null} sections={SECTIONS} filtered={filtered} narrow={shape === 'narrow'} selectedThreadId={null} notice={null} onShowNew={() => {}} onOpen={() => {}} phone={shape === 'phone'} />
      </SidebarProvider>,
    );
  });
  return host;
}

/** A three-line or phone row's tiles as drawn: each tile's host, then the "+N" tile when present. */
function tiles(el: HTMLElement, id: string) {
  const run = el.querySelector<HTMLElement>(`[data-thread-id="${id}"] .ib-atiles`)!;
  expect(run).not.toBeNull();
  return {
    drawn: [...run.querySelectorAll<HTMLElement>(':scope > .ib-atile:not(.ib-atmore)')].map((t) => t.dataset.agentHost),
    more: run.querySelector(':scope > .ib-atmore')?.textContent ?? null,
    name: run.getAttribute('aria-label'),
    role: run.getAttribute('role'),
  };
}

/** A wide row's marks as drawn: each group's host and its "×N", then "+N" when present. */
function marks(el: HTMLElement, id: string) {
  const agents = el.querySelector<HTMLElement>(`[data-thread-id="${id}"] .ib-ags`)!;
  expect(agents).not.toBeNull();
  return {
    drawn: [...agents.querySelectorAll<HTMLElement>(':scope > .ib-ag')].map((g) => `${g.dataset.agentHost}${g.querySelector('.ib-agx')?.textContent ?? ''}`),
    more: agents.querySelector(':scope > .ib-agplus')?.textContent ?? null,
    name: agents.getAttribute('aria-label'),
    role: agents.getAttribute('role'),
  };
}

/** What a screen reader reads for the row: its text, with a role="img" child's label in its place, hidden parts left out. */
function accessibleName(node: Element): string {
  const walk = (n: Node): string => {
    if (n.nodeType === 3) return n.textContent ?? '';
    const e = n as Element;
    if (e.getAttribute('aria-hidden') === 'true' || (e as HTMLElement).hidden) return '';
    if (e.getAttribute('role') === 'img') return ` ${e.getAttribute('aria-label') ?? ''} `;
    return [...e.childNodes].map(walk).join(' ');
  };
  return walk(node).replace(/\s+/g, ' ').trim();
}

/** The row's visible words: its text without what is for a screen reader only. */
function visibleText(node: Element): string {
  const copy = node.cloneNode(true) as Element;
  copy.querySelectorAll('.ib-sr, [hidden]').forEach((n) => n.remove());
  return copy.textContent ?? '';
}

describe.if(hasDom)("a wide row's agents", () => {
  {
    const shape: Shape = 'wide';
    test(`${shape}: a host with two sessions is one mark and "×2"; two spellings of one host are one mark`, () => {
      const el = render(shape);
      expect(marks(el, TWICE.thread_id)).toEqual({ drawn: ['claude-code×2'], more: null, name: '2 Claude Code sessions', role: 'img' });
      expect(marks(el, ALIAS.thread_id).drawn).toEqual(['claude×2']);
      // One agent: its mark alone, no "×1".
      expect(marks(el, ONE.thread_id)).toEqual({ drawn: ['codex'], more: null, name: 'Codex', role: 'img' });
      // A thread the person started: the agent it went to.
      expect(marks(el, ADDRESSED.thread_id)).toEqual({ drawn: ['pi'], more: null, name: 'Pi', role: 'img' });
    });

    test(`${shape}: three hosts are three marks; past three, two marks and "+N" counting the sessions not drawn`, () => {
      const el = render(shape);
      expect(marks(el, THREE.thread_id)).toEqual({ drawn: ['claude-code', 'opencode', 'codex'], more: null, name: 'Claude Code, OpenCode and Codex', role: 'img' });
      expect(marks(el, FOUR.thread_id).drawn).toEqual(['claude-code', 'codex×2']);
      expect(marks(el, FOUR.thread_id).more).toBe('+2');
    });

    test(`${shape}: one name lists every agent, the hidden ones too; the row reads it, and draws no agent name as words`, () => {
      const el = render(shape);
      expect(marks(el, FOUR.thread_id).name).toBe('Claude Code, 2 Codex sessions, OpenCode and Pi');
      const r = el.querySelector<HTMLElement>(`[data-thread-id="${FOUR.thread_id}"]`)!;
      // The marks, the "×N" and the "+N" are for the eye: the one name stands for them.
      const agents = r.querySelector('.ib-ags')!;
      for (const part of agents.children) expect(part.getAttribute('aria-hidden')).toBe('true');
      expect(r.querySelectorAll('[role="img"][aria-label*="Codex"]').length).toBe(1);
      // The row's name starts with where and who, then the title.
      expect(accessibleName(r)).toMatch(/^billing-svc Claude Code, 2 Codex sessions, OpenCode and Pi Subject msg_four/);
      // No agent's name in the row's words (the marks say who), and no native title.
      for (const id of [FOUR.thread_id, ONE.thread_id, TWICE.thread_id]) {
        const text = visibleText(el.querySelector(`[data-thread-id="${id}"]`)!);
        for (const name of ['Claude Code', 'Codex', 'OpenCode', 'Pi']) expect(text).not.toContain(name);
      }
      expect(r.querySelector('[title]')).toBeNull();
      // The marks share the project's cell, never a column of their own; the project is first in the DOM (read
      // first), the cell's grid draws the marks first.
      expect(r.querySelector('.ib-from > .ib-p + .ib-ags')).not.toBeNull();
      expect(r.querySelectorAll('.ib-ags').length).toBe(1);
    });

    test(`${shape}: the marks are drawn before the project, in a slot as wide as the list's widest marks`, () => {
      const el = render(shape);
      const from = el.querySelector<HTMLElement>(`.ib-row[data-thread-id="${FOUR.thread_id}"] .ib-from`)!;
      const cascade = loadCascade(CSS);
      expect(cascade.resolved(from, 'display')).toBe('grid');
      // The marks' track: at least the slot, wider only for a run that outgrows it; then the project's.
      expect(cascade.winner(from, 'grid-template-columns')?.value).toBe('minmax(var(--ib-agslot, auto), max-content) minmax(0, 1fr)');
      expect(cascade.resolved(from.querySelector<HTMLElement>('.ib-ags')!, 'grid-area')).toBe('1 / 1');
      // The marks keep their own width (their tooltip is theirs alone), never stretched across the slot.
      expect(cascade.resolved(from.querySelector<HTMLElement>('.ib-ags')!, 'justify-self')).toBe('start');
      expect(cascade.resolved(from.querySelector<HTMLElement>('.ib-p')!, 'grid-area')).toBe('1 / 2');
      // The slot is the widest run's: three bare marks (58px) against two marks, "×2" and "+2" (54px and four
      // characters of text); neither outgrows the other at every text size, so both are in the max().
      const slot = el.querySelector<HTMLElement>('.ib-listcol')!.style.getPropertyValue('--ib-agslot');
      expect(slot).toContain('58px');
      expect(slot).toContain('calc(54px + var(--ib-fs-12, 12px) * 1.3 + var(--ib-fs-10-5, 10.5px) * 1.3)');
      expect(slot.startsWith('max(')).toBe(true);
    });
  }

  test('the slot: one mark is 16px; a run another outgrows drops out; a list with no rows has none', () => {
    const one = (participants?: InboxParticipant[]) => ({ participants, agent: { kind: 'agent', host: 'codex' } });
    expect(rowAgentsSlot([one(), one(), one([session('pi', 1)])])).toBe('16px');
    // Two Claude Code sessions outgrow one mark; three hosts outgrow two; "×12" outgrows "×2".
    expect(rowAgentsSlot([one(), one(TWICE.participants)])).toBe('calc(18px + var(--ib-fs-12, 12px) * 1.3)');
    expect(rowAgentsSlot([one(THREE.participants), one([session('pi', 1), session('codex', 1)])])).toBe('58px');
    const twelve = Array.from({ length: 12 }, (_, i) => session('claude-code', i));
    expect(rowAgentsSlot([one(TWICE.participants), one(twelve)])).toBe('calc(18px + var(--ib-fs-12, 12px) * 1.95)');
    expect(rowAgentsSlot([])).toBeNull();
  });

  test('Hide agent icons and one project\'s list keep the flex cell: the project starts it, or the marks are alone', () => {
    const cascade = loadCascade(CSS);
    const el = render('wide');
    el.querySelector('.ib-listcol')!.classList.add('ib-lk-noagents');
    expect(cascade.resolved(el.querySelector<HTMLElement>(`.ib-row[data-thread-id="${FOUR.thread_id}"] .ib-from`)!, 'display')).toBe('flex');
    act(() => root?.unmount());
    host?.remove();
    const one = render('wide', true);
    expect(loadCascade(CSS).resolved(one.querySelector<HTMLElement>(`.ib-row[data-thread-id="${FOUR.thread_id}"] .ib-from`)!, 'display')).toBe('flex');
  });

  test("one project's wide list: the marks alone, a run that can wrap inside its column, never one line forced over the title", () => {
    const el = render('wide', true);
    const marks = el.querySelector<HTMLElement>(`.ib-row[data-thread-id="${FOUR.thread_id}"] .ib-from > .ib-ags`)!;
    expect(marks.parentElement!.querySelector('.ib-p')).toBeNull();
    const cascade = loadCascade(CSS);
    expect(cascade.resolved(marks, 'flex-wrap')).toBe('wrap');
    expect(cascade.resolved(marks, 'max-width')).toBe('100%');
    expect(cascade.resolved(marks, 'height')).toBe('auto');
  });
});

describe.if(hasDom)("a three-line or phone row's agents", () => {
  for (const shape of LEAD_SHAPES) {
    test(`${shape}: one tile per agent, at most two, then a "+N" tile counting the other agents`, () => {
      const el = render(shape);
      expect(tiles(el, ONE.thread_id)).toEqual({ drawn: ['codex'], more: null, name: 'Codex', role: 'img' });
      expect(tiles(el, ADDRESSED.thread_id)).toEqual({ drawn: ['pi'], more: null, name: 'Pi', role: 'img' });
      // Two sessions of one host are one tile, and no "×N"; two spellings of one host are one tile too.
      expect(tiles(el, TWICE.thread_id)).toEqual({ drawn: ['claude-code'], more: null, name: '2 Claude Code sessions', role: 'img' });
      expect(tiles(el, ALIAS.thread_id).drawn).toEqual(['claude']);
      expect(tiles(el, THREE.thread_id)).toEqual({ drawn: ['claude-code', 'opencode'], more: '+1', name: 'Claude Code, OpenCode and Codex', role: 'img' });
      // Codex's second session is no tile and no "+N": "+2" is OpenCode and Pi.
      expect(tiles(el, FOUR.thread_id)).toEqual({ drawn: ['claude-code', 'codex'], more: '+2', name: 'Claude Code, 2 Codex sessions, OpenCode and Pi', role: 'img' });
      expect(tiles(el, FIVE.thread_id)).toEqual({ drawn: ['claude-code', 'codex'], more: '+3', name: 'Claude Code, Codex, OpenCode, Pi and Cursor', role: 'img' });
      for (const r of el.querySelectorAll('[data-thread-id]')) expect(r.querySelectorAll('.ib-atile:not(.ib-atmore)').length).toBeLessThanOrEqual(2);
    });

    test(`${shape}: a repeated host is one tile and never hides a different agent: Claude Code twice, then Codex, draws Claude and Codex, no "+N"`, () => {
      const el = render(shape);
      expect(tiles(el, REPEAT.thread_id)).toEqual({ drawn: ['claude-code', 'codex'], more: null, name: '2 Claude Code sessions and Codex', role: 'img' });
    });

    test(`${shape}: the row reads the project first, then its agents, as a wide row does; the tiles are drawn first`, () => {
      const el = render(shape);
      for (const [r, agents] of [
        [FIVE, 'Claude Code, Codex, OpenCode, Pi and Cursor'],
        [REPEAT, '2 Claude Code sessions and Codex'],
        [ONE, 'Codex'],
      ] as const) {
        const node = el.querySelector<HTMLElement>(`[data-thread-id="${r.thread_id}"]`)!;
        expect(accessibleName(node).startsWith(`${r.project.name} ${agents} `)).toBe(true);
      }
      // The project is first in the DOM; the tiles are drawn before it (the pixels: tests/e2e/inbox-row-lead.spec.ts).
      const tilesRun = el.querySelector<HTMLElement>(`[data-thread-id="${FIVE.thread_id}"] .ib-from > .ib-atiles`)!;
      expect(loadCascade(CSS).resolved(tilesRun, 'order')).toBe('-1');
    });

    test(`${shape}: the tiles come before the project; one name lists every agent, the hidden ones too, and no agent name is drawn as words`, () => {
      const el = render(shape);
      const r = el.querySelector<HTMLElement>(`[data-thread-id="${FIVE.thread_id}"]`)!;
      const from = r.querySelector<HTMLElement>('.ib-from')!;
      expect([...from.children].map((c) => c.className.split(' ')[0])).toEqual(['ib-p', 'ib-atiles']);
      expect(from.querySelector('.ib-p')!.textContent).toBe(LONG_PROJECT);
      // The tiles and the "+N" are for the eye: the one name stands for them.
      for (const part of r.querySelector('.ib-atiles')!.children) expect(part.getAttribute('aria-hidden')).toBe('true');
      expect(r.querySelectorAll('[role="img"][aria-label*="Cursor"]').length).toBe(1);
      expect(accessibleName(r)).toMatch(new RegExp(`^${LONG_PROJECT} Claude Code, Codex, OpenCode, Pi and Cursor (Oct 10 )?Subject msg_five`));
      for (const id of [FIVE.thread_id, FOUR.thread_id, TWICE.thread_id]) {
        const text = visibleText(el.querySelector(`[data-thread-id="${id}"]`)!);
        for (const name of ['Claude Code', 'Codex', 'OpenCode', 'Pi', 'Cursor']) expect(text).not.toContain(name);
      }
      expect(r.querySelector('[title]')).toBeNull();
      expect(r.querySelector('.ib-ags')).toBeNull();
    });

    test(`${shape}: the project never wraps: one line, cut with "…", the tiles never shrink`, () => {
      const el = render(shape);
      const cascade = loadCascade(CSS);
      const project = el.querySelector<HTMLElement>(`[data-thread-id="${FIVE.thread_id}"] .ib-from > .ib-p`)!;
      expect(cascade.resolved(project, 'white-space')).toBe('nowrap');
      expect(cascade.resolved(project, 'overflow')).toBe('hidden');
      expect(cascade.resolved(project, 'text-overflow')).toBe('ellipsis');
      expect(cascade.resolved(project, 'min-width')).toBe('0');
      const from = project.parentElement!;
      expect(cascade.resolved(from, 'display')).toBe('flex');
      expect(cascade.resolved(from, 'min-width')).toBe('0');
      expect(cascade.resolved(from.querySelector<HTMLElement>('.ib-atiles')!, 'flex')).toBe('none');
    });
  }

  test("one project's list: the tiles alone, no project", () => {
    const el = render('narrow', true);
    const from = el.querySelector<HTMLElement>(`.ib-nrow[data-thread-id="${FIVE.thread_id}"] .ib-from`)!;
    expect([...from.children].map((c) => c.className.split(' ')[0])).toEqual(['ib-atiles']);
  });

  test('beside a thread the title is never cut: whole text, plain, and a line that wraps', () => {
    const el = render('narrow');
    const title = el.querySelector<HTMLElement>(`.ib-nrow[data-thread-id="${NAMED.thread_id}"] .ib-l2 > .ib-title`)!;
    expect(title.textContent).toBe(LONG_NAME);
    const cascade = loadCascade(CSS);
    expect(cascade.resolved(title, 'white-space')).toBeUndefined();
    expect(cascade.resolved(title, 'text-overflow')).toBeUndefined();
    expect(cascade.resolved(title, 'overflow')).toBeUndefined();
    expect(cascade.resolved(title, 'overflow-wrap')).toBe('anywhere');
    // Nor its line: no clip, no single-line rule on line 2 or the row.
    for (const node of [title.parentElement!, title.closest('.ib-nrow')!]) {
      expect(cascade.resolved(node as HTMLElement, 'overflow')).toBeUndefined();
      expect(cascade.resolved(node as HTMLElement, 'white-space')).toBeUndefined();
    }
  });
});
