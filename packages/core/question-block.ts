/**
 * `:::question` directive blocks: a question an agent embeds in a markdown
 * document, rendered by `@plannotator/ui` as answer controls in place.
 *
 * Pure and browser-safe (no DOM, no node). Everything a host needs lives
 * here: the block grammar and parser, the stable question key, the answer
 * record and its fail-closed validator, the export formatting, and the
 * authoring guide string a host puts in its own agent prompts.
 *
 * The body grammar is plain markdown, so a document that carries questions
 * still reads correctly in any other viewer (GitHub, an editor, a terminal):
 *
 * ```
 * :::question
 * Where should losing conflict versions be kept?
 *
 * Last-write-wins silently drops the loser unless we keep it somewhere.
 *
 * - [ ] Local only, purged after 30 days — cheap, no server change
 * - [ ] Server-side per user — survives reinstall, needs a retention policy
 * - [ ] Nowhere — accept silent loss for v1
 *
 * Recommended: Local only, purged after 30 days
 * :::
 * ```
 *
 * Grammar (line-oriented and tolerant; blank lines are the recommended style,
 * never a requirement):
 * - Kinds: `question` (pick one), `question-multi` (pick any),
 *   `question-text` (free text). A block with no choices is free text
 *   whatever its kind.
 * - Prompt: the first non-blank line that is not a choice or a
 *   recommendation. No prompt means the block is not a question: the parser
 *   returns null and the renderer falls back to the plain directive callout.
 * - Context: every other prose line (before or after the choices).
 * - Choices: `- [ ] label` or `- [ ] label — description` (`*`, `+` and
 *   `1.` markers work too). The first ` — ` / ` – ` / ` - ` splits the label
 *   from the description. `- [x]` marks a choice as already SETTLED (the
 *   agent echoing an earlier decision), exactly what a checked box means on
 *   GitHub. A `question` / `question-multi` block with no task-list items
 *   treats plain `- label` bullets as its choices. A plain bullet keeps its
 *   wrapped lines the way CommonMark reads a list item (indented lines, lazy
 *   unindented lines, an indented paragraph after a blank line), and a bold
 *   name set off by punctuation (`- **Name:** prose`, `**` only) is its
 *   label, unless two bullets would then share a label.
 * - Recommendation: `Recommended: <text>` (aliases `Recommendation:`,
 *   `➡️`, `->`, `=>`, `→`). Text that names a choice label (normalized,
 *   case-insensitive; a `label — reason` tail is allowed) marks that choice
 *   recommended; on a multi question a `,` / `;` / `and` list may name
 *   several. Anything else is a suggested free-text answer. A line right
 *   under it continues it only when it wraps the same sentence (the line
 *   ends without sentence punctuation and the next starts in lower case);
 *   a reason on its own line stays context, and a choice is matched on the
 *   `Recommended:` line itself first.
 * - Decision: a `Decision:` line after the prompt, at the start of a line,
 *   says what answering means for the asker's project. `Decision: when
 *   answered` (case-insensitive, optional trailing period) flags the question:
 *   its answer should become a recorded decision (`decisionOnAnswer`).
 *   `Decision: [statement](https://…)` (exactly one markdown link, http(s)
 *   only) says the decision exists (`decision`); it replaces the flag, and
 *   when both are present the link wins. Each form is read once per block;
 *   any other `Decision:` value is context prose. A `Decision:` line BEFORE
 *   the prompt is the prompt. Neither form changes the question key.
 * - Replaces (the Plannotator Inbox): a `Replaces: <message id>/<key>` line
 *   (or a bare `<message id>`, several separated by commas, semicolons or
 *   spaces) names the earlier question(s) this one replaces. Read only when
 *   EVERY token of its value is id-shaped (`msg_` + a 26-character ULID,
 *   optionally `/q-` + 8 hex, or a bare `q-` + 8 hex key; one trailing `.`
 *   each is dropped), wherever it sits: it is then never the prompt and never
 *   context, so the card never shows the raw ids (`replaces`). Any other
 *   `Replaces:` line ("Replaces: q-learning with PPO") is ordinary prose. It
 *   does not change the question key.
 */

import { sliceText } from "./text-cut";
import {
  DIRECTIVE_OPEN_RE,
  codeFenceCloseIndex,
  directiveCloseIndex,
  htmlBlockEndAt,
  resolveReferenceLinks,
  scanDisplayMath,
  splitFrontmatter,
  type TagCloseIndex,
} from './markdown-structure';

export const QUESTION_DIRECTIVE_KINDS = ['question', 'question-multi', 'question-text'] as const;
export type QuestionDirectiveKind = (typeof QUESTION_DIRECTIVE_KINDS)[number];

export const isQuestionDirectiveKind = (kind: string | undefined | null): kind is QuestionDirectiveKind =>
  typeof kind === 'string' && (QUESTION_DIRECTIVE_KINDS as readonly string[]).includes(kind);

/** How a question is answered. */
export type QuestionKind = 'single' | 'multi' | 'text';

export interface QuestionChoice {
  /** Label as written (inline markdown). The export and answers quote it. */
  label: string;
  description?: string;
  /** Other names this choice had or may be quoted by (plain bullets only):
   *  its full text, its first line, and that line's label as 0.28.1 and
   *  earlier read it. A saved answer quoting one of them selects this
   *  choice (see `canonicalQuestionAnswer`). Absent when there are none. */
  aliases?: string[];
  /** `- [x]`: the agent marked this choice as already decided. */
  settled: boolean;
  /** Named by the block's `Recommended:` line. */
  recommended: boolean;
}

export interface ParsedQuestion {
  kind: QuestionKind;
  directiveKind: QuestionDirectiveKind;
  /** The prompt line as written (inline markdown). */
  prompt: string;
  /** 0-based index of the prompt line within the directive BODY. */
  promptLine: number;
  /** The remaining prose as a markdown body (paragraphs, bullet lines). */
  context: string;
  choices: QuestionChoice[];
  /** The raw text of the recommendation line, when there is one. */
  recommendation?: string;
  /** The recommendation when it names no choice: a suggested answer. */
  suggestedText?: string;
  /** Stable identity: `q-` + hash8(kind + prompt). See questionKey. */
  key: string;
  /** `Decision: when answered`: the asker flagged that answering this
   *  question records a decision. Absent when not flagged, and absent when a
   *  `decision` link is present (the link wins). */
  decisionOnAnswer?: true;
  /** `Decision: [statement](url)`: the decision this question became. */
  decision?: QuestionDecisionLink;
  /** `Replaces: <message id>/<key>` (the Plannotator Inbox): the earlier
   *  questions this one replaces, each token as written. Absent when the
   *  block has no such line. The host checks them (the Inbox refuses an id
   *  that names no open question of the thread). */
  replaces?: string[];
}

/** A recorded decision a question links to (`Decision: [statement](url)`). */
export interface QuestionDecisionLink {
  /** The link text as written (inline markdown). */
  statement: string;
  /** An absolute http(s) URL. */
  url: string;
}

/** Caps. Parsing is bounded; answers are truncated to these on validation. */
export const MAX_QUESTION_BODY_CHARS = 20_000;
export const MAX_QUESTION_CHOICES = 20;
export const MAX_QUESTION_PROMPT_CHARS = 400;
/** The longest label a plain-bullet choice takes before the rest moves to
 *  its description (see capChoiceLabel). Task-list labels are not cut. */
