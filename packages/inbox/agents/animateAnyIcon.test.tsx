/**
 * "Animate it" on an icon's page in the agent icon dialog (SelectedIcon.tsx, AnimateIt.tsx), through the Inbox's real
 * routes (packages/server/inbox-icon-animate.ts, inbox-agent-faces.ts, inbox-agent-icons.ts, inbox-icon-sets.ts)
 * on a temp folder, called through a fetch stand-in: no Inbox is started.
 *
 * What this catches: "Animate it" missing from the page of an uploaded picture or a set's icon, or shown in a grid; a
 * press on a previewed icon that asks before keeping it, or keeps another; a press that asks about another icon than
 * the one shown, or attaches another picture; "Use the original" not putting a set's icon back.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAgent } from '@plannotator/core/inbox-types';
import { createInboxAgentFacesFile } from '../../shared/inbox/agent-faces';
import { createInboxAgentFaces } from '../../server/inbox-agent-faces';
import { createAgentIcons, createInboxAgentIcons } from '../../server/inbox-agent-icons';
import { createBuiltInIconSets, createInboxIconSets } from '../../server/inbox-icon-sets';
import { createIconSetFetcher } from '../../server/inbox-icon-set-fetch';
import { createInboxIconAnimate } from '../../server/inbox-icon-animate';

const hasDom = typeof document !== 'undefined';
if (hasDom) {
  (window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL('http://127.0.0.1:4000/');
  const query = (media: string) => ({ media, matches: false, addEventListener: () => {}, removeEventListener: () => {} });
  (window as unknown as { matchMedia: unknown }).matchMedia = query;
  (globalThis as unknown as { matchMedia: unknown }).matchMedia = query;
}

const { AgentMark } = (hasDom ? await import('./AgentMark') : {}) as typeof import('./AgentMark');
const faces = (hasDom ? await import('./agentFaces') : {}) as typeof import('./agentFaces');
const own = (hasDom ? await import('./ownIcons') : {}) as typeof import('./ownIcons');
const sets = (hasDom ? await import('./iconSets') : {}) as typeof import('./iconSets');
const art = (hasDom ? await import('./faceArtLoad') : {}) as typeof import('./faceArtLoad');
const motion = (hasDom ? await import('./motion') : {}) as typeof import('./motion');
const composer = (hasDom ? await import('../compose/openComposer') : {}) as typeof import('../compose/openComposer');
const { setInboxAgents } = (hasDom ? await import('../agentsList') : {}) as typeof import('../agentsList');

const SVG = (fill: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="24" fill="${fill}"/></svg>`;
const SOURCES = Object.fromEntries((motion.AGENT_FACES ?? []).filter((f) => f !== 'agent').map((f) => [f, `${f}.svg`])) as never;
const ART = Object.fromEntries((motion.AGENT_FACES ?? []).filter((f) => f !== 'agent').map((f) => [f, `<i data-art="${f}"></i>`])) as never;

let root: Root | null = null;
let realFetch: typeof fetch;
let asked: string[] = [];
let opened: { subject?: string; body: string; files?: readonly File[] }[] = [];
const onOpen = (event: Event) => opened.push((event as CustomEvent).detail);

/** The Inbox's routes on a temp folder, behind a fetch stand-in. */
function inbox() {
  const dir = join(mkdtempSync(join(tmpdir(), 'pn-animate-any-dom-')), 'inbox');
  const store = createAgentIcons({ dir: join(dir, 'agent-icons') });
  const file = createInboxAgentFacesFile(dir, () => {});
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const readBody = async (req: Request) => (await req.json()) as Record<string, unknown>;
  const facesRoute = createInboxAgentFaces({ file, serverSession: 'srv', readBody, json, icons: () => store.list() }).route;
  const iconsRoute = createInboxAgentIcons({ icons: store, faces: file, serverSession: 'srv', localOnly: () => json({}, 403), readBody, json }).route;
  const builtIn = createBuiltInIconSets();
  const fetcher = createIconSetFetcher({ dir: join(dir, 'icon-sets'), pointer: null, builtIn: builtIn.ids });
  const setsRoute = createInboxIconSets({ builtIn, fetcher, serverSession: 'srv', localOnly: () => json({}, 403), readBody, json }).route;
  const animate = createInboxIconAnimate({
    inboxDir: dir,
    icons: store,
    faces: file,
    serverSession: 'srv',
    localOnly: () => json({}, 403),
    readBody,
    json,
    touch: () => {},
    setIconKept: async (set, icon) => !!(await builtIn.read(set, icon)),
  });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    // Our faces' pictures are data: URLs once their script is in.
    if (String(input).startsWith('data:')) return realFetch(String(input));
    const url = new URL(String(input), 'http://localhost');
    asked.push(`${init?.method ?? 'GET'} ${url.pathname}`);
    const req = new Request(url, { method: init?.method ?? 'GET', ...(init?.body ? { body: init.body } : {}) });
    try {
      return (await facesRoute(req, url)) ?? (await iconsRoute(req, url, true)) ?? (await setsRoute(req, url, true)) ?? (await animate.route(req, url, true)) ?? json({ error: 'not here' }, 404);
    } catch (cause) {
      const error = cause as { message: string; code: string };
      return json({ error: error.message, code: error.code }, 422);
    }
  }) as typeof fetch;
  return { store, animate };
}

