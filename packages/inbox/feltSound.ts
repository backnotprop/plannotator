export type InboxSoundKind = 'question' | 'thread';

export interface FeltNote {
  freq: number;
  t: number;
  amp: number;
}

const hz = (semitonesFromA4: number) => 440 * Math.pow(2, semitonesFromA4 / 12);

export const FELT_G4 = hz(-2);
export const FELT_D5 = hz(5);

const QUESTION_LEVEL = 0.2113;
const THREAD_LEVEL = 0.1585;

export const INBOX_SOUNDS: Record<InboxSoundKind, readonly FeltNote[]> = {
  question: [
    { freq: FELT_G4, t: 0, amp: 0.8 * QUESTION_LEVEL },
    { freq: FELT_D5, t: 0.105, amp: QUESTION_LEVEL },
  ],
  thread: [{ freq: FELT_D5, t: 0, amp: THREAD_LEVEL }],
};

export const INBOX_SOUND_MS: Record<InboxSoundKind, number> = { question: 600, thread: 450 };

const TAU = 0.16;
const PARTIALS = [
  { ratio: 1, amp: 1, tau: TAU },
  { ratio: 3.93, amp: 0.1, tau: TAU / 5 },
  { ratio: 9.2, amp: 0.015, tau: TAU / 12 },
  { ratio: 2, amp: 0.04, tau: TAU / 2 },
] as const;

const LENGTH = 0.45;
const ATTACK = 0.003;
const FADE = 0.008;

export function scheduleFelt(ctx: BaseAudioContext, master: AudioNode, note: FeltNote): void {
  const start = ctx.currentTime + note.t;
  for (const partial of PARTIALS) {
    const amp = note.amp * partial.amp;
    const peak = amp * Math.exp(-ATTACK / partial.tau);
    const tail = amp * Math.exp(-(LENGTH - FADE) / partial.tau);
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(note.freq * partial.ratio, start);
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(peak, start + ATTACK);
    gain.gain.exponentialRampToValueAtTime(tail, start + LENGTH - FADE);
    gain.gain.exponentialRampToValueAtTime(tail / 1000, start + LENGTH);
    osc.connect(gain).connect(master);
    osc.start(start);
    osc.stop(start + LENGTH + 0.01);
  }
}
