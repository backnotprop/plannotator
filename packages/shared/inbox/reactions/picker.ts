/**
 * Which emoji (approval "inbox-emoji-reactions", item 2): one picker on every
 * platform, drawing from the approved 73-emoji pool (`pool.json`, a copy of
 * `.product/approved/inbox-emoji-reactions/picker/pool.json`), each tagged
 * with meaning words and mood families. The scoring is gate.py's `Picker`:
 *
 * - The mood decides which (family, tone) it may draw from (`GATE`). Every
 *   pool emoji is happy, calm or grim; no mood reaches a grim one, and an
 *   error reaches only 👀 or 🤔.
 * - Pick by meaning: an emoji scores the length of each of its meaning
 *   phrases found in the person's own words, plus a small bonus for the
 *   kind's defaults.
 * - Random among near-equal picks: every emoji within 0.6 of the best (six at
 *   most), chosen by `rand` (a number from the message id, so the pick is
 *   decided once and every device shows the same).
 * - No repeats: the last 8 reactions rest; when nothing is left the least
 *   recently used one that is not the last.
 *
 * gate.py's "25% of plain requests react" is not here: whether a reply gets a
 * reaction at all is the pacing's (pacing.ts).
 */

import POOL_JSON from "./pool.json" with { type: "json" };
import { ownVoice, type ReactionKind, type ReactionMood } from "./gate";

interface PoolEntry {
  words: string[];
  families: string[];
  name: string;
}

export const REACTION_POOL: Readonly<Record<string, PoolEntry>> = (POOL_JSON as unknown as { kept: Record<string, PoolEntry> }).kept;

export type ReactionTone = "happy" | "calm" | "grim";

/**
 * gate.py's TONE. happy: celebratory, warm. calm: neutral acknowledgement.
 * grim: sad, pining, anxious, embarrassed, huffing or ambiguous faces, which
 * nothing can reach.
 */
export const REACTION_TONE: Readonly<Record<string, ReactionTone>> = (() => {
  const tone: Record<string, ReactionTone> = {};
  for (const e of "🙏 😂 ❤️ 🤣 🥰 😍 😊 🎉 😁 🔥 ☺️ ♥️ 😆 🤗 😉 👏 🥳 😎 💜 💪 ✨ 💖 💯 🎈 💙 😃 😜 😄 🙌 🤪 😀 😌 🤩 🎊 💚 💥 🤯 🧡 💛 🤍 🌟 🚀 🏆 👊 🤘 🫶 🩷 🩵".split(" ")) tone[e] = "happy";
  for (const e of "👍 👌 🤔 👀 🙋 ✅ 🤝 🫡 🙂‍↕️".split(" ")) tone[e] = "calm";
  for (const e of "😭 😅 🤦 😳 🙈 🤞 🤭 😬 🙇 😮 😤 🥲 🥹 🫠 🫢 🫣".split(" ")) tone[e] = "grim";
  return tone;
})();

export type ReactionGateKey = "positive" | "positive+joke" | "neutral:goahead" | "neutral:looking" | "error";

/** Which (families, tones) each mood may draw from. */
const GATE: Record<ReactionGateKey, { families: string[]; tones: ReactionTone[] }> = {
  positive: { families: ["praise", "win"], tones: ["happy"] },
  "positive+joke": { families: ["praise", "win", "joke"], tones: ["happy"] },
  "neutral:goahead": { families: ["goahead"], tones: ["calm"] },
  "neutral:looking": { families: ["looking"], tones: ["calm"] },
  error: { families: ["looking"], tones: ["calm"] },
};
/** "Raising hand / me": odd on a request or an error report. */
const EXCLUDE = new Set(["🙋"]);

/** The emoji a mood may draw from, in pool order. */
export function allowedEmoji(key: ReactionGateKey): string[] {
  const { families, tones } = GATE[key];
  return Object.entries(REACTION_POOL)
    .filter(([e, v]) => v.families.some((f) => families.includes(f)) && tones.includes(REACTION_TONE[e]!) && !EXCLUDE.has(e))
    .map(([e]) => e);
}

