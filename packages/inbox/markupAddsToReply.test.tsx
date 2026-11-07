/**
 * Drawing on an image or a video frame (DOM_TESTS=1; approval
 * "inbox-markup-flow"): the drawing screen's ✓ (or Enter) adds the drawing to
 * the reply at once as its own comment, selected, with the window's toast and
 * its Undo; × on the box's picture takes it out; a note goes onto the same
 * comment; a drawing with no words shows its picture as its card (the agent
 * still gets the stand-in words); Escape discards, and a click outside never
 * loses strokes. The drawing screen sits over the whole window (in
 * `.pn-inbox`), not inside the pane.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAnnotationRecord, InboxAttachmentState } from '@plannotator/core/inbox-types';
import { imageCommentAnnotation } from './attachments';
import { MARKUP_ONLY_TEXT } from './markup';
import type { InboxToastModel } from './components/Toast';

const hasDom = typeof document !== 'undefined';
const { AttachmentPane } = (hasDom ? await import('./components/AttachmentPane') : {}) as typeof import('./components/AttachmentPane');
const { VideoAttachmentView } = (hasDom ? await import('./components/VideoAttachmentView') : {}) as typeof import('./components/VideoAttachmentView');

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
/** The thread's records from outside the pane: an edit in the panel, a Send that closes them. */
let setThreadRecords: (update: (now: InboxAnnotationRecord[]) => InboxAnnotationRecord[]) => void = () => {};

/** The pane with its records kept as the thread keeps them (a save upserts, a removal drops). */
function Harness({ attachment, initial = [] }: { attachment: InboxAttachmentState; initial?: InboxAnnotationRecord[] }) {
  const [records, setRecords] = useState(initial);
  setThreadRecords = setRecords;
  const noop = () => {};
  return (
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

/** Open the drawing screen and draw one stroke on it. */
async function openAndDraw() {
  await act(async () => $<HTMLButtonElement>('[data-markup-open]')!.click());
  await settle();
  const stage = $('[data-pn-image-annotator-stage]')!;
  expect(stage).not.toBeNull();
  await act(async () => stage.querySelector('img')!.dispatchEvent(new Event('load')));
  const canvas = stage.querySelector('canvas')!;
  const at = (type: string, x: number, y: number) => canvas.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, clientY: y, pointerId: 1 }));
  await act(async () => at('pointerdown', 10, 10));
  await act(async () => at('pointermove', 30, 20));
  await act(async () => at('pointermove', 50, 30));
  await act(async () => at('pointerup', 50, 30));
}

