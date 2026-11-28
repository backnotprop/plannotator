/**
 * Dictation holds who gets the reply (thread/replyAim.ts, the owner's decision of 2026-11-21, "Yes, follow until I
 * type or pick"). In a thread with more than one agent an empty reply box follows the agent that wrote last; a take
 * under way is words on their way into the box, so the choice holds from the press of the mic. The failure this
 * catches: the person dictates to the agent the chip named, another agent writes while it records or transcribes, and
 * the words land, and go, to that other agent.
 *
 * No microphone and no transcription service: the window's own seam (voice.ts `browserDeps`) gets a scripted
 * recorder, a clock the test moves and an answer the test gives (as voiceKeptWords.test.tsx does).
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxMessageWire, InboxProject, InboxThread } from '@plannotator/core/inbox-types';
import type { TaggableSession } from './api';
import type { VoiceAnswer, VoiceDeps } from './voiceSession';

const hasDom = typeof document !== 'undefined';
const { ThreadPane } = (hasDom ? await import('./components/Thread') : {}) as typeof import('./components/Thread');
const { adoptVoiceSettings, browserDeps } = (hasDom ? await import('./voice') : {}) as typeof import('./voice');

const noop = () => {};
const PROJECT: InboxProject = { id: 'prj_1', key: 'orders-abcdef', name: 'orders', root: '/work/orders', created_at: '2026-11-01T10:00:00.000Z' };
const CLAUDE = { kind: 'agent' as const, host: 'claude-code', session: 'ses_claude', name: null };
const PI = { kind: 'agent' as const, host: 'pi', session: 'ses_pi', name: null };
const M1 = 'msg_01M4H6G73M9H3Z32T859E72DPY';
const M2 = 'msg_01M4H7AAAAAAAAAAAAAAAAAAAA';
const M3 = 'msg_01M4H7BBBBBBBBBBBBBBBBBBBB';

const message = (id: string, author: InboxMessageWire['author'], minute: number): InboxMessageWire => ({
  id,
  project_id: PROJECT.id,
  thread_id: M1,
  reply_to: id === M1 ? null : M1,
  author,
  subject: id === M1 ? 'Order summary' : null,
  body: `Message ${id.slice(-4)}.`,
  created_at: `2026-11-01T10:${String(minute).padStart(2, '0')}:00.000Z`,
  resolved_at: null,
  idempotency_key: null,
  wakes: true,
});
const threadOf = (...messages: InboxMessageWire[]): InboxThread => ({ thread_id: M1, project: PROJECT, subject: 'Order summary', thread_name: null, resolved_at: null, messages });
const tagged = (session: string, host: string): TaggableSession => ({ session, host, kind: 'live', name: null, project: PROJECT, started_at: null, last_at: '2026-11-01T10:50:00.000Z', busy: false, idle_since: null, taggable: true, owner: false, wrote_thread: true });

let root: Root | null = null;
let host: HTMLElement | null = null;
let restore: (() => void)[] = [];
let tick: (() => void) | null = null;
let clock = 1000;
let answer: ((value: VoiceAnswer) => void) | null = null;
let posted: { path: string; body: Record<string, unknown> }[] = [];

beforeEach(() => {
  if (!hasDom) return;
  tick = null;
  answer = null;
  posted = [];
  const deps: Partial<VoiceDeps> = {
    open: async () => ({ rate: 24_000, db: () => -20, stop: async () => [new Float32Array(2400).fill(0.2)], abort: noop, onEnded: noop }),
    prompts: async () => false,
    transcribe: () => new Promise<VoiceAnswer>((resolve) => (answer = resolve)),
    now: () => clock,
    every: (_ms, run) => {
      tick = run;
      return () => (tick = null);
    },
    after: () => noop,
  };
  const had = { ...browserDeps };
  Object.assign(browserDeps, deps);
  const savedFetch = globalThis.fetch;
  const live = [tagged('ses_claude', 'claude-code'), tagged('ses_pi', 'pi')];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
      posted.push({ path, body });
      if (path.endsWith('/draft')) return Response.json({ draft: { v: 1, thread_id: M1, body: String(body.body ?? ''), created_at: '2026-11-01T10:40:00.000Z', updated_at: new Date().toISOString(), ...(body.recipients ? { recipients: body.recipients } : {}) } });
      if (path.endsWith('/reply')) return Response.json({ reply: {}, questions: [], replayed: false });
      return Response.json({ questions: [] });
    }
    if (path.includes('/voice/status')) return Response.json({ state: 'ready', plan: null });
    if (path.includes('/taggable')) return Response.json({ serverSession: 's', owner: null, sessions: live });
    if (path.includes('/attachments')) return Response.json({ serverSession: 's', attachments: [], annotations: [] });
    if (path.includes('/sessions')) {
      const sessions = live.map((t) => ({ session: t.session, host: t.host, started_at: t.last_at, last_seen_at: t.last_at, busy: false, idle_since: null, wrote_thread: true }));
      return Response.json({ serverSession: 's', home: '/home/me', project: PROJECT, sessions });
    }
    return Response.json({});
  }) as typeof fetch;
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => ({}) } });
  const hadWorklet = (globalThis as Record<string, unknown>).AudioWorkletNode;
  (globalThis as Record<string, unknown>).AudioWorkletNode = class {};
  adoptVoiceSettings({ on: true, phones_only: false, engine: 'codex', key: { source: null, last4: null }, computer: null, intro_due: false });
  restore.push(() => {
    Object.assign(browserDeps, had);
    globalThis.fetch = savedFetch;
    (globalThis as Record<string, unknown>).AudioWorkletNode = hadWorklet;
    for (const [owner, name] of [[window, 'isSecureContext'], [navigator, 'mediaDevices']] as const) delete (owner as unknown as Record<string, unknown>)[name];
    adoptVoiceSettings(null);
  });
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  while (restore.length > 0) restore.pop()!();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

const pointer = (el: Element, type: 'pointerdown' | 'pointerup') => act(() => void el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerId: 1 })));
const draw = (thread: InboxThread) =>
  root!.render(
    <div className="pn-inbox">
      <ThreadPane thread={thread} sent={null} onQuestions={noop} onChanged={async () => {}} onClose={noop} file={null} onOpenFile={noop} onOpenGuide={noop} />
    </div>,
  );
const named = (el: HTMLElement) => el.querySelector('[data-recipient] .ib-rto-full')?.textContent ?? null;
const field = (el: HTMLElement) => el.querySelector('textarea:not([data-question-other])') as HTMLTextAreaElement | null;

test.skipIf(!hasDom)('a take under way holds the choice: another agent writes while it records and while it transcribes, and the words land and go to the agent the chip named', async () => {
  let thread = threadOf(message(M1, CLAUDE, 41), message(M2, PI, 45));
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    draw(thread);
  });
  await settle();
  const reply = [...host.querySelectorAll('.ib-pfoot button')].find((b) => b.textContent?.trim() === 'Reply') as HTMLButtonElement;
  await act(async () => reply.click());
  await settle();
  expect(named(host)).toBe('Pi');
  const mic = host.querySelector('[data-voice-mic]')!;
  pointer(mic, 'pointerdown');
  await settle();
  for (let i = 0; i < 12; i++) {
    clock += 40;
    act(() => tick?.());
  }
  expect(field(host)!.value).toBe('');
  // Recording, the box still empty: Claude Code writes.
  thread = { ...thread, messages: [...thread.messages, message(M3, CLAUDE, 47)] };
  act(() => draw(thread));
  await settle();
  expect(named(host)).toBe('Pi');
  pointer(mic, 'pointerup');
  await settle();
  expect(answer).not.toBeNull();
  // Transcribing: still Pi.
  expect(named(host)).toBe('Pi');
  await act(async () => answer!({ text: 'Use the old totals.' }));
  await settle();
  expect(field(host)!.value).toContain('Use the old totals.');
  expect(named(host)).toBe('Pi');
  await act(async () => ([...host!.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Send') as HTMLButtonElement).click());
  await settle();
  const replies = posted.filter((p) => p.path.endsWith('/reply'));
  expect(replies.map((r) => r.path.split('/').at(-2))).toEqual([M2]);
});
