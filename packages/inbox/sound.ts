/**
 * The Inbox's question sound: a soft two-tone doorbell ("Ding-dong", chosen
 * by the owner from twelve), generated live with Web Audio, so there are no
 * audio files. Design of record: .product/approved/inbox-sound/ (kept
 * privately, not in this repo).
 *
 * When it rings: a new question in an agent's message (the same items
 * notify.ts notifies about; plain messages never ring), only while no Inbox
 * tab is in front, and once per burst: the first question rings, more within
 * 30 s of the last one stay silent, and the burst ends when a tab comes to the
 * front. It does not depend on notifications. Several Inbox tabs ring once:
 * they share a BroadcastChannel (who is in front, who rang) and a tab rings
 * only while it holds a short lock (a Web Lock, or localStorage without one).
 *
 * Chrome lets a page play sound only after a click or key press in that tab,
 * so the AudioContext is made and resumed on the first gesture ("armed");
 * before that a ring would be lost without an error, and the Settings line
 * and the sidebar hint say so.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { INBOX_SOUND_DEFAULT_VOLUME, type InboxSoundSettings } from '@plannotator/core/inbox-types';
import { inboxApi } from './api';

// ───────────────────────────── The sound ─────────────────────────────

interface Note {
  freq: number;
  /** Start offset, seconds. */
  t: number;
  dur: number;
  type: OscillatorType;
  vol: number;
  /** An exponential pitch glide from `freq` to `to` over `glide` seconds (the reaction sound's swoop). */
  to?: number;
  glide?: number;
  /** Seconds to full volume; 5 ms unless given. */
  attack?: number;
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

/**
 * The emoji reaction's sound (approval "inbox-emoji-reactions", item 5):
 * "Deeper", u2 of `sound/sounds.json`, unchanged. Up-chirp's two quick
 * upward steps an octave down and a fourth lower (G4, then D5), each swooping
 * up from 0.7 of its note, with a faint octave over each. Its `vol` values are
 * loudness-matched: through the same master gain as Ding-dong (the Inbox's
 * sound volume), it sits about 11 dB under it.
 */
export const REACTION_DEEPER: readonly Note[] = [
  { freq: 274.4, to: 392, glide: 0.03, t: 0, dur: 0.075, type: 'sine', vol: 0.1156, attack: 0.006 },
  { freq: 548.8, to: 784, glide: 0.03, t: 0, dur: 0.0375, type: 'sine', vol: 0.0139, attack: 0.006 },
  { freq: 411.1, to: 587.3, glide: 0.03, t: 0.06, dur: 0.11, type: 'sine', vol: 0.1444, attack: 0.006 },
  { freq: 822.3, to: 1174.7, glide: 0.03, t: 0.06, dur: 0.055, type: 'sine', vol: 0.0173, attack: 0.006 },
];

/** How long the reaction sound's preview shows "Playing…". */
export const REACTION_DEEPER_MS = 300;

const ATTACK = 0.005;

