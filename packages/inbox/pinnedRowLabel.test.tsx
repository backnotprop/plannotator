/**
 * What a pinned row calls its thread (owner ask, 2026-10-29): the thread's name
 * when it has one, the subject otherwise, by the list's own rule
 * (`threadChipName`). The failures this catches: a named thread's pin that
 * still shows the first message's subject, an unnamed one that shows nothing,
 * a pin that keeps the old name after a rename, and a tooltip or accessible
 * name that loses the subject the row no longer shows.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxListRow } from '@plannotator/core/inbox-types';
import { tooltipOf } from './testing/tooltip';

const hasDom = typeof document !== 'undefined';
const { PinnedRow } = (hasDom ? await import('./components/PinnedRow') : {}) as typeof import('./components/PinnedRow');

const SUBJECT = 'The refresh guard is in and the old retry loop is gone.';

function row(threadName: string | null, subject = SUBJECT): InboxListRow {
  return {
    thread_id: 'msg_P1',
    project_id: 'prj_1',
    subject,
    author: { kind: 'agent', host: 'claude-code', session: 'ses_a', name: 'Claude Code' },
    created_at: '2026-10-20T18:10:00.000Z',
    last_at: '2026-10-20T18:10:00.000Z',
    last_author: 'agent',
    message_count: 1,
    resolved_at: null,
    questions: { open: 0, picked: 0, stopped: false, holds_up: [], prompt: null },
    waiting_on_person: false,
    project: { id: 'prj_1', name: 'billing-web' },
    thread_name: threadName,
    section: 'quiet',
    unread: false,
    answered_not_sent: false,
    waiting_since: null,
    unseen: 0,
    sent: null,
    pinned_at: '2026-10-21T09:00:00.000Z',
  } as unknown as InboxListRow;
}

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function draw(r: InboxListRow) {
  if (!root) {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  }
  act(() => {
    root!.render(
      <div className="pn-inbox">
        <PinnedRow row={r} on={false} first last phone={false} onOpen={() => {}} onAction={() => {}} />
      </div>,
    );
  });
}

const button = () => host!.querySelector<HTMLElement>('[data-pinned-row]')!;
const shown = () => button().querySelector('.ib-name')!.textContent;

test.skipIf(!hasDom)('a named thread pins by its name, an unnamed one by its subject', () => {
  draw(row('session-refresh'));
  expect(shown()).toBe('session-refresh');
  expect(button().getAttribute('aria-label')!.startsWith('session-refresh, ')).toBe(true);
  draw(row(null));
  expect(shown()).toBe(SUBJECT);
});

test.skipIf(!hasDom)('a rename updates the pin, and removing the name returns the subject', () => {
  draw(row('session-refresh'));
  draw(row('refresh-guard'));
  expect(shown()).toBe('refresh-guard');
  draw(row(null));
  expect(shown()).toBe(SUBJECT);
});

test.skipIf(!hasDom)('the name leads the accessible name and the tooltip, and the subject is kept in both', async () => {
  draw(row('session-refresh'));
  expect(button().getAttribute('aria-label')).toContain(`session-refresh, ${SUBJECT}, billing-web`);
  const tip = await tooltipOf(button());
  expect(tip).not.toBeNull();
  expect(tip!.startsWith('session-refresh')).toBe(true);
  expect(tip).toContain(SUBJECT);
  expect(tip).toContain('billing-web');
});

test.skipIf(!hasDom)('a subject that already starts with the name is shown once, as the list does', () => {
  draw(row('the refresh guard'));
  expect(shown()).toBe(SUBJECT);
  expect(button().getAttribute('aria-label')!.split(SUBJECT).length).toBe(2);
});

test.skipIf(!hasDom)('a whitespace-only name falls back to the subject', () => {
  draw(row('   '));
  expect(shown()).toBe(SUBJECT);
  expect(button().getAttribute('aria-label')!.split(SUBJECT).length).toBe(2);
});

test.skipIf(!hasDom)('a name that only starts the subject mid-word still shows, with the subject kept', () => {
  draw(row('search', 'Searchable index: postings moved'));
  expect(shown()).toBe('search');
  expect(button().getAttribute('aria-label')).toContain('search, Searchable index: postings moved, billing-web');
});

test.skipIf(!hasDom)("the pin's ⋯ is labelled with the same label as the row", () => {
  draw(row('session-refresh'));
  expect(host!.querySelector('[data-pin-more]')!.getAttribute('aria-label')).toBe('session-refresh options');
  draw(row(null));
  expect(host!.querySelector('[data-pin-more]')!.getAttribute('aria-label')).toBe(`${SUBJECT} options`);
});
