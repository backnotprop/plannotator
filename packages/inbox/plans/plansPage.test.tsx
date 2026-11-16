/**
 * The window's Plans page, drawn from a real plan library: a scratch `plan-library/` written with the store
 * (packages/shared/plans/store.ts), answered by the real route handler (packages/shared/plans/routes.ts) in place of
 * the Inbox, so what the page shows is what the library holds. No server, no Inbox. What regresses if these fail:
 * - the list leaves out a plan, loses "changed since you looked" or the number of new versions, or shows a decision
 *   the plan's record does not hold;
 * - an empty library does not show the get-started screen, or its action does not say how a plan arrives;
 * - a plan's page does not show the newest version's text, the versions newest first, the version you saw, or the
 *   "changed since you looked" banner; opening it does not record the look;
 * - a plan's Markdown page stops being the Inbox's own file viewer (AttachmentPane: its header with Download and the
 *   view switch, the annotation toolstrip, Copy file and Global comment, the comments panel, the contents rail);
 * - a comment made there is not kept in the plan library, not back after the page opens again, or not taken away;
 * - Send opens New message with anything but the plan's own agent session and the comments as plan feedback, or is
 *   not disabled, in the Inbox's words, when no session is known;
 * - a decision on an older version reads as current in the list or the rail head (it must say "changed since");
 * - the page leaves the shared frame (its ground, top bar, rail, page card and versions panel), the reading line's
 *   version words leave its end, or the plan's decision comes back into the reading line or leaves the rail head
 *   (where it shows with the versions panel closed);
 * - the project leaves the rail head's quiet line or the top bar's "Plans / project / plan", or its crumb becomes a
 *   link (the Plans list has no address for one project);
 * - the files rail loses the main page's place or mark, mixes artifacts in with pages, shows Artifacts with none,
 *   opens a row without the versions and the address following, draws an HTML artifact that can run, load or follow
 *   a link, shows a picture the server sends as a download, or forgets that it was closed;
 * - short of room the rail does not give way to the frame's sheet first (with no tab that opens nothing), then the
 *   versions to the frame's sheet;
 * - the versions panel cannot be closed, forgets that it was, or cannot be opened again from the reading line;
 * - another page's activity shows the main page's history, or an artifact's shows anything plan-wide;
 * - opening a plan through another page's link marks every version new in the list;
 * - the compact list leaves out a plan or orders it differently, loses a column, is not a link, is not remembered,
 *   or search and the empty search stop working in it;
 * - picking a version in the versions panel does not show that version, Compare and Copy link are lost, the version
 *   you saw loses "You saw this", a sent-back version loses "Changes asked", or versions with no name each say
 *   "No name recorded";
 * - the diff does not compare the two versions with the plan diff engine, or the reading line does not say so;
 * - with Plans off, the page draws nothing and a `#plans` link goes to the Inbox.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NO_ACTOR } from '@plannotator/core/plans';
import { createPlanStore, type PlanStore } from '../../shared/plans/store';
import { handlePlanRoute } from '../../shared/plans/routes';

const hasDom = typeof document !== 'undefined';
const { PlansRoute } = (hasDom ? await import('./PlansPage') : {}) as typeof import('./PlansPage');
const { readRoute } = (hasDom ? await import('../app/route') : {}) as typeof import('../app/route');
const { resetPlansForTests } = (hasDom ? await import('./store') : {}) as typeof import('./store');
const { PLANS_VIEW_KEY } = (hasDom ? await import('./PlansHome') : {}) as typeof import('./PlansHome');
const storageModule = hasDom ? await import('@plannotator/ui/utils/storage') : null;
const { SidebarProvider } = (hasDom ? await import('../shell/sidebar') : {}) as typeof import('../shell/sidebar');
const mermaid = hasDom ? await import('@plannotator/ui/utils/mermaid') : null;
const diagramSvg = hasDom ? await import('@plannotator/ui/test-setup/diagramSvg') : null;
const { acceptPlanDiagramSvg } = (hasDom ? await import('./planContent') : {}) as typeof import('./planContent');
// Loaded here so the page's lazy contents rail resolves at once.
if (hasDom) await import('@plannotator/ui/components/MarkdownContentsRail');

let root: Root | null = null;
let unlisten = () => {};
let dir = '';
let store: PlanStore;
/** The server's failed import, as the list reports it; a `?retry=1` read counts in `retries` and (here) succeeds. */
let importError: string | null = null;
let retries = 0;
const realFetch = globalThis.fetch;
const realMatchMedia = hasDom ? window.matchMedia : undefined;

