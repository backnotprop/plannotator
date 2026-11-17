/**
 * The Spaces home (approval "plans-home", home-5.html), drawn from a real plan library: a scratch `plan-library/`
 * written with the store, answered by the real route handler in place of the Inbox (the view kept in memory in place
 * of config.json). No server, no Inbox. What regresses if these fail:
 * - "Now" loses a plan that waits on the person or holds one that does not; Recent is not cut to its one row of cards
 *   or 8 rows; "All plans" loses a project, its newest 5 or "Show N more", or forgets a fold;
 * - the cards/list switch is not the person's (kept through the Inbox, so another window opens on it);
 * - the sidebar's project does not scope the page, or Home does not go back;
 * - search misses a title or the empty search says nothing;
 * - an arrival moves a card while the person looks, or does not wait behind "N updates · Show"; Show or looking away
 *   does not settle it; an arrival's dot and fact are not drawn in place at once;
 * - a pin is not kept, the sidebar does not list the pinned spaces in the person's order, or Move up, Move down and
 *   Unpin do nothing;
 * - a face draws before it is near the screen, says the title twice, is focusable, or an HTML page in it can run;
 * - any card says an agent is working (this build knows no live link from a session to a plan).
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NO_ACTOR, type SpacesView } from '@plannotator/core/plans';
import { createPlanStore, type PlanStore } from '../../shared/plans/store';
import { handlePlanRoute } from '../../shared/plans/routes';

const hasDom = typeof document !== 'undefined';
const { PlansRoute } = (hasDom ? await import('./PlansPage') : {}) as typeof import('./PlansPage');
const { PlansNav } = (hasDom ? await import('./PlansNav') : {}) as typeof import('./PlansNav');
const { SPACES_FOLDS_KEY } = (hasDom ? await import('./SpacesHome') : {}) as typeof import('./SpacesHome');
const { readRoute } = (hasDom ? await import('../app/route') : {}) as typeof import('../app/route');
const { readPlans, resetPlansForTests } = (hasDom ? await import('./store') : {}) as typeof import('./store');
const { SidebarProvider } = (hasDom ? await import('../shell/sidebar') : {}) as typeof import('../shell/sidebar');
const { ThemeProvider } = (hasDom ? await import('@plannotator/ui/components/ThemeProvider') : {}) as typeof import('@plannotator/ui/components/ThemeProvider');

let root: Root | null = null;
let unlisten = () => {};
let dir = '';
let store: PlanStore;
/** config.json's `inboxSpacesView`, as the Inbox keeps it. */
let keptView: SpacesView = 'cards';
let viewSaves = 0;
const realFetch = globalThis.fetch;
const realMatchMedia = hasDom ? window.matchMedia : undefined;
const realObserver = hasDom ? globalThis.IntersectionObserver : undefined;

/** A face is drawn once its card comes near the screen: here, when the test says so (`nearAll`). */
let observers: { cb: IntersectionObserverCallback; els: Element[] }[] = [];
function nearAll() {
  act(() => {
    for (const o of observers.splice(0)) o.cb(o.els.map((target) => ({ target, isIntersecting: true }) as unknown as IntersectionObserverEntry), {} as IntersectionObserver);
  });
}