export const MAX_QUESTION_CHOICE_LABEL_CHARS = 200;
/** The cap on each `selected` label of an answer. A picked label is a choice
 *  label, and a choice lives in a block body of at most
 *  MAX_QUESTION_BODY_CHARS, so any label a block can hold round-trips whole.
 *  (Through 0.28.17 this was MAX_QUESTION_CHOICE_LABEL_CHARS, which cut a
 *  task-list label over 200 characters, so it could never be picked.) */
export const MAX_QUESTION_SELECTED_CHARS = MAX_QUESTION_BODY_CHARS;
export const MAX_QUESTION_OTHER_CHARS = 2000;
export const MAX_QUESTION_TEXT_CHARS = 4000;
export const MAX_QUESTION_NOTE_CHARS = 2000;

const CHOICE_RE = /^\s*(?:[-*+]|\d{1,3}[.)])\s+\[([ xX])\]\s+(.*)$/;
const PLAIN_BULLET_RE = /^\s*[-*+]\s+(.*)$/;
const RECOMMENDED_RE = /^\s*(?:[*_]{1,2})?(?:recommended|recommendation)(?:[*_]{1,2})?\s*:\s*(?:[*_]{1,2})?\s*(.*)$/i;
const ARROW_RE = /^\s*(?:➡️|➡|->|=>|→)\s*(.*)$/;
const LABEL_DESC_SEP_RE = /\s+(?:—|–|-)\s+/;
// At the start of the line (no indentation), so an indented line under a
// choice stays that choice's continuation.
const DECISION_RE = /^decision\s*:\s*(.*?)\s*$/i;
const DECISION_FLAG_RE = /^when answered\.?$/i;
const DECISION_LINK_RE = /^\[([^\]]+)\]\((\S+)\)\.?$/;
// `Replaces: msg_…/q-…` anywhere in the block (leading whitespace aside):
// read only when every token is an id (a message id, optionally with its
// question key, or a bare key), so a prose line that happens to start with
// "Replaces:" stays prose.
const REPLACES_KEY = String.raw`q-[0-9a-f]{8}(?:-\d{1,3})?`;
const REPLACES_TOKEN = String.raw`(?:msg_[0-9A-HJKMNP-TV-Z]{26}(?:/${REPLACES_KEY})?|${REPLACES_KEY})\.?`;
const REPLACES_RE = new RegExp(String.raw`^\s*replaces\s*:\s*(${REPLACES_TOKEN}(?:[\s,;]+${REPLACES_TOKEN})*)[\s,;]*$`, 'i');
// A line (leading whitespace aside) that opens a block of its own (list item, heading,
// quote, fence, directive, table row, HTML, rule) ends a plain bullet instead
// of continuing it lazily.
const STARTS_OTHER_BLOCK_RE = /^(?:[-*+]\s|\d{1,9}[.)]\s|#{1,6}(?:\s|$)|>|```|~~~|:::|\||<[A-Za-z/!]|(?:[-*_]\s*){3,}$)/;

/** A line under a `Recommended:` line that wraps it (a continuation of the
 *  same sentence) rather than starting a reason or new prose: the line so
 *  far ends without sentence punctuation and this one starts in lower case,
 *  and it starts no other block. Anything else stays context, as before. */
