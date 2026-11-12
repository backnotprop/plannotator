/**
 * Rename… on an agent's sidebar row (owner: "as its own PR next", a context menu click on the agent): the project
 * row's menu and field (ProjectRow.tsx) on the real AgentsSection, the name kept through the Inbox's real faces route
 * (packages/server/inbox-agent-faces.ts) on a temp folder, called through a fetch stand-in: no Inbox is started.
 *
 * What this catches: an agent row with no ⋯ or no right-click menu, or a menu with other words than a project's
 * ("Rename…", "Reset name" once a name is given); the field not opening with the row's name, or with another key than
 * Enter to save and Escape to cancel; the name not kept by the Inbox (so another window, or a restart, loses it), or
 * kept and not shown on the row, the list rows' and messages' labels (sessionLabels.ts) or the To picker; an empty name
 * refused instead of resetting; Reset name not going back to the agent's own name; a continued session (a new session
 * id for the same conversation) losing the name; another window's rename not shown here; focus left on the page.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAgent, InboxAgentsGroup, InboxListRow } from '@plannotator/core/inbox-types';
import type { ComposeSessionsModel } from '../api';
import { createInboxAgentFacesFile } from '../../shared/inbox/agent-faces';
import { createInboxAgentFaces } from '../../server/inbox-agent-faces';

const hasDom = typeof document !== 'undefined';
if (hasDom) {
  (window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL('http://127.0.0.1:4000/');
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
const labels = (hasDom ? await import('../sessionLabels') : {}) as typeof import('../sessionLabels');
const { useComposeSessions } = (hasDom ? await import('../compose/useComposeSessions') : {}) as typeof import('../compose/useComposeSessions');
const { machinesModel } = await import('../machines');

let root: Root | null = null;
let realFetch: typeof fetch;
let posted: Record<string, unknown>[] = [];
let said: string[] = [];
let file: ReturnType<typeof createInboxAgentFacesFile>;

/** The Inbox's faces route on a temp folder, behind a fetch stand-in. */
function inbox() {
  const dir = join(mkdtempSync(join(tmpdir(), 'pn-agent-rename-dom-')), 'inbox');
  file = createInboxAgentFacesFile(dir, () => {});
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const route = createInboxAgentFaces({ file, serverSession: 'srv', readBody: async (req) => (await req.json()) as Record<string, unknown>, json }).route;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    if (init?.method === 'POST' && url.pathname === '/api/inbox/agent-faces') posted.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    const req = new Request(url, { method: init?.method ?? 'GET', ...(init?.body ? { body: init.body } : {}) });
    return (await route(req, url)) ?? json({ error: 'not here' }, 404);
  }) as typeof fetch;
}

beforeEach(() => {
  if (!hasDom) return;
  realFetch = globalThis.fetch;
  posted = [];
  said = [];
  window.localStorage.clear();
  motion.agentMotionOptions.simulatedDom = true;
  setInboxAgents(null);
  faces.resetAgentFaces();
  labels.setSessionLabels({});
  inbox();
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  globalThis.fetch = realFetch;
  setInboxAgents(null);
  faces.resetAgentFaces();
});

const agent = (id: string, over: Partial<InboxAgent> = {}): InboxAgent => ({ id, session: id, host: 'claude-code', project: { id: 'prj_bill', name: 'billing-svc' }, state: 'idle', waiting: 0, live: true, started_at: null, last_seen_at: null, ...over });
const group = (agents: InboxAgent[]): InboxAgentsGroup => ({ agents, total: agents.length, ended_today: 0 });
const thread = (id: string, session: string, subject: string): InboxListRow =>
  ({ thread_id: id, subject, thread_name: null, author: { kind: 'agent', host: 'claude-code', session, name: null }, last_at: '2026-11-09T09:00:00.000Z', waiting_on_person: false }) as InboxListRow;

/** What other surfaces read: a session's label (the list rows' agents, a message's author). */
function Probe({ session }: { session: string }) {
  const label = labels.labelOf(labels.useSessionLabels(), session);
  return <i data-probe-label={label ?? ''} />;
}

