/**
 * Remove an agent from a thread, in the window (approval "inbox-remove-agent-from-thread", proposal B with D and E).
 * The reply's "to" list: an agent's row has "Remove" between its name and its circle (in the Tab order between them),
 * one press and no dialog. A phone's sheet row slides left over "Remove". After it: the toast "Removed Pi" with Undo,
 * the line "You removed Pi from this thread", and a one-agent thread again (no chip), whose reply goes to the agent
 * still in it even though the removed one wrote last. The failure this catches: Remove on the wrong row or the last
 * one, a press that sends the wrong request, a removed agent still offered or still the default, Undo that does not go.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxMessageWire, InboxProject, InboxRemoval, InboxThread } from '@plannotator/core/inbox-types';
import type { TaggableSession } from './api';
import type { InboxToastModel } from './components/Toast';
import type { RecipientRow } from './replyRecipients';
import { replyRecipientList } from './thread/recipientList';
import { followedSession } from './thread/replyAim';
import { threadParticipants } from './tags';

const hasDom = typeof document !== 'undefined';
// Viewer pulls in web-highlighter, which reads `window` at module-eval time.
const { ThreadPane } = (hasDom ? await import('./components/Thread') : {}) as typeof import('./components/Thread');

const PROJECT: InboxProject = { id: 'prj_1', key: 'billing-svc-abcdef', name: 'billing-svc', root: '/work/billing-svc', created_at: '2026-11-23T14:00:00.000Z' };
const CLAUDE = { kind: 'agent' as const, host: 'claude-code', session: 'ses_claude', name: null };
const PI = { kind: 'agent' as const, host: 'pi', session: 'ses_pi', name: null };
const M1 = 'msg_01M4H6G73M9H3Z32T859E72DPY';
const M2 = 'msg_01M4H7AAAAAAAAAAAAAAAAAAAA';

function message(id: string, author: InboxMessageWire['author'], minute: number, extra: Partial<InboxMessageWire> = {}): InboxMessageWire {
  return {
    id,
    project_id: PROJECT.id,
    thread_id: M1,
    reply_to: id === M1 ? null : M1,
    author,
    subject: id === M1 ? 'Stripe 409s' : null,
    body: `Message ${id.slice(-4)}.`,
    created_at: `2026-11-23T14:${String(minute).padStart(2, '0')}:00.000Z`,
    resolved_at: null,
    idempotency_key: null,
    wakes: true,
    ...extra,
  };
}

/** Claude Code started it, Pi wrote last; `removed`: the root's removals. */
function threadOf(removed: InboxRemoval[] = []): InboxThread {
  return {
    thread_id: M1,
    project: PROJECT,
    subject: 'Stripe 409s',
    thread_name: null,
    resolved_at: null,
    messages: [message(M1, CLAUDE, 41, removed.length > 0 ? { removed } : {}), message(M2, PI, 45)],
  };
}
const PI_OUT: InboxRemoval = { host: 'pi', session: 'ses_pi', at: '2026-11-23T14:50:00.000Z', after: M2 };

function tagged(session: string, host: string): TaggableSession {
  return { session, host, kind: 'live', name: null, project: { id: PROJECT.id, name: PROJECT.name, root: PROJECT.root }, started_at: null, last_at: '2026-11-23T14:50:00.000Z', busy: false, idle_since: null, taggable: true, owner: false, wrote_thread: true };
}

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let posted: { path: string; body: Record<string, unknown> }[] = [];
let toasts: Omit<InboxToastModel, 'id'>[] = [];
/** The thread as the server has it now: a Remove posted takes Pi out, its Undo puts it back. */
let current: InboxThread = threadOf();

beforeEach(() => {
  if (!hasDom) return;
  savedFetch = globalThis.fetch;
  posted = [];
  toasts = [];
  current = threadOf();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      posted.push({ path, body });
      if (path.endsWith('/remove-agent')) {
        const removal: InboxRemoval = body.session === 'ses_pi' ? PI_OUT : { ...PI_OUT, host: 'claude-code', session: String(body.session) };
        current = threadOf([removal]);
        return Response.json({ thread_id: M1, removal });
      }
      if (path.endsWith('/remove-agent/undo')) {
        current = threadOf();
        return Response.json({ thread_id: M1, removed: [] });
      }
      if (path.endsWith('/draft')) return Response.json({ draft: null });
      return Response.json({ questions: [] });
    }
    if (path.endsWith('/draft')) return Response.json({ draft: null });
    if (path.includes('/taggable')) return Response.json({ serverSession: 's', owner: null, sessions: [tagged('ses_claude', 'claude-code'), tagged('ses_pi', 'pi')] });
    if (path.includes('/attachments')) return Response.json({ serverSession: 's', attachments: [], annotations: [] });
    if (path.includes('/sessions')) return Response.json({ serverSession: 's', home: '/home/me', project: PROJECT, sessions: [] });
    return Response.json({});
  }) as typeof fetch;
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = savedFetch;
});

async function settle(ms = 0) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

