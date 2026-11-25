/**
 * A project's picture from the icon dialog (components/ProjectRow.tsx, ProjectMarkPicker.tsx, agents/AgentIconDialog.tsx
 * `ProjectIconDialog`, agents/iconTarget.ts, agents/AnimateIt.tsx), through the Inbox's real routes (icon sets,
 * uploaded pictures, project pictures, icon requests) on temp folders behind a fetch stand-in: no Inbox is started.
 *
 * What this catches: the project mark opening the project instead of the picker; Use this icon keeping a face, another
 * icon's bytes, or a one-colour icon that vanishes on a dark sidebar; Set picture… opening a bare file picker; the
 * picker offering no way back to the letters once a picture is set; Animate it asking about another project, sending
 * the message itself, or not naming the request; a linked machine's project kept on this computer;
 * an older machine's refusal shown as a bare error.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { MachineView, ProjectFolder } from './api';
import { createInboxAgentFacesFile } from '../shared/inbox/agent-faces';
import { createAgentIcons, createInboxAgentIcons } from '../server/inbox-agent-icons';
import { createBuiltInIconSets, createInboxIconSets } from '../server/inbox-icon-sets';
import { createIconSetFetcher } from '../server/inbox-icon-set-fetch';
import { createInboxIconAnimate } from '../server/inbox-icon-animate';
import { createProjectPictures } from '../server/inbox-project-pictures';

const hasDom = typeof document !== 'undefined';
if (hasDom) {
  (window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL('http://127.0.0.1:4000/');
  const query = (media: string) => ({ media, matches: false, addEventListener: () => {}, removeEventListener: () => {} });
  (window as unknown as { matchMedia: unknown }).matchMedia = query;
  (globalThis as unknown as { matchMedia: unknown }).matchMedia = query;
}

const { ProjectRow } = (hasDom ? await import('./components/ProjectRow') : {}) as typeof import('./components/ProjectRow');
const { RowMarksScope } = (hasDom ? await import('./letterMarks') : {}) as typeof import('./letterMarks');
const { LIST_LOOK_OFF } = (hasDom ? await import('./listLook') : {}) as typeof import('./listLook');
const known = (hasDom ? await import('./projectPictures') : {}) as typeof import('./projectPictures');
const routes = (hasDom ? await import('./inboxUrl') : {}) as typeof import('./inboxUrl');
const own = (hasDom ? await import('./agents/ownIcons') : {}) as typeof import('./agents/ownIcons');
const sets = (hasDom ? await import('./agents/iconSets') : {}) as typeof import('./agents/iconSets');
const composer = (hasDom ? await import('./compose/openComposer') : {}) as typeof import('./compose/openComposer');

const SELF = 'ibx_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const MINI = 'ibx_01ARZ3NDEKTSV4RRFFQ69G5FAW';
const HERE = 'prj_01JZ00000000000000000000P1';
const THERE = 'prj_01JZ00000000000000000000P2';

let root: Root | null = null;
let realFetch: typeof fetch;
let asked: string[] = [];
let opened: { subject?: string; body: string; files?: readonly File[]; to?: unknown }[] = [];
const onOpen = (event: Event) => opened.push((event as CustomEvent).detail);

/**
 * This Inbox's routes, and a linked machine's behind `/api/inbox/m/<MINI>/`: each with its own project and pictures.
 * `older`: that machine's door has no picture route (it answers as an older Inbox's door does).
 */
