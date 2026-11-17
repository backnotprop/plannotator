/**
 * The window's Spaces page (a plan's page; the home is spacesHome.test.tsx), drawn from a real plan library: a scratch `plan-library/` written with the store
 * (packages/shared/plans/store.ts), answered by the real route handler (packages/shared/plans/routes.ts) in place of
 * the Inbox, so what the page shows is what the library holds. No server, no Inbox. What regresses if these fail:
 * - an empty library does not show the get-started screen, or its action does not say how a plan arrives;
 * - a plan's page does not show the newest version's text, the versions newest first, the version you saw, or the
 *   "changed since you looked" banner; opening it does not record the look;
 * - a plan's Markdown page stops being the Inbox's own file viewer (AttachmentPane: its header with Download and the
 *   view switch, the annotation toolstrip, Copy file and Global comment, the comments panel, the contents rail);
 * - a comment made there is not kept in the plan library, not back after the page opens again, or not taken away;
 * - Send opens New message with anything but the plan's own agent session and the comments as plan feedback, or is
 *   not disabled, in the Inbox's words, when no session is known; once sent, its comments are not marked sent or the
 *   plan does not get the thread, or a later Send does not go into that thread as a reply;
 * - an Escape leaves the plan page for the Spaces home (the plan page is not a file beside a thread);
 * - approval "plans-editing": an older version or a diagram page offers Edit; Done does not make a new version of the
 *   person's words, does not send the agent what changed (or say it was not told), or a stale base loses the
 *   person's text; Restore does not make a new newest version; Approve approves a version the plan moved past; the
 *   moved approval's line is not shown, or comes back after its Dismiss;
 * - an approval of an older version reads as current in the rail head or the reading line (approval
 *   "plans-editing": "v4 is new and not approved. You approved v2, and that does not carry over."), or a version
 *   row loses its own past approval; a sent-back older version reads as changes asked on the newest;
 * - the page leaves the shared frame (its ground, top bar, rail, page card and versions panel), the reading line's
 *   version words leave its end, or the plan's decision comes back into the reading line or leaves the rail head
 *   (where it shows with the versions panel closed);
 * - the project leaves the rail head's quiet line or the top bar's "Spaces / project / plan", or its crumb becomes a
 *   link;
 * - the files rail loses the main page's place or mark, mixes artifacts in with pages, shows Artifacts with none,
 *   opens a row without the versions and the address following, draws an HTML artifact that can run, load or follow
 *   a link, shows a picture the server sends as a download, or forgets that it was closed;
 * - short of room the rail does not give way to the frame's sheet first (with no tab that opens nothing), then the
 *   versions to the frame's sheet;
 * - the versions panel cannot be closed, forgets that it was, or cannot be opened again from the reading line;
 * - another page's activity shows the main page's history, or an artifact's shows anything plan-wide;
 * - opening a plan through another page's link counts as reading its main page;
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
const storageModule = hasDom ? await import('@plannotator/ui/utils/storage') : null;
const { SidebarProvider } = (hasDom ? await import('../shell/sidebar') : {}) as typeof import('../shell/sidebar');
const mermaid = hasDom ? await import('@plannotator/ui/utils/mermaid') : null;
const diagramSvg = hasDom ? await import('@plannotator/ui/test-setup/diagramSvg') : null;
const { acceptPlanDiagramSvg } = (hasDom ? await import('./planContent') : {}) as typeof import('./planContent');
const { ThemeProvider } = (hasDom ? await import('@plannotator/ui/components/ThemeProvider') : {}) as typeof import('@plannotator/ui/components/ThemeProvider');
const deliver = (hasDom ? await import('./deliver') : null) as typeof import('./deliver') | null;
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
  storageModule?.resetStorageBackend();
  resetPlansForTests();
  rmSync(dir, { recursive: true, force: true });
});

const at = (day: number, hour = 9) => new Date(Date.UTC(2026, 10, day, hour)).toISOString();
const bytes = (text: string) => new TextEncoder().encode(text);

/** A plan with versions; `seen`: the person looked at that version; `root`: its project's folder. */
function plan(name: string, project: string | null, texts: string[], options: { seen?: number; approvedOn?: number; deniedOn?: number; root?: string } = {}) {
  const { plan: record, document } = store.createPlan({ name, project_name: project, project_root: options.root ?? null, created_at: at(1), document: { title: name } });
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
      <ThemeProvider>
        <SidebarProvider>
          <PlansRoute route={readRoute()} on={on} settingsKnown phone={false} />
        </SidebarProvider>
      </ThemeProvider>,
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

test.skipIf(!hasDom)('an approval of an older version never reads as current: the rail head and the reading line say the newest is not approved', async () => {
  const older = plan('Rotate refresh tokens', 'harbor-api', ['# Rotate\n\nv1\n', '# Rotate\n\nv2\n', '# Rotate\n\nv3\n', '# Rotate\n\nv4\n'], { seen: 4, approvedOn: 2 });
  const current = plan('Offline drafts', 'field-notes', ['# Offline drafts\n\nv1\n', '# Offline drafts\n\nv2\n'], { seen: 2, approvedOn: 2 });
  window.location.hash = `#plans=${older}`;
  const host = draw();
  await settle();
  expect(text(host.querySelector('[data-pages-rail-meta] [data-plan-rail-decision]'))).toBe('v4 is new and not approved');
  expect(host.querySelector('[data-plan-reading] [data-plan-decision]')).toBeNull();
  // The reading line of the newest version says why, in one line (history imported before the stored fact).
  expect(text(host.querySelector('[data-plan-reading] [data-plan-approval="cleared"]'))).toBe('v4 is new and not approved. You approved v2, and that does not carry over.');
  // The version row keeps its own approval (the frame's), without the note.
  expect(text(host.querySelector('[data-plan-version="2"] [data-version-approval]'))).toBe('Approved by you');

  window.location.hash = `#plans=${current}`;
  await settle();
  // On its newest version the decision is current: just its words.
  expect(text(host.querySelector('[data-pages-rail-meta] [data-plan-rail-decision]'))).toBe('Approved');
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
  // The top bar: Spaces / the project / the plan; the project is words, not a link.
  expect(text(shell.querySelector('[data-page-header] [data-breadcrumb-root]'))).toBe('Spaces');
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
  // The reading line: Edit at its start (approved already: no Approve), the approval of this newest version, then the
  // version words and the versions toggle (with their count) at its end; no project, no decision mark.
  const reading = host.querySelector('[data-plan-reading]')!;
  expect([...reading.querySelectorAll('[data-reading-start] button')].map(text)).toEqual(['Edit']);
  expect(text(reading.querySelector('[data-plan-approval="approved"]'))).toBe('Approved by you');
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
  // The top bar: Spaces / the plan / the page.
  expect(text(host.querySelector('[data-page-header] [data-breadcrumb-root]'))).toBe('Spaces');
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
  // A plan with no artifacts: one page, no Artifacts heading. With no project: no quiet line, Spaces / the plan.
  expect(fileNames(host.querySelector('[data-plan-files]')!)).toEqual(['Ledger import']);
  expect(host.querySelector('[data-pages-rail-meta]')).toBeNull();
  expect(host.querySelector('[data-plan-crumb-project]')).toBeNull();
  expect(text(host.querySelector('[data-page-header] a[data-plans-back]'))).toBe('Spaces');
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
    expect(toggle.getAttribute('aria-label')).toBe('v2 · newest, version 2, the newest. 2 versions');
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

test.skipIf(!hasDom)('Send opens New message to the agent live in the plan’s project (its own session first) with the comments as plan feedback; with none live it is disabled and says why', async () => {
  const quiet = plan('Rotate refresh tokens', 'ledger', ['# Rotate refresh tokens\n\nRetire keys after 14 days.\n']);
  const { plan: record, document: doc } = store.createPlan({ name: 'Rate limits', project_name: 'harbor-api', created_at: at(1), document: { title: 'Rate limits' } });
  store.addVersion(record.id, doc.id, { bytes: bytes('# Rate limits\n\nA token bucket per key.\n'), committed_at: at(2), source: 'plan-review', agent_session: 'sess-42', agent_host: 'claude-code' });
  keptStorage();
  // Two agents live in harbor-api (the plan's own session among them), one in another project, none in ledger.
  const replies = interceptInbox([
    { project: { id: 'prj_harbor', name: 'harbor-api', root: '/Users/me/harbor-api' }, sessions: [{ session: 'sess-7', host: 'codex' }, { session: 'sess-42', host: 'claude-code' }] },
    { project: { id: 'prj_other', name: 'ledger-ui', root: '/Users/me/ledger-ui' }, sessions: [{ session: 'sess-9', host: 'codex' }] },
  ]);
  const opened: unknown[] = [];
  const listen = (event: Event) => opened.push((event as CustomEvent).detail);
  window.addEventListener('plannotator-inbox:open-composer', listen);
  try {
    window.location.hash = `#plans=${quiet}`;
    let host = draw();
    await settle();
    const button = () => host.querySelector<HTMLButtonElement>('[data-plan-send-button]')!;
    // No agent live in ledger: disabled, in the Inbox's words for a project with no live agent.
    await globalComment(host, 'Shorter.');
    expect(button().disabled).toBe(true);
    expect(text(host.querySelector(`#${button().getAttribute('aria-describedby')}`))).toBe('No agent is running in ledger');
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

    // New message went: the comment is sent (an earlier comment now) and the plan has the thread it started.
    const thread = 'msg_01M7JKWTSFEGR2XJQEJ1R2GHCQ';
    await act(async () => (prefill as unknown as { onSent: (sent: object) => void }).onSent({ threadId: thread, session: 'sess-42', host: 'claude-code', projectName: 'harbor-api', draftId: null }));
    await settle();
    expect(store.get(record.id)!.thread_id).toBe(thread);
    expect(store.comments(record.id).map((c) => c.sent?.message_id)).toEqual([thread]);
    expect(button().disabled).toBe(true);
    expect(text(host.querySelector(`#${button().getAttribute('aria-describedby')}`))).toBe('0 annotations ride your next Send to Claude Code.');

    // The next Send is a reply in that thread, at once; its comment is sent with that reply.
    await globalComment(host, 'And per route.');
    await act(async () => button().click());
    await settle();
    expect(opened).toHaveLength(1);
    expect(replies.map((r) => r.path)).toEqual([`/api/inbox/messages/${thread}/reply`]);
    expect(String(replies[0]!.body.words)).toContain('And per route.');
    expect(store.comments(record.id).map((c) => c.sent?.message_id)).toEqual([thread, 'msg_reply_1']);
  } finally {
    window.removeEventListener('plannotator-inbox:open-composer', listen);
  }
});

/**
 * The Inbox's own routes for one test: the live sessions are `live` (New message's list), replies are taken
 * (`msg_reply_<n>`), the rest still go to Plans' routes.
 */
function interceptInbox(live: { project: { id: string | null; name: string; root: string }; sessions: { session: string; host: string; label?: string }[] }[] = []) {
  const seen: { path: string; body: Record<string, unknown> }[] = [];
  const plans = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://127.0.0.1');
    if (url.pathname === '/api/inbox/sessions') {
      const projects = live.map((group) => ({ project: group.project, sessions: group.sessions.map((one) => ({ started_at: at(1), last_seen_at: at(1), busy: false, idle_since: null, last_thread: null, ...one })) }));
      return Response.json({ serverSession: 's', home: '/Users/me', projects });
    }
    if (!url.pathname.startsWith('/api/inbox/')) return plans(input, init);
    seen.push({ path: url.pathname, body: JSON.parse(String(init?.body ?? '{}')) });
    return Response.json({ reply: { id: `msg_reply_${seen.length}` }, questions: [], replayed: false });
  }) as typeof fetch;
  return seen;
}

/** CodeMirror's EditorView, by the DOM back-reference EditorView.findFromDOM reads (the editor tests' way). */
function editorView(): { state: { doc: { toString(): string; length: number } }; dispatch(spec: unknown): void } {
  const content = document.querySelector<HTMLElement>('[data-plan-editor] .cm-editor .cm-content');
  if (!content) throw new Error('The plan editor did not open');
  const backRef = content as unknown as { cmTile?: { view?: ReturnType<typeof editorView> }; cmView?: { view?: ReturnType<typeof editorView> } };
  const view = backRef.cmTile?.view ?? backRef.cmView?.view;
  if (!view) throw new Error('EditorView not found from CodeMirror DOM back-reference');
  return view;
}

/** Open Edit, put `words` in place of the whole text, then press Done. */
async function editAndDone(host: Element, words: string) {
  await act(async () => host.querySelector<HTMLButtonElement>('[data-plan-edit]')!.click());
  for (let i = 0; i < 40 && !document.querySelector('[data-plan-editor] .cm-content'); i++) await settle();
  const view = editorView();
  await act(async () => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: words } }));
  await act(async () => host.querySelector<HTMLButtonElement>('[data-plan-edit-done]')!.click());
  await settle();
}

