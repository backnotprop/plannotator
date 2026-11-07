/**
 * A reply waiting on a busy agent (owner approval "inbox-busy-agent-reply",
 * 2026-10-21), as the window draws it: the list row's "Undelivered N min"
 * badge in place of the count (blue while it can go in now, grey when it
 * cannot), Send now on the row only on hover and keyboard focus, the band
 * under the reply ("Undelivered 3 min · Claude Code is working · goes in by
 * itself in 2 min · Send now"), the grey band that says why it cannot go in
 * sooner and the fix, and the line after it went in by itself. The failures
 * this catches: a waiting reply that still reads as quietly queued, a
 * countdown promised where nothing can take it, and a Send now that posts
 * nothing. happy-dom has no layout; the real browser shots are in
 * tests/e2e/inbox-undelivered.spec.ts.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxListRow, InboxListSection, InboxMessageWire, InboxProject, InboxRowDelivery, InboxThread } from '@plannotator/core/inbox-types';
import { INBOX_AUTO_SEND_ACK_NOTES } from '@plannotator/core/inbox-types';
import type { RecipientConnection } from './deliveryLine';
import { undeliveredLabel, undeliveredShort } from './deliveryLine';

const hasDom = typeof document !== 'undefined';
const { InboxList } = (hasDom ? await import('./components/InboxList') : {}) as typeof import('./components/InboxList');
const { SidebarProvider } = (hasDom ? await import('./shell/sidebar') : {}) as typeof import('./shell/sidebar');
const { ThreadPane } = (hasDom ? await import('./components/Thread') : {}) as typeof import('./components/Thread');

const MIN = 60_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const AGENT = { kind: 'agent' as const, host: 'claude-code', session: 'ses_a', name: null };

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let posted: string[] = [];
let connection: RecipientConnection | null | undefined;

beforeEach(() => {
  if (!hasDom) return;
  savedFetch = globalThis.fetch;
  posted = [];
  connection = undefined;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (init?.method === 'POST') {
      posted.push(path);
      return Response.json({ message: {} });
    }
    if (path.includes('/attachments')) return Response.json({ serverSession: 's', attachments: [], annotations: [] });
    if (path.includes('/sessions')) {
      const asked = new URL(path, 'http://inbox.test').searchParams.get('asker');
      return Response.json({ serverSession: 's', home: '/home/me', project: PROJECT, sessions: [], ...(asked ? { asker: { session: asked, live: true, connection } } : {}) });
    }
    return Response.json({});
  }) as typeof fetch;
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  for (const node of document.body.querySelectorAll('[data-base-ui-portal], [role="presentation"]')) node.remove();
  root = null;
  host = null;
  globalThis.fetch = savedFetch;
});

async function settle() {
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

// ── The list row ──

function delivery(extra: Partial<InboxRowDelivery>): InboxRowDelivery {
  return { kind: 'reply', state: 'queued', reason: 'working', send_now: false, message_id: 'msg_r', at: null, host: 'claude-code', name: null, ...extra };
}

function row(id: string, subject: string, d: InboxRowDelivery): InboxListRow {
  const last = ago(3.5 * MIN);
  return {
    thread_id: id,
    project_id: 'prj_1',
    subject,
    author: AGENT,
    created_at: last,
    last_at: last,
    last_author: 'person',
    message_count: 2,
    resolved_at: null,
    questions: { open: 0, picked: 0, stopped: false, holds_up: [], prompt: null },
    waiting_on_person: false,
    project: { id: 'prj_1', name: 'ledger' },
    thread_name: null,
    section: 'sent',
    unread: false,
    answered_not_sent: false,
    waiting_since: null,
    unseen: 0,
    sent: { at: last, checked_at: null, wakes: true },
    guide: false,
    delivery: d,
  };
}

function renderList(sections: InboxListSection[], options: { phone?: boolean; narrow?: boolean; onSendNow?: (row: InboxListRow) => void } = {}) {
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
            sections={sections}
            filtered={false}
            narrow={options.narrow ?? false}
            selectedThreadId={null}
            notice={null}
            onShowNew={() => {}}
            onOpen={() => {}}
            onSendNow={options.onSendNow}
            phone={options.phone ?? false}
          />
        </div>
      </SidebarProvider>,
    );
  });
  return host;
}

const CAN = row('msg_can', 'Ledger export format', delivery({ send_now: true, steerable: true, waiting_since: ago(3.5 * MIN), auto_send_at: new Date(Date.now() + 1.5 * MIN).toISOString(), message_id: 'msg_reply_can' }));
const STUCK = row('msg_stuck', 'Invoice rounding', delivery({ send_now: false, steerable: false, waiting_since: ago(12.2 * MIN), auto_send_at: null }));
const QUEUED_OLD = row('msg_old', 'From an older Inbox', delivery({ send_now: true }));
const SECTIONS: InboxListSection[] = [{ id: 'sent', label: 'Sent', threads: [CAN, STUCK, QUEUED_OLD] }];
const rowEl = (el: HTMLElement, id: string) => el.querySelector<HTMLElement>(`[data-thread-id="${id}"]`)!;
const badge = (el: HTMLElement, id: string) => rowEl(el, id).querySelector<HTMLElement>('[data-undelivered]');

for (const shape of ['wide', 'narrow', 'phone'] as const) {
  const wide = shape === 'wide';
  test.skipIf(!hasDom)(`${shape} row: ${wide ? '"Undelivered N min"' : '"Undelivered Nm"'} in place of the count, blue where it can go in now, grey where it cannot`, () => {
    const el = renderList(SECTIONS, { phone: shape === 'phone', narrow: shape === 'narrow' });
    // A three-line or phone row draws the short form (approval "inbox-row-byline", option A); a wide row the full
    // words (the owner, 2026-10-29).
    expect(badge(el, CAN.thread_id)!.textContent).toBe(wide ? 'Undelivered 3 min' : 'Undelivered 3m');
    expect(badge(el, CAN.thread_id)!.hasAttribute('data-stuck')).toBe(false);
    expect(badge(el, STUCK.thread_id)!.textContent).toBe(wide ? 'Undelivered 12 min' : 'Undelivered 12m');
    expect(badge(el, STUCK.thread_id)!.hasAttribute('data-stuck')).toBe(true);
    // In the count's cell: the row's name reads the full words (hidden text beside a short form).
    const cell = badge(el, CAN.thread_id)!.closest('.ib-c')!;
    if (wide) expect(cell.querySelector('.ib-sr')).toBeNull();
    else {
      expect(badge(el, CAN.thread_id)!.closest('[aria-hidden="true"]')).not.toBeNull();
      expect(cell.querySelector('.ib-sr')!.textContent).toBe('Undelivered 3 min');
    }
    // An older Inbox sends no wait: no badge.
    expect(badge(el, QUEUED_OLD.thread_id)).toBeNull();
  });
}

test('the wait in minutes, then hours, then days (review D1): "14 min" / "14m", "2 hours" / "2h", "1 day" / "1d"', () => {
  const now = Date.parse('2026-10-29T12:00:00.000Z');
  const ago = (min: number) => new Date(now - min * 60_000).toISOString();
  const both = (min: number) => [undeliveredLabel(ago(min), now), undeliveredShort(ago(min), now)];
  expect(both(0)).toEqual(['Undelivered', 'Undelivered']);
  expect(both(14)).toEqual(['Undelivered 14 min', 'Undelivered 14m']);
  expect(both(59)).toEqual(['Undelivered 59 min', 'Undelivered 59m']);
  expect(both(60)).toEqual(['Undelivered 1 hour', 'Undelivered 1h']);
  expect(both(125)).toEqual(['Undelivered 2 hours', 'Undelivered 2h']);
  expect(both(1439)).toEqual(['Undelivered 23 hours', 'Undelivered 23h']);
  expect(both(1500)).toEqual(['Undelivered 1 day', 'Undelivered 1d']);
  expect(both(60 * 24 * 9)).toEqual(['Undelivered 9 days', 'Undelivered 9d']);
});

test.skipIf(!hasDom)('Send now on the row: only where it can go in now, a sibling of the row, posted for the reply; never on a phone row', () => {
  const pressed: string[] = [];
  const el = renderList(SECTIONS, { onSendNow: (r) => pressed.push(r.delivery!.message_id) });
  const actionOf = (id: string) => el.querySelector<HTMLElement>(`[data-row="${id}"] > [data-row-send-now]`);
  expect(actionOf(CAN.thread_id)).not.toBeNull();
  expect(actionOf(STUCK.thread_id)).toBeNull();
  expect(actionOf(QUEUED_OLD.thread_id)).toBeNull();
  // A real button, never inside the row's own button, named for the row.
  const button = actionOf(CAN.thread_id) as HTMLButtonElement;
  expect(button.tagName).toBe('BUTTON');
  expect(button.closest('.ib-row')).toBeNull();
  expect(button.getAttribute('aria-label')).toBe('Send now: Ledger export format');
  act(() => button.click());
  expect(pressed).toEqual(['msg_reply_can']);
  act(() => root?.unmount());
  host?.remove();
  const phone = renderList(SECTIONS, { phone: true, onSendNow: () => {} });
  expect(phone.querySelector('[data-row-send-now]')).toBeNull();
});

// ── The line under the reply ──

const PROJECT: InboxProject = { id: 'prj_1', key: 'ledger-abcdef', name: 'ledger', root: '/work/ledger', created_at: '2026-10-21T10:00:00.000Z' };
const ASKED = 'msg_01M4XXVG0ZCPSD10B1KPG7DPMB';
const REPLY = 'msg_01M4XXVG0ZCPSD10B1KPG7DPMC';

function thread(reply: Partial<InboxMessageWire> = {}): InboxThread {
  const asked: InboxMessageWire = {
    id: ASKED,
    project_id: PROJECT.id,
    thread_id: ASKED,
    reply_to: null,
    author: { ...AGENT, name: 'Claude Code' },
    subject: 'Ledger export format',
    subject_question: null,
    body: 'CSV or Parquet?',
    created_at: ago(10 * MIN),
    resolved_at: null,
    idempotency_key: null,
    wakes: true,
  };
  const sent: InboxMessageWire = {
    id: REPLY,
    project_id: PROJECT.id,
    thread_id: ASKED,
    reply_to: ASKED,
    author: { kind: 'person' },
    subject: null,
    body: 'Parquet, and keep a CSV of the monthly summary for finance.',
    created_at: ago(3.5 * MIN),
    resolved_at: null,
    idempotency_key: 'k1',
    ...reply,
  };
  return { thread_id: ASKED, project: PROJECT, subject: asked.subject, thread_name: null, resolved_at: null, messages: [asked, sent] };
}

async function renderThread(value: InboxThread, sent: { at: string; checked_at: string | null } | null = { at: ago(3.5 * MIN), checked_at: null }) {
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(
      <div className="pn-inbox">
        <ThreadPane thread={value} sent={sent} onQuestions={() => {}} onChanged={async () => {}} onClose={() => {}} file={null} onOpenFile={() => {}} onOpenGuide={() => {}} />
      </div>,
    );
  });
  await settle();
  return host;
}

/** The server's clock for the reply on that session (the sessions route's `connection.waits`). */
const waitsFor = (id: string, since: string, autoSince: string | null = since) => ({ [id]: { since, auto_since: autoSince } });

