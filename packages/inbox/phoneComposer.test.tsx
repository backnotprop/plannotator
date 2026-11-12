import { afterEach, beforeEach, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxComposeLaunch, InboxMessageWire, InboxProject, InboxThread } from '@plannotator/core/inbox-types';
import type { TaggableSession } from './api';
import { PHONE_QUERY } from './phone';
import { setSessionLabels } from './sessionLabels';

const hasDom = typeof document !== 'undefined';
const { ThreadPane } = (hasDom ? await import('./components/Thread') : {}) as typeof import('./components/Thread');
const { ComposeDialog } = (hasDom ? await import('./compose/ComposeDialog') : {}) as typeof import('./compose/ComposeDialog');
const { BottomSheet, BOTTOM_SHEET_MS } = (hasDom ? await import('./components/BottomSheet') : {}) as typeof import('./components/BottomSheet');

const PROJECT: InboxProject = { id: 'prj_1', key: 'acme-web-abcdef', name: 'acme-web', root: '/work/acme-web', created_at: '2026-11-01T10:00:00.000Z' };
const CLAUDE = { kind: 'agent' as const, host: 'claude-code', session: 'ses_claude', name: null };
const PI = { kind: 'agent' as const, host: 'pi', session: 'ses_pi', name: null };
const M1 = 'msg_01M4H6G73M9H3Z32T859E72DPY';
const M2 = 'msg_01M4H7AAAAAAAAAAAAAAAAAAAA';

function agentMessage(id: string, author: InboxMessageWire['author'], minute: number): InboxMessageWire {
  return {
    id,
    project_id: PROJECT.id,
    thread_id: M1,
    reply_to: id === M1 ? null : M1,
    author,
    subject: id === M1 ? 'Checkout page' : null,
    body: `Message ${id.slice(-4)}.`,
    created_at: `2026-11-01T10:${String(minute).padStart(2, '0')}:00.000Z`,
    resolved_at: null,
    idempotency_key: null,
    wakes: true,
  };
}
const threadOf = (...messages: InboxMessageWire[]): InboxThread => ({ thread_id: M1, project: PROJECT, subject: 'Checkout page', thread_name: null, resolved_at: null, messages });
const ONE_AGENT = () => threadOf(agentMessage(M1, CLAUDE, 41));
const TWO_AGENTS = () => threadOf(agentMessage(M1, CLAUDE, 41), agentMessage(M2, PI, 45));

function tagged(session: string, host: string): TaggableSession {
  return { session, host, kind: 'live', name: null, project: PROJECT, started_at: null, last_at: '2026-11-01T10:50:00.000Z', busy: false, idle_since: null, taggable: true, owner: false, wrote_thread: true };
}
const LIVE = [tagged('ses_claude', 'claude-code'), tagged('ses_pi', 'pi')];
const CAN_START: InboxComposeLaunch = {
  agents: [{ agent: 'claude-code', name: 'Claude Code' }],
  projects: [{ id: 'prj_web', name: 'web-app', root: '/Users/me/code/web-app', exists: true }],
  scratch: { root: '/Users/me/scratch' },
};
const COMPOSE_SESSIONS = {
  serverSession: 's',
  home: '/Users/me',
  projects: [{ project: { id: 'prj_1', name: 'acme-web', root: '/work/acme-web' }, sessions: [{ session: 'ses_claude', host: 'claude-code', started_at: '2026-11-01T10:54:00.000Z', last_seen_at: '2026-11-01T10:55:00.000Z', busy: false, idle_since: null, last_thread: null }] }],
  launch: CAN_START,
};

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let posted: { path: string; body: Record<string, unknown> }[] = [];

beforeEach(() => {
  if (!hasDom) return;
  savedFetch = globalThis.fetch;
  posted = [];
  setSessionLabels({});
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
      posted.push({ path, body });
      if (path.endsWith('/draft')) return Response.json({ draft: { thread_id: M1, body: body.body, updated_at: new Date(Date.now() + posted.length).toISOString(), ...(body.recipients ? { recipients: body.recipients } : {}) } });
      if (path.endsWith('/reply')) return Response.json({ reply: {}, questions: [], replayed: false });
      return Response.json({ questions: [] });
    }
    if (path.endsWith('/draft')) return Response.json({ draft: null });
    if (path.includes('/taggable')) return Response.json({ serverSession: 's', owner: null, sessions: LIVE });
    if (path.includes('/attachments')) return Response.json({ serverSession: 's', attachments: [], annotations: [] });
    if (path.startsWith('/api/inbox/sessions')) return Response.json(COMPOSE_SESSIONS);
    if (path.includes('/sessions')) {
      const sessions = LIVE.map((t) => ({ session: t.session, host: t.host, started_at: t.last_at, last_seen_at: t.last_at, busy: false, idle_since: null, wrote_thread: true }));
      return Response.json({ serverSession: 's', home: '/home/me', project: PROJECT, sessions });
    }
    if (path.startsWith('/api/inbox/skills')) return Response.json({ skills: [] });
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
  setSessionLabels({});
});