beforeEach(() => {
  if (!hasDom) return;
  dir = mkdtempSync(join(tmpdir(), 'plans-page-'));
  store = createPlanStore({ dataDir: dir });
  resetPlansForTests(null, true);
  importError = null;
  retries = 0;
  window.history.replaceState(null, '', '/');
  // Reduced motion (the frame's panels open and close at once) and a desktop window for the frame's docked rail.
  window.matchMedia = ((query: string) => ({
    matches: query.includes('reduce') || (query.includes('min-width: 768px') && window.innerWidth >= 768),
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  // The Inbox's place: the real route handler over the scratch library.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://127.0.0.1');
    if (url.searchParams.get('retry') === '1') {
      retries++;
      importError = null;
    }
    const answer = await handlePlanRoute(
      { method: init?.method ?? 'GET', pathname: url.pathname, params: url.searchParams, json: async () => JSON.parse(String(init?.body ?? '{}')) },
      { store, importError: () => importError },
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
  localStorage.removeItem(PLANS_VIEW_KEY);
  storageModule?.resetStorageBackend();
  resetPlansForTests();
  rmSync(dir, { recursive: true, force: true });
});

const at = (day: number, hour = 9) => new Date(Date.UTC(2026, 10, day, hour)).toISOString();
const bytes = (text: string) => new TextEncoder().encode(text);

/** A plan with versions; `seen`: the person looked at that version. */
function plan(name: string, project: string | null, texts: string[], options: { seen?: number; approvedOn?: number; deniedOn?: number } = {}) {
  const { plan: record, document } = store.createPlan({ name, project_name: project, created_at: at(1), document: { title: name } });
  texts.forEach((text, i) => store.addVersion(record.id, document.id, { bytes: bytes(text), committed_at: at(2 + i), source: 'plan-review', author_via: 'plan-review' }));
  for (const [kind, n] of [['approved', options.approvedOn], ['denied', options.deniedOn]] as const) {
    if (!n) continue;
    const version = store.versions(record.id)[n - 1]!;
    store.addEvent(record.id, {
      ...NO_ACTOR,
      kind: 'decision',
      at: at(2 + n, 12),
      subject: { document_id: document.id, version_number: n },
      decision: { document_id: document.id, version: version.version, version_number: n, decision: kind, at: at(2 + n, 12), feedback: null, feedback_record: null, snapshot: null },
      legacy: null,
    });
  }
  if (options.seen) store.recordLook(record.id, { seen: options.seen });
  return record.id;
}

/** Let the reads land and React draw them. */
async function settle() {
  for (let i = 0; i < 6; i++) await act(async () => await new Promise((r) => setTimeout(r, 5)));
}

/** The page as App draws it: from the address, drawn again on every hashchange. */
function draw(on = true) {
  const host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  root = createRoot(host);
  const render = () => act(() => root!.render(
      <SidebarProvider>
        <PlansRoute route={readRoute()} on={on} settingsKnown phone={false} />
      </SidebarProvider>,
    ));
  window.addEventListener('hashchange', render);
  unlisten = () => window.removeEventListener('hashchange', render);
  render();
  return host;
}

const text = (el: Element | null) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
/** A file row's name in the frame's rail (`FileRow`: the name, then our Main mark). */
const fileNames = (scope: Element, sel = '') => [...scope.querySelectorAll(`${sel} [data-plan-file] span.truncate`)].map(text);
/**
 * The reading line's version words, without the count on its toggle (the frame's `count`): "v2 · newest", "v2 of 3".
 */
function readingWords(host: Element) {
  const toggle = host.querySelector('[data-plan-reading] [data-reading-versions]');
  if (!toggle) return '';
  const copy = toggle.cloneNode(true) as Element;
  copy.querySelector('[data-reading-versions-count]')?.remove();
  return text(copy);
}
/** Plannotator's storage in memory for one test (happy-dom keeps no cookie here); put back in afterEach. */
function keptStorage(entries: [string, string][] = []) {
  const kept = new Map<string, string>(entries);
  storageModule!.setStorageBackend({ getItem: (k) => kept.get(k) ?? null, setItem: (k, v) => void kept.set(k, v), removeItem: (k) => void kept.delete(k) });
  return kept;
}
/** The frame row's width, as layout would give it (happy-dom lays nothing out); returns the restore. */
function rowWidth(width: () => number) {
  const own = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
  const inherited = Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth');
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get(this: HTMLElement) {
      if (this.hasAttribute('data-frame-row')) return width();
      return (own ?? inherited)?.get?.call(this) ?? 0;
    },
  });
  return () => {
    if (own) Object.defineProperty(HTMLElement.prototype, 'clientWidth', own);
    else delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
  };
}

test.skipIf(!hasDom)('the list is the library: changed since you looked first, with how many versions are new; the decision from its record', async () => {
  const changed = plan('Rotate refresh tokens', 'harbor-api', ['# Rotate refresh tokens\n\nv1\n', '# Rotate refresh tokens\n\nv2\n', '# Rotate refresh tokens\n\nv3\n'], { seen: 1, deniedOn: 1 });
  const approved = plan('Offline drafts', 'field-notes', ['# Offline drafts\n\nv1\n', '# Offline drafts\n\nv2\n'], { seen: 2, approvedOn: 2 });
  const never = plan('Ledger import', 'harbor-api', ['# Ledger import\n\nv1\n']);
  window.location.hash = '#plans';
  const host = draw();
  await settle();

  const since = host.querySelector('[data-plans-group="since"]')!;
  expect(since).not.toBeNull();
  expect([...since.querySelectorAll('[data-plan-row]')].map((r) => r.getAttribute('data-plan-row'))).toEqual([changed]);
  expect(text(since.querySelector('[data-plan-changed]'))).toContain('2 new');
  expect(text(since.querySelector(`[data-plan-row="${changed}"]`))).toContain('you saw v1');
  // Every plan is listed once; the others are not marked changed.
  const rows = [...host.querySelectorAll('[data-plan-row]')].map((r) => r.getAttribute('data-plan-row'));
  expect(rows.sort()).toEqual([changed, approved, never].sort());
  expect(host.querySelector(`[data-plan-row="${approved}"] [data-plan-changed]`)).toBeNull();
  expect(host.querySelector(`[data-plan-row="${never}"] [data-plan-changed]`)).toBeNull();
  // The decision is the record's: approved on v2, changes asked on v1, none.
  expect(host.querySelector(`[data-plan-row="${approved}"] [data-plan-decision]`)?.getAttribute('data-plan-decision')).toBe('approved');
  expect(host.querySelector(`[data-plan-row="${changed}"] [data-plan-decision]`)?.getAttribute('data-plan-decision')).toBe('changes');
  expect(host.querySelector(`[data-plan-row="${never}"] [data-plan-decision]`)?.getAttribute('data-plan-decision')).toBe('none');
  // The project groups follow.
  expect(host.querySelector('[data-plans-group="p:field-notes"]')).not.toBeNull();
});

test.skipIf(!hasDom)('a decision on an older version never reads as current: the list and the rail head say it changed since', async () => {
  const older = plan('Rotate refresh tokens', 'harbor-api', ['# Rotate\n\nv1\n', '# Rotate\n\nv2\n', '# Rotate\n\nv3\n', '# Rotate\n\nv4\n'], { seen: 4, approvedOn: 2 });
  const current = plan('Offline drafts', 'field-notes', ['# Offline drafts\n\nv1\n', '# Offline drafts\n\nv2\n'], { seen: 2, approvedOn: 2 });
  window.location.hash = '#plans';
  const host = draw();
  await settle();
  expect(text(host.querySelector(`[data-plan-row="${older}"] [data-plan-decision]`))).toBe('Approved on v2 · changed since');
  expect(text(host.querySelector(`[data-plan-row="${current}"] [data-plan-decision]`))).toBe('Approved');

  window.location.hash = `#plans=${older}`;
  await settle();
  expect(text(host.querySelector('[data-pages-rail-meta] [data-plan-rail-decision]'))).toBe('Approved on v2 · changed since');
  expect(host.querySelector('[data-plan-reading] [data-plan-decision]')).toBeNull();
  // The version row keeps its own approval (the frame's), without the note.
  expect(text(host.querySelector('[data-plan-version="2"] [data-version-approval]'))).toBe('Approved by you');

  window.location.hash = `#plans=${current}`;
  await settle();
  // On its newest version the decision is current: just its words.
  expect(text(host.querySelector('[data-pages-rail-meta] [data-plan-rail-decision]'))).toBe('Approved');
});

test.skipIf(!hasDom)('the compact list: the switch shows the same plans one line each, is remembered, and search works the same', async () => {
  const changed = plan('Rotate refresh tokens', 'harbor-api', ['# Rotate\n\nv1\n', '# Rotate\n\nv2\n', '# Rotate\n\nv3\n'], { seen: 1 });
  const older = plan('Offline drafts', 'field-notes', ['# Offline drafts\n\nv1\n', '# Offline drafts\n\nv2\n', '# Offline drafts\n\nv3\n'], { seen: 3, approvedOn: 1 });
  const newer = plan('Ledger import', 'harbor-api', ['# Ledger import\n\nv1\n', '# Ledger import\n\nv2\n', '# Ledger import\n\nv3\n', '# Ledger import\n\nv4\n']);
  const rowIds = (host: Element) => [...host.querySelectorAll('[data-plan-row]')].map((r) => r.getAttribute('data-plan-row'));
  window.location.hash = '#plans';
  let host = draw();
  await settle();
  // Rows with previews by default.
  expect(host.querySelector('[data-plans-compact]')).toBeNull();
  expect(host.querySelector('[data-plans-view-pick="rows"]')?.getAttribute('aria-pressed')).toBe('true');
  const inRows = rowIds(host);
  expect(inRows.sort()).toEqual([changed, older, newer].sort());

  await act(async () => (host.querySelector('[data-plans-view-pick="compact"]') as HTMLButtonElement).click());
  const table = host.querySelector('table[data-plans-compact]')!;
  expect(table).not.toBeNull();
  expect(host.querySelector('[data-plans-view-pick="compact"]')?.getAttribute('aria-pressed')).toBe('true');
  expect(host.querySelector('.ib-plans-thumb')).toBeNull();
  // Since you looked first, then every other plan newest first; the same plans as the rows.
  expect(rowIds(host)).toEqual([changed, newer, older]);
  expect([...table.querySelectorAll('thead th')].map(text)).toEqual(['Name', 'Project', 'Version', 'Decision', 'Last change']);
  const line = table.querySelector(`[data-plan-row="${older}"]`)!;
  expect(text(line.querySelector('.ib-plans-c-project'))).toBe('field-notes');
  expect(text(line.querySelector('.ib-plans-c-version'))).toBe('v3');
  expect(text(line.querySelector('[data-plan-decision]'))).toBe('Approved on v1 · changed since');
  expect(text(table.querySelector(`[data-plan-row="${newer}"] [data-plan-decision]`))).toBe('No decision');
  expect(text(table.querySelector(`[data-plan-row="${changed}"] [data-plan-changed]`))).toContain('2 new');
  // Each line is a link to its plan.
  const link = line.querySelector('a')!;
  expect(link.getAttribute('href')).toBe(`#plans=${older}`);
  expect(link.getAttribute('title')).toBe('Offline drafts');

  // Search and the empty search are the same in both views.
  const search = host.querySelector('[data-plans-search]') as HTMLInputElement;
  const type = async (value: string) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, value);
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
  await type('ledger');
  expect(rowIds(host)).toEqual([newer]);
  await type('kubernetes');
  expect(host.querySelector('[data-plans-none]')).not.toBeNull();
  await type('');

  // Remembered: a window opened again shows the compact list.
  unlisten();
  act(() => root?.unmount());
  document.body.innerHTML = '';
  host = draw();
  await settle();
  expect(host.querySelector('table[data-plans-compact]')).not.toBeNull();
  await act(async () => (host.querySelector('[data-plans-view-pick="rows"]') as HTMLButtonElement).click());
  expect(host.querySelector('table[data-plans-compact]')).toBeNull();
  expect(rowIds(host).sort()).toEqual(inRows.sort());

  // A plain click on a line opens the plan.
  await act(async () => (host.querySelector('[data-plans-view-pick="compact"]') as HTMLButtonElement).click());
  await act(async () => (host.querySelector(`[data-plan-row="${newer}"] a`) as HTMLAnchorElement).click());
  await settle();
  expect(host.querySelector(`[data-plan-page="${newer}"]`)).not.toBeNull();
});

test.skipIf(!hasDom)('the frame: top bar, files rail, page card and versions panel; main page first, other pages and artifacts by name; a row opens its file, the versions and the address follow', async () => {
  const id = plan('Rotate refresh tokens', 'harbor-api', ['# Rotate refresh tokens\n\nThe plan.\n'], { seen: 1, approvedOn: 1 });
  const rollout = store.addDocument(id, { title: 'Rollout', created_at: at(3) });
  store.addVersion(id, rollout.id, { bytes: bytes('# Rollout\n\nFirst.\n'), committed_at: at(3), source: 'agent-tool' });
  store.addVersion(id, rollout.id, { bytes: bytes('# Rollout\n\nRollout second version.\n'), committed_at: at(4), source: 'agent-tool' });
  const flow = store.addDocument(id, { title: 'Flow', kind: 'mermaid', created_at: at(3) });
  store.addVersion(id, flow.id, { bytes: bytes('flowchart LR\n  A --> B\n'), committed_at: at(3), source: 'agent-tool' });
  store.addArtifact(id, {
    asset_path: 'mockup.html',
    bytes: bytes('<base target="_self"><h1>Mockup</h1><img src="https://example.com/x.png"><a href="https://example.com/">plain</a> <a href="https://example.com/2" target="_self">self</a> <a href="https://example.com/3" target="_top">top</a>'),
    content_type: 'text/html',
    created_at: at(5),
  });
  store.addArtifact(id, { asset_path: 'pics/screen.png', bytes: new Uint8Array([137, 80, 78, 71]), content_type: 'image/png', title: 'Screen', created_at: at(5) });
  store.addArtifact(id, { asset_path: 'scan.bmp', bytes: new Uint8Array([66, 77]), content_type: 'image/bmp', created_at: at(5) });
  const bare = plan('Ledger import', null, ['# Ledger import\n']);
  const kept = keptStorage();

  window.location.hash = `#plans=${id}`;
  const host = draw();
  await settle();
  // The shared frame's pieces: the top bar outside the cards, then the rail, the page card and the versions panel.
  const shell = host.querySelector('[data-frame]')!;
  expect(shell.querySelector(':scope > [data-page-header]')).not.toBeNull();
  const row = shell.querySelector('[data-frame-row]')!;
  expect(row.querySelector('[data-document-rail] [data-plan-files]')).not.toBeNull();
  expect(row.querySelector('[data-document-shell] [data-plan-document]')).not.toBeNull();
  expect(row.querySelector('[data-docked-panel-clip] [data-versions-panel]')).not.toBeNull();
  // On the frame's own ground, in theme colours.
  expect(host.querySelector('[data-frame-ground][data-frame-colors="theme"] [data-plan-page] [data-frame]')).not.toBeNull();
  // The top bar: Plans / the project / the plan; the project is words, not a link (no address for one project).
  expect(text(shell.querySelector('[data-page-header] [data-breadcrumb-root]'))).toBe('Plans');
  expect(shell.querySelector('[data-page-header] [data-breadcrumb-root]')?.getAttribute('href')).toBe('#plans');
  const projectCrumb = shell.querySelector('[data-page-header] [data-plan-crumb-project]')!;
  expect(text(projectCrumb)).toBe('harbor-api');
  expect(projectCrumb.closest('a')).toBeNull();
  expect(projectCrumb.hasAttribute('href')).toBe(false);
  expect(text(shell.querySelector('[data-page-header] [aria-current="page"]'))).toBe('Rotate refresh tokens');
  // The rail head: back to Plans with the plan's name; on the quiet line under it the project, then the plan's decision.
  expect(text(row.querySelector('[data-pages-back-link]'))).toBe('Rotate refresh tokens');
  const meta = row.querySelector('[data-pages-rail-head] [data-pages-rail-meta]')!;
  expect(text(meta.querySelector('[data-plan-rail-project]'))).toBe('harbor-api');
  const railDecision = meta.querySelector('[data-plan-rail-decision]')!;
  expect(text(railDecision)).toBe('Approved');
  expect(railDecision.getAttribute('data-plan-decision')).toBe('approved');
  expect(meta.querySelector('[data-plan-rail-project]')!.compareDocumentPosition(railDecision) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(meta.querySelector('[title]')?.getAttribute('title')).toBe('harbor-api · Approved');
  // The reading line: only the version words and the versions toggle (with their count), at its end; no project, no
  // decision (an older version's line would read "Approved on v4  You are looking at an older version").
  const reading = host.querySelector('[data-plan-reading]')!;
  expect(reading.querySelector('[data-reading-start]')).toBeNull();
  expect(reading.querySelector('[data-plan-decision]')).toBeNull();
  const end = reading.querySelector('[data-reading-version-end] [data-reading-versions]')!;
  expect(readingWords(host)).toBe('v1 · newest');
  expect(text(end.querySelector('[data-reading-versions-count]'))).toBe('1');
  expect(text(reading)).not.toContain('harbor-api');
  const panel = host.querySelector('[data-plan-files]')!;
  const names = (sel: string) => fileNames(panel, sel);
  expect(names('[data-plan-files-pages]')).toEqual(['Rotate refresh tokens', 'Flow', 'Rollout']);
  // "Main" at the main page's row end (the frame's `trailing`).
  expect(text(panel.querySelector('[data-plan-files-pages] > :first-child [data-file-row-trailing] [data-plan-file-main]'))).toBe('Main');
  expect(panel.querySelectorAll('[data-plan-file-main]').length).toBe(1);
  expect(names('[data-plan-files-artifacts]')).toEqual(['mockup.html', 'scan.bmp', 'Screen']);
  // The frame's second heading: Artifacts and their count, with no Filter of its own (one Filter, under Pages).
  const artHeading = panel.querySelector('[data-plan-files-art-heading]')!;
  expect(text(artHeading)).toBe('Artifacts3');
  expect(artHeading.querySelector('[title="3 artifacts"]')).not.toBeNull();
  expect(artHeading.querySelector('button')).toBeNull();
  expect(panel.querySelectorAll('button[aria-label="Filter files"]').length).toBe(1);
  expect(panel.querySelector(`[data-plan-file="d:${store.get(id)!.primary_doc_id}"]`)?.getAttribute('aria-current')).toBe('page');
  // The main page's activity, under the versions list (the panel's footer): its versions and your decisions.
  expect(host.querySelector('[data-versions-panel] [data-versions-footer] .ib-plan-activity')).not.toBeNull();
  const activity = () => [...host.querySelectorAll('.ib-plan-activity li')].map(text);
  expect(activity().some((line) => line.startsWith('You approved v1'))).toBe(true);

  // A page: the middle shows it, the rail its versions, the address carries it.
  await act(async () => (panel.querySelector(`[data-plan-file="d:${rollout.id}"]`) as HTMLAnchorElement).click());
  await settle();
  expect(window.location.hash).toBe(`#plans=${id}&doc=${rollout.id}`);
  expect(text(host.querySelector('[data-plan-document]'))).toContain('Rollout second version.');
  expect(host.querySelectorAll('[data-versions-panel] [data-version-row]').length).toBe(2);
  expect(host.querySelector(`[data-plan-file="d:${rollout.id}"]`)?.getAttribute('aria-current')).toBe('page');
  // The top bar: Plans / the plan / the page.
  expect(text(host.querySelector('[data-page-header] [data-breadcrumb-root]'))).toBe('Plans');
  expect(host.querySelector('[data-page-header] a[aria-label="Rotate refresh tokens"]')?.getAttribute('href')).toBe(`#plans=${id}`);
  expect(text(host.querySelector('[data-page-header] [aria-current="page"]'))).toBe('Rollout');
  expect(readingWords(host)).toBe('v2 · newest');
  expect(text(host.querySelector('[data-plan-reading] [data-reading-versions-count]'))).toBe('2');
  // Its activity is its own history only: nothing of the main page's versions or decisions.
  expect(activity().map((line) => line.split(' saved')[0])).toEqual(['v2', 'v1']);

  // An artifact: an HTML page in a frame that runs and loads nothing; the rail says it has no versions.
  await act(async () => (host.querySelector('[data-plan-file="a:mockup.html"]') as HTMLAnchorElement).click());
  await settle();
  expect(window.location.hash).toBe(`#plans=${id}&file=mockup.html`);
  const frame = host.querySelector('iframe[data-plan-html-frame]')!;
  expect(frame.getAttribute('sandbox')).toBe('');
  const srcdoc = frame.getAttribute('srcdoc')!;
  expect(srcdoc.startsWith(`<meta http-equiv="Content-Security-Policy" content="default-src 'none';`)).toBe(true);
  // Its links open nowhere: every one asks for a new window (which the sandbox refuses), the page's own base is gone.
  const inside = new DOMParser().parseFromString(srcdoc, 'text/html');
  expect([...inside.querySelectorAll('base')].map((b) => b.getAttribute('target'))).toEqual(['_blank']);
  expect([...inside.querySelectorAll('a')].map((a) => a.getAttribute('target'))).toEqual(['_blank', '_blank', '_blank']);
  expect(host.querySelector('[data-document-shell] [data-plan-no-versions]')).not.toBeNull();
  expect(host.querySelector('[data-versions-panel]')).toBeNull();
  expect(host.querySelector('.ib-plan-activity')).toBeNull();

  // A picture type the server sends as a download (BMP) is a file to download, not a broken picture.
  await act(async () => (host.querySelector('[data-plan-file="a:scan.bmp"]') as HTMLAnchorElement).click());
  await settle();
  expect(host.querySelector('[data-plan-artifact="scan.bmp"] img')).toBeNull();
  expect(host.querySelector('[data-plan-artifact-download]')).not.toBeNull();
  await act(async () => (host.querySelector('[data-plan-file="a:pics/screen.png"]') as HTMLAnchorElement).click());
  await settle();
  expect(host.querySelector('[data-plan-artifact="pics/screen.png"] img')).not.toBeNull();

  // Filter files.
  await act(async () => (host.querySelector('[data-plan-files] button[aria-label="Filter files"]') as HTMLButtonElement).click());
  const field = host.querySelector('[data-plan-files-query]') as HTMLInputElement;
  const type = async (value: string) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value);
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
  await type('roll');
  expect(fileNames(host.querySelector('[data-plan-files]')!)).toEqual(['Rollout']);
  await type('zzz');
  expect(text(host.querySelector('[data-plan-files-none]'))).toBe('No files match “zzz”.');

  // The frame's Collapse rail (its edge, by keyboard) is kept: the rail stays closed on the next plan opened, and the
  // frame's Show files tab brings it back.
  await act(async () => host.querySelector('.collapsible-edge[aria-label="Collapse rail"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  await settle();
  expect(host.querySelector('[data-plan-files]')).toBeNull();
  expect(kept.get('plannotator-inbox-plan-files-open')).toBe('0');
  window.location.hash = `#plans=${bare}`;
  await settle();
  expect(host.querySelector('[data-plan-files]')).toBeNull();
  await act(async () => (host.querySelector('button[aria-label="Show files"]') as HTMLButtonElement).click());
  await settle();
  // A plan with no artifacts: one page, no Artifacts heading. With no project: no quiet line, Plans / the plan.
  expect(fileNames(host.querySelector('[data-plan-files]')!)).toEqual(['Ledger import']);
  expect(host.querySelector('[data-pages-rail-meta]')).toBeNull();
  expect(host.querySelector('[data-plan-crumb-project]')).toBeNull();
  expect(text(host.querySelector('[data-page-header] a[data-plans-back]'))).toBe('Plans');
  expect(host.querySelector('[data-plan-files-artifacts]')).toBeNull();
  expect(text(host.querySelector('[data-plan-files]'))).not.toContain('Artifacts');
});

test.skipIf(!hasDom)('short of room the rail gives way first, to the frame\'s sheet; then the versions, to the frame\'s sheet', async () => {
  const id = plan('Rotate refresh tokens', 'harbor-api', ['# Rotate refresh tokens\n\nThe plan.\n'], { seen: 1 });
  // The rail kept closed: where it cannot dock, no tab offers to open it (it would open nothing).
  const kept = keptStorage([['plannotator-inbox-plan-files-open', '0']]);
  let width = 1000;
  const restore = rowWidth(() => width);
  try {
    window.location.hash = `#plans=${id}`;
    let host = draw();
    await settle();
    // 1000 px: the versions dock (288 beside 480 of document), the rail (306 more) does not: the frame's rail sheet
    // (`RailSheet docked={false}`, from `onFitChange`) takes it, its trigger in the top bar.
    const page = () => host.querySelector('[data-plan-page]')!;
    expect(page().getAttribute('data-files')).toBe('sheet');
    expect(page().getAttribute('data-rail')).toBe('docked');
    expect(host.querySelector('[data-document-rail]')).toBeNull();
    expect(host.querySelector('[data-rail-flags]')).toBeNull();
    expect(host.querySelector('[data-docked-panel-clip] [data-versions-panel]')).not.toBeNull();
    const shows = [...host.querySelectorAll('button[aria-label="Show files"]')];
    expect(shows.length).toBe(1);
    expect(shows[0]!.closest('[data-frame] > *:first-child')).not.toBeNull();
    await act(async () => (shows[0] as HTMLButtonElement).click());
    await settle();
    expect(fileNames(document.querySelector('[data-plan-sidebar="compact"]')!)).toEqual(['Rotate refresh tokens']);
    expect(text(document.querySelector('[data-plan-sidebar="compact"] [data-pages-rail-meta]'))).toBe('harbor-api');
    // The kept choice waits for a row that fits.
    expect(kept.get('plannotator-inbox-plan-files-open')).toBe('0');
    // 700 px: the versions do not dock either; the reading line opens them as the frame's sheet.
    width = 700;
    unlisten();
    act(() => root!.unmount());
    document.body.innerHTML = '';
    host = draw();
    await settle();
    expect(page().getAttribute('data-rail')).toBe('sheet');
    expect(host.querySelector('[data-versions-panel]')).toBeNull();
    const toggle = host.querySelector('[data-reading-versions]') as HTMLButtonElement;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await act(async () => toggle.click());
    await settle();
    expect(document.querySelector('[data-versions-sheet] [data-plan-version="1"]')).not.toBeNull();
    await act(async () => (document.querySelector('[data-versions-sheet] button[aria-label="Close versions"]') as HTMLButtonElement).click());
    await settle();
    expect(document.querySelector('[data-versions-sheet] [data-versions-panel]')).toBeNull();
  } finally {
    restore();
  }
});

test.skipIf(!hasDom)('the versions panel closes, stays closed after a remount, and the reading line opens it again; Compare and Copy link stay', async () => {
  const id = plan('Rotate refresh tokens', 'harbor-api', ['# Rotate refresh tokens\n\nThe plan.\n', '# Rotate refresh tokens\n\nThe plan, again.\n'], { seen: 2, approvedOn: 2 });
  const kept = keptStorage();
  const restore = rowWidth(() => 1400);
  const copied: string[] = [];
  const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value: string) => void copied.push(value) } });
  const redraw = async () => {
    unlisten();
    act(() => root!.unmount());
    document.body.innerHTML = '';
    const next = draw();
    await settle();
    return next;
  };
  try {
    window.location.hash = `#plans=${id}`;
    let host = draw();
    await settle();
    // First use: open, docked beside the page card.
    expect(host.querySelector('[data-plan-page]')!.getAttribute('data-rail')).toBe('docked');
    expect(host.querySelector('[data-docked-panel-clip] [data-versions-panel]')).not.toBeNull();
    // The newest on screen: our Compare offers the one before; Copy link copies this version's address.
    expect(text(host.querySelector('[data-version-actions] [data-plan-compare]'))).toBe('Compare v1 with v2');
    await act(async () => (host.querySelector('[data-version-copy-link]') as HTMLButtonElement).click());
    expect(copied).toEqual([`${window.location.href.split('#')[0]}#plans=${id}&v=2`]);
    await act(async () => (host.querySelector('button[aria-label="Close versions"]') as HTMLButtonElement).click());
    await settle();
    // Closed: the row holds the rail and the page card only; the reading line's button opens it again.
    expect(host.querySelector('[data-versions-panel]')).toBeNull();
    expect(host.querySelector('[data-plan-page]')!.getAttribute('data-rail')).toBe('closed');
    expect([...host.querySelector('[data-frame-row]')!.querySelectorAll(':scope > [data-docked-panel-clip]')]).toEqual([]);
    expect(kept.get('plannotator-inbox-plan-rail-hidden')).toBe('1');
    // With the panel closed the plan's decision is still on screen, in the rail head.
    expect(text(host.querySelector('[data-pages-rail-meta] [data-plan-rail-decision]'))).toBe('Approved');
    // Kept on this computer: a remount draws it closed.
    host = await redraw();
    expect(host.querySelector('[data-versions-panel]')).toBeNull();
    const toggle = host.querySelector('[data-reading-versions]') as HTMLButtonElement;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    // Its name is a full sentence: which version is on screen, and how many there are (the frame's words).
    expect(toggle.getAttribute('aria-label')).toBe('v2 · newest, version 2, the newest. 2 versions. Versions');
    await act(async () => toggle.click());
    await settle();
    expect(host.querySelector('[data-versions-panel] [data-plan-version="2"]')).not.toBeNull();
    // An older version on screen: the frame's Compare (with the newest) and its way back to the newest.
    await act(async () => (host.querySelector('[data-plan-version="1"]') as HTMLAnchorElement).click());
    await settle();
    expect(window.location.hash).toBe(`#plans=${id}&v=1`);
    await act(async () => (host.querySelector('[data-version-compare]') as HTMLButtonElement).click());
    await settle();
    expect(window.location.hash).toBe(`#plans=${id}&from=1&to=2`);
  } finally {
    restore();
    if (clipboard) Object.defineProperty(navigator, 'clipboard', clipboard);
    else delete (navigator as { clipboard?: unknown }).clipboard;
  }
});