test.skipIf(!hasDom)('an Escape never leaves the plan page for the Spaces home; × still goes back to it', async () => {
  const id = plan('Rotate refresh tokens', 'harbor-api', ['# Rotate refresh tokens\n\nRetire keys after 14 days.\n']);
  keptStorage();
  window.location.hash = `#plans=${id}`;
  const host = draw();
  await settle();
  expect(host.querySelector('[data-plan-annotate]')).not.toBeNull();
  for (const target of [document.body, host.querySelector<HTMLElement>('.ib-docscroll')!]) {
    await act(async () => target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    await settle();
    expect(window.location.hash).toBe(`#plans=${id}`);
    expect(host.querySelector(`[data-plan-page="${id}"]`)).not.toBeNull();
  }
  await act(async () => host.querySelector<HTMLButtonElement>('[data-plan-annotate] button[aria-label^="Close"]')!.click());
  await settle();
  expect(window.location.hash).toBe('#plans');
});

test.skipIf(!hasDom)('Edit is on the newest version of a Markdown page only: an older version offers Restore, a diagram page no Edit', async () => {
  const id = plan('Rotate refresh tokens', 'harbor-api', ['# Rotate\n\nv1\n', '# Rotate\n\nv2\n']);
  const flow = store.addDocument(id, { title: 'Flow', kind: 'mermaid', created_at: at(3) });
  store.addVersion(id, flow.id, { bytes: bytes('flowchart LR\n  A --> B\n'), committed_at: at(3), source: 'agent-tool' });
  keptStorage();
  window.location.hash = `#plans=${id}`;
  const host = draw();
  await settle();
  expect(host.querySelector('[data-plan-reading] [data-plan-edit]')).not.toBeNull();
  window.location.hash = `#plans=${id}&v=1`;
  await settle();
  expect(readingWords(host)).toBe('v1 of 2');
  expect(host.querySelector('[data-plan-edit]')).toBeNull();
  expect(host.querySelector('[data-plan-approve]')).toBeNull();
  expect(text(host.querySelector('[data-older-version-bar] [data-plan-restore]'))).toBe('Restore v1');
  // Restore: a new newest version holding v1's words; no agent known, so the page says the agent was not told.
  await act(async () => host.querySelector<HTMLButtonElement>('[data-plan-restore]')!.click());
  await settle();
  expect(store.versions(id).map((v) => [v.version_number, v.source, v.restored_from ?? null])).toEqual([[1, 'plan-review', null], [2, 'plan-review', null], [3, 'person', 1]]);
  expect(readingWords(host)).toBe('v3 · newest');
  expect(text(host.querySelector('[data-plan-banner="saved"] p'))).toBe('Restored v1 as v3. No agent is running in harbor-api, so the agent was not told.');
  window.location.hash = `#plans=${id}&doc=${flow.id}`;
  await settle();
  expect(readingWords(host)).toBe('v1 · newest');
  expect(host.querySelector('[data-plan-edit]')).toBeNull();
});

test.skipIf(!hasDom)('Done makes a new version of the person’s words and sends the agent what changed into the plan’s thread; with no agent the page says it was not told', async () => {
  const id = plan('Rotate refresh tokens', 'harbor-api', ['# Rotate refresh tokens\n\nRetire keys after 14 days.\n']);
  keptStorage();
  window.location.hash = `#plans=${id}`;
  let host = draw();
  await settle();
  await editAndDone(host, '# Rotate refresh tokens\n\nRetire keys after 7 days.\n');
  expect(store.versions(id).map((v) => [v.version_number, v.source, v.author_via])).toEqual([[1, 'plan-review', 'plan-review'], [2, 'person', 'person']]);
  expect(new TextDecoder().decode(store.versionBytes(id, store.get(id)!.primary_doc_id, 2)!)).toBe('# Rotate refresh tokens\n\nRetire keys after 7 days.\n');
  expect(readingWords(host)).toBe('v2 · newest');
  expect(text(host.querySelector('[data-plan-document]'))).toContain('Retire keys after 7 days.');
  expect(text(host.querySelector('[data-plan-banner="saved"] p'))).toBe('Saved as v2. No agent is running in harbor-api, so the agent was not told.');
  // The version panel names the person.
  expect(text(host.querySelector('[data-plan-version="2"]'))).toContain('You');
  // Nothing changed: no version, said so.
  await act(async () => host.querySelector<HTMLButtonElement>('[data-plan-edit]')!.click());
  for (let i = 0; i < 40 && !document.querySelector('[data-plan-editor] .cm-content'); i++) await settle();
  await act(async () => host.querySelector<HTMLButtonElement>('[data-plan-edit-done]')!.click());
  await settle();
  expect(store.versions(id).length).toBe(2);
  expect(text(host.querySelector('[data-plan-banner="unchanged"] p'))).toBe('Nothing changed, so no new version was made.');

  // With the plan's thread: Done replies in it with plan review's Direct Edits.
  store.updatePlan(id, { thread_id: 'msg_01M7JKWTSFEGR2XJQEJ1R2GHCQ' });
  act(() => root!.unmount());
  unlisten();
  document.body.innerHTML = '';
  const replies = interceptInbox();
  host = draw();
  await settle();
  await editAndDone(host, '# Rotate refresh tokens\n\nRetire keys after 3 days.\n');
  expect(store.versions(id).length).toBe(3);
  expect(replies.map((r) => r.path)).toEqual(['/api/inbox/messages/msg_01M7JKWTSFEGR2XJQEJ1R2GHCQ/reply']);
  const words = String(replies[0]!.body.words);
  // v2's edit was never sent (no agent then): the diff starts at v1, the newest version the agent knows.
  expect(words.startsWith('# Direct Edits\n\nThe person edited Rotate refresh tokens.md; it is now v3, in the Plannotator Inbox. Apply these exact changes: a unified diff from v1 (the newest version you know) to v3:')).toBe(true);
  expect(words).toContain('-Retire keys after 14 days.\n+Retire keys after 3 days.');
  for (let i = 0; i < 20 && !store.get(id)!.agent_told; i++) await settle();
  expect(store.get(id)!.agent_told).toEqual({ [store.get(id)!.primary_doc_id]: 3 });
  expect(text(host.querySelector('[data-plan-banner="saved"] p'))).toBe('Saved as v3. The agent was sent what changed.');
  // The person saw v2 when the page opened; v3 is their own, so it is not "Changed since you looked".
  expect(host.querySelector('[data-plan-banner="changed"]')).toBeNull();
});

test.skipIf(!hasDom)('Done with an agent live in the plan’s project opens New message to it with what changed; once sent, the next Done replies in the plan’s thread; several live, or one known by its folder’s name only: New message asks which', async () => {
  const id = plan('Rotate refresh tokens', 'harbor-api', ['# Rotate refresh tokens\n\nRetire keys after 14 days.\n'], { root: '/Users/me/harbor-api' });
  const several = plan('Rate limits', 'ledger', ['# Rate limits\n\nA bucket.\n']);
  // Imported from plan history: only the folder's name is known, and the one agent live is in another folder of that name.
  const named = plan('Cache keys', 'trailhead-api', ['# Cache keys\n\nPer tenant.\n']);
  keptStorage();
  const replies = interceptInbox([
    { project: { id: null, name: 'harbor-api', root: '/Users/me/harbor-api' }, sessions: [{ session: 'sess-7', host: 'codex' }] },
    { project: { id: null, name: 'ledger', root: '/Users/me/ledger' }, sessions: [{ session: 'sess-1', host: 'codex' }, { session: 'sess-2', host: 'claude-code' }] },
    { project: { id: null, name: 'trailhead-api', root: '/Users/me/oss/trailhead-api' }, sessions: [{ session: 'sess-3', host: 'codex' }] },
  ]);
  const opened: { to: unknown; body: string; onSent: (sent: object) => void }[] = [];
  const listen = (event: Event) => opened.push((event as CustomEvent).detail);
  window.addEventListener('plannotator-inbox:open-composer', listen);
  try {
    window.location.hash = `#plans=${id}`;
    let host = draw();
    await settle();
    await editAndDone(host, '# Rotate refresh tokens\n\nRetire keys after 7 days.\n');
    expect(opened.map((o) => o.to)).toEqual([{ session: 'sess-7' }]);
    expect(opened[0]!.body).toContain('-Retire keys after 14 days.\n+Retire keys after 7 days.');
    expect(text(host.querySelector('[data-plan-banner="saved"] p'))).toBe('Saved as v2. What changed is in New message to Codex: send it there.');
    // The person sends it: the plan has the thread, and the agent knows v2.
    await act(async () => opened[0]!.onSent({ threadId: 'msg_01M7JKWTSFEGR2XJQEJ1R2GHCQ', session: 'sess-7', host: 'codex', projectName: 'harbor-api', draftId: null }));
    await settle();
    expect(store.get(id)!.thread_id).toBe('msg_01M7JKWTSFEGR2XJQEJ1R2GHCQ');
    expect(store.get(id)!.agent_told).toEqual({ [store.get(id)!.primary_doc_id]: 2 });
    await editAndDone(host, '# Rotate refresh tokens\n\nRetire keys after 3 days.\n');
    expect(opened).toHaveLength(1);
    expect(replies.map((r) => r.path)).toEqual(['/api/inbox/messages/msg_01M7JKWTSFEGR2XJQEJ1R2GHCQ/reply']);
    expect(String(replies[0]!.body.words)).toContain('-Retire keys after 7 days.\n+Retire keys after 3 days.');
    expect(text(host.querySelector('[data-plan-banner="saved"] p'))).toBe('Saved as v3. The agent was sent what changed.');

    // Two agents live in ledger, neither the plan's: New message opens on its To list.
    act(() => root!.unmount());
    unlisten();
    document.body.innerHTML = '';
    window.location.hash = `#plans=${several}`;
    host = draw();
    await settle();
    await editAndDone(host, '# Rate limits\n\nTwo buckets.\n');
    expect(opened.map((o) => o.to)).toEqual([{ session: 'sess-7' }, 'pick']);
    expect(text(host.querySelector('[data-plan-banner="saved"] p'))).toBe('Saved as v2. What changed is in New message: choose the agent there.');

    // One agent live, but matched by the folder's name only: never chosen for the person; the To list shows its folder.
    act(() => root!.unmount());
    unlisten();
    document.body.innerHTML = '';
    window.location.hash = `#plans=${named}`;
    host = draw();
    await settle();
    await editAndDone(host, '# Cache keys\n\nPer tenant and route.\n');
    expect(opened.map((o) => o.to)).toEqual([{ session: 'sess-7' }, 'pick', 'pick']);
    expect(text(host.querySelector('[data-plan-banner="saved"] p'))).toBe('Saved as v2. What changed is in New message: choose the agent there.');
  } finally {
    window.removeEventListener('plannotator-inbox:open-composer', listen);
  }
});

test.skipIf(!hasDom)('an open edit and a kept text outlive another page and a reload of the plan page; Done untouched on a CRLF page makes no version', async () => {
  const id = plan('Rotate refresh tokens', 'harbor-api', ['# Rotate refresh tokens\r\n\r\nRetire keys after 14 days.\r\n']);
  const notes = store.addDocument(id, { title: 'Notes', kind: 'markdown', created_at: at(3) });
  store.addVersion(id, notes.id, { bytes: bytes('# Notes\n\none\n'), committed_at: at(3), source: 'plan-review' });
  keptStorage();
  window.location.hash = `#plans=${id}`;
  let host = draw();
  await settle();
  // CRLF: opened and Done untouched is no version (the editor gives the lines back with `\n`).
  await act(async () => host.querySelector<HTMLButtonElement>('[data-plan-edit]')!.click());
  for (let i = 0; i < 40 && !document.querySelector('[data-plan-editor] .cm-content'); i++) await settle();
  await act(async () => host.querySelector<HTMLButtonElement>('[data-plan-edit-done]')!.click());
  await settle();
  expect(store.versions(id).length).toBe(1);
  expect(text(host.querySelector('[data-plan-banner="unchanged"] p'))).toBe('Nothing changed, so no new version was made.');
  // An open edit, then another page: back on the plan's page, the editor is open with the person's words.
  await act(async () => host.querySelector<HTMLButtonElement>('[data-plan-edit]')!.click());
  for (let i = 0; i < 40 && !document.querySelector('[data-plan-editor] .cm-content'); i++) await settle();
  const view = editorView();
  await act(async () => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '# Mine\n\nNot saved yet.\n' } }));
  window.location.hash = `#plans=${id}&doc=${notes.id}`;
  await settle();
  expect(document.querySelector('[data-plan-editor]')).toBeNull();
  window.location.hash = `#plans=${id}`;
  await settle();
  for (let i = 0; i < 40 && !document.querySelector('[data-plan-editor] .cm-content'); i++) await settle();
  expect(editorView().state.doc.toString()).toBe('# Mine\n\nNot saved yet.\n');
  // The agent writes v2 meanwhile; Done keeps the text, and a reload of the page still holds it.
  store.addVersion(id, store.get(id)!.primary_doc_id, { bytes: bytes('# Rotate refresh tokens\n\nv2 by the agent\n'), committed_at: at(9), source: 'plan-review' });
  await act(async () => host.querySelector<HTMLButtonElement>('[data-plan-edit-done]')!.click());
  await settle();
  expect(host.querySelector('[data-plan-banner="stale"]')).not.toBeNull();
  act(() => root!.unmount());
  unlisten();
  document.body.innerHTML = '';
  host = draw();
  await settle();
  expect(text(host.querySelector('[data-plan-banner="stale"] p'))).toBe('v2 came while you were editing, so your edit was not saved. Your text is kept here.');
  await act(async () => host.querySelector<HTMLButtonElement>('[data-plan-kept-edit]')!.click());
  for (let i = 0; i < 40 && !document.querySelector('[data-plan-editor] .cm-content'); i++) await settle();
  expect(editorView().state.doc.toString()).toBe('# Mine\n\nNot saved yet.\n');
  // Discarded or saved, it is gone: Cancel here, and a reload shows no editor and no kept text.
  await act(async () => host.querySelector<HTMLButtonElement>('[data-plan-edit-cancel]')!.click());
  act(() => root!.unmount());
  unlisten();
  document.body.innerHTML = '';
  host = draw();
  await settle();
  expect(document.querySelector('[data-plan-editor]')).toBeNull();
  expect(host.querySelector('[data-plan-banner="stale"]')).toBeNull();
});

