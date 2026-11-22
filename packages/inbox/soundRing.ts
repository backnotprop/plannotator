/**
 * When the Inbox's sound rings: pure rules, no timers and no DOM (sound.ts runs them).
 *
 * One sound, the Ding-dong (the bell), for every kind of news:
 * - A question (or an action item) rings the bell unless another question came within RING_BURST_MS: questions among
 *   themselves keep the rule they had before the choice. A plain message never holds a question back.
 * - A new thread rings the bell unless another new thread or a question came within RING_BURST_MS.
 * - A plain agent message (a reply or a failed turn's note) rings the bell only under "for every
 *   agent message", by `plainMessageRings`: the one place the owner's cadence lives.
 * - One list read rings the bell once.
 *
 * Either way nothing rings with the sound off or an Inbox tab in front, and a tab coming to the front ends the bursts.
 * A notice about news is silent when the bell rang in that news's burst (now, or earlier in it): one sound per burst,
 * the bell's, as before the choice; a burst the bell never rang in (the tab not armed yet) keeps the system's.
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
  /** The bell rang in the burst `lastAt` ends (for anything): plain news in it is the bell's, its notice silent. */
  lastRang: boolean;
  /** The bell rang for a question in the question burst `askAt` ends: a question in it is the bell's, its notice silent. */
  askRang: boolean;
  freshAt: number | null;
  freshRang: boolean;
}

export const QUIET_GATE: RingGate = { lastAt: null, askAt: null, lastRang: false, askRang: false, freshAt: null, freshRang: false };

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
  fresh?: boolean;
}

/**
 * Which of the news is the bell's: it rang for it now, or already rang in that kind's burst. The notices about that
 * news are silent (there is one sound per burst), the rest keep the system's.
 */
export interface RangFor {
  asks: boolean;
  plain: boolean;
  fresh: boolean;
}

export const RANG_FOR_NOTHING: RangFor = { asks: false, plain: false, fresh: false };

const within = (at: number | null, now: number) => at !== null && now - at < RING_BURST_MS;

export function newThreadRings(gate: RingGate, now: number): boolean {
  return !within(gate.freshAt, now) && !within(gate.askAt, now);
}

/**
 * News arrived: ring or not, for which of it, and the bursts after. Pure.
 *
 * - Sound off: nothing, and the bursts are left as they were.
 * - An Inbox tab in front (this one or another): nothing; the person sees the list, so the bursts end.
 * - Plain news under "when an agent asks you" is not the sound's: it neither rings nor moves a burst.
 * - Otherwise a question rings by `questionRings`, a new thread by `newThreadRings`, plain news by
 *   `plainMessageRings`; either ringing is one sound, and it is for every piece of this news that is the sound's.
 * - `armed` false (the browser would not play it yet): nothing rings, and the burst is not marked as rung.
 * - `rangFor`: what of this news is the bell's, rung now or earlier in its burst.
 */
export function decideRing(
  gate: RingGate,
  input: { now: number; enabled: boolean; inFront: boolean; otherTabInFront: boolean; when?: InboxSoundWhen; armed?: boolean } & RingNews,
): { ring: boolean; rangFor: RangFor; gate: RingGate } {
  if (!input.enabled) return { ring: false, rangFor: RANG_FOR_NOTHING, gate };
  if (input.inFront || input.otherTabInFront) return { ring: false, rangFor: RANG_FOR_NOTHING, gate: QUIET_GATE };
  const plain = input.plain && ringsFor(input.when, false);
  const fresh = input.fresh === true;
  if (!input.asks && !plain && !fresh) return { ring: false, rangFor: RANG_FOR_NOTHING, gate };
  const now = input.now;
  const newBurst = plainMessageRings(gate, now);
  const newAskBurst = questionRings(gate, now);
  const ring = input.armed !== false && ((input.asks && newAskBurst) || (fresh && newThreadRings(gate, now)) || (plain && newBurst));
  const lastRang = ring || (!newBurst && gate.lastRang);
  const askRang = input.asks ? ring || (!newAskBurst && gate.askRang) : gate.askRang;
  const freshHeld = (within(gate.freshAt, now) && gate.freshRang) || (within(gate.askAt, now) && gate.askRang);
  const freshRang = fresh ? ring || freshHeld : gate.freshRang;
  return {
    ring,
    rangFor: { asks: input.asks && askRang, plain: plain && lastRang, fresh: fresh && freshRang },
    gate: { lastAt: now, askAt: input.asks ? now : gate.askAt, lastRang, askRang, freshAt: fresh ? now : gate.freshAt, freshRang },
  };
}

/** Another tab rang at `at` (for a question when `asked`): this tab is in that burst too, a burst the bell rang in. */
export function heardRing(gate: RingGate, at: number, asked: boolean, fresh = false): RingGate {
  const later = (mine: number | null) => (mine === null ? at : Math.max(mine, at));
  const lastAt = later(gate.lastAt);
  const askAt = asked ? later(gate.askAt) : gate.askAt;
  const freshAt = fresh ? later(gate.freshAt) : gate.freshAt;
  return {
    lastAt,
    askAt,
    lastRang: gate.lastRang || lastAt - at < RING_BURST_MS,
    askRang: asked ? gate.askRang || (askAt ?? at) - at < RING_BURST_MS : gate.askRang,
    freshAt,
    freshRang: fresh ? gate.freshRang || (freshAt ?? at) - at < RING_BURST_MS : gate.freshRang,
  };
}
