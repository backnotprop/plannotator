/**
 * send_message's "choices have no pictures" advice: which questions should
 * have been written as picture choices.
 *
 * An agent writes each option's picture in a rundown above the question, then
 * asks with bare text choices, so the person cannot pick by picture (the
 * owner, 2026-11-06). The first rule fired on any bare pick question under two
 * or more pictures, so it also fired on a merge question under screenshots of
 * the finished work, which needs no pictures in its choices (the owner,
 * 2026-11-11: "not every question needs pictures"). In a clean-room eval of 64
 * sends it fired 9 times, 7 of them on such questions.
 *
 * This rule fires only when the pictures are the options: at least two of the
 * question's choices are each shown by a different picture outside every
 * question block. A choice is shown by a picture when
 *  - its leading marker (`A ·`, `2.`, `**3 —`, or a label that is only `B`) opens the picture's alt text or
 *    one of the lines just above it, or follows a word such as "option",
 *    "variant" or "design" there, or ends the file name (`option-a.png`,
 *    `v2.png`); or
 *  - one of its label's words of four or more letters (not a stop word, not a
 *    word every such picture shares) is in the alt text, the rest of the
 *    picture's line, up to three lines above it, or its file name.
 * A picture that shows three or more of the choices (a contact sheet of all
 * of them) is not one option's picture, and counts for none.
 *
 * Pure; never throws on any body.
 */

import { findQuestionBlocks } from "@plannotator/core/question-block";
import { parseInboxQuestionBlocks } from "@plannotator/core/inbox-questions";
import { blankCode } from "@plannotator/shared/inbox/message-images";

/** A markdown image: its alt text and its target as written (the target the image refs read). */
const MARKDOWN_IMAGE_RE = /!\[([^\]]*)\]\(([^)]+)\)/g;
/** An `<img>` tag. */
const HTML_IMG_RE = /<img\b[^>]*>/gi;
/** A source that is not a picture the person sees as one (the image refs leave these out too). */
const NOT_A_PICTURE_SRC_RE = /^(data:|blob:)/i;
/** A choice's leading marker: one letter or a number up to 99, then `·`, `.`, `:`, `)`, a dash. */
const LEADING_MARKER_RE = /^\s*(?:\*\*)?([A-Za-z]|\d{1,2})\s*(?:·|\.|:|\)|—|–|-)\s+/;
/** Words that name an option without telling one apart from another. */
const MARKER_WORDS = "(?:option|variant|version|take|design|layout|mock|look|choice)";
/** Words of four or more letters that tell no picture apart. */
const STOP_WORDS = new Set([
  "with", "that", "this", "from", "what", "when", "your", "have", "into", "only", "more", "than", "then", "they", "them",
  "there", "their", "about", "each", "page", "pages", "screen", "screens", "option", "options", "version", "versions",
  "today", "today's", "keep", "none", "both", "until", "wait", "just", "like", "look", "looks",
]);
/** How many non-empty lines above a picture can say what it shows. */
const LINES_ABOVE = 3;
const WORD_RE = /[a-z][a-z'+]{3,}/g;

interface OutsidePicture {
  src: string;
  /** The alt text, then the rest of the picture's line, then the lines above it, nearest first. */
  lines: string[];
  /** The file name without its extension, lower case. */
  stem: string;
  /** Everything above in lower case, with the file name. */
  words: string;
}

const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function attribute(tag: string, name: string): string {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\`]+))`, "i").exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3] ?? "") : "";
}