const band = (el: HTMLElement) => el.querySelector<HTMLElement>('[data-undelivered].ib-delivered');

test.skipIf(!hasDom)('it can go in now: "Undelivered 3 min · Claude Code is working · goes in by itself in 2 min" and a filled Send now', async () => {
  connection = { busy: true, idle_since: null, send_now: true, auto_send_after_ms: 5 * MIN, waits: waitsFor(REPLY, ago(3.5 * MIN)) };
  // Sent long ago (for a session that was gone): the minutes are the server's clock, not created_at.
  const el = await renderThread(thread({ created_at: ago(90 * MIN) }));
  const b = band(el)!;
  expect(b.getAttribute('data-delivery')).toBe('queued');
  expect(b.hasAttribute('data-stuck')).toBe(false);
  expect(b.querySelector('strong')!.textContent).toBe('Undelivered 3 min');
  expect(b.textContent).toContain('Undelivered 3 min · Claude Code is working · goes in by itself in 2 min');
  const send = b.querySelector<HTMLButtonElement>('[data-send-now]')!;
  expect(send.textContent).toBe('Send now');
  await act(async () => send.click());
  await settle();
  expect(posted.filter((p) => p.endsWith('/send-now'))).toEqual([`/api/inbox/messages/${REPLY}/send-now`]);
  // No reason line: it can go in.
  expect(b.querySelector('[data-stuck-why]')).toBeNull();
});