beforeEach(() => {
  if (!hasDom) return;
  dir = mkdtempSync(join(tmpdir(), 'spaces-home-'));
  store = createPlanStore({ dataDir: dir });
  resetPlansForTests(null, true);
  keptView = 'cards';
  viewSaves = 0;
  observers = [];
  localStorage.removeItem(SPACES_FOLDS_KEY);
  window.history.replaceState(null, '', '/');
  window.matchMedia = ((query: string) => ({ matches: query.includes('reduce'), media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
  (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = class {
    entry: { cb: IntersectionObserverCallback; els: Element[] };
    constructor(cb: IntersectionObserverCallback) {
      this.entry = { cb, els: [] };
      observers.push(this.entry);
    }
    observe(el: Element) {
      this.entry.els.push(el);
    }
    disconnect() {
      observers = observers.filter((o) => o !== this.entry);
    }
    unobserve() {}
    takeRecords() {
      return [];
    }
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://127.0.0.1');
    const answer = await handlePlanRoute(
      { method: init?.method ?? 'GET', pathname: url.pathname, params: url.searchParams, json: async () => JSON.parse(String(init?.body ?? '{}')) },
      { store, view: { read: () => keptView, save: (v) => ((keptView = v), viewSaves++, true) } },
    );
    if (!answer) return Response.json({ error: 'Not found', code: 'not_found' }, { status: 404 });
    if ('file' in answer) return new Response(readFileSync(answer.file.path), { headers: { 'Content-Type': answer.file.contentType } });
    return Response.json(answer.body, { status: answer.status });
  }) as typeof fetch;
});

afterEach(() => {
  if (!hasDom) return;
  unlisten();
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  globalThis.fetch = realFetch;
  window.matchMedia = realMatchMedia!;
  (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = realObserver;
  localStorage.removeItem(SPACES_FOLDS_KEY);
  resetPlansForTests();
  rmSync(dir, { recursive: true, force: true });
});

let clock = 0;
/** Each plan a little newer than the one before. */
const next = () => new Date(Date.UTC(2026, 10, 1, 9) + ++clock * 60_000).toISOString();
const bytes = (text: string) => new TextEncoder().encode(text);

/** A plan with `versions` versions; `decided`: the person decided on its newest (so it waits on no one). */
function plan(name: string, project: string | null, options: { versions?: number; decided?: boolean; text?: string; kind?: 'markdown' | 'html'; projectId?: string } = {}) {
  const { plan: record, document } = store.createPlan({ name, project_name: project, project_id: options.projectId ?? null, created_at: next(), document: { title: name, kind: options.kind ?? 'markdown' } });
  const count = options.versions ?? 1;
  for (let i = 1; i <= count; i++) store.addVersion(record.id, document.id, { bytes: bytes(options.text ?? `# ${name}\n\nVersion ${i} of the plan.\n`), committed_at: next(), source: 'plan-review', author_via: 'plan-review' });
  if (options.decided) decide(record.id, count);
  return record.id;
}
function decide(id: string, n: number) {
  const document = store.read(id)!.documents[0]!;
  const version = store.versions(id)[n - 1]!;
  const at = next();
  store.addEvent(id, { ...NO_ACTOR, kind: 'decision', at, subject: { document_id: document.id, version_number: n }, decision: { document_id: document.id, version: version.version, version_number: n, decision: 'approved', at, feedback: null, feedback_record: null, snapshot: null }, legacy: null });
}
/** A new version arrives from the agent. */
function arrive(id: string) {
  const document = store.read(id)!.documents[0]!;
  store.addVersion(id, document.id, { bytes: bytes(`# ${store.get(id)!.name}\n\nA newer version.\n`), committed_at: next(), source: 'plan-review', author_via: 'plan-review' });
}

async function settle() {
  for (let i = 0; i < 6; i++) await act(async () => await new Promise((r) => setTimeout(r, 5)));
}

const projects = [{ id: 'prj_harbor', name: 'harbor-api', root: '/work/harbor-api' }];

/** The page as App draws it (with the sidebar's Spaces row), drawn again on every hashchange. */
function draw() {
  const host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  root = createRoot(host);
  const render = () =>
    act(() =>
      root!.render(
        <ThemeProvider>
          <SidebarProvider>
            <nav data-test-sidebar="">
              <PlansNav on onClick={() => {}} />
            </nav>
            <PlansRoute route={readRoute()} on settingsKnown phone={false} projects={projects} />
          </SidebarProvider>
        </ThemeProvider>,
      ),
    );
  window.addEventListener('hashchange', render);
  unlisten = () => window.removeEventListener('hashchange', render);
  render();
  return host;
}
function redraw() {
  unlisten();
  act(() => root?.unmount());
  document.body.innerHTML = '';
  resetPlansForTests(null, true);
  return draw();
}

const text = (el: Element | null) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
const ids = (scope: Element | null) => [...(scope?.querySelectorAll('[data-space]') ?? [])].map((el) => el.getAttribute('data-space'));
const crumbs = (host: Element) => [...host.querySelectorAll('[data-spaces-crumbs] :is(button, b)')].map(text);
const section = (host: Element, name: string) => host.querySelector(`[data-spaces-section="${name}"]`);
const click = async (el: Element | null) => {
  expect(el).not.toBeNull();
  await act(async () => (el as HTMLElement).click());
  await settle();
};
/** Base UI opens a menu on the pointer's press, as a person's click does. */
async function press(el: Element | null) {
  expect(el).not.toBeNull();
  await act(async () => {
    el!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }));
    el!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    el!.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerType: 'mouse' }));
    el!.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
    (el as HTMLElement).click();
  });
  await settle();
}
async function type(host: Element, value: string) {
  const search = host.querySelector('[data-spaces-search]') as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, value);
    search.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

