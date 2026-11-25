/**
 * This computer's Inbox never sends Tagged you (a Spaces server's section only), and a list without it draws exactly
 * as it did before the section existed. What is proved, on the window's own InboxList fed by the list builder
 * (shared/inbox/list.ts `inboxListSections`, one row in each of this Inbox's sections): the structure of the list
 * (every element, its classes and attributes, never its words) on a wide window, beside a thread and on a phone is
 * the one recorded in listLocalUnchanged.structure.txt, which was drawn by the window before Tagged you was added.
 * A change to the list's look changes it too: draw it again with this test's `structure` and say why in the PR.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, setSystemTime, test } from 'bun:test';
import { act } from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxListRow, InboxListSection, InboxSectionId } from '@plannotator/core/inbox-types';
import { inboxListSections } from '../shared/inbox/list';

const hasDom = typeof document !== 'undefined';
const { InboxList } = (hasDom ? await import('./components/InboxList') : {}) as typeof import('./components/InboxList');
const { SidebarProvider } = (hasDom ? await import('./shell/sidebar') : {}) as typeof import('./shell/sidebar');
const { setStorageBackend, resetStorageBackend } = await import('@plannotator/ui/utils/storage');

const NOW = new Date('2026-11-25T15:00:00.000Z');
const AT = '2026-11-25T14:00:00.000Z';
let root: Root | null = null;
let host: HTMLElement | null = null;
const stored = new Map<string, string>();
beforeEach(() => {
  setSystemTime(NOW);
  stored.clear();
  setStorageBackend({ getItem: (key) => stored.get(key) ?? null, setItem: (key, value) => void stored.set(key, value), removeItem: (key) => void stored.delete(key) });
});
afterEach(() => {
  setSystemTime();
  if (!hasDom) return;
  act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  document.body.innerHTML = '';
  resetStorageBackend();
});

function row(id: string, section: InboxSectionId): InboxListRow {
  return {
    thread_id: id,
    project_id: 'prj_1',
    subject: `Thread ${id}`,
    author: { kind: 'agent', host: 'claude-code', session: `ses_${id}`, name: null },
    created_at: AT,
    last_at: AT,
    last_agent_at: AT,
    last_author: 'agent',
    message_count: 2,
    resolved_at: null,
    questions: { open: section === 'quiet' || section === 'new' || section === 'sent' ? 0 : 1, picked: 0, stopped: section === 'stopped', holds_up: section === 'holding' ? ['the release'] : [], prompt: null, actions: 0 },
    waiting_on_person: section === 'stopped' || section === 'holding' || section === 'waiting',
    project: { id: 'prj_1', name: 'harbor' },
    thread_name: null,
    latest_preview: `Latest in ${id}`,
    section,
    unread: section !== 'quiet' && section !== 'sent',
    answered_not_sent: false,
    waiting_since: section === 'quiet' || section === 'new' || section === 'sent' ? null : AT,
    unseen: section === 'quiet' || section === 'sent' ? 0 : 1,
    sent: section === 'sent' ? { at: AT, checked_at: null } : null,
    guide: false,
  } as InboxListRow;
}

/** This Inbox's answer: one row in each section it places rows in. */
const LOCAL = inboxListSections((['stopped', 'holding', 'waiting', 'new', 'sent', 'quiet'] as const).map((id) => row(`t_${id}`, id)));

function draw(list: InboxListSection[], shape: { narrow: boolean; phone?: boolean }): void {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <SidebarProvider>
        <div className="pn-inbox">
          <InboxList title="Inbox" path={null} sections={list} filtered={false} narrow={shape.narrow} phone={shape.phone} selectedThreadId={null} notice={null} onShowNew={() => {}} onOpen={() => {}} />
        </div>
      </SidebarProvider>,
    );
  });
}

/** Attributes that carry words: left out, so the structure is the elements and their marks alone. */
const WORDS = new Set(['aria-label', 'title', 'alt', 'placeholder', 'aria-description', 'aria-valuetext', 'data-count-words']);

function structure(el: Element, depth = 0, out: string[] = []): string[] {
  const attrs = [...el.attributes].filter((a) => !WORDS.has(a.name)).map((a) => `${a.name}="${a.value}"`).sort();
  out.push(`${'  '.repeat(depth)}<${el.tagName.toLowerCase()}${attrs.length ? ` ${attrs.join(' ')}` : ''}>`);
  for (const child of el.children) structure(child, depth + 1, out);
  return out;
}

function drawnStructure(): string {
  const parts: string[] = [];
  for (const [name, shape] of [['wide', { narrow: false }], ['beside a thread', { narrow: true }], ['phone', { narrow: true, phone: true }]] as const) {
    draw(LOCAL, shape);
    parts.push(`== ${name}`, ...structure(host!));
    act(() => root?.unmount());
    host?.remove();
    host = null;
    root = null;
  }
  return `${parts.join('\n')}\n`;
}

test.skipIf(!hasDom)('the list builder never sends Tagged you, and the list draws as it did before the section existed', () => {
  expect(LOCAL.map((section) => section.id)).toEqual(['stopped', 'holding', 'waiting', 'new', 'sent', 'quiet']);
  expect(drawnStructure()).toBe(readFileSync(join(import.meta.dir, 'listLocalUnchanged.structure.txt'), 'utf8'));
});