function fileStem(src: string): string {
  const target = src.trim().replace(/^<|>$/g, "").split(/\s+/)[0] ?? "";
  const name = target.split(/[?#]/)[0]!.split(/[\\/]/).pop() ?? "";
  return name.replace(/\.[a-z0-9]+$/i, "").toLowerCase();
}

/** The pictures on one line: alt text and source, in line order. */
function picturesOn(line: string): { alt: string; src: string; index: number; length: number }[] {
  const found: { alt: string; src: string; index: number; length: number }[] = [];
  for (const m of line.matchAll(MARKDOWN_IMAGE_RE)) found.push({ alt: m[1]!, src: m[2]!.trim(), index: m.index ?? 0, length: m[0].length });
  for (const m of line.matchAll(HTML_IMG_RE)) found.push({ alt: attribute(m[0], "alt"), src: attribute(m[0], "src").trim(), index: m.index ?? 0, length: m[0].length });
  return found.filter((p) => p.src !== "" && !NOT_A_PICTURE_SRC_RE.test(p.src)).sort((a, b) => a.index - b.index);
}

/** Each picture outside every question block and outside code, once, with the words around it. */
export function picturesOutsideQuestions(body: string): OutsidePicture[] {
  const lines = blankCode(body).split("\n");
  const inside = new Array<boolean>(lines.length).fill(false);
  for (const block of findQuestionBlocks(body, { frontmatter: false })) {
    for (let i = block.startLine - 1; i < block.endLine && i < lines.length; i++) inside[i] = true;
  }
  const out: OutsidePicture[] = [];
  const seen = new Set<string>();
  lines.forEach((line, i) => {
    if (inside[i]) return;
    const pictures = picturesOn(line);
    if (pictures.length === 0) return;
    let rest = line;
    for (const p of [...pictures].reverse()) rest = rest.slice(0, p.index) + " " + rest.slice(p.index + p.length);
    rest = rest.trim();
    const above: string[] = [];
    for (let j = i - 1; j >= 0 && above.length < LINES_ABOVE; j--) {
      if (inside[j] || picturesOn(lines[j]!).length > 0) break;
      const text = lines[j]!.trim();
      if (text) above.push(text);
    }
    for (const p of pictures) {
      if (seen.has(p.src)) continue;
      seen.add(p.src);
      const said = [p.alt, ...(rest ? [rest] : []), ...above];
      const stem = fileStem(p.src);
      out.push({ src: p.src, lines: said, stem, words: [...said, stem].join(" ").toLowerCase() });
    }
  });
  return out;
}

/** A label that is only a marker (`- [ ] B`, `- [ ] 2`). */
const MARKER_ONLY_RE = /^\s*(?:\*\*)?([A-Za-z]|\d{1,2})(?:\*\*)?\s*$/;

function markerOf(label: string): string | null {
  const m = LEADING_MARKER_RE.exec(label) ?? MARKER_ONLY_RE.exec(label);
  return m ? m[1]!.toLowerCase() : null;
}

function labelWords(label: string): string[] {
  const rest = label.replace(LEADING_MARKER_RE, "").toLowerCase();
  return [...new Set(rest.match(WORD_RE) ?? [])].filter((w) => !STOP_WORDS.has(w));
}

function shows(label: string, picture: OutsidePicture, common: ReadonlySet<string>): boolean {
  const marker = markerOf(label);
  if (marker) {
    const m = escapeRe(marker);
    // The marker opens the alt text or a line about the picture ("1 · Names", "A. One page", "**2 · Faces**", "### B · Tabs").
    const opens = new RegExp(`^\\**${m}\\s*(·|\\.|:|\\)|—|–)`);
    if (picture.lines.some((line) => opens.test(line.toLowerCase().replace(/^[\s*_#>-]+/, "")))) return true;
    if (new RegExp(`\\b${MARKER_WORDS}\\s*${m}\\b`).test(picture.words)) return true;
    if (new RegExp(`(^|[-_])(v|variant|option|version)[-_]?${m}$`).test(picture.stem)) return true;
  }
  return labelWords(label)
    .filter((w) => !common.has(w))
    .some((w) => new RegExp(`\\b${escapeRe(w)}`).test(picture.words));
}

/** The choices each given a different picture that shows it, one to one, in choice order. */
export function choicesShownByPictures(labels: readonly string[], pictures: readonly OutsidePicture[]): { label: string; src: string }[] {
  const wordSets = pictures.map((p) => new Set(p.words.match(WORD_RE) ?? []));
  // A word every picture shares ("dark" under two dark-mode screenshots) tells none of them apart.
  const common = new Set(
    pictures.length >= 2 ? [...wordSets[0]!].filter((w) => wordSets.every((set) => [...set].some((x) => x.startsWith(w)))) : [],
  );
  const edges = labels.map((label) => pictures.flatMap((p, j) => (shows(label, p, common) ? [j] : [])));
  const sheet = new Set(pictures.map((_, j) => j).filter((j) => edges.filter((e) => e.includes(j)).length >= 3));
  const used = new Set<number>();
  const out: { label: string; src: string }[] = [];
  labels.forEach((label, i) => {
    const j = edges[i]!.find((k) => !sheet.has(k) && !used.has(k));
    if (j === undefined) return;
    used.add(j);
    out.push({ label, src: pictures[j]!.src });
  });
  return out;
}

/**
 * The keys of the pick-one and pick-several questions with no picture choice
 * whose choices are shown, two or more of them, each by a different picture
 * outside every question block; `pictures` counts those pictures (each once).
 * Else no keys.
 */
export function questionsWithoutPictureChoices(body: string): { keys: string[]; pictures: number } {
  const none = { keys: [], pictures: 0 };
  try {
    if (typeof body !== "string" || !body.includes(":::question")) return none;
    const asked = parseInboxQuestionBlocks(body).filter(
      (q) => (q.kind === "single" || q.kind === "multi") && q.parsed.choices.length >= 2 && q.parsed.choices.every((c) => !c.image),
    );
    if (asked.length === 0) return none;
    const pictures = picturesOutsideQuestions(body);
    if (pictures.length < 2) return none;
    const keys: string[] = [];
    const shown = new Set<string>();
    for (const q of asked) {
      const matched = choicesShownByPictures(
        q.parsed.choices.map((c) => c.label),
        pictures,
      );
      if (matched.length < 2) continue;
      keys.push(q.key);
      for (const m of matched) shown.add(m.src);
    }
    return keys.length > 0 ? { keys, pictures: shown.size } : none;
  } catch {
    return none;
  }
}
