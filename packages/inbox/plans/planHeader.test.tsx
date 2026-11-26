/**
 * The plan page's header (approval "inbox-plan-page-header-a3", PlanChrome.tsx), drawn from a real plan library
 * answered by the real route handler (as plansPage.test.tsx). What regresses if these fail:
 * - a phone shows the plan's name more than once at rest, or stacks a second row under its bar: the bar holds the
 *   project and, at its end, Approve (when offered), the decision's mark and the clock; the document's own title is
 *   the first thing under it, and the bar takes the name only once that title is out of view (from the start when the
 *   document's first block is not a level-1 heading with the plan's name); an older version, a comparison or the
 *   editor say so in that one bar (Back to version N and Restore move to the menu);
 * - the file-name row or the chips row comes back, or what they held is lost: the phone's menu holds Edit, Global
 *   comment, Files (with the count), Contents, Copy file, Download and Close, in that order, and each does its thing;
 * - the tools, the comments and Send leave the one bottom bar, Send loses its name, or the phone's Send line is
 *   shown (its words stay Send's description);
 * - an approval state loses its decision's mark (named with the state's words) or its Approve, or the approval's words
 *   come back into the bar;
 * - a computer's bar (approval A2) loses its decision's mark, its pencil (Edit), its history clock (Versions, its
 *   version in its name and tooltip, expanded while Versions is open) or the menu at its end (Copy file, Download, Full
 *   screen), shows words on the newest version's left, or offers the pencil on an older version (one line, its way
 *   back and Restore); the pencil stops starting an edit, or does not wait while an edit is opening; the bottom bar
 *   loses Global comment, or a saved global comment opens again anywhere but on it;
 * - a menu row acts with the handlers of the moment the menu opened (a new version may have come since);
 * - Share shows while its switch is off;
 * - the phone's bar opens on the plan's name and fades to the project (it must open on the project, cut);
 * - the phone's menu is drawn outside the Inbox's root (its icons and lines lose their rules), or Copy file gives no
 *   sign it copied;
 * - a computer's narrow card loses its way to Contents (its own button: the computer's menu has no Contents).
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
import { PLAN_COPIED_MS, planMenuItems, titleAway, type PlanDocActs, type PlanMenuEntry } from './PlanChrome';

const hasDom = typeof document !== 'undefined';
const { PlansRoute } = (hasDom ? await import('./PlansPage') : {}) as typeof import('./PlansPage');
const { readRoute } = (hasDom ? await import('../app/route') : {}) as typeof import('../app/route');
const { resetPlansForTests } = (hasDom ? await import('./store') : {}) as typeof import('./store');
const storageModule = hasDom ? await import('@plannotator/ui/utils/storage') : null;
const { SidebarProvider } = (hasDom ? await import('../shell/sidebar') : {}) as typeof import('../shell/sidebar');
const { ThemeProvider } = (hasDom ? await import('@plannotator/ui/components/ThemeProvider') : {}) as typeof import('@plannotator/ui/components/ThemeProvider');

let root: Root | null = null;
let unlisten = () => {};
let dir = '';
let store: PlanStore;
const realFetch = globalThis.fetch;
const realMatchMedia = hasDom ? window.matchMedia : undefined;
const realWidth = hasDom ? window.innerWidth : 0;
const realRect = hasDom ? HTMLElement.prototype.getBoundingClientRect : undefined;
const realFrame = hasDom ? window.requestAnimationFrame : undefined;

beforeEach(() => {
  if (!hasDom) return;
  dir = mkdtempSync(join(tmpdir(), 'plan-header-'));
  store = createPlanStore({ dataDir: dir });
  resetPlansForTests(null, true);
  window.history.replaceState(null, '', '/');
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
  // Frames run at once, so the scroll follow and the menu's pick land inside `act`.
  window.requestAnimationFrame = ((cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number) as typeof window.requestAnimationFrame;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://127.0.0.1');
    const answer = await handlePlanRoute(
      { method: init?.method ?? 'GET', pathname: url.pathname, params: url.searchParams, json: async () => JSON.parse(String(init?.body ?? '{}')) },
      { store, importError: () => null },
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
  window.requestAnimationFrame = realFrame!;
  HTMLElement.prototype.getBoundingClientRect = realRect!;
  Object.defineProperty(window, 'innerWidth', { value: realWidth, configurable: true, writable: true });
  storageModule?.resetStorageBackend();
  resetPlansForTests();
  rmSync(dir, { recursive: true, force: true });
});

const at = (day: number, hour = 9) => new Date(Date.UTC(2026, 10, day, hour)).toISOString();
const bytes = (text: string) => new TextEncoder().encode(text);
const text = (el: Element | null) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

/** A plan with versions; `approvedOn` / `deniedOn`: the person's decision on that version. */
function plan(name: string, project: string | null, texts: string[], options: { approvedOn?: number; deniedOn?: number } = {}) {
  const { plan: record, document } = store.createPlan({ name, project_name: project, project_root: null, created_at: at(1), document: { title: name } });
  texts.forEach((t, i) => store.addVersion(record.id, document.id, { bytes: bytes(t), committed_at: at(2 + i), source: 'plan-review', author_via: 'plan-review' }));
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
  return record.id;
}

