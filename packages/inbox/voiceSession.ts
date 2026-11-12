import { createVoiceGate, encodeWav } from './voiceAudio';
import { HOLD_MS, type VoicePoint, type VoicePressTarget } from './voicePress';
import type { VoiceRecorder } from './voiceRecorder';
import type { InboxVoiceEngine, InboxVoiceFailure, InboxVoiceStatus } from '@plannotator/core/inbox-types';

export const VOICE_CAP_MS = 120_000;
export const VOICE_COUNTDOWN_MS = 105_000;
export const VOICE_QUIET_STOP_MS = 15_000;
export const VOICE_QUIET_WARN_MS = 10_000;
export const VOICE_NO_VOICE_MS = 1_500;
const HANGOVER_MS = 220;
const TICK_MS = 33;
const BAR_MS = 70;
export const VOICE_BARS = 32;
const QUIET_BAR = 0.08;
export const VOICE_OPENING_SLOW_MS = 150;
export const VOICE_OPENING_GIVE_UP_MS = 10_000;
export const VOICE_ASKING_GIVE_UP_MS = 30_000;
const WASH_FADES_MS = 1300;
const WASH_ENDS_MS = 2300;

export type VoicePhase = 'idle' | 'opening' | 'listening' | 'sending';

export const VOICE_TROUBLE_CODES = ['notheard', 'blocked', 'micfailed', 'nothing', 'badclip', 'expired', 'refused', 'keyrefused', 'offline', 'inboxgone', 'codexfailed', 'notready', 'voiceoff', 'failed'] as const;

export type VoiceTrouble = (typeof VOICE_TROUBLE_CODES)[number];

export interface VoiceView {
  phase: VoicePhase;
  prompting: boolean;
  slow: boolean;
  mode: 'hold' | 'tap' | null;
  trouble: VoiceTrouble | null;
  engine: InboxVoiceEngine | null;
  kept: boolean;
  clipMs: number;
  caret: number;
  wash: { start: number; end: number; fading: boolean } | null;
  said: string;
}

export interface VoiceMeter {
  elapsedMs: number;
  level: number;
  voice: boolean;
  voiceSeen: boolean;
  quietMs: number;
  bars: { height: number; voice: boolean }[];
}

export interface VoiceField {
  selection(): { start: number; end: number };
  text(): string;
  readOnly(): boolean;
  focus(): void;
  select(start: number, end: number): void;
  insert(words: string): { start: number; end: number };
  watch(onCaret: () => void, onInput: () => void): () => void;
}

export type VoiceAnswer = { text: string } | { code: InboxVoiceFailure | null; engine?: InboxVoiceEngine; reason?: InboxVoiceStatus['state'] };

export interface VoiceDeps {
  open(signal: AbortSignal): Promise<VoiceRecorder>;
  prompts(): Promise<boolean>;
  transcribe(clip: Blob, signal: AbortSignal): Promise<VoiceAnswer>;
  notReady(state: InboxVoiceStatus['state']): void;
  now(): number;
  every(ms: number, run: () => void): () => void;
  after(ms: number, run: () => void): () => void;
  note?(ev: 'voice_press' | 'voice_phase', fields: Record<string, unknown>): void;
}

export type VoiceLate = { text: string } | { failed: true; retry: (() => void) | null };

export interface VoiceSession extends VoicePressTarget {
  view(): VoiceView;
  meter(): VoiceMeter;
  subscribe(listener: () => void): () => void;
  subscribeMeter(listener: () => void): () => void;
  attach(field: VoiceField): () => void;
  stop(): void;
  cancel(): void;
  covered(): void;
  retry(): void;
  discard(): void;
}

const IDLE: VoiceView = { phase: 'idle', prompting: false, slow: false, mode: null, trouble: null, engine: null, kept: false, clipMs: 0, caret: 0, wash: null, said: '' };

