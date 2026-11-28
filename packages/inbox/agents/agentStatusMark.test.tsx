/**
 * The status mark for every agent, behind the "Agent status" setting (agents/agentStatus.ts, agents/rexMark.tsx;
 * owner, 2026-11-18). What this catches:
 *  - a mark drawn with the setting off (the default), or a Rex agent's mark gone with it (Rex marks shipped and show
 *    regardless);
 *  - with it on: a state drawn as another, or its words wrong; a thread waiting in the Inbox drawn as a bare disc; a prompt in the agent's terminal not saying so in its
 *    label ("in the agent", never as if it waited in the Inbox); a host that reports no turns drawn at all;
 *  - a fresh Rex record not winning;
 *  - a setting mark on a thread row's icon (owner ruling, 2026-11-18: only where an agent is shown as an agent, the
 *    sidebar's Agents list; a per-agent "Waiting on you" on each of its rows is false for rows that do not wait),
 *    while Rex's marks keep showing there;
 *  - the two switches (Settings' row, the ⋮ menu's item) disagreeing, or a press not saved as `agent_status`;
 *  - a press that does not show at once, or that a list read which already agrees does not settle.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt. No server: the agents list is set and
 * the save is a stand-in fetch.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Menu } from '@base-ui/react/menu';
import type { InboxAgent, InboxAgentMark, InboxAgentsGroup, InboxRexMark } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
if (hasDom) {
  const query = (media: string) => ({ media, matches: false, addEventListener: () => {}, removeEventListener: () => {} });
  (window as unknown as { matchMedia: unknown }).matchMedia = query;
  (globalThis as unknown as { matchMedia: unknown }).matchMedia = query;
  Element.prototype.animate = function () {
    return { currentTime: 0, playbackRate: 1, finished: Promise.resolve(), playState: 'running', play() {}, pause() {}, cancel() {}, finish() {} } as unknown as Animation;
  } as typeof Element.prototype.animate;
  (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

const { HostMark } = (hasDom ? await import('../icons') : {}) as typeof import('../icons');
const { AgentMark } = (hasDom ? await import('./AgentMark') : {}) as typeof import('./AgentMark');
const motion = (hasDom ? await import('./motion') : {}) as typeof import('./motion');
const faces = (hasDom ? await import('./agentFaces') : {}) as typeof import('./agentFaces');
const { setInboxAgents } = (hasDom ? await import('../agentsList') : {}) as typeof import('../agentsList');
const status = (hasDom ? await import('./agentStatus') : {}) as typeof import('./agentStatus');
const { AgentStatusRow } = (hasDom ? await import('./AgentStatusSwitch') : {}) as typeof import('./AgentStatusSwitch');
const { AgentStatusMenuItem } = (hasDom ? await import('../components/Tidy') : {}) as typeof import('../components/Tidy');

let root: Root | null = null;
let realFetch: typeof fetch;
let saves: unknown[] = [];

beforeEach(() => {
  if (!hasDom) return;
  realFetch = globalThis.fetch;
  saves = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (String(url).includes('/settings') && init?.method === 'POST') {
      saves.push(JSON.parse(String(init.body)));
      return Response.json({ agent_status: { on: true } });
    }
    return Response.json({ faces: {}, rev: 0 });
  }) as unknown as typeof fetch;
  window.localStorage.clear();
  (motion as unknown as { agentMotionOptions: { simulatedDom: boolean } }).agentMotionOptions.simulatedDom = true;
  setInboxAgents(null);
  status.resetAgentStatusForTests();
  faces.resetAgentFaces();
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  globalThis.fetch = realFetch;
  setInboxAgents(null);
  status.resetAgentStatusForTests();
  faces.resetAgentFaces();
});

const agent = (id: string, over: { status?: InboxAgentMark; rex?: InboxRexMark; unknown?: boolean } = {}): InboxAgent => ({
  id,
  session: id,
  host: 'claude-code',
  project: { id: 'prj_bill', name: 'billing-svc' },
  state: 'working',
  waiting: 0,
  live: true,
  started_at: null,
  last_seen_at: null,
  ...(over.status ? { status_mark: over.status } : {}),
  ...(over.rex ? { rex_mark: over.rex } : {}),
  ...(over.unknown ? { turns_unknown: true as const } : {}),
});
const list = (agents: InboxAgent[], on: boolean): InboxAgentsGroup[] => [{ agents, total: agents.length, ended_today: 0, ...(on ? { status_marks: true as const } : {}) }];

const AGENTS = [
  agent('ses_rex', { rex: { state: 'working' }, status: { state: 'working' } }),
  agent('ses_work', { status: { state: 'working' } }),
  agent('ses_rest'),
  agent('ses_here', { status: { state: 'blocked', where: 'inbox' } }),
  agent('ses_perm', { status: { state: 'blocked', kind: 'permission', where: 'terminal' } }),
  agent('ses_q', { status: { state: 'blocked', kind: 'question', where: 'terminal' } }),
  agent('ses_codex', { unknown: true }),
];

function draw(node: React.ReactNode) {
  const host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(node));
  return host;
}
/** The sidebar's Agents list: each agent's own mark (AgentMark, as AgentsSection draws it). */
const icons = () => (
  <>
    {AGENTS.map((a) => (
      <div key={a.id} className="ib-sbagent" data-agent={a.id}>
        <AgentMark id={a.id} host="claude-code" name={a.id} agent={a} statusMarks />
      </div>
    ))}
  </>
);
const marksOf = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>('[data-agent]')].map((row) => row.querySelector<HTMLElement>('.ib-rxm')?.getAttribute('aria-label') ?? null);
const markOf = (el: HTMLElement, i: number) => el.querySelectorAll<HTMLElement>('[data-agent]')[i]!.querySelector<HTMLElement>('.ib-rxm')!;
const settle = async () => {
  for (let i = 0; i < 4; i++) await act(async () => await new Promise((done) => setTimeout(done, 0)));
};

