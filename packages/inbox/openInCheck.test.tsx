/**
 * The picked app's check in every Open in list is a stroked tick. The menus
 * portal to the body, outside .pn-inbox, so the check's stroke must come from
 * a rule that reaches it there. Full screen's ⋯ lists the apps without the
 * Open in menu's own attribute, and its check drew as a solid black triangle
 * (the owner, 2026-11-03). The window's real stylesheet is loaded.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeAll, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAttachmentState } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
const { FullScreenMore, OpenInControl } = (hasDom ? await import('./components/OpenIn') : {}) as typeof import('./components/OpenIn');

let root: Root | null = null;
let host: HTMLElement | null = null;
let sheet: HTMLStyleElement | null = null;
const realFetch = globalThis.fetch;

const page: InboxAttachmentState = {
  id: 'att_01K7BBBBBBBBBBBBBBBBBBBBBB',
  name: 'turnkey.html',
  path: '/work/shop/turnkey.html',
  kind: 'html',
  named_path: null,
  sent_sha256: 'a'.repeat(64),
  size: 1000,
  sent_at: '2026-10-10T10:42:00.000Z',
  sent_mtime: '2026-10-10T10:42:00.000Z',
  message_id: 'msg_01K7M1MMMMMMMMMMMMMMMMMMMM',
  changed_since_sent: false,
  unavailable: null,
  current: { sha256: 'a'.repeat(64), size: 1000, mtime: '2026-10-10T10:42:00.000Z' },
} as InboxAttachmentState;

beforeAll(() => {
  if (hasDom) (window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL('http://localhost:4000/');
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  sheet?.remove();
  for (const node of document.body.querySelectorAll('[data-base-ui-portal], [role="presentation"]')) node.remove();
  root = null;
  host = null;
  sheet = null;
  globalThis.fetch = realFetch;
});

async function render(node: ReactNode): Promise<void> {
  // The local app list: an editor and Finder. HTML lists Browser first, checked.
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).includes('/open-in/apps')) {
      return new Response(
        JSON.stringify({ available: true, platform: 'mac', apps: [{ id: 'vscode', label: 'VS Code', icon: 'vscode', kind: 'editor' }, { id: 'finder', label: 'Finder', icon: 'finder', kind: 'file-manager' }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
  sheet = document.createElement('style');
  sheet.textContent = readFileSync(join(import.meta.dir, 'inbox.css'), 'utf8');
  document.head.append(sheet);
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(node);
  });
  for (let i = 0; i < 20; i++) await act(async () => new Promise((r) => setTimeout(r, 10)));
}

async function click(el: Element | null): Promise<void> {
  expect(el).not.toBeNull();
  await act(async () => {
    (el as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 30));
  });
}

/** The check beside the picked app, and how it paints. */
function checkPaint(menuSelector: string): { item: string; fill: string; stroke: string } {
  const menu = document.querySelector<HTMLElement>(menuSelector);
  expect(menu).not.toBeNull();
  expect(menu!.closest('.pn-inbox')).toBeNull();
  const check = menu!.querySelector<SVGElement>('[data-open-in-item] svg[data-icon="check"]');
  expect(check).not.toBeNull();
  const style = getComputedStyle(check!);
  return { item: check!.closest('[data-open-in-item]')!.getAttribute('data-open-in-item')!, fill: style.fill, stroke: style.stroke };
}

test.skipIf(!hasDom)("full screen's ⋯: the picked app's check is stroked, not a filled shape", async () => {
  await render(<FullScreenMore attachment={page} version="current" surface="apps" phone={false} open onOpenChange={() => {}} versionAction={null} />);
  const paint = checkPaint(`[data-full-view-menu="${page.id}"]`);
  expect(paint.item).toBe('browser');
  expect(paint.fill).toBe('none');
  expect(paint.stroke).not.toBe('none');
  expect(paint.stroke).not.toBe('');
});

test.skipIf(!hasDom)("the header's Open in menu: the picked app's check is stroked, not a filled shape", async () => {
  await render(<OpenInControl attachment={page} version="current" surface="apps" label />);
  await click(host!.querySelector('[data-open-in-caret]'));
  const paint = checkPaint(`[data-open-in-menu="${page.id}"]`);
  expect(paint.item).toBe('browser');
  expect(paint.fill).toBe('none');
  expect(paint.stroke).not.toBe('none');
  expect(paint.stroke).not.toBe('');
});
