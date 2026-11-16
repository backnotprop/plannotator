/**
 * Agent icons from the project name, as drawn (approval "inbox-generated-agent-icons", 2026-11-15): an agent's mark
 * (icons.tsx `HostMark`) under Settings → Rows' Agent icons, and the face picker's "From the project name".
 * What this catches: the default look drawing anything but the agent's own mark (the owner: "I didn't want to remove
 * the agent icons"); the setting drawing over a face someone picked, or over the own mark picked under it; a tile with
 * the wrong letters, no corner badge, or one for an agent whose project has nothing to draw; an agent the Agents list
 * no longer names losing its project (the rows say it); the picker lacking the choice, offering it second but for
 * nothing, or the keys not reaching it; a choice there not kept, or the own mark under the setting kept as nothing.
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
  faces.hearAgentFacesEvent({ faces: { ses_p: { face: 'glass-red', sessions: [] }, ses_m: { face: 'mark', sessions: [] } }, rev: 1 });
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
  expect(sent.some((body) => (body as { agent?: string; face?: string }).agent === 'ses_o' && (body as { face?: string }).face === 'mark')).toBe(true);
  await until(() => !document.querySelector('[data-agent-tile="ses_o"] .ib-pf'), 'the own mark back');
});
