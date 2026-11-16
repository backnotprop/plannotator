/**
 * "Open in" for a file of a thread on another linked machine
 * (docs/agent-guides/inbox-machines.md: Open in stays on this computer). The
 * file is on that machine's disk: this computer's editors, Default app and
 * Finder cannot open it, Copy path would copy that machine's path, and that
 * machine's door has no new-tab page. So none of them is offered: the pane's
 * header keeps only what works (an image's new tab, as a plain button; nothing
 * for a page), and a tile's ⋯ keeps Open side by side / full screen and
 * Download. This computer's own file keeps its whole list.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAttachmentState } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
const { OpenInControl } = (hasDom ? await import('./components/OpenIn') : {}) as typeof import('./components/OpenIn');
const { AttachmentTiles } = (hasDom ? await import('./components/AttachmentTiles') : {}) as typeof import('./components/AttachmentTiles');
const { rememberMachine, resetMachineRoutes, setSelfMachine } = (hasDom ? await import('./inboxUrl') : {}) as typeof import('./inboxUrl');

const SELF = 'ibx_01K7SSSSSSSSSSSSSSSSSSSSSS';
const OTHER = 'ibx_01K7MMMMMMMMMMMMMMMMMMMMMM';

function file(id: string, name: string, kind: string, extra: Partial<InboxAttachmentState> = {}): InboxAttachmentState {
  return {
    id,
    name,
    path: `/work/shop/${name}`,
    kind: kind as InboxAttachmentState['kind'],
    named_path: null,
    sent_sha256: 'a'.repeat(64),
    size: 1000,
    sent_at: '2026-10-10T10:42:00.000Z',
    sent_mtime: '2026-10-10T10:42:00.000Z',
    message_id: 'msg_01K7M1MMMMMMMMMMMMMMMMMMMM',
    changed_since_sent: false,
    unavailable: null,
    current: { sha256: 'a'.repeat(64), size: 1000, mtime: '2026-10-10T10:42:00.000Z' },
    ...extra,
  };
}

/** This computer's files. */
const page = file('att_01K7BBBBBBBBBBBBBBBBBBBBBB', 'checkout.html', 'html');
const plan = file('att_01K7AAAAAAAAAAAAAAAAAAAAAA', 'plan.md', 'markdown');
/** The linked machine's files. */
const farPage = file('att_01K7DDDDDDDDDDDDDDDDDDDDDD', 'pricing.html', 'html');
const farPlan = file('att_01K7EEEEEEEEEEEEEEEEEEEEEE', 'notes.md', 'markdown');
const farShot = file('att_01K7FFFFFFFFFFFFFFFFFFFFFF', 'shot.png', 'image', { media_type: 'image/png', width: 1280, height: 800 });

let root: Root | null = null;
let host: HTMLElement | null = null;
const realFetch = globalThis.fetch;
let asked: string[] = [];

beforeEach(() => {
  asked = [];
  setSelfMachine(SELF);
  rememberMachine([farPage.id, farPlan.id, farShot.id], OTHER);
  // This computer's app list answers for "Open in"; nothing else is read here.
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    asked.push(url);
    if (url.includes('/open-in/apps')) {
      return Response.json({ available: true, platform: 'mac', apps: [{ id: 'vscode', label: 'VS Code', kind: 'editor', icon: 'vscode' }, { id: 'reveal', label: 'Finder', kind: 'file-manager', icon: 'finder' }] });
    }
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = realFetch;
  resetMachineRoutes();
});