test.skipIf(!hasDom)('typing is kept a moment after it pauses, and at once when the editor loses focus or the page is hidden', async () => {
  const id = plan('Rotate refresh tokens', 'harbor-api', ['# Rotate refresh tokens\n\nRetire keys after 14 days.\n']);
  keptStorage();
  window.location.hash = `#plans=${id}`;
  const host = draw();
  await settle();
  await act(async () => host.querySelector<HTMLButtonElement>('[data-plan-edit]')!.click());
  for (let i = 0; i < 40 && !document.querySelector('[data-plan-editor] .cm-content'); i++) await settle();
  const key = `plannotator-inbox-plan-edit-${id}-${store.get(id)!.primary_doc_id}`;
  const keptText = () => (JSON.parse(window.sessionStorage.getItem(key) ?? 'null') as { text: string } | null)?.text;
  const type = (words: string) => act(async () => editorView().dispatch({ changes: { from: 0, to: editorView().state.doc.length, insert: words } }));
  await type('# One\n');
  // Not on every keystroke.
  expect(keptText()).toBe('# Rotate refresh tokens\n\nRetire keys after 14 days.\n');
  await act(async () => document.querySelector('[data-plan-editor] .cm-content')!.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
  expect(keptText()).toBe('# One\n');
  await type('# Two\n');
  await act(async () => window.dispatchEvent(new Event('pagehide')));
  expect(keptText()).toBe('# Two\n');
  await type('# Three\n');
  await act(async () => await new Promise((r) => setTimeout(r, 450)));
  expect(keptText()).toBe('# Three\n');
});

test.skipIf(!hasDom)('the agent a plan’s words go to: its own session, else the one matched by the project’s id or folder; matched by the folder’s name only, New message asks', () => {
  const session = (id: string) => ({ session: id, host: 'codex', started_at: at(1), last_seen_at: at(1), busy: false, idle_since: null, last_thread: null });
  const model = (projects: { id: string | null; name: string; root: string; sessions: string[] }[]) => ({ serverSession: 's', home: '/Users/me', projects: projects.map(({ sessions, ...project }) => ({ project, sessions: sessions.map(session) })) }) as unknown as Parameters<typeof import('./deliver').planAgentOf>[2];
  const id = plan('Cache keys', 'trailhead-api', ['# Cache keys\n']);
  const record = (change: object) => ({ ...store.get(id)!, ...change });
  const versions = store.versions(id);
  const kind = (change: object, projects: Parameters<typeof model>[0]) => {
    const agent = deliver!.planAgentOf(record(change), versions, model(projects));
    return agent.kind === 'session' ? agent.session : agent.kind;
  };
  const work = { id: 'prj_work', name: 'trailhead-api · work', root: '/Users/me/work/trailhead-api', sessions: ['sess-w'] };
  const oss = { id: null, name: 'trailhead-api', root: '/Users/me/oss/trailhead-api', sessions: ['sess-o'] };
  expect(kind({ project_id: 'prj_work' }, [work, oss])).toBe('sess-w');
  expect(kind({ project_root: '/Users/me/oss/trailhead-api' }, [work, oss])).toBe('sess-o');
  // The name only: one folder of that name live, or two: never chosen for the person.
  expect(kind({}, [oss])).toBe('pick');
  expect(kind({}, [work, oss])).toBe('pick');
  expect(kind({}, [])).toBe('none');
  // The plan's own session is that agent, whatever its folder is called.
  const own = plan('Own', 'trailhead-api', []);
  store.addVersion(own, store.get(own)!.primary_doc_id, { bytes: bytes('# Own\n'), committed_at: at(2), source: 'plan-review', agent_session: 'sess-o', agent_host: 'codex' });
  expect(deliver!.planAgentOf(store.get(own)!, store.versions(own), model([work, oss]))).toMatchObject({ kind: 'session', session: 'sess-o' });
});

test.skipIf(!hasDom)('a reply that went is never said to have failed when recording it does: the record is tried again, then kept for the next plan page; one key per Send; a held Send is recorded once its outbox entry was delivered, never when refused', async () => {
  const id = plan('Rotate refresh tokens', 'harbor-api', ['# Rotate refresh tokens\n\nRetire keys after 14 days.\n']);
  store.updatePlan(id, { thread_id: 'msg_01M7JKWTSFEGR2XJQEJ1R2GHCQ' });
  const kept = keptStorage();
  const replies = interceptInbox();
  // The first record of the Send fails (the Inbox was busy); the reply had gone.
  const inner = globalThis.fetch;
  let failures = 1;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith('/sent') && failures-- > 0) return Response.json({ error: 'busy' }, { status: 503 });
    return inner(input, init);
  }) as typeof fetch;
  let told = 0;
  const how = await deliver!.deliverToPlanAgent({ plan: store.get(id)!, agent: { kind: 'thread', thread: 'msg_01M7JKWTSFEGR2XJQEJ1R2GHCQ', label: 'the agent' }, words: '# Direct Edits\n\nx', comments: [], told: { doc: store.get(id)!.primary_doc_id, version: 1 }, onSent: () => told++ });
  expect(how).toBe('replied');
  for (let i = 0; i < 30 && told === 0; i++) await new Promise((r) => setTimeout(r, 100));
  expect(told).toBe(1);
  expect(store.get(id)!.agent_told).toEqual({ [store.get(id)!.primary_doc_id]: 1 });
  // The same Send tried again is the same reply: the Inbox answers it once.
  const thread = { kind: 'thread', thread: 'msg_01M7JKWTSFEGR2XJQEJ1R2GHCQ', label: 'the agent' } as const;
  const doc = store.get(id)!.primary_doc_id;
  await deliver!.deliverToPlanAgent({ plan: store.get(id)!, agent: thread, words: '# Direct Edits\n\nx', comments: [], told: { doc, version: 1 }, onSent: () => {} });
  expect(new Set(replies.map((r) => r.body.idempotency_key)).size).toBe(1);
  // The same words carrying other comments, or telling of no version, are a new Send: never taken for the old one.
  await deliver!.deliverToPlanAgent({ plan: store.get(id)!, agent: thread, words: '# Direct Edits\n\nx', comments: ['ann_1'], told: { doc, version: 1 }, onSent: () => {} });
  await deliver!.deliverToPlanAgent({ plan: store.get(id)!, agent: thread, words: '# Direct Edits\n\nx', comments: [], told: null, onSent: () => {} });
  expect(new Set(replies.map((r) => r.body.idempotency_key)).size).toBe(3);

  // Every try failed (the Inbox down for the whole wait): the record waits in localStorage (never the cookie), and the
  // next plan page records it.
  deliver!.setPlanSentRetryWaitsForTests([0, 5]);
  const KEY = deliver!.PLAN_SENT_QUEUE_KEY;
  let refuse: number | null = 503;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith('/sent') && refuse !== null) return Response.json({ error: 'refused', code: refuse === 409 ? 'server_session_mismatch' : 'busy' }, { status: refuse });
    return inner(input, init);
  }) as typeof fetch;
  const queued = () => (JSON.parse(localStorage.getItem(KEY) ?? '[]') as { id: string }[]).map((q) => q.id);
  try {
    const other = plan('Rate limits', 'harbor-api', ['# Rate limits\n\nA bucket.\n', '# Rate limits\n\nTwo.\n']);
    store.updatePlan(other, { thread_id: 'msg_01M7JKWTSFEGR2XJQEJ1R2GHCZ' });
    const otherDoc = store.get(other)!.primary_doc_id;
    await deliver!.deliverToPlanAgent({ plan: store.get(other)!, agent: { ...thread, thread: 'msg_01M7JKWTSFEGR2XJQEJ1R2GHCZ' }, words: '# Direct Edits\n\ny', comments: [], told: { doc: otherDoc, version: 2 }, onSent: () => {} });
    for (let i = 0; i < 20 && !localStorage.getItem(KEY); i++) await new Promise((r) => setTimeout(r, 10));
    expect(queued()).toEqual([other]);
    expect(kept.has(KEY)).toBe(false);
    expect(store.get(other)!.agent_told).toBeUndefined();
    // The Inbox restarted under the tab (409, another server session): it stays queued.
    refuse = 409;
    expect(await deliver!.flushQueuedPlanSent()).toBe(0);
    expect(queued()).toEqual([other]);
    // An older build kept its queue in the cookie: moved once, the cookie cleared. A record refused for good (400: not
    // a record; 404: its plan is gone) is dropped; the rest lands when a plan page opens.
    kept.set(KEY, JSON.stringify([{ id: other, body: { bogus: true } }, { id: 'pln_01M7JKWTSFEGR2XJQEJ1R2GHZZ', body: { thread_id: null, message_id: 'msg_x', to: null, comments: [], told: null } }]));
    refuse = null;
    window.location.hash = `#plans=${other}`;
    draw();
    for (let i = 0; i < 20 && !store.get(other)!.agent_told; i++) await settle();
    expect(store.get(other)!.agent_told).toEqual({ [otherDoc]: 2 });
    for (let i = 0; i < 20 && localStorage.getItem(KEY); i++) await settle();
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(kept.has(KEY)).toBe(false);
  } finally {
    localStorage.removeItem(KEY);
    deliver!.setPlanSentRetryWaitsForTests(null);
  }

  // Held for another machine: recorded once the entry left the waiting list with no notice.
  const waiting = new Set(['k-delivered', 'k-refused']);
  const notices: { key: string }[] = [];
  const look = async () => ({ waiting: [...waiting].map((key) => ({ key })), notices }) as unknown as Awaited<ReturnType<typeof import('../api').inboxApi.outbox>>;
  const went: string[] = [];
  deliver!.whenHeldDelivered('k-delivered', () => went.push('k-delivered'), look, 10);
  deliver!.whenHeldDelivered('k-refused', () => went.push('k-refused'), look, 10);
  await new Promise((r) => setTimeout(r, 40));
  expect(went).toEqual([]);
  waiting.clear();
  notices.push({ key: 'k-refused' });
  await new Promise((r) => setTimeout(r, 60));
  expect(went).toEqual(['k-delivered']);
});

