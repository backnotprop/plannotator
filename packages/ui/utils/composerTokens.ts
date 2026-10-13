/**
 * The comment composer's TOKEN HIGHLIGHT LAYER, as pure ranges.
 *
 * A textarea cannot style substrings, so `CommentPopover` paints its text
 * through one mirrored, aria-hidden overlay rendered behind a
 * transparent-text textarea. That overlay used to know about exactly one kind
 * of token (skill references). It now paints a MERGED list of ranges produced
 * by one or more sources, so a second source (host `@` mentions) needs no
 * second overlay — two mirrored layers could never stay pixel-aligned with
 * each other, and only one of them could own the scroll sync.
 *
 * Everything here is pure: no DOM, no styling, no React. The component maps a
 * range to its span (that is where Tailwind classes and `data-*` attributes
 * live, so the class scanner still sees them); this module only decides WHICH
 * bytes are a token and which token wins when two sources claim the same
 * ones.
 */
import { mentionToken, type MentionPerson } from './mentions';
import type { SkillReferenceToken } from './skillReferences';

/** One highlighted span of the composer's text, half-open `[start, end)`. */
export type ComposerTokenRange =
  | {
      readonly kind: 'skill';
      readonly start: number;
      readonly end: number;
      readonly skill: SkillReferenceToken;
    }
  | {
      readonly kind: 'mention';
      readonly start: number;
      readonly end: number;
      readonly person: MentionPerson;
    };

/**
 * The skill-reference source: the positioned occurrences the autocomplete
 * already found, unchanged. Order, spans and duplicates are preserved — a
 * name referenced twice highlights twice.
 */
export function skillTokenRanges(
  tokens: readonly SkillReferenceToken[],
): ComposerTokenRange[] {
  return tokens.map((skill) => ({
    kind: 'skill',
    start: skill.start,
    end: skill.end,
    skill,
  }));
}

/**
 * The mention source: every occurrence of each tagged person's readable
 * `@Label` token in the text.
 *
 * Driven by the mention ID MODEL, never by a regex over arbitrary `@words`:
 * the people passed in are the ones the author actually picked and whose
 * token still survives (`survivingMentions`), so editing a byte of a token
 * un-chips it in the same breath as it untags the person: a chip follows the
 * body, never a stale pick. (The reported IDS can lag in one inherited case —
 * a label that is a prefix of another label — see HANDOFF § "Mention token
 * chips in the composer".)
 *
 * KNOWN, INHERITED LIMITATION: two people whose labels sanitize to the same
 * token are indistinguishable in a plain-text body, so the FIRST of them
 * listed owns every occurrence of it. That is the same first-match rule
 * `survivingMentions` applies to the ids; it renders a chip either way and
 * never throws.
 */
export function mentionTokenRanges(
  text: string,
  people: readonly MentionPerson[],
): ComposerTokenRange[] {
  const ranges: ComposerTokenRange[] = [];
  const claimed = new Set<string>();
  for (const person of people) {
    const token = mentionToken(person);
    // A person whose label sanitizes to nothing would make every bare `@` a
    // chip; and a token already claimed belongs to the person listed first.
    if (token.length <= 1 || claimed.has(token)) continue;
    claimed.add(token);
    let from = text.indexOf(token);
    while (from !== -1) {
      ranges.push({ kind: 'mention', start: from, end: from + token.length, person });
      from = text.indexOf(token, from + token.length);
    }
  }
  return ranges;
}

/**
 * The one list the overlay paints: every source's ranges, in document order,
 * with overlaps resolved DETERMINISTICALLY and stale ranges dropped.
 *
 * `groups` is in priority order (earlier wins a tie). The rules, applied in
 * this order at each position:
 *
 * 1. a range outside `[0, text.length)`, or empty/inverted, is dropped —
 *    these are ranges computed for a text the composer has since changed;
 * 2. earlier `start` wins;
 * 3. at the same start, the LONGER range wins (so `@Marcus Chen` beats a
 *    `@Marcus` that is also tagged, rather than chipping half of it);
 * 4. at the same start and length, the earlier group wins;
 * 5. a range that begins inside one already kept is dropped outright — the
 *    overlay is a sequence of non-overlapping spans and nothing may nest.
 *
 * With a single skill source this reproduces the pre-refactor loop exactly
 * (which dropped a token whose `start` fell behind the cursor or whose `end`
 * ran past the text); its ranges arrive sorted and non-overlapping, so rules
 * 2-5 never fire.
 */
export function mergeTokenRanges(
  text: string,
  groups: readonly (readonly ComposerTokenRange[])[],
): ComposerTokenRange[] {
  const candidates: { range: ComposerTokenRange; priority: number }[] = [];
  groups.forEach((group, priority) => {
    for (const range of group) {
      if (!Number.isInteger(range.start) || !Number.isInteger(range.end)) continue;
      if (range.start < 0 || range.end > text.length || range.end <= range.start) continue;
      candidates.push({ range, priority });
    }
  });
  candidates.sort(
    (a, b) =>
      a.range.start - b.range.start ||
      b.range.end - a.range.end ||
      a.priority - b.priority,
  );
  const merged: ComposerTokenRange[] = [];
  let pos = 0;
  for (const { range } of candidates) {
    if (range.start < pos) continue;
    merged.push(range);
    pos = range.end;
  }
  return merged;
}