test.skipIf(!hasDom)('a plan’s Markdown page is the Inbox’s own file viewer: its header, toolstrip, Copy file, Global comment, comments panel and contents rail', async () => {
  const headings = ['Rotate refresh tokens', 'Context', 'Design', 'Rollout'];
  const id = plan('Rotate refresh tokens', 'harbor-api', [`# ${headings[0]}\n\n## ${headings[1]}\n\nWhy.\n\n## ${headings[2]}\n\nHow.\n\n## ${headings[3]}\n\nWhen.\n`], { seen: 1 });
  keptStorage();
  // A page wide enough for the rail (happy-dom lays nothing out): the page 900 px, its column 640 px.
  const real = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    if (this.classList.contains('ib-docscroll')) return new DOMRect(0, 0, 900, 800);
    if (this.hasAttribute('data-doc-text-root')) return new DOMRect(130, 0, 640, 2000);
    return real.call(this);
  };
  try {
    window.location.hash = `#plans=${id}`;
    const host = draw();
    await settle();
    // The pane a Markdown file opens in beside a thread (components/AttachmentPane.tsx), its file this version.
    const pane = host.querySelector<HTMLElement>('[data-plan-annotate] section.ib-view[data-attachment-pane]')!;
    expect(pane).not.toBeNull();
    expect(text(pane.querySelector('.ib-vhead [data-header-name]'))).toBe('Rotate refresh tokens.md');
    expect(pane.querySelector('.ib-vhead [data-attachment-download]')!.getAttribute('href')).toBe(`/api/plans/${id}/versions/1`);
    expect(pane.querySelector('.ib-vhead [data-view-switch] [data-full-screen-toggle]')).not.toBeNull();
    // Its annotation toolstrip, and the Viewer's own header: Copy file and Global comment.
    expect(pane.querySelector('.ib-toolstrip')?.querySelectorAll('button').length).toBeGreaterThan(1);
    expect([...pane.querySelectorAll('button')].some((b) => text(b) === 'Copy file')).toBe(true);
    expect(pane.querySelector('button[title="Add global comment"]')).not.toBeNull();
    // The reader's frame: `.ib-docscroll`, the Clean look on the card colour; the comments panel beside it.
    const page = pane.querySelector<HTMLElement>('.ib-docscroll.bg-card[data-look="clean"]')!;
    expect(page).not.toBeNull();
    expect(text(page)).toContain('How.');
    expect(pane.querySelector('.ib-apanel')).not.toBeNull();
    for (let i = 0; i < 4; i++) {
      await act(async () => {
        window.dispatchEvent(new Event('resize'));
        await new Promise((r) => setTimeout(r, 60));
      });
    }
    // The contents rail lists the headings.
    expect([...host.querySelectorAll('.pn-contents-rail .pn-contents-rail-label')].map(text)).toEqual(headings);
  } finally {
    HTMLElement.prototype.getBoundingClientRect = real;
  }
});

