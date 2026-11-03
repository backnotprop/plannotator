/**
 * VADER's compound score, ported from vaderSentiment 3.3.2 (Python), the
 * version the Inbox's mood gate was measured with
 * (`.product/approved/inbox-emoji-reactions/mood-gate/gate.py`).
 *
 * VADER (Valence Aware Dictionary and sEntiment Reasoner), C.J. Hutto,
 * MIT License, Copyright (c) 2016 C.J. Hutto. Hutto, C.J. & Gilbert, E.E.
 * (2014). VADER: A Parsimonious Rule-based Model for Sentiment Analysis of
 * Social Media Text. ICWSM-14. https://github.com/cjhutto/vaderSentiment
 *
 * The rules are a line-for-line port, quirks included (`_but_check` finds a
 * score by value, as the Python does), so the gate decides as it was measured.
 * `vader-lexicon.json` is `vader_lexicon.txt` as word → mean valence;
 * `vader-emoji.json` is `emoji_utf8_lexicon.txt` cut to its single code point
 * entries, the only ones `polarity_scores` can match (it looks emoji up one
 * code point at a time). Nothing here reads the network or the disk at run time.
 */

import LEXICON_JSON from "./vader-lexicon.json" with { type: "json" };
import EMOJI_JSON from "./vader-emoji.json" with { type: "json" };

const LEXICON = new Map<string, number>(Object.entries(LEXICON_JSON as Record<string, number>));
const EMOJI = new Map<string, string>(Object.entries(EMOJI_JSON as Record<string, string>));

const B_INCR = 0.293;
const B_DECR = -0.293;
const C_INCR = 0.733;
const N_SCALAR = -0.74;

const NEGATE = new Set([
  "aint", "arent", "cannot", "cant", "couldnt", "darent", "didnt", "doesnt",
  "ain't", "aren't", "can't", "couldn't", "daren't", "didn't", "doesn't",
  "dont", "hadnt", "hasnt", "havent", "isnt", "mightnt", "mustnt", "neither",
  "don't", "hadn't", "hasn't", "haven't", "isn't", "mightn't", "mustn't",
  "neednt", "needn't", "never", "none", "nope", "nor", "not", "nothing", "nowhere",
  "oughtnt", "shant", "shouldnt", "uhuh", "wasnt", "werent",
  "oughtn't", "shan't", "shouldn't", "uh-uh", "wasn't", "weren't",
  "without", "wont", "wouldnt", "won't", "wouldn't", "rarely", "seldom", "despite",
]);

const BOOSTER: Record<string, number> = {};
for (const w of "absolutely amazingly awfully completely considerable considerably decidedly deeply effing enormous enormously entirely especially exceptional exceptionally extreme extremely fabulously flipping flippin frackin fracking fricking frickin frigging friggin fully fuckin fucking fuggin fugging greatly hella highly hugely incredible incredibly intensely major majorly more most particularly purely quite really remarkably so substantially thoroughly total totally tremendous tremendously uber unbelievably unusually utter utterly very".split(" ")) BOOSTER[w] = B_INCR;
for (const w of ["almost", "barely", "hardly", "just enough", "kind of", "kinda", "kindof", "kind-of", "less", "little", "marginal", "marginally", "occasional", "occasionally", "partly", "scarce", "scarcely", "slight", "slightly", "somewhat", "sort of", "sorta", "sortof", "sort-of"]) BOOSTER[w] = B_DECR;
const isBooster = (w: string) => Object.prototype.hasOwnProperty.call(BOOSTER, w);

const SPECIAL_CASES: Record<string, number> = {
  "the shit": 3, "the bomb": 3, "bad ass": 1.5, "badass": 1.5, "bus stop": 0.0,
  "yeah right": -2, "kiss of death": -1.5, "to die for": 3, "beating heart": 3.5,
};
const isSpecial = (s: string) => Object.prototype.hasOwnProperty.call(SPECIAL_CASES, s);

/** Python's `str.isupper()`: at least one cased letter, and none lower case. */
function isUpper(s: string): boolean {
  return s !== s.toLowerCase() && s === s.toUpperCase();
}

/** Python's `str.lower()` for the lookups. */
const lower = (s: string) => s.toLowerCase();

function negated(word: string): boolean {
  if (NEGATE.has(word)) return true;
  return word.includes("n't");
}

