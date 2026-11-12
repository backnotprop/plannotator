/**
 * An agent's face and given name on a linked machine (approval "inbox-linked-marks"): the real AgentsSection and
 * faces store, this Inbox's faces route and the agent's machine's, each on its own temp folder behind a fetch
 * stand-in (the forward answers as that machine's route does, or holds the write); no Inbox is started.
 *
 * What this catches: a face or name for a linked machine's agent kept in this Inbox's file, or drawn before that
 * machine has it (while it is away); an entry this Inbox's file has for that agent drawn over the machine's own; a
 * machine's newer list not redrawing the mark; a picker, "Your own…" or Rename… offered where they cannot land (an
 * older machine), or the mark there still answering a click; this machine's own agents changed by any of it.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAgent, InboxAgentsGroup } from '@plannotator/core/inbox-types';
import type { MachineView } from '../api';
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
const { setSelfMachine } = await import('../inboxUrl');
const { InboxHeldError } = await import('../api');
const { machinesModel } = await import('../machines');

const SELF = `ibx_01K${'0'.repeat(22)}S`;
const MAC = `ibx_01K${'0'.repeat(22)}M`;
const ART = Object.fromEntries((motion.AGENT_FACES ?? []).filter((face) => face !== 'agent').map((face) => [face, `<i data-art="${face}"></i>`])) as Parameters<typeof motion.setAgentFaceArt>[0];

let root: Root | null = null;
let realFetch: typeof fetch;
let here: ReturnType<typeof createInboxAgentFacesFile>;
let there: ReturnType<typeof createInboxAgentFacesFile>;
/** The other machine is away: the forward holds its writes (202). */
let away = false;
let forwarded: string[] = [];
let refused: unknown[] = [];

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const facesRoute = (file: ReturnType<typeof createInboxAgentFacesFile>) => createInboxAgentFaces({ file, serverSession: 'srv', readBody: async (req) => (await req.json()) as Record<string, unknown>, json }).route;
const scratchFile = () => createInboxAgentFacesFile(join(mkdtempSync(join(tmpdir(), 'pn-linked-faces-dom-')), 'inbox'), () => {});

function inboxes() {
  here = scratchFile();
  there = scratchFile();
  const own = facesRoute(here);
  const theirs = facesRoute(there);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const method = init?.method ?? 'GET';
    if (url.pathname === `/api/inbox/m/${MAC}/agent-faces`) {
      forwarded.push(String(init?.body));
      if (away) {
        const outbox = { key: 'k1', machine: MAC, route: 'agent-faces', state: 'queued', queued_at: '2026-11-12T09:00:00.000Z', settled_at: null, status: null, answer: null, notice: null, dismissed: false };
        return json({ outbox, machine: { id: MAC, name: 'Desktop', state: 'offline' } }, 202);
      }
      const forwardedUrl = new URL('/api/inbox/agent-faces', url);
      return (await theirs(new Request(forwardedUrl, { method, body: init?.body ?? null }), forwardedUrl)) ?? json({ error: 'not here' }, 404);
    }
    const req = new Request(url, { method, ...(init?.body ? { body: init.body } : {}) });
    return (await own(req, url)) ?? json({ error: 'not here' }, 404);
  }) as typeof fetch;
}

