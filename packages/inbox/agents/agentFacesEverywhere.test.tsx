/**
 * One agent, one face, everywhere (agents/agentFaces.ts, icons.tsx `HostMark`'s `agent` and `AuthorMark`): a face
 * chosen on the sidebar's Agents mark shows on that agent's list-row tile, its messages' author marks, the thread's
 * participants, the reply box's recipient pill and its phone sheet, without a reload.
 *
 * What this catches: an icon that keeps the plain mark after a choice; a choice that another window (the event
 * stream) never draws; a conversation that went on under a new session id, or a launch's session, losing its face;
 * an ended agent's threads losing it; the plain mark painted first on a reload when a face is kept (a flash); a choice
 * redrawing icons of other agents (render counts over 300 rows); this browser's old faces lost on the way to the
 * Inbox, or dropped when the Inbox could not take them; the frame name missing from the shared stream.
 *
 * The Inbox's route is the real one (packages/server/inbox-agent-faces.ts) on a temp folder, called through a fetch
 * stand-in: no Inbox is started. DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Profiler, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAgent, InboxAgentsGroup, InboxParticipant } from '@plannotator/core/inbox-types';
import type { InboxAgentFacesWire } from '@plannotator/core/inbox-agent-faces';
import { createInboxAgentFacesFile } from '../../shared/inbox/agent-faces';
import { createInboxAgentFaces } from '../../server/inbox-agent-faces';

const hasDom = typeof document !== 'undefined';
if (hasDom) {
  const query = (media: string) => ({ media, matches: false, addEventListener() {}, removeEventListener() {} });
  (window as unknown as { matchMedia: unknown }).matchMedia = query;
  (globalThis as unknown as { matchMedia: unknown }).matchMedia = query;
}

const { AgentMark } = (hasDom ? await import('./AgentMark') : {}) as typeof import('./AgentMark');
const icons = (hasDom ? await import('../icons') : {}) as typeof import('../icons');
const { RowAgents, RowAgentTiles } = (hasDom ? await import('../components/RowAgents') : {}) as typeof import('../components/RowAgents');
const { ReplyRecipient } = (hasDom ? await import('../components/ReplyRecipient') : {}) as typeof import('../components/ReplyRecipient');
const { TagStack } = (hasDom ? await import('../components/TagPicker') : {}) as typeof import('../components/TagPicker');
const faces = (hasDom ? await import('./agentFaces') : {}) as typeof import('./agentFaces');
const art = (hasDom ? await import('./faceArtLoad') : {}) as typeof import('./faceArtLoad');
const motion = (hasDom ? await import('./motion') : {}) as typeof import('./motion');
const api = (hasDom ? await import('../api') : {}) as typeof import('../api');
const { setInboxAgents } = (hasDom ? await import('../agentsList') : {}) as typeof import('../agentsList');

const SOURCES = Object.fromEntries((motion.AGENT_FACES ?? []).filter((f) => f !== 'agent').map((f) => [f, f === 'transparent' ? { light: `${f}-l.svg`, dark: `${f}-d.svg` } : `${f}.svg`])) as never;
const ART = Object.fromEntries((motion.AGENT_FACES ?? []).filter((f) => f !== 'agent').map((f) => [f, `<i data-art="${f}"></i>`])) as never;

let root: Root | null = null;
let realFetch: typeof fetch;
/** What the windows' streams carried (`event: agent-faces`). */
let events: InboxAgentFacesWire[] = [];
let posts: Record<string, unknown>[] = [];
let failPosts = false;

function inbox() {
  const dir = join(mkdtempSync(join(tmpdir(), 'pn-faces-dom-')), 'inbox');
  const file = createInboxAgentFacesFile(dir, (wire) => events.push(wire));
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const { route } = createInboxAgentFaces({ file, serverSession: 'srv', readBody: async (req) => (await req.json()) as Record<string, unknown>, json });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname !== '/api/inbox/agent-faces') return json({ error: 'not here' }, 404);
    if (init?.method === 'POST') {
      posts.push(JSON.parse(String(init.body)));
      if (failPosts) return json({ error: 'down' }, 503);
    }
    return (await route(new Request(url, { method: init?.method ?? 'GET', ...(init?.body ? { body: init.body } : {}) }), url))!;
  }) as typeof fetch;
  return file;
}

