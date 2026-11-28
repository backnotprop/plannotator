/**
 * Tagged you, from a Spaces server's answer (this computer's Inbox never sends it): the window draws it as it draws
 * every section it is given. What is proved, on the window's own InboxList: the group sits fourth, after Waiting on
 * you and before New since you looked; its row is the list's own row (the same elements and marks as the same row
 * drawn in New, on a wide window, beside a thread and on a phone), so it has no look of its own; and its header
 * closes and opens it as any group's does.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, setSystemTime, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { INBOX_SECTIONS, type InboxListRow, type InboxListSection, type InboxSectionId } from '@plannotator/core/inbox-types';

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

/** A thread Charlie Dunn was tagged in by another person, and the agents' rows around it. */
function row(id: string, section: InboxSectionId): InboxListRow {
  const person = section === 'tagged';
  return {
    thread_id: id,
    project_id: 'prj_1',
    subject: `Thread ${id}`,
    author: person ? { kind: 'person' } : { kind: 'agent', host: 'claude-code', session: `ses_${id}`, name: null },
    created_at: AT,
    last_at: AT,
    last_agent_at: AT,
    last_author: person ? 'person' : 'agent',
    message_count: 2,
    resolved_at: null,
    questions: { open: section === 'waiting' ? 1 : 0, picked: 0, stopped: false, holds_up: [], prompt: null, actions: 0 },
    waiting_on_person: section === 'waiting',
    project: { id: 'prj_1', name: 'Field notes' },
    thread_name: null,
    latest_preview: 'Can you check the store subtitle before Tuesday?',
    section,
    unread: true,
    answered_not_sent: false,
    waiting_since: section === 'waiting' ? AT : null,
    unseen: 1,
    sent: null,
    guide: false,
  } as InboxListRow;
}

const label = (id: InboxSectionId) => INBOX_SECTIONS.find((section) => section.id === id)!.label;
const answer = (rows: InboxListRow[]): InboxListSection[] => INBOX_SECTIONS.map(({ id }) => ({ id, label: label(id), threads: rows.filter((r) => r.section === id) }));

function draw(list: InboxListSection[], shape: { narrow: boolean; phone?: boolean } = { narrow: false }): void {
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

function redraw(list: InboxListSection[], shape: { narrow: boolean; phone?: boolean }): void {
  act(() => root?.unmount());
  host?.remove();
  draw(list, shape);
}

/** A row's elements and marks, never its words; its section's own mark left out. */
function shape(el: Element): string {
  const attrs = [...el.attributes].filter((a) => a.name !== 'data-section' && a.name !== 'aria-label' && a.name !== 'title').map((a) => `${a.name}=${a.name === 'data-thread-id' ? '' : a.value}`).sort();
  return `<${el.tagName.toLowerCase()} ${attrs.join(' ')}>${[...el.children].map(shape).join('')}</>`;
}

const drawnGroups = () => [...host!.querySelectorAll<HTMLElement>('[data-section-id]')].map((group) => group.dataset.sectionId);
const rowOf = (id: string) => host!.querySelector<HTMLElement>(`[data-thread-id="${id}"]`)!;

test.skipIf(!hasDom)('Tagged you is drawn fourth: after Waiting on you, before New since you looked', () => {
  draw(answer([row('t_wait', 'waiting'), row('t_tag', 'tagged'), row('t_new', 'new')]));
  expect(drawnGroups()).toEqual(['waiting', 'tagged', 'new']);
  expect(rowOf('t_tag').closest('[data-section-id]')!.getAttribute('data-section-id')).toBe('tagged');
});

test.skipIf(!hasDom)('its row is the list’s own row, on every shape', () => {
  for (const look of [{ narrow: false }, { narrow: true }, { narrow: true, phone: true }]) {
    redraw(answer([row('t_tag', 'tagged')]), look);
    const tagged = shape(rowOf('t_tag'));
    redraw(answer([{ ...row('t_tag', 'tagged'), section: 'new' }]), look);
    expect(tagged).toBe(shape(rowOf('t_tag')));
  }
});

test.skipIf(!hasDom)('its header closes and opens it as any group’s', () => {
  draw(answer([row('t_tag', 'tagged')]));
  const header = () => host!.querySelector<HTMLButtonElement>('[data-section-id="tagged"] > .ib-band')!;
  expect(header().getAttribute('aria-expanded')).toBe('true');
  act(() => header().click());
  expect(header().getAttribute('aria-expanded')).toBe('false');
  expect(host!.querySelector('[data-thread-id="t_tag"]')).toBeNull();
  act(() => header().click());
  expect(header().getAttribute('aria-expanded')).toBe('true');
  expect(rowOf('t_tag')).not.toBeNull();
});
