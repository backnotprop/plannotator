/**
 * Voice dictation's sums: the clip's WAV, the voice gate, the clock. No browser APIs, so tests read them directly.
 */

/** The rate of the clip the Inbox sends on: the format the route was verified with, and the source of the 5.8 MB limit. */
export const VOICE_WAV_RATE = 24_000;

/** One mono 16-bit PCM WAV at 24 kHz from the samples as they came, averaging what falls in each output sample. */
export function encodeWav(chunks: readonly Float32Array[], rate: number): Blob {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const samples = new Float32Array(total);
  let filled = 0;
  for (const chunk of chunks) {
    samples.set(chunk, filled);
    filled += chunk.length;
  }
  const ratio = rate / VOICE_WAV_RATE;
  const out = new Int16Array(Math.floor(total / ratio));
  for (let i = 0; i < out.length; i++) {
    const from = Math.floor(i * ratio);
    const to = Math.max(from + 1, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let at = from; at < to; at++) sum += samples[at] ?? 0;
    out[i] = Math.max(-1, Math.min(1, sum / (to - from))) * 32767;
  }
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  const text = (at: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(at + i, value.charCodeAt(i));
  };
  text(0, 'RIFF');
  view.setUint32(4, 36 + out.byteLength, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, VOICE_WAV_RATE, true);
  view.setUint32(28, VOICE_WAV_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, out.byteLength, true);
  return new Blob([header, out.buffer], { type: 'audio/wav' });
}

/**
 * Is this voice? The floor is the quietest thing heard this clip, and it follows the room up slowly. A dip between
 * syllables resets it, so a clip that opens on speech still finds the floor. The gate sits 10 dB above it, inside
 * fixed limits: below -52 dB is never voice, above -30 dB always is. Digital zero is the stream starting up, not the
 * room, so it never pins the floor. The values come from synthetic clips, not a real room.
 */
export function createVoiceGate(): (db: number) => { level: number; voice: boolean } {
  let floor: number | null = null;
  return (db) => {
    if (db > -90) floor = floor === null || db < floor ? db : floor + 0.02;
    const gate = Math.min(-30, Math.max(-52, (floor ?? -62) + 10));
    return { level: Math.max(0, Math.min(1, (db + 60) / 50)), voice: db > gate };
  };
}

/** `0:07`, `1:45`. */
export function voiceClock(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