function draw(phone: boolean) {
  root!.render(
    <div className="pn-inbox">
      <ThreadPane
        thread={current}
        sent={null}
        onQuestions={() => {}}
        // The window reads the thread again after a change: here, the server's thread as it is now.
        onChanged={async () => draw(phone)}
        onClose={() => {}}
        file={null}
        onOpenFile={() => {}}
        onOpenGuide={() => {}}
        onToast={(toast) => toasts.push(toast)}
        phone={phone}
      />
    </div>,
  );
}

async function render(phone = false) {
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    draw(phone);
  });
  await settle();
  await settle();
  return host;
}

async function openBox(el: HTMLElement) {
  const reply = [...el.querySelectorAll('.ib-pfoot button')].find((b) => b.textContent?.trim() === 'Reply') as HTMLButtonElement;
  act(() => reply.click());
  await settle();
}
const chip = (el: HTMLElement) => el.querySelector('[data-recipient]') as HTMLButtonElement | null;
const removes = () => posted.filter((p) => p.path.includes('/remove-agent'));

test.skipIf(!hasDom)('a computer: each agent row has Remove between its name and its circle; one press removes it, with the toast and its Undo', async () => {
  const el = await render();
  await openBox(el);
  act(() => chip(el)!.click());
  await settle();
  for (const [session, name] of [['ses_claude', 'Claude Code'], ['ses_pi', 'Pi']] as const) {
    const row = el.querySelector(`[data-recipient-row="${session}"]`) as HTMLElement;
    const parts = [...row.children].map((c) => (c.matches('.ib-rpick-name') ? 'name' : c.matches('[data-recipient-remove]') ? 'remove' : c.matches('[data-recipient-tick]') ? 'circle' : '?'));
    // The circle stays the row's end; Remove is between, in the Tab order (name, Remove, circle).
    expect(parts).toEqual(['name', 'remove', 'circle']);
    const remove = row.querySelector('[data-recipient-remove]') as HTMLButtonElement;
    expect(remove.textContent).toBe('Remove');
    expect(remove.getAttribute('aria-label')).toBe(`Remove ${name} from this thread`);
    expect(remove.tabIndex).toBeGreaterThanOrEqual(0);
  }
  // Tab, then Enter: the press keeps the list's rule (no focus taken by a mouse press) and sends one request.
  const remove = el.querySelector('[data-recipient-row="ses_pi"] [data-recipient-remove]') as HTMLButtonElement;
  const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
  act(() => void remove.dispatchEvent(press));
  expect(press.defaultPrevented).toBe(true);
  act(() => remove.focus());
  await act(async () => remove.click());
  await settle();
  await settle();
  expect(removes()).toEqual([{ path: `/api/inbox/threads/${M1}/remove-agent`, body: { session: 'ses_pi' } }]);
  // The toast: "Removed Pi", "Removed" on a phone, with Undo.
  expect(toasts).toHaveLength(1);
  expect(toasts[0]).toMatchObject({ lead: 'Removed Pi', phoneLead: 'Removed' });
  expect(typeof toasts[0]!.onUndo).toBe('function');
  // A one-agent thread again: no chip, the line in the thread, and the reply goes to Claude Code though Pi wrote last.
  expect(chip(el)).toBeNull();
  const line = el.querySelector('[data-thread-move="removed"]') as HTMLElement;
  expect(line.textContent).toContain('You removed Pi from this thread');
  expect((el.querySelector('textarea:not([data-question-other])') as HTMLTextAreaElement).getAttribute('aria-label')).toBe('Reply to Claude Code');
  // Focus that was on Remove goes back to the words.
  await settle(20);
  expect(document.activeElement === el.querySelector('textarea:not([data-question-other])')).toBe(true);
  // Undo puts it back as it was.
  await act(async () => toasts[0]!.onUndo!());
  await settle();
  expect(removes().map((p) => p.path)).toEqual([`/api/inbox/threads/${M1}/remove-agent`, `/api/inbox/threads/${M1}/remove-agent/undo`]);
  expect(removes()[1]!.body).toEqual({ session: 'ses_pi' });
  expect(chip(el)).not.toBeNull();
  expect(el.querySelector('[data-thread-move="removed"]')).toBeNull();
});

test.skipIf(!hasDom)('Undo puts the person\'s pick back: they picked Claude Code, removed it (the reply went to Pi), and Undo picks Claude Code again', async () => {
  const el = await render();
  await openBox(el);
  act(() => chip(el)!.click());
  await settle();
  // Pi wrote last, so the reply follows Pi; the person picks Claude Code.
  expect(chip(el)!.getAttribute('data-recipient-chosen')).toBe('ses_pi');
  act(() => (el.querySelector('[data-recipient-row="ses_claude"] .ib-rpick-name') as HTMLButtonElement).click());
  await settle();
  expect(chip(el)!.getAttribute('data-recipient-chosen')).toBe('ses_claude');
  if (!el.querySelector('[data-recipient-list]')) act(() => chip(el)!.click());
  await settle();
  await act(async () => (el.querySelector('[data-recipient-row="ses_claude"] [data-recipient-remove]') as HTMLButtonElement).click());
  await settle();
  await settle();
  expect(removes()).toEqual([{ path: `/api/inbox/threads/${M1}/remove-agent`, body: { session: 'ses_claude' } }]);
  expect(chip(el)).toBeNull();
  expect((el.querySelector('textarea:not([data-question-other])') as HTMLTextAreaElement).getAttribute('aria-label')).toBe('Reply to Pi');
  await act(async () => toasts[0]!.onUndo!());
  await settle();
  await settle();
  expect(chip(el)!.getAttribute('data-recipient-chosen')).toBe('ses_claude');
});

