/**
 * Files on a file's own comment row beside the thread (DOM_TESTS=1; the owner, 2026-11-22: "I need to be able to
 * attach images to this comment box on top of files/artifacts"; commentFiles.tsx), with an in-process uploader in
 * place of the Inbox's uploads: the reply box's paperclip after the pencil, a pick, a paste and a drop each add a
 * tile, × takes one out, Comment keeps them on the comment (a picture by its name, any other file as a file) and
 * clears the row; the comment's card shows its pictures and never lays one over the image as a drawing; a film's
 * row takes them too and its card shows them; no Inbox uploads above (the tour), no paperclip.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAnnotationRecord, InboxAttachmentState, InboxUpload } from '@plannotator/core/inbox-types';
import type { CommentFilesHost } from './commentFiles';
import { imageCommentAnnotation } from './attachments';
import { clearFileDrafts } from './fileCommentDrafts';
import type { InboxToastModel } from './components/Toast';

const hasDom = typeof document !== 'undefined';
const { AttachmentPane } = (hasDom ? await import('./components/AttachmentPane') : {}) as typeof import('./components/AttachmentPane');
const { CommentFilesContext } = (hasDom ? await import('./commentFiles') : {}) as typeof import('./commentFiles');

/** The uploads this test's uploader took, in order (no network: each answers at once). */
let uploaded: InboxUpload[] = [];
/** While set, every upload waits for it (a slow upload); `refuseUploads` makes each fail; `storedAs` renames the stored file. */
let uploadGate: Promise<void> | null = null;
let refuseUploads = false;
let storedAs: ((name: string) => string) | null = null;
const host_: CommentFilesHost = {
  machine: null,
  uploader: {
    upload: async (file) => {
      if (uploadGate) await uploadGate;
      if (refuseUploads) throw new Error('refused');
      const upload: InboxUpload = {
        upload_id: `upl_01JD2Q9V8Y6K3M4N5P7R8S9T0${uploaded.length}`,
        name: storedAs ? storedAs(file.name) : file.name,
        size: file.size,
        kind: file.type.startsWith('image/') ? 'image' : 'text',
        sha256: String(uploaded.length).repeat(64).slice(0, 64),
        created_at: '2026-11-22T10:00:00.000Z',
      };
      uploaded.push(upload);
      return upload;
    },
    readText: async () => '',
  },
};
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const picture = (name: string) => new File([PNG], name, { type: 'image/png' });
const textFile = (name: string) => new File(['notes'], name, { type: 'text/plain' });

let root: Root | null = null;
let host: HTMLElement | null = null;
const realFetch = globalThis.fetch;
const restores: (() => void)[] = [];

/** Replace a member for one test (restored after it). */
function stub<T extends object>(target: T, key: string, descriptor: PropertyDescriptor) {
  const previous = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, ...descriptor });
  restores.push(() => (previous ? Object.defineProperty(target, key, previous) : delete (target as Record<string, unknown>)[key]));
}

const MARKED = '/home/me/.plannotator/inbox/markups/' + 'd'.repeat(64) + '.png';
const FRAME = '/home/me/.plannotator/inbox/markups/' + 'c'.repeat(64) + '.jpg';

type Post = { url: string; body: Record<string, unknown> | null };
let posts: Post[] = [];
/** How long the markups route takes to answer (a slow upload). */
let uploadMs = 0;
/** How long each canvas encode takes, one entry per call (none left: at once). */
let encodeMs: number[] = [];
/** Saving an annotation fails (the server refuses it). */
let failSaves = false;

