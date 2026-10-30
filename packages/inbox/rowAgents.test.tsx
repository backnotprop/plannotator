/**
 * The agents in a list row (approval "list-rows-mail-icons", 2026-10-30): one
 * bare mark per agent host after the project, first to join first; a host
 * with two or more sessions is one mark and "×N"; past three hosts, two marks
 * and "+N" counting the sessions not drawn; one accessible name that lists
 * every agent, the hidden ones too, and no agent name drawn as words. The
 * failures this catches: a repeated logo for two sessions of one host, a cap
 * that drops an agent from the row's name, an agent name in visible text, and
 * a narrow row's title cut instead of wrapped. Pixels (the 320 px phone, a long
 * project) are proved in tests/e2e/inbox-row-badges.spec.ts.
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
const SECTIONS: InboxListSection[] = [{ id: 'waiting', label: 'Waiting on you', threads: [ONE, TWICE, THREE, FOUR, ALIAS, ADDRESSED, NAMED] }];

type Shape = 'wide' | 'narrow' | 'phone';
const SHAPES: Shape[] = ['wide', 'narrow', 'phone'];

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

/** A row's marks as drawn: each group's host and its "×N", then "+N" when present. */
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

describe.if(hasDom)("a row's agents", () => {
  for (const shape of SHAPES) {
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
      // The row's name starts with where and who (then the time on line 1 beside a thread and on a phone), then the title.
      expect(accessibleName(r)).toMatch(/^billing-svc Claude Code, 2 Codex sessions, OpenCode and Pi (Oct 10 )?Subject msg_four/);
      // No agent's name in the row's words (the marks say who), and no native title.
      for (const id of [FOUR.thread_id, ONE.thread_id, TWICE.thread_id]) {
        const text = visibleText(el.querySelector(`[data-thread-id="${id}"]`)!);
        for (const name of ['Claude Code', 'Codex', 'OpenCode', 'Pi']) expect(text).not.toContain(name);
      }
      expect(r.querySelector('[title]')).toBeNull();
      // The marks sit after the project, never in a column of their own.
      expect(r.querySelector('.ib-from > .ib-p + .ib-ags')).not.toBeNull();
      expect(r.querySelectorAll('.ib-ags').length).toBe(1);
    });
  }

  test("one project's wide list: the marks alone, a run that can wrap inside its column, never one line forced over the title", () => {
    const el = render('wide', true);
    const marks = el.querySelector<HTMLElement>(`.ib-row[data-thread-id="${FOUR.thread_id}"] .ib-from > .ib-ags`)!;
    expect(marks.parentElement!.querySelector('.ib-p')).toBeNull();
    const cascade = loadCascade(CSS);
    expect(cascade.resolved(marks, 'flex-wrap')).toBe('wrap');
    expect(cascade.resolved(marks, 'max-width')).toBe('100%');
    expect(cascade.resolved(marks, 'height')).toBe('auto');
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
    // The project on line 1 wraps too, and its marks follow it in the same run of text.
    const project = el.querySelector<HTMLElement>(`.ib-nrow[data-thread-id="${NAMED.thread_id}"] .ib-l1 .ib-from > .ib-p`)!;
    expect(cascade.resolved(project, 'white-space')).toBeUndefined();
    expect(cascade.resolved(project, 'overflow-wrap')).toBe('anywhere');
    expect(cascade.resolved(project.parentElement!, 'display')).toBeUndefined();
  });
});
