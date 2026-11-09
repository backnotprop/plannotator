/**
 * The list renders only the rows that changed. Every list read brings new
 * row objects (JSON from the server), so InboxList memoizes each row on its
 * content: a read where one row changed renders that one row again, not all
 * of them (with thousands of threads, re-rendering every row on each agent
 * event cost hundreds of ms of main-thread work). A row's time is drawn by
 * format.shortTime once per row render, so its calls count the rows rendered.
 * The callbacks are the latest props' even for a row that did not render.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, expect, spyOn, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxListRow, InboxListSection } from '@plannotator/core/inbox-types';
import * as format from './format';

const hasDom = typeof document !== 'undefined';
const { InboxList } = (hasDom ? await import('./components/InboxList') : {}) as typeof import('./components/InboxList');
const { SidebarProvider } = (hasDom ? await import('./shell/sidebar') : {}) as typeof import('./shell/sidebar');

function row(n: number): InboxListRow {
  return {
    thread_id: `msg_${n}`,
    project_id: 'prj_1',
    subject: `Thread ${n}`,
    author: { kind: 'agent', host: 'claude-code', session: `ses_${n}`, name: null },
    created_at: '2026-10-10T10:00:00.000Z',
    last_at: '2026-10-10T10:00:00.000Z',
    last_author: 'agent',
    message_count: 1,
    resolved_at: null,
    questions: { open: 1, picked: 0, stopped: false, holds_up: [], prompt: null },
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
  };
}

/** A list read: new objects every time, the same content unless changed. */
function read(change?: (rows: InboxListRow[]) => void): InboxListSection[] {
  const rows = Array.from({ length: 20 }, (_, i) => row(i));
  change?.(rows);
  return [{ id: 'waiting', label: 'Waiting on you', threads: JSON.parse(JSON.stringify(rows)) }];
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

function draw(sections: InboxListSection[], onOpen: (row: InboxListRow) => void): void {
  act(() => {
    root!.render(
      <SidebarProvider>
        <div className="pn-inbox">
          <InboxList title="Inbox" path={null} sections={sections} filtered={false} narrow={false} selectedThreadId={null} notice={null} onShowNew={() => {}} onOpen={onOpen} />
        </div>
      </SidebarProvider>,
    );
  });
}

test.skipIf(!hasDom)('a list read renders only the rows that changed', () => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const shortTime = spyOn(format, 'shortTime');
  try {
    draw(read(), () => {});
    expect(shortTime.mock.calls.length).toBe(20);

    shortTime.mockClear();
    draw(read(), () => {});
    // Same content in new objects, and a new onOpen: no row renders again.
    expect(shortTime.mock.calls.length).toBe(0);

    shortTime.mockClear();
    draw(read((rows) => { rows[7]!.subject = 'Thread 7, revised'; rows[7]!.last_at = '2026-10-10T11:00:00.000Z'; }), () => {});
    expect(shortTime.mock.calls.length).toBe(1);
    expect(host.textContent).toContain('Thread 7, revised');
  } finally {
    shortTime.mockRestore();
  }
});

test.skipIf(!hasDom)('a row that did not render again opens with the latest onOpen', () => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const opened: string[] = [];
  draw(read(), (r) => opened.push(`first:${r.thread_id}`));
  draw(read(), (r) => opened.push(`second:${r.thread_id}`));
  act(() => {
    host!.querySelector<HTMLButtonElement>('[data-thread-id="msg_3"]')!.click();
  });
  expect(opened).toEqual(['second:msg_3']);
});

test.skipIf(!hasDom)("opening a row's right-click menu renders only that row again, and so does closing it", async () => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const sections = read();
  const drawWithMenu = () =>
    act(() => {
      root!.render(
        <SidebarProvider>
          <div className="pn-inbox">
            <InboxList
              title="Inbox"
              path={null}
              sections={sections}
              filtered={false}
              narrow={false}
              selectedThreadId={null}
              notice={null}
              onShowNew={() => {}}
              onOpen={() => {}}
              onRowAction={() => {}}
            />
          </div>
        </SidebarProvider>,
      );
    });
  drawWithMenu();
  const shortTime = spyOn(format, 'shortTime');
  try {
    const target = host.querySelector<HTMLElement>('[data-thread-id="msg_5"]')!;
    await act(async () => {
      target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 200, clientY: 100 }));
    });
    expect(document.querySelector('[data-row-menu="msg_5"]')).not.toBeNull();
    expect(host.querySelector('[data-row="msg_5"]')!.hasAttribute('data-menu')).toBe(true);
    expect(shortTime.mock.calls.length).toBe(1);

    shortTime.mockClear();
    await act(async () => {
      (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(document.querySelector('[data-row-menu]')).toBeNull();
    expect(host.querySelector('[data-row="msg_5"]')!.hasAttribute('data-menu')).toBe(false);
    expect(shortTime.mock.calls.length).toBe(1);
  } finally {
    shortTime.mockRestore();
  }
});
