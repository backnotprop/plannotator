/**
 * Rex in the window: an agent's place (Rex · session / tab) as a Where row on its hover card and in its row's spoken
 * name, Show in Rex on its menu, a run started in Rex, and what its Rex pane says on the card. What this catches: Show in Rex offered when the list
 * did not say (the app has not confirmed a jump, another computer's window), on a phone, or for a linked machine's
 * agent; its press reaching the wrong agent; a failed Show not shown under its row; the place missing from the card's facts; a Rex run
 * offering Stop or Open in Terminal, or not saying where Rex put it or why it started in the background; Rex's word
 * shown over the Inbox's own. A person without Rex sees no change.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt. Fetch is mocked: no server.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAgent, InboxAgentsGroup, InboxRun } from '@plannotator/core/inbox-types';
import { INBOX_RUN_REX_NOT_CONNECTED } from '@plannotator/core/inbox-run-line';
import type { MachineView } from '../api';

const hasDom = typeof document !== 'undefined';
if (hasDom) {
  const query = (media: string) => ({ media, matches: false, addEventListener: () => {}, removeEventListener: () => {} });
  (window as unknown as { matchMedia: unknown }).matchMedia = query;
  (globalThis as unknown as { matchMedia: unknown }).matchMedia = query;
  Element.prototype.animate = function () {
    const finished = Promise.resolve();
    return { currentTime: 0, playbackRate: 1, finished, playState: 'running', play() {}, pause() {}, cancel() {}, finish() {} } as unknown as Animation;
  } as typeof Element.prototype.animate;
  (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

const { AgentsSection } = (hasDom ? await import('./AgentsSection') : {}) as typeof import('./AgentsSection');
const faces = (hasDom ? await import('./agentFaces') : {}) as typeof import('./agentFaces');
const motion = (hasDom ? await import('./motion') : {}) as typeof import('./motion');
const { setInboxAgents } = (hasDom ? await import('../agentsList') : {}) as typeof import('../agentsList');
const { RunLine } = (hasDom ? await import('../components/RunLine') : {}) as typeof import('../components/RunLine');
const { agentFacts } = await import('./model');
const { resetMachineRoutes } = await import('../inboxUrl');
const { machinesModel } = await import('../machines');

let root: Root | null = null;
let realFetch: typeof fetch;
let shown: string[] = [];
let posts: string[] = [];
let bodies: unknown[] = [];

beforeEach(() => {
  if (!hasDom) return;
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if ((init?.method ?? 'GET') === 'POST') posts.push(String(input));
    if ((init?.method ?? 'GET') === 'POST') bodies.push(JSON.parse(String(init?.body ?? '{}')));
    return Response.json(String(input).endsWith('/open') ? { ok: true, command: 'x', opened: 'rex', line: 'Rex · billing / Claude Code' } : { faces: {}, rev: 0, run: null });
  }) as unknown as typeof fetch;
  shown = [];
  posts = [];
  bodies = [];
  said = [];
  window.localStorage.clear();
  motion.agentMotionOptions.simulatedDom = true;
  setInboxAgents(null);
  faces.resetAgentFaces();
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  globalThis.fetch = realFetch;
  setInboxAgents(null);
  faces.resetAgentFaces();
  resetMachineRoutes();
});

const SELF = `ibx_01K${'0'.repeat(22)}S`;
const MAC = `ibx_01K${'0'.repeat(22)}M`;
const view = (id: string, name: string): MachineView =>
  ({ id, name, self: id === SELF, state: 'online', since: '2026-11-09T08:00:00.000Z', reason: null, version: '0.29.0', address: null, both_ways: true, waiting: 0, list_cursor: 1, snoozes: true, launch: true }) as MachineView;

const LINE = 'Rex · billing / Claude Code';
const agent = (id: string, over: Partial<InboxAgent> = {}): InboxAgent => ({ id, session: id, host: 'claude-code', project: { id: 'prj_bill', name: 'billing-svc' }, state: 'idle', waiting: 0, live: true, started_at: null, last_seen_at: null, ...over });
const group = (agents: InboxAgent[], machine?: string): InboxAgentsGroup => ({ agents, total: agents.length, ended_today: 0, ...(machine ? { machine } : {}) });

let said: string[] = [];
function mount(groups: InboxAgentsGroup[], options: { phone?: boolean; linked?: boolean; own?: boolean } = {}) {
  setInboxAgents(groups);
  const host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <AgentsSection
        machines={options.linked ? machinesModel([view(SELF, 'Studio'), view(MAC, 'MacBook')]) : machinesModel([])}
        rows={[]}
        machineId={null}
        agentId={null}
        page="inbox"
        closed={false}
        onToggle={() => {}}
        labelId="l"
        bodyId="b"
        header={() => null}
        onAgentFilter={() => {}}
        onMessageAgent={() => {}}
        onAddAgent={() => {}}
        pick={(go) => go}
        phone={options.phone === true}
        onShowInRex={options.own ? undefined : (a) => shown.push(a.id)}
        announce={(text) => said.push(text)}
      />,
    ),
  );
}

const settle = async () => {
  for (let i = 0; i < 8; i++) await act(async () => await new Promise((done) => setTimeout(done, 0)));
};
const row = (id: string) => document.querySelector<HTMLElement>(`[data-sidebar-agent="${id}"]`);

async function press(el: Element) {
  await act(async () => {
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }));
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerType: 'mouse' }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
    (el as HTMLElement).click();
  });
  await settle();
}

async function itemsOf(id: string): Promise<string[] | null> {
  const more = row(id)?.querySelector('[data-agent-more]');
  if (!more) return null;
  await press(more);
  const items = [...document.querySelectorAll('[data-agent-menu] [role="menuitem"]')].map((el) => el.textContent?.trim() ?? '');
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  await settle();
  return items;
}

test.skipIf(!hasDom)('Show in Rex: on the menu only when the list says it works now; it goes to that agent', async () => {
  mount([group([agent('ses_show', { place: { kind: 'rex', line: LINE, show: true } }), agent('ses_line', { place: { kind: 'rex', line: LINE } }), agent('ses_plain')])]);
  await settle();
  expect(await itemsOf('ses_show')).toContain('Show in Rex');
  // A place without `show` (no jump confirmed by the app yet, or another computer's window): no item.
  const lineOnly = await itemsOf('ses_line');
  expect(lineOnly === null || !lineOnly.includes('Show in Rex')).toBe(true);
  const plain = await itemsOf('ses_plain');
  expect(plain === null || !plain.includes('Show in Rex')).toBe(true);
  await press(row('ses_show')!.querySelector('[data-agent-more]')!);
  await press(document.querySelector('[data-agent-action="rex"]')!);
  expect(shown).toEqual(['ses_show']);
});

test.skipIf(!hasDom)("the Inbox's own Show in Rex: asks this Inbox; a refusal is a visible line under the row, said too, and takes the item away", async () => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if ((init?.method ?? 'GET') === 'POST') posts.push(String(input));
    return Response.json(String(input).endsWith('/rex/show') ? { shown: false, refused: true } : { faces: {}, rev: 0 });
  }) as unknown as typeof fetch;
  mount([group([agent('ses_show', { place: { kind: 'rex', line: LINE, show: true } })])], { own: true });
  await settle();
  await press(row('ses_show')!.querySelector('[data-agent-more]')!);
  await press(document.querySelector('[data-agent-action="rex"]')!);
  await settle();
  expect(posts).toEqual(['/api/inbox/rex/show']);
  expect(said).toHaveLength(1);
  const note = document.querySelector('[data-agent-rex-note]');
  expect(note?.textContent).toBe(said[0]);
  // Under that agent's row, nowhere else.
  expect(row('ses_show')!.nextElementSibling).toBe(note);
  const after = await itemsOf('ses_show');
  expect(after === null || !after.includes('Show in Rex')).toBe(true);
  // The place line stays.
  expect(row('ses_show')!.querySelector('.ib-sr')!.textContent).toContain('in Rex, billing, Claude Code');
});

test.skipIf(!hasDom)("shown: the item stays, and nothing is said", async () => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if ((init?.method ?? 'GET') === 'POST') posts.push(String(input));
    return Response.json(String(input).endsWith('/rex/show') ? { shown: true } : { faces: {}, rev: 0 });
  }) as unknown as typeof fetch;
  mount([group([agent('ses_show', { place: { kind: 'rex', line: LINE, show: true } })])], { own: true });
  await settle();
  await press(row('ses_show')!.querySelector('[data-agent-more]')!);
  await press(document.querySelector('[data-agent-action="rex"]')!);
  await settle();
  expect(said).toEqual([]);
  expect(document.querySelector('[data-agent-rex-note]')).toBeNull();
  expect(await itemsOf('ses_show')).toContain('Show in Rex');
});

test.skipIf(!hasDom)('never on a phone', async () => {
  const place = { kind: 'rex' as const, line: LINE, show: true as const };
  mount([group([agent('ses_phone', { place })])], { phone: true });
  await settle();
  const onPhone = await itemsOf('ses_phone');
  expect(onPhone === null || !onPhone.includes('Show in Rex')).toBe(true);
});

test.skipIf(!hasDom)("a linked machine's agent: offered only when that machine's list says so, and the ask goes to that machine through the link", async () => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if ((init?.method ?? 'GET') === 'POST') posts.push(String(input));
    if ((init?.method ?? 'GET') === 'POST') bodies.push(JSON.parse(String(init?.body ?? '{}')));
    return Response.json(String(input).endsWith('/rex/show') ? { shown: false } : { faces: {}, rev: 0 });
  }) as unknown as typeof fetch;
  const place = { kind: 'rex' as const, line: LINE, show: true as const };
  mount([group([agent('ses_here', { place })], SELF), group([agent('ses_there', { place }), agent('ses_quiet', { place: { kind: 'rex', line: LINE } })], MAC)], { linked: true, own: true });
  await settle();
  expect(await itemsOf('ses_here')).toContain('Show in Rex');
  const quiet = await itemsOf('ses_quiet');
  expect(quiet === null || !quiet.includes('Show in Rex')).toBe(true);
  await press(row('ses_there')!.querySelector('[data-agent-more]')!);
  await press(document.querySelector('[data-agent-action="rex"]')!);
  await settle();
  // That machine's Inbox is asked (its Rex holds the pane), never this one's.
  expect(posts).toEqual([`/api/inbox/m/${MAC}/rex/show`]);
  expect(bodies[0]).toMatchObject({ session: 'ses_there' });
  // It did not show it: the line is under that agent's row, and its item goes.
  expect(row('ses_there')!.nextElementSibling).toBe(document.querySelector('[data-agent-rex-note]'));
  const after = await itemsOf('ses_there');
  expect(after === null || !after.includes('Show in Rex')).toBe(true);
});

test.skipIf(!hasDom)("the place is a Where row on the hover card and in the row's spoken name (no dot); none without one", () => {
  mount([group([agent('ses_show', { place: { kind: 'rex', line: LINE } }), agent('ses_plain')])]);
  const spoken = row('ses_show')!.querySelector('.ib-sr')!.textContent!;
  expect(spoken).toContain('in Rex, billing, Claude Code');
  expect(spoken).not.toContain('·');
  expect(row('ses_plain')!.querySelector('.ib-sr')!.textContent).not.toContain('Rex');
  expect(agentFacts({ agent: agent('a', { place: { kind: 'rex', line: LINE } }), machine: null, name: 'a', thread: null }, null).rows).toContainEqual(['Where', LINE]);
  expect(agentFacts({ agent: agent('b'), machine: null, name: 'b', thread: null }, null).rows.some(([key]) => key === 'Where')).toBe(false);
});

test.skipIf(!hasDom)("a run started in Rex: where Rex put it while it connects, Stop only when the Inbox knows its tab, its pane's prompt with the kind, and why it started in the background when Rex wasn't open", () => {
  const base = { launch_id: 'lch_1', agent: 'claude-code', project: 'billing', folder: '/work/billing', since: null, again: false, stopped_by_person: false, cause: null, untrusted: false, attach_command: null };
  const draw = (run: Record<string, unknown>) => {
    document.body.innerHTML = '';
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(<RunLine run={{ ...base, ...run } as unknown as InboxRun} canOpen={true} machine={null} machineName={null} onChanged={() => {}} />));
    return host;
  };
  expect(draw({ state: 'starting', rex: { line: null } }).textContent).toContain('Starting Claude Code in Rex…');
  expect(draw({ state: 'starting', rex: { line: LINE } }).querySelector('[data-run-rex]')!.textContent).toBe(`Started in ${LINE}`);
  const working = draw({ state: 'working', rex: { line: LINE } });
  expect(working.textContent).toContain('Claude Code is working');
  // No tab the Inbox knows: no Stop that could not work.
  expect(working.querySelector('[data-run-stop]')).toBeNull();
  // Its tab known: Stop closes it, working or at its prompt.
  expect(draw({ state: 'working', rex: { line: LINE, stops: true } }).querySelector('[data-run-stop]')).not.toBeNull();
  expect(draw({ state: 'waiting_terminal', rex: { line: LINE, waiting: 'permission', stops: true } }).querySelector('[data-run-stop]')).not.toBeNull();
  const waiting = draw({ state: 'waiting_terminal', rex: { line: LINE, waiting: 'permission' } });
  expect(waiting.textContent).toContain('Claude Code is waiting on you in Rex: a permission prompt');
  // Its tab is the way in: no Open in Terminal.
  expect(waiting.querySelector('[data-run-open]')).toBeNull();
  expect(waiting.querySelector('[data-run-stop]')).toBeNull();
  const away = draw({ state: 'working', rex: { line: null, unavailable: true } });
  expect(away.querySelector('[data-run-rex-away]')).not.toBeNull();
  expect(away.querySelector('[data-run-stop]')).not.toBeNull();
  // Rex said no to its tab: it runs in the background, said so, and the Inbox's own Stop works.
  const refused = draw({ state: 'working', rex: { line: null, refused: true } });
  expect(refused.querySelector('[data-run-rex-refused]')).not.toBeNull();
  expect(refused.querySelector('[data-run-rex-away]')).toBeNull();
  expect(refused.querySelector('[data-run-stop]')).not.toBeNull();
  // Never connected: what happened in one true sentence (it opened, it hasn't connected), Try again, and no Open in
  // Terminal (it would run a second copy beside its tab's).
  const failed = draw({ state: 'failed', rex: { line: LINE }, cause: INBOX_RUN_REX_NOT_CONNECTED });
  expect(failed.textContent).toContain(`Claude Code opened in Rex but hasn't connected to the Inbox. ${INBOX_RUN_REX_NOT_CONNECTED}`);
  expect(failed.textContent).not.toContain("didn't start");
  expect(failed.querySelector('[data-run-retry]')).not.toBeNull();
  expect(failed.querySelector('[data-run-open]')).toBeNull();
  expect(draw({ state: 'failed', cause: 'x' }).querySelector('[data-run-open]')).not.toBeNull();
  // Not a Rex start: the line as before.
  expect(draw({ state: 'starting' }).textContent).toContain('Starting Claude Code in billing…');
});

test.skipIf(!hasDom)("a reply waiting on a Rex session that may still run: the line says it waits, never that the reply starts it; Try again's why is a plain note, not an error", async () => {
  const base = { launch_id: 'lch_1', agent: 'claude-code', project: 'billing', folder: '/work/billing', since: null, again: false, stopped_by_person: false, cause: null, untrusted: false, attach_command: null };
  const draw = (run: Record<string, unknown>) => {
    document.body.innerHTML = '';
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(<RunLine run={{ ...base, ...run } as unknown as InboxRun} canOpen={true} machine={null} machineName={null} onChanged={() => {}} />));
    return host;
  };
  const stopped = (held?: string) => draw({ state: 'stopped', rex: { line: LINE, ...(held ? { held } : {}) } }).textContent ?? '';
  expect(stopped()).toContain('Your reply starts it again.');
  for (const held of ['may_run', 'still_runs']) {
    expect(stopped(held)).not.toContain('Your reply starts it again.');
    expect(stopped(held)).toContain('Your reply waits');
  }
  // The process found may be one the person resumed in another pane or terminal: never placed in its own tab.
  expect(stopped('still_runs')).not.toContain('in its tab');
  const why = "It's still running in its tab in Rex. Look there.";
  globalThis.fetch = (async () => Response.json({ error: why, code: 'launch_in_rex' }, { status: 409 })) as unknown as typeof fetch;
  const failed = draw({ state: 'failed', rex: { line: LINE }, cause: 'Its tab' });
  await act(async () => (failed.querySelector('[data-run-retry]') as HTMLButtonElement).click());
  await act(async () => await new Promise((done) => setTimeout(done, 0)));
  expect(failed.querySelector('[data-run-note]')?.textContent).toBe(why);
  expect(failed.querySelector('[data-run-error]')).toBeNull();
});

test.skipIf(!hasDom)("the hover card says what the Rex pane said, where the Inbox had nothing of its own", () => {
  const facts = (extra: Partial<InboxAgent>) => agentFacts({ agent: agent('a', { place: { kind: 'rex', line: LINE }, ...extra }), machine: null, name: 'a', thread: null }, null).state;
  expect(facts({ state: 'waiting', waiting: 0, rex_status: { state: 'blocked', kind: 'question' } })).toBe('Waiting on you in Rex: a question');
  expect(facts({ state: 'waiting', waiting: 0, rex_status: { state: 'blocked', kind: 'auth' } })).toBe('Waiting on you in Rex: a sign-in');
  expect(facts({ state: 'waiting', waiting: 0, rex_status: { state: 'blocked' } })).toBe('Waiting on you in Rex');
  // A thread of its own waiting on the person: the Inbox's words.
  expect(facts({ state: 'waiting', waiting: 2, rex_status: { state: 'blocked', kind: 'permission' } })).toBe('2 threads waiting on you');
  expect(facts({ state: 'idle', rex_status: { state: 'done' } })).toBe('Done');
  expect(facts({ state: 'idle', rex_status: { state: 'error' } })).toBe('Stopped on an error');
  expect(facts({ state: 'idle' })).toBe('Idle');
});
