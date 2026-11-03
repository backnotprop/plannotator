/**
 * A list row's tooltips mount on first use (RowTip.tsx; .ops/perf/open-thread-xl.md, fix 2): drawing every row's
 * tooltips with the rows was most of the cost of opening a thread from a long list. What is proved: drawing the rows
 * adds no hover listener; the pointer's first entry still opens the tooltip after the delay, from a trigger drawn
 * the same as before; rows drawn again under a pointer at rest (the browser's own mouseenter, no pointer event) open
 * nothing until the pointer moves, then open as before; a Tab from a row onto its hover action keeps focus there and
 * shows the action's tooltip; a touch never draws a trigger again (it would be under the finger mid-tap).
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxListRow } from '@plannotator/core/inbox-types';
import { hover, openTooltips, settle, unhover } from './testing/tooltip';

const hasDom = typeof document !== 'undefined';
const { InboxList } = (hasDom ? await import('./components/InboxList') : {}) as typeof import('./components/InboxList');
const { SidebarProvider } = (hasDom ? await import('./shell/sidebar') : {}) as typeof import('./shell/sidebar');

function row(id: string, read: boolean): InboxListRow {
  return {
    thread_id: id,
    project_id: 'prj_1',
    subject: `Subject of ${id}`,
    author: { kind: 'agent', host: 'claude-code', session: 'ses_a', name: null },
    created_at: '2026-10-10T10:00:00.000Z',
    last_at: '2026-10-10T10:00:00.000Z',
    last_author: 'agent',
    message_count: 1,
    resolved_at: null,
    questions: { open: read ? 0 : 1, picked: 0, stopped: false, holds_up: [], prompt: null },
    waiting_on_person: !read,
    project: { id: 'prj_1', name: 'plannotator' },
    thread_name: null,
    // A read row the list still holds in New: its hover action is Mark unread.
    section: read ? 'new' : 'waiting',
    unread: !read,
    read_at: read ? '2026-10-10T11:00:00.000Z' : null,
    answered_not_sent: false,
    waiting_since: null,
    unseen: 0,
    sent: null,
    guide: false,
  };
}

const ROWS = Array.from({ length: 12 }, (_, i) => row(`msg_${i}`, i % 2 === 1));

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  for (const node of document.body.querySelectorAll('[data-base-ui-portal], [role="presentation"]')) node.remove();
  root = null;
  host = null;
});

function render(narrow: boolean): HTMLElement {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <SidebarProvider>
        <div className="pn-inbox">
          <InboxList
            title="Inbox"
            path={null}
            sections={[
              { id: 'waiting', label: 'Waiting on you', threads: ROWS.filter((r) => r.unread) },
              { id: 'new', label: 'New', threads: ROWS.filter((r) => !r.unread) },
            ]}
            filtered={false}
            narrow={narrow}
            selectedThreadId={null}
            notice={null}
            onShowNew={() => {}}
            onOpen={() => {}}
            onMarkUnread={() => {}}
            phone={false}
          />
        </div>
      </SidebarProvider>,
    );
  });
  return host;
}

/** An element's attributes, base-ui's generated `id` left out (no style or test reads it). */
const attributes = (el: Element) =>
  [...el.attributes]
    .filter((a) => a.name !== 'id')
    .map((a) => `${a.name}=${a.value}`)
    .sort();

for (const narrow of [false, true]) {
  test.skipIf(!hasDom)(`drawing ${narrow ? 'three-line' : 'wide'} rows adds no hover listener; the first entry opens the tooltip from a trigger drawn the same`, async () => {
    // Hover listeners added on anything inside a row (the list's header keeps its own tooltips).
    const added: string[] = [];
    // The prototype a DOM element takes addEventListener from (happy-dom's own EventTarget, not the global one).
    let owner: object = document.createElement('span');
    while (!Object.prototype.hasOwnProperty.call(owner, 'addEventListener')) owner = Object.getPrototypeOf(owner);
    const target = owner as { addEventListener: (...args: unknown[]) => void };
    const real = target.addEventListener;
    target.addEventListener = function (this: unknown, ...args: unknown[]) {
      if (this instanceof Element && this.closest('.ib-rw')) added.push(String(args[0]));
      return real.apply(this, args);
    };
    let el: HTMLElement;
    try {
      el = render(narrow);
    } finally {
      target.addEventListener = real;
    }
    // Before: every row's tiles, ticks and counts drew a tooltip with four hover listeners each.
    expect(added.filter((t) => t === 'mouseenter' || t === 'mouseleave')).toEqual([]);
    const tiles = () => el.querySelector<HTMLElement>(`[data-thread-id="msg_0"] [data-row-agents]`)!;
    const before = tiles();
    const drawn = { tag: before.tagName, attributes: attributes(before), html: before.innerHTML };
    hover(before);
    await settle();
    expect(openTooltips()).toEqual(['Claude Code']);
    const after = tiles();
    unhover(after);
    await settle();
    expect(openTooltips()).toEqual([]);
    expect({ tag: after.tagName, attributes: attributes(after), html: after.innerHTML }).toEqual(drawn);
  });
}

test.skipIf(!hasDom)('rows drawn again under a pointer at rest: the browser\'s mouseenter alone opens nothing; the next move opens the tooltip', async () => {
  const el = render(false);
  const tiles = () => el.querySelector<HTMLElement>(`[data-thread-id="msg_0"] [data-row-agents]`)!;
  // What Chrome sends a new element under a pointer that has not moved: the mouse's boundary events, no pointer event.
  act(() => {
    tiles().dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: 10, clientY: 10 }));
    tiles().dispatchEvent(new MouseEvent('mouseenter', { clientX: 10, clientY: 10 }));
  });
  await settle();
  expect(openTooltips()).toEqual([]);
  act(() => {
    tiles().dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 12, clientY: 10 }));
  });
  await settle();
  expect(openTooltips()).toEqual(['Claude Code']);
});

test.skipIf(!hasDom)("a Tab from a row onto its hover action keeps focus on the action, and the action's tooltip shows", async () => {
  const el = render(false);
  const rowButton = el.querySelector<HTMLElement>('[data-row="msg_1"] [data-thread-id]')!;
  act(() => rowButton.focus());
  expect(document.activeElement).toBe(rowButton);
  act(() => {
    rowButton.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
  });
  const action = el.querySelector<HTMLElement>('[data-row="msg_1"] [data-row-mark-unread]')!;
  expect(document.activeElement).toBe(action);
  await settle();
  expect(openTooltips().some((t) => t.startsWith('Mark unread'))).toBe(true);
  expect(document.activeElement).toBe(action);
});

test.skipIf(!hasDom)('a touch never draws a trigger again, and opens no tooltip', async () => {
  const el = render(false);
  const tiles = el.querySelector<HTMLElement>(`[data-thread-id="msg_0"] [data-row-agents]`)!;
  act(() => {
    tiles.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'touch', clientX: 10, clientY: 10 }));
  });
  expect(tiles.isConnected).toBe(true);
  await settle();
  expect(openTooltips()).toEqual([]);
});