async function settle() {
  for (let i = 0; i < 8; i++) await act(async () => await new Promise((r) => setTimeout(r, 5)));
}

/** The page as App draws it; `phone`: a 393 px phone window. */
function draw(phone: boolean) {
  Object.defineProperty(window, 'innerWidth', { value: phone ? 393 : 1440, configurable: true, writable: true });
  const host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  root = createRoot(host);
  const render = () =>
    act(() =>
      root!.render(
        <ThemeProvider>
          <SidebarProvider>
            <PlansRoute route={readRoute()} on settingsKnown phone={phone} />
          </SidebarProvider>
        </ThemeProvider>,
      ),
    );
  window.addEventListener('hashchange', render);
  unlisten = () => window.removeEventListener('hashchange', render);
  render();
  return host;
}

/** The document's title in view (`titleBottom` below the scroll's top edge at 100) or scrolled away. */
function placeTitle(titleBottom: number) {
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    if (this.classList.contains('ib-docscroll')) return new DOMRect(0, 100, 393, 700);
    if (this.tagName === 'H1') return new DOMRect(16, titleBottom - 40, 360, 40);
    return realRect!.call(this);
  };
}

const menuRows = () => [...document.querySelectorAll('[data-plan-menu] [data-plan-menu-row]')].map((row) => row.getAttribute('data-plan-menu-row'));
async function openMenu(host: Element) {
  await act(async () => host.querySelector<HTMLButtonElement>('nav [data-plan-more]')!.click());
  await settle();
}
async function pick(key: string) {
  await act(async () => document.querySelector<HTMLElement>(`[data-plan-menu] [data-plan-menu-row="${key}"]`)!.click());
  await settle();
}

const DOC = '# Rate limiting for public endpoints\n\n## Context\n\nNo limit today.\n\n## Approach\n\nA token bucket.\n';