const isRecommendationWrap = (soFar: string, line: string): boolean => {
  const next = line.trim();
  if (PLAIN_BULLET_RE.test(line) || STARTS_OTHER_BLOCK_RE.test(next)) return false;
  if (/[.!?:;]["'”’)\]*_]*$/.test(soFar)) return false;
  return /^\p{Ll}/u.test(next);
};

/** `line` without its first `columns` columns of leading whitespace (tabs
 *  expanded to 4-column stops). */
const dedent = (line: string, columns: number): string => {
  let width = 0;
  let i = 0;
  while (i < line.length && width < columns && (line[i] === ' ' || line[i] === '\t')) {
    width += line[i] === '\t' ? 4 - (width % 4) : 1;
    i++;
  }
  // A tab that ran past the cut leaves its remaining columns as spaces.
  return ' '.repeat(Math.max(0, width - columns)) + line.slice(i);
};

/** Leading whitespace width in columns (a tab counts 4). */
const indentWidth = (line: string): number => {
  let width = 0;
  for (const ch of line) {
    if (ch === ' ') width += 1;
    else if (ch === '\t') width += 4 - (width % 4);
    else break;
  }
  return width;
};

/** The decision link a `Decision:` value names, or null when the value is not
 *  exactly one markdown link to an absolute http(s) URL. */
const parseDecisionLink = (value: string): QuestionDecisionLink | null => {
  const m = value.match(DECISION_LINK_RE);
  if (!m) return null;
  const statement = m[1].trim();
  if (!statement) return null;
  let url: URL;
  try {
    url = new URL(m[2]);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return { statement, url: m[2] };
};

const splitLabel = (raw: string): { label: string; description?: string } => {
  const idx = raw.search(LABEL_DESC_SEP_RE);
  if (idx === -1) return { label: raw.trim() };
  const sep = raw.slice(idx).match(LABEL_DESC_SEP_RE)![0];
  const description = raw.slice(idx + sep.length).trim();
  return {
    label: raw.slice(0, idx).trim(),
    ...(description ? { description } : {}),
  };
};

// `**` only: `__init__: …` names a Python method, not a bold lead.
const BOLD_LEAD_RE = /^\*\*(.+?)\*\*(.*)$/s;

/** A choice written as a bold name and then prose (`**One per session:**
 *  "ramos · cloud-3", …`): the bold name is the label and the rest the
 *  description. Only when the name is set off by punctuation (a `:` `.` `?`
  *  `!` closing the bold text, or `:` `,` `;` or a dash after it), so
 *  `**Fast** mode with cache` and `**Fast** (cached)` stay one label. */
const splitBoldLead = (raw: string): { label: string; description: string } | null => {
  const m = raw.trim().match(BOLD_LEAD_RE);
  if (!m) return null;
  const inner = m[1].trim();
  const rest = m[2];
  if (!/[:.?!]$/.test(inner) && !/^\s*[:,;—–]/.test(rest) && !/^\s+-\s/.test(rest)) return null;
  const label = inner.replace(/\s*:$/, '').trim();
  const description = rest.replace(/^\s*[:,;—–-]?\s*/, '').trim();
  if (!label || !description) return null;
  return { label, description };
};

/** A plain-bullet label longer than `MAX_QUESTION_CHOICE_LABEL_CHARS` is cut
 *  at its first sentence end (else its last space) within the cap; the rest
 *  leads the description, so the card shows a short name. Nothing is
 *  dropped. Task-list labels keep their full length (an answer quotes up to
 *  `MAX_QUESTION_SELECTED_CHARS`). */
const capChoiceLabel = (split: { label: string; description?: string }): { label: string; description?: string } => {
  const { label, description } = split;
  if (label.length <= MAX_QUESTION_CHOICE_LABEL_CHARS) return split;
  const head = label.slice(0, MAX_QUESTION_CHOICE_LABEL_CHARS);
  const sentence = head.match(/^.+?[.!?]["'”’)\]]?(?=\s)/);
  const space = head.lastIndexOf(' ');
  const at = sentence ? sentence[0].length : space > 0 ? space : MAX_QUESTION_CHOICE_LABEL_CHARS;
  const tail = label.slice(at).trim();
  const desc = [tail, description].filter(Boolean).join(' — ');
  return { label: label.slice(0, at).trim(), ...(desc ? { description: desc } : {}) };
};

type ChoiceSplit = { label: string; description?: string };

/** Labels and descriptions for plain-bullet choices. Each bullet prefers a
 *  bold-name label, cut to the answer cap, then the uncut label, then the
 *  plain dash split (what a task-list item uses); a bullet whose label
 *  collides with another's steps down that list, so two choices never share
 *  a label (both would show as picked, and the answer could not tell them
 *  apart). Also returns every name a recommendation may use per choice,
 *  including the bullet's first line and its dash-split label (what the
 *  label was before wrapped lines joined it), so a recommendation that
 *  matched before still matches. */
const plainBulletSplits = (bullets: { text: string; first: string }[]): { splits: ChoiceSplit[]; names: string[][] } => {
  const texts = bullets.map((b) => b.text);
  const options = texts.map((text) => {
    const plain = splitLabel(text);
    const preferred = splitBoldLead(text) ?? plain;
    const list: ChoiceSplit[] = [capChoiceLabel(preferred), preferred, plain];
    return list.filter((o, i) => list.findIndex((p) => p.label === o.label && p.description === o.description) === i);
  });
  const pick = options.map(() => 0);
  for (let changed = true; changed; ) {
    changed = false;
    const owners = new Map<string, number[]>();
    pick.forEach((p, i) => {
      const key = normalizeQuestionText(options[i][p].label);
      owners.set(key, [...(owners.get(key) ?? []), i]);
    });
    for (const group of owners.values()) {
      if (group.length < 2) continue;
      for (const i of group) {
        if (pick[i] < options[i].length - 1) {
          pick[i]++;
          changed = true;
        }
      }
    }
  }
  return {
    splits: pick.map((p, i) => options[i][p]),
    names: options.map((list, i) => [...list.map((o) => o.label), bullets[i].first, splitLabel(bullets[i].first).label]),
  };
};

/** Normalization for comparing labels and prompts: markdown emphasis and code
 *  ticks dropped, whitespace collapsed, case folded, trailing punctuation
 *  trimmed. */
export const normalizeQuestionText = (value: string): string =>
  value
    .replace(/[*_`]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!?:;,]+$/, '')
    .trim()
    .toLowerCase();

/** FNV-1a 32-bit, as 8 hex chars. Deterministic and sync in every runtime. */
const hash8 = (value: string): string => {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
};

/** `q-` + hash8(kind + "\n" + normalized prompt). Stable across plan versions
 *  while the prompt is unchanged and independent of block ids; a reworded
 *  prompt is a new question. */
export const questionKey = (kind: QuestionKind, prompt: string): string =>
  `q-${hash8(`${kind}\n${normalizeQuestionText(prompt)}`)}`;

const QUESTION_KEY_RE = /^q-[0-9a-f]{8}(?:-\d{1,3})?$/;

/** Resolve a recommendation's text against the choices. Returns the matched
 *  choice indices (empty when it names none). */
const matchRecommendation = (
  text: string,
  raws: string[],
  choices: QuestionChoice[],
  multi: boolean,
  names: string[][] = [],
  plainBullets = false,
): number[] => {
  const match = (candidate: string): number => {
    const target = normalizeQuestionText(candidate);
    if (!target) return -1;
    return choices.findIndex(
      (c, i) =>
        normalizeQuestionText(c.label) === target
        || normalizeQuestionText(raws[i]) === target
        || (names[i] ?? []).some((name) => normalizeQuestionText(name) === target),
    );
  };
  const whole = match(text);
  if (whole !== -1) return [whole];
  const head = match(splitLabel(text).label);
  if (head !== -1) return [head];
  // `**Name:** why` and `Name. Why…` (a recommendation that wraps on into its
  // reasons) name a choice by their lead.
  for (const lead of [splitBoldLead(text)?.label, text.match(/^.+?[.!?](?=\s)/)?.[0]]) {
    const hit = lead ? match(lead) : -1;
    if (hit !== -1) return [hit];
  }
  // Plain bullets only (task lists match exactly as they always have):
  // `b. Default off; …` names the one choice whose label starts `b.` / `b)`,
  // same case, so `A. Smith's proposal` never names an `a.` choice.
  const letteredHit = (candidate: string): number => {
    if (!plainBullets) return -1;
    const token = candidate.replace(/^[*_]+/, '').match(/^([A-Za-z]|\d{1,2})[.)]\s/)?.[1];
    if (!token) return -1;
    const hits = choices.flatMap((c, i) => {
      const label = c.label.replace(/^[*_]+/, '');
      return label.startsWith(`${token}.`) || label.startsWith(`${token})`) ? [i] : [];
    });
    return hits.length === 1 ? hits[0] : -1;
  };
  if (multi) {
    for (const sep of [/\s*;\s*/, /\s*,\s*|\s+(?:and|&|\+)\s+/i]) {
      const parts = text.split(sep).map((p) => p.trim()).filter(Boolean);
      if (parts.length < 2) continue;
      const hits = parts.map((p) => {
        const hit = match(p);
        if (hit !== -1) return hit;
        const head = match(splitLabel(p).label);
        return head !== -1 ? head : letteredHit(p);
      });
      if (hits.every((h) => h !== -1)) return [...new Set(hits)];
    }
  }
  const lettered = letteredHit(text);
  return lettered !== -1 ? [lettered] : [];
};

/**
 * Parse a `:::question*` directive body. Returns null when the block is not a
 * question (wrong kind, no prompt, oversized body): the renderer then shows
 * the ordinary directive callout. Never throws.
 */
export const parseQuestionBlock = (directiveKind: string | undefined, body: string): ParsedQuestion | null => {
  if (!isQuestionDirectiveKind(directiveKind)) return null;
  if (typeof body !== 'string' || body.length > MAX_QUESTION_BODY_CHARS) return null;
  const lines = body.replace(/\r\n?/g, '\n').split('\n');

  let prompt = '';
  let promptLine = -1;
  const contextLines: string[] = [];
  const choices: QuestionChoice[] = [];
  const raws: string[] = [];
  // Further names a recommendation may use per choice (plain bullets only).
  const choiceNames: string[][] = [];
  // A plain bullet's context lines: its own line plus every continuation
  // line, so all of them leave the context when the bullets become choices.
  const plainBullets: { text: string; first: string; contextIndices: number[] }[] = [];
  // Context lines to drop at the end: plain bullets that became choices, and
  // the lines that wrap the final recommendation.
  const dropContext = new Set<number>();
  // The current recommendation's wrapped lines (their context indices). They
  // sit in the context until the end, so a later `Recommended:` that
  // replaces this one leaves them there instead of losing them.
  let recommendationWrapIndices: number[] = [];
  // The recommendation as its line reads, and with the lines that wrap it
  // (see isRecommendationWrap). A choice is matched on the line first.
  let recommendation: string | undefined;
  let recommendationWrapped: string | undefined;
  let recommendationOpen = false;
  let lastChoice = -1;
  // The plain bullet the next line may continue (CommonMark list-item
  // paragraph rules): an indented line, or an unindented "lazy" line that
  // starts no other block, continues it; after a blank line only a line
  // indented to the bullet's content column does (a further paragraph).
  let openBullet: { index: number; contentColumn: number; afterBlank: boolean } | null = null;
  let decisionFlag = false;
  let decision: QuestionDecisionLink | undefined;
  const replaces: string[] = [];

  const pushContext = (line: string) => {
    contextLines.push(line);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') {
      lastChoice = -1;
      if (openBullet) openBullet.afterBlank = true;
      recommendationOpen = false;
      if (contextLines.length > 0 && contextLines[contextLines.length - 1] !== '') pushContext('');
      continue;
    }
    const choice = directiveKind === 'question-text' ? null : line.match(CHOICE_RE);
    if (choice) {
      if (choices.length >= MAX_QUESTION_CHOICES) continue;
      const raw = choice[2].trim();
      const { label, description } = splitLabel(raw);
      if (!label) continue;
      choices.push({
        label,
        ...(description ? { description } : {}),
        settled: choice[1].toLowerCase() === 'x',
        recommended: false,
      });
      raws.push(raw);
      lastChoice = choices.length - 1;
      openBullet = null;
      recommendationOpen = false;
      continue;
    }
    const replacesLine = line.match(REPLACES_RE);
    if (replacesLine) {
      for (const raw of replacesLine[1].split(/[\s,;]+/)) {
        const token = raw.replace(/\.$/, '');
        if (token && !replaces.includes(token)) replaces.push(token);
      }
      lastChoice = -1;
      openBullet = null;
      recommendationOpen = false;
      continue;
    }
    const rec = line.match(RECOMMENDED_RE) ?? line.match(ARROW_RE);
    if (rec) {
      const text = rec[1].replace(/[*_]{1,2}$/, '').trim();
      if (text) {
        recommendation = recommendationWrapped = text;
        recommendationWrapIndices = [];
      }
      recommendationOpen = !!text;
      lastChoice = -1;
      openBullet = null;
      continue;
    }
    if (!prompt) {
      // A heading marker on the prompt line (`### Which…?`) is dropped.
      prompt = line.trim().replace(/^#{1,6}\s+/, '');
      promptLine = i;
      continue;
    }
    const decisionLine = line.match(DECISION_RE);
    if (decisionLine) {
      if (!decisionFlag && DECISION_FLAG_RE.test(decisionLine[1])) {
        decisionFlag = true;
        lastChoice = -1;
        openBullet = null;
        recommendationOpen = false;
        continue;
      }
      const link = decision ? null : parseDecisionLink(decisionLine[1]);
      if (link) {
        decision = link;
        lastChoice = -1;
        openBullet = null;
        recommendationOpen = false;
        continue;
      }
    }
    if (recommendationOpen) {
      if (recommendationWrapped && isRecommendationWrap(recommendationWrapped, line)) {
        recommendationWrapped = `${recommendationWrapped} ${line.trim().replace(/[*_]{1,2}$/, '').trim()}`;
        recommendationWrapIndices.push(contextLines.length);
        pushContext(line.trimEnd());
        continue;
      }
      recommendationOpen = false;
    }
    // An indented line right under a choice continues that choice.
    if (lastChoice !== -1 && /^\s+\S/.test(line)) {
      const c = choices[lastChoice];
      const extra = line.trim();
      if (c.description) c.description = `${c.description} ${extra}`;
      else c.description = extra;
      raws[lastChoice] = `${raws[lastChoice]} ${extra}`;
      continue;
    }
    lastChoice = -1;
    const bullet = line.match(PLAIN_BULLET_RE);
    if (openBullet && !bullet) {
      // Indentation is compared with the bullet's own content column, never
      // with zero: a question inside a list item has every body line indented.
      const inItem = indentWidth(line) >= openBullet.contentColumn;
      const continues = openBullet.afterBlank
        ? inItem
        : inItem || !STARTS_OTHER_BLOCK_RE.test(line.trimStart());
      if (continues) {
        const target = plainBullets[openBullet.index];
        target.text = `${target.text} ${line.trim()}`;
        target.contextIndices.push(contextLines.length);
        openBullet.afterBlank = false;
        pushContext(line.trimEnd());
        continue;
      }
    }
    openBullet = null;
    if (bullet && bullet[1].trim()) {
      plainBullets.push({ text: bullet[1].trim(), first: bullet[1].trim(), contextIndices: [contextLines.length] });
      openBullet = {
        index: plainBullets.length - 1,
        contentColumn: indentWidth(line) + (line.trimStart().length - bullet[1].length),
        afterBlank: false,
      };
    }
    pushContext(line.trimEnd());
  }

  if (!prompt) return null;

  // A pick question written with plain bullets: the bullets are the choices.
  const choicesArePlainBullets = choices.length === 0 && directiveKind !== 'question-text' && plainBullets.length > 0;
  if (choicesArePlainBullets) {
    const bullets = plainBullets.slice(0, MAX_QUESTION_CHOICES);
    const { splits, names } = plainBulletSplits(bullets);
    bullets.forEach((bullet, i) => {
      const { label, description } = splits[i];
      if (!label) return;
      const aliases = [...new Set([bullet.text, ...names[i]])]
        .filter((name) => name && normalizeQuestionText(name) !== normalizeQuestionText(label));
      choices.push({
        label,
        ...(description ? { description } : {}),
        ...(aliases.length > 0 ? { aliases } : {}),
        settled: false,
        recommended: false,
      });
      raws.push(bullet.text);
      choiceNames.push(names[i]);
      for (const index of bullet.contextIndices) dropContext.add(index);
    });
  }
  for (const index of recommendationWrapIndices) dropContext.add(index);
  for (let i = contextLines.length - 1; i >= 0; i--) if (dropContext.has(i)) contextLines.splice(i, 1);

  const kind: QuestionKind = choices.length === 0 || directiveKind === 'question-text'
    ? 'text'
    : directiveKind === 'question-multi' ? 'multi' : 'single';

  let suggestedText: string | undefined;
  if (recommendation) {
    const wrapped = recommendationWrapped ?? recommendation;
    let hits: number[] = [];
    if (kind !== 'text') {
      hits = matchRecommendation(recommendation, raws, choices, kind === 'multi', choiceNames, choicesArePlainBullets);
      if (hits.length === 0 && wrapped !== recommendation) {
        hits = matchRecommendation(wrapped, raws, choices, kind === 'multi', choiceNames, choicesArePlainBullets);
      }
    }
    if (hits.length > 0) for (const hit of hits) choices[hit].recommended = true;
    else suggestedText = wrapped;
    recommendation = wrapped;
  }

  // Context keeps each line's indentation (a nested list, a wrapped list item,
  // a code fence), less the indentation every line shares, so it renders as
  // the markdown it was written as.
  const shared = Math.min(...contextLines.filter((l) => l.trim() !== '').map(indentWidth));
  const context = contextLines
    .map((l) => (Number.isFinite(shared) && shared > 0 ? dedent(l, shared) : l))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+/, '')
    .trimEnd();

  return {
    kind,
    directiveKind,
    prompt,
    promptLine,
    context,
    choices: kind === 'text' ? [] : choices,
    ...(recommendation ? { recommendation } : {}),
    ...(suggestedText ? { suggestedText } : {}),
    key: questionKey(kind, prompt),
    ...(decision ? { decision } : decisionFlag ? { decisionOnAnswer: true as const } : {}),
    ...(replaces.length > 0 ? { replaces } : {}),
  };
};

/** The block shape `indexQuestionBlocks` reads (structural, so core does not
 *  depend on the UI's `Block` type). */
export interface QuestionSourceBlock {
  id: string;
  type: string;
  directiveKind?: string;
  content: string;
  startLine: number;
}

export interface IndexedQuestion {
  blockId: string;
  /** 1-based position among the document's question blocks. */
  number: number;
  /** Document line of the prompt (1-based). */
  line: number;
  question: ParsedQuestion;
}

/** The one de-duplication rule for keys within a document: the first block
 *  with a key keeps it, later ones get `-2`, `-3`… in document order. Shared
 *  by `indexQuestionBlocks` and `findQuestionBlocks` so they cannot differ. */
const questionKeyDeduper = (): ((key: string) => string) => {
  const seen = new Map<string, number>();
  return (key) => {
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    return count === 1 ? key : `${key}-${count}`;
  };
};

/**
 * Every parseable question block of a document, in document order, numbered
 * from 1. Keys are de-duplicated with a `-2`, `-3`… suffix so two identical
 * prompts in one document never share an answer.
 */
export const indexQuestionBlocks = (blocks: ReadonlyArray<QuestionSourceBlock>): IndexedQuestion[] => {
  const out: IndexedQuestion[] = [];
  const dedupe = questionKeyDeduper();
  for (const block of blocks) {
    if (block.type !== 'directive' || !isQuestionDirectiveKind(block.directiveKind)) continue;
    const parsed = parseQuestionBlock(block.directiveKind, block.content);
    if (!parsed) continue;
    const key = dedupe(parsed.key);
    out.push({
      blockId: block.id,
      number: out.length + 1,
      // The directive's opening `:::` sits on startLine; its body starts one below.
      line: block.startLine + 1 + parsed.promptLine,
      question: { ...parsed, key },
    });
  }
  return out;
};

/** Where one question block sits in a markdown document (see
 *  `findQuestionBlocks`). */
export interface QuestionBlockLocation {
  /** The block's key, de-duplicated exactly as `indexQuestionBlocks` does it
   *  (`-2`, `-3`… for repeated prompts). Address a block by this key. */
  key: string;
  directiveKind: QuestionDirectiveKind;
  /** 1-based line of the opening `:::question…`. */
  startLine: number;
  /** 1-based line of the closing `:::`, or the document's last line when the
   *  block is never closed (it then runs to the end, as it renders). */
  endLine: number;
  /** The exact source text of lines `startLine`..`endLine`, joined with `\n`
   *  (a `\r` before each newline is kept). */
  text: string;
}

/**
 * Every parseable question block of a markdown document, in document order,
 * located by line. For a server that has to find or verify a question without
 * the UI parser: the keys and block boundaries are the ones `@plannotator/ui`
 * renders, because both split the document with the same
 * `./markdown-structure` helpers (frontmatter, backtick code fences, display
 * math, directives, raw HTML blocks, link reference resolution). A
 * `:::question` inside a code fence, inside an HTML block, inside another
 * directive's body, or behind a blockquote marker is not a block.
 *
 * `frontmatter: false` matches `parseMarkdownToBlocks(markdown, { frontmatter:
 * false })`; the default strips a leading `--- … ---` block like it does.
 */
export const findQuestionBlocks = (
  markdown: string,
  options: { frontmatter?: boolean } = {},
): QuestionBlockLocation[] => {
  if (typeof markdown !== 'string') return [];
  const { content, contentStartLine } = options.frontmatter === false
    ? { content: markdown, contentStartLine: 1 }
    : splitFrontmatter(markdown);
  const source = markdown.split('\n');
  const lines = resolveReferenceLinks(content).split('\n');
  const closeCache = new Map<string, TagCloseIndex>();
  const dedupe = questionKeyDeduper();
  const out: QuestionBlockLocation[] = [];

  // The block splitter's multi-line constructs, in its order. Every other
  // construct it knows (headings, rules, list items, quotes, tables,
  // paragraphs) is one line here and cannot hide a `:::` opener: those lines
  // start with a different character, and the splitter tests them first.
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('```')) {
      i = codeFenceCloseIndex(lines, i);
      continue;
    }
    const mathDelimiter = trimmed.startsWith('$$') ? '$$' : trimmed.startsWith('\\[') ? '\\[' : null;
    const math = mathDelimiter ? scanDisplayMath(lines, i, mathDelimiter) : null;
    if (math) {
      i = math.closeLine;
      // Text after the close is read again as its own line, as the splitter does.
      if (math.remainder) {
        lines[i] = math.remainder;
        i--;
      }
      continue;
    }
    const directiveOpen = trimmed.match(DIRECTIVE_OPEN_RE);
    if (directiveOpen) {
      const close = directiveCloseIndex(lines, i);
      const kind = directiveOpen[1].toLowerCase();
      if (isQuestionDirectiveKind(kind)) {
        const parsed = parseQuestionBlock(kind, lines.slice(i + 1, close).join('\n'));
        if (parsed) {
          const startLine = i + contentStartLine;
          const endLine = Math.min(close, lines.length - 1) + contentStartLine;
          out.push({
            key: dedupe(parsed.key),
            directiveKind: kind,
            startLine,
            endLine,
            text: source.slice(startLine - 1, endLine).join('\n'),
          });
        }
      }
      i = close;
      continue;
    }
    const htmlEnd = htmlBlockEndAt(lines, i, closeCache);
    if (htmlEnd !== -1) i = htmlEnd;
  }
  return out;
};

// ─────────────────────────────── Answers ───────────────────────────────

/** One answer to one question. Stored as `Annotation.questionAnswer`. */
export interface QuestionAnswer {
  v: 1;
  key: string;
  kind: QuestionKind;
  /** The prompt, so the export and archive need no re-parse. */
  prompt: string;
  /** Picked choice LABELS (never ids). */
  selected: string[];
  /** "Other…" text on a choice question. */
  other?: string;
  /** Free-text answer. */
  text?: string;
  note?: string;
  skipped?: boolean;
  /**
   * With `skipped`: the Plannotator Inbox skipped it because a Send left it
   * unanswered, not because the person pressed Skip. Read only with
   * `skipped: true`.
   */
  by_reply?: boolean;
  /** Document line of the prompt when answered. */
  sourceLine?: number;
}

const cap = (value: string, max: number): string => (value.length > max ? value.slice(0, max) : value);

/**
 * An answer's copy of its question's prompt, cut at `MAX_QUESTION_PROMPT_CHARS`
 * between characters (never inside an emoji). The Plannotator Inbox compares
 * a posted answer's prompt with its question's through this same cut.
 */
export function capQuestionPrompt(prompt: string): string {
  return sliceText(prompt, MAX_QUESTION_PROMPT_CHARS);
}

/**
 * Fail-closed validator: returns a normalized copy holding only the known
 * fields (strings truncated to their caps, empty optionals dropped), or null
 * for anything malformed. Every reader of `questionAnswer` goes through it,
 * so a row from an older or foreign writer can never throw in a renderer.
 */
export const parseQuestionAnswer = (value: unknown): QuestionAnswer | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (v.v !== 1) return null;
  if (typeof v.key !== 'string' || !QUESTION_KEY_RE.test(v.key)) return null;
  if (v.kind !== 'single' && v.kind !== 'multi' && v.kind !== 'text') return null;
  if (typeof v.prompt !== 'string') return null;
  if (!Array.isArray(v.selected) || !v.selected.every((s) => typeof s === 'string')) return null;
  for (const field of ['other', 'text', 'note'] as const) {
    if (v[field] !== undefined && typeof v[field] !== 'string') return null;
  }
  if (v.skipped !== undefined && typeof v.skipped !== 'boolean') return null;
  if (v.by_reply !== undefined && typeof v.by_reply !== 'boolean') return null;
  if (v.sourceLine !== undefined && !(Number.isInteger(v.sourceLine) && (v.sourceLine as number) > 0)) return null;

  const selected = [...new Set((v.selected as string[])
    .map((s) => cap(s.trim(), MAX_QUESTION_SELECTED_CHARS))
    .filter(Boolean))]
    .slice(0, MAX_QUESTION_CHOICES);
  const other = typeof v.other === 'string' ? cap(v.other, MAX_QUESTION_OTHER_CHARS) : '';
  const text = typeof v.text === 'string' ? cap(v.text, MAX_QUESTION_TEXT_CHARS) : '';
  const note = typeof v.note === 'string' ? cap(v.note, MAX_QUESTION_NOTE_CHARS) : '';
  return {
    v: 1,
    key: v.key,
    kind: v.kind,
    prompt: capQuestionPrompt(v.prompt),
    selected,
    ...(other.trim() ? { other } : {}),
    ...(text.trim() ? { text } : {}),
    ...(note.trim() ? { note } : {}),
    ...(v.skipped === true ? { skipped: true } : {}),
    ...(v.skipped === true && v.by_reply === true ? { by_reply: true } : {}),
    ...(typeof v.sourceLine === 'number' ? { sourceLine: v.sourceLine } : {}),
  };
};