test.skipIf(!hasDom)('under a minute left: "goes in by itself in under a minute"; no countdown before the auto clock, nor from an older Inbox; no clock yet: no minutes', async () => {
  connection = { busy: true, idle_since: null, send_now: true, auto_send_after_ms: 5 * MIN, waits: waitsFor(REPLY, ago(4.5 * MIN)) };
  let el = await renderThread(thread());
  expect(band(el)!.textContent).toContain('Undelivered 4 min · Claude Code is working · goes in by itself in under a minute');
  act(() => root?.unmount());
  host?.remove();
  // Waited 12 minutes, able to take it for 1: the countdown runs from the 1, the label from the 12.
  connection = { busy: true, idle_since: null, send_now: true, auto_send_after_ms: 5 * MIN, waits: waitsFor(REPLY, ago(12.2 * MIN), ago(1.2 * MIN)) };
  el = await renderThread(thread());
  expect(band(el)!.textContent).toContain('Undelivered 12 min · Claude Code is working · goes in by itself in 4 min');
  act(() => root?.unmount());
  host?.remove();
  connection = { busy: true, idle_since: null, send_now: true, waits: waitsFor(REPLY, ago(3.5 * MIN)) };
  el = await renderThread(thread());
  expect(band(el)!.textContent).toContain('Undelivered 3 min · Claude Code is working · it gets this when its turn ends');
  expect(band(el)!.querySelector('[data-send-now]')).not.toBeNull();
  act(() => root?.unmount());
  host?.remove();
  // The server has not started a clock (it just saw the session busy): the plain queued line, however old the reply.
  connection = { busy: true, idle_since: null, send_now: true, auto_send_after_ms: 5 * MIN, waits: {} };
  el = await renderThread(thread({ created_at: ago(90 * MIN) }));
  expect(band(el)).toBeNull();
  expect(el.querySelector<HTMLElement>('[data-delivery]')!.textContent).toContain('Queued · Claude Code is working; it gets this when its turn ends.');
});