const settle = async () => {
  for (let i = 0; i < 8; i++) await act(async () => await new Promise((done) => setTimeout(done, 0)));
};

beforeEach(() => {
  if (!hasDom) return;
  realFetch = globalThis.fetch;
  asked = [];
  opened = [];
  window.localStorage.clear();
  window.addEventListener(composer.OPEN_COMPOSER_EVENT, onOpen);
  setInboxAgents(null);
  own.resetOwnIcons();
  sets.resetIconSets();
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
  window.removeEventListener(composer.OPEN_COMPOSER_EVENT, onOpen);
});

const agent: InboxAgent = { id: 'ses_a', session: 'ses_a', host: 'claude-code', project: null, state: 'idle', waiting: 0, live: true, started_at: null, last_seen_at: null };

function mount() {
  const host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<AgentMark id="ses_a" host="claude-code" name="Invoice retries" agent={agent} />));
  return host;
}

/** The fan opened by a key on the mark, then a place of the dialog. */
async function openDialog(host: Element, place: 'own' | 'sets') {
  act(() => host.querySelector('[data-agent-icon="ses_a"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  await settle();
  act(() => document.querySelector<HTMLButtonElement>(`[data-face-choice="${place}"]`)!.click());
  await settle();
  return document.querySelector<HTMLElement>('dialog[data-dialog="agent-icon"][open]')!;
}

/** "Animate it" as each place opens from the fan: its button's words, or nothing. */
async function stripInBothPlaces(host: Element) {
  const out: Record<string, string | null> = {};
  for (const place of ['sets', 'own'] as const) {
    const dialog = await openDialog(host, place);
    out[place] = dialog.querySelector('[data-animate-it] button')?.textContent ?? null;
    act(() => dialog.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.click());
    await settle();
  }
  return out;
}

test.if(hasDom)('a set icon in use: Sets opens on its page with "Animate it"; a press asks about that icon and attaches its picture', async () => {
  inbox();
  const host = mount();
  act(() => faces.keepAgentFace('ses_a', 'set:dcss/orc'));
  await settle();
  const dialog = await openDialog(host, 'sets');
  expect(dialog.querySelector('[data-selected-icon] [data-animate-it]')).not.toBeNull();
  act(() => dialog.querySelector<HTMLButtonElement>('[data-animate-go]')!.click());
  await settle();
  expect(document.querySelector('dialog[data-dialog="agent-icon"]')).toBeNull();
  expect(asked).toContain('GET /api/inbox/icon-sets/dcss/orc');
  expect(asked).toContain('POST /api/inbox/icon-animate');
  expect(opened).toHaveLength(1);
  expect(opened[0]!.subject).toBe('Animate an agent icon');
  expect(opened[0]!.body).toMatch(/--request ia_[0-9a-f]{24}/);
  expect(opened[0]!.files!.map((f) => [f.name, f.type])).toEqual([['agent-icon.png', 'image/png']]);
  expect(faces.agentFaceOf('ses_a')).toBe('set:dcss/orc');
});

test.if(hasDom)('"Animate it" is on the page of the uploaded picture or set icon in use, never in a grid; our faces, the agent’s own mark and Transparent open grids', async () => {
  const { store } = inbox();
  const host = mount();
  const kept = store.add(new TextEncoder().encode(SVG('#f97316')));
  if (!kept.ok) throw new Error('upload refused');
  own.hearOwnIcons(store.list());
  const cases: [string, Record<string, string | null>][] = [
    [`own:${kept.icon.id}`, { sets: null, own: 'Animate it' }],
    ['set:dcss/orc', { sets: 'Animate it', own: null }],
    ['glass-red', { sets: null, own: null }],
    ['totman', { sets: null, own: null }],
    ['agent', { sets: null, own: null }],
    ['transparent', { sets: null, own: null }],
  ];
  for (const [face, strip] of cases) {
    act(() => faces.keepAgentFace('ses_a', face as never));
    await settle();
    expect({ face, strip: await stripInBothPlaces(host) }).toEqual({ face, strip });
  }
});

test.if(hasDom)('a previewed icon: "Animate it" keeps it, then asks about it with its picture', async () => {
  inbox();
  const host = mount();
  const dialog = await openDialog(host, 'sets');
  act(() => dialog.querySelector<HTMLButtonElement>('.am-sets-tab[data-set="dcss"]')!.click());
  await settle();
  act(() => dialog.querySelector<HTMLButtonElement>('.am-sets-i[data-set-icon="orc"]')!.click());
  await settle();
  expect(faces.agentFaceOf('ses_a')).toBe('agent');
  act(() => dialog.querySelector<HTMLButtonElement>('[data-animate-go]')!.click());
  await settle();
  expect(faces.agentFaceOf('ses_a')).toBe('set:dcss/orc');
  expect(asked).toContain('GET /api/inbox/icon-sets/dcss/orc');
  expect(opened).toHaveLength(1);
  expect(document.querySelector('dialog[data-dialog="agent-icon"]')).toBeNull();
});

test.if(hasDom)('after a hand-back for a set icon, "Use the original" puts that set icon back', async () => {
  const { store } = inbox();
  const host = mount();
  act(() => faces.keepAgentFace('ses_a', 'set:dcss/orc'));
  await settle();
  const dialog = await openDialog(host, 'sets');
  act(() => dialog.querySelector<HTMLButtonElement>('[data-animate-go]')!.click());
  await settle();
  const request = /--request (ia_[0-9a-f]{24})/.exec(opened[0]!.body)![1];
  // The agent's hand-back (the command posts this), then the window hears the new face and picture.
  const animated = SVG('#16a34a');
  const answer = (await (await fetch('/api/inbox/icon-animate', { method: 'POST', body: JSON.stringify({ request, picture: `data:image/svg+xml;base64,${btoa(animated)}` }) })).json()) as { applied: boolean; icon: string };
  expect(answer.applied).toBe(true);
  own.hearOwnIcons(store.list());
  act(() => faces.keepAgentFace('ses_a', `own:${answer.icon}`));
  await settle();

  // The handed-back picture is an uploaded one: "Your own…" opens on its page.
  const again = await openDialog(host, 'own');
  await settle();
  const strip = again.querySelector('[data-animate-it]')!;
  expect(strip.textContent).toContain('An agent animated this picture.');
  act(() => strip.querySelector<HTMLButtonElement>('[data-animate-undo]')!.click());
  await settle();
  expect(faces.agentFaceOf('ses_a')).toBe('set:dcss/orc');
});