beforeEach(() => {
  posts = [];
  uploadMs = 0;
  encodeMs = [];
  failSaves = false;
  if (!hasDom) return;
  // A 2D context that draws nothing; a canvas that hands back a small PNG or JPEG.
  const ctx = new Proxy({}, { get: () => () => {} });
  stub(HTMLCanvasElement.prototype, 'getContext', { value: () => ctx, writable: true });
  stub(HTMLCanvasElement.prototype, 'toBlob', {
    value: (cb: (blob: Blob) => void, type = 'image/png') => {
      const blob = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type });
      const ms = encodeMs.shift();
      if (ms === undefined) cb(blob);
      else setTimeout(() => cb(blob), ms);
    },
    writable: true,
  });
  stub(Element.prototype, 'setPointerCapture', { value: () => {}, writable: true });
  // A page URL, so the image's route parses (at about:blank happy-dom fails it, and the pane says the image could not be shown).
  const happy = (globalThis as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM;
  const was = location.href;
  happy.setURL('http://127.0.0.1:4100/');
  restores.push(() => happy.setURL(was));
  // happy-dom has no Path2D (the pen's stroke is one).
  stub(globalThis, 'Path2D', { value: class {}, writable: true });
  stub(URL, 'createObjectURL', { value: () => 'blob:frame', writable: true });
  stub(URL, 'revokeObjectURL', { value: () => {}, writable: true });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('/api/inbox/markups')) {
      posts.push({ url, body: null });
      if (uploadMs) await new Promise((resolve) => setTimeout(resolve, uploadMs));
      const path = url.includes('jpeg') || new Headers(init?.headers).get('content-type') === 'image/jpeg' ? FRAME : MARKED;
      return Response.json({ path, name: path.split('/').pop(), url: '/api/inbox/markups/x' });
    }
    if (url === '/api/inbox/annotations') {
      if (failSaves) return Response.json({ error: { code: 'internal', message: 'Not saved.' } }, { status: 500 });
      const body = JSON.parse(String(init?.body));
      posts.push({ url, body });
      return Response.json({ annotation: record(body.annotation, body.annotation.id, body.attachment_id ?? shot.id) });
    }
    if (/^\/api\/inbox\/annotations\/[^/]+\/remove$/.test(url)) {
      posts.push({ url, body: null });
      return Response.json({ annotation: null });
    }
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  // The CSS check runs in the plain pass too, where there is no document.
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = realFetch;
  for (const restore of restores.splice(0).reverse()) restore();
  document.querySelectorAll('[data-pn-image-annotator-stage]').forEach((el) => el.closest('.pn-visible-viewport-overlay')?.remove());
});

const base = {
  named_path: null,
  sent_sha256: 'a'.repeat(64),
  sent_at: '2026-10-10T10:00:00.000Z',
  sent_mtime: '2026-10-10T10:00:00.000Z',
  message_id: 'msg_01K7ZZZZZZZZZZZZZZZZZZZZZZ',
  changed_since_sent: false,
  unavailable: null,
};
const shot: InboxAttachmentState = {
  ...base,
  id: 'att_01K7AAAAAAAAAAAAAAAAAAAAAA',
  name: 'checkout.png',
  path: '/work/api/checkout.png',
  kind: 'image',
  media_type: 'image/png',
  width: 1280,
  height: 800,
  size: 81_000,
  current: { sha256: 'a'.repeat(64), size: 81_000, mtime: base.sent_mtime },
};
const film: InboxAttachmentState = {
  ...base,
  id: 'att_01K7VVVVVVVVVVVVVVVVVVVVVV',
  name: 'launch-cut-v3.mp4',
  path: '/work/api/launch-cut-v3.mp4',
  kind: 'video',
  media_type: 'video/mp4',
  duration_ms: 461_000,
  width: 1920,
  height: 1080,
  size: 483_393_536,
  current: { sha256: 'a'.repeat(64), size: 483_393_536, mtime: base.sent_mtime },
};

function record(annotation: object, id: string, attachmentId = shot.id): InboxAnnotationRecord {
  const attachment = attachmentId === film.id ? film : shot;
  return {
    id,
    project_id: 'prj_x',
    thread_id: 'msg_x',
    message_id: attachment.message_id,
    attachment_id: attachment.id,
    path: attachment.path,
    version: 'current',
    annotation: { ...annotation, createdA: 1 } as Record<string, unknown>,
    created_at: attachment.sent_at,
    updated_at: attachment.sent_at,
    removed_at: null,
    sent_reply_id: null,
  };
}

let toasts: Omit<InboxToastModel, 'id'>[] = [];