/**
 * The answer with each picked label read against the question's current
 * choices: a label that names a choice by one of its `aliases` (a label an
 * older version gave it) becomes that choice's label, so an answer saved
 * before the label changed still shows its pick. An exact name is tried
 * before a normalized one (case, emphasis, punctuation), and a label that
 * names no choice, or several, is kept as it is. Returns the same object
 * when nothing maps.
 */
export const canonicalQuestionAnswer = <A extends QuestionAnswer>(
  question: Pick<ParsedQuestion, 'choices'>,
  answer: A,
): A => {
  if (answer.selected.length === 0) return answer;
  const labels = new Set(question.choices.map((c) => c.label));
  if (answer.selected.every((stored) => labels.has(stored))) return answer;
  // The one choice a stored label names, or -1 when none or several do: an
  // ambiguous label (two bullets that shared a first line, or names that only
  // differ in case or emphasis) stays as stored rather than picking one.
  const only = (hits: number[]): number => (hits.length === 1 ? hits[0] : -1);
  // Through 0.28.17 an answer's labels were cut at
  // MAX_QUESTION_CHOICE_LABEL_CHARS: a stored label that is exactly a long
  // label's first 200 characters names that choice. Exact only, never
  // normalized, so a question with a long label matches nothing else looser.
  const cutLabels = question.choices.map((c) => legacyCutName(c.label));
  const cutHit = (stored: string): number =>
    only(question.choices.flatMap((_, i) => (cutLabels[i] === stored ? [i] : [])));
  const hasAliases = question.choices.some((c) => c.aliases?.length);
  // Answers were capped on validation, so a long alias is matched cut too.
  const names = question.choices.map((c) =>
    (c.aliases ?? []).flatMap((alias) => {
      const cut = legacyCutName(alias);
      return cut === null ? [alias] : [alias, cut];
    }));
  const exactHit = (stored: string): number =>
    only(question.choices.flatMap((_, i) => (names[i].includes(stored) ? [i] : [])));
  const normalizedHit = (stored: string): number => {
    const target = normalizeQuestionText(stored);
    if (!target) return -1;
    return only(question.choices.flatMap((c, i) =>
      normalizeQuestionText(c.label) === target || names[i].some((n) => normalizeQuestionText(n) === target) ? [i] : []));
  };
  let changed = false;
  const selected = answer.selected.map((stored) => {
    if (labels.has(stored)) return stored;
    let hit = hasAliases ? exactHit(stored) : -1;
    if (hit === -1) hit = cutHit(stored);
    if (hit === -1 && hasAliases) hit = normalizedHit(stored);
    if (hit === -1) return stored;
    changed = true;
    return question.choices[hit].label;
  });
  return changed ? { ...answer, selected: [...new Set(selected)] } : answer;
};

