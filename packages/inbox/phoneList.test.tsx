/**
 * The list on a phone: every row is a mail app's row, whatever the list's
 * width and whichever list it is. The report this guards: on an iPhone the
 * list drew the desktop's wide row (one project's list keeps it at any width,
 * and a row only went two-line once measured narrower than 900 px), whose
 * fixed count and time columns left the subject no room, so the agent's mark
 * sat under the count and the time. Pixel geometry is proved in WebKit and
 * Chromium by tests/e2e/inbox-mobile.spec.ts.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxListRow, InboxListSection } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
const { InboxList } = (hasDom ? await import('./components/InboxList') : {}) as typeof import('./components/InboxList');
const { SidebarProvider } = (hasDom ? await import('./shell/sidebar') : {}) as typeof import('./shell/sidebar');

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
    questions: { open: 2, picked: 0, stopped: section === 'stopped', holds_up: section === 'holding' ? ['a', 'b'] : [], prompt: null },
    waiting_on_person: true,
    project: { id: 'prj_1', name: 'payments-reconciliation-service-v2' },
    thread_name: null,
    section,
    unread: true,
    answered_not_sent: false,
    waiting_since: null,
    unseen: 0,
    sent: null,
    guide: false,
    ...extra,
  };
}

const SECTIONS: InboxListSection[] = [
  { id: 'stopped', label: 'Stopped on you', threads: [row('msg_stop', 'stopped')] },
  { id: 'waiting', label: 'Waiting on you', threads: [row('msg_wait', 'waiting', { thread_name: 'refund-webhooks-and-the-long-running-reconciliation-job', guide: true })] },
  { id: 'sent', label: 'Sent', threads: [row('msg_sent', 'sent', { author: { kind: 'agent', host: 'pi', session: 'ses_b', name: null }, unread: false, questions: { open: 0, picked: 0, stopped: false, holds_up: [], prompt: null }, sent: { at: '2026-10-10T10:01:00.000Z', checked_at: null } })] },
];

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function render(filtered: boolean, narrow = false): HTMLElement {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <SidebarProvider>
        <InboxList
          title={filtered ? 'billing-svc' : 'Inbox'}
          path={null}
          sections={SECTIONS}
          filtered={filtered}
          narrow={narrow}
          selectedThreadId={null}
          notice={null}
          onShowNew={() => {}}
          onOpen={() => {}}
          phone
        />
      </SidebarProvider>,
    );
  });
  return host;
}

/**
 * A phone row's two lines: line 1 (`class:text`), the subject, and what follows the subject on line 2
 * (`after`: the agent's mark as 'mark', the open count as `?N`, anything else by its text).
 */
function lines(el: HTMLElement, id: string): { l1: string[]; subject: string; after: string[] } {
  const r = el.querySelector<HTMLElement>(`.ib-mrow[data-thread-id="${id}"]`);
  expect(r).not.toBeNull();
  const [m1, l2, ...rest] = [...r!.children].filter((c) => !c.classList.contains('ib-sr')) as HTMLElement[];
  expect([m1!.className, l2!.className]).toEqual(['ib-m1', 'ib-ml2']);
  expect(rest).toEqual([]);
  const [subject, ...after] = [...l2!.children];
  expect(subject!.className).toBe('ib-m2');
  const named = (c: Element) => (c.className === 'ib-mcol' ? 'mark' : c.classList.contains('ib-qn') ? `?${c.getAttribute('data-open-count')}` : c.textContent ?? '');
  const l1 = [...m1!.children].map((c) => `${c.className}:${c.textContent}`);
  return { l1, subject: subject!.textContent ?? '', after: after.map(named) };
}

describe.if(hasDom)('the list on a phone', () => {
  test('every list, every width: mail rows only, never the wide row or the desktop two-line row', () => {
    for (const [filtered, narrow] of [[false, false], [true, false], [false, true], [true, true]] as const) {
      const el = render(filtered, narrow);
      expect(el.querySelectorAll('.ib-mrow').length).toBe(3);
      expect(el.querySelectorAll('.ib-row, .ib-nrow').length).toBe(0);
      act(() => root?.unmount());
      host?.remove();
    }
  });

  test('two lines: where, the thread and when; then the subject, the marks, the badge and the count at its end', () => {
    const el = render(false);
    expect(lines(el, 'msg_stop')).toEqual({
      // Line 1 is the project and the time; line 2 the subject, then the mark, the badge and ?N last (approval "inbox-row-byline").
      l1: ['ib-pw:payments-reconciliation-service-v2', expect.stringMatching(/^ib-t:/)],
      subject: 'Subject msg_stop',
      after: ['mark', 'Stopped', '?2'],
    });
    // The long thread name joins line 1, before the time; the guided review book follows the subject.
    const wait = lines(el, 'msg_wait');
    expect(wait.l1).toEqual(['ib-pw:payments-reconciliation-service-v2', 'ib-key:refund-webhooks-and-the-long-running-reconciliation-job', expect.stringMatching(/^ib-t:/)]);
    expect(wait.after).toEqual(['', 'mark', '?2']);
    expect(el.querySelector('.ib-mrow[data-thread-id="msg_wait"] .ib-ml2 > [data-guide-mark]')!.getAttribute('aria-label')).toBe('Guided review');
    // A Sent row says where the reply is; its agent's mark ends line 2.
    expect(lines(el, 'msg_sent')).toEqual({
      l1: ['ib-pw:payments-reconciliation-service-v2', expect.stringMatching(/^ib-t:/)],
      subject: 'Saved for Pi. It sees it when it next reads this thread.',
      after: ['mark'],
    });
  });

  test("one project's list names the agent where the project was", () => {
    const el = render(true);
    expect(lines(el, 'msg_stop').l1[0]).toBe('ib-pw:Claude Code');
    expect(lines(el, 'msg_sent').l1[0]).toBe('ib-pw:Pi');
  });
});
