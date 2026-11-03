/**
 * How often (approval "inbox-emoji-reactions", item 4): the "warmth + owed"
 * pacing model of the research round (r2-design model.js), with the owner's
 * 11:40Z amendment. Pure and deterministic: every chance is a number drawn
 * from the message id, so a reply's fate is decided once, and replaying the
 * same day gives the same answer.
 *
 * - Code, errors (pasted output) and long replies never get one.
 * - Frustration never gets one, and starts a 20 min cool-down in its thread:
 *   only thanks or a win may get one there meanwhile.
 * - "Owed" is a rising chance: after deserving replies (thanks, a win, a
 *   joke) got nothing, likely at 2, near-certain at 4 (Often: one sooner).
 * - "Never 2 in a row in one thread" is a strong drop, not a rule: rare, not
 *   impossible.
 * - A gap between reactions (6–15 min; Often 2–6) and a daily cap (12; Often
 *   20). A day starts after 6 h without a delivered reply.
 * - Warmth: each reaction lowers the next one's chance; it refills over the hour.
 */

import { ERR_STRONG_OUTPUT, type MoodResult } from "./gate";

export type ReactionLevel = "sometimes" | "often";

/** What the pacing reads a reply as. */
export type PaceKind = "thanks" | "win" | "joke" | "go" | "ask" | "neutral" | "frustrated" | "unsure" | "never";

/** How much each kind deserves a reaction. */
const DESERVE: Record<PaceKind, number> = { thanks: 0.9, win: 0.85, joke: 0.7, go: 0.25, ask: 0.12, neutral: 0.03, frustrated: 0, unsure: 0, never: 0 };
/** Thanks, a win, a joke. */
const DESERVING = 0.7;

interface Level {
  C: number;
  cost: number;
  refillPerHour: number;
  gapMin: number;
  gapMax: number;
  cap: number;
  /** The owed chance by how many deserving replies in a row got nothing (index), the last one for more. */
  owed: readonly number[];
}

/** "Often" means more of everything. */
export const REACTION_LEVELS: Readonly<Record<ReactionLevel, Level>> = {
  sometimes: { C: 0.3, cost: 0.4, refillPerHour: 0.5, gapMin: 6, gapMax: 15, cap: 12, owed: [0, 0, 0.7, 0.88, 0.97] },
  often: { C: 0.55, cost: 0.25, refillPerHour: 0.9, gapMin: 2, gapMax: 6, cap: 20, owed: [0, 0.7, 0.88, 0.97] },
};
/** A day starts after this long without a delivered reply. */
export const NEW_DAY_GAP_MIN = 6 * 60;
/** The owed count a day starts with. */
const DAY_HEAD_START = 1;
/** After frustration in a thread, only thanks or a win may get one for this long. */
export const COOL_MIN = 20;
/** A reply right after a reaction in the same thread keeps this share of its chance. */
export const REPEAT_DROP = 0.1;
/** Warmth below this: no owed lift. */
const OWED_MIN_WARMTH = 0.25;
/** Long: more characters than this, or more lines. */
const LONG_CHARS = 140;
const LONG_LINES = 2;