const settle = async () => {
  for (let i = 0; i < 6; i++) await act(async () => await new Promise((done) => setTimeout(done, 0)));
};

beforeEach(() => {
  if (!hasDom) return;
  realFetch = globalThis.fetch;
  events = [];
  posts = [];
  failPosts = false;
  window.localStorage.clear();
  setInboxAgents(null);
  faces.resetAgentFaces();
  art.setAgentFaceSourcesForTests(SOURCES);
  motion.setAgentFaceArt(ART);
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  globalThis.fetch = realFetch;
});

function mount(node: React.ReactNode) {
  const host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(node));
  return host;
}

const agent = (over: Partial<InboxAgent>): InboxAgent => ({ id: 'ses_a', session: 'ses_a', host: 'claude-code', project: null, state: 'idle', waiting: 0, live: true, started_at: null, last_seen_at: null, ...over });
const listed = (...agents: InboxAgent[]): InboxAgentsGroup[] => [{ agents, total: agents.length, ended_today: 0 }];
const author = (session: string, host = 'claude-code') => ({ kind: 'agent' as const, host, session, name: null });
const faceOf = (el: Element | null) => el?.querySelector('[data-agent-face]')?.getAttribute('data-agent-face') ?? (el ? 'agent' : 'missing');
const recipient = (session: string) => ({ session, host: 'claude-code', label: 'Invoice retries', short: 'Invoice retries', state: 'live' as const });

function Surfaces({ sidebar }: { sidebar: InboxAgent }) {
  const participants: InboxParticipant[] = [
    { session: 'ses_a', host: 'claude-code' } as InboxParticipant,
    { session: 'ses_b', host: 'claude-code' } as InboxParticipant,
    { session: 'ses_p', host: 'pi' } as InboxParticipant,
  ];
  return (
    <>
      <div data-s="sidebar">
        <AgentMark id={sidebar.id} host={sidebar.host} name="Invoice retries" agent={sidebar} />
      </div>
      <div data-s="row">
        <RowAgents participants={undefined} agent={author('ses_a')} tip={false} />
      </div>
      <div data-s="phone-row">
        <RowAgentTiles participants={participants} agent={author('ses_a')} tip={false} />
      </div>
      <div data-s="author">
        <icons.AuthorMark author={author('ses_a')} big />
      </div>
      <div data-s="other-author">
        <icons.AuthorMark author={author('ses_b')} big />
      </div>
      <div data-s="header">
        <TagStack participants={participants} />
      </div>
      <div data-s="recipient">
        <ReplyRecipient rows={[recipient('ses_a')]} chosen={[recipient('ses_a')]} open={false} onOpen={() => {}} onOnly={() => {}} onToggle={() => {}} onTagAnother={() => {}} />
      </div>
    </>
  );
}
const at = (host: Element, s: string) => host.querySelector(`[data-s="${s}"]`);

test.if(hasDom)('a face chosen on the sidebar mark shows on the row, the authors, the header and the reply pill at once', async () => {
  inbox();
  setInboxAgents(listed(agent({})));
  const host = mount(<Surfaces sidebar={agent({})} />);
  for (const s of ['row', 'author', 'recipient']) expect(faceOf(at(host, s))).toBe('agent');
  act(() => host.querySelector<HTMLButtonElement>('[data-agent-icon="ses_a"]')!.click());
  for (const s of ['row', 'author', 'recipient']) expect(faceOf(at(host, s))).toBe('glass');
  // The phone row and the header's stack: the Claude Code tile is ses_a's (the first to join), Pi stays itself.
  expect(at(host, 'phone-row')!.querySelectorAll('[data-agent-face="glass"]').length).toBe(1);
  expect(at(host, 'header')!.querySelectorAll('[data-agent-face="glass"]').length).toBe(1);
  // Another agent of the same kind keeps its own mark.
  expect(faceOf(at(host, 'other-author'))).toBe('agent');
  await settle();
  expect(posts).toEqual([{ agent: 'ses_a', sessions: [], face: 'glass' }]);
  expect(events.at(-1)!.faces.ses_a!.face).toBe('glass');
});

