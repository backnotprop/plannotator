/**
 * Agent icons from the project name, as drawn (approval "inbox-generated-agent-icons", 2026-11-15): an agent's mark
 * (icons.tsx `HostMark`) under Settings → Rows' Agent icons, and the face picker's "From the project name".
 * What this catches: the default look drawing anything but the agent's own mark (the owner: "I didn't want to remove
 * the agent icons"); the setting drawing over a face someone picked, or over the own mark picked under it; a tile with
 * the wrong letters, no corner badge, or one for an agent whose project has nothing to draw; an agent the Agents list
 * no longer names losing its project (the rows say it); the picker lacking the choice, offering it second but for
 * nothing, or the keys not reaching it; a choice there not kept, or the own mark under the setting kept as nothing;
 * a tile choice sent as a face (an older Plannotator drops the whole entry); knowing an agent's project changing
 * anything with the setting untouched in any place its icon is drawn (the sidebar, rows, the reply box's pill and
 * mark, the thread header's pile, the picker's checked face); a linked machine from before tiles drawn a tile it
 * could not keep the own mark back over, offered one, or sent one (it refuses it with 422).
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt. No server: fetch answers here.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAgent } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
if (hasDom) {
  const query = (media: string) => ({ media, matches: false, addEventListener() {}, removeEventListener() {} });
  (window as unknown as { matchMedia: unknown }).matchMedia = query;
  (globalThis as unknown as { matchMedia: unknown }).matchMedia = query;
}

const icons = (hasDom ? await import('../icons') : {}) as typeof import('../icons');
const ui = (hasDom ? await import('@plannotator/ui/components/inbox-thread/icons') : {}) as typeof import('@plannotator/ui/components/inbox-thread/icons');
const marks = (hasDom ? await import('../letterMarks') : {}) as typeof import('../letterMarks');
const { AgentMark } = (hasDom ? await import('./AgentMark') : {}) as typeof import('./AgentMark');
const faces = (hasDom ? await import('./agentFaces') : {}) as typeof import('./agentFaces');
const project = (hasDom ? await import('./projectFace') : {}) as typeof import('./projectFace');
const { setInboxAgents } = await import('../agentsList');
const { learnProjects, resetKnownProjectsForTests } = await import('../projectPictures');
const { LIST_LOOK_DEFAULT, adoptSavedRows, resetListLookForTests } = await import('../listLook');
const { setStorageBackend, resetStorageBackend } = await import('@plannotator/ui/utils/storage');
const pill = (hasDom ? await import('../components/AgentPill') : {}) as typeof import('../components/AgentPill');
const header = (hasDom ? await import('../components/ThreadSessions') : {}) as typeof import('../components/ThreadSessions');
const { setSelfMachine } = await import('../inboxUrl');

const realFetch = globalThis.fetch;
const sent: unknown[] = [];
let root: Root | null = null;

function agent(id: string, name: string | null): InboxAgent {
  return { id, session: id, host: 'claude-code', project: name ? { id: `prj_${id}`, name } : null, state: 'idle', waiting: 0, live: true, started_at: null, last_seen_at: null };
}

beforeEach(() => {
  if (!hasDom) return;
  sent.length = 0;
  const kept = new Map<string, string>();
  setStorageBackend({ getItem: (k) => kept.get(k) ?? null, setItem: (k, v) => void kept.set(k, v), removeItem: (k) => void kept.delete(k) });
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    if (body) sent.push(body);
    return new Response(JSON.stringify({ faces: {}, rev: 0, rows: body?.rows }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  window.localStorage.clear();
  resetListLookForTests();
  resetKnownProjectsForTests();
  project.resetProjectFaces();
  faces.resetAgentFaces();
  setInboxAgents([{ agents: [agent('ses_o', 'orchard'), agent('ses_p', 'glass-picked'), agent('ses_m', 'mark-picked'), agent('ses_n', '___'), agent('ses_x', null)], total: 5, ended_today: 0 }]);
  // Faces people picked: Red glass for one, the own mark (kept under the setting) for another.
  faces.hearAgentFacesEvent({ faces: { ses_p: { face: 'glass-red', sessions: [] }, ses_m: { face: 'agent', tile: 'mark', sessions: [] } }, rev: 1 });
});

afterEach(() => {
  globalThis.fetch = realFetch;
  resetStorageBackend();
  if (!hasDom) return;
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  setInboxAgents(null);
});

function draw(node: React.ReactNode): HTMLElement {
  const host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.append(host);
  act(() => root?.unmount());
  root = createRoot(host);
  act(() => root!.render(node));
  return host;
}

/** An agent's mark under a look: Agent icons "From the project name" or not. */
function markOf(id: string, fromProject: boolean, big = false): HTMLElement {
  return draw(
    <marks.RowMarksScope look={{ ...LIST_LOOK_DEFAULT, agentProjectIcons: fromProject }}>
      <icons.HostMark host="claude-code" agent={id} big={big} />
    </marks.RowMarksScope>,
  );
}
const plain = (big = false) => draw(<ui.HostMark host="claude-code" big={big} />).innerHTML;