async function render(node: React.ReactNode) {
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(node);
  });
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 60; i += 1) {
    if (check()) return;
    await settle();
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function unmount() {
  act(() => root!.unmount());
  host!.remove();
  root = null;
  host = null;
}

const itemsIn = (menu: ParentNode) => [...menu.querySelectorAll<HTMLElement>('[data-open-in-item]')].map((item) => item.dataset.openInItem);
const labelsOf = (menu: ParentNode) => [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((item) => item.textContent);

test.skipIf(!hasDom)("the pane's header: this computer's page has the whole list; the linked machine's page has none, its image a plain new-tab button", async () => {
  // This computer's page: the split button, Browser first, then the apps and Copy path.
  await render(<OpenInControl attachment={page} version="current" surface="apps" label />);
  await until(() => host!.querySelector('[data-open-in-caret]') !== null, 'the split button');
  expect(host!.querySelector<HTMLAnchorElement>('a[data-open-in-primary="browser"]')!.getAttribute('href')).toBe(`/api/inbox/attachments/${page.id}/page`);
  await act(async () => host!.querySelector<HTMLButtonElement>('[data-open-in-caret]')!.click());
  await until(() => document.querySelector(`[data-open-in-menu="${page.id}"]`) !== null, 'the list');
  expect(itemsIn(document.querySelector(`[data-open-in-menu="${page.id}"]`)!)).toEqual(['browser', 'vscode', 'reveal', 'copy-path']);
  await unmount();

  // The linked machine's page: no control at all (no app list read, no Browser, no new tab).
  asked = [];
  await render(<OpenInControl attachment={farPage} version="current" surface="apps" label />);
  for (let i = 0; i < 5; i += 1) await settle();
  expect(host!.querySelector('[data-open-in]')).toBeNull();
  expect(host!.querySelector('[data-open-in-tab]')).toBeNull();
  expect(host!.querySelector('a')).toBeNull();
  expect(asked.filter((url) => url.includes('/open-in/apps'))).toEqual([]);
  await unmount();

  // The linked machine's image: one action, a plain new-tab link through the forward (no caret, no list).
  await render(<OpenInControl attachment={farShot} version="current" surface="apps" label />);
  await until(() => host!.querySelector('[data-open-in-tab]') !== null, 'the new-tab button');
  expect(host!.querySelector<HTMLAnchorElement>('a[data-open-in-tab]')!.getAttribute('href')).toBe(`/api/inbox/m/${OTHER}/attachments/${farShot.id}/image`);
  expect(host!.querySelector('[data-open-in-caret]')).toBeNull();
  expect(host!.querySelector('[data-open-in]')).toBeNull();
});

test.skipIf(!hasDom)("a tile's ⋯: the linked machine's file keeps Open as and Download, with no apps and no Copy path; this computer's keeps them", async () => {
  await render(<AttachmentTiles attachments={[plan, farPlan]} annotationCounts={new Map()} onOpen={() => {}} onOpenAs={() => {}} openIn="apps" />);
  const open = async (attachment: InboxAttachmentState) => {
    await until(() => host!.querySelector(`button[data-open-in-more="${attachment.id}"]`) !== null, `${attachment.name}'s ⋯`);
    await act(async () => host!.querySelector<HTMLButtonElement>(`button[data-open-in-more="${attachment.id}"]`)!.click());
    await until(() => document.querySelector(`[data-open-in-menu="${attachment.id}"]:not([data-tile-context]) [data-tile-download]`) !== null, `${attachment.name}'s menu`);
    return document.querySelector<HTMLElement>(`[data-open-in-menu="${attachment.id}"]:not([data-tile-context])`)!;
  };
  const close = async (attachment: InboxAttachmentState) => {
    await act(async () => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    await until(() => document.querySelector(`[data-open-in-menu="${attachment.id}"]:not([data-tile-context])`) === null, `${attachment.name}'s menu to close`);
  };

  const far = await open(farPlan);
  expect(labelsOf(far)).toEqual(['Open side by side', 'Open full screen', 'Download']);
  expect(itemsIn(far)).toEqual([]);
  // Download still works across machines: through the forward.
  expect(far.querySelector<HTMLAnchorElement>('[data-tile-download]')!.getAttribute('href')).toBe(`/api/inbox/m/${OTHER}/attachments/${farPlan.id}/download`);
  await close(farPlan);

  const here = await open(plan);
  await until(() => here.querySelector('[data-open-in-item="vscode"]') !== null, 'the apps in the list');
  expect(labelsOf(here)).toEqual(['Open side by side', 'Open full screen', 'Download', 'VS Code', 'Default app', 'Finder', 'Copy path']);
});
