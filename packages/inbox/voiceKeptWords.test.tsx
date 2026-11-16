/**
 * Dictated words are never lost by moving on while the take is out of sight or still being transcribed:
 * - full screen's Hide tools (the card gathered into the corner) stops a running recording, so no microphone stays
 *   open unseen, and what was said so far is transcribed into the reply;
 * - closing the thread's reply box while it says Transcribing keeps the take going: its words land in the draft;
 * - a take belongs to the thread it was said in: another thread's box never gets its words, its line or its failure;
 * - Discard is the person dropping the reply, the take with it: nothing lands afterwards.
 *
 * No microphone and no transcription service: the window's own seam (voice.ts `browserDeps`) gets a scripted
 * recorder, a clock the test moves and an answer the test gives.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxMessageWire, InboxProject, InboxThread } from '@plannotator/core/inbox-types';
import type { FullScreenComposerValue } from './components/FullScreenComposer';
import type { VoiceAnswer, VoiceDeps, VoiceLate } from './voiceSession';

const hasDom = typeof document !== 'undefined';
const { FullScreenComposer } = (hasDom ? await import('./components/FullScreenComposer') : {}) as typeof import('./components/FullScreenComposer');
const { resetComposerState } = (hasDom ? await import('./fullScreenComposer') : {}) as typeof import('./fullScreenComposer');
const { ThreadPane } = (hasDom ? await import('./components/Thread') : {}) as typeof import('./components/Thread');
const { adoptVoiceSettings, browserDeps } = (hasDom ? await import('./voice') : {}) as typeof import('./voice');
const { rememberMachine, resetMachineRoutes } = (hasDom ? await import('./inboxUrl') : {}) as typeof import('./inboxUrl');
const { LATE_VOICE_MISSED, clearLateVoiceMiss } = (hasDom ? await import('./lateVoice') : {}) as typeof import('./lateVoice');

const noop = () => {};
let root: Root | null = null;
let host: HTMLElement | null = null;
let restore: (() => void)[] = [];
let mic: string[] = [];
let tick: (() => void) | null = null;
let clock = 1000;
let answer: ((value: VoiceAnswer) => void) | null = null;
let posted: { path: string; body: Record<string, unknown> }[] = [];

beforeEach(() => {
  if (!hasDom) return;
  mic = [];
  tick = null;
  answer = null;
  posted = [];
  const deps: Partial<VoiceDeps> = {
    open: async () => ({
      rate: 24_000,
      db: () => -20,
      stop: async () => {
        mic.push('stopped');
        return [new Float32Array(2400).fill(0.2)];
      },
      abort: () => mic.push('aborted'),
      onEnded: noop,
    }),
    prompts: async () => false,
    transcribe: () => {
      mic.push('transcribing');
      return new Promise<VoiceAnswer>((resolve) => (answer = resolve));
    },
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
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
      posted.push({ path, body });
      if (path.endsWith('/draft')) return Response.json({ draft: { v: 1, thread_id: THREAD, body: String(body.body ?? ''), created_at: STAMP, updated_at: new Date().toISOString() } });
      return Response.json({ message: {} });
    }
    if (path.includes('/voice/status')) return Response.json({ state: 'ready', plan: null });
    if (path.includes('/attachments')) return Response.json({ serverSession: 's', attachments: [], annotations: [] });
    if (path.includes('/sessions')) return Response.json({ serverSession: 's', home: '/home/me', project: PROJECT, sessions: [] });
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
  resetComposerState?.();
  resetMachineRoutes?.();
  clearLateVoiceMiss?.(THREAD);
  clearLateVoiceMiss?.(OTHER);
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

/** Hold the mic and speak past a hold: the session is listening and has heard a voice. */
async function speak(button: Element): Promise<void> {
  pointer(button, 'pointerdown');
  await settle();
  expect(tick).not.toBeNull();
  for (let i = 0; i < 12; i++) {
    clock += 40;
    act(() => tick?.());
  }
}