test.skipIf(!hasDom)('Now holds what waits on the person, never cut; Recent is one row of cards or 8 rows; the switch is the person\'s, kept through the Inbox', async () => {
  const waiting = Array.from({ length: 6 }, (_, i) => plan(`Waiting ${i + 1}`, 'harbor-api'));
  const done = Array.from({ length: 12 }, (_, i) => plan(`Done ${i + 1}`, i % 2 ? 'harbor-api' : 'field-notes', { decided: true }));
  window.location.hash = '#plans';
  let host = draw();
  await settle();
  expect(host.querySelector('[data-spaces-home]')?.getAttribute('aria-label')).toBe('Spaces');
  expect(text(host.querySelector('h1'))).toBe('What do you want to plan?');
  expect(text(host.querySelector('[data-spaces-local]'))).toBe('On this computer');
  // Now: every waiting plan, newest first, as large cards saying "Your move".
  expect(ids(section(host, 'now'))).toEqual([...waiting].reverse());
  expect(section(host, 'now')!.querySelectorAll('.fc-large')).toHaveLength(6);
  expect(text(section(host, 'now')!.querySelector('.fc-fact'))).toBe('Your move');
  // Recent: one row of cards (4 before the page is measured), newest first.
  expect(ids(section(host, 'recent'))).toEqual([...done].reverse().slice(0, 4));
  // Nothing says an agent is working: no live link is known.
  expect(host.textContent).not.toContain('is working');

  expect(host.querySelector('[data-spaces-view-pick="cards"]')?.getAttribute('aria-pressed')).toBe('true');
  await click(host.querySelector('[data-spaces-view-pick="list"]'));
  expect([keptView, viewSaves]).toEqual(['list', 1]);
  expect(host.querySelector('[data-spaces-home]')?.getAttribute('data-spaces-view')).toBe('list');
  expect(ids(section(host, 'now'))).toHaveLength(6);
  expect(ids(section(host, 'recent'))).toEqual([...done].reverse().slice(0, 8));
  // In the list the project shows only in Now.
  expect(text(section(host, 'now')!.querySelector('.fc-rsec'))).toBe('harbor-api');
  expect(section(host, 'recent')!.querySelector('.fc-rsec')).toBeNull();

  // Another window (a fresh read) opens on the person's view.
  host = redraw();
  await settle();
  expect(host.querySelector('[data-spaces-home]')?.getAttribute('data-spaces-view')).toBe('list');
  expect(host.querySelector('[data-spaces-view-pick="list"]')?.getAttribute('aria-pressed')).toBe('true');
});

test.skipIf(!hasDom)('All plans: by project, the newest 5 rows each then Show N more; a project\'s name folds it, and the fold is remembered', async () => {
  keptView = 'list';
  const harbor = Array.from({ length: 7 }, (_, i) => plan(`Harbor ${i + 1}`, 'harbor-api', { decided: true }));
  const field = [plan('Field 1', 'field-notes', { decided: true })];
  window.location.hash = '#plans';
  let host = draw();
  await settle();
  await click(host.querySelector('[data-spaces-all]'));
  expect(window.location.hash).toBe('#plans&all');
  expect(crumbs(host)).toEqual(['Home', 'All plans']);
  const group = () => host.querySelector('[data-spaces-group="harbor-api"]')!;
  expect(ids(group())).toEqual([...harbor].reverse().slice(0, 5));
  expect(text(group().querySelector('[data-spaces-more]'))).toBe('Show 2 more');
  await click(group().querySelector('[data-spaces-more]'));
  expect(ids(group())).toEqual([...harbor].reverse());
  expect(ids(host.querySelector('[data-spaces-group="field-notes"]'))).toEqual(field);

  await click(group().querySelector('[data-spaces-fold]'));
  expect(group().querySelector('[data-spaces-fold]')?.getAttribute('aria-expanded')).toBe('false');
  expect(ids(group())).toEqual([]);
  expect(text(group().querySelector('.ib-spc-fcount'))).toBe('7 plans');
  host = redraw();
  await settle();
  expect(group().getAttribute('data-folded')).toBe('');
  expect(ids(host.querySelector('[data-spaces-group="field-notes"]'))).toEqual(field);
  // Home goes back.
  await click(host.querySelector('[data-spaces-home-crumb]'));
  expect(window.location.hash).toBe('#plans');
  expect(section(host, 'recent')).not.toBeNull();
});