/** The pane with its records kept as the thread keeps them (a save upserts, a removal drops). */
function Harness({ attachment, initial = [], uploads = true }: { attachment: InboxAttachmentState; initial?: InboxAnnotationRecord[]; uploads?: boolean }) {
  const [records, setRecords] = useState(initial);
  const noop = () => {};
  return (
    <CommentFilesContext.Provider value={uploads ? host_ : null}>
    <div className="pn-inbox">
      <AttachmentPane
        attachment={attachment}
        attachments={[attachment]}
        records={records}
        agent="Claude Code"
        projectName="api"
        projectRoot="/work/api"
        version="current"
        onVersion={noop}
        full={false}
        onToggleFull={noop}
        focusId={null}
        readOnly={false}
        onSaved={(saved) => setRecords((now) => [...now.filter((r) => r.id !== saved.id), saved])}
        onRemoved={(id) => setRecords((now) => now.filter((r) => r.id !== id))}
        onOpenAt={noop}
        onClose={noop}
        strip={{ picks: 0, annotations: records.length, onWriteReply: noop }}
        onToast={(toast) => toasts.push(toast)}
      />
    </div>
    </CommentFilesContext.Provider>
  );
}

async function render(node: React.ReactNode) {
  toasts = [];
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(node);
  });
}

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector);

const saved = () => posts.filter((p) => p.url === '/api/inbox/annotations').map((p) => (p.body as { annotation: Record<string, unknown> }).annotation);
const row = () => $('[data-image-composer] .ib-ccard')!;
const clipInput = () => $<HTMLInputElement>('[data-image-composer] input[type="file"][data-comment-attach]');
const tiles = () => [...document.querySelectorAll<HTMLElement>('[data-image-composer] [data-comment-files] [data-compose-file]')];
const typeInto = async (area: HTMLTextAreaElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(area, value);
    area.dispatchEvent(new Event('input', { bubbles: true }));
  });
};
async function choose(input: HTMLInputElement, files: File[]) {
  Object.defineProperty(input, 'files', { configurable: true, value: files });
  await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
  await settle();
}
async function pasteOn(target: HTMLElement, files: File[]): Promise<boolean> {
  const items = files.map((file) => ({ kind: 'file', type: file.type, getAsFile: () => file }));
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: { files, items, types: items.map((i) => i.type), getData: () => '' } });
  await act(async () => target.dispatchEvent(event));
  await settle();
  return event.defaultPrevented;
}
async function dragOn(target: Element, type: 'dragover' | 'drop', files: File[]): Promise<boolean> {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: { files, types: ['Files'], dropEffect: 'none', getData: () => '' } });
  await act(async () => target.dispatchEvent(event));
  await settle();
  return event.defaultPrevented;
}

beforeEach(() => {
  // A row's draft is window memory: one test's open row never reaches the next.
  clearFileDrafts();
  uploaded = [];
  uploadGate = null;
  refuseUploads = false;
  storedAs = null;
});

/** A gate for the uploads: they wait until `open()`. */
function holdUploads() {
  let open = () => {};
  uploadGate = new Promise<void>((resolve) => {
    open = () => {
      uploadGate = null;
      resolve();
    };
  });
  return async () => {
    open();
    await settle();
  };
}

test.skipIf(!hasDom)('no Inbox uploads above the pane (the tour): the row has no paperclip, and a paste is left to the field', async () => {
  await render(<Harness attachment={shot} uploads={false} />);
  expect(clipInput()).toBeNull();
  expect(await pasteOn($<HTMLTextAreaElement>('[data-image-composer] textarea')!, [picture('shot.png')])).toBe(false);
  expect(tiles()).toHaveLength(0);
});