/** A name as a build through 0.28.17 stored it in an answer when it was
 *  longer than MAX_QUESTION_CHOICE_LABEL_CHARS (cut to that length), else
 *  null (such a name was stored whole). */
const legacyCutName = (name: string): string | null => {
  const trimmed = name.trim();
  return trimmed.length > MAX_QUESTION_CHOICE_LABEL_CHARS ? cap(trimmed, MAX_QUESTION_CHOICE_LABEL_CHARS) : null;
};

/** Whether the export needs a question's choices to print an answer's
 *  current label: a choice has older names, or a label long enough that an
 *  older build stored it cut. */
export const questionChoicesNeedCanonicalLabels = (choices: ReadonlyArray<Pick<QuestionChoice, 'label' | 'aliases'>>): boolean =>
  choices.some((c) => (c.aliases?.length ?? 0) > 0 || legacyCutName(c.label) !== null);

/** A choice was picked, "Other…" was filled, or free text was written. */
export const isQuestionAnswered = (answer: QuestionAnswer): boolean =>
  answer.selected.length > 0 || !!answer.other?.trim() || !!answer.text?.trim();

/** Nothing worth keeping: not answered, not skipped, no note. The host
 *  removes the answer's annotation when an edit makes it empty. */
export const isQuestionAnswerEmpty = (answer: QuestionAnswer): boolean =>
  !isQuestionAnswered(answer) && !answer.skipped && !answer.note?.trim();

