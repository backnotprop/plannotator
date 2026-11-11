import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAnnotationRecord, InboxAttachmentState } from '@plannotator/core/inbox-types';
import { attachmentFeedback, videoCommentAnnotation } from './attachments';
import { AUDIO_PEAK_BARS, audioPeaksOf } from './components/AudioPlayer';

const hasDom = typeof document !== 'undefined';
const { AttachmentPane } = (hasDom ? await import('./components/AttachmentPane') : {}) as typeof import('./components/AttachmentPane');
const { AttachmentTiles } = (hasDom ? await import('./components/AttachmentTiles') : {}) as typeof import('./components/AttachmentTiles');

let root: Root | null = null;
let host: HTMLElement | null = null;
const realFetch = globalThis.fetch;
const restores: (() => void)[] = [];

function stub<T extends object>(target: T, key: string, descriptor: PropertyDescriptor) {
  const previous = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, ...descriptor });
  restores.push(() => (previous ? Object.defineProperty(target, key, previous) : delete (target as Record<string, unknown>)[key]));
}

let paused = 0;
let played = 0;
beforeEach(() => {
  paused = 0;
  played = 0;
  if (!hasDom) return;
  // happy-dom's media element neither plays nor keeps a time: plain fields stand in, and the events fire as a browser's do.
  stub(HTMLMediaElement.prototype, 'paused', {
    get(this: { _paused?: boolean }) {
      return this._paused ?? true;
    },
  });
  stub(HTMLMediaElement.prototype, 'play', {
    value(this: HTMLMediaElement & { _paused?: boolean }) {
      played += 1;
      this._paused = false;
      this.dispatchEvent(new Event('play'));
      return Promise.resolve();
    },
    writable: true,
  });
  stub(HTMLMediaElement.prototype, 'pause', {
    value(this: HTMLMediaElement & { _paused?: boolean }) {
      paused += 1;
      const was = this._paused === false;
      this._paused = true;
      if (was) this.dispatchEvent(new Event('pause'));
    },
    writable: true,
  });
  stub(HTMLMediaElement.prototype, 'currentTime', {
    get(this: { _t?: number }) {
      return this._t ?? 0;
    },
    set(this: { _t?: number }, value: number) {
      this._t = value;
    },
  });
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = realFetch;
  for (const restore of restores.splice(0).reverse()) restore();
});

async function render(node: React.ReactNode) {
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(node);
  });
}

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 20)));

const take: InboxAttachmentState = {
  id: 'att_01K7AAAAAAAAAAAAAAAAAAAAAA',
  name: 'take-2.mp3',
  path: '/work/launch-site/audio/take-2.mp3',
  named_path: null,
  kind: 'audio',
  media_type: 'audio/mpeg',
  duration_ms: 83_000,
  sent_sha256: 'b'.repeat(64),
  size: 1_328_000,
  sent_at: '2026-11-09T10:42:00.000Z',
  sent_mtime: '2026-11-09T10:42:00.000Z',
  message_id: 'msg_01K7ZZZZZZZZZZZZZZZZZZZZZZ',
  current: { sha256: 'b'.repeat(64), size: 1_328_000, mtime: '2026-11-09T10:42:00.000Z' },
  changed_since_sent: false,
  unavailable: null,
};

function record(annotation: object, id: string, created = 1): InboxAnnotationRecord {
  return {
    id,
    project_id: 'prj_x',
    thread_id: 'msg_x',
    message_id: take.message_id,
    attachment_id: take.id,
    path: take.path,
    version: 'current',
    annotation: { ...annotation, createdA: created } as Record<string, unknown>,
    created_at: take.sent_at,
    updated_at: take.sent_at,
    removed_at: null,
    sent_reply_id: null,
  };
}