async function settle(ms = 0) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}
async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 150; i++) {
    if (check()) return;
    await settle(10);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function mount(node: React.ReactNode) {
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(node);
  });
}

async function openReply(thread: InboxThread, phone: boolean) {
  mount(<ThreadPane thread={thread} sent={null} onQuestions={() => {}} onChanged={async () => {}} onClose={() => {}} file={null} onOpenFile={() => {}} onOpenGuide={() => {}} phone={phone} />);
  await settle();
  await settle();
  const reply = [...host!.querySelectorAll('.ib-pfoot button')].find((b) => b.textContent?.trim() === 'Reply') as HTMLButtonElement;
  act(() => reply.click());
  await settle();
  const text = host!.querySelector('textarea') as HTMLTextAreaElement;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(text, 'Ship it.');
    text.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
  act(() => text.focus());
  return text;
}

const q = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector);
const control = () => q<HTMLButtonElement>('[data-reply-row] [data-recipient]');
const sheet = () => q('[data-sheet][data-shown]');
const click = async (el: Element | null) => {
  if (!el) throw new Error('nothing to click');
  act(() => (el as HTMLElement).click());
  await settle();
};
const sheetGone = () => until(() => q('[data-sheet]') === null, 'the sheet to leave the DOM');
const replies = () => posted.filter((p) => p.path.endsWith('/reply'));

test.skipIf(!hasDom)('a phone, one agent: no agent control in the row (the paperclip, Skills, then Send), as on a computer; Send is the arrow', async () => {
  await openReply(ONE_AGENT(), true);
  const row = q('[data-reply-row][data-phone]')!;
  const order = [...row.querySelectorAll('[data-reply-attach], [data-reply-skills], [data-recipient], [data-reply-send]')].map((el) => [...el.attributes].find((a) => /^data-(reply-attach|reply-skills|recipient|reply-send)$/.test(a.name))!.name);
  expect(order).toEqual(['data-reply-attach', 'data-reply-skills', 'data-reply-send']);
  expect(q('[data-recipient], [data-agent-mark], [data-agent-pill], [data-sheet]')).toBeNull();
  expect(q('[data-reply-send]')!.textContent).toBe('Send');
  expect(q('[data-reply-send] svg')).not.toBeNull();
});

test.skipIf(!hasDom)('a phone, several agents of different kinds: the mark and a chevron alone, in the row after Skills; its name still says who, with the session\'s title', async () => {
  await openReply(TWO_AGENTS(), true);
  const row = q('[data-reply-row][data-phone]')!;
  expect([...row.querySelectorAll('[data-reply-skills], [data-recipient], [data-reply-send]')].map((el) => (el.hasAttribute('data-recipient') ? 'recipient' : el.hasAttribute('data-reply-send') ? 'send' : 'skills'))).toEqual(['skills', 'recipient', 'send']);
  const pill = control()!;
  expect(pill.hasAttribute('data-agent-pill')).toBe(true);
  expect(pill.getAttribute('data-recipient-chosen')).toBe('ses_pi');
  expect(pill.querySelector('.ib-apill-n')).toBeNull();
  expect(pill.textContent).toBe('');
  expect(pill.getAttribute('aria-label')).toBe('Reply goes to Pi. Change');
  act(() => setSessionLabels({ ses_pi: 'Copy pass on the order summary' }));
  await settle();
  expect(control()!.querySelector('.ib-apill-n')).toBeNull();
  expect(control()!.getAttribute('aria-label')).toBe('Reply goes to Pi · Copy pass on the order summary. Change');
});