function normalize(score: number, alpha = 15): number {
  const n = score / Math.sqrt(score * score + alpha);
  return n < -1 ? -1 : n > 1 ? 1 : n;
}

function allcapDifferential(words: readonly string[]): boolean {
  let caps = 0;
  for (const w of words) if (isUpper(w)) caps++;
  const diff = words.length - caps;
  return diff > 0 && diff < words.length;
}

function scalarIncDec(word: string, valence: number, isCapDiff: boolean): number {
  const w = lower(word);
  if (!isBooster(w)) return 0;
  let scalar = BOOSTER[w]!;
  if (valence < 0) scalar *= -1;
  if (isUpper(word) && isCapDiff) scalar += valence > 0 ? C_INCR : -C_INCR;
  return scalar;
}

/** Python's `string.punctuation`. */
const PUNCT = new Set("!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~");

function stripPunc(token: string): string {
  const chars = [...token];
  let a = 0;
  let b = chars.length;
  while (a < b && PUNCT.has(chars[a]!)) a++;
  while (b > a && PUNCT.has(chars[b - 1]!)) b--;
  const stripped = chars.slice(a, b);
  return stripped.length <= 2 ? token : stripped.join("");
}

function negationCheck(valence: number, w: readonly string[], startI: number, i: number): number {
  if (startI === 0) {
    if (negated(w[i - 1]!)) valence *= N_SCALAR;
  }
  if (startI === 1) {
    if (w[i - 2] === "never" && (w[i - 1] === "so" || w[i - 1] === "this")) valence *= 1.25;
    else if (w[i - 2] === "without" && w[i - 1] === "doubt") {
      // unchanged
    } else if (negated(w[i - 2]!)) valence *= N_SCALAR;
  }
  if (startI === 2) {
    if ((w[i - 3] === "never" && (w[i - 2] === "so" || w[i - 2] === "this")) || w[i - 1] === "so" || w[i - 1] === "this") valence *= 1.25;
    else if (w[i - 3] === "without" && (w[i - 2] === "doubt" || w[i - 1] === "doubt")) {
      // unchanged
    } else if (negated(w[i - 3]!)) valence *= N_SCALAR;
  }
  return valence;
}

/** Python's negative indexing, which the idiom check relies on near the start of the text. */
const at = (w: readonly string[], k: number) => (k < 0 ? w[w.length + k] : w[k])!;

function specialIdiomsCheck(valence: number, w: readonly string[], i: number): number {
  const onezero = `${at(w, i - 1)} ${at(w, i)}`;
  const twoonezero = `${at(w, i - 2)} ${at(w, i - 1)} ${at(w, i)}`;
  const twoone = `${at(w, i - 2)} ${at(w, i - 1)}`;
  const threetwoone = `${at(w, i - 3)} ${at(w, i - 2)} ${at(w, i - 1)}`;
  const threetwo = `${at(w, i - 3)} ${at(w, i - 2)}`;
  for (const seq of [onezero, twoonezero, twoone, threetwoone, threetwo]) {
    if (isSpecial(seq)) {
      valence = SPECIAL_CASES[seq]!;
      break;
    }
  }
  if (w.length - 1 > i) {
    const zeroone = `${w[i]} ${w[i + 1]}`;
    if (isSpecial(zeroone)) valence = SPECIAL_CASES[zeroone]!;
  }
  if (w.length - 1 > i + 1) {
    const zeroonetwo = `${w[i]} ${w[i + 1]} ${w[i + 2]}`;
    if (isSpecial(zeroonetwo)) valence = SPECIAL_CASES[zeroonetwo]!;
  }
  for (const ngram of [threetwoone, threetwo, twoone]) if (isBooster(ngram)) valence += BOOSTER[ngram]!;
  return valence;
}

function leastCheck(valence: number, w: readonly string[], i: number): number {
  if (i > 1 && !LEXICON.has(w[i - 1]!) && w[i - 1] === "least") {
    if (w[i - 2] !== "at" && w[i - 2] !== "very") valence *= N_SCALAR;
  } else if (i > 0 && !LEXICON.has(w[i - 1]!) && w[i - 1] === "least") valence *= N_SCALAR;
  return valence;
}

