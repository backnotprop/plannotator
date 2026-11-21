import { useEffect } from 'react';
import { useVoiceSession, type VoiceHandle } from '../voice';
import type { VoiceLate, VoiceSession } from '../voiceSession';

/**
 * The reply box's dictation, one session per thread: a take being transcribed outlives the box (closed, or the thread
 * left) and `late` gets its words with the thread it was said in, never another thread's box. Leaving the thread
 * mid-recording stops the take, so what was said is transcribed too; closing the box or covering it lets a recording
 * go, as New message's close does.
 *
 * `parked`: the pane is kept off the page (a free layout too narrow for it). No mic runs unseen, so the take stops and
 * what was said lands in the box, as leaving the thread, or a hidden full screen composer, does.
 */
export function useThreadVoice(threadId: string, late: (outcome: VoiceLate, takenIn: string) => void, parked = false): VoiceHandle {
  const voice = useVoiceSession(true, (outcome, takenIn) => late(outcome, takenIn ?? threadId), threadId);
  useEffect(() => {
    if (!parked) return;
    voice.session.stop();
    coverVoice(voice.session);
  }, [parked, voice.session]);
  return voice;
}

/**
 * A cover over the box hides its status and Cancel: a take still recording or opening goes, its mic closed and nothing
 * posted; one already being transcribed goes on and lands in the box under the cover.
 */
export function coverVoice(session: VoiceSession): void {
  if (session.view().phase !== 'sending') session.covered();
}