test.skipIf(!hasDom)('the sidebar\'s project scopes the page: its plans only, Now first then Earlier; search looks through every title', async () => {
  const mine = plan('Rotate refresh tokens', 'harbor-api', { projectId: 'prj_harbor' });
  const mineDone = plan('Ledger import', 'harbor-api', { decided: true });
  const other = plan('Offline drafts', 'field-notes', { decided: true });
  window.location.hash = '#plans&project=prj_harbor';
  const host = draw();
  await settle();
  expect(crumbs(host)).toEqual(['Home', 'harbor-api']);
  expect(ids(section(host, 'now'))).toEqual([mine]);
  expect(ids(section(host, 'earlier'))).toEqual([mineDone]);
  expect(text(section(host, 'earlier')!.querySelector('h2'))).toBe('Earlier');
  expect(ids(host)).not.toContain(other);

  await click(host.querySelector('[data-spaces-home-crumb]'));
  expect(window.location.hash).toBe('#plans');
  await type(host, 'drafts offline');
  expect(ids(host)).toEqual([other]);
  expect(host.querySelector('[data-spaces-group="field-notes"]')).not.toBeNull();
  await type(host, 'kubernetes');
  expect(text(host.querySelector('[data-spaces-none]'))).toBe('No plans match “kubernetes”.');
  await type(host, '');
  expect(ids(host).sort()).toEqual([mine, mineDone, other].sort());
});

test.skipIf(!hasDom)('nothing moves while the person looks: an arrival\'s dot and fact change in place, its place waits behind "1 update · Show"; looking away settles it', async () => {
  const older = plan('Older plan', 'harbor-api', { decided: true });
  const middle = plan('Middle plan', 'harbor-api', { decided: true });
  const newest = plan('Newest plan', 'harbor-api', { decided: true });
  window.location.hash = '#plans';
  const host = draw();
  await settle();
  expect(ids(section(host, 'recent'))).toEqual([newest, middle, older]);
  const card = () => host.querySelector(`[data-space="${older}"]`)!;
  expect(card().querySelector('.fc-dot')).toBeNull();

  // The pointer is over the page: the person is looking.
  await act(async () => card().dispatchEvent(new Event('pointermove', { bubbles: true })));
  arrive(older);
  await act(async () => await readPlans());
  await settle();
  // In place: the dot and "Your move" at once; the order as it was; the pill beside the first heading.
  expect(card().querySelector('.fc-dot')).not.toBeNull();
  expect(text(card().querySelector('.fc-fact'))).toBe('Your move');
  expect(section(host, 'now')).toBeNull();
  expect(ids(section(host, 'recent'))).toEqual([newest, middle, older]);
  const pill = host.querySelector('[data-card-updates]')!;
  expect(text(pill)).toBe('1 update · Show');
  expect(pill.closest('h2')).not.toBeNull();

  await click(pill);
  expect(ids(section(host, 'now'))).toEqual([older]);
  expect(ids(section(host, 'recent'))).toEqual([newest, middle]);
  expect(host.querySelector('[data-card-updates]')).toBeNull();

  // Another arrives while still looking: held again; then the pointer leaves the window and it settles by itself.
  arrive(middle);
  await act(async () => await readPlans());
  await settle();
  expect(ids(section(host, 'recent'))).toEqual([newest, middle]);
  expect(text(host.querySelector('[data-card-updates]'))).toBe('1 update · Show');
  await act(async () => document.documentElement.dispatchEvent(new Event('pointerleave')));
  await settle();
  expect(ids(section(host, 'now'))).toEqual([middle, older]);
  expect(host.querySelector('[data-card-updates]')).toBeNull();
  // A plan that arrives while no one looks takes its place at once.
  const fresh = plan('A fresh plan', 'harbor-api');
  await act(async () => await readPlans());
  await settle();
  expect(ids(section(host, 'now'))).toEqual([fresh, middle, older]);
});