/** Add a global comment through the Viewer's own button and composer, as the person does. */
async function globalComment(host: Element, words: string) {
  act(() => host.querySelector<HTMLButtonElement>('button[title="Add global comment"]')!.click());
  await settle();
  const area = document.querySelector<HTMLTextAreaElement>('[data-comment-popover] textarea')!;
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(area), 'value')!.set!;
  await act(async () => {
    setter.call(area, words);
    area.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true }));
  });
  await settle();
}

test.skipIf(!hasDom)('a comment on a plan is kept in the plan library, is back when the page opens again, and is taken away from the panel', async () => {
  const id = plan('Rotate refresh tokens', 'harbor-api', ['# Rotate refresh tokens\n\nRetire keys after 14 days.\n']);
  keptStorage();
  window.location.hash = `#plans=${id}`;
  let host = draw();
  await settle();
  await globalComment(host, 'Say who owns the rollout.');
  // Kept by the real route in the library, on this version, as the viewer made it.
  const kept = store.comments(id);
  expect(kept.map((c) => c.body)).toEqual(['Say who owns the rollout.']);
  expect(kept[0]!.target).toEqual({ kind: 'document', document_id: store.read(id)!.plan.primary_doc_id, document_version: store.versions(id)[0]!.version });
  const card = () => host.querySelector(`.ib-apanel [data-annotation-id="${(kept[0]!.anchor as { id: string }).id}"]`);
  expect(text(card())).toContain('Say who owns the rollout.');
  // The page again, from the library alone.
  act(() => root!.unmount());
  unlisten();
  document.body.innerHTML = '';
  resetPlansForTests(null, true);
  host = draw();
  await settle();
  expect(text(card())).toContain('Say who owns the rollout.');
  // Taken away from its card: gone from the library too.
  const remove = [...card()!.querySelectorAll<HTMLButtonElement>('button')].find((b) => /delete|remove/i.test(`${b.getAttribute('aria-label') ?? ''} ${b.title}`))!;
  act(() => remove.click());
  await settle();
  expect(store.comments(id)).toEqual([]);
  expect(card()).toBeNull();
});