/** How a question reads to the reviewer: `answered` (a pick, Other or free
 *  text), `skipped`, `settled` (the agent marked a choice `[x]` and the
 *  reviewer has not picked, filled Other or skipped; a note alone keeps it
 *  settled), or `open`. The card, the panel and the progress chip all use
 *  this one rule. */
export type QuestionStatus = 'open' | 'answered' | 'skipped' | 'settled';

export const questionStatus = (
  question: Pick<ParsedQuestion, 'choices'>,
  answer?: QuestionAnswer | null,
): QuestionStatus => {
  if (answer && isQuestionAnswered(answer)) return 'answered';
  if (answer?.skipped) return 'skipped';
  if (question.choices.some((c) => c.settled)) return 'settled';
  return 'open';
};

/** An empty answer for a question, ready to edit. */
export const emptyQuestionAnswer = (indexed: Pick<IndexedQuestion, 'line' | 'question'>): QuestionAnswer => ({
  v: 1,
  key: indexed.question.key,
  kind: indexed.question.kind,
  prompt: capQuestionPrompt(indexed.question.prompt),
  selected: [],
  sourceLine: indexed.line,
});

/** The answer a question's recommendation stands for: the recommended
 *  choices, or the suggested text (as the free-text answer on a text
 *  question, as "Other…" on a choice question). Null without one. */