function inboxes({ older = false } = {}) {
  const make = (project: string, name: string) => {
    const dir = join(mkdtempSync(join(tmpdir(), 'pn-project-icons-dom-')), 'inbox');
    const store = createAgentIcons({ dir: join(dir, 'agent-icons') });
    const file = createInboxAgentFacesFile(dir, () => {});
    const pictures = createProjectPictures({ dir: join(dir, 'project-pictures'), env: {} });
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    const readBody = async (req: Request) => (await req.json()) as Record<string, unknown>;
    const iconsRoute = createInboxAgentIcons({ icons: store, faces: file, serverSession: 'srv', readBody, json }).route;
    const builtIn = createBuiltInIconSets();
    const fetcher = createIconSetFetcher({ dir: join(dir, 'icon-sets'), pointer: null, builtIn: builtIn.ids });
    const setsRoute = createInboxIconSets({ builtIn, fetcher, serverSession: 'srv', readBody, json }).route;
    const folder = { id: project, name, root: `/work/${name}` };
    const animate = createInboxIconAnimate({
      inboxDir: dir,
      icons: store,
      faces: file,
      serverSession: 'srv',
      readBody,
      json,
      touch: () => {},
      setIconKept: async (set, icon) => !!(await builtIn.read(set, icon)),
      projects: { has: (id) => id === project, uploadedAt: (id) => pictures.uploadedAt(id), setUpload: (id, bytes) => pictures.setUpload(id, bytes), changed: () => {} },
    });
    // The project picture route as the Inbox answers it (packages/server/inbox.ts): Set picture's checks, the project back.
    const pictureRoute = async (req: Request, url: URL) => {
      if (url.pathname !== `/api/inbox/projects/${project}/picture` || req.method !== 'POST') return null;
      const body = await readBody(req);
      if (body.picture === null) pictures.removeUpload(project);
      else {
        const data = /^data:image\/[a-z0-9.+-]+;base64,(.+)$/i.exec(String(body.picture));
        const saved = data ? pictures.setUpload(project, new Uint8Array(Buffer.from(data[1]!, 'base64'))) : null;
        if (!saved?.ok) return json({ error: 'Picture: a PNG, JPEG, GIF, WebP or SVG image.', code: 'validation_error' }, 422);
      }
      const at = pictures.uploadedAt(project);
      return json({ project: { ...folder, ...(at !== undefined ? { picture: at } : {}) } });
    };
    const kept = async () => {
      const picture = await pictures.get({ id: project, root: '/nowhere' }, { logo: false, github: false, repo: () => null });
      return picture ? new TextDecoder().decode(picture.body) : null;
    };
    const handle = async (req: Request, url: URL) => (await iconsRoute(req, url)) ?? (await setsRoute(req, url)) ?? (await pictureRoute(req, url)) ?? (await animate.route(req, url)) ?? json({ error: 'not here' }, 404);
    return { builtIn, folder, kept, handle, store };
  };
  const here = make(HERE, 'billing');
  const there = make(THERE, 'infra');
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://127.0.0.1:4000');
    asked.push(`${init?.method ?? 'GET'} ${url.pathname}`);
    const far = url.pathname.startsWith(`/api/inbox/m/${MINI}/`);
    if (far && older) return new Response(JSON.stringify({ error: "This isn't available from another computer.", code: 'device_route_not_found' }), { status: 404, headers: { 'content-type': 'application/json' } });
    const local = new URL(routes.localRoute(url.pathname) + url.search, url);
    const req = new Request(local, { method: init?.method ?? 'GET', ...(init?.body ? { body: init.body } : {}) });
    try {
      return await (far ? there : here).handle(req, local);
    } catch (cause) {
      const error = cause as { message: string; code: string };
      return new Response(JSON.stringify({ error: error.message, code: error.code }), { status: 422, headers: { 'content-type': 'application/json' } });
    }
  }) as typeof fetch;
  return { here, there };
}

const settle = async () => {
  for (let i = 0; i < 10; i++) await act(async () => await new Promise((done) => setTimeout(done, 0)));
};

beforeEach(() => {
  if (!hasDom) return;
  realFetch = globalThis.fetch;
  asked = [];
  opened = [];
  window.localStorage.clear();
  window.addEventListener(composer.OPEN_COMPOSER_EVENT, onOpen);
  routes.resetMachineRoutes();
  routes.setSelfMachine(SELF, [{ id: MINI, name: 'Mac mini', self: false, state: 'online' } as MachineView]);
  routes.rememberMachine([THERE], MINI);
  known.resetKnownProjectsForTests();
  own.resetOwnIcons();
  sets.resetIconSets();
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  globalThis.fetch = realFetch;
  window.removeEventListener(composer.OPEN_COMPOSER_EVENT, onOpen);
});

let removed: string[] = [];
/** One project's sidebar row, with project marks on (Settings → Rows). */
function mount(project: { id: string; name: string; root: string }) {
  removed = [];
  known.learnProjects([project]);
  const host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.append(host);
  root = createRoot(host);
  const folder = { ...project, threads: 1, unread: 0, listed: 1, archived: 0 } as unknown as ProjectFolder;
  act(() =>
    root!.render(
      <RowMarksScope look={{ ...LIST_LOOK_OFF, marksProjects: true }}>
        <ProjectRow
          project={folder}
          count={0}
          on={false}
          held={false}
          readable={false}
          phone={false}
          onOpen={() => {}}
          onAction={() => {}}
          onPicture={async (file) => {
            removed.push(file === null ? 'removed' : 'file');
            return true;
          }}
        />
      </RowMarksScope>,
    ),
  );
  return host;
}

