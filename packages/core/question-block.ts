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
 *   treats plain `- label` bullets as its choices.
 * - Recommendation: `Recommended: <text>` (aliases `Recommendation:`,
 *   `➡️`, `->`, `=>`, `→`). Text that names a choice label (normalized,
 *   case-insensitive; a `label — reason` tail is allowed) marks that choice
 *   recommended; on a multi question a `,` / `;` / `and` list may name
 *   several. Anything else is a suggested free-text answer.
 */

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
}

/** Caps. Parsing is bounded; answers are truncated to these on validation. */
export const MAX_QUESTION_BODY_CHARS = 20_000;
export const MAX_QUESTION_CHOICES = 20;
export const MAX_QUESTION_PROMPT_CHARS = 400;
export const MAX_QUESTION_CHOICE_LABEL_CHARS = 200;
export const MAX_QUESTION_OTHER_CHARS = 2000;
export const MAX_QUESTION_TEXT_CHARS = 4000;
export const MAX_QUESTION_NOTE_CHARS = 2000;

const CHOICE_RE = /^\s*(?:[-*+]|\d{1,3}[.)])\s+\[([ xX])\]\s+(.*)$/;
const PLAIN_BULLET_RE = /^\s*[-*+]\s+(.*)$/;
const RECOMMENDED_RE = /^\s*(?:[*_]{1,2})?(?:recommended|recommendation)(?:[*_]{1,2})?\s*:\s*(?:[*_]{1,2})?\s*(.*)$/i;
const ARROW_RE = /^\s*(?:➡️|➡|->|=>|→)\s*(.*)$/;
const LABEL_DESC_SEP_RE = /\s+(?:—|–|-)\s+/;

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
const matchRecommendation = (text: string, raws: string[], choices: QuestionChoice[], multi: boolean): number[] => {
  const match = (candidate: string): number => {
    const target = normalizeQuestionText(candidate);
    if (!target) return -1;
    return choices.findIndex(
      (c, i) => normalizeQuestionText(c.label) === target || normalizeQuestionText(raws[i]) === target,
    );
  };
  const whole = match(text);
  if (whole !== -1) return [whole];
  const head = match(splitLabel(text).label);
  if (head !== -1) return [head];
  if (!multi) return [];
  for (const sep of [/\s*;\s*/, /\s*,\s*|\s+(?:and|&|\+)\s+/i]) {
    const parts = text.split(sep).map((p) => p.trim()).filter(Boolean);
    if (parts.length < 2) continue;
    const hits = parts.map((p) => {
      const hit = match(p);
      return hit !== -1 ? hit : match(splitLabel(p).label);
    });
    if (hits.every((h) => h !== -1)) return [...new Set(hits)];
  }
  return [];
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
  const plainBullets: { text: string; contextIndex: number }[] = [];
  let recommendation: string | undefined;
  let lastChoice = -1;

  const pushContext = (line: string) => {
    contextLines.push(line);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') {
      lastChoice = -1;
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
      continue;
    }
    const rec = line.match(RECOMMENDED_RE) ?? line.match(ARROW_RE);
    if (rec) {
      const text = rec[1].replace(/[*_]{1,2}$/, '').trim();
      if (text) recommendation = text;
      lastChoice = -1;
      continue;
    }
    if (!prompt) {
      // A heading marker on the prompt line (`### Which…?`) is dropped.
      prompt = line.trim().replace(/^#{1,6}\s+/, '');
      promptLine = i;
      continue;
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
    if (bullet && bullet[1].trim()) {
      plainBullets.push({ text: bullet[1].trim(), contextIndex: contextLines.length });
    }
    pushContext(line.trim());
  }

  if (!prompt) return null;

  // A pick question written with plain bullets: the bullets are the choices.
  if (choices.length === 0 && directiveKind !== 'question-text' && plainBullets.length > 0) {
    const taken = new Set<number>();
    for (const bullet of plainBullets.slice(0, MAX_QUESTION_CHOICES)) {
      const { label, description } = splitLabel(bullet.text);
      if (!label) continue;
      choices.push({ label, ...(description ? { description } : {}), settled: false, recommended: false });
      raws.push(bullet.text);
      taken.add(bullet.contextIndex);
    }
    for (let i = contextLines.length - 1; i >= 0; i--) if (taken.has(i)) contextLines.splice(i, 1);
  }

  const kind: QuestionKind = choices.length === 0 || directiveKind === 'question-text'
    ? 'text'
    : directiveKind === 'question-multi' ? 'multi' : 'single';

  let suggestedText: string | undefined;
  if (recommendation) {
    const hits = kind === 'text' ? [] : matchRecommendation(recommendation, raws, choices, kind === 'multi');
    if (hits.length > 0) for (const hit of hits) choices[hit].recommended = true;
    else suggestedText = recommendation;
  }

  const context = contextLines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

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

/**
 * Every parseable question block of a document, in document order, numbered
 * from 1. Keys are de-duplicated with a `-2`, `-3`… suffix so two identical
 * prompts in one document never share an answer.
 */
export const indexQuestionBlocks = (blocks: ReadonlyArray<QuestionSourceBlock>): IndexedQuestion[] => {
  const out: IndexedQuestion[] = [];
  const seen = new Map<string, number>();
  for (const block of blocks) {
    if (block.type !== 'directive' || !isQuestionDirectiveKind(block.directiveKind)) continue;
    const parsed = parseQuestionBlock(block.directiveKind, block.content);
    if (!parsed) continue;
    const count = (seen.get(parsed.key) ?? 0) + 1;
    seen.set(parsed.key, count);
    const key = count === 1 ? parsed.key : `${parsed.key}-${count}`;
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
  /** Document line of the prompt when answered. */
  sourceLine?: number;
}

const cap = (value: string, max: number): string => (value.length > max ? value.slice(0, max) : value);

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
  if (v.sourceLine !== undefined && !(Number.isInteger(v.sourceLine) && (v.sourceLine as number) > 0)) return null;

  const selected = [...new Set((v.selected as string[])
    .map((s) => cap(s.trim(), MAX_QUESTION_CHOICE_LABEL_CHARS))
    .filter(Boolean))]
    .slice(0, MAX_QUESTION_CHOICES);
  const other = typeof v.other === 'string' ? cap(v.other, MAX_QUESTION_OTHER_CHARS) : '';
  const text = typeof v.text === 'string' ? cap(v.text, MAX_QUESTION_TEXT_CHARS) : '';
  const note = typeof v.note === 'string' ? cap(v.note, MAX_QUESTION_NOTE_CHARS) : '';
  return {
    v: 1,
    key: v.key,
    kind: v.kind,
    prompt: cap(v.prompt, MAX_QUESTION_PROMPT_CHARS),
    selected,
    ...(other.trim() ? { other } : {}),
    ...(text.trim() ? { text } : {}),
    ...(note.trim() ? { note } : {}),
    ...(v.skipped === true ? { skipped: true } : {}),
    ...(typeof v.sourceLine === 'number' ? { sourceLine: v.sourceLine } : {}),
  };
};

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
  prompt: cap(indexed.question.prompt, MAX_QUESTION_PROMPT_CHARS),
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
    out += 'Skipped\n';
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
  const reported = answers.filter((a) => !isQuestionAnswerEmpty(a));
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

When a decision needs the reviewer (a trade-off you cannot settle from the code or the conversation), write it as a question block. The reviewer answers in place, and the answers come back to you in an "Answers to your questions" section at the top of their feedback, with the questions they left open listed under "Unanswered".

\`\`\`markdown
:::question
Where should losing conflict versions be kept?

Last-write-wins silently drops the loser unless we keep it somewhere.

- [ ] Local only, purged after 30 days — cheap, no server change
- [ ] Server-side per user — survives reinstall, needs a retention policy
- [ ] Nowhere — accept silent loss for v1

Recommended: Local only, purged after 30 days
:::
\`\`\`

- \`:::question\` picks one choice, \`:::question-multi\` picks any number, \`:::question-text\` asks for free text (a block with no choices is free text too).
- The first line is the question. Other prose lines are context.
- Choices are task-list items: \`- [ ] label\`, optionally \`- [ ] label — why\`. The reviewer can always answer "Other", add a note, or skip.
- \`Recommended: <label>\` marks your recommendation. Text that matches no choice is offered as a suggested answer.
- \`- [x]\` means the choice is already settled. Use it when you resubmit: keep an answered question with the chosen choice checked, or remove the block and write the decision into the prose.
- Leave blank lines between the parts so the block also reads well on GitHub.
- Ask only what you cannot decide alone, and keep a round short (about 8 questions at most). Do not ask rhetorical questions or questions the codebase answers.
- Each answer comes back under its question (\`### Q2. <question> (line N)\`) as \`Answer: <choice>\`, marked \`(your recommendation)\` when the reviewer took yours, or as \`Other: …\`, free text in a quote, or \`Skipped\`, plus any \`Note:\`. A question you marked \`- [x]\` is settled and only comes back if the reviewer changed it or added a note.
`;
