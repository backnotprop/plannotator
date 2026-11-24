/**
 * Show, and the "N new" bar arriving while the list is scrolled down, keep the rows on screen where they were
 * (holdView.ts). They must do it without laying out the rows out of view. Each row's box (`.ib-rw`) has
 * `content-visibility: auto` (inbox.css), so the browser skips the layout of a row out of view, and a read of the
 * geometry of anything inside that box lays the row out first. Reading every row's button that way laid out the
 * whole list on every Show and every arrival of the bar. On the soak's large Inbox (2,200 rows) that made the
 * longest main-thread task go from about 300 ms to 1.1 to 1.9 s.
 *
 * happy-dom has no layout. A stand-in gives each row and its box their place, 50 px rows in a 400 px scroll box.
 * It counts every geometry read inside the box of a row out of view: in a browser, each one is a forced layout of
 * that row. The guard counts those reads. It does not time anything.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxListRow, InboxListSection } from '@plannotator/core/inbox-types';
import type { NewsLine } from './newsWords';

const hasDom = typeof document !== 'undefined';
const { InboxList } = (hasDom ? await import('./components/InboxList') : {}) as typeof import('./components/InboxList');
const { SidebarProvider } = (hasDom ? await import('./shell/sidebar') : {}) as typeof import('./shell/sidebar');
const { hereLine } = await import('./newsWords');

const ROWS = 300;
const ROW_H = 50;
const VIEW_H = 400;
const BAR_H = 50;
const LONG_AGO = '2026-10-10T10:00:00.000Z';

let root: Root | null = null;
let host: HTMLElement | null = null;
const restore: (() => void)[] = [];

afterEach(() => {
  if (!hasDom) return;
  for (const undo of restore.splice(0)) undo();
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function row(id: string): InboxListRow {
  return {
    thread_id: id,
    project_id: 'prj_1',
    subject: `Thread ${id}`,
    author: { kind: 'agent', host: 'claude-code', session: `ses_${id}`, name: null },
    created_at: LONG_AGO,
    last_at: LONG_AGO,
    last_agent_at: LONG_AGO,
    last_author: 'agent',
    message_count: 1,
    resolved_at: null,
    questions: { open: 0, picked: 0, stopped: false, holds_up: [], prompt: null, actions: 0 },
    waiting_on_person: false,
    project: { id: 'prj_1', name: 'alpha' },
    thread_name: null,
    section: 'new',
    unread: true,
    answered_not_sent: false,
    waiting_since: null,
    unseen: 0,
    sent: null,
    guide: false,
  } as InboxListRow;
}
const SECTIONS: InboxListSection[] = [{ id: 'new', label: 'New since you looked', threads: Array.from({ length: ROWS }, (_, n) => row(`t${n}`)) }];
const REPLY = hereLine([{ id: 't0', kind: 'reply', agent: 'Claude Code', title: 'Move the webhooks to the queue', projectId: 'prj_1', project: 'alpha' }])!;

function draw(here: NewsLine | null, onShowNew: () => void = () => {}) {
  root!.render(
    <SidebarProvider>
      <div className="pn-inbox">
        <InboxList title="Inbox" path={null} sections={SECTIONS} filtered={false} narrow={false} selectedThreadId={null} notice={here ? { count: 1, project: null, here } : null} onShowNew={onShowNew} onOpen={() => {}} phone={false} rememberLook={false} />
      </div>
    </SidebarProvider>,
  );
}

/**
 * A browser's layout for the list: row n's box (`.ib-rw`) and the row in it at n × 50 px, below the bar's 50 px
 * while it is drawn, in a 400 px scroll box. No scroll anchoring. `forced` counts the geometry reads inside the box
 * of a row out of view.
 */
function layOut(body: HTMLElement) {
  let top = 0;
  Object.defineProperty(body, 'scrollTop', { configurable: true, get: () => top, set: (v: number) => void (top = v) });
  body.getBoundingClientRect = () => ({ top: 0, bottom: VIEW_H, left: 0, right: 380, width: 380, height: VIEW_H, x: 0, y: 0, toJSON() {} }) as DOMRect;
  const rect = Element.prototype.getBoundingClientRect;
  const rects = Element.prototype.getClientRects;
  const placeOf = (el: Element): DOMRect | null => {
    const id = el.getAttribute('data-thread-id') ?? el.getAttribute('data-row');
    if (id === null || !body.contains(el)) return null;
    const y = (body.querySelector('[data-held-bar]') ? BAR_H : 0) + Number(id.slice(1)) * ROW_H - top;
    return { top: y, bottom: y + ROW_H, left: 0, right: 380, width: 380, height: ROW_H, x: 0, y, toJSON() {} } as DOMRect;
  };
  const seen = { forced: 0 };
  const note = (el: Element) => {
    const box = el.closest('.ib-rw');
    if (!box || box === el) return;
    const place = placeOf(box);
    if (place && (place.bottom <= 0 || place.top >= VIEW_H)) seen.forced++;
  };
  Element.prototype.getBoundingClientRect = function (this: Element) {
    note(this);
    return placeOf(this) ?? rect.call(this);
  };
  Element.prototype.getClientRects = function (this: Element) {
    note(this);
    const place = placeOf(this);
    return (place ? [place] : rects.call(this)) as unknown as DOMRectList;
  };
  restore.push(() => {
    Element.prototype.getBoundingClientRect = rect;
    Element.prototype.getClientRects = rects;
  });
  return { seen, scrollTop: () => top };
}

function render(here: NewsLine | null) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => draw(here));
  const body = host.querySelector<HTMLElement>('.ib-lbody')!;
  // Every row is drawn, each in its own box: the stand-in's model holds.
  expect(body.querySelectorAll('.ib-rw [data-thread-id]').length).toBe(ROWS);
  return { body, ...layOut(body) };
}

test.skipIf(!hasDom)('the bar arriving while the list is scrolled down keeps the rows in place and lays out no row out of view', () => {
  const list = render(null);
  list.body.scrollTop = 5_000;
  act(() => draw(REPLY));
  expect(list.scrollTop()).toBe(5_000 + BAR_H);
  // Its news goes without Show: the rows stay put again.
  act(() => draw(null));
  expect(list.scrollTop()).toBe(5_000);
  expect(list.seen.forced).toBe(0);
});

test.skipIf(!hasDom)('Show while the list is scrolled down keeps the rows in place and lays out no row out of view', () => {
  const list = render(REPLY);
  list.body.scrollTop = 5_000;
  act(() => draw(REPLY, () => draw(null)));
  act(() => host!.querySelector<HTMLElement>('[data-inbox-notice]')!.click());
  expect(host!.querySelector('[data-held-bar]')).toBeNull();
  expect(list.scrollTop()).toBe(5_000 - BAR_H);
  expect(list.seen.forced).toBe(0);
});