test.skipIf(!hasDom)('a phone, two agents of one kind: still the mark and a chevron alone; the accessible name and the sheet tell them apart', async () => {
  const SECOND = { kind: 'agent' as const, host: 'claude-code', session: 'ses_pi', name: null };
  await openReply(threadOf(agentMessage(M1, CLAUDE, 41), agentMessage(M2, SECOND, 45)), true);
  act(() => setSessionLabels({ ses_pi: 'Invoice PDF fonts' }));
  await settle();
  const pill = control()!;
  expect(pill.hasAttribute('data-agent-pill')).toBe(true);
  expect(pill.querySelector('.ib-apill-n')).toBeNull();
  expect(pill.textContent).toBe('');
  expect(pill.getAttribute('aria-label')).toBe('Reply goes to Claude Code · Invoice PDF fonts. Change');
  await click(pill);
  await until(() => sheet() !== null, 'the sheet');
  expect(q('[data-recipient-row="ses_pi"] .ib-sheet-t')!.textContent).toBe('Invoice PDF fonts');
  expect(q('[data-recipient-row="ses_pi"]')!.getAttribute('aria-selected')).toBe('true');
  expect(q('[data-recipient-row="ses_claude"]')!.getAttribute('aria-selected')).toBe('false');
});

test.skipIf(!hasDom)('a phone: a tap on another agent sends to it alone, closes the sheet and puts focus back in the reply; Send goes to the agent the control names', async () => {
  const text = await openReply(TWO_AGENTS(), true);
  await click(control());
  await until(() => sheet() !== null, 'the sheet');
  expect(sheet()!.getAttribute('role')).toBe('dialog');
  expect(sheet()!.getAttribute('aria-label')).toBe('Who gets this reply');
  expect(document.activeElement).toBe(sheet());
  expect(q('[data-recipient-row="ses_pi"]')!.getAttribute('aria-selected')).toBe('true');
  await click(q('[data-recipient-row="ses_claude"]'));
  expect(sheet()).toBeNull();
  expect(document.activeElement).toBe(text);
  expect(control()!.getAttribute('data-recipient-chosen')).toBe('ses_claude');
  expect(control()!.getAttribute('aria-label')).toBe('Reply goes to Claude Code. Change');
  await sheetGone();
  await click(q('[data-reply-send]'));
  await settle();
  expect(replies()).toHaveLength(1);
  expect(replies()[0]!.path).toContain(M1);
  expect(replies()[0]!.body.to).toBeUndefined();
});

test.skipIf(!hasDom)('a phone, several recipients: the circle adds one and the sheet stays; the control is the first mark with how many; Escape closes and focus returns', async () => {
  const text = await openReply(TWO_AGENTS(), true);
  await click(control());
  await until(() => sheet() !== null, 'the sheet');
  await click(q('[data-recipient-tick="ses_claude"]'));
  expect(sheet()).not.toBeNull();
  expect(q('[data-recipient-tick="ses_claude"]')!.getAttribute('aria-checked')).toBe('true');
  const mark = control()!;
  expect(mark.hasAttribute('data-agent-mark')).toBe(true);
  expect(mark.querySelector('[data-agent-count]')!.textContent).toBe('2');
  expect(mark.getAttribute('aria-label')).toBe('Reply goes to Pi and Claude Code. Change');
  act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
  await settle();
  expect(sheet()).toBeNull();
  expect(document.activeElement).toBe(text);
  expect(text.isConnected).toBe(true);
  expect(text.value).toBe('Ship it.');
});

test.skipIf(!hasDom)('a phone: a tap outside the sheet closes it', async () => {
  const text = await openReply(TWO_AGENTS(), true);
  await click(control());
  await until(() => sheet() !== null, 'the sheet');
  await click(q('[data-sheet-scrim]'));
  expect(sheet()).toBeNull();
  expect(document.activeElement).toBe(text);
});

test.skipIf(!hasDom)('a computer is as it was: a one-agent thread has no recipient control, several agents get the pill and its list, and nothing of the phone is drawn', async () => {
  await openReply(ONE_AGENT(), false);
  expect(q('[data-recipient]')).toBeNull();
  expect(q('[data-agent-mark], [data-agent-pill], [data-sheet]')).toBeNull();
  expect(q('[data-reply-row]')!.hasAttribute('data-phone')).toBe(false);
  expect(q('[data-reply-send] svg')).toBeNull();
  act(() => root?.unmount());
  host?.remove();
  await openReply(TWO_AGENTS(), false);
  const pill = q<HTMLButtonElement>('[data-recipient]')!;
  expect(pill.className).toBe('ib-rto');
  await click(pill);
  expect(q('[data-recipient-list]')!.className).toContain('ib-rpick');
  expect(q('[data-agent-mark], [data-agent-pill], [data-sheet], [data-sheet-scrim]')).toBeNull();
});