test.skipIf(!hasDom)('a phone: a row slides left over Remove; past a third it removes, a short swipe or a rightward one does nothing', async () => {
  const el = await render(true);
  await openBox(el);
  act(() => chip(el)!.click());
  await settle();
  const wrap = el.querySelector('[data-recipient-list] [data-swipe-remove="ses_pi"]') as HTMLElement;
  expect(wrap.querySelector('[data-recipient-row="ses_pi"]')).not.toBeNull();
  expect(wrap.querySelector('.ib-arcswipe-under')?.textContent).toBe('Remove');
  Object.defineProperty(wrap, 'offsetWidth', { configurable: true, value: 360 });
  const swipe = async (dx: number) => {
    const at = (type: string, x: number) => wrap.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, button: 0, clientX: x, clientY: 50 }));
    await act(async () => {
      at('pointerdown', 300);
      at('pointermove', 300 + dx / 2);
      at('pointermove', 300 + dx);
      at('pointerup', 300 + dx);
    });
    await settle();
  };
  await swipe(60);
  await swipe(-40);
  expect(removes()).toEqual([]);
  await swipe(-140);
  await settle();
  expect(removes()).toEqual([{ path: `/api/inbox/threads/${M1}/remove-agent`, body: { session: 'ses_pi' } }]);
  expect(toasts[0]).toMatchObject({ lead: 'Removed Pi', phoneLead: 'Removed' });
});

test('the list: Remove only on the thread\'s own agents, never with one agent left, nor where the thread\'s machine does not take it', () => {
  const base = { askerEnded: false, asking: null, live: null, taggable: null, gone: new Map(), rcptDefault: 'ses_pi', start: null };
  const two = threadOf();
  const rowsOf = (thread: InboxThread, removeOn: boolean) =>
    replyRecipientList({ ...base, thread, participants: threadParticipants(thread), removeOn }).map((r) => [r.session, !!r.removable]);
  expect(rowsOf(two, true)).toEqual([
    ['ses_claude', true],
    ['ses_pi', true],
  ]);
  // A linked machine from before Remove (no `remove-agent` mark): no Remove.
  expect(rowsOf(two, false)).toEqual([
    ['ses_claude', false],
    ['ses_pi', false],
  ]);
  // Pi removed: it is no row, and Claude Code, the last agent, has no Remove.
  const out = threadOf([PI_OUT]);
  expect(threadParticipants(out).map((p) => p.session)).toEqual(['ses_claude']);
  expect(rowsOf(out, true)).toEqual([['ses_claude', false]]);
  // A tag of Pi's after the removal brings it back.
  const back: InboxThread = { ...out, messages: [...out.messages, message('msg_01M4H7DDDDDDDDDDDDDDDDDDDD', { kind: 'person' }, 52, { reply_to: M1, tags: [{ host: 'pi', session: 'ses_pi', wakes: true }] })] };
  expect(threadParticipants(back).map((p) => p.session)).toEqual(['ses_claude', 'ses_pi']);
});

test('the reply follows the latest live agent once the newest writer is removed, else the latest', () => {
  const CODEX = { kind: 'agent' as const, host: 'codex', session: 'ses_codex', name: null };
  const M3 = 'msg_01M4H7CCCCCCCCCCCCCCCCCCCC';
  const piOut: InboxRemoval = { ...PI_OUT, after: M3 };
  const thread: InboxThread = { ...threadOf([piOut]), messages: [message(M1, CLAUDE, 41, { removed: [piOut] }), message(M3, CODEX, 43), message(M2, PI, 45)] };
  const row = (session: string, host: string, state: RecipientRow['state']): RecipientRow => ({ session, host, label: host, short: host, state });
  // Codex wrote after Claude Code but has ended: the reply goes to Claude Code, which is live.
  expect(followedSession(thread, [row('ses_claude', 'claude-code', 'live'), row('ses_codex', 'codex', 'ended')], null)).toBe('ses_claude');
  // Neither live: the latest still in the thread.
  expect(followedSession(thread, [row('ses_claude', 'claude-code', 'ended'), row('ses_codex', 'codex', 'ended')], null)).toBe('ses_codex');
  // Nobody removed: today's rule, the newest writer even when it ended.
  const plain: InboxThread = { ...threadOf(), messages: [message(M1, CLAUDE, 41), message(M3, CODEX, 43)] };
  expect(followedSession(plain, [row('ses_claude', 'claude-code', 'live'), row('ses_codex', 'codex', 'ended')], null)).toBe('ses_codex');
});
