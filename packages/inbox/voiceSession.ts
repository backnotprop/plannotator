/**
 * One composer's dictation, press to words in the box. No React and no direct browser audio: it talks to a recorder
 * and a field through `VoiceDeps`, which is what lets every path be tested without a microphone.
 *
 * `view()` is the coarse state: it changes a few times a recording, and a host re-renders on it. `meter()` changes on
 * every tick and is read by the bars and the caret through `subscribeMeter`, so a thread never re-renders at audio rate.
 *
 * What must stay true: it never sends. It puts text in the field and stops; the person presses Send. While `view()`
 * is not idle the host keeps Send off. Starting a recording in one composer cancels one running in another.
 */
import { createVoiceGate, encodeWav } from './voiceAudio';
import { HOLD_MS, type VoicePressTarget } from './voicePress';
import type { VoiceRecorder } from './voiceRecorder';
import type { InboxVoiceEngine, InboxVoiceFailure, InboxVoiceStatus } from '@plannotator/core/inbox-types';

export const VOICE_CAP_MS = 120_000;
/** From here the time counts down. */
export const VOICE_COUNTDOWN_MS = 105_000;
/** Tap mode, after speech: this much quiet stops it. */
export const VOICE_QUIET_STOP_MS = 15_000;
export const VOICE_QUIET_WARN_MS = 10_000;
/** Nothing heard for this long says so. */
export const VOICE_NO_VOICE_MS = 1_500;
/** A breath between words is still voice. */
const HANGOVER_MS = 220;
const TICK_MS = 33;
const BAR_MS = 70;
/** The newest of the level's history; a phone shows the last few. */
export const VOICE_BARS = 32;
const QUIET_BAR = 0.08;
const WASH_FADES_MS = 1300;
const WASH_ENDS_MS = 2300;

export type VoicePhase = 'idle' | 'opening' | 'listening' | 'sending';

/** Why the last press ended without words. Kept in `VoiceView` until the next press, a Discard or, for those with no clip, typing. */
export type VoiceTrouble = 'notheard' | 'blocked' | 'micfailed' | 'nothing' | 'expired' | 'refused' | 'keyrefused' | 'offline' | 'inboxgone' | 'codexfailed' | 'notready' | 'voiceoff';

export interface VoiceView {
  phase: VoicePhase;
  /** The browser is asking for the microphone. */
  prompting: boolean;
  /** Null until the press resolves into a hold or a tap. */
  mode: 'hold' | 'tap' | null;
  /** A hold slid off the button: letting go cancels. */
  armed: boolean;
  trouble: VoiceTrouble | null;
  /** The engine that answered, for words that name it. */
  engine: InboxVoiceEngine | null;
  /** A clip is kept for Retry. */
  kept: boolean;
  clipMs: number;
  /** Where the words will land. */
  caret: number;
  /** The words that just landed. */
  wash: { start: number; end: number; fading: boolean } | null;
  /** For a screen reader. */
  said: string;
}

export interface VoiceMeter {
  elapsedMs: number;
  /** 0 to 1, smoothed. */
  level: number;
  voice: boolean;
  voiceSeen: boolean;
  quietMs: number;
  bars: { height: number; voice: boolean }[];
}

/** The textarea, as the session needs it (voiceField.ts). */
export interface VoiceField {
  selection(): { start: number; end: number };
  text(): string;
  /** A Send on its way holds the field. */
  readOnly(): boolean;
  focus(): void;
  select(start: number, end: number): void;
  /** Put the words at the cursor; answers where they went. */
  insert(words: string): { start: number; end: number };
  watch(onCaret: () => void, onInput: () => void): () => void;
}

export type VoiceAnswer = { text: string } | { code: InboxVoiceFailure | null; engine?: InboxVoiceEngine; reason?: InboxVoiceStatus['state'] };