/** The defaults each kind leans to, best first (a small bonus). */
const DEF: Record<string, string[]> = {
  praise: ["❤️", "👏", "✨", "🙌", "🔥", "🤩", "🫶", "🌟"],
  thanks: ["🙏", "❤️", "🫶", "😊", "🤗", "💙"],
  win: ["🎉", "🙌", "🥳", "🚀", "😎", "💪", "🏆", "✨"],
  joke: ["😂", "🤣", "😆", "😜", "🤪", "😉"],
  goahead: ["👍", "👌", "🫡", "🤝", "🙂‍↕️", "✅"],
  looking: ["👀", "🤔"],
};

/** How many of the latest reactions rest. */
export const REACTION_REST = 8;

const STOPW = new Set(
  "i me my we our you your it its this that these those is are was were be been am do does did a an the and or but if so then than to of in on at by for with from up down out about into over just like not no yes yeah yep ok okay hey bro dude let lets what why how where when who which can could would should will make sure go get got all some any there here now also really actually still again even one thing things".split(
    " ",
  ),
);
const stem = (w: string) => (w.length > 4 ? w.replace(/(ing|ed|es|s)$/, "") : w);
function norm(t: string): string[] {
  const s = t.toLowerCase().replace(/’/g, "'").replace(/n't\b/g, " not");
  return (s.match(/[a-z0-9]+/g) ?? []).map(stem);
}

const PHRASES: Record<string, string[][]> = Object.fromEntries(
  Object.entries(REACTION_POOL).map(([e, v]) => [e, v.words.map(norm).filter((p) => p.length > 0 && (p.length > 1 || !STOPW.has(p[0]!)))]),
);

export function gateKey(mood: ReactionMood, kind: ReactionKind | null): ReactionGateKey | null {
  if (mood === "positive") return kind === "joke" ? "positive+joke" : "positive";
  if (mood === "error") return "error";
  if (mood === "neutral") return kind === "goahead" ? "neutral:goahead" : "neutral:looking";
  return null;
}

/**
 * The emoji for a reply the mood allows a reaction on, or null (frustrated,
 * unsure). `recent`: the reactions so far, oldest first. `rand`: in [0, 1).
 */
export function pickEmoji(input: { text: string; mood: ReactionMood; kind: ReactionKind | null; recent: readonly string[]; rand: number }): string | null {
  const key = gateKey(input.mood, input.kind);
  if (!key) return null;
  const cand = allowedEmoji(key);
  const own = " " + norm(ownVoice(input.text)).join(" ") + " ";
  const defaults = DEF[input.mood === "error" ? "looking" : (input.kind ?? "looking")] ?? [];
  const score = new Map<string, number>();
  for (const e of cand) {
    let s = 0;
    for (const p of PHRASES[e] ?? []) if (own.includes(" " + p.join(" ") + " ")) s += p.length;
    const d = defaults.indexOf(e);
    if (d >= 0) s += 0.5 - 0.04 * d;
    if (s > 0) score.set(e, s);
  }
  if (score.size === 0) for (const e of cand) score.set(e, 0.01);
  const ranked = [...score.keys()].sort((a, b) => score.get(b)! - score.get(a)! || (a < b ? -1 : a > b ? 1 : 0));
  if (ranked.length === 0) return null;
  const top = score.get(ranked[0]!)!;
  const tier = ranked.filter((e) => score.get(e)! >= top - 0.6).slice(0, 6);
  const resting = new Set(input.recent.slice(-REACTION_REST));
  const last = input.recent.length > 0 ? input.recent[input.recent.length - 1] : undefined;
  let fresh = tier.filter((e) => !resting.has(e));
  if (fresh.length === 0) fresh = ranked.filter((e) => !resting.has(e));
  if (fresh.length === 0) {
    // Tiny sets (an error has two): the least recently used that is not the last one.
    const lastUse = (e: string) => input.recent.lastIndexOf(e);
    fresh = ranked
      .filter((e) => e !== last)
      .sort((a, b) => lastUse(a) - lastUse(b))
      .slice(0, 1);
    if (fresh.length === 0) fresh = ranked.slice(0, 1);
  }
  return fresh[Math.min(fresh.length - 1, Math.floor(input.rand * fresh.length))]!;
}
