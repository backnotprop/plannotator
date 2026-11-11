/**
 * Export decisions in the thread's ⋯ More (design brief "export-decisions", 2026-11-10), on the real ThreadMore.
 *
 * What regresses: the item showing on a thread with no question cards (most threads; action items are not questions),
 * or missing on one that has them; leaving its place right after Add a pull request…, or hiding when the thread has no linked PR to add from; a download that is not a plain link to
 * the thread's own route (relative, so it works over the tailnet or a tunnel; through the forward for a linked
 * machine's thread); the phone sheet not swapping to its sub-view and back. Post decisions (step 2): the "Post on a
 * pull request" group missing where posting is offered, or shown where it is not (another machine's thread);
 * a row that posts on another PR than its own; with no PR, Add a pull request… not leading to the add-then-post.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxThread } from '@plannotator/core/inbox-types';
import { rememberMachine, resetMachineRoutes } from './inboxUrl';
import { inboxThreadPullWire, parseInboxThreadPullRef } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
const { ThreadMore } = (hasDom ? await import('./components/CopyMenus') : {}) as typeof import('./components/CopyMenus');

let root: Root | null = null;
let host: HTMLElement | null = null;

let savedFetch: typeof fetch | null = null;
let postToSaves: string[] = [];
/** The thread's PRs as the Inbox answers them, while a test stubs fetch. */
function stubPulls(refs: string[]) {
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === '/api/inbox/settings/decisions-post') {
      if (init?.method === 'POST') postToSaves.push(JSON.parse(String(init.body)).post_to);
      return Response.json({ post_to: init?.method === 'POST' ? postToSaves.at(-1) : 'description' });
    }
    const pulls = refs.map((ref) => {
      const parsed = parseInboxThreadPullRef(ref) as { key: string; url: string };
      return inboxThreadPullWire({ id: `${THREAD_ID}:${parsed.key}`, project_id: 'prj_1', thread_id: THREAD_ID, pull: parsed.key, url: parsed.url, added_by: { kind: 'person' }, added_at: '2026-11-10T10:00:00.000Z', state: 'open', title: null, base: null, head: null, read_at: null });
    });
    expect(String(input)).toBe(`/api/inbox/threads/${THREAD_ID}/pulls`);
    return Response.json({ pulls, groups: [{ kind: 'related', pulls: pulls.map((p) => p.pull) }], removed: [] });
  }) as typeof fetch;
}

afterEach(() => {
  if (!hasDom) return;
  if (savedFetch) globalThis.fetch = savedFetch;
  savedFetch = null;
  postToSaves = [];
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  document.body.innerHTML = '';
  resetMachineRoutes();
});

const THREAD_ID = 'msg_01M62DTT05NJ59ZR4AJCDJ70XK';
const MACHINE = 'ibx_01M62DTW6WCYD3ZH6Z17MFMA8G';

function thread(kinds: ('single' | 'action')[]): InboxThread {
  return {
    thread_id: THREAD_ID,
    subject: 'Offline sync',
    project: { id: 'prj_1', name: 'notes' },
    messages: [{ id: THREAD_ID, questions: kinds.map((kind, i) => ({ key: `q-${i}`, kind })) }],
  } as unknown as InboxThread;
}

function frame(children: ReactNode) {
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(children);
  });
}

async function press(target: HTMLElement) {
  await act(async () => {
    target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }));
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerType: 'mouse' }));
    target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
    target.click();
  });
}

const wait = (ms: number) => act(() => new Promise((resolve) => setTimeout(resolve, ms)));
async function until(done: () => boolean, what: string) {
  const end = Date.now() + 2_000;
  while (!done() && Date.now() < end) await wait(10);
  if (!done()) throw new Error(`never: ${what}`);
}

async function openMore() {
  await press(document.querySelector<HTMLElement>('[data-thread-more]')!);
  await until(() => !!document.querySelector('[data-thread-menu]'), 'the ⋯ menu');
  return document.querySelector<HTMLElement>('[data-thread-menu]')!;
}