const press = (key: string) => act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })));
const saved = () => posts.filter((p) => p.url === '/api/inbox/annotations').map((p) => (p.body as { annotation: Record<string, unknown> }).annotation);
const removed = () => posts.filter((p) => p.url.endsWith('/remove')).map((p) => decodeURIComponent(p.url.split('/')[4]!));
const typeInto = async (area: HTMLTextAreaElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(area, value);
    area.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

test.skipIf(!hasDom)('the ✓ adds the drawing to the reply at once: a comment, selected, with the toast; the box keeps its picture and offers a note', async () => {
  await render(<Harness attachment={shot} />);
  await openAndDraw();
  // The drawing screen is over the whole window, not inside the pane (beside the thread it sat under the thread column).
  const overlay = $('[data-pn-image-annotator-stage]')!.closest('.pn-visible-viewport-overlay')!;
  expect(overlay.parentElement!.classList.contains('pn-inbox')).toBe(true);
  expect(overlay.closest('[data-attachment-pane]')).toBeNull();
  expect($('[data-pn-image-annotator-hint]')!.textContent).toBe('Enter or ✓ adds to your reply · Esc cancels');

  await act(async () => $<HTMLButtonElement>('[data-pn-image-annotator-toolbar] button[title^="Save"]')!.click());
  await settle();
  expect($('[data-pn-image-annotator-stage]')).toBeNull();
  const [added] = saved();
  expect(saved()).toHaveLength(1);
  expect(added).toMatchObject({ text: MARKUP_ONLY_TEXT, images: [{ path: MARKED }] });
  // In the reply: its card shows the picture (no stand-in words), and it is selected so the drawing lies on the image.
  const card = $(`[data-annotation-id="${added!.id}"]`)!;
  expect(card.querySelector('[data-markup-picture] img')).not.toBeNull();
  expect(card.textContent).not.toContain(MARKUP_ONLY_TEXT);
  expect($('[data-showing-markup]')).not.toBeNull();
  expect(toasts.map((t) => t.lead)).toEqual(['Markup added to your reply']);
  expect(typeof toasts[0]!.onUndo).toBe('function');
  // The box: the picture with its check and ×, "Note (optional)", Add note waiting for words.
  expect($('[data-image-composer] [data-markup-kept] img')).not.toBeNull();
  expect($<HTMLTextAreaElement>('[data-image-composer] textarea')!.placeholder).toBe('Note (optional)');
  expect($<HTMLButtonElement>('[data-image-comment-save]')!.textContent).toBe('Add note');
  expect($<HTMLButtonElement>('[data-image-comment-save]')!.disabled).toBe(true);
});

test.skipIf(!hasDom)('a note goes onto the same comment; the stand-in words give way to the note', async () => {
  await render(<Harness attachment={shot} />);
  await openAndDraw();
  await press('Enter');
  await settle();
  const id = saved()[0]!.id;
  await typeInto($<HTMLTextAreaElement>('[data-image-composer] textarea')!, 'Make the step dots the heading.');
  await act(async () => $<HTMLButtonElement>('[data-image-comment-save]')!.click());
  await settle();
  expect(saved()).toHaveLength(2);
  expect(saved()[1]).toMatchObject({ id, text: 'Make the step dots the heading.', images: [{ path: MARKED }] });
  expect(document.querySelectorAll('[data-annotation-id]')).toHaveLength(1);
  const card = $(`[data-annotation-id="${id}"]`)!;
  expect(card.textContent).toContain('Make the step dots the heading.');
  expect(card.querySelector('[data-markup-picture]')).toBeNull();
  // The box is clear for the next comment.
  expect($('[data-markup-kept]')).toBeNull();
  expect($<HTMLTextAreaElement>('[data-image-composer] textarea')!.placeholder).toBe('Comment on this image…');
});

test.skipIf(!hasDom)("the toast's Undo and the picture's × each take the drawing out of the reply", async () => {
  await render(<Harness attachment={shot} />);
  await openAndDraw();
  await press('Enter');
  await settle();
  const first = saved()[0]!.id as string;
  await act(async () => toasts[0]!.onUndo!());
  await settle();
  expect(removed()).toEqual([first]);
  expect($(`[data-annotation-id="${first}"]`)).toBeNull();
  expect($('[data-markup-kept]')).toBeNull();

  await openAndDraw();
  await press('Enter');
  await settle();
  const second = saved()[1]!.id as string;
  expect(second).not.toBe(first);
  await act(async () => $<HTMLButtonElement>('[data-markup-kept] [data-markup-remove]')!.click());
  await settle();
  expect(removed()).toEqual([first, second]);
  expect($(`[data-annotation-id="${second}"]`)).toBeNull();
  expect($('[data-markup-kept]')).toBeNull();
});

test.skipIf(!hasDom)('Escape discards the drawing and adds nothing; a click outside keeps strokes and closes only an empty drawing', async () => {
  await render(<Harness attachment={shot} />);
  await openAndDraw();
  const overlay = () => $('[data-pn-image-annotator-stage]')?.closest<HTMLElement>('.pn-visible-viewport-overlay') ?? null;
  // A stray click outside: the drawing stays open.
  await act(async () => overlay()!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await settle();
  expect(overlay()).not.toBeNull();
  await press('Escape');
  await settle();
  expect(overlay()).toBeNull();
  expect(posts).toEqual([]);
  expect(toasts).toEqual([]);
  // An empty drawing: a click outside closes it, and adds nothing.
  await act(async () => $<HTMLButtonElement>('[data-markup-open]')!.click());
  await settle();
  await act(async () => overlay()!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await settle();
  expect(overlay()).toBeNull();
  expect(posts).toEqual([]);
});

test.skipIf(!hasDom)('a drawing with no words shows its picture as its card; with words, the words', async () => {
  const wordless = record(imageCommentAnnotation({ id: 'ann-pic', name: shot.name, text: MARKUP_ONLY_TEXT, markup: { path: MARKED, name: 'checkout, marked up' } }), 'ann-pic');
  const worded = record(imageCommentAnnotation({ id: 'ann-words', name: shot.name, text: 'Bigger total.', markup: { path: MARKED, name: 'checkout, marked up' } }), 'ann-words');
  await render(<Harness attachment={shot} initial={[wordless, worded]} />);
  const pic = $('[data-annotation-id="ann-pic"]')!;
  expect(pic.querySelector('[data-markup-picture] img')!.getAttribute('alt')).toBe('checkout, marked up');
  expect(pic.textContent).not.toContain(MARKUP_ONLY_TEXT);
  const words = $('[data-annotation-id="ann-words"]')!;
  expect(words.querySelector('[data-markup-picture]')).toBeNull();
  expect(words.textContent).toContain('Bigger total.');
});

test.skipIf(!hasDom)('a video frame takes the same flow: Enter adds the marked-up frame at the pinned moment; a note goes onto it', async () => {
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
  await openAndDraw();
  expect($('[data-pn-image-annotator-hint]')!.textContent).toBe('Enter or ✓ adds to your reply · Esc cancels');
  await press('Enter');
  await settle();
  const [added] = saved();
  expect(added).toMatchObject({ blockId: 'video', text: MARKUP_ONLY_TEXT, inboxVideo: { time: 102.4 } });
  expect((added!.images as { name: string }[])[0]!.name).toBe('launch-cut-v3 at 1:42, marked up');
  expect(toasts.map((t) => t.lead)).toEqual(['Markup added to your reply']);
  expect($('[data-video-composer] [data-markup-kept] img')).not.toBeNull();
  const card = $(`[data-annotation-id="${added!.id}"]`)!;
  expect(card.querySelector('[data-markup-picture] img')).not.toBeNull();
  expect(card.querySelector('[data-video-card-time]')!.textContent).toBe('1:42');

  await typeInto($<HTMLTextAreaElement>('[data-video-composer] textarea')!, 'The logo is clipped here.');
  await act(async () => $<HTMLButtonElement>('[data-video-comment-save]')!.click());
  await settle();
  expect(saved()[1]).toMatchObject({ id: added!.id, text: 'The logo is clipped here.', inboxVideo: { time: 102.4 } });
  expect($('[data-markup-kept]')).toBeNull();

  // Undo from the toast takes it out.
  await act(async () => toasts[0]!.onUndo!());
  await settle();
  expect(removed()).toEqual([added!.id as string]);
});

test.skipIf(!hasDom)('a second ✓ or Enter while the drawing uploads adds it once', async () => {
  uploadMs = 40;
  await render(<Harness attachment={shot} />);
  await openAndDraw();
  await press('Enter');
  await press('Enter');
  await act(async () => new Promise((resolve) => setTimeout(resolve, 120)));
  expect(saved()).toHaveLength(1);
  expect(document.querySelectorAll('[data-annotation-id]')).toHaveLength(1);
  expect(toasts).toHaveLength(1);
});

test.skipIf(!hasDom)('a note and a redraw build on the comment as it reads now: words written in the panel stay', async () => {
  await render(<Harness attachment={shot} />);
  await openAndDraw();
  await press('Enter');
  await settle();
  const id = saved()[0]!.id as string;
  // Words written on the card in Annotations meanwhile.
  await act(async () =>
    setThreadRecords((now) => now.map((r) => (r.id === id ? { ...r, annotation: { ...r.annotation, text: 'Panel words' } } : r))),
  );
  // A redraw replaces the picture and keeps the words; no second "added" toast (its Undo would take the whole comment).
  await act(async () => $<HTMLButtonElement>('[data-markup-kept] [data-markup-redraw]')!.click());
  await settle();
  await act(async () => $('[data-pn-image-annotator-stage] img')!.dispatchEvent(new Event('load')));
  const canvas = $('[data-pn-image-annotator-stage] canvas')!;
  for (const [type, x] of [['pointerdown', 5], ['pointermove', 40], ['pointerup', 40]] as const) {
    await act(async () => canvas.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, clientY: x, pointerId: 1 })));
  }
  await press('Enter');
  await settle();
  expect(saved()[1]).toMatchObject({ id, text: 'Panel words', images: [{ path: MARKED }] });
  expect(toasts).toHaveLength(1);
  // A note follows the panel's words.
  await typeInto($<HTMLTextAreaElement>('[data-image-composer] textarea')!, 'Box note');
  await act(async () => $<HTMLButtonElement>('[data-image-comment-save]')!.click());
  await settle();
  expect(saved()[2]).toMatchObject({ id, text: 'Panel words\n\nBox note' });
});