export const recommendedQuestionAnswer = (
  indexed: Pick<IndexedQuestion, 'line' | 'question'>,
  base?: QuestionAnswer,
): QuestionAnswer | null => {
  const { question } = indexed;
  const start = base ?? emptyQuestionAnswer(indexed);
  const labels = question.choices.filter((c) => c.recommended).map((c) => c.label);
  const { skipped: _skipped, other: _other, text: _text, ...rest } = start;
  if (labels.length > 0) return { ...rest, selected: labels };
  if (!question.suggestedText) return null;
  return question.kind === 'text'
    ? { ...rest, selected: [], text: question.suggestedText }
    : { ...rest, selected: [], other: question.suggestedText };
};

/** Whether an answer is exactly what the question recommended. */
export const isRecommendedQuestionAnswer = (
  answer: QuestionAnswer,
  recommendedLabels: readonly string[],
  suggestedText?: string,
): boolean => {
  if (answer.kind === 'text') {
    return !!suggestedText && !!answer.text && answer.text.trim() === suggestedText.trim();
  }
  if (recommendedLabels.length > 0) {
    if (answer.other?.trim()) return false;
    const want = new Set(recommendedLabels.map(normalizeQuestionText));
    const got = new Set(answer.selected.map(normalizeQuestionText));
    return want.size === got.size && [...want].every((l) => got.has(l));
  }
  return !!suggestedText && answer.selected.length === 0 && answer.other?.trim() === suggestedText.trim();
};

const oneLine = (value: string): string => value.replace(/\s+/g, ' ').trim();

/**
 * The answer as one line, for `Annotation.text`, so a consumer that does not
 * know `questionAnswer` still reads it: `Answer: Local only — note: …`,
 * `Skipped`, `Note: …`.
 */
export const formatQuestionAnswerText = (answer: QuestionAnswer): string => {
  const parts: string[] = [];
  if (answer.selected.length) parts.push(answer.selected.map(oneLine).join('; '));
  if (answer.other?.trim()) parts.push(`Other: ${oneLine(answer.other)}`);
  if (answer.text?.trim()) parts.push(oneLine(answer.text));
  let out = parts.length ? `Answer: ${parts.join('; ')}` : answer.skipped ? 'Skipped' : '';
  if (answer.note?.trim()) out = out ? `${out} — note: ${oneLine(answer.note)}` : `Note: ${oneLine(answer.note)}`;
  return out || 'No answer';
};

/**
 * The body lines of one answer in the export (no heading):
 * `Answer: X (your recommendation)`, a bulleted list for several picks, a
 * blockquote for free text, `Skipped`, then `Note: …`.
 */
export const formatQuestionAnswerLines = (
  answer: QuestionAnswer,
  opts: { recommended?: boolean; settledLabels?: readonly string[] } = {},
): string => {
  const rec = opts.recommended ? ' (your recommendation)' : '';
  let out = '';
  // A settled question the reviewer only added a note to: the settled
  // choice stands as the answer, printed with the note.
  const settled = opts.settledLabels ?? [];
  if (settled.length > 0 && !isQuestionAnswered(answer) && !answer.skipped) {
    const labels = settled.map(oneLine);
    out += labels.length > 1
      ? `Answer (already settled in the document):\n${labels.map((l) => `- ${l}\n`).join('')}`
      : `Answer: ${labels[0]} (already settled in the document)\n`;
  }
  const picks = [...answer.selected.map(oneLine)];
  if (answer.other?.trim()) picks.push(`Other: ${oneLine(answer.other)}`);
  if (answer.text?.trim()) {
    out += `Answer${rec}:\n> ${answer.text.trim().replace(/\r?\n/g, '\n> ')}\n`;
  } else if (picks.length > 1) {
    out += `Answer${rec}:\n${picks.map((p) => `- ${p}\n`).join('')}`;
  } else if (picks.length === 1) {
    out += `Answer: ${picks[0]}${rec}\n`;
  } else if (answer.skipped) {
    out += answer.by_reply ? 'Skipped (not answered in this reply)\n' : 'Skipped\n';
  }
  const note = answer.note?.trim();
  if (note) {
    // A multi-line note keeps its line breaks, as a blockquote like free
    // text; a one-line note stays on the `Note:` line.
    out += /\r?\n/.test(note)
      ? `Note:\n> ${note.replace(/\r?\n/g, '\n> ')}\n`
      : `Note: ${note}\n`;
  }
  return out;
};

/** What the export needs to know about one question of the document. */
export interface QuestionExportItem {
  key: string;
  number: number;
  prompt: string;
  line?: number;
  recommendedLabels: string[];
  suggestedText?: string;
  /** The agent marked a choice `[x]`: decided, not waiting on the reviewer. */
  settled: boolean;
  /** The `[x]` choice labels. Absent reads as none. */
  settledLabels?: string[];
  /** The question's choices, so an answer that quotes an older label is
   *  printed with the current one (`canonicalQuestionAnswer`). Absent: the
   *  answer's labels are printed as stored. */
  choices?: Pick<QuestionChoice, 'label' | 'aliases'>[];
}

export const questionExportItems = (indexed: ReadonlyArray<IndexedQuestion>): QuestionExportItem[] =>
  indexed.map(({ number, line, question }) => ({
    key: question.key,
    number,
    prompt: question.prompt,
    line,
    recommendedLabels: question.choices.filter((c) => c.recommended).map((c) => c.label),
    ...(question.suggestedText ? { suggestedText: question.suggestedText } : {}),
    settled: question.choices.some((c) => c.settled),
    settledLabels: question.choices.filter((c) => c.settled).map((c) => c.label),
    ...(questionChoicesNeedCanonicalLabels(question.choices) ? { choices: question.choices.map(({ label, aliases }) => ({ label, ...(aliases ? { aliases } : {}) })) } : {}),
  }));

export const QUESTION_ANSWERS_HEADING = 'Answers to your questions';

/**
 * The "Answers to your questions" export section. Empty string when there is
 * no answer, note or skip to report (the export then carries no section).
 *
 * `Q<n>` is the document order of every question block, so numbers match the
 * "Question N of M" eyebrows. Questions the agent already settled with `[x]`
 * and the reviewer left alone are neither counted nor listed as unanswered;
 * one the reviewer only added a note to counts as answered by its settled
 * choice, which is printed with the note.
 * An answer whose question is no longer in the document is still reported.
 */
