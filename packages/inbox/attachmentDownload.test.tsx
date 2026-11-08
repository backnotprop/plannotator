/**
 * Download from where the files are (the owner, 2026-11-08: "a simple,
 * better, faster way to download attachments ... the context menu should
 * also have Download"). A right-click on a tile at a message's foot, or on an
 * Artifacts card, opens the tile's menu at the pointer with Download: the
 * version the tile opens, saved under the file's own name (an HTML page and a
 * Markdown file too, never opened). On this computer the tile's ⋯ holds the
 * same list. A picture in the gallery and a touch keep the browser's own menu.
 * The viewer's bar beside the thread has Download for every kind, for the
 * version on screen.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAttachmentState } from '@plannotator/core/inbox-types';
import type { FileArtifact } from './artifacts';

const hasDom = typeof document !== 'undefined';
const { AttachmentPane } = (hasDom ? await import('./components/AttachmentPane') : {}) as typeof import('./components/AttachmentPane');
const { AttachmentTiles } = (hasDom ? await import('./components/AttachmentTiles') : {}) as typeof import('./components/AttachmentTiles');
const { ArtifactsView } = (hasDom ? await import('./components/ArtifactsView') : {}) as typeof import('./components/ArtifactsView');

const M1 = 'msg_01K7M1MMMMMMMMMMMMMMMMMMMM';

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
    message_id: M1,
    changed_since_sent: false,
    unavailable: null,
    current: { sha256: 'a'.repeat(64), size: 1000, mtime: '2026-10-10T10:42:00.000Z' },
    ...extra,
  };
}

const plan = file('att_01K7AAAAAAAAAAAAAAAAAAAAAA', 'plan.md', 'markdown');
const page = file('att_01K7BBBBBBBBBBBBBBBBBBBBBB', 'checkout.html', 'html');
const shot = file('att_01K7CCCCCCCCCCCCCCCCCCCCCC', 'shot.png', 'image', { media_type: 'image/png', width: 1280, height: 800 });
const spec = file('att_01K7DDDDDDDDDDDDDDDDDDDDDD', 'spec.pdf', 'pdf', { media_type: 'application/pdf' });
/** Edited on disk after it was sent: the tile opens it as it is now. */
const edited = file('att_01K7EEEEEEEEEEEEEEEEEEEEEE', 'notes.md', 'markdown', {
  changed_since_sent: true,
  current: { sha256: 'b'.repeat(64), size: 1200, mtime: '2026-10-10T12:00:00.000Z' },
});
/** Gone from disk: the tile opens the version it sent. */
const gone = file('att_01K7FFFFFFFFFFFFFFFFFFFFFF', 'old.md', 'markdown', { current: null, unavailable: { code: 'attachment_missing', message: 'gone' } });

let root: Root | null = null;
let host: HTMLElement | null = null;
const realFetch = globalThis.fetch;