export interface VoiceDeps {
  open(): Promise<VoiceRecorder>;
  prompts(): Promise<boolean>;
  /** Throws when the Inbox could not be reached. */
  transcribe(clip: Blob, signal: AbortSignal): Promise<VoiceAnswer>;
  /** The Inbox says this computer is not ready after all. */
  notReady(state: InboxVoiceStatus['state']): void;
  now(): number;
  every(ms: number, run: () => void): () => void;
  after(ms: number, run: () => void): () => void;
}

export interface VoiceSession extends VoicePressTarget {
  view(): VoiceView;
  meter(): VoiceMeter;
  subscribe(listener: () => void): () => void;
  subscribeMeter(listener: () => void): () => void;
  /** Give the session its field; the returned function drops everything, a clip included, and any answer still on its way. */
  attach(field: VoiceField): () => void;
  stop(): void;
  cancel(): void;
  retry(): void;
  discard(): void;
}

const IDLE: VoiceView = { phase: 'idle', prompting: false, mode: null, armed: false, trouble: null, engine: null, kept: false, clipMs: 0, caret: 0, wash: null, said: '' };

const TROUBLE: Record<InboxVoiceFailure, { trouble: VoiceTrouble; keeps: boolean }> = {
  voice_expired: { trouble: 'expired', keeps: true },
  voice_refused: { trouble: 'refused', keeps: true },
  voice_key_refused: { trouble: 'keyrefused', keeps: true },
  voice_unreachable: { trouble: 'offline', keeps: true },
  voice_codex_failed: { trouble: 'codexfailed', keeps: true },
  voice_not_ready: { trouble: 'notready', keeps: true },
  voice_off: { trouble: 'voiceoff', keeps: false },
  voice_empty: { trouble: 'nothing', keeps: false },
  voice_bad_clip: { trouble: 'nothing', keeps: false },
};

/** The one recording in this window. */
let recording: { drop(): void } | null = null;

const freshMeter = (): VoiceMeter => ({ elapsedMs: 0, level: 0, voice: false, voiceSeen: false, quietMs: 0, bars: Array.from({ length: VOICE_BARS }, () => ({ height: QUIET_BAR, voice: false })) });