/** The section with the window's Rename… (App.tsx `renameAgent`, as it is: keep the name, then say it). */
function mount(rows: InboxListRow[] = [], phone = false) {
  const host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <>
        <AgentsSection
          machines={machinesModel([])}
          rows={rows}
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
          phone={phone}
          announce={(text) => said.push(text)}
          onRename={async (a, name, own) => {
            try {
              await faces.keepAgentName(a, name);
            } catch {
              return false;
            }
            said.push(name === null ? `Name reset${own ? ` to ${own}` : ''}.` : `Renamed to ${name}.`);
            return true;
          }}
        />
        <Probe session="ses_a" />
      </>,
    ),
  );
  return host;
}

const settle = async () => {
  for (let i = 0; i < 8; i++) await act(async () => await new Promise((done) => setTimeout(done, 0)));
};
const row = (id: string) => document.querySelector<HTMLElement>(`[data-sidebar-agent="${id}"]`)!;
const rowName = (id: string) => row(id).querySelector('.ib-proj .ib-name')?.textContent;
const field = () => document.querySelector<HTMLInputElement>('input.ib-proj-rename');
const menuItems = () => [...document.querySelectorAll('[data-agent-menu] [role="menuitem"]')].map((el) => el.textContent?.trim());

async function openMore(id: string) {
  const more = row(id).querySelector<HTMLElement>('[data-agent-more]')!;
  await act(async () => {
    more.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }));
    more.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    more.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerType: 'mouse' }));
    more.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
    more.click();
  });
}
async function rightClick(id: string) {
  await act(async () => {
    row(id).querySelector('.ib-proj')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 40, clientY: 200 }));
  });
  await settle();
}
async function pick(action: 'rename' | 'reset') {
  await act(async () => {
    document.querySelector<HTMLElement>(`[data-agent-action="${action}"]`)!.click();
  });
  await settle();
}
async function type(text: string) {
  const input = field()!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function key(el: HTMLElement, name: string) {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
  });
  await settle();
}

test.skipIf(!hasDom)('Rename… from ⋯: the project field with the row’s name, Enter keeps it with the Inbox, every surface shows it; Reset name goes back', async () => {
  setInboxAgents([group([agent('ses_a', { label: 'Fix login redirect' })])]);
  mount([thread('thr_1', 'ses_a', 'Invoice retries')]);
  await settle();
  expect(rowName('ses_a')).toBe('Fix login redirect');
  await openMore('ses_a');
  // A project's words: Rename… alone while no name is given.
  expect(menuItems()).toEqual(['Rename…']);
  await pick('rename');
  expect(field()!.value).toBe('Fix login redirect');
  expect(field()!.getAttribute('aria-label')).toBe('Agent name');
  expect(field()!.placeholder).toBe('Fix login redirect');
  expect(document.getElementById(field()!.getAttribute('aria-describedby')!)!.textContent).toBe('Enter to save, Escape to cancel.');
  await type('  Retry   worker ');
  await key(field()!, 'Enter');
  expect(field()).toBeNull();
  expect(rowName('ses_a')).toBe('Retry worker');
  expect(posted.map(({ serverSession: _, ...change }) => change)).toEqual([{ agent: 'ses_a', sessions: [], name: 'Retry worker' }]);
  // Kept by the Inbox (another window, a restart, read it there), and shown where a session's label is read.
  expect(file.wire().faces.ses_a).toEqual({ face: 'agent', sessions: [], name: 'Retry worker' });
  expect(document.querySelector('[data-probe-label]')!.getAttribute('data-probe-label')).toBe('Retry worker');
  expect(said).toEqual(['Renamed to Retry worker.']);
  // Focus back on ⋯, never the page.
  expect(document.activeElement).toBe(row('ses_a').querySelector('[data-agent-more]'));

  // A right-click opens the same menu, now with Reset name.
  await rightClick('ses_a');
  expect(menuItems()).toEqual(['Rename…', 'Reset name']);
  await pick('reset');
  expect(rowName('ses_a')).toBe('Fix login redirect');
  expect(file.wire().faces).toEqual({});
  expect(document.querySelector('[data-probe-label]')!.getAttribute('data-probe-label')).toBe('');
  expect(said.at(-1)).toBe('Name reset to Fix login redirect.');
});

