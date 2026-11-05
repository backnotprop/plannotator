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
import { HOLD_MS, type VoicePoint, type VoicePressTarget } from './voicePress';
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
/**
 * The button shows it is opening from the press itself (lit, with the spinner). Its words wait this long, so a mic
 * that opens at once doesn't flash a line; any longer and a tap looks like it did nothing.
 */
export const VOICE_OPENING_SLOW_MS = 150;
/** A mic that hasn't opened by now, with no browser prompt up, is a mic that didn't start: the next tap tries again. */
export const VOICE_OPENING_GIVE_UP_MS = 10_000;
/** While the browser asks, the person is answering it: a longer wait before giving up. */
export const VOICE_ASKING_GIVE_UP_MS = 30_000;
const WASH_FADES_MS = 1300;
const WASH_ENDS_MS = 2300;

export type VoicePhase = 'idle' | 'opening' | 'listening' | 'sending';

/** Every reason a press can end without words; the debug log's filter must keep each (voiceDebugLog.test.ts). */
export const VOICE_TROUBLE_CODES = ['notheard', 'blocked', 'micfailed', 'nothing', 'badclip', 'expired', 'refused', 'keyrefused', 'offline', 'inboxgone', 'codexfailed', 'notready', 'voiceoff'] as const;

/** Why the last press ended without words. Kept in `VoiceView` until the next press, a Discard or, for those with no clip, typing. */
export type VoiceTrouble = (typeof VOICE_TROUBLE_CODES)[number];

export interface VoiceView {
  phase: VoicePhase;
  /** The browser is asking for the microphone. */
  prompting: boolean;
  /** The microphone has taken long to open, with no prompt: without a line and a Cancel the box just looks stuck. */
  slow: boolean;
  /** Null until the press resolves into a hold or a tap. */
  mode: 'hold' | 'tap' | null;
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
  /** Open the microphone. `signal` aborts when the take ends before it opened: the recorder lets go of what it holds. */
  open(signal: AbortSignal): Promise<VoiceRecorder>;
  prompts(): Promise<boolean>;
  /** Throws when the Inbox could not be reached. */
  transcribe(clip: Blob, signal: AbortSignal): Promise<VoiceAnswer>;
  /** The Inbox says this computer is not ready after all. */
  notReady(state: InboxVoiceStatus['state']): void;
  now(): number;
  every(ms: number, run: () => void): () => void;
  after(ms: number, run: () => void): () => void;
  /** The opt-in debug log (`debugNote`): phases, modes and inputs only, never audio or words. */
  note?(ev: 'voice_press' | 'voice_phase', fields: Record<string, unknown>): void;
}

/** What became of a take whose field went while it was being transcribed: its words, or nothing to show for it. */
export type VoiceLate = { text: string } | { failed: true; retry: (() => void) | null };

export interface VoiceSession extends VoicePressTarget {
  view(): VoiceView;
  meter(): VoiceMeter;
  subscribe(listener: () => void): () => void;
  subscribeMeter(listener: () => void): () => void;
  /**
   * Give the session its field. The returned function drops everything, a clip included, and any answer still on its
   * way; with a `late` host, a take already being transcribed goes on, and a later field or `late` takes its words.
   */
  attach(field: VoiceField): () => void;
  stop(): void;
  cancel(): void;
  /** Something now covers the box, status and Cancel with it: as `cancel`, and focus stays where it went. */
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

/** The one recording in this window. */
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
  /** The open still on its way: anything that ends the take aborts it, so a hung mic holds nothing. */
  let opener: AbortController | null = null;
  /** The opening's slow line and give-ups: cleared when it opens or ends, so none can reach a later take. */
  let openTimers: (() => void)[] = [];
  const clearOpenTimers = () => {
    for (const cancelTimer of openTimers) cancelTimer();
    openTimers = [];
  };
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

  const note = (ev: 'voice_press' | 'voice_phase', fields: Record<string, unknown>) => {
    try {
      deps.note?.(ev, fields);
    } catch {
      // The log never changes a take.
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
    opener?.abort();
    opener = null;
    clearOpenTimers();
    pressed = false;
    secondPress = false;
    if (recording === handle) recording = null;
  };

  /** Esc or Cancel: the box is as it was. Words typed meanwhile stay; only then does the caret stay too. */
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

  /** A failed answer whose field and host have both gone has no line to show it on, so the host's `late` says it. */
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
    // The prompt took the press away, or the finger came up while the mic opened: a tap.
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
    // In the press, before any wait: see openVoiceRecorder. A throw here (the AudioContext refused) is a mic that did
    // not start, never a run left opening with no line, no Cancel and Send off.
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
    // A microphone that never answers (seen on iOS) ends with the "didn't start" note, so the box is never left
    // waiting on it with Send off. Giving up aborts the open (release), so the recorder lets go of its AudioContext
    // now and of a stream that arrives later; a recorder handed over anyway is closed at once (`mine !== run` below).
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
        // No clip came out of the recorder: back at rest with a line, never a spinner that stays.
        try {
          taken.abort();
        } catch {
          // Already let go of.
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
    // Not one of this route's codes: the answer came from something other than a working Inbox, a restarted one among them.
    const known = answer.code ? TROUBLE[answer.code] : { trouble: 'inboxgone' as const, keeps: true };
    if (answer.code === 'voice_not_ready' && answer.reason) deps.notReady(answer.reason);
    if (failedUnseen(known.keeps)) return;
    if (!known.keeps) clip = null;
    set({ ...IDLE, trouble: known.trouble, engine: answer.engine ?? null, kept: known.keeps, clipMs: view.clipMs, said: 'Dictation failed' });
  };

  /** Each input with the state it met, so a tap that did nothing shows in the log; a pointer's adds its offset from the button's centre. */
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
      // A take or a line that outlived the last field carries on in this one.
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
      // Opening or sending: the button already shows it is busy (lit with the spinner), so another tap changes nothing
      // and the take goes on. Cancel on the bar is the way out (owner's call, 2026-11-02: a tap that cancels unseen is
      // worse than a tap that waits in sight).
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
      // Held from the moment it was listening: the time the mic took to open was no talking.
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