/** The picker opened by a key on the project's mark, then one of its places. */
async function pick(host: Element, projectId: string, place: string) {
  act(() => host.querySelector(`[data-project-icon="${projectId}"]`)!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  await settle();
  act(() => document.querySelector<HTMLButtonElement>(`[data-face-choice="${place}"]`)!.click());
  await settle();
  return document.querySelector<HTMLElement>('dialog[data-dialog="agent-icon"][open]');
}

/** In the dialog's Sets: one set's icon, then Use this icon. */
async function useSetIcon(dialog: HTMLElement, set: string, icon: string) {
  act(() => dialog.querySelector<HTMLButtonElement>(`.am-sets-tab[data-set="${set}"]`)!.click());
  await settle();
  act(() => dialog.querySelector<HTMLButtonElement>(`.am-sets-i[data-set-icon="${icon}"]`)!.click());
  await settle();
  act(() => dialog.querySelector<HTMLButtonElement>('[data-use-icon]')!.click());
  await settle();
}

test.if(hasDom)("the project's mark opens the picker; a set's icon becomes the project's picture as its own bytes, and the letters come back from the picker", async () => {
  const { here } = inboxes();
  const host = mount(here.folder);
  // No picture yet: the picker offers the two places, not the letters.
  const dialog = (await pick(host, HERE, 'sets'))!;
  expect(dialog).not.toBeNull();
  await useSetIcon(dialog, 'dcss', 'orc');
  expect(document.querySelector('dialog[data-dialog="agent-icon"]')).toBeNull();
  const orc = await here.builtIn.read('dcss', 'orc');
  const kept = await here.kept();
  expect(kept).toBe(new TextDecoder().decode(orc!.body));
  expect(known.hasSetPicture(HERE)).toBe(true);

  // A one-colour icon carries its own colour: an image cannot take the sidebar's text colour.
  const again = (await pick(host, HERE, 'sets'))!;
  await useSetIcon(again, 'game-icons', 'air-man');
  expect(await here.kept()).toContain('<style>svg{color:');

  // With a picture set, the picker's first place puts the letters back.
  act(() => host.querySelector(`[data-project-icon="${HERE}"]`)!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  await settle();
  expect([...document.querySelectorAll('[data-face-choice]')].map((el) => el.getAttribute('data-face-choice'))).toEqual(['letters', 'own', 'sets']);
  act(() => document.querySelector<HTMLButtonElement>('[data-face-choice="letters"]')!.click());
  await settle();
  expect(removed).toEqual(['removed']);
});

test.if(hasDom)('Set picture… opens the dialog on Your own…; Animate it on a set icon asks about this project and opens New message to pick an agent', async () => {
  const { here } = inboxes();
  const host = mount(here.folder);
  act(() => host.querySelector<HTMLButtonElement>(`[data-pmore="${HERE}"]`)!.click());
  await settle();
  act(() => document.querySelector<HTMLElement>('[data-project-action="picture"]')!.click());
  await settle();
  const dialog = document.querySelector<HTMLElement>('dialog[data-dialog="agent-icon"][open]')!;
  expect(dialog.querySelector('.ib-agi-drop')).not.toBeNull();
  act(() => dialog.querySelector<HTMLButtonElement>('[data-agi-place="sets"]')!.click());
  await settle();
  act(() => dialog.querySelector<HTMLButtonElement>('.am-sets-tab[data-set="dcss"]')!.click());
  await settle();
  act(() => dialog.querySelector<HTMLButtonElement>('.am-sets-i[data-set-icon="orc"]')!.click());
  await settle();
  act(() => dialog.querySelector<HTMLButtonElement>('[data-animate-go]')!.click());
  await settle();
  expect(document.querySelector('dialog[data-dialog="agent-icon"]')).toBeNull();
  expect(opened).toHaveLength(1);
  const message = opened[0]!;
  const request = /--request (ia_[0-9a-f]{24})/.exec(message.body)?.[1];
  expect(request).toBeDefined();
  expect(message.body).toContain('one of my projects');
  expect(message.files).toHaveLength(1);
  expect(message.to).toBe('pick');
  // The request names this project: its hand-back becomes the picture.
  const animated = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#0f766e"/></svg>';
  const answer = (await (await fetch('/api/inbox/icon-animate', { method: 'POST', body: JSON.stringify({ request, picture: `data:image/svg+xml;base64,${btoa(animated)}` }) })).json()) as { applied: boolean; target: string };
  expect(answer).toMatchObject({ applied: true, target: 'project' });
  expect(await here.kept()).toBe(animated);
});

test.if(hasDom)("a linked machine's project is kept on that machine; an older machine is named as needing an update", async () => {
  const { here, there } = inboxes();
  const host = mount(there.folder);
  const dialog = (await pick(host, THERE, 'sets'))!;
  await useSetIcon(dialog, 'dcss', 'orc');
  expect(asked).toContain(`POST /api/inbox/m/${MINI}/projects/${THERE}/picture`);
  // The set's icon is read from this Inbox, and the picture kept there, not here.
  expect(asked).toContain('GET /api/inbox/icon-sets/dcss/orc');
  expect(await there.kept()).not.toBeNull();
  expect(await here.kept()).toBeNull();
  act(() => root?.unmount());
  document.body.innerHTML = '';

  inboxes({ older: true });
  const older = mount(there.folder);
  const refused = (await pick(older, THERE, 'sets'))!;
  await useSetIcon(refused, 'dcss', 'orc');
  expect(refused.querySelector('[data-icon-refused]')?.textContent).toBe('Mac mini needs an update to set this picture.');
  expect(document.querySelector('dialog[data-dialog="agent-icon"][open]')).not.toBeNull();
});