test.if(hasDom)('another window’s choice, carried by the shared stream, redraws this one', async () => {
  const file = inbox();
  const host = mount(<Surfaces sidebar={agent({})} />);
  // The frame name is one the tabs' shared stream passes on.
  expect(api.INBOX_EVENT_FRAMES).toContain('agent-faces');
  file.change({ agent: 'ses_a', face: 'glass-blue' });
  act(() => api.dispatchInboxFrame({ name: 'agent-faces', data: JSON.stringify(events.at(-1)), id: null }, { onRecord: () => {}, onStatus: () => {}, onAgentFaces: faces.hearAgentFacesEvent }));
  for (const s of ['row', 'author', 'recipient', 'sidebar']) expect(at(host, s)!.querySelector('[data-agent-face="glass-blue"], [data-face="glass-blue"]')).not.toBeNull();
  // An older copy (a late relay) never takes it back.
  act(() => faces.hearAgentFacesEvent({ faces: {}, rev: 0 }));
  expect(faceOf(at(host, 'row'))).toBe('glass-blue');
});

test.if(hasDom)('a conversation that went on under a new id, and a launch’s session, keep their face', async () => {
  inbox();
  // ses_a chose Pink; its conversation goes on as ses_c (a poll's `continues`).
  faces.keepAgentFace(agent({}), 'glass-pink');
  await settle();
  setInboxAgents(listed(agent({ id: 'ses_c', session: 'ses_c', continues: ['ses_a'] })));
  await settle();
  const host = mount(
    <>
      <div data-s="sidebar">
        <AgentMark id="ses_c" host="claude-code" name="Invoice retries" agent={agent({ id: 'ses_c', session: 'ses_c', continues: ['ses_a'] })} />
      </div>
      <div data-s="new">
        <icons.AuthorMark author={author('ses_c')} />
      </div>
      <div data-s="launch">
        <icons.HostMark host="codex" agent="ses_real" />
      </div>
    </>,
  );
  expect(faces.agentFaceOf('ses_c')).toBe('glass-pink');
  expect(faceOf(at(host, 'new'))).toBe('glass-pink');
  // A launch chosen while starting: its real session, once listed, has the face.
  faces.keepAgentFace(agent({ id: 'lnc_1', session: 'launch:lnc_1', host: 'codex' }), 'totman');
  await settle();
  act(() => setInboxAgents(listed(agent({ id: 'lnc_1', session: 'ses_real', host: 'codex', launch: { id: 'lnc_1', thread_id: 'msg_1' } }))));
  await settle();
  expect(faceOf(at(host, 'launch'))).toBe('totman');
});

test.if(hasDom)('an ended agent, gone from the list, keeps its face on its old threads', async () => {
  const file = inbox();
  setInboxAgents(listed(agent({ id: 'ses_c', session: 'ses_c', continues: ['ses_a'] })));
  faces.keepAgentFace(agent({ id: 'ses_c', session: 'ses_c', continues: ['ses_a'] }), 'glass-teal');
  await settle();
  act(() => setInboxAgents(listed()));
  await settle();
  const host = mount(
    <>
      <div data-s="old">
        <icons.AuthorMark author={author('ses_a')} />
      </div>
      <div data-s="new">
        <icons.AuthorMark author={author('ses_c')} />
      </div>
    </>,
  );
  expect(faceOf(at(host, 'old'))).toBe('glass-teal');
  expect(faceOf(at(host, 'new'))).toBe('glass-teal');
  expect(file.wire().faces.ses_c!.sessions).toEqual(['ses_a']);
});

test.if(hasDom)('a reload paints the kept face first: no plain mark before the read answers', () => {
  window.localStorage.setItem(faces.AGENT_FACES_PAINT_KEY, JSON.stringify({ faces: { ses_a: { face: 'yellow', sessions: ['ses_0'] } }, rev: 4 }));
  faces.resetAgentFaces();
  const seen: string[] = [];
  function Watch() {
    return (
      <span
        ref={(el) => {
          if (el) seen.push(faceOf(el.parentElement!.querySelector('[data-s="row"]')));
        }}
      />
    );
  }
  mount(
    <>
      <div data-s="row">
        <icons.AuthorMark author={author('ses_0')} />
      </div>
      <Watch />
    </>,
  );
  expect(seen).toEqual(['yellow']);
});