test.skipIf(!hasDom)('with the setting untouched every agent draws exactly what it drew before', () => {
  const before = plain();
  for (const id of ['ses_o', 'ses_m', 'ses_n', 'ses_x']) expect([id, markOf(id, false).innerHTML]).toEqual([id, before]);
  expect(markOf('ses_o', false, true).innerHTML).toBe(plain(true));
  expect(markOf('ses_p', false).querySelector('[data-agent-face]')!.getAttribute('data-agent-face')).toBe('glass-red');
});

test.skipIf(!hasDom)('"From the project name": the project\'s letters on its hue, the agent\'s own mark on the corner', () => {
  const el = markOf('ses_o', true);
  const tile = el.querySelector('.ib-mk.ib-pf')!;
  expect(tile.getAttribute('data-agent-face')).toBe('project');
  const letters = tile.querySelector('.ib-lm')!;
  expect([letters.textContent, letters.getAttribute('data-hue'), letters.hasAttribute('data-solid'), letters.getAttribute('aria-hidden')]).toEqual(['OD', String(marks.hueOf('orchard')), true, 'true']);
  // The second letter in its own span: a tile under 20 px shows the first alone (agents.css; projectFace.test.ts reads the rule).
  expect(letters.querySelector('.ib-lm-2')!.textContent).toBe('D');
  expect(markOf('ses_n', true).querySelector('.ib-lm-2')).toBeNull();
  // The badge is the agent's own mark, the same drawing as its plain mark.
  expect(tile.querySelector('.ib-pf-b')!.innerHTML).toBe(plain());
});

test.skipIf(!hasDom)('the setting changes only agents with no face picked; a picked face, the own mark picked, and a name with nothing to draw stay', () => {
  expect(markOf('ses_p', true).querySelector('[data-agent-face]')!.getAttribute('data-agent-face')).toBe('glass-red');
  for (const id of ['ses_m', 'ses_n', 'ses_x']) expect([id, markOf(id, true).innerHTML]).toEqual([id, plain()]);
});

test.skipIf(!hasDom)('an agent the Agents list no longer names takes its project from the rows it wrote in', () => {
  expect(markOf('ses_gone', true).innerHTML).toBe(plain());
  learnProjects([], [{ project: { id: 'prj_t', name: 'tidepool-web' }, author: { kind: 'agent', session: 'ses_gone' } }]);
  expect(markOf('ses_gone', true).querySelector('.ib-lm')!.textContent).toBe('TW');
});

function sidebarMark(id: string) {
  const host = draw(
    <div className="ib-sbagent">
      <AgentMark id={id} host="claude-code" name="Refactor sync engine" />
    </div>,
  );
  const icon = host.querySelector<HTMLButtonElement>(`[data-agent-icon="${id}"]`)!;
  icon.getBoundingClientRect = () => ({ left: 15, top: 370, width: 28, height: 28, right: 43, bottom: 398, x: 15, y: 370, toJSON: () => ({}) }) as DOMRect;
  return icon;
}
async function wait(ms: number) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}
async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await wait(10);
  }
  throw new Error(`timed out waiting for ${what}`);
}
const key = (el: Element, k: string) => act(() => void el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })));
const radios = () => [...document.querySelectorAll<HTMLButtonElement>('[role="radiogroup"] [role="radio"]')];