test.skipIf(!hasDom)('a phone: the bar holds the project at rest and takes the plan’s name once the document’s title scrolls away; the name shows once', async () => {
  const id = plan('Rate limiting for public endpoints', 'trailhead-api', [DOC], { approvedOn: 1 });
  placeTitle(260);
  window.location.hash = `#plans=${id}`;
  // Whether the bar ever showed the plan's name while the page opened (the name must not flash in, then fade out).
  let flashed = false;
  const watch = new MutationObserver(() => void (flashed ||= document.querySelector('[data-plan-bartitle][data-away]') !== null));
  watch.observe(document.body, { subtree: true, childList: true, attributes: true });
  const host = draw(true);
  await settle();
  watch.disconnect();
  expect(flashed).toBe(false);
  const page = host.querySelector('[data-plan-page]')!;
  const bar = host.querySelector('[data-plan-bartitle]')!;
  expect(page.getAttribute('data-plan-header')).toBe('project');
  expect(bar.hasAttribute('data-away')).toBe(false);
  // The cross-fade is on only once the first measurement is in.
  expect(bar.hasAttribute('data-settled')).toBe(true);
  expect(text(bar.querySelector('[data-plan-bartitle-rest]'))).toBe('trailhead-api');
  // The title block is out of reach at rest (inert), so the name is read once: in the document.
  expect(bar.querySelector('[data-plan-titleblock]')!.hasAttribute('inert')).toBe(true);
  expect(host.querySelector('nav [data-breadcrumb-collapse]')).toBeNull();
  // One bar: at its end the decision's mark (named with the approval's words) and the history clock (approval A2: no
  // version text; the version is in the clock's name). Nothing above the document's own title, no pinned line.
  const marks = host.querySelector('nav [data-plan-topmarks]')!;
  expect([...marks.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'))).toEqual(['Approved by you', 'Versions · v1, newest']);
  expect(marks.querySelector('[data-plan-decision-mark="approved"]')).not.toBeNull();
  expect(host.querySelector('.ib-docscroll [data-plan-kicker]')).toBeNull();
  expect(host.querySelector('.ib-docscroll [data-block-id]')!.tagName).toBe('H1');
  expect(host.querySelector('[data-reading-line]')).toBeNull();
  expect(host.querySelector('.ib-vhead')).toBeNull();

  // The title scrolls away: the bar takes the plan's name (no version text, no decision words), one button that opens Versions.
  placeTitle(60);
  await act(async () => host.querySelector('.ib-docscroll')!.dispatchEvent(new Event('scroll')));
  await settle();
  expect(page.getAttribute('data-plan-header')).toBe('name');
  const block = bar.querySelector<HTMLButtonElement>('[data-plan-titleblock]')!;
  expect(block.hasAttribute('inert')).toBe(false);
  expect(block.getAttribute('aria-label')).toBe('Rate limiting for public endpoints. Version 1. Versions');
  expect(text(block)).toBe('Rate limiting for public endpoints');
  await act(async () => block.click());
  await settle();
  expect(document.querySelector('[data-versions-panel]')).not.toBeNull();
});

test.skipIf(!hasDom)('a phone: a document whose first block is not the plan’s title has the plan’s name in the bar from the start', async () => {
  const id = plan('Rate limiting for public endpoints', 'trailhead-api', ['## Context\n\nNo limit today.\n']);
  placeTitle(260);
  window.location.hash = `#plans=${id}`;
  const host = draw(true);
  await settle();
  expect(host.querySelector('[data-plan-page]')!.getAttribute('data-plan-header')).toBe('name');
  expect(host.querySelector('[data-plan-bartitle]')!.hasAttribute('data-away')).toBe(true);
});

test.skipIf(!hasDom)('a phone: tools, comments and Send are one bar at the bottom; Send is its mark, its line its description', async () => {
  const id = plan('Rate limiting for public endpoints', 'trailhead-api', [DOC]);
  placeTitle(260);
  window.location.hash = `#plans=${id}`;
  const host = draw(true);
  await settle();
  const dock = host.querySelector('[data-plan-dock]')!;
  // The five tools, as marks: no word shows (each keeps its name as its accessible name).
  const tools = [...dock.querySelectorAll<HTMLElement>('.ib-toolstrip button')];
  expect(tools.length).toBeGreaterThanOrEqual(5);
  expect(tools.every((b) => b.querySelector<HTMLElement>(':scope > span')!.style.opacity === '0' && text(b) !== '')).toBe(true);
  expect(host.querySelector('[data-plan-annotate] section .ib-toolstrip')).toBeNull();
  // The comments button sits beside Send, in the bar.
  expect(dock.querySelector('[data-annotations-sheet]')).not.toBeNull();
  const send = dock.querySelector<HTMLButtonElement>('[data-plan-send-button]')!;
  expect(send.getAttribute('aria-label')).toBe('Send');
  expect(text(send)).toBe('');
  expect(send.disabled).toBe(true);
  const line = host.querySelector(`#${send.getAttribute('aria-describedby')}`)!;
  expect(line.getAttribute('data-plan-send-line')).toBe('described');
  expect(text(line)).toBe('No agent is running in trailhead-api');
  // Share is off unless its switch is on.
  expect(host.querySelector('[data-plan-share]')).toBeNull();
});

test.skipIf(!hasDom)('a phone’s menu holds what the file-name row and the chips held, in order, and each row does its thing', async () => {
  const id = plan('Rate limiting for public endpoints', 'trailhead-api', [DOC]);
  const doc = store.addDocument(id, { title: 'Load test notes', kind: 'markdown', created_at: at(3) });
  store.addVersion(id, doc.id, { bytes: bytes('# Load test notes\n'), committed_at: at(3), source: 'agent-tool' });
  placeTitle(260);
  const copied: string[] = [];
  const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t: string) => void copied.push(t) } });
  try {
    window.location.hash = `#plans=${id}`;
    const host = draw(true);
    await settle();
    // No Files button of its own in the bar: Files is in the menu.
    expect(host.querySelector('nav button[aria-label="Show files"]')).toBeNull();
    await openMenu(host);
    expect(menuRows()).toEqual(['edit', 'global', 'files', 'contents', 'copy', 'download', 'close']);
    expect(document.querySelectorAll('[data-plan-menu] .ib-sheet-line').length).toBe(3);
    expect(text(document.querySelector('[data-plan-menu-row="files"] .ib-plan-menu-end'))).toBe('2');
    expect(document.querySelector('[data-plan-menu-row="download"]')!.getAttribute('href')).toBe(`/api/plans/${id}/versions/1`);
    expect(document.querySelector('[data-plan-menu]')!.getAttribute('aria-label')).toBe('Page actions');
    // Drawn inside the Inbox's root, where its icons' and lines' rules apply.
    expect(document.querySelector('[data-plan-menu]')!.closest('.pn-inbox')).toBe(host);

    // Copy file: the row says it copied, as the Viewer's own Copy does, then the menu closes.
    await pick('copy');
    expect(copied).toEqual([DOC]);
    expect(text(document.querySelector('[data-plan-menu-row="copy"]'))).toBe('Copied!');
    expect(document.querySelector('[data-plan-menu-row="copy"]')!.hasAttribute('data-copied')).toBe(true);
    await act(async () => await new Promise((r) => setTimeout(r, PLAN_COPIED_MS + 50)));
    await settle();
    expect(host.querySelector('nav [data-plan-more]')!.getAttribute('aria-expanded')).toBe('false');

    await openMenu(host);
    await pick('global');
    expect(document.querySelector('[data-comment-popover] textarea')).not.toBeNull();
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    await settle();

    await openMenu(host);
    await pick('files');
    expect(document.querySelector('[data-plan-sidebar="compact"]')).not.toBeNull();
    expect(text(document.querySelector('[data-plan-sidebar="compact"]'))).toContain('Load test notes');
    // A phone has no crumbs: its files sheet keeps its own back row.
    expect(document.querySelector('[data-plan-sidebar="compact"] [data-pages-back-link]')!.getAttribute('aria-label')).toBe('Back to Rate limiting for public endpoints');
    expect(host.querySelector('[data-plan-crumb-back]')).toBeNull();
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    await settle();

    await openMenu(host);
    await pick('contents');
    expect(document.querySelector('[data-contents="sheet"]')).not.toBeNull();
    await act(async () => document.querySelector<HTMLButtonElement>('[data-contents="sheet"] button[aria-label="Close contents"]')!.click());
    await settle();

    // Edit opens the editor; Done and Cancel are the one bar's, no line pinned under it.
    await openMenu(host);
    await pick('edit');
    expect(host.querySelector('nav [data-plan-topmarks] [data-plan-edit-done]')).not.toBeNull();
    expect(host.querySelector('[data-reading-line]')).toBeNull();
    // They take the room of the mark and the clock (a 320 px bar holds no more); the clock is a row of "…".
    expect(host.querySelector('nav [data-plan-decision-mark]')).toBeNull();
    expect(host.querySelector('nav [data-reading-versions]')).toBeNull();
    await openMenu(host);
    await pick('versions');
    expect(document.querySelector('[data-versions-panel]')).not.toBeNull();
    await act(async () => host.querySelector<HTMLButtonElement>('[data-plan-edit-cancel]')!.click());
    await settle();
    expect(host.querySelector('nav [data-plan-decision-mark]')).not.toBeNull();

    await openMenu(host);
    await pick('close');
    expect(window.location.hash).toBe('#plans');
  } finally {
    if (clipboard) Object.defineProperty(navigator, 'clipboard', clipboard);
    else delete (navigator as { clipboard?: unknown }).clipboard;
  }
});

