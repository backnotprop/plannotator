/**
 * Rex in the window: an agent's place (Rex · session / tab) on its hover card and in its row's spoken name, Show in
 * Rex on its menu, and the run line's Open in Rex. What this catches: Show in Rex offered when the list did not say
 * it works now (Remote Control off, another computer's window), on a phone, or for a linked machine's agent; its
 * press reaching the wrong agent; the place missing from the card's facts; Open in Rex said while Open in Terminal
 * opens Terminal, or the other way round. A person without Rex sees no change.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt. Fetch is mocked: no server.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAgent, InboxAgentsGroup, InboxRun } from '@plannotator/core/inbox-types';
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

beforeEach(() => {
  if (!hasDom) return;
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if ((init?.method ?? 'GET') === 'POST') posts.push(String(input));
    return Response.json({ faces: {}, rev: 0, run: null });
  }) as unknown as typeof fetch;
  shown = [];
  posts = [];
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
  // A place without `show` (Remote Control off, or another computer's window): no item, so no menu of its own.
  const lineOnly = await itemsOf('ses_line');
  expect(lineOnly === null || !lineOnly.includes('Show in Rex')).toBe(true);
  const plain = await itemsOf('ses_plain');
  expect(plain === null || !plain.includes('Show in Rex')).toBe(true);
  await press(row('ses_show')!.querySelector('[data-agent-more]')!);
  await press(document.querySelector('[data-agent-action="rex"]')!);
  expect(shown).toEqual(['ses_show']);
});

test.skipIf(!hasDom)("the Inbox's own Show in Rex: asks this Inbox, and a refusal takes the item away at once", async () => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if ((init?.method ?? 'GET') === 'POST') posts.push(String(input));
    return Response.json(String(input).endsWith('/rex/show') ? { shown: false } : { faces: {}, rev: 0 });
  }) as unknown as typeof fetch;
  mount([group([agent('ses_show', { place: { kind: 'rex', line: LINE, show: true } })])], { own: true });
  await settle();
  await press(row('ses_show')!.querySelector('[data-agent-more]')!);
  await press(document.querySelector('[data-agent-action="rex"]')!);
  await settle();
  expect(posts).toEqual(['/api/inbox/rex/show']);
  const after = await itemsOf('ses_show');
  expect(after === null || !after.includes('Show in Rex')).toBe(true);
  // The place line stays.
  expect(row('ses_show')!.querySelector('.ib-sr')!.textContent).toContain(LINE);
});

test.skipIf(!hasDom)("never on a phone, nor for a linked machine's agent", async () => {
  const place = { kind: 'rex' as const, line: LINE, show: true as const };
  mount([group([agent('ses_phone', { place })])], { phone: true });
  await settle();
  const onPhone = await itemsOf('ses_phone');
  expect(onPhone === null || !onPhone.includes('Show in Rex')).toBe(true);
  act(() => root!.unmount());
  document.body.innerHTML = '';
  mount([group([agent('ses_here', { place })], SELF), group([agent('ses_there', { place })], MAC)], { linked: true });
  await settle();
  expect(await itemsOf('ses_here')).toContain('Show in Rex');
  const there = await itemsOf('ses_there');
  expect(there === null || !there.includes('Show in Rex')).toBe(true);
});

test.skipIf(!hasDom)("the place is on the hover card's facts and in the row's spoken name; none without one", () => {
  mount([group([agent('ses_show', { place: { kind: 'rex', line: LINE } }), agent('ses_plain')])]);
  expect(row('ses_show')!.querySelector('.ib-sr')!.textContent).toContain(LINE);
  expect(row('ses_plain')!.querySelector('.ib-sr')!.textContent).not.toContain('Rex');
  expect(agentFacts({ agent: agent('a', { place: { kind: 'rex', line: LINE } }), machine: null, name: 'a', thread: null }, null).place).toBe(LINE);
  expect(agentFacts({ agent: agent('b'), machine: null, name: 'b', thread: null }, null).place).toBeNull();
});

test.skipIf(!hasDom)("the run line says Open in Rex while this computer's Open in Terminal opens Rex, else Open in Terminal", async () => {
  const run = { state: 'waiting_terminal', launch_id: 'lch_1', agent: 'claude-code', project: 'billing', folder: '/work/billing', since: null, again: false, stopped_by_person: false, cause: null, untrusted: false, attach_command: null } as unknown as InboxRun;
  const draw = () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(<RunLine run={run} canOpen={true} machine={null} machineName={null} onChanged={() => {}} />));
    return host;
  };
  setInboxAgents([group([agent('ses_a')])]);
  let el = draw();
  expect(el.querySelector('[data-run-open]')!.textContent).toBe('Open in Terminal');
  act(() => setInboxAgents([{ ...group([agent('ses_a')]), open_in: 'rex' }]));
  await settle();
  expect(el.querySelector('[data-run-open]')!.textContent).toBe('Open in Rex');
  await act(async () => (el.querySelector('[data-run-open]') as HTMLButtonElement).click());
  // The same open: the server decides where it opens.
  expect(posts).toEqual(['/api/inbox/launch/lch_1/open']);
  act(() => setInboxAgents([group([agent('ses_a')])]));
  await settle();
  expect(el.querySelector('[data-run-open]')!.textContent).toBe('Open in Terminal');
});