function butCheck(lowerWords: readonly string[], sentiments: number[]): number[] {
  const bi = lowerWords.indexOf("but");
  if (bi === -1) return sentiments;
  // As the Python: each score is found again by value (`list.index`), so equal scores share the first one's place.
  for (const sentiment of [...sentiments]) {
    const si = sentiments.indexOf(sentiment);
    if (si < bi) sentiments.splice(si, 1, sentiment * 0.5);
    else if (si > bi) sentiments.splice(si, 1, sentiment * 1.5);
  }
  return sentiments;
}

function count(text: string, ch: string): number {
  let n = 0;
  for (const c of text) if (c === ch) n++;
  return n;
}

function punctuationEmphasis(text: string): number {
  const ep = Math.min(count(text, "!"), 4) * 0.292;
  const qmCount = count(text, "?");
  const qm = qmCount > 1 ? (qmCount <= 3 ? qmCount * 0.18 : 0.96) : 0;
  return ep + qm;
}

/** Python's `round(x, 4)` close enough for a score that is compared with thresholds. */
const round4 = (x: number) => Math.round(x * 10000) / 10000;

/** VADER's `polarity_scores(text)["compound"]`, in -1..1. */
/**
 * Python's `sum()` of floats (3.12 and later): Neumaier's compensated sum, the
 * compensation added at the end when it is finite. vaderSentiment sums the
 * word scores with `sum()`; a plain left-to-right sum can leave 0 where Python
 * leaves 1.7e-16, which flips the compound's sign once punctuation emphasis
 * is added.
 */
export function pythonSum(values: readonly number[]): number {
  let total = 0;
  let c = 0;
  for (const x of values) {
    const t = total + x;
    if (Math.abs(total) >= Math.abs(x)) c += total - t + x;
    else c += x - t + total;
    total = t;
  }
  if (c !== 0 && Number.isFinite(c)) total += c;
  return total;
}

export function vaderCompound(input: string): number {
  // Emoji become their descriptions.
  let noEmoji = "";
  let prevSpace = true;
  for (const ch of input) {
    const description = EMOJI.get(ch);
    if (description !== undefined) {
      if (!prevSpace) noEmoji += " ";
      noEmoji += description;
      prevSpace = false;
    } else {
      noEmoji += ch;
      prevSpace = ch === " ";
    }
  }
  const text = noEmoji.trim();
  const words = text.split(/\s+/).filter((w) => w.length > 0).map(stripPunc);
  const lw = words.map(lower);
  const isCapDiff = allcapDifferential(words);
  let sentiments: number[] = [];
  for (let i = 0; i < words.length; i++) {
    const item = words[i]!;
    const itemLower = lw[i]!;
    if (isBooster(itemLower)) {
      sentiments.push(0);
      continue;
    }
    if (i < words.length - 1 && itemLower === "kind" && lw[i + 1] === "of") {
      sentiments.push(0);
      continue;
    }
    let valence = 0;
    const base = LEXICON.get(itemLower);
    if (base !== undefined) {
      valence = base;
      if (itemLower === "no" && i !== words.length - 1 && LEXICON.has(lw[i + 1]!)) valence = 0;
      if ((i > 0 && lw[i - 1] === "no") || (i > 1 && lw[i - 2] === "no") || (i > 2 && lw[i - 3] === "no" && (lw[i - 1] === "or" || lw[i - 1] === "nor"))) {
        valence = base * N_SCALAR;
      }
      if (isUpper(item) && isCapDiff) valence += valence > 0 ? C_INCR : -C_INCR;
      for (let startI = 0; startI < 3; startI++) {
        if (i > startI && !LEXICON.has(lw[i - (startI + 1)]!)) {
          let s = scalarIncDec(words[i - (startI + 1)]!, valence, isCapDiff);
          if (startI === 1 && s !== 0) s *= 0.95;
          if (startI === 2 && s !== 0) s *= 0.9;
          valence += s;
          valence = negationCheck(valence, lw, startI, i);
          if (startI === 2) valence = specialIdiomsCheck(valence, lw, i);
        }
      }
      valence = leastCheck(valence, lw, i);
    }
    sentiments.push(valence);
  }
  sentiments = butCheck(lw, sentiments);
  if (sentiments.length === 0) return 0;
  let sum = pythonSum(sentiments);
  const emphasis = punctuationEmphasis(text);
  if (sum > 0) sum += emphasis;
  else if (sum < 0) sum -= emphasis;
  return round4(normalize(sum));
}