test.skipIf(!hasDom)('Send opens New message to the plan’s own agent session with the comments as plan feedback; with no session it is disabled and says why', async () => {
  const quiet = plan('Rotate refresh tokens', 'harbor-api', ['# Rotate refresh tokens\n\nRetire keys after 14 days.\n']);
  const { plan: record, document: doc } = store.createPlan({ name: 'Rate limits', project_name: 'harbor-api', created_at: at(1), document: { title: 'Rate limits' } });
  store.addVersion(record.id, doc.id, { bytes: bytes('# Rate limits\n\nA token bucket per key.\n'), committed_at: at(2), source: 'plan-review', agent_session: 'sess-42', agent_host: 'claude-code' });
  keptStorage();
  const opened: unknown[] = [];
  const listen = (event: Event) => opened.push((event as CustomEvent).detail);
  window.addEventListener('plannotator-inbox:open-composer', listen);
  try {
    window.location.hash = `#plans=${quiet}`;
    let host = draw();
    await settle();
    const button = () => host.querySelector<HTMLButtonElement>('[data-plan-send-button]')!;
    // No session known: disabled, in the Inbox's words for a project with no live agent.
    await globalComment(host, 'Shorter.');
    expect(button().disabled).toBe(true);
    expect(text(host.querySelector(`#${button().getAttribute('aria-describedby')}`))).toBe('No agent is running in harbor-api');
    act(() => root!.unmount());
    unlisten();
    document.body.innerHTML = '';
    window.location.hash = `#plans=${record.id}`;
    host = draw();
    await settle();
    // Nothing to send yet.
    expect(button().disabled).toBe(true);
    await globalComment(host, 'Name the limit per tenant.');
    expect(button().disabled).toBe(false);
    expect(text(host.querySelector(`#${button().getAttribute('aria-describedby')}`))).toBe('1 annotation rides your next Send to Claude Code.');
    await act(async () => button().click());
    await settle();
    expect(opened).toHaveLength(1);
    const prefill = opened[0] as { subject: string; body: string; to: { session: string } };
    expect(prefill.to).toEqual({ session: 'sess-42' });
    expect(prefill.subject).toBe('Rate limits');
    expect(prefill.body).toContain('# Plan Feedback');
    expect(prefill.body).toContain('Name the limit per tenant.');
  } finally {
    window.removeEventListener('plannotator-inbox:open-composer', listen);
  }
});

