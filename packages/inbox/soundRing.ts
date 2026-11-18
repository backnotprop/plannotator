/**
 * When the Inbox's sound rings: pure rules, no timers and no DOM (sound.ts runs them).
 *
 * Two kinds of news, with separate rules:
 * - A question (or an action item) rings unless another question came within RING_BURST_MS: questions among
 *   themselves keep the rule they had before the choice. A plain message never holds a question back.
 * - A plain agent message (a reply, a new thread that asks nothing, a failed turn's note) rings only under "for every
 *   agent message", by `plainMessageRings`: the one place the owner's cadence lives.
 *
 * Either way nothing rings with the sound off or an Inbox tab in front, and a tab coming to the front ends the bursts.
 */

import { inboxSoundWhen, type InboxSoundWhen } from '@plannotator/core/inbox-types';

/** A burst: news within this long of the last news of its kind stays silent. */
export const RING_BURST_MS = 30_000;

/**
 * How long a tab holds the ring lock (sound.ts): long enough that every Inbox tab has handled the same event, so a
 * ring for news, if any, has played within this long of the list read that brought it.
 */
export const RING_LOCK_MS = 3000;

export interface RingGate {
  /** When the last news of any kind arrived (this tab's, or a ring another tab reported); null: no burst. */
  lastAt: number | null;
  /** When the last question arrived (this tab's, or a question ring another tab reported); null: no question burst. */
  askAt: number | null;
}

export const QUIET_GATE: RingGate = { lastAt: null, askAt: null };

/**
 * Whether news of this kind is the sound's business under the person's choice: a question always; a plain agent
 * message only under "for every agent message" (also the default, with nothing chosen).
 */
export function ringsFor(when: InboxSoundWhen | undefined, asks: boolean): boolean {
  return asks || inboxSoundWhen(when) === 'messages';
}

/** A question rings unless another question came within RING_BURST_MS (the rule before the choice). */
export function questionRings(gate: RingGate, now: number): boolean {
  return gate.askAt === null || now - gate.askAt >= RING_BURST_MS;
}

/**
 * THE cadence for plain agent messages while no Inbox tab is in front (the owner, 2026-11-18: "Every message, as
 * picked (about once a minute with a few agents busy)"): each one rings unless other news came within the last
 * RING_BURST_MS, so a burst of agents writing at once rings once. Change the cadence here and nowhere else.
 */
export function plainMessageRings(gate: RingGate, now: number): boolean {
  return gate.lastAt === null || now - gate.lastAt >= RING_BURST_MS;
}

/** What one list read brought: a question among it (`asks`), a plain agent message among it (`plain`). */
export interface RingNews {
  asks: boolean;
  plain: boolean;
}

/** Which of the news the bell rang for: the notices about that news are silent (there is one sound), the rest keep the system's. */
export interface RangFor {
  asks: boolean;
  plain: boolean;
}

export const RANG_FOR_NOTHING: RangFor = { asks: false, plain: false };

/**
 * News arrived: ring or not, for which of it, and the bursts after. Pure.
 *
 * - Sound off: nothing, and the bursts are left as they were.
 * - An Inbox tab in front (this one or another): nothing; the person sees the list, so the bursts end.
 * - Plain news under "when an agent asks you" is not the sound's: it neither rings nor moves a burst.
 * - Otherwise a question rings by `questionRings`, plain news by `plainMessageRings`; either ringing is one sound,
 *   and it is for every piece of this news that is the sound's.
 */
export function decideRing(
  gate: RingGate,
  input: { now: number; enabled: boolean; inFront: boolean; otherTabInFront: boolean; when?: InboxSoundWhen } & RingNews,
): { ring: boolean; rangFor: RangFor; gate: RingGate } {
  if (!input.enabled) return { ring: false, rangFor: RANG_FOR_NOTHING, gate };
  if (input.inFront || input.otherTabInFront) return { ring: false, rangFor: RANG_FOR_NOTHING, gate: QUIET_GATE };
  const plain = input.plain && ringsFor(input.when, false);
  if (!input.asks && !plain) return { ring: false, rangFor: RANG_FOR_NOTHING, gate };
  const ring = (input.asks && questionRings(gate, input.now)) || (plain && plainMessageRings(gate, input.now));
  return {
    ring,
    rangFor: ring ? { asks: input.asks, plain } : RANG_FOR_NOTHING,
    gate: { lastAt: input.now, askAt: input.asks ? input.now : gate.askAt },
  };
}

/** Another tab rang at `at` (for a question when `asked`): this tab is in that burst too. */
export function heardRing(gate: RingGate, at: number, asked: boolean): RingGate {
  const later = (mine: number | null) => (mine === null ? at : Math.max(mine, at));
  return { lastAt: later(gate.lastAt), askAt: asked ? later(gate.askAt) : gate.askAt };
}