test.skipIf(!hasDom)('a newer version that came while editing: nothing is saved, the newest shows, and the person’s text is kept to edit again; one banner carries Show changes', async () => {
  const id = plan('Rotate refresh tokens', 'harbor-api', ['# Rotate refresh tokens\n\nv1\n'], { seen: 1 });
  keptStorage();
  window.location.hash = `#plans=${id}`;
  const host = draw();
  await settle();
  await act(async () => host.querySelector<HTMLButtonElement>('[data-plan-edit]')!.click());
  for (let i = 0; i < 40 && !document.querySelector('[data-plan-editor] .cm-content'); i++) await settle();
  const view = editorView();
  await act(async () => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '# Mine\n\nMy words.\n' } }));
  // The agent writes v2 meanwhile.
  store.addVersion(id, store.get(id)!.primary_doc_id, { bytes: bytes('# Rotate refresh tokens\n\nv2 by the agent\n'), committed_at: at(9), source: 'plan-review', agent_name: 'Claude Code' });
  await act(async () => host.querySelector<HTMLButtonElement>('[data-plan-edit-done]')!.click());
  await settle();
  expect(store.versions(id).length).toBe(2);
  expect(readingWords(host)).toBe('v2 · newest');
  expect(text(host.querySelector('[data-plan-document]'))).toContain('v2 by the agent');
  expect(text(host.querySelector('[data-plan-banner="stale"] p'))).toBe('v2 came while you were editing, so your edit was not saved. Your text is kept here.');
  // The person saw v1, but the kept text's banner is the one about v2: no "Changed since you looked" beside it; its own Show changes compares what they edited with v2.
  expect(host.querySelector('[data-plan-banner="changed"]')).toBeNull();
  expect([...host.querySelectorAll('[data-plan-show-changes]')].map((b) => [text(b), b.closest('[data-plan-banner]')?.getAttribute('data-plan-banner')])).toEqual([['Show changes', 'stale']]);
  // Authors: the agent's name where the library has it; a version with none has no author line, never "No name recorded".
  expect(text(host.querySelector('[data-version-row][data-version="2"] [data-version-author]'))).toBe('Claude Code');
  expect(text(host.querySelector('[data-version-row][data-version="1"] [data-version-author]'))).toBe('');
  expect(text(host.querySelector('[data-versions-panel]'))).not.toContain('No name recorded');
  await act(async () => host.querySelector<HTMLButtonElement>('[data-plan-show-changes]')!.click());
  await settle();
  expect(window.location.hash).toBe(`#plans=${id}&from=1&to=2`);
  expect(host.querySelector('[data-plan-banner="stale"]')).not.toBeNull();
  expect(host.querySelector('[data-plan-show-changes]')).toBeNull();
  // Edit v2 with your text: the editor opens on the person's words, on the newest.
  await act(async () => host.querySelector<HTMLButtonElement>('[data-plan-kept-edit]')!.click());
  for (let i = 0; i < 40 && !document.querySelector('[data-plan-editor] .cm-content'); i++) await settle();
  expect(editorView().state.doc.toString()).toBe('# Mine\n\nMy words.\n');
  await act(async () => host.querySelector<HTMLButtonElement>('[data-plan-edit-done]')!.click());
  await settle();
  expect(store.versions(id).map((v) => v.version_number)).toEqual([1, 2, 3]);
  expect(new TextDecoder().decode(store.versionBytes(id, store.get(id)!.primary_doc_id, 3)!)).toBe('# Mine\n\nMy words.\n');
});