function scheduleNote(ctx: AudioContext, master: GainNode, note: Note): void {
  const now = ctx.currentTime + note.t;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = note.type;
  osc.frequency.setValueAtTime(note.freq, now);
  if (note.to) osc.frequency.exponentialRampToValueAtTime(note.to, now + (note.glide ?? note.dur));
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(note.vol, now + (note.attack ?? ATTACK));
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

/** One AudioContext for the page, made on the first gesture (or the first Play). */
class InboxAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;

  /** Make the context (and resume it): call from a click or key press. */
  arm(): void {
    const ctx = this.ensure();
    if (ctx && ctx.state === 'suspended') void ctx.resume().catch(() => {});
  }

  /** Play the sound at `volume` (10–100). Without a context yet, nothing (a ring before the first gesture is lost). */
  play(volume: number, options: { create: boolean; notes?: readonly Note[] }): boolean {
    const ctx = options.create ? this.ensure() : this.ctx;
    if (!ctx || !this.master) return false;
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
    this.master.gain.value = Math.max(0, Math.min(1, volume / 100));
    for (const note of options.notes ?? DING_DONG) scheduleNote(ctx, this.master, note);
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

// ───────────────────────────── When it rings ─────────────────────────────

/** A burst: questions within this long of the last one stay silent. */
export const RING_BURST_MS = 30_000;

export interface RingGate {
  /** When the last question of the current burst arrived (in this tab, or a ring another tab reported); null: no burst. */
  lastAt: number | null;
}

export const QUIET_GATE: RingGate = { lastAt: null };

/**
 * New questions arrived: ring or not, and the burst after. Pure.
 *
 * - Sound off: nothing, and the burst is left as it was.
 * - An Inbox tab in front (this one or another): nothing; the person sees the
 *   list, so the burst ends.
 * - Within 30 s of the last question of a burst: nothing; the burst goes on
 *   from this question.
 * - Otherwise: ring, and a burst starts.
 */
export function decideRing(gate: RingGate, input: { now: number; enabled: boolean; inFront: boolean; otherTabInFront: boolean }): { ring: boolean; gate: RingGate } {
  if (!input.enabled) return { ring: false, gate };
  if (input.inFront || input.otherTabInFront) return { ring: false, gate: QUIET_GATE };
  if (gate.lastAt !== null && input.now - gate.lastAt < RING_BURST_MS) return { ring: false, gate: { lastAt: input.now } };
  return { ring: true, gate: { lastAt: input.now } };
}

/** Another tab rang at `at`: this tab is in that burst too. */
export function heardRing(gate: RingGate, at: number): RingGate {
  return { lastAt: gate.lastAt === null ? at : Math.max(gate.lastAt, at) };
}

// ───────────────────────────── Several tabs ─────────────────────────────

export const SOUND_CHANNEL = 'plannotator-inbox-sound';
/** How long a tab holds the ring lock: long enough that every tab has handled the same event. */
export const RING_LOCK_MS = 3000;
/** A tab that said "in front" counts for this long without saying it again (it repeats every 5 s while in front). */
const FRONT_FRESH_MS = 15_000;
const FRONT_REPEAT_MS = 5_000;

type ChannelMessage =
  | { type: 'hello'; id: string }
  | { type: 'front'; id: string; front: boolean }
  | { type: 'bye'; id: string }
  | { type: 'rang'; id: string; at: number };

/** The Inbox tab is in front: visible and focused (the same test notifications use). */
export function pageInFront(): boolean {
  return document.visibilityState === 'visible' && document.hasFocus();
}

const LOCK_KEY = `${SOUND_CHANNEL}-lock`;
/** Lets go of the ring lock this tab holds, if any. */
let releaseHold: (() => void) | null = null;

/**
 * The burst ended (an Inbox tab came to the front): let go of the ring lock
 * at once, so the next burst can ring even within RING_LOCK_MS.
 */
function endRingHold(): void {
  releaseHold?.();
  releaseHold = null;
  try {
    window.localStorage.removeItem(LOCK_KEY);
  } catch {
    // No storage.
  }
}

/** How long a tab holds a reaction it played, so another tab showing the same thread does not play it too. */
const REACTION_CLAIM_MS = 10_000;
const REACTION_CLAIM_KEY = `${SOUND_CHANNEL}-reaction`;

/**
 * Play the reaction `key` (message id and landing time) once across this
 * browser's Inbox tabs, as the question sound rings once: a Web Lock named for
 * the reaction, held a while, else a localStorage note of the last one played.
 */
async function claimReaction(key: string, play: () => void): Promise<boolean> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (locks?.request) {
    try {
      return await new Promise<boolean>((resolve, reject) => {
        locks
          .request(`${REACTION_CLAIM_KEY}:${key}`, { ifAvailable: true }, (lock) => {
            if (!lock) {
              resolve(false);
              return undefined;
            }
            play();
            resolve(true);
            return new Promise<void>((done) => setTimeout(done, REACTION_CLAIM_MS));
          })
          .catch(reject);
      });
    } catch {
      // Fall through to localStorage.
    }
  }
  try {
    const last = JSON.parse(window.localStorage.getItem(REACTION_CLAIM_KEY) ?? 'null') as { key?: string; at?: number } | null;
    if (last?.key === key && Date.now() - (last.at ?? 0) < REACTION_CLAIM_MS) return false;
    window.localStorage.setItem(REACTION_CLAIM_KEY, JSON.stringify({ key, at: Date.now() }));
  } catch {
    // No storage: this tab plays.
  }
  play();
  return true;
}

/**
 * Take the ring lock for RING_LOCK_MS (or until the burst ends) and run
 * `ring` if this tab got it; resolves whether it did. A Web Lock where there
 * is one; else a timestamp in localStorage (the same origin as the channel),
 * which is close enough for a doorbell.
 */
async function withRingLock(ring: () => void): Promise<boolean> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (locks?.request) {
    try {
      return await locks.request(SOUND_CHANNEL, { ifAvailable: true }, async (lock) => {
        if (!lock) return false;
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
  } catch {
    // No storage: this tab rings.
  }
  ring();
  return true;
}

// ───────────────────────────── The hook ─────────────────────────────

export interface InboxSound {
  /** The saved choice (on, at 60, until the Inbox says otherwise). */
  settings: InboxSoundSettings;
  /** The tab has had a click or key press, so a ring can play. */
  armed: boolean;
  /** A preview is playing ("Playing…"). */
  playing: boolean;
  /** Play: always plays, tab in front or not, at `volume` (default: the saved one). */
  preview: (volume?: number) => void;
  /** New questions arrived (notify.ts's items, after the list read). */
  questionsArrived: () => void;
  /** Another Inbox tab said it is in front (within the last 15 s): it handles what arrives (notify.ts). */
  otherTabInFront: () => boolean;
  /**
   * An emoji reaction landed on a reply in the thread on screen (approval
   * "inbox-emoji-reactions"): "Deeper" at the Inbox's sound volume. Only once
   * the tab has had a click (a browser drops it before). The question sound's
   * switch has no say: the reaction's own Sound switch is the caller's.
   * `key` names the reaction (message id and landing time): several of this
   * browser's tabs showing it play it once.
   */
  reactionLanded: (key: string) => void;
  /** Settings → Capabilities → Sound's ▶: plays "Deeper" now. */
  previewReaction: () => void;
  /** The reaction sound's preview is playing ("Playing…"). */
  reactionPlaying: boolean;
  /** Save the switch; false when the Inbox did not keep it (the switch goes back). */
  setEnabled: (next: boolean) => Promise<boolean>;
  setVolume: (next: number) => Promise<boolean>;
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

const DEFAULT_SETTINGS: InboxSoundSettings = { enabled: true, volume: INBOX_SOUND_DEFAULT_VOLUME, dialog_shown_for: null };

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
  const settings = options.settings ?? DEFAULT_SETTINGS;
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
      else if (message.type === 'rang' && typeof message.at === 'number') gate.current = heardRing(gate.current, message.at);
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

  const questionsArrived = useCallback(() => {
    const now = Date.now();
    const decided = decideRing(gate.current, { now, enabled: settingsRef.current.enabled, inFront: pageInFront(), otherTabInFront: otherTabInFront() });
    gate.current = decided.gate;
    // Before the first click Chrome keeps the context suspended: the ring would be lost, so none is tried.
    if (!decided.ring || !armedRef.current) return;
    void withRingLock(() => {
      audio.current?.play(settingsRef.current.volume, { create: true });
      try {
        channel.current?.postMessage({ type: 'rang', id: id.current, at: now } satisfies ChannelMessage);
      } catch {
        // Closed.
      }
    });
  }, [otherTabInFront]);

  const preview = useCallback((volume?: number) => {
    // Play is a click: it arms the sound too.
    audio.current?.arm();
    setArmed(true);
    audio.current?.play(volume ?? settingsRef.current.volume, { create: true });
    setPlaying(true);
    if (playingTimer.current) clearTimeout(playingTimer.current);
    playingTimer.current = setTimeout(() => setPlaying(false), DING_DONG_MS);
  }, []);

  const [reactionPlaying, setReactionPlaying] = useState(false);
  const reactionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (reactionTimer.current) clearTimeout(reactionTimer.current);
    },
    [],
  );
  const reactionLanded = useCallback((key: string) => {
    if (!armedRef.current) return;
    // Several Inbox tabs showing the thread: the first to claim the reaction plays it, the others stay quiet.
    void claimReaction(key, () => audio.current?.play(settingsRef.current.volume, { create: true, notes: REACTION_DEEPER }));
  }, []);
  const previewReaction = useCallback(() => {
    // Play is a click: it arms the sound too.
    audio.current?.arm();
    setArmed(true);
    audio.current?.play(settingsRef.current.volume, { create: true, notes: REACTION_DEEPER });
    setReactionPlaying(true);
    if (reactionTimer.current) clearTimeout(reactionTimer.current);
    reactionTimer.current = setTimeout(() => setReactionPlaying(false), REACTION_DEEPER_MS);
  }, []);

  const save = useCallback(async (change: { enabled?: boolean; volume?: number }) => {
    const before = settingsRef.current;
    onSettingsRef.current({ ...before, ...change });
    try {
      onSettingsRef.current((await inboxApi.saveSound(change)).sound);
      return true;
    } catch {
      onSettingsRef.current(before);
      return false;
    }
  }, []);

  const setEnabled = useCallback((next: boolean) => save({ enabled: next }), [save]);
  const setVolume = useCallback((next: number) => save({ volume: next }), [save]);

  return { settings, armed, playing, preview, questionsArrived, otherTabInFront, reactionLanded, previewReaction, reactionPlaying, setEnabled, setVolume };
}