test.skipIf(!hasDom)("it can't go in sooner: grey, no button, no countdown; why, and the fix with Copy when it is an older plugin", async () => {
  connection = { busy: true, idle_since: null, send_now: false, auto_send_after_ms: 5 * MIN, waits: waitsFor(REPLY, ago(12.3 * MIN), null) };
  let el = await renderThread(thread());
  let b = band(el)!;
  expect(b.hasAttribute('data-stuck')).toBe(true);
  expect(b.querySelector('[data-send-now]')).toBeNull();
  expect(b.textContent).toContain('Undelivered 12 min · Claude Code is working · it gets this when its turn ends');
  expect(b.textContent).not.toContain('by itself');
  expect(b.querySelector('[data-stuck-why]')!.textContent).toBe("It can't go in sooner.");
  act(() => root?.unmount());
  host?.remove();

  connection = {
    busy: true,
    idle_since: null,
    send_now: false,
    auto_send_after_ms: 5 * MIN,
    engine: '2.1.305',
    outdated: { loaded: '0.28.21', installed: '0.28.25', fix: 'restart' },
    restart_command: 'cd ~/code/billing && claude --resume ses_a',
    waits: waitsFor(REPLY, ago(12.3 * MIN), null),
  };
  el = await renderThread(thread());
  b = band(el)!;
  const why = b.querySelector<HTMLElement>('[data-stuck-why]')!;
  expect(why.textContent).toContain("It can't go in sooner: this session runs an older Plannotator plugin. Type /reload-plugins in that Claude Code to fix it.");
  expect(why.querySelector('code')!.textContent).toBe('/reload-plugins');
  expect(why.querySelector<HTMLButtonElement>('[data-restart-copy]')!.getAttribute('aria-label')).toBe('Copy /reload-plugins');
  // The manual path stays folded.
  expect(b.querySelector('[data-restart-toggle]')!.getAttribute('aria-expanded')).toBe('false');
});

