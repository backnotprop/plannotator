/**
 * The Inbox's sound: a soft two-tone doorbell ("Ding-dong", chosen by the
 * owner from twelve), generated live with Web Audio, so there are no audio
 * files. Design of record: .product/approved/inbox-sound/ (kept privately, not
 * in this repo).
 *
 * When it rings (the person's choice, `InboxSoundSettings.when`; the rules
 * are soundRing.ts): "for every agent message" (the default) for any new
 * message from an agent (a reply, a new thread, a question); "when an agent
 * asks you or starts a thread" for a new question or a new thread.
 * Either way only while no Inbox tab is in front, and one list read rings
 * once. A question rings unless another question came within 30 s; a plain
 * reply rings unless any news came within 30 s, and never holds a question
 * back; a tab coming to the front ends both bursts. It does not depend on
 * notifications. Several Inbox tabs ring once:
 * they share a BroadcastChannel (who is in front, who rang) and a tab rings
 * only while it holds a short lock (a Web Lock, or localStorage without one).
 *
 * Chrome lets a page play sound only after a click or key press in that tab,
 * so the AudioContext is made and resumed on the first gesture ("armed").
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { INBOX_SOUND_DEFAULT_VOLUME, INBOX_SOUND_DEFAULT_WHEN, inboxSoundWhen, isInboxSoundVolume, type InboxSoundSettings, type InboxSoundWhen } from '@plannotator/core/inbox-types';
import { inboxApi } from './api';
import { decideRing, heardRing, QUIET_GATE, RING_LOCK_MS, type RangFor, type RingGate, type RingNews } from './soundRing';

export { decideRing, heardRing, plainMessageRings, questionRings, QUIET_GATE, RING_BURST_MS, RING_LOCK_MS, ringsFor, type RangFor, type RingGate, type RingNews } from './soundRing';

// ───────────────────────────── The sound ─────────────────────────────

interface Note {
  freq: number;
  /** Start offset, seconds. */
  t: number;
  dur: number;
  type: OscillatorType;
  vol: number;
}

/** Semitones from C4 (0 = C4), as the sound picker computes them. */
const N = (semis: number) => 440 * Math.pow(2, (semis - 9) / 12);

/** Tile #9 of the approved sound picker, unchanged: two triangle notes, each with a quiet sine an octave above. */
export const DING_DONG: readonly Note[] = [
  { freq: N(16), t: 0, dur: 0.55, type: 'triangle', vol: 0.3 },
  { freq: N(16) * 2, t: 0, dur: 0.3, type: 'sine', vol: 0.06 },
  { freq: N(12), t: 0.32, dur: 0.75, type: 'triangle', vol: 0.3 },
  { freq: N(12) * 2, t: 0.32, dur: 0.4, type: 'sine', vol: 0.06 },
];

/** How long the sound lasts, for "Playing…". */
export const DING_DONG_MS = 1100;

const ATTACK = 0.005;

function scheduleNote(ctx: AudioContext, master: GainNode, note: Note): void {
  const now = ctx.currentTime + note.t;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = note.type;
  osc.frequency.setValueAtTime(note.freq, now);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(note.vol, now + ATTACK);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + note.dur);
  osc.connect(gain).connect(master);
  osc.start(now);
  osc.stop(now + note.dur + 0.02);
}

type AudioContextCtor = new () => AudioContext;

function audioContextCtor(): AudioContextCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

function autoplayPolicy(): string | null {
  if (typeof navigator === 'undefined') return null;
  const nav = navigator as Navigator & { getAutoplayPolicy?: (type: 'audiocontext') => string };
  try {
    return nav.getAutoplayPolicy?.('audiocontext') ?? null;
  } catch {
    return null;
  }
}

/** One AudioContext for the page, made on the first gesture (or the first Play). */
class InboxAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;

  /** Make the context (and resume it): call from a click or key press. */
  arm(): void {
    const ctx = this.ensure();
    if (ctx && ctx.state === 'suspended') void ctx.resume().catch(() => {});
  }

  unlock(): boolean {
    const ctx = this.ensure();
    if (!ctx) return false;
    const allowed = autoplayPolicy() === 'allowed';
    if (allowed && ctx.state === 'suspended') void ctx.resume().catch(() => {});
    return allowed || ctx.state === 'running';
  }

  /** Play the sound at `volume` (10–100). Without a context yet, nothing (a ring before the first gesture is lost). */
  play(volume: number, options: { create: boolean }): boolean {
    const ctx = options.create ? this.ensure() : this.ctx;
    if (!ctx || !this.master) return false;
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
    this.master.gain.value = Math.max(0, Math.min(1, volume / 100));
    for (const note of DING_DONG) scheduleNote(ctx, this.master, note);
    return true;
  }

  private ensure(): AudioContext | null {
    if (this.ctx) return this.ctx;
    const Ctor = audioContextCtor();
    if (!Ctor) return null;
    try {
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.connect(this.ctx.destination);
    } catch {
      this.ctx = null;
      this.master = null;
    }
    return this.ctx;
  }
}

