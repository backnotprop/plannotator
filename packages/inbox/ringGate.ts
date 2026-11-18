import type { InboxSoundKind } from './feltSound';

export const RING_BURST_MS = 30_000;

export interface RingGate {
  lastAt: number | null;
  asked: boolean;
}

export const QUIET_GATE: RingGate = { lastAt: null, asked: false };

export interface RingInput {
  now: number;
  kind: InboxSoundKind;
  enabled: boolean;
  inFront: boolean;
  otherTabInFront: boolean;
}

export function decideRing(gate: RingGate, input: RingInput): { ring: boolean; gate: RingGate } {
  if (!input.enabled) return { ring: false, gate };
  if (input.inFront || input.otherTabInFront) return { ring: false, gate: QUIET_GATE };
  const question = input.kind === 'question';
  const inBurst = gate.lastAt !== null && input.now - gate.lastAt < RING_BURST_MS;
  if (!inBurst) return { ring: true, gate: { lastAt: input.now, asked: question } };
  return { ring: question && !gate.asked, gate: { lastAt: input.now, asked: gate.asked || question } };
}

export function heardRing(gate: RingGate, at: number, kind: InboxSoundKind): RingGate {
  const question = kind === 'question';
  if (gate.lastAt !== null && gate.lastAt >= at) return { lastAt: gate.lastAt, asked: gate.asked || (question && gate.lastAt - at < RING_BURST_MS) };
  const carried = gate.lastAt !== null && at - gate.lastAt < RING_BURST_MS && gate.asked;
  return { lastAt: at, asked: carried || question };
}
