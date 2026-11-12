import { mentionToken, type MentionPerson } from './mentions';
import type { SkillReferenceToken } from './skillReferences';

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

export function mentionTokenRanges(
  text: string,
  people: readonly MentionPerson[],
): ComposerTokenRange[] {
  const ranges: ComposerTokenRange[] = [];
  const claimed = new Set<string>();
  for (const person of people) {
    const token = mentionToken(person);
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