test.if(hasDom)('a choice redraws only that agent’s icons, of 300 rows', async () => {
  inbox();
  const renders = new Map<string, number>();
  const count = (id: string) => () => renders.set(id, (renders.get(id) ?? 0) + 1);
  const rows = Array.from({ length: 300 }, (_, i) => `ses_${i}`);
  mount(
    <>
      {rows.map((id) => (
        <Profiler key={id} id={id} onRender={count(id)}>
          <icons.AuthorMark author={author(id)} />
        </Profiler>
      ))}
    </>,
  );
  renders.clear();
  act(() => faces.keepAgentFace('ses_7', 'glass-red'));
  await settle();
  expect([...renders.keys()]).toEqual(['ses_7']);
  expect(renders.get('ses_7')).toBe(1);
  // The server's answer (the same face) redraws nothing.
  expect(posts.length).toBe(1);
});

test.if(hasDom)('this browser’s faces from before show at once, go to the Inbox once, and stay when it cannot take them', async () => {
  window.localStorage.setItem(faces.AGENT_FACES_KEY, JSON.stringify({ ses_old: 'totman', lnc_9: 'glass-ice', bad: 'nope' }));
  faces.resetAgentFaces();
  inbox();
  expect(faces.agentFaceOf('ses_old')).toBe('totman');
  failPosts = true;
  await act(async () => await faces.readAgentFaces());
  expect(posts).toEqual([{ adopt: { ses_old: 'totman', lnc_9: 'glass-ice' } }]);
  expect(window.localStorage.getItem(faces.AGENT_FACES_KEY)).not.toBeNull();
  expect(faces.agentFaceOf('ses_old')).toBe('totman');
  failPosts = false;
  await act(async () => await faces.readAgentFaces());
  expect(window.localStorage.getItem(faces.AGENT_FACES_KEY)).toBeNull();
  expect(faces.agentFaceOf('lnc_9')).toBe('glass-ice');
  // Read again: nothing more to send.
  await act(async () => await faces.readAgentFaces());
  expect(posts.filter((p) => 'adopt' in p).length).toBe(2);
  expect(JSON.parse(window.localStorage.getItem(faces.AGENT_FACES_PAINT_KEY)!).faces.ses_old.face).toBe('totman');
});

// The owner's rule (2026-11-10): a face is drawn in exactly the box the plain mark has in every row look, so no row's
// height, gap or alignment moves, and a list with no face chosen is the same as before (measured: every look, wide,
// beside a thread and at 390, 0 pixels differ; tools in the PR body). These pin what that rests on.
test.if(hasDom)('a face takes the plain mark’s element and tile: same classes but `ib-face`, one picture in place of the glyph', () => {
  const host = mount(
    <>
      <div data-s="plain">
        <RowAgents participants={undefined} agent={author('ses_plain')} tip={false} />
      </div>
      <div data-s="faced">
        <RowAgents participants={undefined} agent={author('ses_faced')} tip={false} />
      </div>
    </>,
  );
  act(() => faces.keepAgentFace('ses_faced', 'glass-blue'));
  const plain = at(host, 'plain')!.querySelector('.ib-atile')!;
  const faced = at(host, 'faced')!.querySelector('.ib-atile')!;
  expect(faced.className).toBe(plain.className);
  expect(faced.getAttribute('style')).toBe(plain.getAttribute('style'));
  const [pm, fm] = [plain.firstElementChild!, faced.firstElementChild!];
  expect(fm.className).toBe(`${pm.className} ib-face`);
  expect(fm.getAttribute('style')).toBe(pm.getAttribute('style'));
  expect([...fm.children].map((c) => c.tagName)).toEqual(['IMG']);
  expect(fm.querySelector('img')!.getAttribute('class')).toBeNull();
});

test('the stylesheet gives a face nothing of its own but which Transparent picture shows (no size, tile or offset)', async () => {
  const css = await Bun.file(new URL('../inbox.css', import.meta.url)).text();
  const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(([, selector]) => /ib-face/.test(selector!));
  expect(rules.length).toBeGreaterThan(0);
  for (const [, selector, body] of rules) {
    const props = body!.split(';').map((d) => d.split(':')[0]!.trim()).filter(Boolean);
    expect({ selector: selector!.trim(), props }).toEqual({ selector: selector!.trim(), props: ['display'] });
  }
});
