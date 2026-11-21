/**
 * The subject of a thread the person starts in the Inbox (compose): a short
 * name, never the whole dictated paragraph. Agents' subjects keep
 * `deriveInboxSubject` (./inbox-questions, which re-exports this module).
 *
 * Pure and browser-safe: the store writes it and the compose dialog previews
 * it, so the two never differ. Never throws.
 */

import { findQuestionBlocks, parseQuestionBlock } from "./question-block";

/**
 * How wide a subject the person's own thread gets, in columns: a CJK or emoji
 * character counts two, so a Japanese subject is about as wide on screen as
 * an English one. The ellipsis counts one.
 */
export const PERSON_THREAD_SUBJECT_COLUMNS = 60;

/** Bidi controls: never in a subject, where they could reorder what the list shows. */
const BIDI_CONTROLS = /[؜‎‏‪-‮⁦-⁩]/gu;

/**
 * The subject of a thread the person starts:
 *
 *  1. The first line with words, as plain text: markdown marks, links (their
 *     text), images, HTML and list, quote or heading marks dropped; fenced
 *     code and `:::` blocks skipped.
 *  2. A greeting or filler at its start dropped ("Hey Claude,", "So,", "Okay
 *     so", "Um,"), and the next letter capitalized.
 *  3. A URL shortened to its host and last path part, a long path to its last
 *     two parts.
 *  4. The first sentence when it fits `PERSON_THREAD_SUBJECT_COLUMNS`, whole
 *     and without "…" (a final "." dropped; "?" and "!" kept).
 *  5. Else its first clause, up to the last comma, semicolon, colon or dash
 *     that fits and leaves at least 24 columns, plus "…".
 *  6. Else cut after the last word that fits (a dangling "and", "the"… dropped),
 *     plus "…"; text without spaces (CJK) is cut between two characters.
 *  7. A body with no words: the first image's alt text or file name, else the
 *     first attached file's name (`files`), else "Image", else the first line
 *     of code, else the first question's prompt (a body that is only a
 *     `:::question` block), else the first line with anything on it (an
 *     unclosed directive).
 *
 * Bidi controls never reach the subject. Null only for a body with nothing on
 * any line.
 */
export function derivePersonThreadSubject(input: string, options: { files?: readonly string[] } = {}): string | null {
  const body = typeof input === "string" ? input.replace(BIDI_CONTROLS, "") : "";
  const { images, code, words } = scanPersonBody(body);
  if (words) {
    const named = shortenSubject(compactLinks(dropFiller(words)));
    if (named) return named;
  }
  for (const image of images) {
    const alt = image.alt.replace(/\s+/g, " ").trim();
    if (alt && !/^(?:image|img|screenshot|picture|photo|pasted image)$/i.test(alt)) return cutColumns(alt, PERSON_THREAD_SUBJECT_COLUMNS);
    const name = fileNameOf(image.src);
    if (name) return cutColumns(name, PERSON_THREAD_SUBJECT_COLUMNS);
  }
  const files = (options.files ?? []).map((name) => name.replace(BIDI_CONTROLS, "").replace(/\s+/g, " ").trim()).filter(Boolean);
  if (files.length > 0) {
    const more = files.length - 1;
    const tail = more === 0 ? "" : ` and ${more} more file${more === 1 ? "" : "s"}`;
    return `${cutColumns(files[0]!, PERSON_THREAD_SUBJECT_COLUMNS - columnsOf(tail))}${tail}`;
  }
  if (images.length > 0) return "Image";
  if (code) return cutColumns(code.replace(/\s+/g, " "), PERSON_THREAD_SUBJECT_COLUMNS);
  const prompt = firstQuestionPrompt(body);
  if (prompt) return shortenSubject(prompt);
  return firstLineSubject(body);
}

/**
 * The first line with words (as plain text), the images on lines before it
 * and on it, and the first line of fenced code: fenced code and `:::` blocks
 * are skipped.
 */
function scanPersonBody(body: string): { images: { alt: string; src: string }[]; code: string | null; words: string | null } {
  const images: { alt: string; src: string }[] = [];
  let code: string | null = null;
  let fence: string | null = null;
  let directive = 0;
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    const fenceMark = /^(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (fenceMark && fenceMark[1]![0] === fence[0] && fenceMark[1]!.length >= fence.length && line.slice(fenceMark[1]!.length).trim() === "") fence = null;
      else if (code === null && line) code = line;
      continue;
    }
    if (fenceMark) {
      fence = fenceMark[1]!;
      continue;
    }
    if (/^:::\S/.test(line)) {
      directive += 1;
      continue;
    }
    if (line === ":::") {
      directive = Math.max(0, directive - 1);
      continue;
    }
    if (directive > 0 || !line) continue;
    const plain = plainSubjectLine(line, images);
    if (plain) return { images, code, words: plain };
  }
  return { images, code, words: null };
}