beforeEach(() => {
  if (!hasDom) return;
  realFetch = globalThis.fetch;
  away = false;
  forwarded = [];
  refused = [];
  window.localStorage.clear();
  motion.agentMotionOptions.simulatedDom = true;
  motion.setAgentFaceArt(ART);
  setSelfMachine(SELF);
  setInboxAgents(null);
  faces.resetAgentFaces();
  faces.onAgentFaceRefused((cause) => refused.push(cause));
  inboxes();
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
const view = (id: string, name: string, marks?: string[]): MachineView =>
  ({ id, name, self: id === SELF, state: 'online', since: '2026-11-09T08:00:00.000Z', reason: null, version: '0.29.0', address: null, both_ways: true, waiting: 0, list_cursor: 1, snoozes: true, launch: true, ...(marks ? { marks } : {}) }) as MachineView;
const TAKES = ['star', 'agent-face', 'agent-name'];

/** The list read: this Inbox's agent, and the other machine's with the faces its list carries now. */
function listed(macFaces = true) {
  const wire = there.wire();
  const mac: InboxAgentsGroup = { machine: MAC, agents: [agent('ses_m', { host: 'pi' })], total: 1, ended_today: 0, ...(macFaces ? { faces: wire.faces, faces_rev: wire.rev } : {}) };
  setInboxAgents([{ machine: SELF, agents: [agent('ses_a')], total: 1, ended_today: 0 }, mac]);
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 4; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function mount(marks: string[] | undefined) {
  const host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <AgentsSection
        machines={machinesModel([view(SELF, 'Laptop'), view(MAC, 'Desktop', marks)])}
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
        onRename={async (a, name) => {
          try {
            await faces.keepAgentName(a, name);
          } catch (cause) {
            return cause instanceof InboxHeldError;
          }
          return true;
        }}
      />,
    ),
  );
}

const row = (id: string) => document.querySelector<HTMLElement>(`[data-sidebar-agent="${id}"]`)!;
const markOf = (id: string) => row(id).querySelector<HTMLElement>(`[data-agent-icon="${id}"]`)!;

test.skipIf(!hasDom)("a face chosen on a linked machine's agent is kept in that machine's file only, and drawn once it answers", async () => {
  listed();
  mount(TAKES);
  await settle();
  // The click cycle's next face after the agent's own mark.
  await act(async () => markOf('ses_m').click());
  await settle();
  expect(forwarded).toHaveLength(1);
  expect(there.wire().faces.ses_m?.face).toBe('glass');
  expect(here.wire().faces.ses_m).toBeUndefined();
  expect(faces.agentFaceOf('ses_m')).toBe('glass');
  // This machine's own agent: as before, kept in this Inbox's file.
  await act(async () => markOf('ses_a').click());
  await settle();
  expect(here.wire().faces.ses_a?.face).toBe('glass');
  expect(there.wire().faces.ses_a).toBeUndefined();
  expect(forwarded).toHaveLength(1);
});

test.skipIf(!hasDom)('held while that machine is away: nothing drawn, the wait is said; its list brings the face once it lands', async () => {
  listed();
  mount(TAKES);
  await settle();
  away = true;
  await act(async () => markOf('ses_m').click());
  await settle();
  expect(faces.agentFaceOf('ses_m')).toBe('agent');
  expect(refused).toHaveLength(1);
  expect(refused[0]).toBeInstanceOf(InboxHeldError);
  expect((refused[0] as Error).message).toBe('Waiting for Desktop: this applies when Desktop is back.');
  expect(here.wire().faces.ses_m).toBeUndefined();
  // Back: the outbox delivers it there, and the next list read (the relayed `agent-faces`) carries it.
  there.change({ agent: 'ses_m', face: 'glass' });
  act(() => listed());
  await settle();
  expect(faces.agentFaceOf('ses_m')).toBe('glass');
});

test.skipIf(!hasDom)("Rename… on a linked machine's agent names it in that machine's file, and the row shows it", async () => {
  listed();
  mount(TAKES);
  await settle();
  await act(async () => {
    expect(await faces.keepAgentName(agent('ses_m'), 'Docs pass')).toBeUndefined();
  });
  await settle();
  expect(there.wire().faces.ses_m?.name).toBe('Docs pass');
  expect(here.wire().faces.ses_m).toBeUndefined();
  expect(row('ses_m').textContent).toContain('Docs pass');
  // Away: the save waits, the row keeps the name it has.
  away = true;
  let held: unknown = null;
  await act(async () => {
    held = await faces.keepAgentName(agent('ses_m'), 'Later').catch((cause: unknown) => cause);
  });
  expect(held).toBeInstanceOf(InboxHeldError);
  expect(row('ses_m').textContent).toContain('Docs pass');
});

test.skipIf(!hasDom)("an entry this Inbox's file has for a linked machine's agent is not drawn: only that machine's copy is", async () => {
  here.change({ agent: 'ses_m', face: 'glass-blue' });
  here.change({ agent: 'ses_m', name: 'Stale name' });
  await act(async () => faces.readAgentFaces());
  listed();
  mount(TAKES);
  await settle();
  expect(faces.agentFaceOf('ses_m')).toBe('agent');
  expect(row('ses_m').textContent).not.toContain('Stale name');
  there.change({ agent: 'ses_m', face: 'yellow' });
  act(() => listed());
  await settle();
  expect(faces.agentFaceOf('ses_m')).toBe('yellow');
});

test.skipIf(!hasDom)('a machine that takes faces: its agents\' picker has no "Your own…"; this machine\'s agent keeps it', async () => {
  listed();
  mount(TAKES);
  await settle();
  const open = async (id: string) => {
    // happy-dom lays nothing out: the mark at the sidebar's left, half way down a 1024 × 768 window.
    markOf(id).getBoundingClientRect = () => ({ left: 15, top: 370, width: 28, height: 28, right: 43, bottom: 398, x: 15, y: 370, toJSON: () => ({}) }) as DOMRect;
    await act(async () => markOf(id).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    await settle();
    return [...document.querySelectorAll<HTMLElement>('[data-face-choice]')].map((el) => el.dataset.faceChoice);
  };
  const theirs = await open('ses_m');
  expect(theirs).toContain('sets');
  expect(theirs).toContain('glass');
  expect(theirs).not.toContain('own');
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  mount(TAKES);
  await settle();
  expect(await open('ses_a')).toContain('own');
});

test.skipIf(!hasDom)('an older machine (its list takes no agent marks): no picker and no Rename… on its agents, and their marks show no face from here', async () => {
  here.change({ agent: 'ses_m', face: 'glass-blue' });
  await act(async () => faces.readAgentFaces());
  listed(false);
  mount(['star']);
  await settle();
  expect(markOf('ses_m').tagName).toBe('SPAN');
  expect(row('ses_m').querySelector('[data-agent-more]')).toBeNull();
  expect(faces.agentFaceOf('ses_m')).toBe('agent');
  // This machine's agent keeps both.
  expect(markOf('ses_a').tagName).toBe('BUTTON');
  expect(row('ses_a').querySelector('[data-agent-more]')).not.toBeNull();
});
