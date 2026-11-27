/**
 * The agent's card and profile (approval "inbox-agent-profile-card"), drawn by the real InboxList inside the window's
 * AgentProfileHost, as App draws them.
 *
 * What this catches: a card on a list not filtered to an agent, or a second one in the Agents view; the card's line
 * claiming a state the Inbox does not know (an agent with no plugin), or the permission prompt not in amber; the card
 * not opening the profile, a second press not closing it, ✕ or Escape not closing it, a thread in the profile not
 * replacing it; the Agents view's row still folding instead of opening the profile, or its arrow not folding; a linked
 * computer's agent without its computer, its threads or its details; the one-second clock running while no line
 * counts (work for a person not using this).
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt. No server, no fetch.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAgent, InboxAgentsGroup, InboxListGroupId, InboxListRow, InboxListSection } from '@plannotator/core/inbox-types';
import type { TidyController } from '../components/Tidy';
import type { MachineView } from '../api';
import type { MachinesModel } from '../machines';
import type { Route } from '../app/route';

const hasDom = typeof document !== 'undefined';
const { InboxList } = (hasDom ? await import('../components/InboxList') : {}) as typeof import('../components/InboxList');
const { SidebarProvider } = (hasDom ? await import('../shell/sidebar') : {}) as typeof import('../shell/sidebar');
const { setInboxAgents } = (hasDom ? await import('../agentsList') : {}) as typeof import('../agentsList');
const { AgentProfileHost } = (hasDom ? await import('./nav') : {}) as typeof import('./nav');
const { agentClockRunning } = await import('./clock');
const { LIST_VIEW_COOKIE, resetListViewForTests } = await import('../listView');
const { resetAgentFoldsForTests } = await import('../agentsView/folds');
const { setStorageBackend, resetStorageBackend } = await import('@plannotator/ui/utils/storage');

const stored = new Map<string, string>();
let root: Root | null = null;
let host: HTMLElement | null = null;
let routeNow: Route = { page: 'inbox', project: null, thread: null };
const messaged: string[] = [];

beforeEach(() => {
  stored.clear();
  messaged.length = 0;
  setStorageBackend({ getItem: (key) => stored.get(key) ?? null, setItem: (key, value) => void stored.set(key, value), removeItem: (key) => void stored.delete(key) });
  resetListViewForTests();
  resetAgentFoldsForTests();
});

afterEach(() => {
  resetStorageBackend();
  resetListViewForTests();
  resetAgentFoldsForTests();
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  setInboxAgents(null);
  document.body.innerHTML = '';
});

const TIDY: TidyController = { surface: 'list', scope: null, plan: null, run: null, start: async () => null, refresh: () => {} };
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

function row(id: string, minutesAgo: number, section: InboxListRow['section'], session: string, extra: Partial<InboxListRow> = {}): InboxListRow {
  return {
    thread_id: id,
    project: { id: 'prj_h', name: 'harbor' },
    subject: `Thread ${id}`,
    thread_name: null,
    author: { kind: 'agent', host: 'claude-code', session, name: null },
    last_at: ago(minutesAgo),
    last_agent_at: ago(minutesAgo),
    last_author: 'agent',
    section,
    unread: section === 'waiting',
    unseen: 0,
    questions: { open: section === 'waiting' ? 1 : 0, picked: 0, stopped: false, holds_up: [] },
    sent: null,
    resolved_at: null,
    ...extra,
  } as unknown as InboxListRow;
}

function agent(id: string, label: string, over: Partial<InboxAgent> = {}): InboxAgent {
  return { id, session: id, host: 'claude-code', label, project: { id: 'prj_h', name: 'harbor' }, state: 'idle', waiting: 0, live: true, started_at: ago(80), last_seen_at: ago(1), ...over };
}

const WORKING = agent('ses_web', 'harbor-web', { state: 'working', state_since: ago(3), model: 'claude-opus-5-5', effort: 'high', context: 38 });
const ASKING = agent('ses_ask', 'harbor-test', { state: 'waiting', waiting: 1, status_mark: { state: 'blocked', kind: 'permission', where: 'terminal' } });
const IDLE = agent('ses_docs', 'quill-docs', { state_since: ago(45) });
const NO_PLUGIN = agent('ses_cx', 'checkout', { host: 'codex', turns_unknown: true });

const ROWS = [
  row('web-wait', 20, 'waiting', 'ses_web', { thread_name: 'Docs for the Agents section' }),
  row('web-sent', 10, 'sent', 'ses_web', { thread_name: 'Rename Machines to Agents' }),
  row('ask-1', 5, 'waiting', 'ses_ask'),
  row('docs-1', 30, 'quiet', 'ses_docs'),
  row('cx-1', 40, 'quiet', 'ses_cx'),
];

function sections(rows: readonly InboxListRow[]): InboxListSection[] {
  const ids: InboxListGroupId[] = ['stopped', 'holding', 'waiting', 'new', 'sent', 'quiet', 'snoozed'];
  return ids.map((id) => ({ id, label: id, threads: rows.filter((r) => r.section === id) })) as InboxListSection[];
}

const NO_MACHINES: MachinesModel = { self: null, all: [], linked: [], names: new Map(), away: new Set() };
const machine = (id: string, name: string) => ({ id, name }) as unknown as MachineView;
const LINKED: MachinesModel = { self: 'ibx_lap', all: [machine('ibx_lap', 'Laptop'), machine('ibx_studio', 'Studio')], linked: [machine('ibx_studio', 'Studio')], names: new Map([['ibx_lap', 'Laptop'], ['ibx_studio', 'Studio']]), away: new Set() };

function Window({ start, machines, rows }: { start: Route; machines: MachinesModel; rows: readonly InboxListRow[] }) {
  const [route, setRoute] = useState(start);
  routeNow = route;
  return (
    <SidebarProvider>
      <AgentProfileHost route={route} go={setRoute} close={setRoute} machines={machines} rows={rows} phone={false} stacked={false} backLabel="harbor-web" onMessage={(session) => messaged.push(session)}>
        <InboxList
          title="harbor-web"
          path={null}
          sections={sections(rows)}
          sort={{ epoch: 1, keep: null }}
          filtered={false}
          narrow={!!route.profile}
          phone={false}
          machines={machines}
          selectedThreadId={route.thread}
          notice={null}
          onShowNew={() => {}}
          onOpen={(r: InboxListRow) => setRoute({ ...route, profile: null, thread: r.thread_id })}
          tidy={TIDY}
        />
      </AgentProfileHost>
    </SidebarProvider>
  );
}

function render(options: { agent?: string | null; groups?: InboxAgentsGroup[]; machines?: MachinesModel; rows?: readonly InboxListRow[]; profile?: string } = {}): HTMLElement {
  setInboxAgents(options.groups ?? [{ agents: [WORKING, ASKING, IDLE, NO_PLUGIN], total: 4, ended_today: 0 }]);
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.append(host);
  root = createRoot(host);
  const start: Route = { page: 'inbox', project: null, agent: options.agent ?? null, profile: options.profile ?? null, thread: null };
  act(() => root!.render(<Window start={start} machines={options.machines ?? NO_MACHINES} rows={options.rows ?? ROWS} />));
  return host;
}

const card = (el: HTMLElement) => el.querySelector<HTMLElement>('[data-agent-card]');
const cardButton = (el: HTMLElement) => el.querySelector<HTMLButtonElement>('.ib-apc-b')!;
const profile = (el: HTMLElement) => el.querySelector<HTMLElement>('[data-agent-profile]');
const click = (node: HTMLElement) => act(() => node.click());

describe.skipIf(!hasDom)('the card atop a list filtered to one agent', () => {
  test('no filter, no card; filtered, its name, kind and project, and what it does now with how long', () => {
    expect(card(render())).toBeNull();
    act(() => root!.unmount());
    host!.remove();
    const el = render({ agent: 'ses_web' });
    const shown = card(el)!;
    expect(shown.querySelector('.ib-apc-n')!.textContent).toBe('harbor-web');
    expect(shown.querySelector('.ib-apc-m')!.textContent).toBe('Claude Code · harbor');
    expect(shown.querySelector('[data-agent-line]')!.getAttribute('data-agent-line')).toBe('working');
    expect(shown.querySelector('.ib-apl-w')!.textContent).toBe('Working');
    expect(shown.querySelector('[data-agent-line-time]')!.textContent).toBe('3m');
    expect(shown.querySelector('.ib-apl-spin')).not.toBeNull();
    expect(agentClockRunning()).toBe(true);
  });

  test('stuck on a permission prompt: amber words with the pause mark', () => {
    const shown = card(render({ agent: 'ses_ask' }))!;
    const line = shown.querySelector('[data-agent-line]')!;
    expect(line.getAttribute('data-tone')).toBe('asking');
    expect(line.textContent).toBe('Asking for permission');
    expect(line.querySelector('.ib-apl-pause')).not.toBeNull();
  });

  test('idle says since when; an agent with no plugin shows no line and nothing in its place, and no clock runs', () => {
    expect(card(render({ agent: 'ses_docs' }))!.querySelector('.ib-apl-w')!.textContent).toMatch(/^Idle since /);
    act(() => root!.unmount());
    host!.remove();
    const shown = card(render({ agent: 'ses_cx' }))!;
    expect(shown.getAttribute('data-agent-card-line')).toBe('none');
    expect(shown.querySelector('.ib-apc-2')).toBeNull();
    expect(shown.querySelector('.ib-apc-m')!.textContent).toBe('Codex · harbor');
    expect(agentClockRunning()).toBe(false);
  });

  test('the Agents view draws no second card: its agent row is the card', () => {
    stored.set(LIST_VIEW_COOKIE, 'agents');
    resetListViewForTests();
    const el = render({ agent: 'ses_web' });
    expect(card(el)).toBeNull();
    expect(el.querySelector('[data-agent-head]')).not.toBeNull();
  });
});

describe.skipIf(!hasDom)('the profile', () => {
  test('the card opens it in the reading pane, pressed; its Activity, Threads, Details and Message', () => {
    const el = render({ agent: 'ses_web' });
    expect(profile(el)).toBeNull();
    click(cardButton(el));
    expect(routeNow.profile).toBe('ses_web');
    expect(cardButton(el).getAttribute('aria-pressed')).toBe('true');
    const pane = profile(el)!;
    expect(pane.matches('section.ib-pane')).toBe(true);
    expect(pane.querySelector('h2')!.textContent).toBe('harbor-web');
    expect(pane.querySelector('[data-agent-profile-activity] .ib-apl-w')!.textContent).toBe('Working');
    const threads = [...pane.querySelectorAll<HTMLElement>('[data-agent-profile-thread]')];
    expect(threads.map((t) => t.getAttribute('data-agent-profile-thread'))).toEqual(['web-sent', 'web-wait']);
    expect(threads[1]!.querySelector('.ib-apf-th-w')!.textContent).toBe('Waiting on you');
    expect(threads[0]!.querySelector('.ib-apf-th-w')).toBeNull();
    const details = Object.fromEntries([...pane.querySelectorAll('dl div')].map((d) => [d.querySelector('dt')!.textContent, d.querySelector('dd')!.textContent]));
    expect(details.Model).toBe('Opus 5.5 · high');
    expect(details.Context).toBe('38% used');
    expect(Object.keys(details)).toContain('Started');
    click(pane.querySelector<HTMLButtonElement>('[data-agent-profile-message]')!);
    expect(messaged).toEqual(['ses_web']);
  });

  test('a thread in it replaces it; ✕, Escape and a second press on the card close it', () => {
    const el = render({ agent: 'ses_web', profile: 'ses_web' });
    click(profile(el)!.querySelector<HTMLButtonElement>('[data-agent-profile-thread="web-wait"]')!);
    expect(routeNow).toMatchObject({ thread: 'web-wait', agent: 'ses_web' });
    expect(routeNow.profile ?? null).toBeNull();
    expect(profile(el)).toBeNull();
    expect(cardButton(el).getAttribute('aria-pressed')).toBe('false');

    click(cardButton(el));
    expect(routeNow.thread).toBeNull();
    click(profile(el)!.querySelector<HTMLButtonElement>('[data-agent-profile-close]')!);
    expect(profile(el)).toBeNull();
    expect(routeNow).toMatchObject({ agent: 'ses_web', thread: null });

    click(cardButton(el));
    act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(profile(el)).toBeNull();

    click(cardButton(el));
    expect(profile(el)).not.toBeNull();
    click(cardButton(el));
    expect(profile(el)).toBeNull();
  });
});

describe.skipIf(!hasDom)('the Agents view', () => {
  test("an agent's row opens its profile and carries its line; the arrow at its end folds it", () => {
    stored.set(LIST_VIEW_COOKIE, 'agents');
    resetListViewForTests();
    const el = render();
    const group = el.querySelector<HTMLElement>('.ib-lbody > [data-agent="ses_web"]')!;
    const head = group.querySelector<HTMLButtonElement>('[data-agent-head]')!;
    const fold = group.querySelector<HTMLButtonElement>('[data-agent-fold]')!;
    expect(head.querySelector('[data-agent-line]')!.textContent).toBe('Working3m');
    expect(head.hasAttribute('aria-expanded')).toBe(false);
    expect(fold.getAttribute('aria-label')).toBe('harbor-web threads');
    const open = fold.getAttribute('aria-expanded') === 'true';
    const rows = () => group.querySelectorAll('[data-thread-id]').length;
    const before = rows();

    click(head);
    expect(routeNow.profile).toBe('ses_web');
    expect(head.getAttribute('aria-pressed')).toBe('true');
    expect(profile(el)!.querySelector('h2')!.textContent).toBe('harbor-web');
    // The row's press folds nothing.
    expect(rows()).toBe(before);

    click(fold);
    expect(fold.getAttribute('aria-expanded')).toBe(String(!open));
    expect(rows() === 0).toBe(open);
    expect(routeNow.profile).toBe('ses_web');

    // The agent asking in its terminal: amber on its row too.
    const asking = el.querySelector('.ib-lbody > [data-agent="ses_ask"] [data-agent-line]')!;
    expect(asking.getAttribute('data-tone')).toBe('asking');
  });
});

describe.skipIf(!hasDom)("a linked computer's agent", () => {
  test('the card names the other computer; the profile always names its computer and lists its threads from there', () => {
    const fern = agent('ses_fern', 'fern-api', { host: 'pi', project: { id: 'prj_f', name: 'fern' }, state: 'working', state_since: ago(1), model: 'claude-opus-5-5', context: 22 });
    const own = agent('ses_web', 'harbor-web');
    const rows = [row('fern-1', 3, 'new', 'ses_fern', { machine: 'ibx_studio', thread_name: 'Retry queue for refunds' }), row('own-1', 2, 'quiet', 'ses_web', { machine: 'ibx_lap' })];
    const el = render({
      agent: 'ses_fern',
      machines: LINKED,
      rows,
      groups: [
        { machine: 'ibx_lap', agents: [own], total: 1, ended_today: 0 },
        { machine: 'ibx_studio', agents: [fern], total: 1, ended_today: 0 },
      ],
    });
    expect(card(el)!.querySelector('.ib-apc-m')!.textContent).toBe('Pi · fern · Studio');
    click(cardButton(el));
    const pane = profile(el)!;
    expect(pane.querySelector('.ib-apf-sub')!.textContent).toBe('Pi · fern · Studio');
    expect([...pane.querySelectorAll('[data-agent-profile-thread]')].map((t) => t.getAttribute('data-agent-profile-thread'))).toEqual(['fern-1']);
    expect(pane.textContent).toContain('22% used');
    act(() => root!.unmount());
    host!.remove();
    // This computer's own agent: the card does not name the computer; the profile does.
    const mine = render({ agent: 'ses_web', machines: LINKED, rows, groups: [{ machine: 'ibx_lap', agents: [own], total: 1, ended_today: 0 }] });
    expect(card(mine)!.querySelector('.ib-apc-m')!.textContent).toBe('Claude Code · harbor');
    click(cardButton(mine));
    expect(profile(mine)!.querySelector('.ib-apf-sub')!.textContent).toBe('Claude Code · harbor · Laptop');
  });
});