test.skipIf(!hasDom)('a phone: every approval state keeps its mark and its Approve in the one bar; an older version says so there, its way back and Restore in the menu', async () => {
  const two = ['# Rate limiting for public endpoints\n\nv1\n', '# Rate limiting for public endpoints\n\nv2\n'];
  // Changes asked on the newest: Approve and the decision's mark are at the bar's end.
  const denied = plan('Rate limiting for public endpoints', 'trailhead-api', two, { deniedOn: 2 });
  placeTitle(260);
  window.location.hash = `#plans=${denied}`;
  let host = draw(true);
  await settle();
  const marks = () => host.querySelector('nav [data-plan-topmarks]')!;
  expect(marks().querySelector('[data-plan-approve]')).not.toBeNull();
  expect(marks().querySelector('[data-plan-decision-mark="changes"]')!.getAttribute('aria-label')).toBe('Changes asked');
  expect(marks().querySelector('[data-plan-edit]')).toBeNull();
  // An approval of an older version never reads as current: the mark says the newest is not approved.
  act(() => root?.unmount());
  const cleared = plan('Rate limiting for public endpoints', 'trailhead-api', two, { approvedOn: 1 });
  window.location.hash = `#plans=${cleared}`;
  host = draw(true);
  await settle();
  expect(marks().querySelector('[data-plan-decision-mark="none"]')!.getAttribute('aria-label')).toBe('v2 is new and not approved. You approved v1, and that does not carry over.');
  expect(marks().querySelector('[data-plan-approve]')).not.toBeNull();
  // An older version: the bar says so in the name's place, the mark and the clock stay; nothing pinned under the bar.
  window.location.hash = `#plans=${cleared}&v=1`;
  await settle();
  expect(host.querySelector('[data-reading-line]')).toBeNull();
  expect(text(host.querySelector('nav [data-plan-barline]'))).toBe('v1 of 2, an older version');
  expect([...marks().querySelectorAll('button')].map((b) => b.getAttribute('aria-label'))).toEqual(['v2 is new and not approved. You approved v1, and that does not carry over.', 'Versions']);
  await openMenu(host);
  expect(menuRows().slice(0, 2)).toEqual(['newest', 'restore']);
  expect(text(document.querySelector('[data-plan-menu-row="newest"]'))).toBe('Back to version 2');
  expect(text(document.querySelector('[data-plan-menu-row="restore"]'))).toBe('Restore v1');
  await pick('newest');
  expect(window.location.hash).toBe(`#plans=${cleared}`);
  expect(host.querySelector('nav [data-plan-barline]')).toBeNull();
});

