/**
 * Emoji reactions on the person's replies (approval "inbox-emoji-reactions";
 * design record `.product/approved/inbox-emoji-reactions/`): the decision the
 * Inbox makes when an agent receives a reply (`InboxStore.recordDelivery`).
 * The mood gate (gate.ts, with VADER in vader.ts), the pacing (pacing.ts) and
 * the picker (picker.ts) all run here, on this computer: no network, no model.
 */

import type { InboxReaction } from "@plannotator/core/inbox-types";
import { mood, type MoodResult } from "./gate";
import { chance, decidePace, MOOD_MAX_CHARS, paceKind, reactionDelayMs, type PaceEntry, type ReactionLevel } from "./pacing";
import { pickEmoji } from "./picker";

export { mood } from "./gate";
export { decidePace, paceKind, type ReactionLevel } from "./pacing";
export { pickEmoji, REACTION_REST } from "./picker";

/** The moods already read, by message id and the length read (a delivery reads the day's replies again). */
const moods = new Map<string, MoodResult>();
const MOOD_CACHE_MAX = 4000;

/** The gate on a message's text, never on more than `MOOD_MAX_CHARS` (its cost grows with the square of a sentence). */
function moodOf(id: string, full: string): MoodResult {
  const text = full.length > MOOD_MAX_CHARS ? full.slice(0, MOOD_MAX_CHARS) : full;
  const key = `${id}\u0000${text.length}`;
  const hit = moods.get(key);
  if (hit) return hit;
  const m = mood(text);
  if (moods.size >= MOOD_CACHE_MAX) moods.clear();
  moods.set(key, m);
  return m;
}

/** A delivered reply, as the decision reads it: the person's own words, when it reached its agent (ms). */
export interface ReactionReply {
  id: string;
  thread: string;
  text: string;
  at: number;
}

export interface ReactionInput {
  level: ReactionLevel;
  reply: ReactionReply;
  /** The replies delivered before it (the last day is enough), oldest first, with whether each got one. */
  history: readonly (ReactionReply & { reacted: boolean })[];
  /** The latest reactions' emoji, oldest first: they rest (picker.ts). */
  recent: readonly string[];
}

/** The reaction a reply gets as its agent receives it, or null. Deterministic. */
export function decideReaction(input: ReactionInput): InboxReaction | null {
  const { reply } = input;
  const kind = paceKind(reply.text, (text) => moodOf(reply.id, text));
  const history: PaceEntry[] = input.history.map((h) => ({ id: h.id, thread: h.thread, at: h.at, kind: paceKind(h.text, (text) => moodOf(h.id, text)), reacted: h.reacted }));
  const pace = decidePace(history, { id: reply.id, thread: reply.thread, at: reply.at, kind }, input.level);
  if (!pace.react) return null;
  // Only a short reply gets this far (pacing.ts): the gate already read it, whole.
  const m = moodOf(reply.id, reply.text);
  const emoji = pickEmoji({ text: reply.text, mood: m.mood, kind: m.kind, recent: input.recent, rand: chance(reply.id, "pick") });
  if (!emoji) return null;
  return { emoji, at: new Date(reply.at + reactionDelayMs(reply.id)).toISOString() };
}