test.skipIf(!hasDom)('approving names the version on screen: refused once the plan moved on (the newest shows); the person’s own edit moves the approval, said once', async () => {
  const id = plan('Rotate refresh tokens', 'harbor-api', ['# Rotate refresh tokens\n\nv1\n']);
  const kept = keptStorage();
  window.location.hash = `#plans=${id}`;
  const host = draw();
  await settle();
  // The agent writes v2 behind the page's back: Approve of v1 is refused, and v2 shows.
  store.addVersion(id, store.get(id)!.primary_doc_id, { bytes: bytes('# Rotate refresh tokens\n\nv2\n'), committed_at: at(9), source: 'plan-review' });
  await act(async () => host.querySelector<HTMLButtonElement>('[data-plan-approve]')!.click());
  await settle();
  expect(store.events(id).filter((e) => e.kind === 'decision')).toEqual([]);
  expect(text(host.querySelector('[data-plan-banner="refused"] p'))).toBe('The plan moved on: v2 is newer than the version you had.');
  expect(readingWords(host)).toBe('v2 · newest');
  await act(async () => host.querySelector<HTMLButtonElement>('[data-plan-approve]')!.click());
  await settle();
  expect(text(host.querySelector('[data-plan-reading] [data-plan-approval="approved"]'))).toBe('Approved by you');
  expect(host.querySelector('[data-plan-approve]')).toBeNull();
  expect(text(host.querySelector('[data-pages-rail-meta] [data-plan-rail-decision]'))).toBe('Approved');
  // The person's own edit: the approval moves, and the line says so until its Dismiss.
  await editAndDone(host, '# Rotate refresh tokens\n\nv2, tightened\n');
  expect(text(host.querySelector('[data-plan-reading] [data-plan-approval="moved"]'))).toBe('Your approval moved to v3.');
  await act(async () => host.querySelector<HTMLButtonElement>('[data-plan-approval-dismiss]')!.click());
  expect(text(host.querySelector('[data-plan-reading] [data-plan-approval="approved"]'))).toBe('Approved by you');
  expect([...kept.values()]).toContain('3');
  // An agent's version clears it, in the stored fact's words.
  store.addVersion(id, store.get(id)!.primary_doc_id, { bytes: bytes('# Rotate refresh tokens\n\nv4\n'), committed_at: at(10), source: 'plan-review', agent_session: 's-1' });
  window.location.hash = '#plans';
  await settle();
  window.location.hash = `#plans=${id}`;
  await settle();
  expect(text(host.querySelector('[data-plan-reading] [data-plan-approval="cleared"]'))).toBe('v4 is new and not approved. You approved v3, and that does not carry over.');
  expect(text(host.querySelector('[data-plan-version="3"] [data-version-approval]'))).toBe('Approved by you');
});

