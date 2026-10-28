/**
 * The list on a phone: every row is a mail app's row, whatever the list's
 * width and whichever list it is. The report this guards: on an iPhone the
 * list drew the desktop's wide row (one project's list keeps it at any width,
 * and a row only went two-line once measured narrower than 900 px), whose
 * fixed count and time columns left the subject no room, so the agent's mark
 * sat under the count and the time. Pixel geometry is proved in WebKit and
 * Chromium by tests/e2e/inbox-mobile.spec.ts.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from the test.yml DOM list.
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
 * A phone row's lines. `chips`: line 3 (what the thread holds, ended by the agent's mark), or null when the row
 * has no line 3; `subjectEnd`: what ends the subject's line ('mark' when the row has no line 3).
 */
function lines(el: HTMLElement, id: string): { l1: string[]; subject: string; subjectEnd: string | null; chips: string[] | null } {
  const r = el.querySelector<HTMLElement>(`.ib-mrow[data-thread-id="${id}"]`);
  expect(r).not.toBeNull();
  const [m1, second, m3] = [...r!.children].filter((c) => !c.classList.contains('ib-sr')) as HTMLElement[];
  expect(m1!.className).toBe('ib-m1');
  const named = (c: Element) => (c.className === 'ib-mcol' ? 'mark' : c.textContent ?? '');
  const l1 = [...m1!.children].map((c) => (c.className === 'ib-mcol' ? 'mark' : `${c.className}:${c.textContent}`));
  if (second!.className === 'ib-m2end') {
    const [m2, end] = [...second!.children] as HTMLElement[];
    expect(m2!.className).toBe('ib-m2');
    expect(m3).toBeUndefined();
    return { l1, subject: m2!.textContent ?? '', subjectEnd: end ? named(end) : null, chips: null };
  }
  expect(second!.className).toBe('ib-m2');
  return { l1, subject: second!.textContent ?? '', subjectEnd: null, chips: m3 ? [...m3.children].map(named) : null };
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

  test('where and when on the first line, the subject on its own line, what the thread holds after it, ended by the mark', () => {
    const el = render(false);
    expect(lines(el, 'msg_stop')).toEqual({
      // The owner's pick (h): line 1 is the project and the time only; the agent's mark ends line 3.
      l1: ['ib-p:payments-reconciliation-service-v2', expect.stringMatching(/^ib-t:/)],
      subject: 'Subject msg_stop',
      subjectEnd: null,
      chips: ['Stopped', '2 questions', 'mark'],
    });
    // The long thread name and the guided review mark ride the third line; nothing shares the subject's line.
    expect(lines(el, 'msg_wait').chips).toEqual(['refund-webhooks-and-the-long-running-reconciliation-job', '2 questions', 'Guided review', 'mark']);
    // A Sent row says where the reply is, and has nothing to list after it: the mark ends the subject's line.
    expect(lines(el, 'msg_sent')).toEqual({
      l1: ['ib-p:payments-reconciliation-service-v2', expect.stringMatching(/^ib-t:/)],
      subject: 'Saved for Pi. It sees it when it next reads this thread.',
      subjectEnd: 'mark',
      chips: null,
    });
  });

  test("one project's list names the agent where the project was", () => {
    const el = render(true);
    expect(lines(el, 'msg_stop').l1[0]).toBe('ib-p:Claude Code');
    expect(lines(el, 'msg_sent').l1[0]).toBe('ib-p:Pi');
  });
});