test.skipIf(!hasDom)('after it went in by itself: "Delivered to Claude Code, <time> · went into its turn by itself after 5 min"; when the turn ended first it says so; a person\'s Send now says nothing of it', async () => {
  const sentAt = ago(30 * MIN);
  const waitedFrom = ago(9 * MIN);
  const nowAt = new Date(Date.parse(waitedFrom) + 5 * MIN).toISOString();
  const deliveredAt = new Date(Date.parse(nowAt) + 20_000).toISOString();
  const delivered = (intoTurn?: boolean) => ({
    delivery: { state: 'delivered' as const, host: 'claude-code', session: 'ses_a', at: deliveredAt, ...(intoTurn === undefined ? {} : { into_turn: intoTurn }) },
  });
  const auto = { created_at: sentAt, deliver_now_at: nowAt, deliver_now_by: 'auto' as const, wait_started_at: waitedFrom };
  let el = await renderThread(thread({ ...auto, ...delivered(true) }), { at: sentAt, checked_at: deliveredAt });
  let line = el.querySelector<HTMLElement>('[data-delivery]')!;
  expect(line.getAttribute('data-delivery')).toBe('delivered');
  expect(line.textContent).toMatch(/^Delivered to Claude Code, .+ · went into its turn by itself after 5 min$/);
  act(() => root?.unmount());
  host?.remove();
  // Its own Ask question held the turn: it went in when the turn ended, not by itself mid-turn.
  el = await renderThread(thread({ ...auto, ...delivered(false) }), { at: sentAt, checked_at: deliveredAt });
  line = el.querySelector<HTMLElement>('[data-delivery]')!;
  expect(line.textContent).toMatch(/^Delivered to Claude Code, .+ · went in when its turn ended$/);
  expect(line.hasAttribute('data-auto')).toBe(false);
  act(() => root?.unmount());
  host?.remove();
  el = await renderThread(thread({ created_at: sentAt, deliver_now_at: nowAt, deliver_now_by: 'person', ...delivered() }), { at: sentAt, checked_at: deliveredAt });
  line = el.querySelector<HTMLElement>('[data-delivery]')!;
  expect(line.textContent).not.toContain('by itself');
});

test.skipIf(!hasDom)('marked to go in just before its session went away: it waits for the session, never "Sending … now" forever', async () => {
  connection = null;
  const el = await renderThread(thread({ deliver_now_at: ago(0.5 * MIN), deliver_now_by: 'auto', wait_started_at: ago(5.5 * MIN) }));
  const line = el.querySelector<HTMLElement>('[data-delivery]')!;
  expect(line.getAttribute('data-delivery')).toBe('queued');
  expect(line.textContent).toContain('Queued for Claude Code; it gets this when its session is back.');
  expect(line.textContent).not.toContain('Sending');
});

test.skipIf(!hasDom)('a 👍 waiting on a busy session says how long and that it waits for the turn to end: no countdown, no Send now', async () => {
  connection = { busy: true, idle_since: null, send_now: true, auto_send_after_ms: 5 * MIN, waits: waitsFor('msg_note', ago(3.5 * MIN)) };
  const value = thread();
  const asked = value.messages[0]!;
  const acked: InboxThread = {
    ...value,
    messages: [{ ...asked, ack: { label: 'Looks good', at: ago(3.6 * MIN), read_seq: 4, settled_seq: 5, note_id: 'msg_note', note_at: ago(3.5 * MIN), deliver_now_at: null, deliver_now_by: null } }],
  };
  const el = await renderThread(acked, null);
  await settle();
  const pill = el.querySelector<HTMLElement>('[data-ack-pill]')!;
  // The owner's decision: a 👍 waits for the turn to end. How long it waited, no countdown.
  expect(INBOX_AUTO_SEND_ACK_NOTES).toBe(false);
  expect(pill.textContent).toContain('Undelivered 3 min · Claude Code is working · it gets this when its turn ends');
  expect(pill.textContent).not.toContain('by itself');
  expect([...el.querySelectorAll('button')].some((button) => /send now/i.test(button.textContent ?? ''))).toBe(false);
});
