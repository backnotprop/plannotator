/**
 * Export decisions in the thread's ⋯ More (design brief "export-decisions", 2026-11-10), on the real ThreadMore.
 *
 * What regresses: the item showing on a thread with no question cards (most threads; action items are not questions),
 * or missing on one that has them; leaving its place right after Copy thread; a download that is not a plain link to
 * the thread's own route (relative, so it works over the tailnet or a tunnel; through the forward for a linked
 * machine's thread); anything about pull requests in the menu (not in this version); the phone sheet not swapping to
 * its sub-view and back.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxThread } from '@plannotator/core/inbox-types';
import { rememberMachine, resetMachineRoutes } from './inboxUrl';

const hasDom = typeof document !== 'undefined';
const { ThreadMore } = (hasDom ? await import('./components/CopyMenus') : {}) as typeof import('./components/CopyMenus');

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  if (!hasDom) return;
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
  [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((el) => (el.hasAttribute('data-thread-export-item') ? 'export' : (el.getAttribute('data-copy-item') ?? '?')));

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

  test('desktop: right after Copy thread, a submenu of two plain download links, nothing about pull requests', async () => {
    frame(<ThreadMore thread={thread(['single', 'action'])} linkOf={() => ''} phone={false} addPull={() => {}} />);
    const menu = await openMore();
    const keys = itemKeys(menu);
    expect(keys[keys.indexOf('thread') + 1]).toBe('export');
    const sub = await openExportSubmenu(menu);
    const links = [...sub.querySelectorAll<HTMLAnchorElement>('[data-decision-export]')];
    expect(links.map((l) => l.getAttribute('data-decision-export'))).toEqual(['md', 'html']);
    expectDownload(links[0]!, 'md');
    expectDownload(links[1]!, 'html');
    // No PR posting in this version: the submenu holds the two downloads only.
    expect(sub.querySelectorAll('[role="menuitem"]').length).toBe(2);
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
