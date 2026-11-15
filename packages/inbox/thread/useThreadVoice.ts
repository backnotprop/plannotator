import { useEffect, useRef } from 'react';
import { useVoiceSession, type VoiceHandle } from '../voice';
import type { VoiceLate } from '../voiceSession';

/**
 * The reply box's dictation. A take being transcribed outlives the box (closed, or the thread left): `late` gets its
 * words with the thread the take started in, which the pane may no longer show.
 */
export function useThreadVoice(threadId: string, late: (outcome: VoiceLate, takenIn: string) => void): VoiceHandle {
  const lateRef = useRef(late);
  lateRef.current = late;
  const takenIn = useRef(threadId);
  const voice = useVoiceSession(true, (outcome) => lateRef.current(outcome, takenIn.current));
  const idle = voice.view.phase === 'idle';
  useEffect(() => {
    if (idle) takenIn.current = threadId;
  }, [idle, threadId]);
  return voice;
}