const later = record(videoCommentAnnotation({ id: 'ann-vid-b', name: take.name, time: 61, text: 'The music drowns the last line.' }), 'ann-vid-b', 1);
const earlier = record(videoCommentAnnotation({ id: 'ann-vid-a', name: take.name, time: 12.5, text: 'Say "three steps", not "a few".' }), 'ann-vid-a', 2);

function pane(records: InboxAnnotationRecord[], extra: Record<string, unknown> = {}, attachment: InboxAttachmentState = take) {
  const noop = () => {};
  return (
    <AttachmentPane
      attachment={attachment}
      attachments={[attachment]}
      records={records}
      agent="Claude"
      projectName="launch-site"
      projectRoot="/work/launch-site"
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
      strip={{ picks: 0, annotations: records.length, onWriteReply: noop }}
      {...extra}
    />
  );
}

const notFound = (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch;

test.skipIf(!hasDom)('the tile reads "MP3 audio · 1:23 · size" and offers Play', async () => {
  await render(<AttachmentTiles attachments={[take]} annotationCounts={new Map([[take.path, 2]])} onOpen={() => {}} />);
  const tile = host!.querySelector<HTMLButtonElement>(`button[data-attachment-id="${take.id}"]`)!;
  expect(tile.getAttribute('data-attachment-kind')).toBe('audio');
  expect(tile.querySelector('.ib-kd')!.textContent).toBe('MP3 audio · 1:23 · 2 comments · 1.3 MB');
  expect(tile.querySelector('.ib-open')!.textContent).toBe('Play');
  expect(tile.getAttribute('aria-label')).toBe(`Play ${take.name}`);
  expect(tile.querySelector('[data-icon="music"]')).not.toBeNull();
});

test.skipIf(!hasDom)('the pane plays it from its audio route in its own player; play, the bar and each comment dot seek', async () => {
  globalThis.fetch = notFound;
  await render(pane([later, earlier]));
  const audio = host!.querySelector<HTMLAudioElement>('audio[data-video-player]')!;
  expect(audio.getAttribute('src')).toBe(`/api/inbox/attachments/${take.id}/audio`);
  expect(audio.hasAttribute('controls')).toBe(false);
  expect(host!.querySelector('video')).toBeNull();
  expect(host!.querySelector('.ib-vhead .ib-from')!.textContent).toBe('1:23');
  expect(host!.querySelector('.ib-audmeta')!.textContent).toBe('MP3 audio · 1:23');

  const play = host!.querySelector<HTMLButtonElement>('[data-audio-play]')!;
  expect(play.getAttribute('aria-label')).toBe('Play');
  await act(async () => play.click());
  expect(played).toBe(1);
  expect(play.getAttribute('aria-label')).toBe('Pause');
  await act(async () => play.click());
  expect(play.getAttribute('aria-label')).toBe('Play');

  const bar = host!.querySelector<HTMLElement>('[data-audio-scrub]')!;
  expect(bar.getAttribute('role')).toBe('slider');
  expect(bar.getAttribute('aria-valuemax')).toBe('83');
  const pausesBefore = paused;
  await act(async () => bar.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
  expect(audio.currentTime).toBe(5);
  await act(async () => bar.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })));
  expect(audio.currentTime).toBe(83);
  expect(paused).toBe(pausesBefore);
  expect(host!.querySelector('[data-video-time-now]')!.textContent).toBe('1:23 / 1:23');

  const dots = [...host!.querySelectorAll<HTMLButtonElement>('[data-video-dot]')];
  expect(dots.map((d) => d.getAttribute('data-video-dot'))).toEqual(['ann-vid-a', 'ann-vid-b']);
  expect(dots[0]!.style.left).toBe(`${(12.5 / 83) * 100}%`);
  await act(async () => dots[1]!.click());
  expect(audio.currentTime).toBe(61);
  expect(dots[1]!.className).toContain('ib-on');
  const panel = host!.querySelector('[data-annotation-panel]')!;
  expect(panel.querySelector('[data-annotation-panel-note]')!.textContent).toBe('By time');
  const pills = [...host!.querySelectorAll<HTMLButtonElement>('[data-video-card-time]')];
  expect(pills.map((p) => p.textContent)).toEqual(['0:12', '1:01']);
  expect(panel.querySelector('[data-video-card-frame]')).toBeNull();
  await act(async () => pills[0]!.click());
  expect(audio.currentTime).toBe(12.5);
});