test.skipIf(!hasDom)('only the main page counts as looking: a link to another page of a never-opened plan marks nothing new', async () => {
  const id = plan('Rotate refresh tokens', 'harbor-api', ['# Rotate\n\nv1\n', '# Rotate\n\nv2\n', '# Rotate\n\nv3\n']);
  const notes = store.addDocument(id, { title: 'Notes', created_at: at(3) });
  store.addVersion(id, notes.id, { bytes: bytes('# Notes\n'), committed_at: at(3), source: 'agent-tool' });
  window.location.hash = `#plans=${id}&doc=${notes.id}`;
  const host = draw();
  await settle();
  expect(readingWords(host)).toBe('v1 · newest');
  // That page's versions are remembered; the plan is still unlooked, so the list marks nothing.
  expect(store.looks().plans[id]?.docs[notes.id]).toBe(1);
  expect(store.list()[0]).toMatchObject({ seen_version_number: null, changed: false });
  resetPlansForTests(null, true);
  window.location.hash = '#plans';
  await settle();
  expect(host.querySelector(`[data-plan-row="${id}"]`)).not.toBeNull();
  expect(host.querySelector(`[data-plan-row="${id}"] [data-plan-changed]`)).toBeNull();
  expect(host.querySelector('[data-plans-group="since"]')).toBeNull();
});