test.skipIf(!hasDom)('the picker offers "From the project name" second, by the keys; chosen, it is kept for the agent', async () => {
  const icon = sidebarMark('ses_o');
  key(icon, 'Enter');
  await until(() => radios().length > 0, 'the picker');
  expect(radios().slice(0, 3).map((r) => r.getAttribute('data-face-choice'))).toEqual(['agent', 'project', 'transparent']);
  const choice = radios()[1]!;
  expect([choice.getAttribute('aria-label'), choice.getAttribute('title'), choice.getAttribute('aria-checked')]).toEqual(['From the project name', 'From the project name', 'false']);
  expect(choice.querySelector('.ib-pf .ib-lm')!.textContent).toBe('OD');
  await until(() => document.activeElement === radios()[0], 'focus on the face shown');
  key(document.activeElement!, 'ArrowDown');
  expect(document.activeElement).toBe(choice);
  key(choice, 'Enter');
  act(() => choice.click());
  await until(() => faces.agentFaceOf('ses_o') === 'project', 'the face kept');
  expect(sent).toContainEqual({ agent: 'ses_o', sessions: [], face: 'agent', tile: 'project' });
  await until(() => !!document.querySelector('[data-agent-tile="ses_o"] .ib-pf'), 'the tile on the mark');
  // An agent whose project has nothing to draw is offered no tile.
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  key(sidebarMark('ses_n'), 'Enter');
  await until(() => radios().length > 0, 'the picker');
  expect(radios().map((r) => r.getAttribute('data-face-choice'))).not.toContain('project');
});

test.skipIf(!hasDom)('under the setting the tile is checked for an agent with none, and its own mark picked there is kept as a pick', async () => {
  adoptSavedRows(['smallNames', 'agentProjectIcons'], 1, -1);
  const icon = sidebarMark('ses_o');
  await until(() => !!document.querySelector('[data-agent-tile="ses_o"] .ib-pf'), 'the tile');
  key(icon, 'Enter');
  await until(() => radios().length > 0, 'the picker');
  expect(radios().filter((r) => r.getAttribute('aria-checked') === 'true').map((r) => r.getAttribute('data-face-choice'))).toEqual(['project']);
  act(() => radios()[0]!.click());
  await until(() => faces.agentFaceOf('ses_o') === 'mark', 'the own mark kept');
  // Kept beside the own mark, which a Plannotator from before tiles reads as the own mark (it keeps the entry's name).
  expect(sent).toContainEqual({ agent: 'ses_o', sessions: [], face: 'agent', tile: 'mark' });
  await until(() => !document.querySelector('[data-agent-tile="ses_o"] .ib-pf'), 'the own mark back');
});

test.skipIf(!hasDom)('under the setting an agent whose project has nothing to draw shows its own mark, and its picker checks it', async () => {
  adoptSavedRows(['smallNames', 'agentProjectIcons'], 1, -1);
  const icon = sidebarMark('ses_n');
  await wait(0);
  expect(document.querySelector('[data-agent-tile="ses_n"]')).toBeNull();
  key(icon, 'Enter');
  await until(() => radios().length > 0, 'the picker');
  expect(radios().map((r) => r.getAttribute('data-face-choice'))).not.toContain('project');
  expect(radios().filter((r) => r.getAttribute('aria-checked') === 'true').map((r) => r.getAttribute('data-face-choice'))).toEqual(['agent']);
});

/** Every place an agent's icon is drawn, for one agent: the sidebar's mark, a row's (and an author's) mark, the reply
 *  box's pill and mark, the thread header's pile. */
function everywhere(id: string, other: string, fromProject: boolean): HTMLElement {
  const sessions = [id, other].map((session) => ({ session, sessions: [session], host: 'claude-code', machine: null, agentId: session, name: session, state: 'idle' as const }));
  return draw(
    <marks.RowMarksScope look={{ ...LIST_LOOK_DEFAULT, agentProjectIcons: fromProject }}>
      <div className="ib-sbagent">
        <AgentMark id={id} host="claude-code" name="Refactor sync engine" />
      </div>
      <icons.HostMark host="claude-code" agent={id} />
      <icons.HostMark host="claude-code" agent={id} big />
      <pill.AgentPill host="claude-code" agent={id} label="Refactor sync engine" open={false} onClick={() => {}} ariaLabel="Reply to" />
      <pill.AgentMark host="claude-code" agent={id} count={2} open={false} onClick={() => {}} ariaLabel="Reply to" />
      <header.ThreadSessions sessions={sessions} />
    </marks.RowMarksScope>,
  );
}