test.skipIf(!hasDom)('typing pauses and pins the moment; Comment saves a comment at that time, with no frame and no Mark up', async () => {
  const posts: { url: string; body: unknown }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/inbox/annotations') {
      const body = JSON.parse(String(init?.body));
      posts.push({ url, body });
      return Response.json({ annotation: record(body.annotation, body.annotation.id) });
    }
    posts.push({ url, body: null });
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
  await render(pane([]));
  expect(host!.querySelector('[data-markup-open]')).toBeNull();
  const audio = host!.querySelector<HTMLAudioElement>('audio[data-video-player]')!;
  await act(async () => host!.querySelector<HTMLButtonElement>('[data-audio-play]')!.click());
  audio.currentTime = 42.75;
  await act(async () => audio.dispatchEvent(new Event('timeupdate', { bubbles: true })));
  const area = host!.querySelector<HTMLTextAreaElement>('[data-video-composer] textarea')!;
  expect(area.placeholder).toBe('Comment at 0:42…');
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(area, 'Breath noise before this word');
    area.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
  expect(paused).toBeGreaterThan(0);
  expect(host!.querySelector<HTMLButtonElement>('[data-audio-play]')!.getAttribute('aria-label')).toBe('Play');
  const chip = host!.querySelector<HTMLButtonElement>('[data-video-time]')!;
  expect(chip.hasAttribute('data-pinned')).toBe(true);
  expect(chip.textContent).toBe('0:42');
  expect(host!.querySelector('[data-video-frame]')).toBeNull();
  expect(host!.querySelector('[data-video-draft-dot]')).not.toBeNull();

  await act(async () => host!.querySelector<HTMLButtonElement>('[data-video-comment-save]')!.click());
  await settle();
  expect(posts.filter((p) => p.url.startsWith('/api/inbox/markups'))).toEqual([]);
  const saved = (posts.find((p) => p.url === '/api/inbox/annotations')!.body as { annotation: Record<string, unknown> }).annotation;
  expect(saved).toMatchObject({
    blockId: 'video',
    type: 'COMMENT',
    text: 'Breath noise before this word',
    originalText: 'take-2.mp3 at 0:42',
    inboxVideo: { time: 42.75 },
  });
  expect(saved.images).toBeUndefined();
  expect(host!.querySelector<HTMLTextAreaElement>('[data-video-composer] textarea')!.value).toBe('');
});

test.skipIf(!hasDom)('the waveform is drawn from the decoded peaks of a small file; a large one keeps the plain bar and is never fetched', async () => {
  const fetched: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    fetched.push(url);
    if (url.endsWith('/audio')) return new Response(new Uint8Array(64));
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
  const samples = new Float32Array(8000).map((_, i) => Math.sin(i / 10) * (i / 8000));
  stub(globalThis, 'OfflineAudioContext', {
    value: class {
      decodeAudioData() {
        return Promise.resolve({ numberOfChannels: 1, getChannelData: () => samples });
      }
    },
    writable: true,
  });
  await render(pane([], {}, { ...take, id: 'att_01K7AAAAAAAAAAAAAAAAAAAAAB' }));
  await settle();
  const bar = host!.querySelector('[data-audio-scrub]')!;
  expect(bar.hasAttribute('data-waveform')).toBe(true);
  expect(bar.querySelectorAll('rect').length).toBe(AUDIO_PEAK_BARS * 2);
  expect(fetched).toContain('/api/inbox/attachments/att_01K7AAAAAAAAAAAAAAAAAAAAAB/audio');

  act(() => root!.unmount());
  host!.remove();
  fetched.length = 0;
  const big = { ...take, id: 'att_01K7AAAAAAAAAAAAAAAAAAAAAC', size: 300_000_000, current: { ...take.current!, size: 300_000_000 } };
  await render(pane([], {}, big));
  await settle();
  expect(host!.querySelector('[data-audio-scrub]')!.hasAttribute('data-waveform')).toBe(false);
  expect(host!.querySelector('[data-audio-scrub] .ib-audline')).not.toBeNull();
  expect(fetched.filter((url) => url.endsWith('/audio'))).toEqual([]);
});