test.skipIf(!hasDom)('a computer: the pinned bar holds the approval, the pencil, the history clock and the menu; no version text on the newest; an older version is one line with no pencil; Global comment is a mark in the bottom bar', async () => {
  const id = plan('Rate limiting for public endpoints', 'trailhead-api', [DOC, DOC.replace('A token bucket.', 'A token bucket per key.')], { approvedOn: 2 });
  window.location.hash = `#plans=${id}`;
  const host = draw(false);
  await settle();
  const reading = host.querySelector('[data-plan-reading]')!;
  const bar = reading.querySelector('[data-plan-bar="newest"]')!;
  // Nothing on the left: the decision is the first mark at the end, named with the approval's words.
  expect([...bar.querySelectorAll('.ib-plan-bar-end button')].map((b) => b.getAttribute('aria-label'))).toEqual(['Approved by you', 'Edit', 'Versions · v2, newest', 'Page actions']);
  expect(text(bar)).toBe('');
  expect(bar.querySelector('.ib-plan-bar-start')!.childElementCount).toBe(0);
  // Versions is closed until the clock opens it; then the clock reads expanded and the panel marks the version.
  const clock = () => reading.querySelector<HTMLButtonElement>('[data-reading-versions]')!;
  expect(clock().getAttribute('aria-expanded')).toBe('false');
  expect(clock().hasAttribute('aria-pressed')).toBe(false);
  expect(host.querySelector('[data-versions-panel]')).toBeNull();
  await act(async () => clock().click());
  await settle();
  expect(clock().getAttribute('aria-expanded')).toBe('true');
  expect(host.querySelector('[data-versions-panel] [data-plan-version="2"]')!.getAttribute('aria-current')).toBe('true');
  // The pencil starts an edit: Done and Cancel take the bar's left; no pencil while editing.
  await act(async () => reading.querySelector<HTMLButtonElement>('[data-plan-edit]')!.click());
  await settle();
  expect(reading.querySelector('[data-plan-edit-done]')).not.toBeNull();
  expect(reading.querySelector('[data-plan-edit]')).toBeNull();
  await act(async () => reading.querySelector<HTMLButtonElement>('[data-plan-edit-cancel]')!.click());
  await settle();
  // An older version: one line, its way back and Restore; the clock stays; no pencil.
  window.location.hash = `#plans=${id}&v=1`;
  await settle();
  const older = host.querySelector('[data-plan-reading] [data-plan-bar="older"]')!;
  expect(text(older.querySelector('[data-plan-older-words]'))).toBe('v1 of 2, an older version');
  expect(text(older.querySelector('[data-plan-newest]'))).toBe('Back to version 2');
  expect(text(older.querySelector('[data-plan-restore]'))).toBe('Restore v1');
  expect(older.querySelector('[data-plan-edit]')).toBeNull();
  expect(older.querySelector('[data-reading-versions]')!.getAttribute('aria-label')).toBe('Versions');
  // The newest version's decision still shows on an older one.
  expect(older.querySelector('[data-plan-decision-mark="approved"]')!.getAttribute('aria-label')).toBe('Approved by you');
  window.location.hash = `#plans=${id}`;
  await settle();
  expect(host.querySelector('[data-plan-kicker]')).toBeNull();
  expect(host.querySelector('.ib-vhead')).toBeNull();
  const dock = host.querySelector('[data-plan-dock]')!;
  expect(dock.querySelector('[data-plan-global]')!.getAttribute('aria-label')).toBe('Global comment');
  // The tools keep their words on a computer (the chosen ones show theirs).
  expect([...dock.querySelectorAll<HTMLElement>('.ib-toolstrip button')].some((b) => b.querySelector<HTMLElement>(':scope > span')!.style.opacity === '1')).toBe(true);
  expect(text(dock.querySelector('[data-plan-send-button]'))).toBe('Send');
  // The top bar is unchanged: Spaces / the project / the plan.
  expect(host.querySelector('[data-plan-bartitle]')).toBeNull();
});