test.skipIf(!hasDom)('the paperclip after the pencil; a pick, a paste and a drop each add a tile; × takes one out; Comment keeps them on the comment and clears the row', async () => {
  await render(<Harness attachment={shot} />);
  const input = clipInput()!;
  expect(input).not.toBeNull();
  const label = input.closest('label')!;
  expect(label.getAttribute('aria-label')).toBe('Attach files');
  expect($('[data-markup-open]')!.compareDocumentPosition(label) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  const save = () => $<HTMLButtonElement>('[data-image-comment-save]')!;
  expect(save().disabled).toBe(true);

  await choose(input, [picture('legend.png')]);
  expect(tiles().map((t) => [t.getAttribute('data-compose-file-name'), t.getAttribute('data-compose-file')])).toEqual([['legend.png', 'done']]);
  // A picture alone is a comment.
  expect(save().disabled).toBe(false);
  // A screenshot pasted into the field (no text: the browser's own paste prevented).
  expect(await pasteOn($<HTMLTextAreaElement>('[data-image-composer] textarea')!, [picture('image.png')])).toBe(true);
  expect(tiles()).toHaveLength(2);
  // A drop on the row: "Drop to attach" while it is over, then a tile.
  expect(await dragOn(row(), 'dragover', [textFile('notes.txt')])).toBe(true);
  expect($('[data-comment-drop]')).not.toBeNull();
  expect(await dragOn(row(), 'drop', [textFile('notes.txt')])).toBe(true);
  expect($('[data-comment-drop]')).toBeNull();
  expect(tiles().map((t) => t.getAttribute('data-compose-file-name'))).toEqual(['legend.png', expect.stringMatching(/^pasted-image-/), 'notes.txt']);

  // × takes the pasted one out, focus back in the field.
  await act(async () => tiles()[1]!.querySelector<HTMLButtonElement>('button')!.click());
  expect(tiles()).toHaveLength(2);
  expect(document.activeElement).toBe($('[data-image-composer] textarea'));

  await typeInto($<HTMLTextAreaElement>('[data-image-composer] textarea')!, 'The legend is cut off.');
  await act(async () => save().click());
  await settle();
  expect(saved()).toHaveLength(1);
  expect(saved()[0]).toMatchObject({
    text: 'The legend is cut off.',
    images: [
      { path: `${uploaded[0]!.upload_id}/legend.png`, name: 'legend' },
      { path: `${uploaded[2]!.upload_id}/notes.txt`, name: 'notes.txt', kind: 'file' },
    ],
  });
  expect(tiles()).toHaveLength(0);
  expect($<HTMLTextAreaElement>('[data-image-composer] textarea')!.value).toBe('');
  // Its card shows the picture (by its upload; the window's resolver turns that into the upload's route) and the file.
  const card = $(`[data-annotation-id="${saved()[0]!.id}"]`)!;
  expect(card.querySelector(`img[src*="${uploaded[0]!.upload_id}"]`)).not.toBeNull();
  expect(card.querySelector('[data-attachment-file]')).not.toBeNull();
  expect(card.querySelector('[data-markup-picture]')).toBeNull();
});

test.skipIf(!hasDom)('a comment of pictures alone shows them on its card and never lays one over the image; a drawing beside them still does', async () => {
  const UPL = 'upl_01JD2Q9V8Y6K3M4N5P7R8S9T0A';
  const added = { path: `${UPL}/legend.png`, name: 'legend' };
  const drawing = { path: '/home/me/.plannotator/inbox/markups/' + 'e'.repeat(64) + '.png', name: 'checkout, marked up' };
  const alone = record({ ...imageCommentAnnotation({ id: 'ann-img-alone', name: shot.name, text: '', markup: null }), images: [added] }, 'ann-img-alone');
  const both = record({ ...imageCommentAnnotation({ id: 'ann-img-both', name: shot.name, text: 'See both.', markup: drawing }), images: [added, drawing] }, 'ann-img-both');
  await render(<Harness attachment={shot} initial={[alone, both]} />);
  const aloneCard = $('[data-annotation-id="ann-img-alone"]')!;
  expect(aloneCard.querySelector('[data-markup-picture]')).toBeNull();
  expect(aloneCard.querySelector(`img[src*="${UPL}"]`)).not.toBeNull();
  await act(async () => aloneCard.click());
  await settle();
  expect($('[data-markup-overlay]')).toBeNull();
  await act(async () => $<HTMLElement>('[data-annotation-id="ann-img-both"]')!.click());
  await settle();
  expect($('[data-showing-markup]')).not.toBeNull();
});

test.skipIf(!hasDom)('a film’s row takes files too: Comment keeps them after its frame, and its card shows them', async () => {
  await render(<Harness attachment={film} />);
  const input = clipInput()!;
  expect(input).not.toBeNull();
  await choose(input, [picture('cut-note.png')]);
  await typeInto($<HTMLTextAreaElement>('[data-image-composer] textarea')!, 'This cut is late.');
  await settle();
  await act(async () => $<HTMLButtonElement>('[data-video-comment-save]')!.click());
  await settle();
  const [comment] = saved();
  const images = comment!.images as { path: string; name: string }[];
  expect(images.at(-1)).toEqual({ path: `${uploaded[0]!.upload_id}/cut-note.png`, name: 'cut-note' });
  expect(tiles()).toHaveLength(0);
  const card = $(`[data-annotation-id="${comment!.id}"]`)!;
  expect(card.querySelector(`[data-comment-added] img[src*="${uploaded[0]!.upload_id}"]`)).not.toBeNull();
});

// ── The review's cases (2026-11-22): uploads still on their way, a refused one, a failed save, the film's ✓ and play. ──

const press = (key: string) => act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })));
const states = () => tiles().map((t) => t.getAttribute('data-compose-file'));