/** The submenu opens from its item by key (ArrowRight), as Base UI's menus do; happy-dom has no hover. */
async function openExportSubmenu(menu: HTMLElement) {
  const item = menu.querySelector<HTMLElement>('[data-thread-export-item]')!;
  await act(async () => {
    item.focus();
    item.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  });
  await until(() => !!document.querySelector('[data-thread-export-menu]'), 'the submenu');
  return document.querySelector<HTMLElement>('[data-thread-export-menu]')!;
}

const itemKeys = (menu: HTMLElement) =>
  [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((el) => (el.hasAttribute('data-thread-export-item') ? 'export' : el.hasAttribute('data-thread-add-pull-item') ? 'add-pull' : (el.getAttribute('data-copy-item') ?? '?')));

function expectDownload(link: HTMLAnchorElement, format: 'md' | 'html', prefix = '/api/inbox') {
  expect(link.tagName).toBe('A');
  expect(link.hasAttribute('download')).toBe(true);
  const href = link.getAttribute('href')!;
  // Relative: the window's own origin, whatever address it was opened at.
  expect(href.startsWith(`${prefix}/threads/${THREAD_ID}/decisions?`)).toBe(true);
  const query = new URLSearchParams(href.split('?')[1]);
  expect(query.get('format')).toBe(format);
  expect(query.get('tz')).toBeTruthy();
}

describe.skipIf(!hasDom)('Export decisions in ⋯ More', () => {
  test('hidden on a thread with no question cards, and on one with only action items', async () => {
    for (const kinds of [[], ['action']] as ('single' | 'action')[][]) {
      frame(<ThreadMore thread={thread(kinds)} linkOf={() => ''} phone={false} />);
      const menu = await openMore();
      expect(menu.querySelector('[data-thread-export-item]')).toBeNull();
      act(() => root?.unmount());
      host?.remove();
    }
  });

  test('desktop: right after Add a pull request…, a submenu of two plain download links, and no Post group where posting is not offered', async () => {
    frame(<ThreadMore thread={thread(['single', 'action'])} linkOf={() => ''} phone={false} addPull={() => {}} />);
    const menu = await openMore();
    const keys = itemKeys(menu);
    expect(keys[keys.indexOf('add-pull') + 1]).toBe('export');
    const sub = await openExportSubmenu(menu);
    const links = [...sub.querySelectorAll<HTMLAnchorElement>('[data-decision-export]')];
    expect(links.map((l) => l.getAttribute('data-decision-export'))).toEqual(['md', 'html']);
    expectDownload(links[0]!, 'md');
    expectDownload(links[1]!, 'html');
    // Posting not offered (no postDecisions: another machine's thread): the two downloads only.
    expect(sub.querySelectorAll('[role="menuitem"]').length).toBe(2);
  });

  test('Post on a pull request: one row per PR on the thread, each posting on its own PR', async () => {
    stubPulls(['acme/notes#12', 'group/app!45']);
    const posted: string[] = [];
    frame(<ThreadMore thread={thread(['single'])} linkOf={() => ''} phone={false} addPull={() => {}} postDecisions={{ post: (ref) => posted.push(ref), addPullThenPost: () => posted.push('add') }} />);
    const sub = await openExportSubmenu(await openMore());
    await until(() => !!sub.querySelector('[data-decision-post]'), 'the PR rows');
    expect(sub.querySelector('.ib-pm-glabel')!.textContent).toBe('Post on a pull request');
    const rows = [...sub.querySelectorAll<HTMLElement>('[data-decision-post]')];
    expect(rows.map((r) => r.textContent)).toEqual(['acme/notes#12', 'group/app!45']);
    expect(sub.querySelector('[data-decision-post-add]')).toBeNull();
    await press(rows[1]!);
    expect(posted).toEqual(['group/app!45']);
  });

  test('Where to post: the stored choice is checked (the description by default), and a pick saves it without closing the menu', async () => {
    stubPulls(['acme/notes#12']);
    frame(<ThreadMore thread={thread(['single'])} linkOf={() => ''} phone={false} postDecisions={{ post: () => {}, addPullThenPost: () => {} }} />);
    const sub = await openExportSubmenu(await openMore());
    await until(() => !!sub.querySelector('[data-decision-post-to]'), 'Where to post');
    const choices = () => [...sub.querySelectorAll<HTMLElement>('[data-decision-post-to]')].map((el) => [el.getAttribute('data-decision-post-to'), el.getAttribute('aria-checked')]);
    expect(choices()).toEqual([
      ['description', 'true'],
      ['comment', 'false'],
      ['both', 'false'],
    ]);
    await press(sub.querySelector<HTMLElement>('[data-decision-post-to="comment"]')!);
    await until(() => postToSaves.length === 1, 'the save');
    expect(postToSaves).toEqual(['comment']);
    expect(choices()[1]).toEqual(['comment', 'true']);
    expect(document.querySelector('[data-thread-export-menu]')).not.toBeNull();
    // One group with the PR rows (the owner: "should be a part of the PR section"): no divider between them.
    const group = sub.querySelector('[data-decision-post="acme/notes#12"]')!.closest('[role="group"]')!;
    expect(group.contains(sub.querySelector('[data-decision-post-to="both"]'))).toBe(true);
    const between = [...group.querySelectorAll('[role="separator"]')];
    expect(between).toEqual([]);
  });

  test('Post on a pull request with none linked: Add a pull request… starts the add-then-post', async () => {
    stubPulls([]);
    const posted: string[] = [];
    frame(<ThreadMore thread={thread(['single'])} linkOf={() => ''} phone={false} addPull={() => {}} postDecisions={{ post: (ref) => posted.push(ref), addPullThenPost: () => posted.push('add') }} />);
    const sub = await openExportSubmenu(await openMore());
    await until(() => !!sub.querySelector('[data-decision-post-add]'), 'Add a pull request…');
    expect(sub.querySelector('[data-decision-post]')).toBeNull();
    await press(sub.querySelector<HTMLElement>('[data-decision-post-add]')!);
    expect(posted).toEqual(['add']);
  });

  test('phone: the sub-view carries the Post group under the downloads', async () => {
    stubPulls(['acme/notes#12']);
    frame(<ThreadMore thread={thread(['single'])} linkOf={() => ''} phone postDecisions={{ post: () => {}, addPullThenPost: () => {} }} />);
    const menu = await openMore();
    await press(menu.querySelector<HTMLElement>('[data-thread-export-item]')!);
    await until(() => !!menu.querySelector('[data-decision-post="acme/notes#12"]'), 'the PR row in the sheet');
    const order = [...menu.querySelectorAll('[data-decision-export], [data-decision-post]')].map((el) => el.getAttribute('data-decision-export') ?? el.getAttribute('data-decision-post'));
    expect(order).toEqual(['md', 'html', 'acme/notes#12']);
  });

  test('shown without Add a pull request… too (no PR offered): in its own group after Copy thread ID', async () => {
    frame(<ThreadMore thread={thread(['single'])} linkOf={() => ''} phone={false} />);
    const menu = await openMore();
    const keys = itemKeys(menu);
    expect(keys.slice(keys.indexOf('thread-id') + 1)).toEqual(['export']);
  });

  test("a linked machine's thread downloads through this Inbox's forward to that machine", async () => {
    rememberMachine([THREAD_ID], MACHINE);
    frame(<ThreadMore thread={thread(['single'])} linkOf={() => ''} phone={false} />);
    const menu = await openMore();
    await openExportSubmenu(menu);
    expectDownload(document.querySelector<HTMLAnchorElement>('[data-decision-export="md"]')!, 'md', `/api/inbox/m/${MACHINE}`);
  });

  test('phone: the sheet swaps to "‹ Export decisions" with the two downloads, and back', async () => {
    frame(<ThreadMore thread={thread(['single'])} linkOf={() => ''} phone />);
    const menu = await openMore();
    await press(menu.querySelector<HTMLElement>('[data-thread-export-item]')!);
    await until(() => !!menu.querySelector('[data-decision-export-back]'), 'the sub-view');
    expect(menu.querySelector('[data-copy-item="thread"]')).toBeNull();
    const links = [...menu.querySelectorAll<HTMLAnchorElement>('[data-decision-export]')];
    expect(links.length).toBe(2);
    expectDownload(links[0]!, 'md');
    await press(menu.querySelector<HTMLElement>('[data-decision-export-back]')!);
    await until(() => !!menu.querySelector('[data-copy-item="thread"]'), 'the sheet again');
    expect(menu.querySelector('[data-decision-export]')).toBeNull();
  });
});
