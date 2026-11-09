/**
 * The delivery glyph before a row's time ("Ticks", approval
 * "inbox-row-delivery"): one shape per state on wide, three-line and phone
 * rows; the state in words in the row's accessible name; the thread's line
 * as ui's tooltip (no native title); the delivery time once delivered; and
 * a Sent row keeps its real subject. An older Inbox (no `delivery`) keeps
 * the words it had. happy-dom has no layout; the real browser shots are in
 * the e2e (tests/e2e/inbox-send-now.spec.ts).
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxListRow, InboxListSection, InboxRowDelivery } from '@plannotator/core/inbox-types';
import { shortTime, whenTime } from './format';

const hasDom = typeof document !== 'undefined';
const { InboxList } = (hasDom ? await import('./components/InboxList') : {}) as typeof import('./components/InboxList');
const { SidebarProvider } = (hasDom ? await import('./shell/sidebar') : {}) as typeof import('./shell/sidebar');

const AGENT = { kind: 'agent' as const, host: 'claude-code', session: 'ses_a', name: null };
const LAST = '2026-10-20T10:00:00.000Z';
const DELIVERED_AT = '2026-10-20T10:07:00.000Z';

function delivery(state: InboxRowDelivery['state'], reason: InboxRowDelivery['reason'], extra: Partial<InboxRowDelivery> = {}): InboxRowDelivery {
  return { kind: 'reply', state, reason, send_now: false, message_id: 'msg_r', at: null, host: 'claude-code', name: null, ...extra };
}

function row(id: string, subject: string, d: InboxRowDelivery | null | undefined, section: InboxListRow['section'] = 'sent'): InboxListRow {
  return {
    thread_id: id,
    project_id: 'prj_1',
    subject,
    author: AGENT,
    created_at: LAST,
    last_at: LAST,
    last_author: 'person',
    message_count: 2,
    resolved_at: null,
    questions: { open: 0, picked: 0, stopped: false, holds_up: [], prompt: null },
    waiting_on_person: false,
    project: { id: 'prj_1', name: 'ledger' },
    thread_name: null,
    section,
    unread: false,
    answered_not_sent: false,
    waiting_since: null,
    unseen: 0,
    sent: { at: LAST, checked_at: null, wakes: true },
    guide: false,
    ...(d === undefined ? {} : { delivery: d }),
  };
}

const QUEUED = row('msg_q', 'Retry policy for the Stripe webhook', delivery('queued', 'working', { send_now: true }));
const SENDING = row('msg_s', 'Drop the legacy share portal route?', delivery('sending', 'idle'));
const SAVED = row('msg_v', 'App Store screenshots: light or dark?', delivery('saved', 'reads', { host: 'codex', name: 'Codex' }));
// Quiet is folded on first draw: a delivered reply to a woken session stays Sent until an agent reads the thread.
const DELIVERED = row('msg_d', 'Search index for the docs site', delivery('delivered', 'delivered', { at: DELIVERED_AT }));
const UNDELIVERED = row('msg_u', 'Why does staging pull the old image?', delivery('undelivered', 'undelivered', { kind: 'message', host: 'pi' }));
const OLDER = row('msg_o', 'From an older Inbox', undefined);
const SECTIONS: InboxListSection[] = [
  { id: 'sent', label: 'Sent', threads: [QUEUED, SENDING, SAVED, UNDELIVERED, OLDER, DELIVERED] },
];

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

function render(options: { phone?: boolean; narrow?: boolean } = {}): HTMLElement {
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
            sections={SECTIONS}
            filtered={false}
            narrow={options.narrow ?? false}
            selectedThreadId={null}
            notice={null}
            onShowNew={() => {}}
            onOpen={() => {}}
            phone={options.phone ?? false}
          />
        </div>
      </SidebarProvider>,
    );
  });
  return host;
}

const rowEl = (el: HTMLElement, id: string) => el.querySelector<HTMLElement>(`[data-thread-id="${id}"]`)!;
const tick = (el: HTMLElement, id: string) => rowEl(el, id).querySelector<HTMLElement>('.ib-tick');

/** The row's accessible name, as a screen reader builds it here: text, with a role="img" child's label in its place. */
function accessibleName(node: Element): string {
  const walk = (n: Node): string => {
    if (n.nodeType === 3) return n.textContent ?? '';
    const element = n as Element;
    if (element.getAttribute?.('aria-hidden') === 'true') return '';
    if (element.getAttribute?.('role') === 'img') return ` ${element.getAttribute('aria-label') ?? ''} `;
    return [...n.childNodes].map(walk).join('');
  };
  return walk(node).replace(/\s+/g, ' ').trim();
}