async function openAndDraw() {
  await act(async () => $<HTMLButtonElement>('[data-markup-open]')!.click());
  await settle();
  const stage = $('[data-pn-image-annotator-stage]')!;
  await act(async () => stage.querySelector('img')!.dispatchEvent(new Event('load')));
  const canvas = stage.querySelector('canvas')!;
  for (const [type, x] of [['pointerdown', 10], ['pointermove', 30], ['pointermove', 50], ['pointerup', 50]] as const) {
    await act(async () => canvas.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, clientY: x, pointerId: 1 })));
  }
}

async function renderFilm() {
  stub(HTMLMediaElement.prototype, 'pause', { value: () => {}, writable: true });
  stub(HTMLMediaElement.prototype, 'currentTime', {
    get(this: { _t?: number }) {
      return this._t ?? 0;
    },
    set(this: { _t?: number }, value: number) {
      this._t = value;
    },
  });
  stub(HTMLVideoElement.prototype, 'videoWidth', { get: () => 1920 });
  stub(HTMLVideoElement.prototype, 'videoHeight', { get: () => 1080 });
  await render(<Harness attachment={film} />);
  const video = $<HTMLVideoElement>('video[data-video-player]')!;
  video.currentTime = 102.4;
  await act(async () => video.dispatchEvent(new Event('timeupdate', { bubbles: true })));
}

test.skipIf(!hasDom)('Comment waits while a file uploads; the finished tile says the name the agent gets; a refused one stays out of the comment', async () => {
  await render(<Harness attachment={shot} />);
  const open = holdUploads();
  storedAs = (name) => name.replace('.png', '-2.png');
  await choose(clipInput()!, [picture('shot.png')]);
  await typeInto($<HTMLTextAreaElement>('[data-image-composer] textarea')!, 'Crop it.');
  const save = () => $<HTMLButtonElement>('[data-image-comment-save]')!;
  expect(states()).toEqual(['uploading']);
  expect(save().disabled).toBe(true);
  await open();
  expect(states()).toEqual(['done']);
  expect(tiles()[0]!.getAttribute('data-compose-file-name')).toBe('shot-2.png');
  expect(save().disabled).toBe(false);
  // A refused upload: its tile says so and the comment goes without it.
  refuseUploads = true;
  await choose(clipInput()!, [picture('broken.png')]);
  expect(states()).toEqual(['done', 'refused']);
  await act(async () => save().click());
  await settle();
  expect((saved()[0]!.images as { path: string }[]).map((i) => i.path)).toEqual([`${uploaded[0]!.upload_id}/shot-2.png`]);
});