test.skipIf(!hasDom)('once its comment is gone (removed in the panel, or sent), the box lets the drawing go; the next drawing is a new comment', async () => {
  await render(<Harness attachment={shot} />);
  await openAndDraw();
  await press('Enter');
  await settle();
  const first = saved()[0]!.id as string;
  expect($('[data-markup-kept]')).not.toBeNull();
  // The card deleted in the panel, or the reply sent: the record leaves the unsent ones.
  await act(async () => setThreadRecords((now) => now.filter((r) => r.id !== first)));
  await settle();
  // (A boolean: bun cannot print a happy-dom element in a failure.)
  expect($('[data-markup-kept]') !== null).toBe(false);
  expect($<HTMLTextAreaElement>('[data-image-composer] textarea')!.placeholder).toBe('Comment on this image…');
  await openAndDraw();
  await press('Enter');
  await settle();
  expect(saved()).toHaveLength(2);
  expect(saved()[1]!.id).not.toBe(first);
  expect(saved()[1]).toMatchObject({ text: MARKUP_ONLY_TEXT });
});

test.skipIf(!hasDom)("a video's Undo lets go of the selection, as an image's does", async () => {
  stub(HTMLMediaElement.prototype, 'pause', { value: () => {}, writable: true });
  stub(HTMLVideoElement.prototype, 'videoWidth', { get: () => 1920 });
  stub(HTMLVideoElement.prototype, 'videoHeight', { get: () => 1080 });
  const selections: (string | null)[] = [];
  const notices: Omit<InboxToastModel, 'id'>[] = [];
  await render(
    <div className="pn-inbox">
      <VideoAttachmentView
        attachment={film}
        version="current"
        annotations={[]}
        selectedId={null}
        onSelect={(id) => selections.push(id)}
        readOnly={false}
        onSave={async () => true}
        onError={() => {}}
        onRemove={() => {}}
        onNotice={(notice) => notices.push(notice)}
      />
    </div>,
  );
  await openAndDraw();
  await press('Enter');
  await settle();
  expect(notices).toHaveLength(1);
  await act(async () => notices[0]!.onUndo!());
  expect(selections.at(-1)).toBeNull();
});