async function wait(ms: number) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

function hover(target: HTMLElement) {
  act(() => {
    for (const type of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointermove', 'mousemove']) {
      const Ctor = type.startsWith('pointer') ? PointerEvent : MouseEvent;
      target.dispatchEvent(new Ctor(type, { bubbles: type !== 'pointerenter' && type !== 'mouseenter', cancelable: true, pointerType: 'mouse', clientX: 10, clientY: 10 } as PointerEventInit));
    }
  });
}

const tooltipWith = (el: HTMLElement, text: string) => [...document.body.querySelectorAll('*')].some((n) => !el.contains(n) && n.children.length === 0 && n.textContent === text);

test.skipIf(!hasDom)('one shape per state, on wide, three-line and phone rows; a row from an older Inbox has none', () => {
  for (const options of [{}, { narrow: true }, { phone: true }]) {
    const el = render(options);
    expect(tick(el, QUEUED.thread_id)!.dataset.tick).toBe('queued');
    expect(tick(el, QUEUED.thread_id)!.querySelector('svg path')!.getAttribute('d')).toContain('M12 6v6h4.5');
    expect(tick(el, SENDING.thread_id)!.querySelectorAll('.ib-dots i').length).toBe(3);
    expect(tick(el, SAVED.thread_id)!.querySelectorAll('svg path').length).toBe(1);
    expect(tick(el, DELIVERED.thread_id)!.querySelectorAll('svg.ib-dcheck path').length).toBe(2);
    expect(tick(el, UNDELIVERED.thread_id)!.dataset.tick).toBe('undelivered');
    expect(tick(el, OLDER.thread_id)).toBeNull();
    // The glyph sits in the time cell, before the time.
    const time = rowEl(el, QUEUED.thread_id).querySelector('.ib-t')!;
    expect(time.firstElementChild!.firstElementChild!.classList.contains('ib-tick')).toBe(true);
    // Send now stays in the thread: the row never offers it.
    expect(rowEl(el, QUEUED.thread_id).parentElement!.querySelector('[data-row-send-now], [data-send-now]')).toBeNull();
    act(() => root?.unmount());
    host?.remove();
  }
});

test.skipIf(!hasDom)("the state in words is in the row's name; a Sent row keeps its subject; the time is the delivery's once delivered", () => {
  const el = render();
  expect(accessibleName(rowEl(el, QUEUED.thread_id))).toContain(`Retry policy for the Stripe webhook Queued for Claude Code, ${shortTime(LAST)}`);
  expect(accessibleName(rowEl(el, SAVED.thread_id))).toContain('Saved for Codex,');
  expect(accessibleName(rowEl(el, UNDELIVERED.thread_id))).toContain('Not delivered,');
  expect(accessibleName(rowEl(el, DELIVERED.thread_id))).toContain(`Delivered to Claude Code, ${shortTime(DELIVERED_AT)}`);
  expect(rowEl(el, SENDING.thread_id).querySelector('.ib-title')!.textContent).toBe('Drop the legacy share portal route?');
  // No glyph: the older wording stays.
  expect(rowEl(el, OLDER.thread_id).querySelector('.ib-title')!.textContent).toBe('Queued for Claude Code; it gets this as its next turn.');
});

test.skipIf(!hasDom)("the tooltip is the thread's delivery line, ui's tooltip, never a native title", async () => {
  const el = render();
  const glyph = tick(el, QUEUED.thread_id)!;
  expect(glyph.hasAttribute('title')).toBe(false);
  hover(glyph);
  await wait(400);
  expect(tooltipWith(el, 'Queued · Claude Code is working; it gets this when its turn ends.')).toBe(true);
  hover(tick(el, DELIVERED.thread_id)!);
  await wait(400);
  expect(tooltipWith(el, `Delivered to Claude Code, ${whenTime(DELIVERED_AT)}`)).toBe(true);
});