test.skipIf(!hasDom)('with the setting untouched, knowing an agent\'s project changes nothing anywhere its icon is drawn', async () => {
  const known = everywhere('ses_o', 'ses_q', false).innerHTML;
  expect(known).not.toMatch(/ib-pf|data-agent-tile|hidden=""|data-agent-face="project"/);
  // The same agents with no project anywhere (neither the Agents list nor the rows say one).
  act(() => setInboxAgents([{ agents: [agent('ses_o', null), agent('ses_q', null)], total: 2, ended_today: 0 }]));
  resetKnownProjectsForTests();
  expect(everywhere('ses_o', 'ses_q', false).innerHTML).toBe(known);
  // The picker shows the own mark as the agent's face (the tile is offered, not shown).
  act(() => setInboxAgents([{ agents: [agent('ses_o', 'orchard'), agent('ses_q', 'orchard')], total: 2, ended_today: 0 }]));
  key(sidebarMark('ses_o'), 'Enter');
  await until(() => radios().length > 0, 'the picker');
  expect(radios().filter((r) => r.getAttribute('aria-checked') === 'true').map((r) => r.getAttribute('data-face-choice'))).toEqual(['agent']);
  // And the same places do draw the tile under the setting: the comparison above can see one.
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  const on = everywhere('ses_o', 'ses_q', true);
  expect(on.querySelectorAll('.ib-pf').length).toBeGreaterThanOrEqual(5);
});

test.skipIf(!hasDom)('an agent on a linked machine from before tiles keeps its own mark under the setting, is offered no tile, and is sent none', async () => {
  const SELF = `ibx_01K${'0'.repeat(22)}S`;
  const OLD = `ibx_01K${'0'.repeat(22)}O`;
  const NEW = `ibx_01K${'0'.repeat(22)}N`;
  setSelfMachine(SELF);
  act(() =>
    setInboxAgents([
      { machine: SELF, agents: [agent('ses_o', 'orchard')], total: 1, ended_today: 0 },
      // 0.28.66: faces, and no `face_tiles`.
      { machine: OLD, agents: [agent('ses_far', 'kestrel')], total: 1, ended_today: 0, faces: {}, faces_rev: 1 },
      { machine: NEW, agents: [agent('ses_new', 'tidepool-web')], total: 1, ended_today: 0, faces: {}, faces_rev: 1, face_tiles: true },
    ]),
  );
  await wait(0);
  expect(markOf('ses_far', true).innerHTML).toBe(plain());
  expect(markOf('ses_new', true).querySelector('.ib-pf .ib-lm')!.textContent).toBe('TW');
  expect(markOf('ses_o', true).querySelector('.ib-pf .ib-lm')!.textContent).toBe('OD');
  key(sidebarMark('ses_far'), 'Enter');
  await until(() => radios().length > 0, 'the picker');
  const choices = radios().map((r) => r.getAttribute('data-face-choice'));
  expect(choices).not.toContain('project');
  expect(radios().filter((r) => r.getAttribute('aria-checked') === 'true').map((r) => r.getAttribute('data-face-choice'))).toEqual(['agent']);
  // Even asked to, the store sends that machine only what it keeps: the own mark as `agent`, never a tile.
  sent.length = 0;
  faces.keepAgentFace('ses_far', 'mark');
  faces.keepAgentFace('ses_far', 'project');
  await wait(0);
  // (A forward to a linked machine carries its own idempotency key: not part of the change.)
  const changes = () => sent.map((body) => Object.fromEntries(Object.entries(body as Record<string, unknown>).filter(([k]) => k !== 'idempotency_key')));
  expect(changes().filter((body) => body.agent === 'ses_far')).toEqual([
    { agent: 'ses_far', sessions: [], face: 'agent' },
    { agent: 'ses_far', sessions: [], face: 'agent' },
  ]);
  // A machine that keeps tiles is sent the tile.
  faces.keepAgentFace('ses_new', 'project');
  await wait(0);
  expect(changes()).toContainEqual({ agent: 'ses_new', sessions: [], face: 'agent', tile: 'project' });
});