test.skipIf(!hasDom)('an import that failed is a quiet note in the list and on the get-started screen; Try again reads again with ?retry=1', async () => {
  importError = 'disk says no';
  window.location.hash = '#plans';
  const empty = draw();
  await settle();
  const startNote = empty.querySelector('[data-plans-start] [data-plans-import-error]');
  expect(text(startNote)).toContain('Could not read your earlier plans');
  unlisten();
  act(() => root?.unmount());
  empty.remove();

  plan('Rotate refresh tokens', 'harbor-api', ['# Rotate refresh tokens\n\nv1\n']);
  importError = 'disk says no';
  resetPlansForTests(null, true);
  const host = draw();
  await settle();
  const note = host.querySelector('[data-plans-home] [data-plans-import-error]')!;
  expect(note.getAttribute('title')).toBe('disk says no');
  expect(retries).toBe(0);
  await act(async () => (note.querySelector('button') as HTMLButtonElement).click());
  await settle();
  expect(retries).toBe(1);
  expect(host.querySelector('[data-plans-import-error]')).toBeNull();
  expect(host.querySelector('[data-plan-row]')).not.toBeNull();
});

test.skipIf(!hasDom)('an empty library shows the get-started screen, whose action says how a plan arrives', async () => {
  window.location.hash = '#plans';
  const host = draw();
  await settle();
  expect(host.querySelector('[data-plans-start]')).not.toBeNull();
  expect(host.querySelector('[data-plans-home]')).toBeNull();
  const how = host.querySelector<HTMLButtonElement>('[data-plans-how]')!;
  const steps = host.querySelector<HTMLElement>('[data-plans-steps]')!;
  expect(how.getAttribute('aria-expanded')).toBe('false');
  expect(steps.hidden).toBe(true);
  act(() => how.click());
  expect(how.getAttribute('aria-expanded')).toBe('true');
  expect(steps.hidden).toBe(false);
});

test.skipIf(!hasDom)('a plan opens on its newest version, versions newest first, the one you saw marked; the look is recorded; picking a version shows it', async () => {
  const id = plan('Rotate refresh tokens', 'harbor-api', ['# Rotate refresh tokens\n\nfirst draft\n', '# Rotate refresh tokens\n\nsecond pass\n', '# Rotate refresh tokens\n\nthree keys now\n'], { seen: 1, deniedOn: 1 });
  window.location.hash = `#plans=${id}`;
  const host = draw();
  await settle();

  expect(readingWords(host)).toBe('v3 · newest');
  expect(text(host.querySelector('[data-plan-document]'))).toContain('three keys now');
  expect([...host.querySelectorAll('[data-plan-version]')].map((b) => b.getAttribute('data-plan-version'))).toEqual(['3', '2', '1']);
  // The version you saw says so under its row (outside its link); the one you sent back says "Changes asked".
  expect(text(host.querySelector('[data-version-row][data-version="1"] [data-version-note] [data-plan-seen]'))).toBe('You saw this');
  expect(host.querySelectorAll('[data-plan-seen]').length).toBe(1);
  expect(host.querySelector('[data-plan-version="1"] [data-plan-seen]')).toBeNull();
  expect(text(host.querySelector('[data-plan-version="1"] [data-version-decision="negative"]'))).toBe('Changes asked');
  // No version has a name: no author line ("No name recorded" on each) at all.
  expect(host.querySelector('[data-versions-panel] [data-version-author]')).toBeNull();
  expect(text(host.querySelector('[data-versions-panel]'))).not.toContain('No name recorded');
  expect(host.querySelector('[data-plan-version="3"]')?.getAttribute('aria-current')).toBe('true');
  // Changed since you looked: you saw v1, and Show changes is offered.
  expect(text(host.querySelector('[data-plan-banner="changed"]'))).toContain('You saw v1');
  // Opening it is seeing v3: the next list read says it is no longer changed.
  expect(store.looks().plans[id]?.docs[store.get(id)!.primary_doc_id]).toBe(3);

  act(() => host.querySelector<HTMLAnchorElement>('[data-plan-version="2"]')!.click());
  await settle();
  expect(window.location.hash).toBe(`#plans=${id}&v=2`);
  expect(readingWords(host)).toBe('v2 of 3');
  // "of 3" says how many; no count beside it.
  expect(host.querySelector('[data-plan-reading] [data-reading-versions-count]')).toBeNull();
  expect(host.querySelector('[data-plan-reading] [data-plan-newest]')?.getAttribute('href')).toBe(`#plans=${id}`);
  expect(text(host.querySelector('[data-plan-document]'))).toContain('second pass');
  expect(host.querySelector('[data-plan-version="2"]')?.getAttribute('aria-current')).toBe('true');
  // The banner still compares with what was seen when the page opened.
  expect(host.querySelector('[data-plan-banner="changed"]')).not.toBeNull();
});

test.skipIf(!hasDom)('Show changes compares the version you saw with the newest, through the plan diff engine', async () => {
  const id = plan('Rotate refresh tokens', 'harbor-api', ['# Rotate refresh tokens\n\nRetire keys after 14 days.\n\nDelete retired keys at once.\n', '# Rotate refresh tokens\n\nRetire keys after 21 days.\n\nKeep retired keys for an audit.\n'], { seen: 1 });
  window.location.hash = `#plans=${id}`;
  const host = draw();
  await settle();
  act(() => host.querySelector<HTMLButtonElement>('[data-plan-show-changes]')!.click());
  await settle();
  expect(window.location.hash).toBe(`#plans=${id}&from=1&to=2`);
  expect(text(host.querySelector('[data-plan-banner="diff"]'))).toContain('the one you saw');
  // The reading line says which two are compared, and still how many versions there are.
  expect(text(host.querySelector('[data-plan-reading] [data-reading-comparing]'))).toBe('Comparing v1 with v2');
  expect(text(host.querySelector('[data-plan-reading] [data-reading-versions-count]'))).toBe('2');
  // Both compared versions are marked in the versions panel.
  expect([...host.querySelectorAll('[data-version-row][data-version-compared]')].map((row) => row.getAttribute('data-version'))).toEqual(['2', '1']);
  const diff = host.querySelector('[data-plan-diff="1-2"]')!;
  expect(diff).not.toBeNull();
  // The old words are marked removed and the new ones added; nothing offers a comment (read only).
  expect(text(diff.querySelector('.plan-diff-word-removed, .plan-diff-removed'))).toContain('14');
  expect(text(diff.querySelector('.plan-diff-word-added, .plan-diff-added'))).toContain('21');
  expect(diff.querySelector('[style*="cursor: pointer"]')).toBeNull();
  // Back to one version.
  act(() => host.querySelector<HTMLButtonElement>('[data-plan-only]')!.click());
  await settle();
  expect(window.location.hash).toBe(`#plans=${id}`);
  expect(host.querySelector('[data-plan-diff]')).toBeNull();
});

