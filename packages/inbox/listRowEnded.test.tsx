import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxListRow } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
const { InboxList } = (hasDom ? await import('./components/InboxList') : {}) as typeof import('./components/InboxList');
const { SidebarProvider } = (hasDom ? await import('./shell/sidebar') : {}) as typeof import('./shell/sidebar');

function row(extra: Partial<InboxListRow>): InboxListRow {
  return {
    thread_id: 'msg_1',
    project_id: 'prj_1',
    subject: 'Retry policy',
    author: { kind: 'agent', host: 'claude-code', session: 'ses_1', name: null },
    created_at: '2026-10-10T10:00:00.000Z',
    last_at: '2026-10-10T10:00:00.000Z',
    last_author: 'agent',
    message_count: 1,
    resolved_at: null,
    questions: { open: 2, picked: 0, stopped: false, holds_up: [], prompt: null, actions: 0 },
    waiting_on_person: true,
    project: { id: 'prj_1', name: 'plannotator' },
    thread_name: null,
    section: 'waiting',
    unread: true,
    answered_not_sent: false,
    waiting_since: null,
    unseen: 0,
    sent: null,
    guide: false,
    ...extra,
  } as InboxListRow;
}

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
});

function render(listed: InboxListRow) {
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(
      <SidebarProvider>
        <div className="pn-inbox">
          <InboxList
            title="Inbox"
            path={null}
            sections={[{ id: listed.section, label: 'Waiting on you', threads: [listed] }]}
            filtered={false}
            narrow={false}
            selectedThreadId={null}
            notice={null}
            onShowNew={() => {}}
            onOpen={() => {}}
            pinned={new Set()}
          />
        </div>
      </SidebarProvider>,
    );
  });
  return host;
}

test.skipIf(!hasDom)('a marked row says Session ended beside its open questions', () => {
  const el = render(row({ session_ended: true }));
  expect(el.querySelector('[data-row-ended]')?.textContent).toBe('Session ended');
  expect(el.querySelector('.ib-row')?.textContent).toContain('2 questions');
});

test.skipIf(!hasDom)('a row the server did not mark says nothing about it', () => {
  const el = render(row({}));
  expect(el.querySelector('[data-row-ended]')).toBeNull();
  expect(el.textContent).not.toContain('Session ended');
});
