/**
 * "Your own…": a picture the person uploads for an agent's icon (agents/ownIcons.ts, OwnIconsBody.tsx, AgentIconDialog.tsx, icons.tsx
 * `HostMark`, motion.ts), through the Inbox's real routes (packages/server/inbox-agent-icons.ts and
 * inbox-agent-faces.ts) on a temp folder, called through a fetch stand-in: no Inbox is started.
 *
 * What this catches: the fan without its "Your own…" place, or that place not opening the pictures; a pasted or
 * picked picture not kept, or not shown on the agent at once; a picture not shown on the row, the author, the header
 * or the reply pill; a picture that moves outside the sidebar (anything but its still there), or in the sidebar under
 * reduced motion; a picture drawn as markup (innerHTML) instead of an image's address; a removed picture, one from
 * another machine, or one that fails to load drawn as a broken picture instead of the agent's own mark; a removal
 * that asks a question; another agent reusing a picture that is uploaded again.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAgent, InboxAgentFacesWire, InboxParticipant } from '@plannotator/core/inbox-types';
import { createInboxAgentFacesFile } from '../../shared/inbox/agent-faces';
import { createInboxAgentFaces } from '../../server/inbox-agent-faces';
import { createAgentIcons, createInboxAgentIcons } from '../../server/inbox-agent-icons';

const hasDom = typeof document !== 'undefined';
let reduced = false;
const changeListeners = new Set<() => void>();
if (hasDom) {
  // A page with an address, as the window has: happy-dom then loads no picture (and fails none by itself), so a
  // picture that fails is one a test fails on purpose.
  (window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL('http://127.0.0.1:4000/');
  const query = (media: string) => ({
    media,
    get matches() {
      return media.includes('reduce') ? reduced : false;
    },
    addEventListener: (_: string, listener: () => void) => changeListeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => changeListeners.delete(listener),
  });
  (window as unknown as { matchMedia: unknown }).matchMedia = query;
  (globalThis as unknown as { matchMedia: unknown }).matchMedia = query;
}

const { AgentMark } = (hasDom ? await import('./AgentMark') : {}) as typeof import('./AgentMark');
const icons = (hasDom ? await import('../icons') : {}) as typeof import('../icons');
const { RowAgents } = (hasDom ? await import('../components/RowAgents') : {}) as typeof import('../components/RowAgents');
const { ReplyRecipient } = (hasDom ? await import('../components/ReplyRecipient') : {}) as typeof import('../components/ReplyRecipient');
const { TagStack } = (hasDom ? await import('../components/TagPicker') : {}) as typeof import('../components/TagPicker');
const faces = (hasDom ? await import('./agentFaces') : {}) as typeof import('./agentFaces');
const own = (hasDom ? await import('./ownIcons') : {}) as typeof import('./ownIcons');
const art = (hasDom ? await import('./faceArtLoad') : {}) as typeof import('./faceArtLoad');
const motion = (hasDom ? await import('./motion') : {}) as typeof import('./motion');
const { setInboxAgents } = (hasDom ? await import('../agentsList') : {}) as typeof import('../agentsList');

const PNG = new Uint8Array(readFileSync(join(import.meta.dir, '../../server/fixtures/agent-icons/still.png')));
const GIF = new Uint8Array(readFileSync(join(import.meta.dir, '../../server/fixtures/agent-icons/anim.gif')));
const sha = (bytes: Uint8Array) => new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
const SOURCES = Object.fromEntries((motion.AGENT_FACES ?? []).filter((f) => f !== 'agent').map((f) => [f, `${f}.svg`])) as never;
const ART = Object.fromEntries((motion.AGENT_FACES ?? []).filter((f) => f !== 'agent').map((f) => [f, `<i data-art="${f}"></i>`])) as never;

let root: Root | null = null;
let realFetch: typeof fetch;
let events: InboxAgentFacesWire[] = [];
let asked: string[] = [];

/** The Inbox's two routes on a temp folder, behind a fetch stand-in. */
function inbox() {
  const dir = join(mkdtempSync(join(tmpdir(), 'pn-own-icons-dom-')), 'inbox');
  const store = createAgentIcons({ dir: join(dir, 'agent-icons') });
  const file = createInboxAgentFacesFile(dir, (wire) => events.push({ ...wire, icons: store.list() }));
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const readBody = async (req: Request) => (await req.json()) as Record<string, unknown>;
  const facesRoute = createInboxAgentFaces({ file, serverSession: 'srv', readBody, json, icons: () => store.list() }).route;
  const iconsRoute = createInboxAgentIcons({ icons: store, faces: file, serverSession: 'srv', localOnly: () => json({ code: 'local_only' }, 403), readBody, json }).route;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    asked.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`);
    const req = new Request(url, { method: init?.method ?? 'GET', ...(init?.body ? { body: init.body } : {}) });
    try {
      return (await facesRoute(req, url)) ?? (await iconsRoute(req, url, true)) ?? json({ error: 'not here' }, 404);
    } catch (cause) {
      // The Inbox's own answer to a refusal (its error handler): the words and the code.
      const error = cause as { message: string; code: string };
      return json({ error: error.message, code: error.code }, 422);
    }
  }) as typeof fetch;
  return { file, store };
}

const settle = async () => {
  for (let i = 0; i < 8; i++) await act(async () => await new Promise((done) => setTimeout(done, 0)));
};

beforeEach(() => {
  if (!hasDom) return;
  realFetch = globalThis.fetch;
  events = [];
  asked = [];
  reduced = false;
  window.localStorage.clear();
  setInboxAgents(null);
  own.resetOwnIcons();
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
      <div data-s="other">
        <icons.AuthorMark author={author('ses_b')} big />
      </div>
    </>
  );
}

/** Each place's uploaded picture: its `src`, or what it shows instead. */
const shown = (el: Element) => el.querySelector<HTMLImageElement>('.ib-own > img, .am-face:not([hidden]) img[data-own]')?.getAttribute('src') ?? (el.querySelector('[data-agent-face]') ? 'another face' : 'own mark');
const OUTSIDE = ['row', 'author', 'header', 'recipient'];

/** The fan opened by a key on the sidebar mark, then "Your own…". */
async function openOwn(host: Element) {
  const mark = host.querySelector<HTMLButtonElement>('[data-agent-icon="ses_a"]')!;
  act(() => mark.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  await settle();
  const place = document.querySelector<HTMLButtonElement>('[data-face-choice="own"]');
  expect(place?.getAttribute('aria-label')).toBe('Your own…');
  act(() => place!.click());
  await settle();
  const panel = document.querySelector<HTMLElement>('dialog[data-dialog="agent-icon"][open]');
  expect(panel).not.toBeNull();
  return panel!;
}

function paste(file: File) {
  const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
  Object.defineProperty(event, 'clipboardData', { value: { files: [file] } });
  document.dispatchEvent(event);
}

test.if(hasDom)('a pasted picture is kept and shows on the agent everywhere at once: moving in the sidebar, its still everywhere else', async () => {
  inbox();
  setInboxAgents([{ agents: [agent()], total: 1, ended_today: 0 }]);
  const host = mount(<Surfaces />);
  const panel = await openOwn(host);
  expect(panel.textContent).toContain('Your own…');
  await act(async () => paste(new File([GIF], 'cat.gif', { type: 'image/gif' })));
  await settle();
  const id = sha(GIF);
  expect(asked).toContain('POST /api/inbox/agent-icons');
  expect(faces.agentFaceOf('ses_a')).toBe(`own:${id}`);
  // The sidebar plays it; every other place asks for the still.
  expect(shown(at(host, 'sidebar'))).toBe(`/api/inbox/agent-icons/${id}`);
  for (const s of OUTSIDE) expect({ s, src: shown(at(host, s)) }).toEqual({ s, src: `/api/inbox/agent-icons/${id}?still=1` });
  expect(shown(at(host, 'other'))).toBe('own mark');
  // The panel closed and every window heard it (the wire names the picture).
  expect(document.querySelector('dialog[data-dialog="agent-icon"][open]')).toBeNull();
  expect(events.at(-1)!.icons!.map((icon) => icon.id)).toEqual([id]);
  expect(events.at(-1)!.faces.ses_a!.face).toBe(`own:${id}`);
});

test.if(hasDom)('a picture is only ever an image of its address, set as an attribute: never markup', async () => {
  const { store } = inbox();
  const added = store.add(PNG);
  if (!added.ok) throw new Error(added.reason);
  const host = mount(<Surfaces />);
  act(() => faces.keepAgentFace('ses_a', `own:${added.icon.id}`));
  await settle();
  const sidebarImg = at(host, 'sidebar').querySelector('img[data-own]')!;
  expect(sidebarImg.tagName).toBe('IMG');
  // Nothing but the image under its layer: no inlined svg, no element the picture's bytes could have made.
  for (const s of ['sidebar', ...OUTSIDE]) {
    const box = s === 'sidebar' ? at(host, s).querySelector('.am-ownart')! : at(host, s).querySelector('.ib-own')!;
    expect({ s, tags: [...new Set([...box.querySelectorAll('*')].map((el) => el.tagName))] }).toEqual({ s, tags: ['IMG'] });
  }
  // A face that is not a picture's id never reaches an icon (a hostile file or wire is dropped).
  act(() => faces.hearAgentFacesEvent({ faces: { ses_a: { face: 'own:"><img src=x onerror=alert(1)>', sessions: [] } }, rev: 999 }));
  expect(faces.agentFaceOf('ses_a')).toBe('agent');
});

test.if(hasDom)('reduced motion: the sidebar shows the still too, and goes back to the moving picture when it is turned off', async () => {
  const { store } = inbox();
  const added = store.add(GIF);
  if (!added.ok) throw new Error(added.reason);
  reduced = true;
  const host = mount(<Surfaces />);
  act(() => faces.keepAgentFace('ses_a', `own:${added.icon.id}`));
  await settle();
  expect(shown(at(host, 'sidebar'))).toBe(`/api/inbox/agent-icons/${added.icon.id}?still=1`);
  reduced = false;
  act(() => {
    for (const listener of [...changeListeners]) listener();
  });
  expect(shown(at(host, 'sidebar'))).toBe(`/api/inbox/agent-icons/${added.icon.id}`);
  for (const s of OUTSIDE) expect(shown(at(host, s))).toBe(`/api/inbox/agent-icons/${added.icon.id}?still=1`);
});

test.if(hasDom)('a picture this Inbox does not keep (removed, or chosen on another machine) is the agent’s own mark, never a broken picture', async () => {
  const { store, file } = inbox();
  const added = store.add(PNG);
  if (!added.ok) throw new Error(added.reason);
  const host = mount(<Surfaces />);
  // A face for a picture this Inbox never had (the file copied from another machine).
  file.change({ agent: 'ses_a', face: `own:${'f'.repeat(64)}` });
  await act(async () => await faces.readAgentFaces());
  for (const s of ['sidebar', ...OUTSIDE]) expect({ s, shown: shown(at(host, s)) }).toEqual({ s, shown: 'own mark' });
  expect(at(host, 'sidebar').querySelector('[data-agent-mark]')!.getAttribute('data-face')).toBe('agent');

  // One it has: shown; then a picture that fails to load (deleted from the folder by hand): the own mark again.
  act(() => faces.keepAgentFace('ses_a', `own:${added.icon.id}`));
  await settle();
  for (const s of OUTSIDE) expect(shown(at(host, s))).toContain(added.icon.id);
  for (const img of host.querySelectorAll('img')) if ((img.getAttribute('src') ?? '').includes(added.icon.id)) act(() => img.dispatchEvent(new Event('error')));
  for (const s of ['sidebar', ...OUTSIDE]) expect({ s, shown: shown(at(host, s)) }).toEqual({ s, shown: 'own mark' });
});

test.if(hasDom)('× takes a picture away with no question: the agents showing it go back to their own mark; another agent reuses one', async () => {
  const { store } = inbox();
  const added = store.add(PNG);
  if (!added.ok) throw new Error(added.reason);
  await act(async () => await faces.readAgentFaces());
  const host = mount(
    <>
      <Surfaces />
      <div data-s="b">
        <AgentMark id="ses_b" host="pi" name="Docs" agent={agent({ id: 'ses_b', session: 'ses_b', host: 'pi' })} />
      </div>
    </>,
  );
  // Another agent picks the picture already kept: no new upload.
  const b = host.querySelector<HTMLButtonElement>('[data-agent-icon="ses_b"]')!;
  act(() => b.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  await settle();
  act(() => document.querySelector<HTMLButtonElement>('[data-face-choice="own"]')!.click());
  await settle();
  act(() => document.querySelector<HTMLButtonElement>(`[data-own-icon="${added.icon.id}"]`)!.click());
  await settle();
  expect(faces.agentFaceOf('ses_b')).toBe(`own:${added.icon.id}`);
  expect(asked.filter((a) => a === 'POST /api/inbox/agent-icons')).toEqual([]);
  act(() => faces.keepAgentFace('ses_a', `own:${added.icon.id}`));
  await settle();

  const panel = await openOwn(host);
  const confirm = globalThis.confirm;
  let questions = 0;
  globalThis.confirm = () => {
    questions++;
    return true;
  };
  try {
    await act(async () => panel.querySelector<HTMLButtonElement>(`[data-own-remove="${added.icon.id}"]`)!.click());
    await settle();
  } finally {
    globalThis.confirm = confirm;
  }
  expect(questions).toBe(0);
  expect(store.list()).toEqual([]);
  expect(faces.agentFaceOf('ses_a')).toBe('agent');
  expect(faces.agentFaceOf('ses_b')).toBe('agent');
  // The sidebar's swap back (a short fade) has ended.
  await act(async () => await new Promise((done) => setTimeout(done, 400)));
  for (const s of ['sidebar', ...OUTSIDE, 'b']) expect({ s, shown: shown(at(host, s)) }).toEqual({ s, shown: 'own mark' });
});

test.if(hasDom)('a refused picture says Set picture…’s words in the panel and changes nothing', async () => {
  inbox();
  const host = mount(<Surfaces />);
  const panel = await openOwn(host);
  await act(async () => paste(new File([new TextEncoder().encode('<html></html>')], 'page.png', { type: 'image/png' })));
  await settle();
  expect(panel.querySelector('[role="status"]')!.textContent).toBe('Picture: a PNG, JPEG, GIF, WebP or SVG image.');
  await act(async () => paste(new File([new Uint8Array(512 * 1024 + 1)], 'photo.jpg', { type: 'image/jpeg' })));
  await settle();
  expect(panel.querySelector('[role="status"]')!.textContent).toBe('Picture: at most 512 KB.');
  expect(faces.agentFaceOf('ses_a')).toBe('agent');
});
