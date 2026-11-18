import { useCallback, useEffect, useRef, useState } from 'react';
import { INBOX_SOUND_DEFAULT_VOLUME, type InboxSoundSettings } from '@plannotator/core/inbox-types';
import { inboxApi } from './api';
import { INBOX_SOUND_MS, INBOX_SOUNDS, scheduleFelt, type InboxSoundKind } from './feltSound';
import { decideRing, heardRing, QUIET_GATE, type RingGate } from './ringGate';

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

  play(volume: number, kind: InboxSoundKind, options: { create: boolean }): boolean {
    const ctx = options.create ? this.ensure() : this.ctx;
    if (!ctx || !this.master) return false;
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
    this.master.gain.value = Math.max(0, Math.min(1, volume / 100));
    for (const note of INBOX_SOUNDS[kind]) scheduleFelt(ctx, this.master, note);
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
/** How long a tab holds the ring lock: long enough that every tab has handled the same event. */
export const RING_LOCK_MS = 3000;
/** A tab that said "in front" counts for this long without saying it again (it repeats every 5 s while in front). */
const FRONT_FRESH_MS = 15_000;
const FRONT_REPEAT_MS = 5_000;

type ChannelMessage =
  | { type: 'hello'; id: string }
  | { type: 'front'; id: string; front: boolean }
  | { type: 'bye'; id: string }
  | { type: 'rang'; id: string; at: number; kind?: InboxSoundKind };

/** The Inbox tab is in front: visible and focused (the same test notifications use). */
export function pageInFront(): boolean {
  return document.visibilityState === 'visible' && document.hasFocus();
}

const lockName = (kind: InboxSoundKind) => (kind === 'question' ? SOUND_CHANNEL : `${SOUND_CHANNEL}-${kind}`);
const lockKey = (kind: InboxSoundKind) => `${lockName(kind)}-lock`;
const releaseHolds = new Set<() => void>();

/**
 * The burst ended (an Inbox tab came to the front): let go of the ring lock
 * at once, so the next burst can ring even within RING_LOCK_MS.
 */
function endRingHold(): void {
  for (const release of [...releaseHolds]) release();
  releaseHolds.clear();
  try {
    for (const kind of Object.keys(INBOX_SOUNDS) as InboxSoundKind[]) window.localStorage.removeItem(lockKey(kind));
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
async function withRingLock(kind: InboxSoundKind, ring: () => void): Promise<boolean> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (locks?.request) {
    try {
      return await locks.request(lockName(kind), { ifAvailable: true }, async (lock) => {
        if (!lock) return false;
        ring();
        await new Promise<void>((resolve) => {
          const release = () => {
            clearTimeout(timer);
            releaseHolds.delete(release);
            resolve();
          };
          const timer = setTimeout(release, RING_LOCK_MS);
          releaseHolds.add(release);
        });
        return true;
      });
    } catch {
      // Fall through to localStorage.
    }
  }
  try {
    const held = Number(window.localStorage.getItem(lockKey(kind)) ?? 0);
    const now = Date.now();
    if (now - held < RING_LOCK_MS) return false;
    window.localStorage.setItem(lockKey(kind), String(now));
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
  armed: boolean;
  covers: () => boolean;
  /** A preview is playing ("Playing…"). */
  playing: boolean;
  /** Play: always plays, tab in front or not, at `volume` (default: the saved one). */
  preview: (volume?: number) => void;
  arrived: (kind: InboxSoundKind) => void;
  /** Another Inbox tab said it is in front (within the last 15 s): it handles what arrives (notify.ts). */
  otherTabInFront: () => boolean;
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
      else if (message.type === 'rang' && typeof message.at === 'number') gate.current = heardRing(gate.current, message.at, message.kind ?? 'question');
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

  const arrived = useCallback((kind: InboxSoundKind) => {
    const now = Date.now();
    const decided = decideRing(gate.current, { now, kind, enabled: settingsRef.current.enabled, inFront: pageInFront(), otherTabInFront: otherTabInFront() });
    gate.current = decided.gate;
    if (!decided.ring) return;
    if (!armedRef.current) {
      if (!audio.current?.unlock()) return;
      armedRef.current = true;
      setArmed(true);
    }
    void withRingLock(kind, () => {
      audio.current?.play(settingsRef.current.volume, kind, { create: true });
      try {
        channel.current?.postMessage({ type: 'rang', id: id.current, at: now, kind } satisfies ChannelMessage);
      } catch {
        // Closed.
      }
    });
  }, [otherTabInFront]);

  const covers = useCallback(() => settingsRef.current.enabled && armedRef.current && !otherTabInFront(), [otherTabInFront]);

  const preview = useCallback((volume?: number) => {
    // Play is a click: it arms the sound too.
    audio.current?.arm();
    setArmed(true);
    audio.current?.play(volume ?? settingsRef.current.volume, 'question', { create: true });
    setPlaying(true);
    if (playingTimer.current) clearTimeout(playingTimer.current);
    playingTimer.current = setTimeout(() => setPlaying(false), INBOX_SOUND_MS.question);
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

  return { settings, armed, covers, playing, preview, arrived, otherTabInFront, setEnabled, setVolume };
}
