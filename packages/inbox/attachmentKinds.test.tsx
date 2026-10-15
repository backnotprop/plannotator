/**
 * Attachments of any kind in the window (DOM_TESTS=1 for the rendering
 * tests): an image shows inline in the message AND as a tile with its
 * thumbnail, both from the attachment's own image route; a PDF, a plain
 * file and a kind this window does not know are Download links; the image
 * pane draws the image and a comment box. And the feedback a Send carries:
 * an image comment names its marked-up copy, a code comment its lines.
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAnnotationRecord, InboxAttachmentState } from '@plannotator/core/inbox-types';
import { attachmentFeedback, codeCommentAnnotation, imageCommentAnnotation } from './attachments';
import { inboxImageSrcResolver } from './images';

const hasDom = typeof document !== 'undefined';
const { AttachmentPane } = (hasDom ? await import('./components/AttachmentPane') : {}) as typeof import('./components/AttachmentPane');
const { AttachmentTiles } = (hasDom ? await import('./components/AttachmentTiles') : {}) as typeof import('./components/AttachmentTiles');

let root: Root | null = null;
let host: HTMLElement | null = null;
const realFetch = globalThis.fetch;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = realFetch;
});

async function render(node: React.ReactNode) {
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(node);
  });
}

const base = {
  named_path: null,
  sent_sha256: 'a'.repeat(64),
  sent_at: '2026-10-10T10:00:00.000Z',
  sent_mtime: '2026-10-10T10:00:00.000Z',
  message_id: 'msg_01K7ZZZZZZZZZZZZZZZZZZZZZZ',
  changed_since_sent: false,
  unavailable: null,
};

function file(id: string, name: string, kind: string, extra: Partial<InboxAttachmentState> = {}): InboxAttachmentState {
  return {
    ...base,
    id,
    name,
    path: `/work/api/${name}`,
    kind: kind as InboxAttachmentState['kind'],
    size: 81_000,
    current: { sha256: 'a'.repeat(64), size: 81_000, mtime: base.sent_mtime },
    ...extra,
  };
}

const shot = file('att_01K7AAAAAAAAAAAAAAAAAAAAAA', 'checkout.png', 'image', { media_type: 'image/png', width: 1280, height: 800 });
const spec = file('att_01K7BBBBBBBBBBBBBBBBBBBBBB', 'payments-api.pdf', 'pdf', { media_type: 'application/pdf' });
const zip = file('att_01K7CCCCCCCCCCCCCCCCCCCCCC', 'fixtures.zip', 'file');
// A kind a newer Inbox might write: this window treats it as a file to download.
const future = file('att_01K7DDDDDDDDDDDDDDDDDDDDDD', 'clip.holo', 'hologram');

test.skipIf(!hasDom)('an image shows inline in the message and as a tile with its thumbnail, both from its image route', async () => {
  const opened: string[] = [];
  await render(<AttachmentTiles attachments={[shot, spec]} annotationCounts={new Map([[shot.path, 2]])} onOpen={(a) => opened.push(a.id)} />);
  const route = `/api/inbox/attachments/${shot.id}/image`;
  const inline = host!.querySelector<HTMLButtonElement>(`[data-gallery-image="${shot.id}"]`)!;
  expect(inline).not.toBeNull();
  // (happy-dom fails every image load, so the frame's src is read off the frame.)
  expect(inline.querySelector('.ib-gal-frame')!.getAttribute('data-src')).toBe(route);
  expect(inline.getAttribute('aria-label')).toBe('View checkout.png, PNG image, 2 comments');
  expect(inline.textContent).toContain('1280 × 800');
  const tile = host!.querySelector<HTMLButtonElement>(`button[data-attachment-id="${shot.id}"]`)!;
  expect(tile.querySelector('.ib-thumb img')!.getAttribute('src')).toBe(route);
  await act(async () => inline.click());
  await act(async () => tile.click());
  expect(opened).toEqual([shot.id, shot.id]);
});

test.skipIf(!hasDom)('a PDF, a plain file and an unknown kind are Download links, never opened in the window', async () => {
  await render(<AttachmentTiles attachments={[spec, zip, future]} annotationCounts={new Map()} onOpen={() => {}} />);
  for (const attachment of [spec, zip, future]) {
    const link = host!.querySelector<HTMLAnchorElement>(`[data-attachment-id="${attachment.id}"]`)!;
    expect(link.tagName).toBe('A');
    expect(link.getAttribute('href')).toBe(`/api/inbox/attachments/${attachment.id}/download`);
    expect(link.getAttribute('download')).toBe(attachment.name);
    expect(link.getAttribute('data-attachment-kind')).toBe(attachment === spec ? 'pdf' : 'file');
  }
  expect(host!.querySelector('[data-image-gallery]')).toBeNull();
  // A changed or missing current file downloads the version that was sent.
  act(() => root!.unmount());
  host!.remove();
  await render(<AttachmentTiles attachments={[{ ...zip, unavailable: { code: 'attachment_missing', message: 'gone' }, current: null }]} annotationCounts={new Map()} onOpen={() => {}} />);
  expect(host!.querySelector(`[data-attachment-id="${zip.id}"]`)!.getAttribute('href')).toBe(`/api/inbox/attachments/${zip.id}/download?version=sent`);
});

test.skipIf(!hasDom)('the image pane draws the image from its route and offers a comment box with Mark up; no text is fetched', async () => {
  const fetched: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    fetched.push(String(input));
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
  const noop = () => {};
  await render(
    <AttachmentPane
      attachment={shot}
      attachments={[shot]}
      records={[]}
      agent="Claude Code"
      projectName="api"
      projectRoot="/work/api"
      version="current"
      onVersion={noop}
      full={false}
      onToggleFull={noop}
      focusId={null}
      readOnly={false}
      onSaved={noop}
      onRemoved={noop}
      onOpenAt={noop}
      onClose={noop}
      strip={{ picks: 0, annotations: 0, onBack: noop, onWriteReply: noop }}
    />,
  );
  expect(host!.querySelector('.ib-imgstage')!.getAttribute('data-src')).toBe(`/api/inbox/attachments/${shot.id}/image`);
  expect(host!.querySelector('[data-image-composer] textarea')).not.toBeNull();
  expect(host!.querySelector('[data-markup-open]')).not.toBeNull();
  expect(host!.querySelector('[data-attachment-download]')!.getAttribute('href')).toBe(`/api/inbox/attachments/${shot.id}/download`);
  // An image is never read as text.
  expect(fetched.filter((url) => url.includes('/view'))).toEqual([]);
});

test.skipIf(!hasDom)('a text file too large to show (413 attachment_too_large) opens as the Download card', async () => {
  const log = file('att_01K7GGGGGGGGGGGGGGGGGGGGGG', 'worker.log', 'text');
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: 'worker.log is too large to show here.', code: 'attachment_too_large' }), {
      status: 413,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch;
  const noop = () => {};
  await render(
    <AttachmentPane
      attachment={log}
      attachments={[log]}
      records={[]}
      agent="Claude Code"
      projectName="api"
      projectRoot="/work/api"
      version="current"
      onVersion={noop}
      full={false}
      onToggleFull={noop}
      focusId={null}
      readOnly={false}
      onSaved={noop}
      onRemoved={noop}
      onOpenAt={noop}
      onClose={noop}
      strip={{ picks: 0, annotations: 0, onBack: noop, onWriteReply: noop }}
    />,
  );
  await act(async () => {
    for (let i = 0; i < 100 && !host!.querySelector('[data-download-card]'); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  });
  const card = host!.querySelector('[data-download-card]')!;
  expect(card).not.toBeNull();
  expect(card.querySelector('a[download]')!.getAttribute('href')).toBe(`/api/inbox/attachments/${log.id}/download`);
  expect(host!.querySelector('[role="alert"]')).toBeNull();
});

function renderPane(attachment: InboxAttachmentState, options: { phone?: boolean; others?: InboxAttachmentState[]; records?: InboxAnnotationRecord[] } = {}) {
  globalThis.fetch = (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch;
  const noop = () => {};
  return render(
    <AttachmentPane
      attachment={attachment}
      attachments={[attachment, ...(options.others ?? [])]}
      records={options.records ?? []}
      agent="Claude Code"
      projectName="api"
      projectRoot="/work/api"
      version="current"
      onVersion={noop}
      full={options.phone === true}
      fullLocked={options.phone === true}
      phone={options.phone}
      onToggleFull={noop}
      focusId={null}
      readOnly={false}
      onSaved={noop}
      onRemoved={noop}
      onOpenAt={noop}
      onClose={noop}
      strip={{ picks: 0, annotations: 0, onBack: noop, onWriteReply: noop }}
    />,
  );
}

// Rows 47 and 61: a PDF takes no comments, so it has no panel beside it and no Comments button on a phone.
test.skipIf(!hasDom)('a PDF has no comments panel or Comments button, unless other files have comments to list', async () => {
  await renderPane(spec);
  expect(host!.querySelector('[data-attachment-pane]')!.classList.contains('ib-nopanel')).toBe(true);
  act(() => root!.unmount());
  host!.remove();

  await renderPane(spec, { phone: true });
  expect(host!.querySelector('[data-download-card]')).not.toBeNull();
  expect(host!.querySelector('[data-annotations-sheet]')).toBeNull();
  act(() => root!.unmount());
  host!.remove();

  // Another file's comment: the panel lists it, so a phone keeps the button to open it.
  const note = record(shot, imageCommentAnnotation({ id: 'ann-shot', name: 'checkout.png', text: 'Cut off.' }), 'ann-shot');
  await renderPane(spec, { phone: true, others: [shot], records: [note] });
  expect(host!.querySelector('[data-attachment-pane]')!.classList.contains('ib-nopanel')).toBe(false);
  const button = host!.querySelector<HTMLButtonElement>('[data-annotations-sheet]')!;
  expect(button).not.toBeNull();
  expect(button.getAttribute('aria-label')).toMatch(/^Comments, \d+$/);
  const panel = host!.querySelector('.ib-apanel')!;
  expect(button.getAttribute('aria-controls')).toBe(panel.id);
  // The sheet's close, and Escape inside it, close it and give focus back to the button.
  await act(async () => button.click());
  expect(button.getAttribute('aria-expanded')).toBe('true');
  const close = panel.querySelector<HTMLButtonElement>('button[aria-label="Close the comments"]')!;
  await act(async () => close.click());
  expect(button.getAttribute('aria-expanded')).toBe('false');
  expect(document.activeElement).toBe(button);
  await act(async () => button.click());
  await act(async () => {
    close.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  });
  expect(button.getAttribute('aria-expanded')).toBe('false');
  expect(document.activeElement).toBe(button);
});

// Row 52: a 1×1 image was blown up to a block of one colour; row 51: a panorama became a sliver.
test.skipIf(!hasDom)('a tiny image draws at its own size in its thumbnail, and a panorama is cropped to 4:1 from the left', async () => {
  const dot = file('att_01K7HHHHHHHHHHHHHHHHHHHHHH', 'dot.png', 'image', { media_type: 'image/png', width: 1, height: 1 });
  const pano = file('att_01K7JJJJJJJJJJJJJJJJJJJJJJ', 'pano.png', 'image', { media_type: 'image/png', width: 8000, height: 300 });
  await render(<AttachmentTiles attachments={[dot, pano, shot]} annotationCounts={new Map()} onOpen={() => {}} />);
  const thumb = (a: InboxAttachmentState) => host!.querySelector(`button[data-attachment-id="${a.id}"] .ib-thumb img`)!;
  expect(thumb(dot).hasAttribute('data-small')).toBe(true);
  expect(thumb(shot).hasAttribute('data-small')).toBe(false);
  const frame = (a: InboxAttachmentState) => host!.querySelector<HTMLElement>(`[data-gallery-image="${a.id}"] .ib-gal-frame`)!;
  expect(frame(pano).classList.contains('ib-wide')).toBe(true);
  expect(frame(pano).getAttribute('style')).toMatch(/aspect-ratio: 4( \/ 1)?;/);
  expect(frame(shot).classList.contains('ib-wide')).toBe(false);
});

function record(attachment: InboxAttachmentState, annotation: object, id: string): InboxAnnotationRecord {
  return {
    id,
    project_id: 'prj_x',
    thread_id: 'msg_x',
    message_id: attachment.message_id,
    attachment_id: attachment.id,
    path: attachment.path,
    version: 'current',
    annotation: annotation as Record<string, unknown>,
    created_at: base.sent_at,
    updated_at: base.sent_at,
    removed_at: null,
    sent_reply_id: null,
  };
}

test('the Send feedback carries an image comment with its marked-up copy, and a code comment with its lines', () => {
  const markupPath = `/home/me/.plannotator/inbox/markups/${'b'.repeat(64)}.png`;
  const code = file('att_01K7EEEEEEEEEEEEEEEEEEEEEE', 'retry.mjs', 'code');
  const outside = file('att_01K7FFFFFFFFFFFFFFFFFFFFFF', 'shot.png', 'image', { path: '/tmp/shots/shot.png' });
  const records = [
    record(shot, imageCommentAnnotation({ id: 'ann-img', name: 'checkout.png', text: 'The Pay button is cut off.', markup: { path: markupPath, name: 'checkout, marked up' } }), 'ann-img'),
    record(code, codeCommentAnnotation({ id: 'ann-code', lineStart: 12, lineEnd: 14, text: 'Five retries is too many.', code: 'export const MAX_ATTEMPTS = 5;\nexport const DELAY = 30;\nexport const JITTER = true;' }), 'ann-code'),
    record(outside, imageCommentAnnotation({ id: 'ann-out', name: 'shot.png', text: 'Wrong colour.' }), 'ann-out'),
  ];
  const feedback = attachmentFeedback(records, [shot, code, outside], new Map(), '/work/api');
  expect(feedback).toContain('## checkout.png');
  expect(feedback).toContain('The Pay button is cut off.');
  expect(feedback).toContain(`- [checkout, marked up] \`${markupPath}\``);
  expect(feedback).toContain('## retry.mjs');
  expect(feedback).toContain('(lines 12–14) Feedback on: "export const MAX_ATTEMPTS = 5; …"');
  expect(feedback).toContain('> Five retries is too many.');
  // A file attached from outside the project is named by its absolute path.
  expect(feedback).toContain('## /tmp/shots/shot.png');
});

test('a marked-up copy shows back through the Inbox route by its name only', () => {
  const name = `${'c'.repeat(64)}.png`;
  expect(inboxImageSrcResolver(`/home/me/.plannotator/inbox/markups/${name}`)).toBe(`/api/inbox/markups/${name}`);
  expect(inboxImageSrcResolver('/etc/passwd')).toBe('/api/image?path=%2Fetc%2Fpasswd');
});