async function hear(text: string): Promise<void> {
  expect(answer).not.toBeNull();
  await act(async () => answer!({ text }));
  await settle();
}

const THREAD = 'msg_01M4XXVG0ZCPSD10B1KPG7DPMB';
const OTHER = 'msg_01M4XXVG0ZCPSD10B1KPG7DPMZ';
const STAMP = '2026-10-16T17:00:00.000Z';
const PROJECT: InboxProject = { id: 'prj_1', key: 'ledger-abcdef', name: 'ledger', root: '/work/ledger', created_at: STAMP };

describe.skipIf(!hasDom)("full screen's Hide tools", () => {
  let gather: (tucked: boolean) => void = noop;
  let words = '';
  let late: VoiceLate[] = [];

  function Harness({ corner = true }: { corner?: boolean }) {
    const [tucked, setTucked] = useState(false);
    const [text, setText] = useState('');
    gather = setTucked;
    words = text;
    const value: FullScreenComposerValue = {
      threadId: 'thr_voice',
      phone: false,
      tucked,
      onGather: corner ? () => setTucked(true) : undefined,
      fileKey: 'att_a:current',
      reply: {
        to: 'Claude Code',
        value: text,
        onChange: setText,
        onLateVoice: (outcome) => late.push(outcome),
        onSend: noop,
        sending: false,
        canSend: false,
        picks: 0,
        annotations: 0,
        comments: { records: [], attachments: [], onEdit: async () => {}, onRemove: async () => {}, onOpen: noop, editing: null, onEditing: noop, list: null, onList: noop } as unknown as FullScreenComposerValue['reply']['comments'],
        actions: 0,
        files: [],
        onFiles: noop,
        onDropFiles: noop,
        onPaste: noop,
        onRemoveFile: noop,
        onPutBack: noop,
        openQuestions: 0,
        openActions: 0,
        conflict: false,
        error: null,
        sentAt: null,
        onOpenThread: noop,
      },
    };
    return <FullScreenComposer value={value} noun="page" comment={null} />;
  }

  test('stops the recording, so no mic runs unseen, and what was said lands in the reply', async () => {
    host = document.createElement('div');
    host.className = 'pn-inbox';
    document.body.appendChild(host);
    act(() => {
      root = createRoot(host!);
      root.render(<Harness />);
    });
    await settle();
    await speak(host.querySelector('[data-fcomp] [data-voice-mic]')!);
    expect(mic).toEqual([]);
    act(() => gather(true));
    await settle();
    expect(mic).toEqual(['stopped', 'transcribing']);
    expect(tick).toBeNull();
    await hear('said before hiding');
    expect(words).toContain('said before hiding');
  });

  test('with no corner control, minimizing the card stops the recording before the card goes, and its words reach the reply', async () => {
    late = [];
    host = document.createElement('div');
    host.className = 'pn-inbox';
    document.body.appendChild(host);
    act(() => {
      root = createRoot(host!);
      root.render(<Harness corner={false} />);
    });
    await settle();
    await speak(host.querySelector('[data-fcomp] [data-voice-mic]')!);
    await act(async () => (host!.querySelector('[data-fcomp-minimize]') as HTMLButtonElement).click());
    await settle();
    expect(host.querySelector('[data-fcomp]')).toBeNull();
    expect(mic).toEqual(['stopped', 'transcribing']);
    await hear('said before minimizing');
    expect(late).toEqual([{ text: 'said before minimizing' }]);
  });
});

