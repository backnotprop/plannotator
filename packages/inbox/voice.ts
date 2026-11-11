import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { InboxVoiceSettings, InboxVoiceStatus } from '@plannotator/core/inbox-types';
import { inboxApi } from './api';
import { debugNote } from './debugLog';
import { useTouchScreen } from './phone';
import { microphoneUsable, microphoneWillPrompt, openVoiceRecorder } from './voiceRecorder';
import { createVoiceSession, type VoiceDeps, type VoiceLate, type VoiceSession, type VoiceView } from './voiceSession';

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

export function adoptVoiceSettings(next: InboxVoiceSettings | null | undefined): void {
  const was = settings;
  settings = next ?? null;
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

export async function checkVoiceStatus(fresh = false): Promise<void> {
  if (checking || !settings?.on) return;
  if (!fresh && (status?.state === 'ready' || Date.now() - checkedAt < RECHECK_MS)) return;
  checking = true;
  notify();
  try {
    status = await inboxApi.voiceStatus(fresh);
  } catch {
  }
  checkedAt = Date.now();
  checking = false;
  notify();
}

export function voiceWhere(current: InboxVoiceSettings | null): string {
  return current?.computer ?? 'this computer';
}

export type VoiceBlock = 'nomic' | 'notready';

export function voiceBlock(state: InboxVoiceStatus['state'] | undefined, usable: boolean): VoiceBlock | null {
  if (!usable) return 'nomic';
  return state === 'missing' || state === 'signedout' || state === 'apikey' || state === 'other' || state === 'nokey' ? 'notready' : null;
}

export function useVoiceShown(): boolean {
  const current = useVoiceSettings();
  const touch = useTouchScreen();
  return current?.on === true && (!current.phones_only || touch);
}

export function useVoiceBlock(shown: boolean): VoiceBlock | null {
  const { status: known } = useVoiceStatus();
  useEffect(() => {
    if (shown) void checkVoiceStatus();
  }, [shown]);
  return shown ? voiceBlock(known?.state, microphoneUsable()) : null;
}

export const browserDeps: VoiceDeps = {
  open: (signal) => openVoiceRecorder(signal),
  note: debugNote,
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
  busy: boolean;
}

export function useVoiceSession(ownsEscape = true, late?: (outcome: VoiceLate) => void): VoiceHandle {
  const lateRef = useRef(late);
  lateRef.current = late;
  const [session] = useState(() => createVoiceSession(browserDeps, late && ((outcome) => lateRef.current?.(outcome))));
  const view = useSyncExternalStore(session.subscribe, session.view, session.view);
  const busy = view.phase !== 'idle';
  // Esc belongs to the voice control only while it is running, and this press only cancels: it does not also close
  // the box or the dialog. A plain capture listener, so no shortcut registry entry, as approved.
  useEffect(() => {
    if (!busy || !ownsEscape) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      session.cancel();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [busy, ownsEscape, session]);
  return useMemo(() => ({ session, view, busy }), [session, view, busy]);
}
