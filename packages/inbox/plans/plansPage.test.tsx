/**
 * The window's Plans page, drawn from a real plan library: a scratch `plan-library/` written with the store
 * (packages/shared/plans/store.ts), answered by the real route handler (packages/shared/plans/routes.ts) in place of
 * the Inbox, so what the page shows is what the library holds. No server, no Inbox. What regresses if these fail:
 * - the list leaves out a plan, loses "changed since you looked" or the number of new versions, or shows a decision
 *   the plan's record does not hold;
 * - an empty library does not show the get-started screen, or its action does not say how a plan arrives;
 * - a plan's page does not show the newest version's text, the versions newest first, the version you saw, or the
 *   "changed since you looked" banner; opening it does not record the look;
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
const { SidebarProvider } = (hasDom ? await import('../shell/sidebar') : {}) as typeof import('../shell/sidebar');

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