test.skipIf(!hasDom)('only the main page counts as looking: a link to another page of a never-opened plan leaves it unread on the home', async () => {
  const id = plan('Rotate refresh tokens', 'harbor-api', ['# Rotate\n\nv1\n', '# Rotate\n\nv2\n', '# Rotate\n\nv3\n']);
  const notes = store.addDocument(id, { title: 'Notes', created_at: at(3) });
  store.addVersion(id, notes.id, { bytes: bytes('# Notes\n'), committed_at: at(3), source: 'agent-tool' });
  window.location.hash = `#plans=${id}&doc=${notes.id}`;
  const host = draw();
  await settle();
  expect(readingWords(host)).toBe('v1 · newest');
  // That page's versions are remembered; the plan's main page is still unread, so the home keeps its dot.
  expect(store.looks().plans[id]?.docs[notes.id]).toBe(1);
  expect(store.list()[0]).toMatchObject({ seen_version_number: null, changed: false });
  resetPlansForTests(null, true);
  window.location.hash = '#plans';
  await settle();
  expect(host.querySelector(`[data-space="${id}"]`)).not.toBeNull();
  expect(host.querySelector(`[data-space="${id}"] [data-frame-card-dot]`)).not.toBeNull();
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
  const note = host.querySelector('[data-spaces-home] [data-plans-import-error]')!;
  expect(note.getAttribute('title')).toBe('disk says no');
  expect(retries).toBe(0);
  await act(async () => (note.querySelector('button') as HTMLButtonElement).click());
  await settle();
  expect(retries).toBe(1);
  expect(host.querySelector('[data-plans-import-error]')).toBeNull();
  expect(host.querySelector('[data-space]')).not.toBeNull();
});

test.skipIf(!hasDom)('an empty library shows the get-started screen, whose action says how a plan arrives', async () => {
  window.location.hash = '#plans';
  const host = draw();
  await settle();
  expect(host.querySelector('[data-plans-start]')).not.toBeNull();
  expect(host.querySelector('[data-spaces-home]')).toBeNull();
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
  expect(host.querySelector('[data-spaces-home], [data-plans-start], [data-plan-page]')).toBeNull();
  expect(text(host)).toBe('');
  expect(reads).toBe(0);
});
