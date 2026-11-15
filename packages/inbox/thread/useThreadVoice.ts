import { useVoiceSession, type VoiceHandle } from '../voice';
import type { VoiceLate } from '../voiceSession';

/**
 * The reply box's dictation, one session per thread: a take being transcribed outlives the box (closed, or the thread
 * left) and `late` gets its words with the thread it was said in, never another thread's box.
 */
export function useThreadVoice(threadId: string, late: (outcome: VoiceLate, takenIn: string) => void): VoiceHandle {
  return useVoiceSession(true, (outcome, takenIn) => late(outcome, takenIn ?? threadId), threadId);
}