export const formatQuestionAnswersSection = (
  questions: ReadonlyArray<QuestionExportItem>,
  answers: ReadonlyArray<QuestionAnswer>,
  opts: { headingLevel?: 2 | 3 } = {},
): string => {
  const choicesByKey = new Map(questions.map((q) => [q.key, q.choices]));
  const reported = answers
    .filter((a) => !isQuestionAnswerEmpty(a))
    .map((a) => {
      const choices = choicesByKey.get(a.key);
      return choices ? canonicalQuestionAnswer({ choices: choices as QuestionChoice[] }, a) : a;
    });
  if (reported.length === 0) return '';
  const h = '#'.repeat(opts.headingLevel ?? 2);
  const sub = `${h}#`;
  const byKey = new Map<string, QuestionAnswer>();
  for (const a of reported) if (!byKey.has(a.key)) byKey.set(a.key, a);

  const open = questions.filter((q) => !q.settled || byKey.has(q.key));
  const settledUntouched = questions.length - open.length;
  // A settled question with only a note (no pick, Other or skip) counts as
  // answered: the settled choice stands.
  const settledStands = (q: QuestionExportItem, a: QuestionAnswer): boolean =>
    q.settled && !isQuestionAnswered(a) && !a.skipped;
  const answered = open.filter((q) => {
    const a = byKey.get(q.key);
    return a ? isQuestionAnswered(a) || settledStands(q, a) : false;
  }).length;

  let out = `${h} ${QUESTION_ANSWERS_HEADING}\n\n`;
  out += `${answered} of ${open.length} question${open.length === 1 ? '' : 's'} answered.`;
  if (settledUntouched > 0) {
    out += ` ${settledUntouched} already settled in the document ${settledUntouched === 1 ? 'was' : 'were'} left as is.`;
  }
  // The Inbox's Send skips what it left unanswered: say how the agent should read those skips.
  const byReply = open.filter((q) => {
    const a = byKey.get(q.key);
    return a !== undefined && a.skipped === true && a.by_reply === true && !isQuestionAnswered(a);
  }).length;
  if (byReply > 0) {
    out += ` ${byReply} ${byReply === 1 ? 'was' : 'were'} not answered in this reply; treat ${byReply === 1 ? 'it' : 'them'} as skipped, and ask again if you still need ${byReply === 1 ? 'it' : 'them'}.`;
  }
  out += '\n\n';

  const unanswered: QuestionExportItem[] = [];
  const matched = new Set<string>();
  for (const q of open) {
    const a = byKey.get(q.key);
    if (!a) {
      unanswered.push(q);
      continue;
    }
    matched.add(q.key);
    const where = q.line ? ` (line ${q.line})` : '';
    out += `${sub} Q${q.number}. ${oneLine(q.prompt)}${where}\n`;
    out += formatQuestionAnswerLines(a, {
      recommended: isQuestionAnswered(a) && isRecommendedQuestionAnswer(a, q.recommendedLabels, q.suggestedText),
      ...(settledStands(q, a) ? { settledLabels: q.settledLabels ?? [] } : {}),
    });
    out += '\n';
  }
  for (const a of byKey.values()) {
    if (matched.has(a.key)) continue;
    out += `${sub} ${oneLine(a.prompt)} (this question is no longer in the document)\n`;
    out += formatQuestionAnswerLines(a);
    out += '\n';
  }
  if (unanswered.length > 0) {
    out += `${sub} Unanswered\n`;
    for (const q of unanswered) out += `- Q${q.number}. ${oneLine(q.prompt)}${q.line ? ` (line ${q.line})` : ''}\n`;
    out += '\n';
  }
  return out;
};

// ───────────────────────── Annotation record ─────────────────────────

export const QUESTION_ANSWER_ANNOTATION_PREFIX = 'ann-question-';

export const questionAnswerAnnotationId = (key: string): string => `${QUESTION_ANSWER_ANNOTATION_PREFIX}${key}`;

/** The annotation that carries an answer, structurally (`type` is the
 *  literal `'COMMENT'`, which a host maps onto its own annotation type). */
export interface QuestionAnswerAnnotationRecord {
  id: string;
  blockId: string;
  startOffset: 0;
  endOffset: 0;
  type: 'COMMENT';
  text: string;
  originalText: string;
  createdA: number;
  questionAnswer: QuestionAnswer;
}

/** Build the annotation for an answer: id `ann-question-<key>`, the block's
 *  id, the prompt as the quote and the one-line answer as the text. Pass the
 *  existing row's `createdA` when updating so ordering stays put. */
export const buildQuestionAnswerAnnotation = (
  blockId: string,
  answer: QuestionAnswer,
  createdA: number = Date.now(),
): QuestionAnswerAnnotationRecord => ({
  id: questionAnswerAnnotationId(answer.key),
  blockId,
  startOffset: 0,
  endOffset: 0,
  type: 'COMMENT',
  text: formatQuestionAnswerText(answer),
  originalText: answer.prompt,
  createdA,
  questionAnswer: answer,
});

// ───────────────────────── Authoring guide ─────────────────────────

/**
 * The syntax reference as one string, for a host's agent prompts. Plannotator
 * writes its own skill text from this same source.
 */
export const QUESTION_AUTHORING_GUIDE = `## Asking the reviewer questions

Ask what only the reviewer can decide as a question block. Answers come back at the top of their feedback ("Answers to your questions", then "Unanswered").

\`\`\`markdown
:::question
Where should we keep the edit that loses a sync conflict?

When two devices edit one note offline, the later save wins and the other edit is lost. Local storage keeps it with no server work.

- [ ] Local only, purged after 30 days — cheap, no server change
- [ ] Server-side per user — survives reinstall, needs a retention policy
- [ ] Nowhere — accept silent loss for v1

Recommended: Local only, purged after 30 days
:::
\`\`\`

- \`:::question\` picks one choice, \`:::question-multi\` any number, \`:::question-text\` free text (so does a block with no choices).
- The first line is the question; the lines after it are context. Never send a bare question: the reviewer switches in cold, thinks at the level of the product, and does not know what you know.
  - Say what the choice affects, what you know or tried, and why you recommend it, so they can decide without opening anything else.
  - Be terse: one to three short sentences, plain words, no jargon or internal names they would not know.
  - Add a screenshot (\`![alt](path)\`) for anything visual.
  - Link a file that shows it better (a plan, an HTML mock): \`[the mock](mock.html)\`. In the Inbox, attach it too; the link opens it beside the thread.
- Choices: \`- [ ] label\`, optionally \`- [ ] label — why\`. The reviewer can also answer "Other", add a note, or skip.
- \`Recommended: <label>\` marks yours; text matching no choice shows as a suggested answer.
- Ask only what you cannot decide alone, about 8 a round at most. Do not ask rhetorical questions or questions the codebase answers.
- \`- [x]\` marks a settled choice. On resubmit, check the chosen answer, or drop the block and state the decision in prose.
- Leave blank lines between the parts so the block reads well on GitHub.
- Each answer comes back under its question (\`### Q2. <question> (line N)\`) as \`Answer: <choice>\`, marked \`(your recommendation)\` when the reviewer took yours, or as \`Other: …\`, free text in a quote, or \`Skipped\`, plus any \`Note:\`. A question you marked \`- [x]\` is settled and only comes back if the reviewer changed it or added a note.
- In the Inbox, withdraw your own questions that are still open (read_thread state \`open\` or \`picked\`) as the thread moves on: when a newer message replaces them, makes them moot or follows up on them, or the person's reply settled them in words, name them in \`supersedes\` (or a \`Replaces:\` line) so they stop keeping the thread at the top of the person's list.
`;