test.skipIf(!hasDom)('pinning: the card\'s pin keeps a space in the sidebar, in the person\'s order; Move up, Move down and Unpin', async () => {
  const a = plan('Alpha plan', 'harbor-api', { decided: true });
  const b = plan('Beta plan', 'harbor-api', { decided: true });
  const c = plan('Gamma plan', 'harbor-api', { decided: true });
  window.location.hash = '#plans';
  let host = draw();
  await settle();
  const pinned = () => [...host.querySelectorAll('[data-space-pins] [data-pinned-space]')].map((el) => el.getAttribute('data-pinned-space'));
  expect(host.querySelector('[data-space-pins]')).toBeNull();
  for (const id of [b, a, c]) await click(host.querySelector(`[data-space-pin-toggle="${id}"]`));
  expect(pinned()).toEqual([b, a, c]);
  expect(store.pins()).toEqual([b, a, c]);
  // The card says so: its pin is now Unpin, and its link's name says "pinned".
  expect(host.querySelector(`[data-space-pin-toggle="${a}"]`)?.getAttribute('aria-label')).toBe('Unpin');
  expect(text(host.querySelector(`[data-space="${a}"] [data-card-link]`))).toContain('pinned');
  // The action is beside the link, never in it.
  expect(host.querySelector(`[data-space="${a}"] [data-card-link] [data-space-pin-toggle]`)).toBeNull();

  const menu = async (id: string, action: 'up' | 'down' | 'unpin') => {
    await press(host.querySelector(`[data-space-pin-more="${id}"]`));
    await press(document.querySelector(`[data-space-pin-menu="${id}"] [data-space-pin-action="${action}"]`));
  };
  await menu(c, 'up');
  expect(pinned()).toEqual([b, c, a]);
  await menu(b, 'down');
  expect(pinned()).toEqual([c, b, a]);
  await menu(a, 'unpin');
  expect(pinned()).toEqual([c, b]);
  expect(store.pins()).toEqual([c, b]);
  // Kept: a new window lists them in that order; a pinned row opens its plan.
  host = redraw();
  await settle();
  expect(pinned()).toEqual([c, b]);
  await click(host.querySelector(`[data-pinned-space="${b}"]`));
  expect(window.location.hash).toBe(`#plans=${b}`);
});

test.skipIf(!hasDom)('a face: drawn only near the screen, the plan\'s own top without the title again, inert; an HTML page in a frame that runs nothing', async () => {
  const doc = plan('Rotate refresh tokens', 'harbor-api', { text: '# Rotate refresh tokens\n\n## Context\n\nRetire keys after 14 days.\n' });
  const page = plan('Checkout mockup', 'harbor-api', { kind: 'html', text: '<h1>Checkout</h1><script>parent.x = 1</script>' });
  window.location.hash = '#plans';
  const host = draw();
  await settle();
  const face = (id: string) => host.querySelector(`[data-space="${id}"] [data-card-face]`)!;
  expect(face(doc).getAttribute('aria-hidden')).toBe('true');
  expect(face(doc).hasAttribute('inert')).toBe(true);
  // Not near yet: the quiet ground only.
  expect(face(doc).querySelector('[data-space-face]')).toBeNull();
  nearAll();
  await settle();
  const drawn = face(doc).querySelector('[data-space-face="document"]')!;
  expect(drawn).not.toBeNull();
  expect(text(drawn)).toContain('Retire keys after 14 days.');
  expect(text(drawn.querySelector('h2'))).toBe('Context');
  // The card says the title; the face does not say it again.
  expect(drawn.textContent).not.toContain('Rotate refresh tokens');
  expect(text(host.querySelector(`[data-space="${doc}"] .fc-title`))).toBe('New. Rotate refresh tokens');
  // The page is a frame that runs nothing, is never focusable, under the plan page's own policy.
  const frame = face(page).querySelector('iframe')!;
  expect(frame.getAttribute('sandbox')).toBe('');
  expect(frame.getAttribute('tabindex')).toBe('-1');
  expect(frame.getAttribute('srcdoc')).toContain("default-src 'none'");
  expect(host.querySelector(`[data-space="${page}"]`)?.querySelector('[data-card-kind="page"]')).not.toBeNull();
  // One link per card, named by its title and fact.
  expect(host.querySelectorAll(`[data-space="${doc}"] a`)).toHaveLength(1);
});
