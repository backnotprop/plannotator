/**
 * What the mic's status says at this moment, from the session's state. Pure, so the moments it changes are tested
 * without waiting for them.
 */
import { voiceClock } from './voiceAudio';
import { VOICE_CAP_MS, VOICE_COUNTDOWN_MS, VOICE_NO_VOICE_MS, VOICE_QUIET_STOP_MS, VOICE_QUIET_WARN_MS, type VoiceMeter, type VoiceView } from './voiceSession';

export type VoiceLineState = 'asking' | 'opening' | 'hold' | 'tap' | 'quiet' | 'nearcap' | 'silencestop' | 'sending';

export interface VoiceLine {
  state: VoiceLineState;
  word: string;
  hint: string;
  time?: string;
  /** The level, and whether it is lit. */
  bars?: 'voice' | 'quiet';
}

/** Nothing to say while idle, or in the moment the mic opens with no prompt. */
export function voiceLine(view: VoiceView, meter: VoiceMeter, phone: boolean): VoiceLine | null {
  const { elapsedMs, voice, voiceSeen, quietMs } = meter;
  const time = voiceClock(elapsedMs);
  if (view.phase === 'opening') {
    if (view.prompting) return { state: 'asking', word: 'Asking for the microphone', hint: phone ? '' : 'Answer the browser’s prompt' };
    return view.slow ? { state: 'opening', word: 'Opening the microphone', hint: '' } : null;
  }
  if (view.phase === 'sending') return { state: 'sending', word: 'Transcribing', hint: phone ? '' : `${voiceClock(view.clipMs)} clip` };
  if (view.phase !== 'listening') return null;
  const held = view.mode !== 'tap';
  if (!voiceSeen && elapsedMs >= VOICE_NO_VOICE_MS) return { state: 'quiet', word: 'No voice yet', hint: phone ? '' : 'Check your microphone', bars: 'quiet', time };
  if (!held && voiceSeen && quietMs >= VOICE_QUIET_WARN_MS) {
    const left = Math.ceil((VOICE_QUIET_STOP_MS - quietMs) / 1000);
    return { state: 'silencestop', word: 'Quiet', hint: phone ? '' : `Stopping in ${left} s`, bars: 'quiet', time };
  }
  const bars = voice ? 'voice' : 'quiet';
  if (elapsedMs >= VOICE_COUNTDOWN_MS) {
    return { state: 'nearcap', word: 'Listening', hint: phone ? '' : 'Stops at 2:00', bars, time: `${voiceClock(VOICE_CAP_MS - elapsedMs + 999)} left` };
  }
  if (held) return { state: 'hold', word: 'Listening', hint: phone ? '' : 'Let go to stop · Esc cancels', bars, time };
  return { state: 'tap', word: 'Listening', hint: phone ? '' : 'Tap the mic to stop', bars, time };
}
