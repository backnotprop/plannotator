/**
 * The list's project column. With every project shown a wide row carries the
 * project label before the subject cell (approval "inbox-row-byline", the
 * one-line row); the agents' marks, the badge, the count and the time follow
 * in columns of their own. In one project's list (a sidebar folder) the
 * project cell is not rendered, so the row does not start with an empty
 * block. The failure this catches is the column coming back merely hidden
 * (display: none, an empty span) while the grid still reserves its width.
 * Pixel positions are proved in tests/e2e/inbox.spec.ts.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxListRow, InboxListSection } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
const { InboxList, WIDE_ROWS_MIN_LIST_WIDTH } = (hasDom ? await import('./components/InboxList') : {}) as typeof import('./components/InboxList');
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
    questions: { open: 1, picked: 0, stopped: section === 'stopped', holds_up: section === 'holding' ? ['a', 'b'] : [], prompt: null },
    waiting_on_person: true,
    project: { id: 'prj_1', name: 'billing-svc' },
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
  { id: 'holding', label: 'Holding up work', threads: [row('msg_hold', 'holding')] },
  { id: 'waiting', label: 'Waiting on you', threads: [row('msg_wait', 'waiting', { thread_name: 'refund-webhooks', guide: true })] },
  { id: 'sent', label: 'Sent', threads: [row('msg_sent', 'sent', { author: { kind: 'agent', host: 'pi', session: 'ses_b', name: null }, unread: false, sent: { at: '2026-10-10T10:01:00.000Z', checked_at: null } })] },
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
          path={filtered ? '~/src/billing-svc' : null}
          sections={SECTIONS}
          filtered={filtered}
          narrow={narrow}
          selectedThreadId={null}
          notice={null}
          onShowNew={() => {}}
          onOpen={() => {}}
        />
      </SidebarProvider>,
    );
  });
  return host;
}

function rowEl(el: HTMLElement, id: string): HTMLElement {
  const found = el.querySelector<HTMLElement>(`.ib-row[data-thread-id="${id}"]`);
  expect(found).not.toBeNull();
  return found!;
}

describe.if(hasDom)('the wide list', () => {
  test('every project: the project, the subject cell, then the marks, the badge, the count and the time in columns', () => {
    const el = render(false);
    expect(el.querySelector('.ib-listcol')!.classList.contains('ib-noproj')).toBe(false);
    for (const id of ['msg_stop', 'msg_hold', 'msg_wait', 'msg_sent']) {
      const r = rowEl(el, id);
      const cells = [...r.children];
      expect(cells.length).toBe(7);
      expect(cells[0]!.className).toBe('ib-p');
      expect(cells[0]!.textContent).toBe('billing-svc');
      expect(cells[1]!.className).toBe('ib-subj');
      // The badge and the marks sit in their own columns, never inside the subject cell; every row has every
      // cell, empty or not, so the columns line up down the list.
      expect(cells[1]!.querySelector('.ib-badge, .ib-mk')).toBeNull();
      expect(cells.slice(2).map((c) => c.className.split(' ')[0])).toEqual(['ib-cw', 'ib-mcol', 'ib-bcol', 'ib-cq', 'ib-t']);
    }
    expect(rowEl(el, 'msg_stop').children[4]!.querySelector('.ib-badge')!.textContent).toBe('Stopped');
    // The open count is ?N (from one question on), its words for a screen reader.
    expect(rowEl(el, 'msg_stop').children[5]!.querySelector('.ib-sr')!.textContent).toBe('1 question');
  });

  test("one project: no project cell; the subject cell starts the row", () => {
    const el = render(true);
    expect(el.querySelector('.ib-listcol')!.classList.contains('ib-noproj')).toBe(true);
    expect(el.querySelectorAll('.ib-row .ib-p').length).toBe(0);
    for (const id of ['msg_stop', 'msg_hold', 'msg_wait', 'msg_sent']) {
      const cells = [...rowEl(el, id).children];
      expect(cells.map((c) => c.className.split(' ')[0])).toEqual(['ib-subj', 'ib-cw', 'ib-mcol', 'ib-bcol', 'ib-cq', 'ib-t']);
    }
    // The subject cell starts with the thread chip or the subject, badge or not.
    expect(rowEl(el, 'msg_wait').querySelector('.ib-subj')!.firstElementChild!.className).toBe('ib-key');
    expect(rowEl(el, 'msg_sent').querySelector('.ib-subj')!.firstElementChild!.className).toBe('ib-s');
    // The badge keeps its own column; its words stay for a screen reader.
    for (const [id, badge] of [['msg_stop', 'Stopped'], ['msg_hold', 'Holds up 2']] as const) {
      const r = rowEl(el, id);
      expect(r.querySelector('.ib-subj .ib-badge')).toBeNull();
      expect(r.querySelector('.ib-bcol > .ib-badge')!.textContent).toBe(badge);
    }
    // The thread chip and the guided review mark stay in the subject cell.
    const wait = rowEl(el, 'msg_wait').querySelector('.ib-subj')!;
    expect(wait.querySelector('.ib-key')!.textContent).toBe('refund-webhooks');
    const mark = wait.querySelector('[data-guide-mark]')!;
    expect(mark.getAttribute('aria-label')).toBe('Guided review');
  });

  test("beside an open thread: a narrow row's first line names its agent in one project, the project in all", () => {
    let el = render(true, true);
    const l1 = (id: string) => el.querySelector<HTMLElement>(`.ib-nrow[data-thread-id="${id}"] .ib-l1 .ib-p`)!.textContent;
    expect(el.querySelectorAll('.ib-row').length).toBe(0);
    expect(l1('msg_wait')).toBe('Claude Code');
    expect(l1('msg_sent')).toBe('Pi');
    act(() => root?.unmount());
    host?.remove();
    el = render(false, true);
    expect(l1('msg_wait')).toBe('billing-svc');
    expect(l1('msg_sent')).toBe('billing-svc');
  });

  test('every project, in a list narrower than the wide row needs: two-line rows; one project keeps its wide rows', () => {
    const saved = globalThis.ResizeObserver;
    let width = 800;
    // happy-dom lays nothing out: report the list's width the way a browser's observer would.
    globalThis.ResizeObserver = class {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe() {
        // A browser's entry: the border box, and a content box 1px narrower (the column's border).
        this.callback([{ contentRect: { width: width - 1 }, borderBoxSize: [{ inlineSize: width, blockSize: 0 }] } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
      }
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    try {
      let el = render(false);
      expect(el.querySelectorAll('.ib-row').length).toBe(0);
      expect(el.querySelectorAll('.ib-nrow').length).toBe(4);
      // The guided review mark stays on the two-line row.
      expect(el.querySelector('.ib-nrow[data-thread-id="msg_wait"] [data-guide-mark]')).not.toBeNull();
      act(() => root?.unmount());
      host?.remove();
      el = render(true);
      expect(el.querySelectorAll('.ib-row').length).toBe(4);
      act(() => root?.unmount());
      host?.remove();
      width = WIDE_ROWS_MIN_LIST_WIDTH;
      el = render(false);
      expect(el.querySelectorAll('.ib-row').length).toBe(4);
    } finally {
      globalThis.ResizeObserver = saved;
    }
  });

  test('a focused row keeps focus when the list crosses the two-line width, both ways', () => {
    const saved = globalThis.ResizeObserver;
    let resize: (width: number) => void = () => {};
    // happy-dom lays nothing out: the stub reports the widths a browser's observer would.
    // Only the list's own observer (the first): a badge's card, shown while its row has keyboard focus,
    // positions itself with observers of its own.
    let listObserver = false;
    globalThis.ResizeObserver = class {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe() {
        if (listObserver) return;
        listObserver = true;
        resize = (width) =>
          this.callback([{ contentRect: { width: width - 1 }, borderBoxSize: [{ inlineSize: width, blockSize: 0 }] } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
        resize(1200);
      }
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    try {
      const el = render(false);
      const wide = el.querySelector<HTMLElement>('.ib-row[data-thread-id="msg_hold"]')!;
      wide.focus();
      expect(document.activeElement).toBe(wide);
      act(() => resize(800));
      const narrow = el.querySelector<HTMLElement>('.ib-nrow[data-thread-id="msg_hold"]');
      expect(narrow).not.toBeNull();
      expect(document.activeElement).toBe(narrow);
      act(() => resize(1000));
      expect(document.activeElement).toBe(el.querySelector('.ib-row[data-thread-id="msg_hold"]'));
      // Focus outside the list is left alone.
      const outside = document.createElement('button');
      document.body.append(outside);
      outside.focus();
      act(() => resize(800));
      expect(document.activeElement).toBe(outside);
      outside.remove();
    } finally {
      globalThis.ResizeObserver = saved;
    }
  });
});
