/**
 * What the mic's status says at this moment, from the session's state. Pure, so the moments it changes are tested
 * without waiting for them.
 */
import { voiceClock } from './voiceAudio';
import { VOICE_CAP_MS, VOICE_COUNTDOWN_MS, VOICE_NO_VOICE_MS, VOICE_QUIET_STOP_MS, VOICE_QUIET_WARN_MS, type VoiceMeter, type VoiceView } from './voiceSession';

export type VoiceLineState = 'asking' | 'hold' | 'tap' | 'quiet' | 'armed' | 'nearcap' | 'silencestop' | 'sending';

export interface VoiceLine {
  state: VoiceLineState;
  word: string;
  hint: string;
  time?: string;
  /** The level, and whether it is lit. */
  bars?: 'voice' | 'quiet';
  /** A visible Cancel: a mouse or phone has no Esc once nothing is held. */
  cancel: boolean;
  danger?: boolean;
}

/** Nothing to say while idle, or in the instant the mic opens with no prompt. */
export function voiceLine(view: VoiceView, meter: VoiceMeter, phone: boolean): VoiceLine | null {
  const { elapsedMs, voice, voiceSeen, quietMs } = meter;
  const time = voiceClock(elapsedMs);
  if (view.phase === 'opening') {
    return view.prompting ? { state: 'asking', word: 'Asking for the microphone', hint: phone ? '' : 'Answer the browser’s prompt', cancel: true } : null;
  }
  if (view.phase === 'sending') return { state: 'sending', word: 'Transcribing', hint: phone ? '' : `${voiceClock(view.clipMs)} clip`, cancel: true };
  if (view.phase !== 'listening') return null;
  if (view.armed) return { state: 'armed', word: 'Let go to cancel', hint: '', bars: 'voice', time, cancel: false, danger: true };
  const held = view.mode !== 'tap';
  if (!voiceSeen && elapsedMs >= VOICE_NO_VOICE_MS) return { state: 'quiet', word: 'No voice yet', hint: phone ? '' : 'Check your microphone', bars: 'quiet', time, cancel: !held };
  if (!held && voiceSeen && quietMs >= VOICE_QUIET_WARN_MS) {
    const left = Math.ceil((VOICE_QUIET_STOP_MS - quietMs) / 1000);
    return { state: 'silencestop', word: 'Quiet', hint: phone ? '' : `Stopping in ${left} s`, bars: 'quiet', time, cancel: true };
  }
  const bars = voice ? 'voice' : 'quiet';
  if (elapsedMs >= VOICE_COUNTDOWN_MS) {
    return { state: 'nearcap', word: 'Listening', hint: phone ? '' : 'Stops at 2:00', bars, time: `${voiceClock(VOICE_CAP_MS - elapsedMs + 999)} left`, cancel: !held };
  }
  if (held) return { state: 'hold', word: 'Listening', hint: phone ? 'Slide to cancel' : 'Let go to stop · Esc cancels', bars, time, cancel: false };
  return { state: 'tap', word: 'Listening', hint: phone ? '' : 'Tap the mic to stop', bars, time, cancel: true };
}