const TROUBLE: Record<InboxVoiceFailure, { trouble: VoiceTrouble; keeps: boolean }> = {
  voice_expired: { trouble: 'expired', keeps: true },
  voice_refused: { trouble: 'refused', keeps: true },
  voice_key_refused: { trouble: 'keyrefused', keeps: true },
  voice_unreachable: { trouble: 'offline', keeps: true },
  voice_codex_failed: { trouble: 'codexfailed', keeps: true },
  voice_not_ready: { trouble: 'notready', keeps: true },
  voice_off: { trouble: 'voiceoff', keeps: false },
  voice_empty: { trouble: 'nothing', keeps: false },
  voice_bad_clip: { trouble: 'badclip', keeps: false },
};
const UNKNOWN_FAILURE = { trouble: 'failed', keeps: true } as const;

let recording: { drop(): void } | null = null;

const freshMeter = (): VoiceMeter => ({ elapsedMs: 0, level: 0, voice: false, voiceSeen: false, quietMs: 0, bars: Array.from({ length: VOICE_BARS }, () => ({ height: QUIET_BAR, voice: false })) });

export function createVoiceSession(deps: VoiceDeps, late?: (outcome: VoiceLate) => void): VoiceSession {
  let view = IDLE;
  let meter = freshMeter();
  const listeners = new Set<() => void>();
  const meterListeners = new Set<() => void>();
  let field: VoiceField | null = null;
  let recorder: VoiceRecorder | null = null;
  let clip: Blob | null = null;
  let abort: AbortController | null = null;
  let opener: AbortController | null = null;
  let openTimers: (() => void)[] = [];
  const clearOpenTimers = () => {
    for (const cancelTimer of openTimers) cancelTimer();
    openTimers = [];
  };
  let run = 0;
  let pressed = false;
  let pressedAt = 0;
  let secondPress = false;
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

  const note = (ev: 'voice_press' | 'voice_phase', fields: Record<string, unknown>) => {
    try {
      deps.note?.(ev, fields);
    } catch {
    }
  };

  const set = (next: Partial<VoiceView>) => {
    const was = view;
    view = { ...view, ...next };
    if (was.phase !== view.phase || was.mode !== view.mode || was.prompting !== view.prompting || was.slow !== view.slow || was.trouble !== view.trouble) {
      note('voice_phase', { phase: view.phase, mode: view.mode ?? undefined, prompting: view.prompting, slow: view.slow, trouble: view.trouble ?? undefined });
    }
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
    opener?.abort();
    opener = null;
    clearOpenTimers();
    pressed = false;
    secondPress = false;
    if (recording === handle) recording = null;
  };

  const cancel = (refocus = true) => {
    if (view.phase === 'idle') return;
    run++;
    release();
    clip = null;
    set({ ...IDLE, said: 'Cancelled' });
    if (!field) return;
    if (before && field.text() === before.text) field.select(before.start, before.end);
    if (refocus && !keepFocus) field.focus();
  };

  const failedUnseen = (keeps: boolean) => {
    if (field || listeners.size > 0) return false;
    if (!keeps) clip = null;
    set({ ...IDLE });
    late?.({ failed: true, retry: keeps ? () => session.retry() : null });
    return true;
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
    clearOpenTimers();
    set({ phase: 'listening', prompting: false, slow: false, mode: view.prompting || !pressed ? 'tap' : null, said: 'Listening' });
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
    const opens = new AbortController();
    opener = opens;
    let opening: Promise<VoiceRecorder>;
    try {
      opening = deps.open(opens.signal);
    } catch (cause) {
      opening = Promise.reject(cause);
    }
    void deps.prompts().then((prompts) => {
      if (prompts && mine === run && view.phase === 'opening') set({ prompting: true, said: 'Asking for the microphone' });
    });
    clearOpenTimers();
    openTimers.push(
      deps.after(VOICE_OPENING_SLOW_MS, () => {
        if (mine === run && view.phase === 'opening') set({ slow: true, said: 'Opening the microphone' });
      }),
    );
    const giveUp = (unlessAsking: boolean) => {
      if (mine !== run || view.phase !== 'opening' || (unlessAsking && view.prompting)) return;
      run++;
      release();
      set({ ...IDLE, trouble: 'micfailed', said: 'The microphone did not start' });
    };
    openTimers.push(
      deps.after(VOICE_OPENING_GIVE_UP_MS, () => giveUp(true)),
      deps.after(VOICE_ASKING_GIVE_UP_MS, () => giveUp(false)),
    );
    opening.then(
      (opened) => {
        if (opener === opens) opener = null;
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
    set({ phase: 'sending', mode: null, clipMs: meter.elapsedMs, said: 'Transcribing' });
    void taken
      .stop()
      .then((chunks) => {
        if (mine !== run) return;
        clip = encodeWav(chunks, taken.rate);
        void send();
      })
      .catch(() => {
        try {
          taken.abort();
        } catch {
        }
        if (mine !== run) return;
        run++;
        release();
        clip = null;
        if (!failedUnseen(false)) set({ ...IDLE, trouble: 'badclip', said: 'Dictation failed' });
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
    if (mine !== run) return;
    abort = null;
    if ('text' in answer) {
      if (!field) {
        clip = null;
        set({ ...IDLE });
        late?.(answer);
        return;
      }
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
    const known = answer.code ? (Object.hasOwn(TROUBLE, answer.code) ? TROUBLE[answer.code] : UNKNOWN_FAILURE) : { trouble: 'inboxgone' as const, keeps: true };
    if (answer.code === 'voice_not_ready' && answer.reason) deps.notReady(answer.reason);
    if (failedUnseen(known.keeps)) return;
    if (!known.keeps) clip = null;
    set({ ...IDLE, trouble: known.trouble, engine: answer.engine ?? null, kept: known.keeps, clipMs: view.clipMs, said: 'Dictation failed' });
  };

  const pressNote = (input: 'press' | 'release' | 'lost' | 'toggle', at?: VoicePoint) => note('voice_press', { input, phase: view.phase, mode: view.mode ?? undefined, dx: at?.dx, dy: at?.dy });

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
      if ((view.phase !== 'idle' || view.trouble !== null) && !stopWatching) {
        stopWatching = next.watch(onCaret, onInput);
        onCaret();
      }
      return () => {
        if (!late || view.phase !== 'sending') handle.drop();
        for (const cancelTimer of washTimers) cancelTimer();
        washTimers = [];
        stopWatching?.();
        stopWatching = null;
        field = null;
      };
    },
    press: (at) => {
      pressNote('press', at);
      if (view.phase === 'listening' && view.mode === 'tap') {
        secondPress = true;
        return;
      }
      if (view.phase !== 'idle') return;
      pressed = true;
      pressedAt = deps.now();
      start(false);
    },
    release: (at) => {
      pressNote('release', at);
      if (secondPress) {
        secondPress = false;
        stop();
        return;
      }
      if (!pressed) return;
      pressed = false;
      if (view.phase !== 'listening') return;
      if (deps.now() - Math.max(pressedAt, startedAt) < HOLD_MS) set({ mode: 'tap' });
      else stop();
    },
    lost: () => {
      pressNote('lost');
      secondPress = false;
      if (!pressed) return;
      pressed = false;
      if (view.phase === 'listening' && view.mode !== 'tap') cancel();
    },
    toggle: () => {
      pressNote('toggle');
      if (view.phase === 'listening') stop();
      else if (view.phase === 'idle') start(true);
    },
    stop,
    cancel: () => cancel(),
    covered: () => cancel(false),
    retry: () => {
      if (view.phase === 'idle' && clip && !field?.readOnly()) void send();
    },
    discard: () => {
      clip = null;
      set({ ...IDLE });
    },
  };
  return session;
}