/** The prompt of the body's first `:::question` block, as plain words. */
function firstQuestionPrompt(body: string): string | null {
  if (!body.includes(":::question")) return null;
  for (const location of findQuestionBlocks(body, { frontmatter: false })) {
    const lines = location.text.replace(/\r\n?/g, "\n").split("\n");
    const inner = lines.slice(1, lines.length > 1 && lines.at(-1)!.trim() === ":::" ? -1 : undefined);
    const prompt = parseQuestionBlock(location.directiveKind, inner.join("\n"))?.prompt;
    const plain = prompt ? plainSubjectLine(prompt.replace(/\s+/g, " ").trim(), []) : "";
    if (plain) return plain;
  }
  return null;
}

/** The first line with anything on it: its words when it has some (directive and fence marks skipped), else the line itself. */
function firstLineSubject(body: string): string | null {
  let first: string | null = null;
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    first ??= line;
    if (/^(?:`{3,}|~{3,}|:::)/.test(line)) continue;
    const plain = plainSubjectLine(line, []);
    if (plain) return shortenSubject(plain);
  }
  return first === null ? null : cutColumns(first.replace(/\s+/g, " "), PERSON_THREAD_SUBJECT_COLUMNS);
}

/**
 * How much of a line the markdown rules read: a subject or a name comes from
 * its start, and the link and tag patterns below backtrack on a long
 * unclosed `[x](y`, `<a ` or `![a](b`, so a 1 MB dictated line must never
 * reach them whole.
 */
const PLAIN_LINE_MAX = 4096;

/** One markdown line as plain words; the images on it are added to `images`. */
function plainSubjectLine(input: string, images: { alt: string; src: string }[]): string {
  // Cut, and never leave half of a surrogate pair at the end.
  const line = input.length > PLAIN_LINE_MAX ? input.slice(0, PLAIN_LINE_MAX).replace(/[\uD800-\uDBFF]$/, "") : input;
  let text = line
    .replace(/^(?:>\s*)+/, "")
    .replace(/^#{1,6}(?:\s+|$)/, "")
    .replace(/^(?:[-*+]|\d{1,9}[.)])\s+/, "")
    .replace(/^\[[ xX]\]\s+/, "");
  text = text.replace(/!\[([^\]]*)\]\(\s*<?([^)\s>]*)>?(?:\s+[^)]*)?\)/g, (_match, alt: string, src: string) => {
    images.push({ alt, src });
    return " ";
  });
  text = text.replace(/<img\b[^>]*>/gi, (tag) => {
    const src = /\bsrc\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ?? "";
    const alt = /\balt\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ?? "";
    images.push({ alt, src });
    return " ";
  });
  text = text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1")
    .replace(/<((?:https?|mailto):[^>\s]+)>/gi, "$1")
    .replace(/<\/?[A-Za-z][^>]*>/g, " ")
    .replace(/`+([^`]*)`+/g, "$1")
    .replace(/\*\*|__|~~/g, "")
    .replace(/(^|[\s(["'])[*_]+(?=\S)/g, "$1")
    .replace(/(\S)[*_]+(?=$|[\s)\]"'.,!?:;])/g, "$1");
  return text.replace(/\s+/g, " ").trim();
}

const FILLER_WORD = "(?:so|ok|okay|alright|all right|well|right|anyway|anyways|yeah|basically)";
/** An agent's name: "Hey Claude can you…" needs no comma after it. */
const AGENT_NAME = "(?:claude|codex|pi|opencode|amp|gemini|qwen|cursor|droid)";
/** A word that is an addressee only before punctuation: "Hey there, …", never "Hey there is a bug". */
const ADDRESSEE_WORD = "(?:there|team|buddy|friend|folks|all|everyone)";
/**
 * What ends a greeting or filler: punctuation followed by a space or the end,
 * or a dash with spaces around it. A dash inside a word ("Right-click",
 * "Hi-DPI", "Well-known", "So-called") never does.
 */
const SEPARATOR = "(?:\\s*[,.!:;]+(?=\\s|$)\\s*|\\s+[—–-]+\\s+)";
/**
 * A filler counts only before a separator, before another filler, or before
 * words that start a request ("So I want…", not "So many tests…").
 */
const FILLER_LEAD = new RegExp(
  `^${FILLER_WORD}(?:${SEPARATOR}|\\s+(?=(?:${FILLER_WORD.slice(3, -1)}|um+|uh+|i|i'm|i've|i'd|i'll|we|we're|we've|let's|can|could|would|will|please|quick|just|here|what|how|why|is|are|do|does|the|this)\\b))`,
  "iu",
);
/** "Hey Claude can you…": a greeting needs no comma. */
const GREETING = new RegExp(
  `^(?:hey|hi|hello|yo)(?:\\s+${AGENT_NAME}(?:${SEPARATOR}|\\s+)|\\s+${ADDRESSEE_WORD}${SEPARATOR}|${SEPARATOR}|\\s+)`,
  "iu",
);
/** A hesitation never starts what the person means. */
const HESITATION = new RegExp(`^(?:um+|uh+|erm+|hmm+|ah+)(?:${SEPARATOR}|\\s+)`, "iu");
/** What is left when the greeting was the whole message: a name, or nothing. */
const ONLY_A_NAME = new RegExp(`^(?:${AGENT_NAME}|${ADDRESSEE_WORD})?[\\s,.!:;—–-]*$`, "iu");

/** "Hey Claude, so I want to…" → "I want to…"; "Hey Claude" alone stays as it is. */
function dropFiller(text: string): string {
  let out = text;
  for (let i = 0; i < 6; i += 1) {
    const match = GREETING.exec(out) ?? HESITATION.exec(out) ?? FILLER_LEAD.exec(out);
    if (!match || match[0].length >= out.length) break;
    out = out.slice(match[0].length).trimStart();
  }
  if (out === text || ONLY_A_NAME.test(out)) return text;
  return out.replace(/^\p{Ll}/u, (letter) => letter.toLocaleUpperCase());
}

/** A URL to its host and last path part; a long path to its last two parts. */
function compactLinks(text: string): string {
  return text
    .replace(/\bhttps?:\/\/(?:www\.)?([^\s/?#]+)(\S*)/gi, (_match, host: string, rest: string) => {
      const trail = /[.,!?:;)]+$/.exec(rest)?.[0] ?? "";
      const path = rest.slice(0, rest.length - trail.length).replace(/[?#].*$/, "");
      const parts = path.split("/").filter(Boolean);
      if (parts.length === 0) return `${host}${trail}`;
      if (parts.length === 1) return `${host}/${parts[0]}${trail}`;
      return `${host}/…/${parts[parts.length - 1]}${trail}`;
    })
    .replace(/(^|\s)((?:~|\.{1,2})?\/?(?:[^\s/]+\/){2,}[^\s/]+)/g, (whole, lead: string, path: string) => {
      if (path.length <= 24 || path.includes("…")) return whole;
      const trail = /[.,!?:;)]+$/.exec(path)?.[0] ?? "";
      const parts = path.slice(0, path.length - trail.length).split("/").filter(Boolean);
      if (parts.length < 3) return whole;
      return `${lead}…/${parts.slice(-2).join("/")}${trail}`;
    });
}

const ABBREVIATIONS = new Set(["e.g", "i.e", "etc", "vs", "mr", "mrs", "ms", "dr", "st", "approx", "fig", "no", "cf", "a.k.a", "aka"]);
const SMALL_TAIL_WORD =
  /\s+(?:and|or|but|so|the|a|an|to|of|for|with|that|which|in|on|at|by|from|as|is|are|be|it|its|my|our|your|their|this|these|those|if|then|than|like|about|into|over|what|how)$/iu;

/** Steps 4 to 6 of `derivePersonThreadSubject`. */
function shortenSubject(text: string): string {
  const max = PERSON_THREAD_SUBJECT_COLUMNS;
  const sentence = firstSentence(text);
  if (columnsOf(sentence) <= max) return sentence;
  const budget = max - 1;
  let clause: string | null = null;
  for (const match of sentence.matchAll(/[,;:](?=\s)|\s[—–-](?=\s)|[，；：、]/gu)) {
    const head = sentence.slice(0, match.index).trimEnd();
    if (columnsOf(head) > budget) break;
    if (columnsOf(head) >= 24) clause = head;
  }
  if (clause) return `${clause}…`;
  let cut = "";
  for (const match of sentence.matchAll(/\S+/g)) {
    const next = sentence.slice(0, match.index + match[0].length);
    if (columnsOf(next) > budget) break;
    cut = next;
  }
  if (columnsOf(cut) < 24) cut = sliceColumns(sentence, budget);
  for (let i = 0; i < 2; i += 1) cut = cut.replace(SMALL_TAIL_WORD, "");
  cut = cut.replace(/[\s,;:—–(-]+$/u, "");
  return `${cut}…`;
}

/** The first sentence of a line, its final "." or "…" dropped and "?" or "!" kept. The whole line when no sentence ends in it. */
function firstSentence(text: string): string {
  let end = text.length;
  for (let i = 2; i < text.length; i += 1) {
    const ch = text[i]!;
    if (ch === "。" || ch === "！" || ch === "？") {
      end = i + 1;
      break;
    }
    const ellipsis = ch === "…" ? 1 : text.startsWith("...", i) ? 3 : 0;
    if (ch !== "." && ch !== "!" && ch !== "?" && !ellipsis) continue;
    const after = i + (ellipsis || 1);
    const rest = text.slice(after);
    if (rest !== "" && !/^["'”’)\]]*\s/.test(rest)) {
      if (ellipsis === 3) i += 2;
      continue;
    }
    if (ch === "." && !ellipsis) {
      const word = /(\S+)$/.exec(text.slice(0, i))?.[1]?.toLowerCase() ?? "";
      // "e.g", "Dr", a lone initial, or single letters with dots ("U.S", "a.m").
      if (ABBREVIATIONS.has(word) || /^(?:\p{L}\.)*\p{L}$/u.test(word)) continue;
    }
    end = after;
    break;
  }
  const sentence = text
    .slice(0, end)
    .trim()
    .replace(/(?:\.{3}|…|[.。])$/u, "")
    .trimEnd();
  return sentence || text.trim();
}

function fileNameOf(src: string): string {
  const last = src.replace(/[?#].*$/, "").split(/[\\/]/).filter(Boolean).pop() ?? "";
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

const graphemes: Intl.Segmenter | null =
  typeof Intl !== "undefined" && typeof (Intl as { Segmenter?: unknown }).Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

function graphemesOf(text: string): string[] {
  return graphemes ? Array.from(graphemes.segment(text), (part) => part.segment) : Array.from(text);
}

/** Two columns for CJK, Hangul, full-width forms and emoji, else one. */
function graphemeColumns(grapheme: string): number {
  const cp = grapheme.codePointAt(0) ?? 0;
  const wide =
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd);
  return wide ? 2 : 1;
}

function columnsOf(text: string): number {
  let columns = 0;
  for (const grapheme of graphemesOf(text)) columns += graphemeColumns(grapheme);
  return columns;
}

/** The longest start of `text` at most `max` columns wide, ending between two characters. */
function sliceColumns(text: string, max: number): string {
  let columns = 0;
  let out = "";
  for (const grapheme of graphemesOf(text)) {
    const width = graphemeColumns(grapheme);
    if (columns + width > max) break;
    columns += width;
    out += grapheme;
  }
  return out;
}

/** `text` when it fits `max` columns, else its start and "…", together at most `max`. */
function cutColumns(text: string, max: number): string {
  if (columnsOf(text) <= max) return text;
  return `${sliceColumns(text, max - 1).trimEnd()}…`;
}

// ── The thread name compose suggests ─────────────────────────────────────────

/** The longest name compose suggests for a thread the person starts, in columns (CJK counts two). */
export const PERSON_THREAD_NAME_COLUMNS = 24;
/** The most words compose suggests for a thread's name. */
export const PERSON_THREAD_NAME_WORDS = 3;

/**
 * The name compose fills the thread's chip with while the person has not
 * typed one: one to three words naming the topic ("Kanban board", "Paste
 * bug", "PR 1934"), at most `PERSON_THREAD_NAME_COLUMNS` columns, never cut
 * in a word, no punctuation at its end. "" when nothing good comes out (a
 * bare question, filler, code), so the chip shows its placeholder instead of
 * a made-up name.
 *
 *  1. The first line with words (as for the subject), greeting and filler
 *     dropped, links replaced by a name ("PR 1934", "Issue 12", a page's last
 *     path part).
 *  2. Its first sentence, as words: function words, request verbs ("can you",
 *     "fix", "explore"), vague nouns ("thing", "problem") and adverbs are
 *     dropped; what is left in a row is a candidate ("paste bug", "reply
 *     box"). A comma or semicolon ends a candidate; "of", "or", "vs" and
 *     their Romance forms ("de") join two words of one.
 *  3. The first candidate of two or more words, else the first one. One of
 *     more than three words keeps its first two. Words come off the end until
 *     it fits the columns; a single word too wide gives nothing.
 *  4. "X specifically" (or "especially", "in particular") right after a name
 *     of one or two words puts X in front: "Board" → "Kanban board".
 *  5. Text written without spaces (Japanese, Chinese) is split at particles
 *     and common verbs: Japanese takes the first part, Chinese the longest.
 *  6. A body with no words, or none worth a name: the first image's alt text
 *     or file name, then the first attached file's name, as words.
 *
 * The first word is capitalized when it is a plain lowercase word (never an
 * identifier like `inbox_tool`, `e2e` or `pnpm`). Pure; never throws.
 */
export function suggestPersonThreadName(input: string, options: { files?: readonly string[] } = {}): string {
  const body = typeof input === "string" ? input.replace(BIDI_CONTROLS, "") : "";
  const { images, words } = scanPersonBody(body);
  if (words) {
    const named = nameFromLine(dropFiller(words));
    if (named) return named;
  }
  for (const image of images) {
    const alt = image.alt.replace(/\s+/g, " ").trim();
    if (alt && !/^(?:image|img|screenshot|picture|photo|pasted image)$/i.test(alt)) {
      const named = nameFromLine(alt);
      if (named) return named;
    }
    const named = nameFromFile(fileNameOf(image.src));
    if (named) return named;
  }
  for (const file of options.files ?? []) {
    const named = nameFromFile(file.replace(BIDI_CONTROLS, ""));
    if (named) return named;
  }
  return "";
}

/** A file's name as words: "board-mock.png" → "Board mock". Generic names ("image", "pasted-image-2026-10-16-1405") give nothing. */
function nameFromFile(file: string): string {
  const stem = file
    .trim()
    .replace(/\.[A-Za-z0-9]{1,5}$/, "")
    .replace(/[-_.]+/g, " ")
    .trim();
  if (!stem || /^(?:image|img|screenshot|screen shot|pasted (?:image|file|graphic)|blob|photo|untitled)\b/i.test(stem)) return "";
  return nameFromLine(stem);
}

const NAME_TRAILING = /[\s.,;:!?…。！？、，；：—–-]+$/u;
const KANA = /[぀-ヿ]/u;
const HAN = /\p{Script=Han}/u;

function nameFromLine(text: string): string {
  // Zero-width and other invisible characters never reach a name (nor split a word).
  const line = replaceLinks(text.replace(/\p{Default_Ignorable_Code_Point}/gu, "")).replace(/\s+/g, " ").trim();
  if (!line) return "";
  const sentences = line.split(/(?<=[.!?。！？])\s*/u).map((part) => part.trim()).filter(Boolean);
  const first = sentences[0] ?? line;
  if (!/\s/.test(first.trim()) && (KANA.test(first) || HAN.test(first))) {
    // Text without spaces: the sentence that asks for something ("…を追加したい") over a plain statement before it.
    const asking = sentences.find((sentence) => CJK_REQUEST.test(sentence)) ?? first;
    return capped(nameFromUnspaced(asking));
  }
  // First pass: the topic words. Second, when nothing is left ("make the thing work better"): every
  // word but function words, two at least, so a lone verb ("think") never names a thread.
  return nameFromRuns(contentRuns(first), sentences, 1) || nameFromRuns(contentRuns(first, NAME_FUNCTION), sentences, 2);
}

/** A request in text written without spaces: Japanese "…たい", "…ください", "…ほしい"; Chinese "想", "要", "请", "帮". */
const CJK_REQUEST = /たい|ください|下さい|ほしい|欲しい|しよう|ましょう|てくれ|想|要|请|帮|吗/u;

function nameFromRuns(runs: string[][], sentences: string[], minWords: number): string {
  const ordered = [...runs.filter((run) => run.length >= 2), ...runs.filter((run) => run.length < 2)].filter((run) => run.length >= minWords);
  for (const run of ordered) {
    let words = run.length > PERSON_THREAD_NAME_WORDS ? run.slice(0, 2) : run;
    // "Board. Kanban specifically." → "Kanban board".
    const qualifier = sentences.length > 1 ? qualifierOf(sentences[1]!) : null;
    if (qualifier && words.length < PERSON_THREAD_NAME_WORDS && !words.some((word) => word.toLowerCase() === qualifier.toLowerCase())) {
      const joined = [qualifier, ...words];
      if (columnsOf(joined.join(" ")) <= PERSON_THREAD_NAME_COLUMNS) words = joined;
    }
    while (words.length > 1 && columnsOf(words.join(" ")) > PERSON_THREAD_NAME_COLUMNS) words = words.slice(0, -1);
    // A connector never ends a name ("error de" → "error").
    while (words.length > 1 && NAME_CONNECTORS.has(words[words.length - 1]!.toLowerCase())) words = words.slice(0, -1);
    if (words.length < minWords) continue;
    const name = capped(words.join(" ").replaceAll(LINK_JOIN, " "));
    if (name) return capitalizeName(name);
  }
  return "";
}

/** The name when it fits the columns, else "" (never cut in a word). */
function capped(name: string): string {
  const trimmed = name.replace(NAME_TRAILING, "").trim();
  return trimmed && columnsOf(trimmed) <= PERSON_THREAD_NAME_COLUMNS ? trimmed : "";
}

function isPlainLowerWord(word: string): boolean {
  return /^[\p{Ll}][\p{Ll}'’-]*$/u.test(word) && /[aeiouyàáâäãåæèéêëìíîïòóôöõøùúûüýÿœ]/u.test(word);
}

function capitalizeName(name: string): string {
  const [head, ...rest] = name.split(" ");
  if (!head || !isPlainLowerWord(head)) return name;
  return [head.replace(/^\p{Ll}/u, (letter) => letter.toLocaleUpperCase()), ...rest].join(" ");
}

/** "Kanban specifically." → "Kanban"; "specifically kanban" → "kanban". */
function qualifierOf(sentence: string): string | null {
  const plain = sentence.replace(NAME_TRAILING, "").trim();
  const after = /^([\p{L}\p{N}][\p{L}\p{N}'’_-]*)\s+(?:specifically|especially|in particular|particularly|ideally|mainly)$/iu.exec(plain);
  const before = /^(?:specifically|especially|ideally|mainly)\s+([\p{L}\p{N}][\p{L}\p{N}'’_-]*)$/iu.exec(plain);
  const word = after?.[1] ?? before?.[1] ?? null;
  return word && !NAME_STOP.has(normalizeWord(word)) ? word : null;
}

/** Joins the words a link is named by into one word, so no rule splits them; a space again in the name. */
const LINK_JOIN = "\u2060";

/** Links named for a thread: "PR 1934", "Issue 12", a repository, else a page's last path part as words, else its host. */
function replaceLinks(text: string): string {
  return text.replace(/\bhttps?:\/\/(?:www\.)?([^\s/?#]+)([^\s]*)/gi, (_match, host: string, rest: string) => {
    const path = rest.replace(/[?#].*$/, "").replace(/[.,!?:;)]+$/, "");
    const parts = path.split("/").filter(Boolean).map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    });
    const lower = host.toLowerCase();
    if (/(?:^|\.)(?:github\.com|gitlab\.com|bitbucket\.org)$/.test(lower) && parts.length >= 2) {
      const kind = parts.indexOf("pull") >= 0 ? "pull" : parts.indexOf("pull-requests") >= 0 ? "pull-requests" : parts.indexOf("merge_requests") >= 0 ? "merge_requests" : parts.indexOf("issues") >= 0 ? "issues" : null;
      const number = kind ? parts[parts.indexOf(kind) + 1] : undefined;
      if (kind && number && /^\d+$/.test(number)) return ` ${kind === "issues" ? "Issue" : "PR"}${LINK_JOIN}${number} `;
      if (parts.length === 2) return ` ${parts[1]} `;
    }
    const last = [...parts].reverse().find((part) => /\p{L}/u.test(part));
    if (last) {
      const words = last.replace(/\.[A-Za-z0-9]{1,5}$/, "").replace(/[-_.+]+/g, " ").trim();
      if (words) return ` ${words.split(" ").slice(0, PERSON_THREAD_NAME_WORDS).join(LINK_JOIN)} `;
    }
    return ` ${lower} `;
  });
}

/** A word as the lists compare it: lowercase, curly apostrophe made straight. */
function normalizeWord(word: string): string {
  return word.toLowerCase().replace(/’/g, "'");
}

/**
 * The runs of words worth naming in one sentence: everything in NAME_STOP
 * (and anything without a letter or digit) breaks a run, and so does a
 * comma, semicolon, colon or dash after a word.
 */
function contentRuns(sentence: string, stop: ReadonlySet<string> = NAME_STOP): string[][] {
  const tokens = sentence.split(/\s+/).filter(Boolean);
  const runs: string[][] = [];
  let run: string[] = [];
  const end = () => {
    if (run.length > 0) runs.push(run);
    run = [];
  };
  const wordOf = (token: string): { word: string; breaks: boolean } => {
    const breaks = /[,;:)\]}—–]$/u.test(token) || /[.!?]$/.test(token);
    let word = token.replace(/^[\s"'“”‘’(\[{¿¡*_~`<]+/u, "").replace(/[\s"'“”‘’)\]}.,;:!?…*_~`>]+$/u, "");
    // A path names its file: "packages/inbox/compose.tsx" → "compose.tsx".
    if (/\/./.test(word) && !/^\//.test(word.slice(-1))) word = word.split("/").filter(Boolean).pop() ?? word;
    if (!(/\p{Script=Hangul}/u.test(word) && KOREAN_VERB.test(word))) word = stripKoreanParticle(word);
    return { word, breaks };
  };
  for (let i = 0; i < tokens.length; i += 1) {
    const { word, breaks } = wordOf(tokens[i]!);
    const key = normalizeWord(word);
    const content = isContentWord(word, key, stop);
    if (content) {
      run.push(word);
      if (breaks) end();
      continue;
    }
    // "the build is failing" → "build failing": the auxiliary drops out.
    if (run.length > 0 && AUX_BEFORE_ING.has(key) && !breaks && i + 1 < tokens.length) {
      const next = wordOf(tokens[i + 1]!);
      if (/ing$/i.test(next.word) && isContentWord(next.word, normalizeWord(next.word), stop)) continue;
    }
    // "error de pegado", "Postgres or SQLite": a connector between two words of a run joins them.
    if (run.length > 0 && NAME_CONNECTORS.has(key) && !breaks && i + 1 < tokens.length) {
      const next = wordOf(tokens[i + 1]!);
      if (isContentWord(next.word, normalizeWord(next.word), stop)) {
        run.push(word);
        continue;
      }
    }
    end();
  }
  end();
  return runs;
}

function isContentWord(word: string, key: string, stop: ReadonlySet<string> = NAME_STOP): boolean {
  if (!word || !/[\p{L}\p{N}]/u.test(word)) return false;
  if (word.startsWith("@")) return false;
  if (/^\p{L}$/u.test(word)) return false;
  // Code, not a topic: "alert(1)", "a=b", "<div>".
  if (/[()[\]{}<>=;]/.test(word)) return false;
  if (stop.has(key)) return false;
  // A Korean verb or ending: "추가하고", "싶어요", "주세요".
  if (/\p{Script=Hangul}/u.test(word) && KOREAN_VERB.test(word)) return false;
  return true;
}

const KOREAN_VERB = /(?:요|다|고|까|세요|니다|해|줘|게)$/u;
const KOREAN_PARTICLE = /(?<=\p{Script=Hangul})(?:에서|으로|에게|까지|부터|이랑|을|를|이|가|은|는|에|로|와|과|의|도|만)$/u;
function stripKoreanParticle(word: string): string {
  return word.length > 2 && KOREAN_PARTICLE.test(word) ? word.replace(KOREAN_PARTICLE, "") : word;
}

/** Text written without spaces: Japanese is split at particles and takes its first part; Chinese at function words and common verbs, and takes its longest. */
function nameFromUnspaced(sentence: string): string {
  const text = sentence.replace(/[。！？、，；：「」『』（）()"'“”]/gu, " ");
  if (KANA.test(text)) {
    const parts = text
      .replace(/^(?:私|僕|俺|ちょっと|あの|えっと)(?:は|が)?/u, "")
      .split(/について|って|から|まで|ので|けど|を|が|は|に|で|と|へ|や|も|\s+/u)
      .map((part) => part.trim())
      .filter((part) => [...part].length >= 2 && !/^[぀-ゟ]+$/u.test(part));
    return parts[0] ?? "";
  }
  const parts = text
    .replace(/^(?:我想|我要|我们|请你|请|帮我|能不能|可以|你能|麻烦)/u, "")
    .split(/一下|一个|看看|添加|增加|修复|检查|实现|改成|可以|是否|应该|怎么|什么|为什么|的|了|吗|呢|吧|是|和|跟|与|给|加|把|对|在|用|做|修|改|想|要|能|会|有|\s+/u)
    .map((part) => part.trim())
    .filter((part) => [...part].length >= 2);
  let best = "";
  for (const part of parts) if ([...part].length > [...best].length) best = part;
  return best;
}

const AUX_BEFORE_ING = new Set(["is", "are", "was", "were", "keeps", "kept", "keep", "been", "isn't", "aren't"]);

/** Words that join two words of one name: "error de pegado", "Postgres or SQLite", "state of the art" (not across "the"). */
const NAME_CONNECTORS = new Set(["of", "or", "vs", "versus", "de", "del", "di", "du", "des", "da", "do", "von", "der"]);

const words = (text: string): string[] => text.split(/\s+/).filter(Boolean);

/**
 * Words that carry no topic in any sentence: function words, greetings, the
 * wish itself ("want", "need") and every listed language's function words.
 * The second pass (`nameFromLine`) drops only these.
 */
const NAME_FUNCTION = new Set(
  words(
    // English: articles, pronouns, auxiliaries, prepositions, conjunctions, question words.
    "a an the this that these those it its it's i i'm i've i'd i'll me my mine we we're we've we'd we'll us our ours you you're you've you'd you'll your yours " +
    "he she they them their his her him who whom whose which what what's whats where where's when when's why why's how how's whether if then than so " +
    "is are was were be been being am do does did done doing don't doesn't didn't have has had having can can't cannot could couldn't would wouldn't " +
    "should shouldn't will won't shall may might must isn't aren't wasn't weren't there there's here here's " +
    "and but nor yet also too either neither both not no yes yeah yep ok okay sure " +
    "to in on at by for with from into onto about above below over under up down out off through across after before between during " +
    "around against along among within without via per like as until till since because while though although " +
    // Request words, greetings and politeness.
    "please pls plz thanks thank thx hey hi hello yo hmm um uh lets let's let gonna wanna gotta claude codex opencode " +
    "want wants wanted need needs needed like liked love would-like wish hope think thinking thought thoughts ok okay",
  ),
);

/**
 * What never names a thread in the first pass: NAME_FUNCTION, request verbs,
 * vague nouns and adverbs, in English and (the commonest) in Spanish,
 * French, German, Portuguese and Italian.
 */
const NAME_STOP = new Set([
  ...NAME_FUNCTION,
  ...words(
    // Request verbs (and their -ing forms): what the person asks for, never the topic.
    "explore exploring look looks looking see seeing check checking fix fixing add adding make making create creating try trying " +
    "think thinking know tell telling show showing help helping find finding figure figuring get getting got give go going went " +
    "start starting review reviewing investigate investigating debug debugging update updating change changing improve improving " +
    "implement implementing write writing read reading consider considering discuss discussing work working wonder wondering " +
    "use using compare comparing rename renaming remove removing delete deleting move moving refactor refactoring clean cleaning " +
    "set setting put putting do doing take taking keep keeping switch switching handle handling support supporting dig digging " +
    "talk talking ask asking answer explain explaining understand plan planning design designing build-out sort sorting " +
    "summarize summarise summarizing figure-out look-into ship shipping run running test-drive brainstorm brainstorming " +
    "lately recently soon later earlier somewhere anymore " +
    "maybe really just actually basically specifically especially particularly still already even again ever never always now today " +
    "currently quickly quick briefly real very much many more most less least some any all every each other another such same own " +
    "lot lots bit little few several enough else instead together anyway anyways though perhaps probably possibly somehow kind sort " +
    "new better good great nice best whole entire certain different " +
    // Vague nouns.
    "thing things stuff something anything everything nothing someone anyone way ways idea ideas thought thoughts question questions " +
    "problem problems issue issue's part point case matter situation concern approach option options status update-on progress " +
    "one ones time times today tomorrow yesterday morning afternoon tonight week day minute second",
  ),
]);

for (const word of words(
    // Spanish.
    "el la los las un una unos unas lo al y o e u pero que qué en con por para sin sobre como cómo cuando dónde donde se su sus mi mis tu tus " +
    "yo tú nos es son está están estar ser hay muy más puedes podrías puede quiero quisiera necesito querría arreglar revisar mirar ver hacer " +
    "agregar añadir crear cambiar probar explorar este esta estos estas eso esa ese " +
    // French.
    "le les une des et ou mais dans avec pour sur sans par au aux ce cette ces je tu il elle nous vous ils elles mon ma mes ton ta tes son sa ses " +
    "est sont être avoir peux pourrais peut veux voudrais voudrait faut faire regarder corriger ajouter voir changer essayer explorer qui quoi " +
    "comment pourquoi quand très plus aussi bien " +
    // German.
    "die das ein eine einen einem einer und oder aber mit für auf im ins am vom zum zur bei aus nach über unter ich du er sie es wir ihr dir mir " +
    "mich dich uns euch mein meine dein deine ist sind war bin hast hat haben kannst kann können könntest könnte möchte möchtest will willst " +
    "sollen soll bitte mal mir doch noch auch schon sehr nur wie was wo warum wann den dem des nicht kein keine ansehen anschauen beheben " +
    "machen hinzufügen ändern prüfen schauen " +
    // Portuguese and Italian.
    "os as um uma ao em no na nos nas com por para sem você podes pode podia quero preciso il lo gli un uno una e o ma che per con su " +
    "puoi potresti voglio vorrei sistemare aggiungere guardare",
)) {
  NAME_FUNCTION.add(word);
  NAME_STOP.add(word);
}