test.skipIf(!hasDom)('a computer whose card has no room for the Contents rail keeps its own Contents button, which opens the sheet', async () => {
  const id = plan('Rate limiting for public endpoints', 'trailhead-api', [DOC]);
  window.location.hash = `#plans=${id}`;
  const host = draw(false);
  // The rail is not drawn here (no layout): the button turns to the sheet once the rail's wait is over.
  await act(async () => await new Promise((r) => setTimeout(r, 2600)));
  await settle();
  const open = host.querySelector<HTMLButtonElement>('[data-plan-annotate] [data-contents-open]');
  expect(open).not.toBeNull();
  await act(async () => open!.click());
  await settle();
  expect(document.querySelector('[data-contents="sheet"]')).not.toBeNull();
});

test.skipIf(!hasDom)('the title is not known while the document has no block yet', () => {
  const scroll = document.createElement('div');
  expect(titleAway(scroll, 'A plan')).toBeNull();
  scroll.innerHTML = '<h2 data-block-id="b1">Context</h2>';
  expect(titleAway(scroll, 'A plan')).toBe(true);
});

test('the menu’s rows: a phone’s groups in their order, a computer’s three; a row with nothing behind it is left out', () => {
  const pane = { current: null };
  const acts: PlanDocActs = { older: null, edit: () => {}, versions: null, pane, contents: null, download: { href: '/v/1', name: 'a.md' }, full: () => {} };
  const keys = (rows: PlanMenuEntry[]) => rows.map((r) => (r === '-' ? '-' : r.key));
  expect(keys(planMenuItems({ phone: true, acts, files: { count: 7, open: () => {} }, close: () => {} }))).toEqual(['edit', 'global', '-', 'files', '-', 'copy', 'download', '-', 'close']);
  expect(keys(planMenuItems({ phone: false, acts, files: null, close: () => {} }))).toEqual(['copy', 'download', 'full']);
  // An artifact on a phone: Files and Close only.
  expect(keys(planMenuItems({ phone: true, acts: null, files: { count: 3, open: () => {} }, close: () => {} }))).toEqual(['files', '-', 'close']);
  expect(planMenuItems({ phone: false, acts: null, files: null, close: () => {} })).toEqual([]);
  // An older version on a phone: its way back and its Restore come first; a computer keeps them in its bar.
  const older: PlanDocActs = { ...acts, edit: null, older: { head: 4, shown: 2, back: () => {}, restore: () => {} } };
  expect(keys(planMenuItems({ phone: true, acts: older, files: null, close: () => {} })).slice(0, 3)).toEqual(['newest', 'restore', '-']);
  expect(keys(planMenuItems({ phone: false, acts: older, files: null, close: () => {} }))).toEqual(['copy', 'download', 'full']);
  // A phone while editing: Done and Cancel take the bar's room, so Versions is the menu's first row.
  const editing: PlanDocActs = { ...acts, edit: null, versions: () => {} };
  expect(keys(planMenuItems({ phone: true, acts: editing, files: null, close: () => {} })).slice(0, 3)).toEqual(['versions', '-', 'global']);
});