test.skipIf(!hasDom)('a save that fails keeps the words and the files in the row; the next Comment carries them', async () => {
  await render(<Harness attachment={shot} />);
  await choose(clipInput()!, [picture('legend.png')]);
  await typeInto($<HTMLTextAreaElement>('[data-image-composer] textarea')!, 'The legend is cut off.');
  failSaves = true;
  await act(async () => $<HTMLButtonElement>('[data-image-comment-save]')!.click());
  await settle();
  expect(saved()).toHaveLength(0);
  expect(states()).toEqual(['done']);
  expect($<HTMLTextAreaElement>('[data-image-composer] textarea')!.value).toBe('The legend is cut off.');
  failSaves = false;
  await act(async () => $<HTMLButtonElement>('[data-image-comment-save]')!.click());
  await settle();
  expect((saved()[0]!.images as { name: string }[]).map((i) => i.name)).toEqual(['legend']);
  expect(tiles()).toHaveLength(0);
});

test.skipIf(!hasDom)('the ✓ with words while a file uploads drops nothing: the files stay in the row for the next comment', async () => {
  await render(<Harness attachment={shot} />);
  await choose(clipInput()!, [picture('first.png')]);
  const open = holdUploads();
  await choose(clipInput()!, [picture('second.png')]);
  await typeInto($<HTMLTextAreaElement>('[data-image-composer] textarea')!, 'Like this.');
  await openAndDraw();
  await press('Enter');
  await settle();
  // One file still uploading: none go with the drawing, and none are dropped.
  expect(saved()).toHaveLength(1);
  expect((saved()[0]!.images as { path: string }[]).every((i) => !i.path.startsWith('upl_'))).toBe(true);
  expect(states()).toEqual(['done', 'uploading']);
  await open();
  expect(states()).toEqual(['done', 'done']);
});

test.skipIf(!hasDom)('a film: the ✓ with words while a file uploads keeps the files in the row', async () => {
  await renderFilm();
  const open = holdUploads();
  await choose(clipInput()!, [picture('cut.png')]);
  await typeInto($<HTMLTextAreaElement>('[data-video-composer] textarea')!, 'The logo is clipped.');
  await openAndDraw();
  await press('Enter');
  await settle();
  expect(saved()).toHaveLength(1);
  expect(states()).toEqual(['uploading']);
  await open();
  expect(states()).toEqual(['done']);
});

test.skipIf(!hasDom)('a film: files attached for the note after a wordless ✓ stay when the film plays on', async () => {
  await renderFilm();
  await openAndDraw();
  await press('Enter');
  await settle();
  expect(saved()).toHaveLength(1);
  await choose(clipInput()!, [picture('note.png')]);
  await act(async () => $<HTMLVideoElement>('video[data-video-player]')!.dispatchEvent(new Event('play')));
  expect(states()).toEqual(['done']);
  // Without files the row follows the film again, as before.
  await act(async () => tiles()[0]!.querySelector<HTMLButtonElement>('button')!.click());
  await act(async () => $<HTMLVideoElement>('video[data-video-player]')!.dispatchEvent(new Event('pause')));
  await act(async () => $<HTMLVideoElement>('video[data-video-player]')!.dispatchEvent(new Event('play')));
  expect($('[data-video-composer] [data-markup-kept]') === null).toBe(true);
});

test.skipIf(!hasDom)('closing the file while a file uploads: the upload goes on, and its tile is in the row when the file opens again', async () => {
  await render(<Harness attachment={shot} />);
  const open = holdUploads();
  await choose(clipInput()!, [picture('late.png')]);
  expect(states()).toEqual(['uploading']);
  await act(async () => root?.unmount());
  root = null;
  await open();
  expect(uploaded.map((u) => u.name)).toEqual(['late.png']);
  await render(<Harness attachment={shot} />);
  await settle();
  expect(tiles().map((t) => [t.getAttribute('data-compose-file-name'), t.getAttribute('data-compose-file')])).toEqual([['late.png', 'done']]);
});

// ── The second review's cases (2026-11-22): an upload closed twice, a pin card's files, Put back, a phone's ✓. ──