export function createVoiceSession(deps: VoiceDeps): VoiceSession {
  let view = IDLE;
  let meter = freshMeter();
  const listeners = new Set<() => void>();
  const meterListeners = new Set<() => void>();
  let field: VoiceField | null = null;
  let recorder: VoiceRecorder | null = null;
  let clip: Blob | null = null;
  let abort: AbortController | null = null;
  /** Bumped by anything that ends a run: an older run's late answer finds a different number and does nothing. */
  let run = 0;
  let pressed = false;
  let pressedAt = 0;
  /** The press that will stop a tap-mode recording, once it lets go. */
  let secondPress = false;
  /** Started from the keyboard: focus stays on the button, or Space would type instead of stopping. */
  let keepFocus = false;
  let before: { start: number; end: number; text: string } | null = null;
  let startedAt = 0;
  let lastTick = 0;
  let lastBar = 0;
  let lastVoiceAt = Number.NEGATIVE_INFINITY;
  let gate = createVoiceGate();
  let stopTicking: (() => void) | null = null;
  let stopWatching: (() => void) | null = null;
  let washTimers: (() => void)[] = [];

  const set = (next: Partial<VoiceView>) => {
    view = { ...view, ...next };
    const wanted = view.phase !== 'idle' || view.wash !== null || view.trouble !== null;
    if (wanted && !stopWatching && field) stopWatching = field.watch(onCaret, onInput);
    if (!wanted && stopWatching) {
      stopWatching();
      stopWatching = null;
    }
    for (const listener of listeners) listener();
  };

  const onCaret = () => {
    if (!field || view.phase === 'idle') return;
    const { start } = field.selection();
    if (start !== view.caret) set({ caret: start });
  };
  const onInput = () => {
    onCaret();
    // The field changed under the wash, and a line with nothing to retry has been read.
    if (view.wash) clearWash();
    if (view.trouble && !view.kept) set({ trouble: null });
  };

  const clearWash = () => {
    for (const cancel of washTimers) cancel();
    washTimers = [];
    if (view.wash) set({ wash: null });
  };

  const release = () => {
    stopTicking?.();
    stopTicking = null;
    recorder?.abort();
    recorder = null;
    abort?.abort();
    abort = null;
    pressed = false;
    secondPress = false;
    if (recording === handle) recording = null;
  };

  /** Esc, Cancel, or a slide off: the box is as it was. Words typed meanwhile stay; only then does the caret stay too. */
  const cancel = () => {
    if (view.phase === 'idle') return;
    run++;
    release();
    clip = null;
    set({ ...IDLE, said: 'Cancelled' });
    if (!field) return;
    if (before && field.text() === before.text) field.select(before.start, before.end);
    if (!keepFocus) field.focus();
  };

  const handle = {
    drop: () => {
      run++;
      release();
      clip = null;
      set({ ...IDLE });
    },
  };

  const tick = () => {
    if (view.phase !== 'listening' || !recorder) return;
    const now = deps.now();
    const passed = now - lastTick;
    lastTick = now;
    meter.elapsedMs = now - startedAt;
    const heard = gate(recorder.db());
    meter.level = meter.level * 0.6 + heard.level * 0.4;
    if (heard.voice) {
      lastVoiceAt = now;
      meter.voiceSeen = true;
    }
    meter.voice = now - lastVoiceAt < HANGOVER_MS;
    meter.quietMs = meter.voice ? 0 : meter.quietMs + passed;
    if (now - lastBar >= BAR_MS) {
      lastBar = now;
      meter.bars.shift();
      meter.bars.push({ height: meter.voice ? Math.max(0.16, meter.level) : QUIET_BAR, voice: meter.voice });
    }
    if (view.mode === null && pressed && meter.elapsedMs >= HOLD_MS) set({ mode: 'hold' });
    for (const listener of meterListeners) listener();
    if (meter.elapsedMs >= VOICE_CAP_MS) stop();
    else if (view.mode === 'tap' && meter.voiceSeen && meter.quietMs >= VOICE_QUIET_STOP_MS) stop();
  };

  const begin = () => {
    meter = freshMeter();
    gate = createVoiceGate();
    startedAt = deps.now();
    lastTick = startedAt;
    lastBar = startedAt;
    lastVoiceAt = Number.NEGATIVE_INFINITY;
    // The prompt took the press away, or the finger came up while the mic opened: a tap.
    set({ phase: 'listening', prompting: false, mode: view.prompting || !pressed ? 'tap' : null, armed: false, said: 'Listening' });
    stopTicking = deps.every(TICK_MS, tick);
  };

  const start = (fromKeyboard: boolean) => {
    if (!field || field.readOnly()) {
      pressed = false;
      return;
    }
    if (recording !== handle) recording?.drop();
    recording = handle;
    keepFocus = fromKeyboard;
    for (const cancelTimer of washTimers) cancelTimer();
    washTimers = [];
    clip = null;
    const mine = ++run;
    const selection = field.selection();
    before = { ...selection, text: field.text() };
    if (!fromKeyboard) field.focus();
    set({ ...IDLE, phase: 'opening', caret: selection.start });
    // In the press, before any wait: see openVoiceRecorder.
    const opening = deps.open();
    void deps.prompts().then((prompts) => {
      if (prompts && mine === run && view.phase === 'opening') set({ prompting: true, said: 'Asking for the microphone' });
    });
    opening.then(
      (opened) => {
        if (mine !== run) {
          opened.abort();
          return;
        }
        recorder = opened;
        opened.onEnded(() => {
          if (mine === run) stop();
        });
        begin();
      },
      (cause: unknown) => {
        if (mine !== run) return;
        release();
        const name = (cause as { name?: string } | null)?.name;
        set({ ...IDLE, trouble: name === 'NotAllowedError' || name === 'SecurityError' ? 'blocked' : 'micfailed', said: 'The microphone did not start' });
      },
    );
  };

  const stop = () => {
    if (view.phase !== 'listening' || !recorder) return;
    const mine = run;
    const taken = recorder;
    recorder = null;
    stopTicking?.();
    stopTicking = null;
    pressed = false;
    secondPress = false;
    if (recording === handle) recording = null;
    if (!meter.voiceSeen) {
      taken.abort();
      set({ ...IDLE, trouble: 'notheard', said: 'Nothing was sent' });
      return;
    }
    set({ phase: 'sending', mode: null, armed: false, clipMs: meter.elapsedMs, said: 'Transcribing' });
    void taken.stop().then((chunks) => {
      if (mine !== run) return;
      clip = encodeWav(chunks, taken.rate);
      void send();
    });
  };

  const send = async () => {
    if (!clip) return;
    const mine = run;
    const leaving = new AbortController();
    abort = leaving;
    if (view.phase !== 'sending') {
      const selection = field?.selection();
      set({ phase: 'sending', trouble: null, kept: false, caret: selection?.start ?? 0, said: 'Transcribing' });
    }
    let answer: VoiceAnswer;
    try {
      answer = await deps.transcribe(clip, leaving.signal);
    } catch {
      answer = { code: null };
    }
    if (mine !== run || !field) return;
    abort = null;
    if ('text' in answer) {
      const place = field.insert(answer.text);
      clip = null;
      set({ ...IDLE, wash: { ...place, fading: false }, said: 'Text added at the cursor' });
      washTimers = [
        deps.after(WASH_FADES_MS, () => {
          if (view.wash) set({ wash: { ...view.wash, fading: true } });
        }),
        deps.after(WASH_ENDS_MS, clearWash),
      ];
      return;
    }
    // Not one of this route's codes: the answer came from something other than a working Inbox, a restarted one among them.
    const known = answer.code ? TROUBLE[answer.code] : { trouble: 'inboxgone' as const, keeps: true };
    if (!known.keeps) clip = null;
    if (answer.code === 'voice_not_ready' && answer.reason) deps.notReady(answer.reason);
    set({ ...IDLE, trouble: known.trouble, engine: answer.engine ?? null, kept: known.keeps, clipMs: view.clipMs, said: 'Dictation failed' });
  };

  const session: VoiceSession = {
    view: () => view,
    meter: () => meter,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeMeter: (listener) => {
      meterListeners.add(listener);
      return () => meterListeners.delete(listener);
    },
    attach: (next) => {
      field = next;
      return () => {
        handle.drop();
        for (const cancelTimer of washTimers) cancelTimer();
        washTimers = [];
        stopWatching?.();
        stopWatching = null;
        field = null;
      };
    },
    press: () => {
      if (view.phase === 'listening' && view.mode === 'tap') {
        secondPress = true;
        return;
      }
      if (view.phase !== 'idle') return;
      pressed = true;
      pressedAt = deps.now();
      start(false);
    },
    release: () => {
      if (secondPress) {
        secondPress = false;
        stop();
        return;
      }
      if (!pressed) return;
      pressed = false;
      if (view.phase !== 'listening') return;
      if (view.armed) cancel();
      // Held from the moment it was listening: the time the mic took to open was no talking.
      else if (deps.now() - Math.max(pressedAt, startedAt) < HOLD_MS) set({ mode: 'tap' });
      else stop();
    },
    slide: (off) => {
      if (pressed && view.phase === 'listening' && view.mode !== 'tap' && off !== view.armed) set({ armed: off });
    },
    lost: () => {
      secondPress = false;
      if (!pressed) return;
      pressed = false;
      if (view.phase === 'listening' && view.mode !== 'tap') cancel();
    },
    toggle: () => {
      if (view.phase === 'listening') stop();
      else if (view.phase === 'idle') start(true);
    },
    stop,
    cancel,
    retry: () => {
      if (view.phase === 'idle' && clip) void send();
    },
    discard: () => {
      clip = null;
      set({ ...IDLE });
    },
  };
  return session;
}