test.skipIf(!hasDom)('a computer: the pencil waits while the edit opens, as Edit did', async () => {
  const id = plan('Rate limiting for public endpoints', 'trailhead-api', [DOC]);
  window.location.hash = `#plans=${id}`;
  const host = draw(false);
  await settle();
  let release = () => {};
  const held = new Promise<void>((r) => (release = r));
  const fetching = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (/\/versions\/1$/.test(new URL(String(input), 'http://127.0.0.1').pathname)) await held;
    return fetching(input, init);
  }) as typeof fetch;
  const pencil = () => host.querySelector<HTMLButtonElement>('[data-plan-reading] [data-plan-edit]');
  await act(async () => pencil()!.click());
  await settle();
  expect(pencil()!.disabled).toBe(true);
  release();
  await settle();
  expect(host.querySelector('[data-plan-reading] [data-plan-edit-done]')).not.toBeNull();
});

test.skipIf(!hasDom)('a computer: a global comment being written opens again on the bottom bar’s Global comment, not on the Viewer’s hidden button', async () => {
  const id = plan('Rate limiting for public endpoints', 'trailhead-api', [DOC, DOC.replace('A token bucket.', 'A token bucket per key.')]);
  window.location.hash = `#plans=${id}`;
  const host = draw(false);
  await settle();
  await act(async () => host.querySelector<HTMLButtonElement>('[data-plan-dock] [data-plan-global]')!.click());
  await settle();
  const box = () => document.querySelector<HTMLTextAreaElement>('[data-comment-popover] textarea');
  expect(box()).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box()!, 'Keep the old limit for admins');
    box()!.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
  // Another version and back: the pane keeps the words, then opens them again where the person can see them.
  window.location.hash = `#plans=${id}&v=1`;
  await settle();
  const measured = new Set<Element>();
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    measured.add(this);
    return realRect!.call(this);
  };
  window.location.hash = `#plans=${id}`;
  await settle();
  expect(box()?.value).toBe('Keep the old limit for admins');
  expect(measured.has(host.querySelector('[data-plan-dock] [data-plan-global]')!)).toBe(true);
  const hidden = [...host.querySelectorAll('[data-sticky-actions] button')];
  expect(hidden.some((b) => measured.has(b))).toBe(false);
});