test.skipIf(!hasDom)('closed, opened and closed again before an upload lands: it is still in the row when the file opens the third time', async () => {
  await render(<Harness attachment={shot} />);
  const open = holdUploads();
  await choose(clipInput()!, [picture('late.png')]);
  await act(async () => root?.unmount());
  // Open again while it is still on its way: no tile yet, and closed again at once.
  await render(<Harness attachment={shot} />);
  expect(tiles()).toHaveLength(0);
  await act(async () => root?.unmount());
  root = null;
  await open();
  await render(<Harness attachment={shot} />);
  await settle();
  expect(tiles().map((t) => [t.getAttribute('data-compose-file-name'), t.getAttribute('data-compose-file')])).toEqual([['late.png', 'done']]);
});

/** A long paste of text alone on `target` (32 KB or more: the reply box's pasted text tile). */
async function pasteWords(target: HTMLElement, words: string) {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: { files: [], items: [{ kind: 'string', type: 'text/plain', getAsFile: () => null }], types: ['text/plain'], getData: (type: string) => (type === 'text/plain' ? words : '') } });
  await act(async () => target.dispatchEvent(event));
  await settle();
}

test.skipIf(!hasDom)('a pasted text put back goes into the comment’s field with the caret after it, and is said as in the reply box', async () => {
  await render(<Harness attachment={shot} />);
  const area = $<HTMLTextAreaElement>('[data-image-composer] textarea')!;
  const LOG = `run 1: ok\n${'x'.repeat(33 * 1024)}`;
  act(() => area.focus());
  await pasteWords(area, LOG);
  expect(tiles()).toHaveLength(1);
  // Typed after the paste: the browser's undo no longer reaches it, only the tile does.
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => {
    const before = new Event('beforeinput', { bubbles: true, cancelable: true });
    Object.defineProperty(before, 'inputType', { value: 'insertText' });
    area.dispatchEvent(before);
    setter.call(area, 'See:');
    area.setSelectionRange(4, 4);
    area.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const back = tiles()[0]!.querySelector<HTMLButtonElement>('[data-pasted-side]')!;
  act(() => back.focus());
  await act(async () => back.click());
  await settle();
  expect(tiles()).toHaveLength(0);
  // Back where it was pasted (before the words typed since), the caret after it.
  expect(area.value).toBe(`${LOG}See:`);
  expect(document.activeElement === area).toBe(true);
  expect(area.selectionStart).toBe(LOG.length);
  expect(document.querySelector('[data-drag-live]')?.textContent).toBe('The pasted text is back in your reply.');
});

test.skipIf(!hasDom)('a phone’s film row: the ✓ with words while a file uploads keeps the row open with the file in it', async () => {
  stub(HTMLMediaElement.prototype, 'pause', { value: () => {}, writable: true });
  stub(HTMLVideoElement.prototype, 'videoWidth', { get: () => 1920 });
  stub(HTMLVideoElement.prototype, 'videoHeight', { get: () => 1080 });
  await render(<PhoneHarness attachment={film} />);
  await act(async () => $<HTMLButtonElement>('[data-video-compose]')!.click());
  await settle();
  const open = holdUploads();
  await choose(clipInput()!, [picture('cut.png')]);
  await typeInto($<HTMLTextAreaElement>('[data-video-composer] textarea')!, 'The logo is clipped.');
  await openAndDraw();
  await press('Enter');
  await settle();
  expect(saved()).toHaveLength(1);
  // Not closed with the file still waiting in it.
  expect($('[data-video-composer]') !== null).toBe(true);
  expect(states()).toEqual(['uploading']);
  await open();
  expect(states()).toEqual(['done']);
  // With no file left in it, the ✓ with words closes the row as before.
  await act(async () => tiles()[0]!.querySelector<HTMLButtonElement>('button')!.click());
  await typeInto($<HTMLTextAreaElement>('[data-video-composer] textarea')!, 'And here.');
  await openAndDraw();
  await press('Enter');
  await settle();
  expect(saved()).toHaveLength(2);
  expect($('[data-video-composer]') === null).toBe(true);
});

/** The pane as a phone draws it outside full screen (no full-screen composer: the film's row opens from "Comment at"). */
function PhoneHarness({ attachment }: { attachment: InboxAttachmentState }) {
  const [records, setRecords] = useState<InboxAnnotationRecord[]>([]);
  const noop = () => {};
  return (
    <CommentFilesContext.Provider value={host_}>
      <div className="pn-inbox">
        <AttachmentPane
          attachment={attachment}
          attachments={[attachment]}
          records={records}
          agent="Claude Code"
          projectName="api"
          projectRoot="/work/api"
          version="current"
          onVersion={noop}
          full={false}
          phone
          onToggleFull={noop}
          focusId={null}
          readOnly={false}
          onSaved={(saved) => setRecords((now) => [...now.filter((r) => r.id !== saved.id), saved])}
          onRemoved={(id) => setRecords((now) => now.filter((r) => r.id !== id))}
          onOpenAt={noop}
          onClose={noop}
          strip={{ picks: 0, annotations: records.length, onWriteReply: noop }}
          onToast={(toast) => toasts.push(toast)}
        />
      </div>
    </CommentFilesContext.Provider>
  );
}

// A phone page's pin card (HtmlPageComment.tsx), held by the hook as the pane holds it.
const { useHtmlPageComment } = (hasDom ? await import('./components/HtmlPageComment') : {}) as typeof import('./components/HtmlPageComment');
type PinCard = ReturnType<typeof import('./components/HtmlPageComment').useHtmlPageComment>;
let pinCard: PinCard | null = null;
function PinCardHarness() {
  const viewer = { current: null };
  pinCard = useHtmlPageComment({ enabled: true, fileKey: 'att_page:current', threadId: null, name: 'report.html', viewer, onSave: async () => true, covered: () => 0, onDone: () => {} });
  return <div className="pn-inbox">{pinCard.card}</div>;
}
/** The uploads come from the provider above the pane, as the thread's. */
function PinCardWorld() {
  return (
    <CommentFilesContext.Provider value={host_}>
      <PinCardHarness />
    </CommentFilesContext.Provider>
  );
}
const pin = (id: string) => ({
  annotation: { id, blockId: '', startOffset: 0, endOffset: 0, type: 'COMMENT', text: '', originalText: '412 ms', createdA: 1 } as never,
  intent: 'compose' as const,
  cancel: () => {},
});
const cardClip = () => $<HTMLInputElement>('[data-html-comment] input[type="file"][data-comment-attach]');
const cardTiles = () => [...document.querySelectorAll<HTMLElement>('[data-html-comment] [data-comment-files] [data-compose-file]')];

test.skipIf(!hasDom)('a phone page’s pin card: its files are kept with it as the file closes (alone too, and still uploading) and come back on its pin', async () => {
  await render(<PinCardWorld />);
  await act(async () => pinCard!.onHostDraft(pin('pin-1')));
  await choose(cardClip()!, [picture('legend.png')]);
  const open = holdUploads();
  await choose(cardClip()!, [picture('late.png')]);
  expect(cardTiles().map((t) => t.getAttribute('data-compose-file'))).toEqual(['done', 'uploading']);
  // The file closes: no words, only files, and the card is kept.
  const kept = pinCard!.kept();
  expect(kept).not.toBeNull();
  expect(kept!.files!.map((f) => f.name)).toEqual(['legend.png']);
  expect(kept!.late).toHaveLength(1);
  await act(async () => root?.unmount());
  root = null;
  await open();
  // Opened again: the page hands the same pin back, and the card holds both files.
  await render(<PinCardWorld />);
  pinCard!.expect(kept!);
  await act(async () => pinCard!.onHostDraft(pin('pin-1')));
  await settle();
  expect(cardTiles().map((t) => [t.getAttribute('data-compose-file-name'), t.getAttribute('data-compose-file')])).toEqual([
    ['legend.png', 'done'],
    ['late.png', 'done'],
  ]);
  expect($<HTMLButtonElement>('[data-html-comment-save]')!.disabled).toBe(false);
});