// ───────────────────────────── Several tabs ─────────────────────────────

export const SOUND_CHANNEL = 'plannotator-inbox-sound';
/** A tab that said "in front" counts for this long without saying it again (it repeats every 5 s while in front). */
const FRONT_FRESH_MS = 15_000;
const FRONT_REPEAT_MS = 5_000;

type ChannelMessage =
  | { type: 'hello'; id: string }
  | { type: 'front'; id: string; front: boolean }
  | { type: 'bye'; id: string }
  /** `asked`: the ring was for a question (absent from a tab before the choice, whose rings always were). */
  | { type: 'rang'; id: string; at: number; asked?: boolean; fresh?: boolean };

/** The Inbox tab is in front: visible and focused (the same test notifications use). */
export function pageInFront(): boolean {
  return document.visibilityState === 'visible' && document.hasFocus();
}

const LOCK_KEY = `${SOUND_CHANNEL}-lock`;
/** Lets go of the ring lock this tab holds, if any. */
let releaseHold: (() => void) | null = null;
/** Until when this tab holds the ring lock (it rang last): it rings again in that time itself (a question seconds after a reply). */
let holdingUntil = 0;

/**
 * The burst ended (an Inbox tab came to the front): let go of the ring lock
 * at once, so the next burst can ring even within RING_LOCK_MS.
 */
export function endRingHold(): void {
  releaseHold?.();
  releaseHold = null;
  holdingUntil = 0;
  try {
    window.localStorage.removeItem(LOCK_KEY);
  } catch {
    // No storage.
  }
}

/**
 * Take the ring lock for RING_LOCK_MS (or until the burst ends) and run
 * `ring` if this tab got it; resolves whether it did. A Web Lock where there
 * is one; else a timestamp in localStorage (the same origin as the channel),
 * which is close enough for a doorbell.
 */
async function withRingLock(ring: () => void): Promise<boolean> {
  // This tab rang moments ago and still holds the lock: every other tab defers to it, so it rings this news itself
  // (news decideRing lets ring, such as a question seconds after a reply), or no tab would.
  if (Date.now() < holdingUntil) {
    ring();
    return true;
  }
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (locks?.request) {
    try {
      return await locks.request(SOUND_CHANNEL, { ifAvailable: true }, async (lock) => {
        if (!lock) return false;
        holdingUntil = Date.now() + RING_LOCK_MS;
        ring();
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, RING_LOCK_MS);
          releaseHold = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        releaseHold = null;
        return true;
      });
    } catch {
      // Fall through to localStorage.
    }
  }
  try {
    const held = Number(window.localStorage.getItem(LOCK_KEY) ?? 0);
    const now = Date.now();
    if (now - held < RING_LOCK_MS) return false;
    window.localStorage.setItem(LOCK_KEY, String(now));
    holdingUntil = now + RING_LOCK_MS;
  } catch {
    // No storage: this tab rings.
  }
  ring();
  return true;
}

// ───────────────────────────── The hook ─────────────────────────────

export interface InboxSound {
  /** The saved choice (on, at 60, for every agent message, until the Inbox says otherwise). */
  settings: InboxSoundSettings & { when: InboxSoundWhen };
  /** The tab has had a click or key press, so a ring can play. */
  armed: boolean;
  /** A preview is playing ("Playing…"). */
  playing: boolean;
  /** Play: always plays, tab in front or not, at `volume` (default: the saved one). */
  preview: (volume?: number) => void;
  /**
   * New agent news arrived (notify.ts, after the list read): a question among it (`asks`), a plain agent message among
   * it (`plain`). Answers which of it the bell rang for: a notice about that news is silent, so there is one sound.
   */
  arrived: (news: RingNews) => RangFor;
  /**
   * The Inbox's `event: sound` frame (any window saved the switch, volume or choice; `rev`, that save's count): this
   * window rings by it at once. An older save's frame, or one that lands while this window's own save is on its way,
   * never turns the row back.
   */
  hear: (frame: unknown, rev?: number) => void;
  /** Another Inbox tab said it is in front (within the last 15 s): it handles what arrives (notify.ts). */
  otherTabInFront: () => boolean;
  /** Save the switch; false when the Inbox did not keep it (the switch goes back). */
  setEnabled: (next: boolean) => Promise<boolean>;
  setVolume: (next: number) => Promise<boolean>;
  setWhen: (next: InboxSoundWhen) => Promise<boolean>;
}

/** The gestures a browser may count as a user activation. */
const ARMING_EVENTS = ['pointerdown', 'pointerup', 'click', 'touchend', 'keydown'] as const;