test.skipIf(!hasDom)('a recording the browser cannot play shows the Download card', async () => {
  globalThis.fetch = notFound;
  stub(HTMLMediaElement.prototype, 'error', { get: () => ({ code: 4, message: 'unsupported' }) });
  await render(pane([]));
  await act(async () => host!.querySelector('audio')!.dispatchEvent(new Event('error')));
  const card = host!.querySelector('[data-video-unplayable]')!;
  expect(card.textContent).toContain('This recording’s format can’t play here');
  expect(card.querySelector('a')!.getAttribute('href')).toBe(`/api/inbox/attachments/${take.id}/download`);
});

test.skipIf(!hasDom)('a phone: its length and comment count under the bar, the comments listed, and "Comment at" opens the row', async () => {
  globalThis.fetch = notFound;
  await render(pane([later, earlier], { phone: true }));
  expect(host!.querySelector('[data-video-meta]')!.textContent).toContain('1:23');
  expect(host!.querySelector('[data-video-meta]')!.textContent).toContain('2 comments');
  expect([...host!.querySelectorAll('[data-video-card] .ib-vtime')].map((t) => t.textContent)).toEqual(['0:12', '1:01']);
  expect(host!.querySelector('[data-video-composer]')).toBeNull();
  const compose = host!.querySelector<HTMLButtonElement>('[data-video-compose]')!;
  expect(compose.textContent).toBe('Comment at 0:00');
  await act(async () => compose.click());
  await settle();
  expect(host!.querySelector('[data-video-composer] textarea')).not.toBeNull();
  expect(host!.querySelector('[data-markup-open]')).toBeNull();
});

test('the reply carries each comment at its moment, as a film\'s does', () => {
  const feedback = attachmentFeedback([later, earlier], [take], new Map(), '/work/launch-site');
  expect(feedback).toContain('## audio/take-2.mp3');
  const first = feedback.indexOf('### 1. Feedback on: "take-2.mp3 at 0:12"\nAt 0:12 (12.5 s of 1:23)\n> Say "three steps", not "a few".');
  const second = feedback.indexOf('### 2. Feedback on: "take-2.mp3 at 1:01"\nAt 1:01 (61 s of 1:23)\n> The music drowns the last line.');
  expect(first).toBeGreaterThan(-1);
  expect(second).toBeGreaterThan(first);
  const unknown = attachmentFeedback([earlier], [{ ...take, duration_ms: undefined }], new Map(), '/work/launch-site');
  expect(unknown).toContain('At 0:12 (12.5 s)\n');
});

test('the waveform\'s peaks: the loudest of each slice against the loudest of all, silence a thin line', () => {
  const quiet = new Float32Array(400);
  const loud = new Float32Array(400).fill(0.5);
  const peaks = audioPeaksOf([Float32Array.from([...quiet, ...loud])], 4);
  expect(peaks).toEqual([0.04, 0.04, 1, 1]);
  expect(audioPeaksOf([new Float32Array(4).fill(0.1), Float32Array.from([0, 0, 0.8, 0.8])], 2)).toEqual([Math.pow(0.1 / 0.8, 0.7), 1]);
  expect(audioPeaksOf([], 4)).toEqual([]);
  expect(audioPeaksOf([new Float32Array(10)], 2)).toEqual([0.04, 0.04]);
});
