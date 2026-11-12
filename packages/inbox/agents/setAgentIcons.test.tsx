/**
 * "Sets": an icon from a set as an agent's icon (agents/iconSets.ts, SetsBody.tsx, AgentIconDialog.tsx, icons.tsx `HostMark`, motion.ts),
 * through the Inbox's real routes (packages/server/inbox-icon-sets.ts, inbox-agent-faces.ts) on a temp folder, called
 * through a fetch stand-in: no Inbox is started. The fetchable set comes from a local fake server
 * (tests/helpers/fake-icon-set.ts, generated pictures on 127.0.0.1).
 *
 * What this catches: the fan without its "Sets" place, or that place not opening the sets; a picked icon kept before
 * "Use this icon", or kept by the back control or Close; a used icon not kept as `set:<set>/<icon>`, or not shown on the sidebar, the row, the author, the header or the reply pill; a pixel set drawn
 * without its native size (so not at whole multiples) or a one-colour set drawn as an `<img>` (which cannot take the
 * text colour) or as inlined markup; an icon that does not load drawn as a broken picture instead of the agent's own
 * mark; a search by name or number that finds the wrong icons; the pointer read before the person opens Sets; "Get"
 * not filling the grid in; the window's built-in looks drifting from the sets' manifests.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAgent, InboxAgentFacesWire, InboxParticipant } from '@plannotator/core/inbox-types';
import { createInboxAgentFacesFile } from '../../shared/inbox/agent-faces';
import { createInboxAgentFaces } from '../../server/inbox-agent-faces';
import { createBuiltInIconSets, createInboxIconSets } from '../../server/inbox-icon-sets';
import { createIconSetFetcher } from '../../server/inbox-icon-set-fetch';
import { serveFakeIconSet, type FakeIconSet } from '../../../tests/helpers/fake-icon-set';

const hasDom = typeof document !== 'undefined';
if (hasDom) {
  (window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL('http://127.0.0.1:4000/');
  const query = (media: string) => ({ media, matches: false, addEventListener: () => {}, removeEventListener: () => {} });
  (window as unknown as { matchMedia: unknown }).matchMedia = query;
  (globalThis as unknown as { matchMedia: unknown }).matchMedia = query;
}

const { AgentMark } = (hasDom ? await import('./AgentMark') : {}) as typeof import('./AgentMark');
const icons = (hasDom ? await import('../icons') : {}) as typeof import('../icons');
const { RowAgents } = (hasDom ? await import('../components/RowAgents') : {}) as typeof import('../components/RowAgents');
const { ReplyRecipient } = (hasDom ? await import('../components/ReplyRecipient') : {}) as typeof import('../components/ReplyRecipient');
const { TagStack } = (hasDom ? await import('../components/TagPicker') : {}) as typeof import('../components/TagPicker');
const faces = (hasDom ? await import('./agentFaces') : {}) as typeof import('./agentFaces');
const sets = (hasDom ? await import('./iconSets') : {}) as typeof import('./iconSets');
const panel = (hasDom ? await import('./SetsBody') : {}) as typeof import('./SetsBody');
const art = (hasDom ? await import('./faceArtLoad') : {}) as typeof import('./faceArtLoad');
const motion = (hasDom ? await import('./motion') : {}) as typeof import('./motion');
const { setInboxAgents } = (hasDom ? await import('../agentsList') : {}) as typeof import('../agentsList');

const SOURCES = Object.fromEntries((motion.AGENT_FACES ?? []).filter((f) => f !== 'agent').map((f) => [f, `${f}.svg`])) as never;
const ART = Object.fromEntries((motion.AGENT_FACES ?? []).filter((f) => f !== 'agent').map((f) => [f, `<i data-art="${f}"></i>`])) as never;

let root: Root | null = null;
let realFetch: typeof fetch;
let events: InboxAgentFacesWire[] = [];
let asked: string[] = [];
let served: FakeIconSet | null = null;

/** The Inbox's routes on a temp folder, behind a fetch stand-in (the fetcher itself reaches the fake set for real). */
function inbox(pointer: string | null = null) {
  const dir = join(mkdtempSync(join(tmpdir(), 'pn-set-icons-dom-')), 'inbox');
  const file = createInboxAgentFacesFile(dir, (wire) => events.push(wire));
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const readBody = async (req: Request) => (await req.json()) as Record<string, unknown>;
  const facesRoute = createInboxAgentFaces({ file, serverSession: 'srv', readBody, json }).route;
  const builtIn = createBuiltInIconSets();
  // Bun's own fetch, as the server's (happy-dom's would apply a page's CORS rules, and its AbortSignal is not Bun's).
  const serverFetch = ((url: URL, init: RequestInit) => Bun.fetch(url, { ...init, signal: undefined })) as unknown as typeof fetch;
  const fetcher = createIconSetFetcher({ dir: join(dir, 'icon-sets'), pointer, builtIn: builtIn.ids, fetch: serverFetch });
  const setsRoute = createInboxIconSets({ builtIn, fetcher, serverSession: 'srv', localOnly: () => json({ code: 'local_only' }, 403), readBody, json }).route;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    asked.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`);
    const req = new Request(url, { method: init?.method ?? 'GET', ...(init?.body ? { body: init.body } : {}) });
    return (await facesRoute(req, url)) ?? (await setsRoute(req, url, true)) ?? json({ error: 'not here' }, 404);
  }) as typeof fetch;
  return { file, fetcher };
}

const settle = async () => {
  for (let i = 0; i < 8; i++) await act(async () => await new Promise((done) => setTimeout(done, 0)));
};

beforeEach(() => {
  if (!hasDom) return;
  realFetch = globalThis.fetch;
  events = [];
  asked = [];
  window.localStorage.clear();
  setInboxAgents(null);
  sets.resetIconSets();
  faces.resetAgentFaces();
  art.setAgentFaceSourcesForTests(SOURCES);
  motion.setAgentFaceArt(ART);
});

afterEach(async () => {
  if (!hasDom) return;
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  globalThis.fetch = realFetch;
  await served?.stop();
  served = null;
});

function mount(node: React.ReactNode) {
  const host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(node));
  return host;
}

const agent = (over: Partial<InboxAgent> = {}): InboxAgent => ({ id: 'ses_a', session: 'ses_a', host: 'claude-code', project: null, state: 'idle', waiting: 0, live: true, started_at: null, last_seen_at: null, ...over });
const author = (session: string, host = 'claude-code') => ({ kind: 'agent' as const, host, session, name: null });
const recipient = (session: string) => ({ session, host: 'claude-code', label: 'Invoice retries', short: 'Invoice retries', state: 'live' as const });
const at = (host: Element, s: string) => host.querySelector(`[data-s="${s}"]`)!;

function Surfaces() {
  const participants = [{ session: 'ses_a', host: 'claude-code' } as InboxParticipant, { session: 'ses_p', host: 'pi' } as InboxParticipant];
  return (
    <>
      <div data-s="sidebar">
        <AgentMark id="ses_a" host="claude-code" name="Invoice retries" agent={agent()} />
      </div>
      <div data-s="row">
        <RowAgents participants={undefined} agent={author('ses_a')} tip={false} />
      </div>
      <div data-s="author">
        <icons.AuthorMark author={author('ses_a')} big />
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
const OUTSIDE = ['row', 'author', 'header', 'recipient'];

/** What a place draws for agent ses_a: a set icon (its address and how it is drawn), or the agent's own mark. */
function drawn(el: Element): string {
  const box = el.querySelector<HTMLElement>('.ib-set, .am-face:not([hidden]) .am-setart');
  if (!box) return el.querySelector('[data-agent-face]') ? 'another face' : 'own mark';
  const img = box.querySelector('img');
  const mono = box.dataset.mono !== undefined;
  return `${img?.getAttribute('src') ?? '?'} ${mono ? `mono ${box.style.getPropertyValue('--set-src')}` : `px ${box.style.getPropertyValue('--set-px') || 'none'}`}`;
}

async function openSets(host: Element) {
  const mark = host.querySelector<HTMLButtonElement>('[data-agent-icon="ses_a"]')!;
  act(() => mark.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  await settle();
  const place = document.querySelector<HTMLButtonElement>('[data-face-choice="sets"]');
  expect(place?.getAttribute('aria-label')).toBe('Sets');
  act(() => place!.click());
  await settle();
  const opened = document.querySelector<HTMLElement>('dialog[data-dialog="agent-icon"][open]');
  expect(opened).not.toBeNull();
  return opened!;
}
const tab = (id: string) => document.querySelector<HTMLButtonElement>(`.am-sets-tab[data-set="${id}"]`)!;
const cells = () => [...document.querySelectorAll<HTMLButtonElement>('.am-sets-i')];
const page = () => document.querySelector<HTMLElement>('[data-selected-icon]');
const useIt = async () => {
  act(() => document.querySelector<HTMLButtonElement>('[data-use-icon]')!.click());
  await settle();
};
const type = async (value: string) => {
  const input = document.querySelector<HTMLInputElement>('.am-sets-q')!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
};

test.if(hasDom)('"Sets" opens the sets; an icon picked there is previewed, and "Use this icon" shows it on the agent everywhere at once, pixel art at its native size', async () => {
  inbox();
  setInboxAgents([{ agents: [agent()], total: 1, ended_today: 0 }]);
  const host = mount(<Surfaces />);
  // Nothing asked of the sets until Sets opens.
  expect(asked.filter((a) => a.includes('icon-sets'))).toEqual([]);
  await openSets(host);
  expect(asked).toContain('GET /api/inbox/icon-sets?remote=1');
  expect([...document.querySelectorAll('.am-sets-tab')].map((t) => t.textContent)).toEqual(['Noto Emoji 3D', 'Dungeon Crawl', 'game-icons.net', 'Tiny Creatures']);
  expect(tab('noto-3d').getAttribute('aria-selected')).toBe('true');
  act(() => tab('tiny-creatures').click());
  await settle();
  expect(cells()).toHaveLength(170);
  expect(cells()[0]!.querySelector('.am-sets-n')!.textContent).toBe('#001');
  expect(cells()[0]!.getAttribute('aria-label')).toBe('Zombie, #001');
  act(() => cells()[0]!.click());
  await settle();
  // Its page, previewed: nothing kept, nothing told to other windows, the agent still its own mark everywhere.
  expect(page()!.dataset.selectedIcon).toBe('set:tiny-creatures/zombie');
  expect(page()!.hasAttribute('data-previewing')).toBe(true);
  expect(faces.agentFaceOf('ses_a')).toBe('agent');
  expect(events).toEqual([]);
  for (const s of OUTSIDE) expect(drawn(at(host, s))).toBe('own mark');
  await useIt();
  expect(faces.agentFaceOf('ses_a')).toBe('set:tiny-creatures/zombie');
  expect(document.querySelector('dialog[data-dialog="agent-icon"][open]')).toBeNull();
  // Every window heard it.
  expect(events.at(-1)!.faces.ses_a!.face).toBe('set:tiny-creatures/zombie');
  for (const s of ['sidebar', ...OUTSIDE]) expect({ s, drawn: drawn(at(host, s)) }).toEqual({ s, drawn: '/api/inbox/icon-sets/tiny-creatures/zombie px 16px' });
  for (const s of ['sidebar', ...OUTSIDE]) expect(at(host, s).querySelector<HTMLElement>('.ib-set, .am-setart')!.dataset.pixel).toBe('');
});

test.if(hasDom)('Sets opens on the set last looked at, kept by the browser across reloads; a set no longer listed falls back to the first', async () => {
  inbox();
  // Kept by an earlier page.
  window.localStorage.setItem(panel.LAST_SET_KEY, 'dcss');
  const host = mount(<Surfaces />);
  let dialog = await openSets(host);
  expect(tab('dcss').getAttribute('aria-selected')).toBe('true');
  // Looking at a set, and choosing one of its icons, keep it for the next page.
  act(() => tab('game-icons').click());
  await settle();
  expect(window.localStorage.getItem(panel.LAST_SET_KEY)).toBe('game-icons');
  act(() => tab('tiny-creatures').click());
  await settle();
  window.localStorage.removeItem(panel.LAST_SET_KEY);
  act(() => cells()[0]!.click());
  await settle();
  expect(window.localStorage.getItem(panel.LAST_SET_KEY)).toBe('tiny-creatures');
  await useIt();
  window.localStorage.setItem(panel.LAST_SET_KEY, 'gone');
  dialog = await openSets(host);
  // The agent's own set icon still opens its set (its page first, then back to the grid).
  act(() => dialog.querySelector<HTMLButtonElement>('.ib-agi-back')!.click());
  await settle();
  expect(tab('tiny-creatures').getAttribute('aria-selected')).toBe('true');
  act(() => dialog.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.click());
  await settle();
  act(() => faces.keepAgentFace('ses_a', 'agent'));
  await settle();
  await openSets(host);
  expect(tab('noto-3d').getAttribute('aria-selected')).toBe('true');
});

test.if(hasDom)('a one-colour icon is a mask in the text colour everywhere, never an <img> you see and never markup', async () => {
  inbox();
  const host = mount(<Surfaces />);
  act(() => faces.keepAgentFace('ses_a', 'set:game-icons/wyvern'));
  await settle();
  for (const s of ['sidebar', ...OUTSIDE]) {
    expect({ s, drawn: drawn(at(host, s)) }).toEqual({ s, drawn: '/api/inbox/icon-sets/game-icons/wyvern mono url("/api/inbox/icon-sets/game-icons/wyvern")' });
    const box = at(host, s).querySelector('.ib-set, .am-face:not([hidden]) .am-setart')!;
    // Only the mask's span and the hidden image that says whether it loads: no inlined svg, nothing else.
    expect({ s, tags: [...box.querySelectorAll('*')].map((el) => `${el.tagName}${(el as HTMLElement).hidden ? ' hidden' : ''}`) }).toEqual({ s, tags: ['SPAN', 'IMG hidden'] });
  }
  // A face that is not a set icon's id never reaches an icon.
  act(() => faces.hearAgentFacesEvent({ faces: { ses_a: { face: 'set:game-icons/x")};body{background:url(//evil', sessions: [] } }, rev: 999 }));
  expect(faces.agentFaceOf('ses_a')).toBe('agent');
});

test.if(hasDom)('an icon that does not load (a set this machine lacks, a dropped icon) is the agent’s own mark, never a broken picture', async () => {
  inbox();
  const host = mount(<Surfaces />);
  for (const face of ['set:dcss/orc', 'set:game-icons/wyvern'] as const) {
    act(() => faces.keepAgentFace('ses_a', face));
    await settle();
    for (const s of OUTSIDE) expect(drawn(at(host, s))).toContain(face.slice(4));
    for (const img of document.querySelectorAll('img')) if ((img.getAttribute('src') ?? '').includes(face.slice(4))) act(() => img.dispatchEvent(new Event('error')));
    await settle();
    for (const s of ['sidebar', ...OUTSIDE]) expect({ face, s, drawn: drawn(at(host, s)) }).toEqual({ face, s, drawn: 'own mark' });
    act(() => faces.keepAgentFace('ses_a', 'agent'));
    await act(async () => await new Promise((done) => setTimeout(done, 400)));
  }
  // The server answers 404 for a set it does not have (and the window then draws the own mark, as above).
  expect((await fetch('/api/inbox/icon-sets/blobs/3')).status).toBe(404);
});

test.if(hasDom)('search by name or number, and the keys stay inside the panel', async () => {
  inbox();
  const host = mount(<Surfaces />);
  await openSets(host);
  act(() => tab('dcss').click());
  await settle();
  expect(cells()).toHaveLength(419);
  for (const q of ['27', '#027', '027']) {
    await type(q);
    expect({ q, found: cells().map((c) => c.querySelector('.am-sets-n')!.textContent) }).toEqual({ q, found: ['#027'] });
  }
  await type('orc');
  const names = cells().map((c) => c.getAttribute('aria-label')!);
  expect(names.length).toBeGreaterThan(3);
  for (const name of names) expect(name.toLowerCase()).toContain('orc');
  expect(document.querySelector('.am-sets-head')!.textContent).toContain(`${names.length} found`);
  // Enter in the search picks the first found.
  const input = document.querySelector<HTMLInputElement>('.am-sets-q')!;
  act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  await settle();
  expect(page()!.dataset.selectedIcon).toMatch(/^set:dcss\/.*orc/);
  // The search's own function: a number is that icon only; words match names and search words.
  const list = [
    { id: 'a', n: 1, name: 'Mossy' },
    { id: 'b', n: 27, name: 'Mote', words: ['slime'] },
    { id: 'c', n: 270, name: 'Pip' },
  ];
  expect(panel.searchSetIcons(list, '27').map((i) => i.id)).toEqual(['b']);
  expect(panel.searchSetIcons(list, 'mo').map((i) => i.id)).toEqual(['a', 'b']);
  expect(panel.searchSetIcons(list, 'sli').map((i) => i.id)).toEqual(['b']);
  expect(panel.setNumber(25, 1025)).toBe('#0025');
});

test.if(hasDom)('the window’s built-in looks are the sets’ own', async () => {
  // Only a set drawn some other way than a plain picture needs a look known up front (pixel art, one colour).
  const listed = (await createBuiltInIconSets().list()).filter((s) => s.pixelated || s.mono);
  expect(Object.fromEntries(listed.map((s) => [s.id, { pixelated: s.pixelated, size: s.size, mono: s.mono }]))).toEqual(
    Object.fromEntries(Object.entries(sets.BUILT_IN_SET_LOOKS).map(([id, look]) => [id, { pixelated: look.pixelated, size: look.size, mono: look.mono }])),
  );
});

test.if(hasDom)('game-icons.net shows its credit line under its grid; the others show none', async () => {
  inbox();
  const host = mount(<Surfaces />);
  await openSets(host);
  expect(document.querySelector('.am-sets-credit')).toBeNull();
  act(() => tab('game-icons').click());
  await settle();
  const credit = document.querySelector('.am-sets-credit')!;
  expect(credit.textContent).toBe('Icons by game-icons.net authors · CC BY 3.0 · Credits');
  expect(credit.querySelector('a')!.getAttribute('href')).toBe('/api/inbox/icon-sets/game-icons?credits=1');
  act(() => tab('dcss').click());
  await settle();
  expect(document.querySelector('.am-sets-credit')).toBeNull();
});

test.if(hasDom)('a fetchable set: "Get" downloads it in one click and its grid fills in; then it is a set like the others', async () => {
  served = await serveFakeIconSet({ count: 12 });
  const { fetcher } = inbox(served.pointer);
  const host = mount(<Surfaces />);
  await openSets(host);
  act(() => tab('blobs').click());
  await settle();
  expect(document.querySelector('.am-sets-get')!.textContent).toBe('Get12 icons');
  expect(cells()).toHaveLength(0);
  await act(async () => document.querySelector<HTMLButtonElement>('[data-get="blobs"]')!.click());
  await settle();
  await act(async () => await fetcher.running('blobs'));
  await act(async () => await new Promise((done) => setTimeout(done, 700)));
  await settle();
  expect(document.querySelector('.am-sets-get')).toBeNull();
  expect(cells().map((c) => c.disabled)).toEqual(new Array(12).fill(false));
  expect(cells()[1]!.getAttribute('aria-label')).toBe('Mote, #002');
  act(() => cells()[1]!.click());
  await settle();
  await useIt();
  expect(faces.agentFaceOf('ses_a')).toBe('set:blobs/2');
  for (const s of OUTSIDE) expect(drawn(at(host, s))).toBe('/api/inbox/icon-sets/blobs/2 px 16px');
});

// The owner, 2026-11-12: a click opens the picker; it no longer drops a set icon for Transparent.
test.if(hasDom)('a click on a mark showing a set icon opens the picker and keeps the set icon; the picker\'s Sets shows it and opens on its page, the grid behind it with it marked', async () => {
  inbox();
  const host = mount(<Surfaces />);
  act(() => faces.keepAgentFace('ses_a', 'set:dcss/orc'));
  await settle();
  const face = host.querySelector<HTMLButtonElement>('[data-agent-icon="ses_a"]')!;
  act(() => void face.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 })));
  await settle();
  expect(face.getAttribute('aria-expanded')).toBe('true');
  expect(faces.agentFaceOf('ses_a')).toBe('set:dcss/orc');
  const place = document.querySelector<HTMLButtonElement>('[data-face-choice="sets"]')!;
  expect(place.getAttribute('aria-checked')).toBe('true');
  expect(place.querySelector('.am-sets-art img')!.getAttribute('src')).toBe('/api/inbox/icon-sets/dcss/orc');
  act(() => place.click());
  await settle();
  const dialog = document.querySelector<HTMLElement>('dialog[data-dialog="agent-icon"][open]')!;
  // The page of the icon in use: nothing to use, "Animate it" under "Optional".
  expect(page()!.dataset.selectedIcon).toBe('set:dcss/orc');
  expect(page()!.hasAttribute('data-previewing')).toBe(false);
  expect(dialog.querySelector('[data-use-icon]')).toBeNull();
  expect(dialog.querySelector('.ib-agi-sel-opt')!.textContent).toBe('Optional');
  act(() => dialog.querySelector<HTMLButtonElement>('.ib-agi-back')!.click());
  await settle();
  expect([...dialog.querySelectorAll('.am-sets-i[aria-checked="true"]')].map((cell) => cell.getAttribute('data-set-icon'))).toEqual(['orc']);
  expect(faces.agentFaceOf('ses_a')).toBe('set:dcss/orc');
});

test.if(hasDom)('a previewed icon: the back control and Close keep the icon the agent had; "Use this icon" keeps the pick', async () => {
  inbox();
  const host = mount(<Surfaces />);
  act(() => faces.keepAgentFace('ses_a', 'set:dcss/orc'));
  await settle();
  const sent = events.length;
  let dialog = await openSets(host);
  act(() => dialog.querySelector<HTMLButtonElement>('.ib-agi-back')!.click());
  await settle();
  act(() => tab('noto-3d').click());
  await settle();
  act(() => cells()[0]!.click());
  await settle();
  const picked = page()!.dataset.selectedIcon!;
  expect(picked).toMatch(/^set:noto-3d\//);
  // Its page shows the pick large and at the window's sizes; the head still shows the icon in use.
  expect(page()!.querySelector('.ib-agi-sel-big .ib-set img')!.getAttribute('src')).toBe(`/api/inbox/icon-sets/${picked.slice(4)}`);
  expect(dialog.querySelector('.ib-agi-mark .ib-set img')!.getAttribute('src')).toBe('/api/inbox/icon-sets/dcss/orc');
  expect(dialog.querySelector('[data-use-icon]')!.textContent).toBe('Use this icon');
  expect(dialog.querySelector('.ib-agi-sel-opt')!.textContent).toBe('Optional');
  // Back: the grid again, nothing kept.
  act(() => dialog.querySelector<HTMLButtonElement>('.ib-agi-back')!.click());
  await settle();
  expect(page()).toBeNull();
  expect(faces.agentFaceOf('ses_a')).toBe('set:dcss/orc');
  // Close from a preview: nothing kept.
  act(() => cells()[0]!.click());
  await settle();
  act(() => dialog.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.click());
  await settle();
  expect(faces.agentFaceOf('ses_a')).toBe('set:dcss/orc');
  expect(events.length).toBe(sent);
  // "Use this icon": kept, closed.
  dialog = await openSets(host);
  act(() => dialog.querySelector<HTMLButtonElement>('.ib-agi-back')!.click());
  await settle();
  act(() => tab('noto-3d').click());
  await settle();
  act(() => cells()[0]!.click());
  await settle();
  await useIt();
  expect(faces.agentFaceOf('ses_a')).toBe(picked);
  expect(document.querySelector('dialog[data-dialog="agent-icon"][open]')).toBeNull();
  for (const s of OUTSIDE) expect(drawn(at(host, s))).toContain(picked.slice(4));
});

test.if(hasDom)('the dialog: a modal naming the agent with its icon now; Escape and a click outside close it; focus goes back to the face', async () => {
  inbox();
  const host = mount(<Surfaces />);
  act(() => faces.keepAgentFace('ses_a', 'set:dcss/orc'));
  await settle();
  const face = host.querySelector<HTMLButtonElement>('[data-agent-icon="ses_a"]')!;
  for (const close of ['Escape', 'outside', 'Close'] as const) {
    const dialog = await openSets(host);
    // The Inbox's own dialog, modal; its head names the agent and shows the icon it has now.
    expect(dialog.tagName).toBe('DIALOG');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.querySelector('h2')!.textContent).toBe('Invoice retries');
    expect(dialog.querySelector('.ib-agi-mark .ib-set img')!.getAttribute('src')).toBe('/api/inbox/icon-sets/dcss/orc');
    expect(dialog.querySelector('[data-agi-place="sets"]')!.getAttribute('aria-selected')).toBe('true');
    if (close === 'Escape') act(() => dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    else if (close === 'outside') act(() => dialog.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    else act(() => dialog.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.click());
    await settle();
    expect({ close, open: document.querySelector('dialog[data-dialog="agent-icon"]') }).toEqual({ close, open: null });
    expect({ close, focus: document.activeElement === face }).toEqual({ close, focus: true });
    // Nothing chosen: the face is as it was.
    expect(faces.agentFaceOf('ses_a')).toBe('set:dcss/orc');
  }
  // The switch in its head moves to "Your own…", with its drop area.
  const dialog = await openSets(host);
  act(() => dialog.querySelector<HTMLButtonElement>('[data-agi-place="own"]')!.click());
  await settle();
  expect(dialog.querySelector('.ib-agi-drop')!.textContent).toBe('Drop or paste an imageUpload…');
  expect(dialog.querySelector('.am-sets-g')).toBeNull();
});