/**
 * The browser counts this gesture (or an earlier one) as a user activation,
 * so an AudioContext may start. Without `navigator.userActivation` (an older
 * browser), any gesture counts.
 */
function userActivated(): boolean {
  const activation = typeof navigator !== 'undefined' ? navigator.userActivation : undefined;
  if (!activation) return true;
  return activation.isActive || activation.hasBeenActive;
}

/** The sound's settings from an `event: sound` frame, or null for anything else. */
export function soundFromFrame(value: unknown): InboxSoundSettings | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.enabled !== 'boolean' || !isInboxSoundVolume(v.volume)) return null;
  return {
    enabled: v.enabled,
    volume: v.volume,
    when: inboxSoundWhen(v.when),
    dialog_shown_for: typeof v.dialog_shown_for === 'string' ? v.dialog_shown_for : null,
    ...(typeof v.dialog_due === 'boolean' ? { dialog_due: v.dialog_due } : {}),
  };
}

const DEFAULT_SETTINGS: InboxSoundSettings = { enabled: true, volume: INBOX_SOUND_DEFAULT_VOLUME, when: INBOX_SOUND_DEFAULT_WHEN, dialog_shown_for: null };

function tabId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now()}-${Math.random()}`;
  }
}

export function useInboxSound(options: {
  /** From GET /api/inbox/settings; null until read (or from an Inbox that predates the sound: on at 60). */
  settings: InboxSoundSettings | null | undefined;
  onSettings: (next: InboxSoundSettings) => void;
}): InboxSound {
  const given = options.settings ?? DEFAULT_SETTINGS;
  // An Inbox that predates the choice sends none: the default.
  const settings: InboxSound['settings'] = { ...given, when: inboxSoundWhen(given.when) };
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const onSettingsRef = useRef(options.onSettings);
  onSettingsRef.current = options.onSettings;
  const audio = useRef<InboxAudio | null>(null);
  if (audio.current === null) audio.current = new InboxAudio();
  const [armed, setArmed] = useState(() => typeof navigator !== 'undefined' && navigator.userActivation?.hasBeenActive === true);
  const armedRef = useRef(armed);
  armedRef.current = armed;
  const [playing, setPlaying] = useState(false);
  const playingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const gate = useRef<RingGate>(QUIET_GATE);
  const id = useRef(tabId());
  const others = useRef(new Map<string, { front: boolean; at: number }>());
  const channel = useRef<BroadcastChannel | null>(null);

  // The first click or key press in the tab that the browser counts as a
  // user activation arms the sound. Some never do (Escape, a modifier alone):
  // the page keeps listening until one does.
  useEffect(() => {
    if (armed) {
      audio.current?.arm();
      return;
    }
    const arm = () => {
      if (!userActivated()) return;
      audio.current?.arm();
      armedRef.current = true;
      setArmed(true);
    };
    for (const type of ARMING_EVENTS) window.addEventListener(type, arm, { capture: true });
    return () => {
      for (const type of ARMING_EVENTS) window.removeEventListener(type, arm, { capture: true });
    };
  }, [armed]);

  // The tabs tell each other who is in front and who rang.
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const ch = new BroadcastChannel(SOUND_CHANNEL);
    channel.current = ch;
    const me = id.current;
    const say = (message: ChannelMessage) => {
      try {
        ch.postMessage(message);
      } catch {
        // Closed: nothing to tell.
      }
    };
    ch.onmessage = (event: MessageEvent<ChannelMessage>) => {
      const message = event.data;
      if (!message || typeof message !== 'object' || message.id === me) return;
      if (message.type === 'hello') say({ type: 'front', id: me, front: pageInFront() });
      else if (message.type === 'front') {
        others.current.set(message.id, { front: message.front, at: Date.now() });
        // Another tab in front: the burst is over everywhere.
        if (message.front) {
          gate.current = QUIET_GATE;
          endRingHold();
        }
      }
      else if (message.type === 'bye') others.current.delete(message.id);
      else if (message.type === 'rang' && typeof message.at === 'number') gate.current = heardRing(gate.current, message.at, message.asked !== false, message.fresh === true);
    };
    const report = () => {
      const front = pageInFront();
      // In front: the burst ends here, and the other tabs hear it.
      if (front) {
        gate.current = QUIET_GATE;
        endRingHold();
      }
      say({ type: 'front', id: me, front });
    };
    const bye = () => say({ type: 'bye', id: me });
    say({ type: 'hello', id: me });
    report();
    const repeat = setInterval(() => {
      if (pageInFront()) say({ type: 'front', id: me, front: true });
    }, FRONT_REPEAT_MS);
    window.addEventListener('focus', report);
    window.addEventListener('blur', report);
    document.addEventListener('visibilitychange', report);
    window.addEventListener('pagehide', bye);
    return () => {
      bye();
      clearInterval(repeat);
      window.removeEventListener('focus', report);
      window.removeEventListener('blur', report);
      document.removeEventListener('visibilitychange', report);
      window.removeEventListener('pagehide', bye);
      ch.close();
      channel.current = null;
    };
  }, []);

  // Without a channel, this tab alone still ends its burst when it comes to the front.
  useEffect(() => {
    const back = () => {
      if (!pageInFront()) return;
      gate.current = QUIET_GATE;
      endRingHold();
    };
    window.addEventListener('focus', back);
    document.addEventListener('visibilitychange', back);
    return () => {
      window.removeEventListener('focus', back);
      document.removeEventListener('visibilitychange', back);
    };
  }, []);

  useEffect(
    () => () => {
      if (playingTimer.current) clearTimeout(playingTimer.current);
    },
    [],
  );

  const otherTabInFront = useCallback(() => {
    const now = Date.now();
    return [...others.current.values()].some((tab) => tab.front && now - tab.at < FRONT_FRESH_MS);
  }, []);

  const arrived = useCallback((news: RingNews): RangFor => {
    const now = Date.now();
    const { enabled, when } = settingsRef.current;
    if (!armedRef.current && enabled && !pageInFront() && audio.current?.unlock()) {
      armedRef.current = true;
      setArmed(true);
    }
    const decided = decideRing(gate.current, { now, enabled, when, armed: armedRef.current, inFront: pageInFront(), otherTabInFront: otherTabInFront(), ...news });
    gate.current = decided.gate;
    if (!decided.ring) return decided.rangFor;
    // This tab rings, or another that decided the same within the lock's hold does: either way the bell rang for it.
    void withRingLock(() => {
      audio.current?.play(settingsRef.current.volume, { create: true });
      try {
        channel.current?.postMessage({ type: 'rang', id: id.current, at: now, asked: decided.rangFor.asks, fresh: decided.rangFor.fresh } satisfies ChannelMessage);
      } catch {
        // Closed.
      }
    });
    return decided.rangFor;
  }, [otherTabInFront]);

  // Saves in order: the last save's count this window knows (a frame's or a save's answer's), the saves on their way,
  // and the newest frame that came meanwhile (applied after them if it is newer than their answers).
  const lastRev = useRef(0);
  const saving = useRef(0);
  const saveSeq = useRef(0);
  const heldFrame = useRef<{ sound: InboxSoundSettings; rev: number } | null>(null);

  const hear = useCallback((frame: unknown, rev?: number) => {
    const next = soundFromFrame(frame);
    if (!next) return;
    if (typeof rev === 'number') {
      if (rev <= lastRev.current) return;
      if (saving.current > 0) {
        if (!heldFrame.current || rev > heldFrame.current.rev) heldFrame.current = { sound: next, rev };
        return;
      }
      lastRev.current = rev;
    }
    onSettingsRef.current(next);
  }, []);

  const preview = useCallback((volume?: number) => {
    // Play is a click: it arms the sound too.
    audio.current?.arm();
    setArmed(true);
    audio.current?.play(volume ?? settingsRef.current.volume, { create: true });
    setPlaying(true);
    if (playingTimer.current) clearTimeout(playingTimer.current);
    playingTimer.current = setTimeout(() => setPlaying(false), DING_DONG_MS);
  }, []);

  const save = useCallback(async (change: { enabled?: boolean; volume?: number; when?: InboxSoundWhen }) => {
    const before = settingsRef.current;
    const seq = ++saveSeq.current;
    saving.current++;
    onSettingsRef.current({ ...before, ...change });
    try {
      const answer = await inboxApi.saveSound(change);
      if (typeof answer.sound_rev === 'number') lastRev.current = Math.max(lastRev.current, answer.sound_rev);
      // A later save (a double click) is on its way: its answer is the one to show, so this one never flicks back.
      if (seq === saveSeq.current) onSettingsRef.current(answer.sound);
      return true;
    } catch {
      if (seq === saveSeq.current) onSettingsRef.current(before);
      return false;
    } finally {
      saving.current--;
      const held = heldFrame.current;
      if (saving.current === 0 && held) {
        heldFrame.current = null;
        if (held.rev > lastRev.current) {
          lastRev.current = held.rev;
          onSettingsRef.current(held.sound);
        }
      }
    }
  }, []);

  const setEnabled = useCallback((next: boolean) => save({ enabled: next }), [save]);
  const setVolume = useCallback((next: number) => save({ volume: next }), [save]);
  const setWhen = useCallback((next: InboxSoundWhen) => save({ when: next }), [save]);

  return { settings, armed, playing, preview, arrived, hear, otherTabInFront, setEnabled, setVolume, setWhen };
}