beforeEach(() => {
  // The view route reads text files; the apps list answers for "Open in" on this computer.
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/open-in/apps')) {
      return Response.json({ available: true, platform: 'mac', apps: [{ id: 'vscode', label: 'VS Code', kind: 'editor', icon: 'vscode' }] });
    }
    const att = [plan, page, edited].find((a) => url.includes(a.id));
    if (att && url.includes('/view')) {
      const html = att.kind === 'html' ? '<h1>Checkout</h1>' : null;
      return Response.json({ serverSession: 's', attachment: att, version: 'current', text: html ?? '# Plan\n\nShip it.\n', html });
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

const contextMenu = () => document.querySelector<HTMLElement>('[data-tile-context]');
const downloadIn = (menu: ParentNode) => menu.querySelector<HTMLAnchorElement>('[data-tile-download]');
const labelsOf = (menu: ParentNode) => [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((item) => item.textContent);

/** A right-click at `el` (a mouse, or the platform's long press when `touch`): the event, to see whether ours took it. */
async function rightClick(el: Element, touch = false): Promise<MouseEvent> {
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 200, clientY: 120 });
  if (touch) Object.defineProperty(event, 'pointerType', { value: 'touch' });
  await act(async () => {
    el.dispatchEvent(event);
  });
  await settle();
  return event;
}

async function closeMenu() {
  await act(async () => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  await until(() => contextMenu() === null, 'the menu to close');
}

test.skipIf(!hasDom)('a right-click on a tile opens its menu with Download: the version it opens, under its own name', async () => {
  await render(<AttachmentTiles attachments={[plan, page, spec, edited, gone]} annotationCounts={new Map()} onOpen={() => {}} />);
  for (const attachment of [plan, page, spec, edited]) {
    // On the tile's name, not just its edge: anywhere on the tile is the tile.
    const event = await rightClick(host!.querySelector(`[data-attachment-id="${attachment.id}"] .ib-nm`)!);
    await until(() => contextMenu() !== null, `${attachment.name}'s menu`);
    // Ours, not the browser's.
    expect(event.defaultPrevented).toBe(true);
    const download = downloadIn(contextMenu()!)!;
    expect(download.getAttribute('href')).toBe(`/api/inbox/attachments/${attachment.id}/download`);
    // An HTML page and a Markdown file are saved as files, never opened.
    expect(download.getAttribute('download')).toBe(attachment.name);
    expect(download.textContent).toBe('Download');
    await closeMenu();
  }
  // A file gone from disk opens (and downloads) the version it sent.
  await rightClick(host!.querySelector(`[data-attachment-id="${gone.id}"]`)!);
  await until(() => contextMenu() !== null, `${gone.name}'s menu`);
  expect(downloadIn(contextMenu()!)!.getAttribute('href')).toBe(`/api/inbox/attachments/${gone.id}/download?version=sent`);
  expect(downloadIn(contextMenu()!)!.textContent).toBe('Download the sent version');
});

test.skipIf(!hasDom)('on this computer the tile ⋯ and the right-click list the same items, Download among them', async () => {
  const opened: string[] = [];
  await render(<AttachmentTiles attachments={[plan]} annotationCounts={new Map()} onOpen={() => {}} onOpenAs={(a, view) => opened.push(`${a.id}:${view}`)} openIn="apps" />);
  await until(() => host!.querySelector(`[data-open-in-more="${plan.id}"]`) !== null, 'the tile ⋯');
  const more = host!.querySelector<HTMLButtonElement>(`button[data-open-in-more="${plan.id}"]`)!;
  expect(more.getAttribute('aria-label')).toBe(`More: ${plan.name}`);
  await act(async () => more.click());
  await until(() => document.querySelector(`[data-open-in-menu="${plan.id}"] [data-open-in-item="vscode"]`) !== null, 'the ⋯ menu with its apps');
  const dots = document.querySelector<HTMLElement>(`[data-open-in-menu="${plan.id}"]:not([data-tile-context])`)!;
  const dotsLabels = labelsOf(dots);
  expect(downloadIn(dots)!.getAttribute('href')).toBe(`/api/inbox/attachments/${plan.id}/download`);
  await act(async () => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  await until(() => document.querySelector(`[data-open-in-menu="${plan.id}"]`) === null, 'the ⋯ menu to close');

  await rightClick(host!.querySelector(`[data-attachment-id="${plan.id}"]`)!);
  await until(() => contextMenu() !== null, 'the right-click menu');
  expect(labelsOf(contextMenu()!)).toEqual(dotsLabels);
  expect(dotsLabels).toEqual(['Open side by side', 'Open full screen', 'Download', 'VS Code', 'Default app', 'Copy path']);
  // An item acts as the ⋯'s does.
  await act(async () => contextMenu()!.querySelector<HTMLElement>('[data-open-as="side"]')!.click());
  expect(opened).toEqual([`${plan.id}:side`]);
});

test.skipIf(!hasDom)('a picture in the gallery and a touch keep the browser’s own menu', async () => {
  await render(<AttachmentTiles attachments={[shot]} annotationCounts={new Map()} onOpen={() => {}} />);
  // The big picture: the browser's Save Image As and Copy Image (a copied picture pastes as this file: reusePaste.ts).
  const picture = await rightClick(host!.querySelector(`[data-gallery-image="${shot.id}"] .ib-gal-frame`)!);
  expect(picture.defaultPrevented).toBe(false);
  expect(contextMenu()).toBeNull();
  // A long press on a phone: no menu of ours (useContextMenuTrigger has no long press).
  const touch = await rightClick(host!.querySelector(`button[data-attachment-id="${shot.id}"]`)!, true);
  expect(touch.defaultPrevented).toBe(false);
  expect(contextMenu()).toBeNull();
  // The same tile by mouse: ours.
  await rightClick(host!.querySelector(`button[data-attachment-id="${shot.id}"]`)!);
  await until(() => contextMenu() !== null, 'the menu');
  expect(downloadIn(contextMenu()!)!.getAttribute('download')).toBe(shot.name);
});

test.skipIf(!hasDom)('a right-click on an Artifacts card opens its menu with Download', async () => {
  const artifact = (attachment: InboxAttachmentState): FileArtifact => ({
    type: 'file',
    attachment,
    inline: false,
    alsoIds: [],
    messageId: M1,
    sender: 'Claude Code',
    sentAt: '10:42 AM',
    at: '2026-10-10T10:42:00.000Z',
    fromPerson: false,
    host: 'claude-code',
  });
  await render(<ArtifactsView artifacts={[artifact(page), artifact(edited)]} annotationCounts={new Map()} openId={null} onOpen={() => {}} onOpenGuide={() => {}} />);
  for (const attachment of [page, edited]) {
    const event = await rightClick(host!.querySelector(`[data-artifact-tile="${attachment.id}"] .ib-art-cap`)!);
    await until(() => contextMenu() !== null, `${attachment.name}'s card menu`);
    expect(event.defaultPrevented).toBe(true);
    const download = downloadIn(contextMenu()!)!;
    // An edited file: as it is now, the version the card opens.
    expect(download.getAttribute('href')).toBe(`/api/inbox/attachments/${attachment.id}/download`);
    expect(download.getAttribute('download')).toBe(attachment.name);
    await closeMenu();
  }
});

const noop = () => {};
function pane(attachment: InboxAttachmentState, version: 'current' | 'sent' = 'current') {
  return (
    <AttachmentPane
      attachment={attachment}
      attachments={[attachment]}
      records={[]}
      agent="Claude Code"
      projectName="shop"
      projectRoot="/work/shop"
      version={version}
      onVersion={noop}
      full={false}
      onToggleFull={noop}
      focusId={null}
      readOnly={false}
      onSaved={noop}
      onRemoved={noop}
      onOpenAt={noop}
      onClose={noop}
      strip={{ picks: 0, annotations: 0, onWriteReply: noop }}
    />
  );
}
const barDownload = () => host!.querySelector<HTMLAnchorElement>('.ib-vhead [data-attachment-download]');

test.skipIf(!hasDom)('the viewer’s bar has Download for an image, a Markdown file and an HTML page, saved as the file', async () => {
  for (const attachment of [shot, plan, page]) {
    await render(pane(attachment));
    await until(() => barDownload() !== null, `${attachment.name}'s bar`);
    expect(barDownload()!.getAttribute('href')).toBe(`/api/inbox/attachments/${attachment.id}/download`);
    expect(barDownload()!.getAttribute('download')).toBe(attachment.name);
    expect(barDownload()!.getAttribute('aria-label')).toBe(`Download ${attachment.name}`);
    act(() => root!.unmount());
    host!.remove();
  }
  root = null;
  host = null;
});

test.skipIf(!hasDom)('a file edited after it was sent: the bar downloads the version on screen, and says when that is the sent one', async () => {
  await render(pane(edited));
  await until(() => barDownload() !== null, 'the bar');
  expect(barDownload()!.getAttribute('href')).toBe(`/api/inbox/attachments/${edited.id}/download`);
  expect(barDownload()!.getAttribute('aria-label')).toBe(`Download ${edited.name}`);
  await act(async () => root!.render(pane(edited, 'sent')));
  await until(() => barDownload()!.getAttribute('href')!.endsWith('?version=sent'), 'the sent version');
  expect(barDownload()!.getAttribute('href')).toBe(`/api/inbox/attachments/${edited.id}/download?version=sent`);
  expect(barDownload()!.getAttribute('download')).toBe(edited.name);
  expect(barDownload()!.getAttribute('aria-label')).toBe(`Download ${edited.name} (the version it sent)`);
});
