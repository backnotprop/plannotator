import { useVoiceSession, type VoiceHandle } from '../voice';
import type { VoiceLate, VoiceSession } from '../voiceSession';

/**
 * The reply box's dictation, one session per thread: a take being transcribed outlives the box (closed, or the thread
 * left) and `late` gets its words with the thread it was said in, never another thread's box. Leaving the thread
 * mid-recording stops the take, so what was said is transcribed too; closing the box or covering it lets a recording
 * go, as New message's close does.
 */
export function useThreadVoice(threadId: string, late: (outcome: VoiceLate, takenIn: string) => void): VoiceHandle {
  return useVoiceSession(true, (outcome, takenIn) => late(outcome, takenIn ?? threadId), threadId);
}

/**
 * A cover over the box hides its status and Cancel: a take still recording or opening goes, its mic closed and nothing
 * posted; one already being transcribed goes on and lands in the box under the cover.
 */
export function coverVoice(session: VoiceSession): void {
  if (session.view().phase !== 'sending') session.covered();
}