test.skipIf(!hasDom)('a phone: while the sheet is open focus stays in it, and what asked for focus gets it when the sheet closes', async () => {
  const text = await openReply(TWO_AGENTS(), true);
  await click(control());
  await until(() => sheet() !== null, 'the sheet');
  const close = q<HTMLButtonElement>('[data-reply-close]')!;
  act(() => close.focus());
  expect(document.activeElement).toBe(sheet());
  await click(q('[data-sheet-scrim]'));
  expect(document.activeElement).toBe(close);
  expect(text.isConnected).toBe(true);
});

test.skipIf(!hasDom)('a phone: "Tag another agent" closes the sheet and leaves the caret in the reply, where the @ is typed', async () => {
  const text = await openReply(TWO_AGENTS(), true);
  await click(control());
  await until(() => sheet() !== null, 'the sheet');
  const typed: string[] = [];
  (document as unknown as { execCommand: (command: string, ui: boolean, value: string) => boolean }).execCommand = (_command, _ui, value) => {
    typed.push(`${document.activeElement === text ? 'reply' : 'elsewhere'}:${value}`);
    return true;
  };
  await click(q('[data-recipient-tag]'));
  delete (document as unknown as { execCommand?: unknown }).execCommand;
  expect(typed).toEqual(['reply: @']);
  expect(sheet()).toBeNull();
  expect(document.activeElement).toBe(text);
});

async function openCompose(phone: boolean) {
  mount(<ComposeDialog request={{}} phone={phone} current={null} lastSent={null} home="/Users/me" launchTip={null} onSent={() => {}} onSaved={() => {}} onDeleted={() => {}} onClose={() => {}} />);
  await until(() => q('dialog[data-compose] [data-compose-to]:not([data-loading])') !== null, 'To');
}
const to = () => q<HTMLButtonElement>('dialog[data-compose] [data-compose-to]')!;

test.skipIf(!hasDom)('a phone: To is a pill in the foot\'s row with no To line at the top; it opens the sheet, and a pick names the agent and goes to the message', async () => {
  await openCompose(true);
  expect(q('dialog[data-compose] .ib-cp-to')).toBeNull();
  expect(to().closest('.ib-cp-foot')).not.toBeNull();
  expect(to().hasAttribute('data-agent-pill')).toBe(true);
  expect(to().getAttribute('data-compose-to')).toBe('choose');
  expect(to().textContent).toBe('Choose an agent');
  expect(to().getAttribute('aria-label')).toBe('To: choose an agent');
  await click(to());
  await until(() => q('[data-compose-to-sheet][data-shown]') !== null, 'the To sheet');
  expect(document.activeElement).toBe(q('[data-compose-to-sheet]'));
  const row = q('[data-compose-session="ses_claude"]')!;
  expect(row.querySelector('.ib-sheet-t')!.textContent).toBe('Claude Code');
  expect(row.querySelector('.ib-sheet-d')!.textContent).toContain('acme-web');
  expect(q('[data-compose-start-caption]')!.textContent).toContain('Start a new session in');
  await click(row);
  expect(q('[data-compose-to-sheet][data-shown]')).toBeNull();
  expect(to().getAttribute('data-compose-to')).toBe('ses_claude');
  expect(to().querySelector('.ib-apill-n')!.textContent).toBe('Claude Code');
  expect(to().getAttribute('aria-label')).toBe('To: Claude Code in acme-web. Change');
  expect(document.activeElement).toBe(q('dialog[data-compose] textarea'));
});

test.skipIf(!hasDom)('a phone: a new session shows where it starts on a line over the row, and that line opens the folder menu', async () => {
  await openCompose(true);
  await click(to());
  await until(() => q('[data-compose-start="claude-code"]') !== null, 'the start row');
  await click(q('[data-compose-start="claude-code"]'));
  expect(to().getAttribute('data-compose-to')).toBe('start');
  expect(to().querySelector('.ib-apill-n')!.textContent).toBe('Claude Code');
  const line = q('[data-compose-start-line]')!;
  expect(line.textContent).toContain('New Claude Code session in');
  const folder = line.querySelector<HTMLButtonElement>('[data-compose-folder]')!;
  expect(folder.textContent).toContain('web-app');
  expect(folder.getAttribute('aria-expanded')).toBe('false');
  await click(folder);
  expect(folder.getAttribute('aria-expanded')).toBe('true');
});

