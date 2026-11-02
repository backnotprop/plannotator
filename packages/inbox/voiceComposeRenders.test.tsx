/**
 * Dictating in New message re-renders nothing at audio rate, and words that land are one change, not one per word. The
 * level reaches the screen by direct writes (voiceSession.ts `subscribeMeter`), so a host that subscribed to the meter
 * would cost a whole dialog 30 times a second, and a phone would feel it. A production build has no render count, so
 * this holds the real dialog in a Profiler, with a microphone made of plain objects and a fake answer from the Inbox.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, Profiler } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const hasDom = typeof document !== 'undefined';
const { ComposeDialog } = (hasDom ? await import('./compose/ComposeDialog') : {}) as typeof import('./compose/ComposeDialog');
const { adoptVoiceSettings } = (hasDom ? await import('./voice') : {}) as typeof import('./voice');

const WORDS = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');

let root: Root | null = null;
let host: HTMLElement | null = null;
let commits = 0;
let ticks = 0;
const saved: Record<string, unknown> = {};

/** What the recorder reads: a level that comes and goes, as speech does, one reading per tick of the session. */
class FakeContext {
  sampleRate = 24_000;
  destination = {};
  audioWorklet = { addModule: async () => {} };
  resume = async () => {};
  close = async () => {};
  createMediaStreamSource = () => ({ connect: () => {} });
  createAnalyser = () => ({
    fftSize: 1024,
    connect: () => {},
    getFloatTimeDomainData: (level: Float32Array) => {
      ticks += 1;
      level.fill(ticks % 6 < 3 ? 0.2 : 0.0002);
    },
  });
}

class FakeWorklet {
  port: { onmessage: ((event: { data: unknown }) => void) | null; postMessage: (message: string) => void };
  constructor() {
    const port = {
      onmessage: null as ((event: { data: unknown }) => void) | null,
      postMessage: () => {
        port.onmessage?.({ data: new Float32Array(240) });
        port.onmessage?.({ data: 'flushed' });
      },
    };
    this.port = port;
  }
  connect() {}
}

beforeEach(() => {
  if (!hasDom) return;
  commits = 0;
  ticks = 0;
  for (const name of ['AudioContext', 'AudioWorkletNode', 'fetch']) saved[name] = (globalThis as Record<string, unknown>)[name];
  Object.assign(globalThis, { AudioContext: FakeContext, AudioWorkletNode: FakeWorklet });
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => ({ getTracks: () => [], getAudioTracks: () => [] }) } });
  Object.defineProperty(navigator, 'permissions', { configurable: true, value: { query: async () => ({ state: 'granted' }) } });
  globalThis.fetch = (async (input: RequestInfo | URL) => (String(input).includes('/voice/transcribe') ? Response.json({ text: WORDS }) : Response.json({ state: 'ready', plan: null }))) as typeof fetch;
  adoptVoiceSettings({ on: true, phones_only: false, engine: 'codex', key: { source: null, last4: null }, computer: null, intro_due: false, guest: false });
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  adoptVoiceSettings(null);
  Object.assign(globalThis, saved);
  for (const [owner, name] of [[window, 'isSecureContext'], [navigator, 'mediaDevices'], [navigator, 'permissions']] as const) delete (owner as unknown as Record<string, unknown>)[name];
});

const until = async (done: () => boolean) => {
  for (let i = 0; i < 400 && !done(); i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  expect(done()).toBe(true);
};

const press = (button: Element, type: string) => {
  act(() => {
    button.dispatchEvent(new window.PointerEvent(type, { bubbles: true, button: 0 }));
  });
};

async function openDialog() {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const transport = {
    sessions: async () => ({ serverSession: 's', home: '/tmp', projects: [] }),
    startThread: async () => ({ thread_id: 'thr_1' }),
    drafts: false,
    uploads: false,
  };
  await act(async () => {
    root!.render(
      <Profiler id="compose" onRender={() => (commits += 1)}>
        <ComposeDialog request={{}} phone current={null} lastSent={null} home={null} transport={transport} onSent={() => {}} onSaved={() => {}} onDeleted={() => {}} onClose={() => {}} />
      </Profiler>,
    );
  });
  await until(() => host!.querySelector('[data-voice-mic]') !== null);
  return host.querySelector('[data-voice-mic]')!;
}

describe.skipIf(!hasDom)('dictating in New message', () => {
  test('a second of listening costs the clock, not a render per tick', async () => {
    const button = await openDialog();
    press(button, 'pointerdown');
    press(button, 'pointerup');
    await until(() => host!.querySelector('[data-voice-line="tap"]') !== null);

    commits = 0;
    const from = ticks;
    await until(() => ticks - from >= 30);
    expect(commits, `${commits} commits over ${ticks - from} ticks`).toBeLessThanOrEqual(3);
  });

  test('forty words landing are one change, not forty', async () => {
    const button = await openDialog();
    press(button, 'pointerdown');
    press(button, 'pointerup');
    await until(() => host!.querySelector('[data-voice-line="tap"]') !== null);
    await until(() => ticks >= 12);

    commits = 0;
    const field = host!.querySelector('textarea')!;
    let changes = 0;
    field.addEventListener('input', () => (changes += 1));
    press(button, 'pointerdown');
    press(button, 'pointerup');
    await until(() => field.value === WORDS);
    expect(changes).toBe(1);
    expect(commits, `${commits} commits for 40 words`).toBeLessThan(12);
  });
});