describe.skipIf(!hasDom)("the thread's reply box while it says Transcribing", () => {
  function thread(): InboxThread {
    const asked: InboxMessageWire = {
      id: THREAD,
      project_id: PROJECT.id,
      thread_id: THREAD,
      reply_to: null,
      author: { kind: 'agent', host: 'claude-code', name: 'Claude Code', session: 'ses_a' },
      subject: 'Shipped the migration',
      subject_question: null,
      body: 'Shipped the migration. Anything else?',
      created_at: STAMP,
      resolved_at: null,
      idempotency_key: null,
    };
    return { thread_id: THREAD, project: PROJECT, subject: asked.subject, thread_name: null, resolved_at: null, messages: [asked] };
  }

  const other = (): InboxThread => ({ ...thread(), thread_id: OTHER, messages: thread().messages.map((m) => ({ ...m, id: OTHER, thread_id: OTHER })) });
  const show = (value: InboxThread) =>
    act(() => {
      root!.render(
        <div className="pn-inbox">
          <ThreadPane thread={value} sent={null} onQuestions={noop} onChanged={async () => {}} onClose={noop} file={null} onOpenFile={noop} onOpenGuide={noop} />
        </div>,
      );
    });
  const openBox = async (el: HTMLElement) => {
    const reply = [...el.querySelectorAll('.ib-pfoot button')].find((b) => /^(Reply|Edit draft)$/.test(b.textContent?.trim() ?? '')) as HTMLButtonElement;
    await act(async () => reply.click());
    await settle();
  };
  const boxText = (el: HTMLElement) => (el.querySelector('textarea:not([data-question-other])') as HTMLTextAreaElement | null)?.value ?? '';

  /** The thread with its reply box open, the mic held and listening. */
  async function recording(): Promise<HTMLElement> {
    host = document.createElement('div');
    document.body.appendChild(host);
    act(() => {
      root = createRoot(host!);
    });
    show(thread());
    await settle();
    await openBox(host);
    await speak(host.querySelector('[data-voice-mic]')!);
    expect(host.querySelector('[data-voice-line="hold"]')).not.toBeNull();
    expect(mic).toEqual([]);
    return host;
  }

  /** The thread with its reply box open, a take transcribing in it. */
  async function transcribing(): Promise<HTMLElement> {
    host = document.createElement('div');
    document.body.appendChild(host);
    act(() => {
      root = createRoot(host!);
      root.render(
        <div className="pn-inbox">
          <ThreadPane thread={thread()} sent={null} onQuestions={noop} onChanged={async () => {}} onClose={noop} file={null} onOpenFile={noop} onOpenGuide={noop} />
        </div>,
      );
    });
    await settle();
    const reply = [...host.querySelectorAll('.ib-pfoot button')].find((b) => /^(Reply|Edit draft)$/.test(b.textContent?.trim() ?? '')) as HTMLButtonElement;
    await act(async () => reply.click());
    await settle();
    const button = host.querySelector('[data-voice-mic]')!;
    await speak(button);
    pointer(button, 'pointerup');
    await settle();
    expect(mic).toEqual(['stopped', 'transcribing']);
    expect(host.querySelector('[data-voice-line="sending"]')).not.toBeNull();
    return host;
  }

  const draftSaves = () => posted.filter((p) => p.path === `/api/inbox/threads/${THREAD}/draft`).map((p) => String(p.body.body ?? ''));

  test('closing the box keeps the take: its words land in the draft when they come', async () => {
    const el = await transcribing();
    await act(async () => (el.querySelector('[data-reply-close]') as HTMLButtonElement).click());
    await settle();
    expect(el.querySelector('textarea:not([data-question-other])')).toBeNull();
    await hear('dictated words');
    expect(draftSaves().some((body) => body.includes('dictated words'))).toBe(true);
  });

  test('another thread opened meanwhile: the words go to the draft of the thread they were said in', async () => {
    const el = await transcribing();
    show(other());
    await settle();
    await hear('dictated words');
    expect(draftSaves().some((body) => body.includes('dictated words'))).toBe(true);
    expect(posted.some((p) => p.path.includes(OTHER) && String(p.body.body ?? '').includes('dictated words'))).toBe(false);
    expect(boxText(el)).not.toContain('dictated words');
  });

  test("another thread's box opened before the words come: it starts clean, and the words still go to their own thread's draft", async () => {
    const el = await transcribing();
    show(other());
    await settle();
    await openBox(el);
    expect(el.querySelectorAll('[data-voice-line]').length).toBe(0);
    await hear('dictated words');
    expect(boxText(el)).not.toContain('dictated words');
    expect(posted.some((p) => p.path.includes(OTHER) && String(p.body.body ?? '').includes('dictated words'))).toBe(false);
    expect(draftSaves().some((body) => body.includes('dictated words'))).toBe(true);
  });

  test('a take that fails after the person moved to another thread says so in its own thread, not in the one open', async () => {
    const el = await transcribing();
    show(other());
    await settle();
    await openBox(el);
    expect(answer).not.toBeNull();
    await act(async () => answer!({ code: 'voice_refused' }));
    await settle();
    expect(el.textContent).not.toContain(LATE_VOICE_MISSED);
    show(thread());
    await settle();
    expect(el.textContent).toContain(LATE_VOICE_MISSED);
  });

  test("another machine's thread (no draft here): the words wait in the page and come back when its box opens", async () => {
    rememberMachine([THREAD], 'ibx_01M4XXVG0ZCPSD10B1KPG7DPMB');
    const el = await transcribing();
    await act(async () => (el.querySelector('[data-reply-close]') as HTMLButtonElement).click());
    await settle();
    await hear('dictated words');
    expect(el.textContent).not.toContain(LATE_VOICE_MISSED);
    await openBox(el);
    expect(boxText(el)).toContain('dictated words');
  });

  test('another thread opened mid-recording: the mic stops, the other box starts clean, and what was said goes to its own draft', async () => {
    const el = await recording();
    show(other());
    await settle();
    expect(mic).toEqual(['stopped', 'transcribing']);
    expect(tick).toBeNull();
    await openBox(el);
    expect(el.querySelectorAll('[data-voice-line]').length).toBe(0);
    await hear('said while recording');
    expect(boxText(el)).not.toContain('said while recording');
    expect(posted.some((p) => p.path.includes(OTHER) && String(p.body.body ?? '').includes('said while recording'))).toBe(false);
    expect(draftSaves().some((body) => body.includes('said while recording'))).toBe(true);
  });

  test('the thread left mid-recording (the pane goes): the mic stops and what was said goes to its draft', async () => {
    await recording();
    act(() => root!.render(<div className="pn-inbox" />));
    await settle();
    expect(mic).toEqual(['stopped', 'transcribing']);
    await hear('said while recording');
    expect(draftSaves().some((body) => body.includes('said while recording'))).toBe(true);
  });

  const cover = () =>
    act(() => {
      root!.render(
        <div className="pn-inbox">
          <ThreadPane thread={thread()} covered sent={null} onQuestions={noop} onChanged={async () => {}} onClose={noop} file={null} onOpenFile={noop} onOpenGuide={noop} />
        </div>,
      );
    });

  test('a cover mid-recording, speech already heard: the mic closes and nothing is posted', async () => {
    await recording();
    cover();
    await settle();
    expect(mic).toEqual(['aborted']);
    expect(answer).toBeNull();
    expect(posted.filter((p) => p.path.includes('/voice/'))).toEqual([]);
  });

  test('a cover while it says Transcribing: the take goes on and lands in the box under the cover', async () => {
    const el = await transcribing();
    cover();
    await settle();
    await hear('dictated words');
    expect(boxText(el)).toContain('dictated words');
  });

  test("closing the box mid-recording lets the take go, as New message's close does", async () => {
    const el = await recording();
    await act(async () => (el.querySelector('[data-reply-close]') as HTMLButtonElement).click());
    await settle();
    expect(mic).toEqual(['aborted']);
    expect(answer).toBeNull();
  });

  test('Discard drops the take with the reply: nothing lands afterwards', async () => {
    const el = await transcribing();
    const discard = el.querySelector('[data-reply-discard]') as HTMLButtonElement;
    expect(discard).not.toBeNull();
    await act(async () => discard.click());
    await settle();
    if (answer) await hear('dictated words');
    expect(draftSaves().some((body) => body.includes('dictated words'))).toBe(false);
  });
});