test('on a phone the drawing’s × is a 44 px target', () => {
  const css = readFileSync(new URL('./inbox.css', import.meta.url), 'utf8');
  const size = Number(/\.pn-inbox \.ib-kept \.ib-kept-x \{[^}]*\bwidth: (\d+)px/.exec(css)![1]);
  const phone = css.slice(css.indexOf('/* the comment box: one row, 44 px targets'));
  const inset = /\.pn-inbox \.ib-kept \.ib-kept-x::after \{ inset: -(\d+)px; \}/.exec(phone);
  expect(inset).not.toBeNull();
  expect(size + 2 * Number(inset![1])).toBeGreaterThanOrEqual(44);
});

/** A film in the pane, paused at 1:42 (happy-dom's media element keeps no time: a plain field stands in). */
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

test.skipIf(!hasDom)('on a video too, a second Enter while the frame uploads adds it once', async () => {
  uploadMs = 40;
  await renderFilm();
  await openAndDraw();
  await press('Enter');
  await press('Enter');
  await act(async () => new Promise((resolve) => setTimeout(resolve, 120)));
  expect(saved()).toHaveLength(1);
  expect(toasts).toHaveLength(1);
});

test.skipIf(!hasDom)("on a video too, a note keeps the panel's words and the moment", async () => {
  await renderFilm();
  await openAndDraw();
  await press('Enter');
  await settle();
  const id = saved()[0]!.id as string;
  await act(async () =>
    setThreadRecords((now) => now.map((r) => (r.id === id ? { ...r, annotation: { ...r.annotation, text: 'Panel words' } } : r))),
  );
  await typeInto($<HTMLTextAreaElement>('[data-video-composer] textarea')!, 'Box note');
  await act(async () => $<HTMLButtonElement>('[data-video-comment-save]')!.click());
  await settle();
  expect(saved()[1]).toMatchObject({ id, text: 'Panel words\n\nBox note', inboxVideo: { time: 102.4 } });
});