test.skipIf(!hasDom)('an agent’s plan fetches no remote picture and no link takes the tab away: in the document and in the diff', async () => {
  const risky = [
    '# Links',
    '',
    '![tracker](https://tracker.example/p.png) ![inline](data:image/png;base64,iVBORw0KGgo=)',
    '',
    '[spec](docs/spec.md) [mail](mailto:someone@example.com) [editor](vscode://file/x.ts) [site](https://example.com/x) [top](#links) <auto@example.com>',
    '',
    '<p><a href="docs/raw.md">raw</a> <img src="https://tracker.example/h.png" alt="raw tracker"></p>',
    '',
  ].join('\n');
  const id = plan('Links', 'harbor-api', ['# Links\n\nplain\n', risky]);
  const check = (scope: Element) => {
    const srcs = [...scope.querySelectorAll('img')].map((img) => img.getAttribute('src') ?? '');
    // No picture from anywhere but the plan itself.
    expect(srcs.filter((src) => !src.startsWith('data:'))).toEqual([]);
    const hrefs = [...scope.querySelectorAll('a[href]')].map((a) => a.getAttribute('href'));
    // A relative path, a mail link and an editor link are inert text; a web link opens in a new tab.
    for (const inert of ['docs/spec.md', 'mailto:someone@example.com', 'mailto:auto@example.com', 'vscode://file/x.ts', 'docs/raw.md']) expect(hrefs).not.toContain(inert);
    expect(text(scope)).toContain('spec');
    const site = scope.querySelector('a[href="https://example.com/x"]')!;
    expect(site.getAttribute('target')).toBe('_blank');
    expect(site.getAttribute('rel')).toContain('noopener');
  };

  window.location.hash = `#plans=${id}`;
  const host = draw();
  await settle();
  check(host.querySelector('[data-plan-document="2"]')!);

  window.location.hash = `#plans=${id}&from=1&to=2`;
  await settle();
  check(host.querySelector('[data-plan-diff="1-2"]')!);
});

test.skipIf(!hasDom)('a drawn diagram that would load from another host is never put in the page: its source shows; markers and same-document links still draw', async () => {
  const NS = 'xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"';
  // What the engine hands back for each source: the sources pass the source rule, the drawn svgs are the test.
  const drawn: Record<string, string> = {
    'flowchart TD\n  Hostile --> X': `<svg ${NS} id="h" viewBox="0 0 10 10"><image href="https://tracker.example/p.png" width="5" height="5"/></svg>`,
    'flowchart TD\n  Marker --> Y': `<svg ${NS} id="m" viewBox="0 0 10 10" data-marker-diagram=""><defs><marker id="a"><path d="M0 0L5 5"/></marker></defs><path d="M0 0L9 9" marker-end="url(#a)"/><a href="#a"><text>x</text></a></svg>`,
  };
  const restoreParser = diagramSvg!.installInertDiagramSvgParser();
  mermaid!.__setMermaidRuntimeLoaderForTests(async () => ({ initialize() {}, render: async (_id: string, source: string) => ({ svg: drawn[source.trim()] ?? '' }) }) as never);
  try {
    const text = ['# Drawn', '', '```mermaid', 'flowchart TD', '  Hostile --> X', '```', '', '```mermaid', 'flowchart TD', '  Marker --> Y', '```', ''].join('\n');
    const id = plan('Drawn', 'harbor-api', [text]);
    window.location.hash = `#plans=${id}`;
    const host = draw();
    await settle();
    await settle();
    const doc = host.querySelector('[data-plan-document="1"]')!;
    // The hostile one: no svg of it anywhere in the page, its source as code.
    expect(document.querySelector('image')).toBeNull();
    expect(document.querySelector('svg#h, svg[id$="h"]')).toBeNull();
    const source = [...doc.querySelectorAll('pre')].find((pre) => pre.textContent?.includes('Hostile --> X'));
    expect(source).toBeDefined();
    // The marker one is mounted.
    expect(doc.querySelector('[data-marker-diagram] path[marker-end="url(#a)"]')).not.toBeNull();
  } finally {
    mermaid!.__setMermaidRuntimeLoaderForTests(undefined);
    restoreParser();
  }
});

test.skipIf(!hasDom)('the drawn-diagram check: what loads from another host or document is refused, the same document and data: pass', () => {
  const NS = 'xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"';
  const parse = (body: string) => diagramSvg!.parseInertSvg(`<svg ${NS} id="r">${body}</svg>`)!;
  const refused = [
    '<image href="https://tracker.example/p.png"/>',
    '<image xlink:href="//tracker.example/p.png"/>',
    '<image href="shots/p.png"/>',
    '<use href="other.svg#x"/>',
    '<rect style="fill: url(https://tracker.example/f.svg#g)"/>',
    '<rect fill="url(https://tracker.example/f.svg#g)"/>',
    '<rect style="background: u\\72l(x)"/>',
    '<rect fill="u\\72l(https://tracker.example/f.svg#g)"/>',
    '<rect mask="u\\72l(https://tracker.example/m.svg#m)"/>',
    '<style>#r .n { background: url("https://tracker.example/b.png") }</style>',
    '<style>@import "x.css";</style>',
    '<foreignObject><div xmlns="http://www.w3.org/1999/xhtml"><img src="https://tracker.example/i.png"/></div></foreignObject>',
    '<foreignObject><table xmlns="http://www.w3.org/1999/xhtml" background="https:tracker.example/t.png"/></foreignObject>',
    '<foreignObject><img xmlns="http://www.w3.org/1999/xhtml" srcset="a.png 1x, https://tracker.example/2.png 2x"/></foreignObject>',
    '<a href="https://tracker.example/"><text>x</text></a>',
  ];
  for (const body of refused) expect([body, acceptPlanDiagramSvg(parse(body))]).toEqual([body, false]);
  const accepted = [
    '<defs><marker id="a"/></defs><path marker-end="url(#a)"/>',
    '<rect fill="url(#grad)" filter="url(#drop-shadow)"/>',
    '<use href="#a"/>',
    '<image href="data:image/png;base64,iVBORw0KGgo="/>',
    '<style>#r .node rect { fill: #f9f; stroke: #333 }</style>',
    '<a href="#a"><text>x</text></a>',
  ];
  for (const body of accepted) expect([body, acceptPlanDiagramSvg(parse(body))]).toEqual([body, true]);
});

test.skipIf(!hasDom)('a Mermaid fence that could load a picture is shown as its source, never drawn; a plain one is still a diagram', async () => {
  const text = [
    '# Diagrams',
    '',
    '```mermaid',
    'flowchart TD',
    '  A@{ img: "https://tracker.example/m.png" }',
    '```',
    '',
    '```mermaid',
    'flowchart TD',
    '  Start --> Ship',
    '```',
    '',
  ].join('\n');
  const id = plan('Diagrams', 'harbor-api', [text]);
  window.location.hash = `#plans=${id}`;
  const host = draw();
  await settle();
  const doc = host.querySelector('[data-plan-document="1"]')!;
  const diagrams = [...doc.querySelectorAll('[data-diagram-block="mermaid"]')];
  // The plain one goes to the diagram renderer; the one with a picture does not.
  expect(diagrams).toHaveLength(1);
  expect(diagrams[0]!.textContent).toContain('Start --> Ship');
  const source = [...doc.querySelectorAll('pre')].find((pre) => pre.textContent?.includes('tracker.example/m.png'));
  expect(source).toBeDefined();
  expect(source!.closest('[data-diagram-block]')).toBeNull();
});

test.skipIf(!hasDom)('off: the page draws nothing, reads nothing, and a #plans link goes to the Inbox in place', async () => {
  plan('Rotate refresh tokens', 'harbor-api', ['# Rotate refresh tokens\n\nv1\n']);
  resetPlansForTests(null, false);
  let reads = 0;
  const inner = globalThis.fetch;
  globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
    reads++;
    return inner(...args);
  }) as typeof fetch;
  window.location.hash = '#plans';
  const host = draw(false);
  await settle();
  expect(window.location.hash).toBe('');
  expect(readRoute().page).toBe('inbox');
  expect(host.querySelector('[data-plans-home], [data-plans-start], [data-plan-page]')).toBeNull();
  expect(text(host)).toBe('');
  expect(reads).toBe(0);
});
