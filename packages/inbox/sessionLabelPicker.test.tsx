/**
 * The To picker's session labels (approval "inbox-session-label"), as the
 * picker draws them. The failures this catches: a label that does not replace
 * the project on its row, a row without a label that loses its words, the
 * phone's second line without its project, the filter not finding a label, and
 * a " · " inside a label being split like a project's parents (the To line would
 * then cut the label's own words first).
 *
 * The geometry (one line, cut with an ellipsis, columns that line up) needs a
 * real layout: tests/e2e/inbox-session-label.spec.ts, on the compiled binary.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxComposeProject } from '@plannotator/core/inbox-types';
import { composeGroups } from './compose/model';

const hasDom = typeof document !== 'undefined';
const { SessionDetail, ToPicker } = (hasDom ? await import('./compose/ToPicker') : {}) as typeof import('./compose/ToPicker');
const { NewCardDialog } = (hasDom ? await import('./board/NewCardDialog') : {}) as typeof import('./board/NewCardDialog');

const PROJECT = { id: 'prj_1', name: 'ai-collab', root: '/home/me/src/ai-collab' };

function session(id: string, host: string, label?: string) {
  return { session: id, host, started_at: '2026-11-01T10:54:00.000Z', last_seen_at: '2026-11-01T10:55:00.000Z', busy: false, idle_since: null, last_thread: null, ...(label ? { label } : {}) };
}

const projects: InboxComposeProject[] = [
  {
    project: PROJECT,
    sessions: [session('ses_named', 'claude-code', 'Fix login redirect'), session('ses_cjk', 'pi', '冲突筛查圆桌 · kelu'), session('ses_plain', 'claude-code')],
  },
];

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

function render(node: React.ReactNode) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(node));
}

function picker(phone = false, onPick: (session: string) => void = () => {}) {
  render(<ToPicker groups={composeGroups(projects, null)} selected={null} home="/home/me" phone={phone} onPick={(target) => onPick(target.session)} onClose={() => {}} />);
}

const row = (session: string) => host!.querySelector<HTMLElement>(`[role="option"][data-compose-session="${session}"]`);
const rows = () => [...host!.querySelectorAll<HTMLElement>('[role="option"]')].map((option) => option.getAttribute('data-compose-session'));
const words = (option: Element, selector: string) => option.querySelector(selector)?.textContent ?? null;

function type(text: string) {
  const input = host!.querySelector('input') as HTMLInputElement;
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    set.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

test.skipIf(!hasDom)("a label takes the project's place on its row; the folder stays, and a row with none keeps its words", () => {
  picker();
  const named = row('ses_named')!;
  expect(words(named, '.ib-cp-op')).toBe('Fix login redirect');
  expect(named.textContent).not.toContain('ai-collab · ');
  expect(words(named, '.ib-cp-of')).toBe('~/src/ai-collab');
  const plain = row('ses_plain')!;
  expect(words(plain, '.ib-cp-op')).toBe('ai-collab');
  expect(plain.querySelector('[data-session-label]')).toBeNull();
  expect(words(plain, '.ib-cp-of')).toBe('~/src/ai-collab');
});

test.skipIf(!hasDom)('the accessible name says the label and still names the project and folder', () => {
  picker();
  const name = row('ses_named')!.getAttribute('aria-label')!;
  for (const part of ['Claude Code', 'Fix login redirect', 'in ai-collab', '~/src/ai-collab']) expect(name).toContain(part);
  // Pinned on purpose: a row without a label reads exactly as before this feature.
  expect(row('ses_plain')!.getAttribute('aria-label')!.startsWith('Claude Code in ai-collab, ~/src/ai-collab')).toBe(true);
});

test.skipIf(!hasDom)('a phone shows the label, then the project, on the second line', () => {
  picker(true);
  expect(words(row('ses_named')!, '.ib-cp-op')).toBe('Fix login redirect · ai-collab');
  expect(words(row('ses_cjk')!, '.ib-cp-op')).toBe('冲突筛查圆桌 · kelu · ai-collab');
  expect(words(row('ses_plain')!, '.ib-cp-op')).toBe('ai-collab');
});

test.skipIf(!hasDom)('the list says it holds a label only while a row on it has one: filtered down to none, the columns are as before', () => {
  picker();
  const list = host!.querySelector('[role="listbox"]')!;
  expect(list.hasAttribute('data-session-labels')).toBe(true);
  type('ses_nothing_matches_this');
  expect(rows()).toEqual([]);
  expect(list.hasAttribute('data-session-labels')).toBe(false);
});

test.skipIf(!hasDom)('the filter finds a label, any word of it, in any case and any script', () => {
  picker();
  type('login');
  expect(rows()).toEqual(['ses_named']);
  type('REDIRECT fix');
  expect(rows()).toEqual(['ses_named']);
  type('圆桌');
  expect(rows()).toEqual(['ses_cjk']);
  // The project still matches every row, labelled or not.
  type('ai-collab');
  expect(rows()).toEqual(['ses_named', 'ses_cjk', 'ses_plain']);
});

test.skipIf(!hasDom)('a pick names the session, whatever the row reads', () => {
  const picked: string[] = [];
  picker(false, (id) => picked.push(id));
  act(() => row('ses_named')!.click());
  expect(picked).toEqual(['ses_named']);
});

test.skipIf(!hasDom)('To reads the label then the project, and a " · " in the label stays in the label', () => {
  render(<SessionDetail name="main · workspaces/worktrees" root="/w/main" label="冲突筛查圆桌 · kelu" />);
  const detail = host!.querySelector('[data-compose-detail]')!;
  expect(detail.textContent).toBe('· 冲突筛查圆桌 · kelu · main · workspaces/worktrees');
  // The label is the part that stays whole; the project gives way first, as a parent folder does.
  expect(detail.querySelector('.ib-cp-tdf')!.textContent).toBe('冲突筛查圆桌 · kelu');
  expect(detail.querySelector('.ib-cp-tdp bdi')!.textContent).toBe('main · workspaces/worktrees');
});

test.skipIf(!hasDom)('To with no label splits the project as it always did', () => {
  render(<SessionDetail name="main · workspaces/worktrees" root="/w/main" />);
  const detail = host!.querySelector('[data-compose-detail]')!;
  expect(detail.querySelector('.ib-cp-tdf')!.textContent).toBe('main');
  expect(detail.querySelector('.ib-cp-tdp bdi')!.textContent).toBe('workspaces/worktrees');
});

test.skipIf(!hasDom)("the Board's New card shares the picker, and its To line says the pick's label too", () => {
  const folder = { ...PROJECT, key: 'ai-collab-1a2b3c', created_at: '2026-11-01T10:00:00.000Z', threads: 0, unread: 0 };
  render(<NewCardDialog projects={[folder]} defaultProject={PROJECT.id} sessions={{ serverSession: 'srv', home: '/home/me', projects }} home="/home/me" phone={false} initialMode="send" onClose={() => {}} onCreate={async () => null} />);
  const to = () => document.querySelector<HTMLElement>('[data-compose-to]')!;
  const pick = (session: string) => {
    act(() => to().click());
    act(() => document.querySelector<HTMLElement>(`[role="option"][data-compose-session="${session}"]`)!.click());
  };

  pick('ses_named');
  expect(to().getAttribute('aria-label')).toBe('To: Claude Code, Fix login redirect, in ai-collab. Change');
  expect(document.querySelector('[data-compose-detail]')!.textContent).toBe('· Fix login redirect · ai-collab');

  pick('ses_plain');
  expect(to().getAttribute('aria-label')).toBe('To: Claude Code in ai-collab. Change');
  expect(document.querySelector('[data-compose-detail] [data-session-label]')).toBeNull();
});
