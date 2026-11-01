/**
 * Voice dictation in the window (approval "inbox-voice", 2026-10-31). The server half and its limits are in
 * packages/server/inbox-voice.ts; docs: "Voice dictation" in docs/agent-guides/inbox-compose.md.
 *
 * This file holds what every composer shares: the saved settings and the Inbox's read of this computer, as a store,
 * so a mic deep in a thread needs no props; and `useVoiceSession`, one composer's dictation. A host calls the hook,
 * passes the result to `InboxComposerField` and `VoiceFoot`, and keeps Send off while `busy`.
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { InboxVoiceSettings, InboxVoiceStatus } from '@plannotator/core/inbox-types';
import { inboxApi } from './api';
import { useTouchScreen } from './phone';
import { microphoneUsable, microphoneWillPrompt, openVoiceRecorder } from './voiceRecorder';
import { createVoiceSession, type VoiceDeps, type VoiceSession, type VoiceView } from './voiceSession';

/** How soon a computer that was not ready may be asked again without a person's press. */
const RECHECK_MS = 30_000;

let settings: InboxVoiceSettings | null = null;
let status: InboxVoiceStatus | null = null;
let checking = false;
let checkedAt = 0;
const listeners = new Set<() => void>();
const notify = () => {
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** What the Inbox says about voice now, from any read or save. */
export function adoptVoiceSettings(next: InboxVoiceSettings | null | undefined): void {
  const was = settings;
  settings = next ?? null;
  // Another engine, or back on, or another key: what was known no longer holds.
  if (was?.on !== settings?.on || was?.engine !== settings?.engine || was?.key.source !== settings?.key.source) {
    status = null;
    checkedAt = 0;
  }
  notify();
}

export function useVoiceSettings(): InboxVoiceSettings | null {
  return useSyncExternalStore(subscribe, () => settings, () => null);
}

export function useVoiceStatus(): { status: InboxVoiceStatus | null; checking: boolean } {
  const known = useSyncExternalStore(subscribe, () => status, () => null);
  const busy = useSyncExternalStore(subscribe, () => checking, () => false);
  return { status: known, checking: busy };
}

/**
 * Ask the Inbox whether voice can work here. With Codex as the engine that starts a short-lived Codex, so a ready
 * computer is asked once (a failed transcribe corrects it), and only a person's press (`fresh`) goes past the wait.
 */
export async function checkVoiceStatus(fresh = false): Promise<void> {
  if (checking || !settings?.on) return;
  if (!fresh && (status?.state === 'ready' || Date.now() - checkedAt < RECHECK_MS)) return;
  checking = true;
  notify();
  try {
    status = await inboxApi.voiceStatus(fresh);
  } catch {
    // The Inbox did not answer: nothing known, so the mic stays usable and a press says what is wrong.
  }
  checkedAt = Date.now();
  checking = false;
  notify();
}

/** The name of the computer that does the work. */
export function voiceWhere(current: InboxVoiceSettings | null): string {
  return current?.computer ?? 'this computer';
}

export type VoiceBlock = 'nomic' | 'notready';

/** Why the mic is dimmed, if it is. `unknown` is not a block: a press finds out. */
export function voiceBlock(state: InboxVoiceStatus['state'] | undefined, usable: boolean): VoiceBlock | null {
  if (!usable) return 'nomic';
  return state === 'missing' || state === 'signedout' || state === 'apikey' || state === 'other' || state === 'nokey' ? 'notready' : null;
}

/** Whether the mic is on this device: voice on, and with Phones only, a touch screen. The touch query, never width. */
export function useVoiceShown(): boolean {
  const current = useVoiceSettings();
  const touch = useTouchScreen();
  return current?.on === true && (!current.phones_only || touch);
}

/** The mic's state on this page; asks the Inbox once a mic is on screen, never before. */
export function useVoiceBlock(shown: boolean): VoiceBlock | null {
  const { status: known } = useVoiceStatus();
  useEffect(() => {
    if (shown) void checkVoiceStatus();
  }, [shown]);
  return shown ? voiceBlock(known?.state, microphoneUsable()) : null;
}

const browserDeps: VoiceDeps = {
  open: openVoiceRecorder,
  prompts: microphoneWillPrompt,
  transcribe: (clip, signal) => inboxApi.transcribeVoice(clip, signal),
  notReady: (state) => {
    status = { state, plan: null };
    notify();
  },
  now: () => performance.now(),
  every: (ms, run) => {
    // Not an animation frame: the 2:00 cap must hold in a hidden tab.
    const timer = setInterval(run, ms);
    return () => clearInterval(timer);
  },
  after: (ms, run) => {
    const timer = setTimeout(run, ms);
    return () => clearTimeout(timer);
  },
};

export interface VoiceHandle {
  session: VoiceSession;
  view: VoiceView;
  /** Send waits: the reply could otherwise go out without the words. */
  busy: boolean;
}

export function useVoiceSession(): VoiceHandle {
  const [session] = useState(() => createVoiceSession(browserDeps));
  const view = useSyncExternalStore(session.subscribe, session.view, session.view);
  const busy = view.phase !== 'idle';
  // Esc belongs to the voice control only while it is running, and this press only cancels: it does not also close
  // the box or the dialog. A plain capture listener, so no shortcut registry entry, as approved.
  useEffect(() => {
    if (!busy) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      session.cancel();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [busy, session]);
  return useMemo(() => ({ session, view, busy }), [session, view, busy]);
}
