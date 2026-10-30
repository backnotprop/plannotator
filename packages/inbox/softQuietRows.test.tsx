/**
 * A Quiet row's title with Soft's quiet-text switch off (light mode, the
 * owner's pick): in the narrow list beside an open thread a Quiet title is
 * quiet text (`.ib-nrow[data-section="quiet"] .ib-title`), and in the wide
 * list a Quiet row's title takes its row's colour. The failure this catches:
 * the Soft rule for Quiet titles (`var(--ib-quiet-dim, <today's>)`) falling
 * back to the row's text colour on the narrow row, so the narrow Quiet titles
 * turned dark in light mode.
 *
 * The real list is rendered; the colour is worked out from inbox.css by
 * cssCascade.testing.ts (happy-dom does not apply the Soft switches).
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxListRow, InboxListSection } from '@plannotator/core/inbox-types';
import { loadCascade } from './cssCascade.testing';

const hasDom = typeof document !== 'undefined';
const { InboxList } = (hasDom ? await import('./components/InboxList') : {}) as typeof import('./components/InboxList');
const { SidebarProvider } = (hasDom ? await import('./shell/sidebar') : {}) as typeof import('./shell/sidebar');

const CSS = readFileSync(join(import.meta.dir, 'inbox.css'), 'utf8');
const AGENT = { kind: 'agent' as const, host: 'claude-code', session: 'ses_a', name: null };

function row(id: string, section: InboxListRow['section'], extra: Partial<InboxListRow> = {}): InboxListRow {
  return {
    thread_id: id,
    project_id: 'prj_1',
    subject: `Subject ${id}`,
    author: AGENT,
    created_at: '2026-10-10T10:00:00.000Z',
    last_at: '2026-10-10T10:00:00.000Z',
    last_author: 'agent',
    message_count: 1,
    resolved_at: null,
    questions: { open: section === 'waiting' ? 1 : 0, picked: 0, stopped: false, holds_up: [], prompt: null },
    waiting_on_person: section === 'waiting',
    project: { id: 'prj_1', name: 'billing-svc' },
    thread_name: null,
    section,
    unread: section === 'waiting',
    answered_not_sent: false,
    waiting_since: null,
    unseen: 0,
    sent: null,
    guide: false,
    ...extra,
  };
}

const SECTIONS: InboxListSection[] = [
  { id: 'waiting', label: 'Waiting on you', threads: [row('msg_wait', 'waiting')] },
  { id: 'quiet', label: 'Quiet', threads: [row('msg_quiet', 'quiet', { read_at: '2026-10-10T10:02:00.000Z' })] },
];

let root: Root | null = null;
let host: HTMLElement | null = null;
const savedClass = hasDom ? document.documentElement.className : '';

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  document.documentElement.className = savedClass;
});

/** The list in the window's own wrapper, Quiet unfolded. */
function render(narrow: boolean, mode: 'light' | 'dark'): HTMLElement {
  document.documentElement.className = mode === 'light' ? 'light' : '';
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <SidebarProvider>
        <InboxList title="Inbox" path={null} sections={SECTIONS} filtered={false} narrow={narrow} selectedThreadId={null} notice={null} onShowNew={() => {}} onOpen={() => {}} />
      </SidebarProvider>,
    );
  });
  const band = [...host.querySelectorAll<HTMLButtonElement>('button.ib-band')].find((b) => b.getAttribute('aria-expanded') === 'false');
  expect(band).toBeDefined();
  act(() => band!.click());
  return host;
}

function subject(el: HTMLElement, id: string): HTMLElement {
  const found = el.querySelector<HTMLElement>(`[data-thread-id="${id}"] .ib-title`);
  expect(found).not.toBeNull();
  return found!;
}

describe.if(hasDom)("Quiet titles with Soft's quiet text off", () => {
  test('light, narrow list: a Quiet title is quiet text', () => {
    const el = render(true, 'light');
    expect(el.querySelector('.ib-nrow[data-section="quiet"]')).not.toBeNull();
    const cascade = loadCascade(CSS);
    expect(cascade.resolved(subject(el, 'msg_quiet'), 'color')).toBe('var(--muted-foreground)');
  });

  test('light, wide list: a Quiet title keeps its row\'s colour', () => {
    const el = render(false, 'light');
    const quietRow = el.querySelector<HTMLElement>('.ib-row[data-section="quiet"]');
    expect(quietRow).not.toBeNull();
    const cascade = loadCascade(CSS);
    const own = cascade.resolved(subject(el, 'msg_quiet'), 'color');
    expect(own).toBe(cascade.resolved(quietRow!, 'color'));
    expect(own).not.toBe('var(--muted-foreground)');
  });

  test('dark (the switch on): the narrow and wide Quiet titles step back to quiet text', () => {
    for (const narrow of [true, false]) {
      const el = render(narrow, 'dark');
      const cascade = loadCascade(CSS);
      expect(cascade.resolved(subject(el, 'msg_quiet'), 'color')).toBe('var(--muted-foreground)');
      act(() => root?.unmount());
      host?.remove();
    }
  });
});