const CODE = /```|`[^`]+`|\b\w+\.(ts|tsx|js|py|go|rs|css):\d+|\bat \w+ \(|^\s{4}\S/m;
const ASK = /\?\s*$|^(can you|could you|please|check|look at|try|would you)\b/i;

/** FNV-1a, then murmur3's fmix32, into [0, 1): the model's only source of chance. */
export function chance(id: string, salt: string): number {
  const s = `${id}:${salt}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/**
 * The most of a reply the mood gate ever reads. The gate's praise check is
 * quadratic in a sentence's length and runs inside the delivery, so a long
 * reply (up to 1,000,000 characters) is never read whole.
 */
export const MOOD_MAX_CHARS = 2000;

/** More than 140 characters or more than 2 lines: linear, and stops at the third line. */
export function isLongReply(t: string): boolean {
  if (t.length > LONG_CHARS) return true;
  let lines = 1;
  for (let i = t.indexOf("\n"); i >= 0; i = t.indexOf("\n", i + 1)) if (++lines > LONG_LINES) return true;
  return false;
}

/**
 * The pacing's reading of a reply. `readMood` runs the mood gate (on at most
 * `MOOD_MAX_CHARS`). Long replies, code and pasted errors never get one, so
 * they are decided first from cheap checks; for them the gate reads only the
 * head, to tell frustration (which starts the cool-down) from the rest.
 */
export function paceKind(text: string, readMood: (text: string) => MoodResult): PaceKind {
  const t = text.trim();
  // Long first: the code and error patterns then only ever run on 140 characters.
  if (isLongReply(t) || CODE.test(t) || ERR_STRONG_OUTPUT.test(t)) return readMood(text.slice(0, MOOD_MAX_CHARS)).mood === "frustrated" ? "frustrated" : "never";
  const m = readMood(text);
  if (m.mood === "frustrated") return "frustrated";
  if (m.mood === "unsure") return "unsure";
  if (m.mood === "positive") return m.kind === "joke" ? "joke" : m.kind === "win" ? "win" : "thanks";
  if (m.mood === "neutral" && m.kind === "goahead") return "go";
  // A calm bug report: 👀 or 🤔, a low chance, as a question gets.
  if (m.mood === "error") return "ask";
  return ASK.test(t) ? "ask" : "neutral";
}

/** One delivered reply, for the replay: when (ms), where, what it was read as, and whether it got one. */
export interface PaceEntry {
  id: string;
  thread: string;
  at: number;
  kind: PaceKind;
  /** It got a reaction (history), null for the reply being decided. */
  reacted: boolean | null;
}

export interface PaceDecision {
  react: boolean;
  /** The chance it had. */
  p: number;
  why: string;
}

/**
 * Decide `current` after replaying `history` (earlier deliveries, oldest
 * first, with what they really got: a level change or an Off day in between
 * stays as it was). Only the last day matters; older entries are harmless.
 */
export function decidePace(history: readonly PaceEntry[], current: Omit<PaceEntry, "reacted">, level: ReactionLevel): PaceDecision {
  const L = REACTION_LEVELS[level];
  let warmth = 1;
  let lastAt = -Infinity;
  let gap = 0;
  let owed = DAY_HEAD_START;
  let day = 0;
  let prevT: number | null = null;
  const threads = new Map<string, { prevReacted: boolean; coolUntil: number }>();
  const step = (entry: PaceEntry | Omit<PaceEntry, "reacted">, outcome: boolean | null): PaceDecision | null => {
    const t = entry.at / 60_000;
    let T = threads.get(entry.thread);
    if (!T) threads.set(entry.thread, (T = { prevReacted: false, coolUntil: -Infinity }));
    if (prevT === null || t - prevT >= NEW_DAY_GAP_MIN) {
      warmth = 1;
      owed = DAY_HEAD_START;
      day = 0;
      lastAt = -Infinity;
    } else warmth = Math.min(1, warmth + (L.refillPerHour * (t - prevT)) / 60);
    prevT = t;
    const d = DESERVE[entry.kind];
    const deserving = d >= DESERVING;
    let p = 0;
    let why = "";
    if (entry.kind === "frustrated") {
      T.coolUntil = t + COOL_MIN;
      why = "frustrated: never";
    } else if (entry.kind === "never") why = "code, an error or long: never";
    else if (entry.kind === "unsure") why = "unsure: never";
    else if (t < T.coolUntil && entry.kind !== "thanks" && entry.kind !== "win") why = "cooling after frustration";
    else if (t - lastAt < gap) why = `gap (${Math.round(gap)} min)`;
    else if (day >= L.cap) why = "daily cap";
    else {
      const lift = deserving ? Math.min(1, L.C * (owed + 1)) : L.C;
      p = d * lift * (0.3 + 0.7 * warmth);
      if (deserving && warmth >= OWED_MIN_WARMTH) {
        const owedChance = L.owed[Math.min(owed, L.owed.length - 1)]!;
        if (owedChance > p) {
          p = owedChance;
          why = `owed: ${owed} deserving missed`;
        }
      }
      if (T.prevReacted) {
        p *= REPEAT_DROP;
        why = "the last reply here got one";
      }
    }
    let reacted: boolean;
    let decision: PaceDecision | null = null;
    if (outcome === null) {
      const u = chance(entry.id, "rx");
      reacted = p > 0 && u < p;
      decision = { react: reacted, p, why: why || (p > 0 ? `drew ${u.toFixed(2)} against ${p.toFixed(2)}` : "no") };
    } else reacted = outcome;
    if (reacted) {
      lastAt = t;
      gap = L.gapMin + (L.gapMax - L.gapMin) * chance(entry.id, "gap");
      warmth = Math.max(0, warmth - L.cost);
      if (deserving) owed = 0;
      day++;
      T.prevReacted = true;
    } else {
      if (deserving) owed++;
      T.prevReacted = false;
    }
    return decision;
  };
  for (const entry of history) step(entry, entry.reacted === true);
  return step(current, null)!;
}

/** How long after delivery the badge lands: 0.8 to 2.5 s, from the message id. */
export function reactionDelayMs(id: string): number {
  return Math.round((0.8 + 1.7 * chance(id, "delay")) * 1000);
}