/** Two ✓ presses whose encodes finish far apart: the second lands after the first drawing is already in the reply. */
async function twoLateChecks() {
  encodeMs = [5, 120];
  uploadMs = 20;
  const check = $<HTMLButtonElement>('[data-pn-image-annotator-toolbar] button[title^="Save"]')!;
  await act(async () => check.click());
  await act(async () => check.click());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 250)));
}

test.skipIf(!hasDom)('one drawing per opening: a ✓ whose encode lands after the first drawing is in the reply adds nothing', async () => {
  await render(<Harness attachment={shot} />);
  await openAndDraw();
  await twoLateChecks();
  expect(saved()).toHaveLength(1);
  expect(toasts).toHaveLength(1);
  // The next opening takes its drawing (a redraw of the same comment).
  await act(async () => $<HTMLButtonElement>('[data-markup-kept] [data-markup-redraw]')!.click());
  await settle();
  await act(async () => $('[data-pn-image-annotator-stage] img')!.dispatchEvent(new Event('load')));
  const canvas = $('[data-pn-image-annotator-stage] canvas')!;
  for (const [type, x] of [['pointerdown', 5], ['pointermove', 40], ['pointerup', 40]] as const) {
    await act(async () => canvas.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, clientY: x, pointerId: 1 })));
  }
  await press('Enter');
  await settle();
  expect(saved()).toHaveLength(2);
  expect(saved()[1]!.id).toBe(saved()[0]!.id);
});

test.skipIf(!hasDom)('on a video too, one drawing per opening, however late the second ✓', async () => {
  await renderFilm();
  await openAndDraw();
  await twoLateChecks();
  expect(saved()).toHaveLength(1);
  expect(toasts).toHaveLength(1);
});

test.skipIf(!hasDom)('playing on never drops a redraw that is waiting to be saved', async () => {
  await renderFilm();
  await openAndDraw();
  await press('Enter');
  await settle();
  expect(saved()).toHaveLength(1);
  // A redraw the server refuses: it waits in the row, to go with the note.
  failSaves = true;
  await act(async () => $<HTMLButtonElement>('[data-video-composer] [data-markup-redraw]')!.click());
  await settle();
  await openAndDrawAgain();
  await press('Enter');
  await settle();
  failSaves = false;
  const video = $<HTMLVideoElement>('video[data-video-player]')!;
  await act(async () => video.dispatchEvent(new Event('play')));
  // (Booleans: bun cannot print a happy-dom element in a failure.)
  expect($('[data-video-composer] [data-markup-kept]') !== null).toBe(true);
  expect($<HTMLButtonElement>('[data-video-comment-save]')!.disabled).toBe(false);
  await act(async () => $<HTMLButtonElement>('[data-video-comment-save]')!.click());
  await settle();
  const last = saved().at(-1)!;
  expect(last.id).toBe(saved()[0]!.id);
  expect((last.images as { name: string }[])[0]!.name).toMatch(/marked up$/);
});

/** Draw on the drawing screen already open (a redraw). */
async function openAndDrawAgain() {
  await act(async () => $('[data-pn-image-annotator-stage] img')!.dispatchEvent(new Event('load')));
  const canvas = $('[data-pn-image-annotator-stage] canvas')!;
  for (const [type, x] of [['pointerdown', 5], ['pointermove', 40], ['pointerup', 40]] as const) {
    await act(async () => canvas.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, clientY: x, pointerId: 1 })));
  }
}