test.skipIf(!hasDom)('a computer\'s New message is as it was: the To line at the top with its list under it, no pill, no card, no sheet', async () => {
  await openCompose(false);
  expect(to().className).toBe('ib-cp-tobtn');
  expect(to().closest('.ib-cp-to')).not.toBeNull();
  expect(q('dialog[data-compose] [data-compose-pcard], dialog[data-compose] [data-agent-pill], dialog[data-compose] [data-compose-skills]')).toBeNull();
  await click(to());
  expect(q('[data-sheet], [data-sheet-scrim]')).toBeNull();
  expect(q('dialog[data-compose] [data-compose-session="ses_claude"]')!.className).toContain('ib-cp-opt');
});

function pointer(target: Element, type: string, clientY: number, timeStamp: number) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { clientY, pointerId: 1 });
  Object.defineProperty(event, 'timeStamp', { value: timeStamp });
  act(() => void target.dispatchEvent(event));
}

test.skipIf(!hasDom)('the sheet: a long drag down on its head closes it, a short one settles back; closed, it leaves the DOM after its way out', async () => {
  let closes = 0;
  const draw = (open: boolean) => (
    <BottomSheet open={open} onClose={() => closes++} title="To" host={null}>
      <div>rows</div>
    </BottomSheet>
  );
  mount(draw(true));
  await until(() => sheet() !== null, 'the sheet');
  const head = q('[data-sheet-head]')!;
  Object.defineProperty(q('[data-sheet]'), 'offsetHeight', { configurable: true, value: 300 });
  pointer(head, 'pointerdown', 100, 1000);
  pointer(head, 'pointermove', 140, 1400);
  expect(q('[data-sheet]')!.hasAttribute('data-dragging')).toBe(true);
  pointer(head, 'pointerup', 140, 1800);
  expect(closes).toBe(0);
  expect(q('[data-sheet]')!.hasAttribute('data-dragging')).toBe(false);
  pointer(head, 'pointerdown', 100, 3000);
  pointer(head, 'pointermove', 240, 3400);
  pointer(head, 'pointerup', 240, 3800);
  expect(closes).toBe(1);
  act(() => root!.render(draw(false)));
  await settle();
  expect(q('[data-sheet]')).not.toBeNull();
  expect(sheet()).toBeNull();
  await settle(BOTTOM_SHEET_MS + 40);
  expect(q('[data-sheet], [data-sheet-scrim]')).toBeNull();
});

const CSS = readFileSync(join(import.meta.dir, 'phoneComposer.css'), 'utf8');

test('phoneComposer.css restyles the shared parts only inside phone.ts\'s own query', () => {
  const queries = [...CSS.matchAll(/^@media ([^{]+) \{$/gm)].map((m) => m[1]!.trim());
  expect(queries).toContain(PHONE_QUERY);
  const outside = CSS.slice(0, CSS.indexOf(`@media ${PHONE_QUERY}`));
  expect(outside).not.toMatch(/\.ib-(pfoot|rbox|rrow|rscroll|rsend|rtext|rclose|rline|cp-foot|cp-body|cp-head|cp-send)\b/);
  expect(outside).not.toMatch(/dialog\.ib-cp/);
});

test('the reply\'s typing area on a phone: a line taller than the 64 px it was, and capped at 40% of what the keyboard leaves in every keyboard state', () => {
  const rule = (selector: string) => {
    const at = CSS.indexOf(`${selector} {`);
    if (at < 0) throw new Error(`no rule for ${selector}`);
    return CSS.slice(at, CSS.indexOf('}', at));
  };
  const text = rule('.pn-inbox .ib-pfoot .ib-rscroll :is(.ib-rtext, .ib-rmirror)');
  const min = Number(/min-height: min\((\d+)px, calc\(var\(--ib-vvh, 100dvh\) \* 0\.4\)\)/.exec(text)![1]);
  expect(min).toBeGreaterThanOrEqual(64 + 24);
  expect(text).toContain('max-height: none');
  expect(text).toContain('font-size: 16px');
  const cap = rule('.pn-inbox .ib-pfoot .ib-rbox .ib-rscroll, :root[data-ib-keyboard-pin] .pn-inbox .ib-pfoot .ib-rbox .ib-rscroll');
  expect(cap).toContain('max-height: calc(var(--ib-vvh, 100dvh) * 0.4)');
});