test.skipIf(!hasDom)('off (the default): only the Rex agent carries a mark, and every other icon is exactly as before', () => {
  setInboxAgents(list(AGENTS, false));
  const el = draw(icons());
  expect(marksOf(el)).toEqual(['Working', null, null, null, null, null, null]);
});

test.skipIf(!hasDom)('on: each agent its mark and words, a terminal prompt saying where; at rest and a host that reports no turns none; Rex wins', () => {
  setInboxAgents(list(AGENTS, true));
  const el = draw(icons());
  expect(marksOf(el)).toEqual(['Working', 'Working', null, 'Waiting on you', 'Waiting for your permission in the agent', 'Waiting for your answer in the agent', null]);
  const perm = markOf(el, 4);
  // The same jelly mark Rex draws for a blocked pane, its words as its text alternative only.
  expect([perm.dataset.rxState, perm.dataset.rxWhere, perm.getAttribute('title'), perm.hasAttribute('data-rx-wait')]).toEqual(['permission', 'terminal', 'Waiting for your permission in the agent', true]);
  // Waiting on the person in the Inbox: Rex's question jelly (the "?"), never the bare waiting disc; its own words.
  const here = markOf(el, 3);
  expect([here.dataset.rxState, here.getAttribute('aria-label')]).toEqual(['question', 'Waiting on you']);
  expect(el.textContent).toBe('');
});

test.skipIf(!hasDom)("on: a thread row's icon never gains a setting mark (one waiting row, one finished row of the same agent); Rex's still shows", () => {
  setInboxAgents(list(AGENTS, true));
  // Two rows of the agent that waits on the person in the Inbox (one row waits, one is finished), and a Rex agent's row.
  const el = draw(
    <>
      <HostMark host="claude-code" agent="ses_here" />
      <HostMark host="claude-code" agent="ses_here" />
      <HostMark host="claude-code" agent="ses_perm" />
      <HostMark host="claude-code" agent="ses_rex" />
    </>,
  );
  expect([...el.querySelectorAll<HTMLElement>('.ib-mk')].map((mk) => mk.querySelector('.ib-rxm')?.getAttribute('aria-label') ?? null)).toEqual([null, null, null, 'Working']);
});

test.skipIf(!hasDom)('the two switches agree: one press shows at once in both and on every icon, and is saved as agent_status', async () => {
  setInboxAgents(list(AGENTS, false));
  const el = draw(
    <>
      <AgentStatusRow />
      <Menu.Root open modal={false}>
        <Menu.Portal>
          <Menu.Positioner>
            <Menu.Popup>
              <AgentStatusMenuItem />
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
      {icons()}
    </>,
  );
  const sw = () => el.querySelector<HTMLElement>('[data-settings-agent-status] [role="switch"]')!;
  const item = () => document.querySelector<HTMLElement>('[data-agent-status-option]')!;
  expect([sw().getAttribute('aria-checked'), item().getAttribute('aria-checked')]).toEqual(['false', 'false']);
  act(() => sw().click());
  expect([sw().getAttribute('aria-checked'), item().getAttribute('aria-checked')]).toEqual(['true', 'true']);
  expect(marksOf(el)[1]).toBe('Working');
  await settle();
  expect(saves).toEqual([{ agent_status: { on: true } }]);
  // The next list read says it is on (every window reads it): still on, from the list now.
  act(() => setInboxAgents(list(AGENTS, true)));
  status.resetAgentStatusForTests();
  expect([sw().getAttribute('aria-checked'), item().getAttribute('aria-checked')]).toEqual(['true', 'true']);
  // Another window turned it off: both follow the list.
  act(() => setInboxAgents(list(AGENTS, false)));
  expect([sw().getAttribute('aria-checked'), item().getAttribute('aria-checked')]).toEqual(['false', 'false']);
  expect(marksOf(el)).toEqual(['Working', null, null, null, null, null, null]);
});

test.skipIf(!hasDom)("two windows: once this window's save landed, a list carrying another window's later save wins (no stale press)", async () => {
  setInboxAgents(list(AGENTS, false));
  const el = draw(<AgentStatusRow />);
  const sw = () => el.querySelector<HTMLElement>('[data-settings-agent-status] [role="switch"]')!;
  act(() => sw().click());
  await settle();
  expect(saves).toEqual([{ agent_status: { on: true } }]);
  // Before this window read a list that says on, the other window turned it off: the list now says off.
  act(() => setInboxAgents(list(AGENTS, false)));
  expect(sw().getAttribute('aria-checked')).toBe('false');
});
