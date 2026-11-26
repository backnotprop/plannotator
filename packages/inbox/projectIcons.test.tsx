/**
 * A project's picture from the icon dialog (components/ProjectRow.tsx, ProjectMarkPicker.tsx, agents/AgentIconDialog.tsx
 * `ProjectIconDialog`, agents/iconTarget.ts, agents/DrawIt.tsx), through the Inbox's real routes (icon sets, uploaded
 * pictures, project pictures, icon requests) on temp folders behind a fetch stand-in: no Inbox is started.
 *
 * What this catches: the project mark opening the project instead of the picker; Use this icon keeping a face, another
 * icon's bytes, or a one-colour icon that vanishes on a dark sidebar; Set picture… opening a bare file picker; the
 * picker offering no way back to the letters once a picture is set; "Ask an agent to draw it" asking about another
 * project, sending the message itself, not naming the request, or leaving out what the window knows of the project
 * (its name, folder, origin and newest threads' titles, newest first, each one line and cut short); a linked machine's project kept on this computer;
 * an older machine's refusal shown as a bare error. The picker's outer arc: not all eight hues, a source offered that
 * the project lacks or missing one it has, the wrong place checked, or a picked hue not kept or not drawn.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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
const lookApi = (hasDom ? await import('./data/projectLookApi') : {}) as typeof import('./data/projectLookApi');
const marksModule = (hasDom ? await import('./letterMarks') : {}) as typeof import('./letterMarks');

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
    // Its folder has a favicon: the repo's logo is one of its sources.
    const root = join(dir, '..', name);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>');
    const folder = { id: project, name, root };
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
      const use = { logo: false, github: false, repo: () => null };
      if (url.pathname === `/api/inbox/projects/${project}/picture/sources`) return json(await pictures.sources(folder, use));
      if (url.pathname !== `/api/inbox/projects/${project}/picture`) return null;
      if (req.method === 'GET') {
        const source = url.searchParams.get('source');
        const picture = source === 'repo' || source === 'github' ? await pictures.source(folder, source, use) : await pictures.get(folder, use);
        return picture ? new Response(picture.body, { headers: { 'content-type': picture.type } }) : new Response(null, { status: 204 });
      }
      const body = await readBody(req);
      if (body.look !== undefined) {
        if (!pictures.setLook(project, body.look as never)) return json({ error: 'look', code: 'validation_error' }, 422);
      } else if (body.picture === null) pictures.removeUpload(project);
      else {
        const data = /^data:image\/[a-z0-9.+-]+;base64,(.+)$/i.exec(String(body.picture));
        const saved = data ? pictures.setUpload(project, new Uint8Array(Buffer.from(data[1]!, 'base64'))) : null;
        if (!saved?.ok) return json({ error: 'Picture: a PNG, JPEG, GIF, WebP or SVG image.', code: 'validation_error' }, 422);
      }
      const at = pictures.uploadedAt(project);
      const look = pictures.lookOf(project);
      return json({ project: { ...folder, ...(at !== undefined ? { picture: at } : {}), ...(look ? { look } : {}) } });
    };
    const kept = async () => {
      const picture = await pictures.get({ id: project, root: '/nowhere' }, { logo: false, github: false, repo: () => null });
      return picture ? new TextDecoder().decode(picture.body) : null;
    };
    const handle = async (req: Request, url: URL) => (await iconsRoute(req, url)) ?? (await setsRoute(req, url)) ?? (await pictureRoute(req, url)) ?? (await animate.route(req, url)) ?? json({ error: 'not here' }, 404);
    return { builtIn, folder, kept, handle, store, pictures };
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
let looks: string[] = [];
/** One project's sidebar row, with project marks on (Settings → Rows). */
function mount(project: { id: string; name: string; root: string }) {
  removed = [];
  looks = [];
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
          // As projectWrites.ts keeps a look: the Inbox's answer is the project the list then draws.
          onLook={async (look) => {
            looks.push(look);
            const answer = await lookApi.setProjectLook(project.id, look);
            if (answer.project) known.learnProjects([answer.project]);
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
  expect([...document.querySelectorAll('[data-face-choice]')].map((el) => el.getAttribute('data-face-choice')).slice(0, 3)).toEqual(['letters', 'own', 'sets']);
  act(() => document.querySelector<HTMLButtonElement>('[data-face-choice="letters"]')!.click());
  await settle();
  expect(removed).toEqual(['removed']);
});

test.if(hasDom)('Set picture… opens the dialog on Your own…; Ask an agent to draw it asks about this project and opens New message to pick an agent, filled in with what the window knows', async () => {
  const { here } = inboxes();
  const row = (id: string, subject: string, at: string, project = { id: HERE, name: 'billing' }) => ({ thread_id: id, project, thread_name: null, subject, last_at: at, author: { kind: 'agent', session: 'ses_x' } });
  known.learnProjects(
    [{ ...here.folder, repo: 'acme/billing' }],
    [
      row('thr_1', 'Retry the failed invoices', '2026-11-20T10:00:00.000Z'),
      row('thr_2', `Reconcile the ledger\nwith the bank ${'x'.repeat(120)}`, '2026-11-24T10:00:00.000Z'),
      row('thr_3', 'Another project thread', '2026-11-25T10:00:00.000Z', { id: THERE, name: 'infra' }),
    ],
  );
  const host = mount(here.folder);
  act(() => host.querySelector<HTMLButtonElement>(`[data-pmore="${HERE}"]`)!.click());
  await settle();
  act(() => document.querySelector<HTMLElement>('[data-project-action="picture"]')!.click());
  await settle();
  const dialog = document.querySelector<HTMLElement>('dialog[data-dialog="agent-icon"][open]')!;
  expect(dialog.querySelector('.ib-agi-drop')).not.toBeNull();
  act(() => dialog.querySelector<HTMLButtonElement>('[data-draw-go]')!.click());
  await settle();
  expect(document.querySelector('dialog[data-dialog="agent-icon"]')).toBeNull();
  expect(opened).toHaveLength(1);
  const message = opened[0]!;
  const request = /--request (ia_[0-9a-f]{24})/.exec(message.body)?.[1];
  expect(request).toBeDefined();
  expect(message.body).toContain('"billing"');
  expect(message.body).toContain(here.folder.root);
  expect(message.body).toContain('acme/billing');
  // This project's threads only, newest first, each on one line and cut short.
  const ledger = message.body.indexOf('"Reconcile the ledger with the bank');
  expect(ledger).toBeGreaterThan(-1);
  expect(ledger).toBeLessThan(message.body.indexOf('"Retry the failed invoices"'));
  expect(message.body).not.toContain('Another project thread');
  expect(message.body).not.toContain('x'.repeat(100));
  // The tile the icon is drawn on, and the hand-back with this request's id.
  expect(message.body).toContain('<rect width="64" height="64" rx="14"/>');
  expect(message.body).toContain(`plannotator inbox icon set <file.svg> --request ${request}`);
  expect(message.to).toBe('pick');
  // The request names this project: its hand-back becomes the picture.
  const drawn = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#0f766e"/></svg>';
  const answer = (await (await fetch('/api/inbox/icon-animate', { method: 'POST', body: JSON.stringify({ request, picture: `data:image/svg+xml;base64,${btoa(drawn)}` }) })).json()) as { applied: boolean; target: string };
  expect(answer).toMatchObject({ applied: true, target: 'project' });
  expect(await here.kept()).toBe(drawn);
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

test.if(hasDom)("the picker's outer arc: the letters in all eight hues and the sources the project has; a hue is kept for the project and drawn", async () => {
  const { here } = inboxes();
  const host = mount(here.folder);
  act(() => host.querySelector(`[data-project-icon="${HERE}"]`)!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  await settle();
  const places = () => [...document.querySelectorAll('[data-face-choice]')].map((el) => el.getAttribute('data-face-choice'));
  // Its folder has a logo, and its origin is not on GitHub: the repo's logo, no GitHub picture.
  expect(places()).toEqual(['own', 'sets', 'hue:0', 'hue:1', 'hue:2', 'hue:3', 'hue:4', 'hue:5', 'hue:6', 'hue:7', 'repo']);
  // Nothing picked and no picture: the name's own hue is the one checked.
  const own = `hue:${marksModule.hueOf(HERE)}`;
  expect(document.querySelector('[aria-checked="true"]')?.getAttribute('data-face-choice')).toBe(own);
  const other = own === 'hue:3' ? 'hue:4' : 'hue:3';
  act(() => document.querySelector<HTMLButtonElement>(`[data-face-choice="${other}"]`)!.click());
  await settle();
  expect(looks).toEqual([other]);
  expect(here.pictures.lookOf(HERE)).toBe(other);
  // The row's mark is drawn in that hue, and the picker now checks it and offers the letters back.
  expect(host.querySelector('.ib-proj .ib-lm')?.getAttribute('data-hue')).toBe(other.slice(4));
  act(() => host.querySelector(`[data-project-icon="${HERE}"]`)!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  await settle();
  expect(document.querySelector('[aria-checked="true"]')?.getAttribute('data-face-choice')).toBe(other);
  expect(places()[0]).toBe('letters');
  // The repo's logo: the project's look in place of the hue.
  act(() => document.querySelector<HTMLButtonElement>('[data-face-choice="repo"]')!.click());
  await settle();
  expect(here.pictures.lookOf(HERE)).toBe('repo');
});
