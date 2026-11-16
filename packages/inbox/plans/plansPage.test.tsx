/**
 * The window's Plans page, drawn from a real plan library: a scratch `plan-library/` written with the store
 * (packages/shared/plans/store.ts), answered by the real route handler (packages/shared/plans/routes.ts) in place of
 * the Inbox, so what the page shows is what the library holds. No server, no Inbox. What regresses if these fail:
 * - the list leaves out a plan, loses "changed since you looked" or the number of new versions, or shows a decision
 *   the plan's record does not hold;
 * - an empty library does not show the get-started screen, or its action does not say how a plan arrives;
 * - a plan's page does not show the newest version's text, the versions newest first, the version you saw, or the
 *   "changed since you looked" banner; opening it does not record the look;
 * - a decision on an older version reads as current in the list or the page line (it must say "changed since");
 * - the compact list leaves out a plan or orders it differently, loses a column, is not a link, is not remembered,
 *   or search and the empty search stop working in it;
 * - picking a version in the rail does not show that version;
 * - the diff does not compare the two versions with the plan diff engine;
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
const { SidebarProvider } = (hasDom ? await import('../shell/sidebar') : {}) as typeof import('../shell/sidebar');
const mermaid = hasDom ? await import('@plannotator/ui/utils/mermaid') : null;
const diagramSvg = hasDom ? await import('@plannotator/ui/test-setup/diagramSvg') : null;
const { acceptPlanDiagramSvg } = (hasDom ? await import('./planContent') : {}) as typeof import('./planContent');

let root: Root | null = null;
let unlisten = () => {};
let dir = '';
let store: PlanStore;
/** The server's failed import, as the list reports it; a `?retry=1` read counts in `retries` and (here) succeeds. */
let importError: string | null = null;
let retries = 0;
const realFetch = globalThis.fetch;

beforeEach(() => {
  if (!hasDom) return;
  dir = mkdtempSync(join(tmpdir(), 'plans-page-'));
  store = createPlanStore({ dataDir: dir });
  resetPlansForTests(null, true);
  importError = null;
  retries = 0;
  window.history.replaceState(null, '', '/');
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
  localStorage.removeItem(PLANS_VIEW_KEY);
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

test.skipIf(!hasDom)('a decision on an older version never reads as current: the list and the page line say it changed since', async () => {
  const older = plan('Rotate refresh tokens', 'harbor-api', ['# Rotate\n\nv1\n', '# Rotate\n\nv2\n', '# Rotate\n\nv3\n', '# Rotate\n\nv4\n'], { seen: 4, approvedOn: 2 });
  const current = plan('Offline drafts', 'field-notes', ['# Offline drafts\n\nv1\n', '# Offline drafts\n\nv2\n'], { seen: 2, approvedOn: 2 });
  window.location.hash = '#plans';
  const host = draw();
  await settle();
  expect(text(host.querySelector(`[data-plan-row="${older}"] [data-plan-decision]`))).toBe('Approved on v2 · changed since');
  expect(text(host.querySelector(`[data-plan-row="${current}"] [data-plan-decision]`))).toBe('Approved');

  window.location.hash = `#plans=${older}`;
  await settle();
  expect(text(host.querySelector('.ib-plan-line [data-plan-decision]'))).toBe('Approved on v2 · changed since');
  // The version row keeps its own mark, without the note.
  expect(text(host.querySelector('[data-plan-version="2"] .ib-plan-vdec'))).toBe('Approved');

  window.location.hash = `#plans=${current}`;
  await settle();
  expect(text(host.querySelector('.ib-plan-line [data-plan-decision]'))).toBe('Approved on v2');
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

  expect(text(host.querySelector('[data-plan-reading]'))).toBe('Reading v3 · newest');
  expect(text(host.querySelector('[data-plan-document]'))).toContain('three keys now');
  expect([...host.querySelectorAll('[data-plan-version]')].map((b) => b.getAttribute('data-plan-version'))).toEqual(['3', '2', '1']);
  expect(host.querySelector('[data-plan-version="1"] [data-plan-seen]')).not.toBeNull();
  expect(host.querySelector('[data-plan-version="3"]')?.getAttribute('aria-current')).toBe('true');
  // Changed since you looked: you saw v1, and Show changes is offered.
  expect(text(host.querySelector('[data-plan-banner="changed"]'))).toContain('You saw v1');
  // Opening it is seeing v3: the next list read says it is no longer changed.
  expect(store.looks().plans[id]?.docs[store.get(id)!.primary_doc_id]).toBe(3);

  act(() => host.querySelector<HTMLButtonElement>('[data-plan-version="2"]')!.click());
  await settle();
  expect(window.location.hash).toBe(`#plans=${id}&v=2`);
  expect(text(host.querySelector('[data-plan-reading]'))).toBe('Reading v2 of 3');
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
  expect(text(host.querySelector('[data-plan-reading]'))).toBe('Comparing v1 with v2');
  expect(text(host.querySelector('[data-plan-banner="diff"]'))).toContain('the one you saw');
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