test.skipIf(!hasDom)('an empty name is Reset name; Escape cancels; a name past the cap is refused with the project’s words', async () => {
  setInboxAgents([group([agent('ses_a', { host: 'pi', project: null })])]);
  file.change({ agent: 'ses_a', face: 'glass-blue' });
  file.change({ agent: 'ses_a', name: 'Docs pass' });
  mount();
  await act(async () => await faces.readAgentFaces());
  await settle();
  expect(rowName('ses_a')).toBe('Docs pass');
  await openMore('ses_a');
  await pick('rename');
  await type('Something else');
  await key(field()!, 'Escape');
  expect(field()).toBeNull();
  expect(rowName('ses_a')).toBe('Docs pass');
  expect(posted).toEqual([]);
  await openMore('ses_a');
  await pick('rename');
  await type('x'.repeat(65));
  await key(field()!, 'Enter');
  expect(field()).not.toBeNull();
  expect(said).toEqual(['A name can be at most 64 characters.']);
  await type('   ');
  await key(field()!, 'Enter');
  expect(field()).toBeNull();
  // Its own name again (a Pi session with no title or thread: its agent's), the face it had kept.
  expect(rowName('ses_a')).toBe('Pi');
  expect(file.wire().faces.ses_a).toEqual({ face: 'glass-blue', sessions: [] });
});

test.skipIf(!hasDom)('a continued session keeps its name, and another window’s rename shows here at once', async () => {
  file.change({ agent: 'ses_old', name: 'Retry worker' });
  setInboxAgents([group([agent('ses_new', { continues: ['ses_old'], label: 'Its own title' })])]);
  mount();
  await act(async () => await faces.readAgentFaces());
  await settle();
  // The same conversation under a new session id: the name given to the old one.
  expect(rowName('ses_new')).toBe('Retry worker');
  // Renamed from here: one entry for the agent, its old session in it.
  await openMore('ses_new');
  expect(menuItems()).toEqual(['Rename…', 'Reset name']);
  await pick('rename');
  await type('Retry worker 2');
  await key(field()!, 'Enter');
  expect(file.wire().faces).toEqual({ ses_new: { face: 'agent', sessions: ['ses_old'], name: 'Retry worker 2' } });
  // Another window renamed it (`event: agent-faces`): shown without a read.
  await act(async () => faces.hearAgentFacesEvent({ faces: { ses_new: { face: 'agent', sessions: ['ses_old'], name: 'From the phone' } }, rev: 99 }));
  await settle();
  expect(rowName('ses_new')).toBe('From the phone');
});

test.skipIf(!hasDom)('a given name beats the session’s own title on the To picker’s sessions', async () => {
  file.change({ agent: 'ses_a', name: 'Retry worker' });
  const model: ComposeSessionsModel = { projects: [{ project: { id: 'prj_bill', name: 'billing-svc', root: '/code/billing' }, sessions: [{ session: 'ses_a', host: 'claude-code', label: 'Its own title' }, { session: 'ses_b', host: 'pi' }] }] } as unknown as ComposeSessionsModel;
  function To() {
    const { model: read } = useComposeSessions(true, async () => model);
    const sessions = read?.projects.flatMap((p) => p.sessions.map((s) => `${s.session}:${s.label ?? ''}`)) ?? [];
    return <i data-to={sessions.join(',')} />;
  }
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<To />));
  await act(async () => await faces.readAgentFaces());
  await settle();
  expect(host.querySelector('[data-to]')!.getAttribute('data-to')).toBe('ses_a:Retry worker,ses_b:');
});
