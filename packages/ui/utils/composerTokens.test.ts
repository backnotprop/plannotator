/**
 * The composer's token highlight ranges (DOM-free).
 *
 * What these catch: a chip painted over bytes that are no longer the token
 * (the caret would then drift from a highlight that means nothing), two
 * sources double-claiming the same bytes and producing nested or overlapping
 * spans, a stale range computed for an older text running past the end, and
 * the regression the merge exists to prevent — a single skill source no
 * longer behaving exactly like the pre-refactor loop.
 */
import { describe, expect, test } from 'bun:test';
import {
  mentionTokenRanges,
  mergeTokenRanges,
  skillTokenRanges,
  type ComposerTokenRange,
} from './composerTokens';
import type { MentionPerson } from './mentions';
import type { SkillCatalogEntry, SkillReferenceToken } from './skillReferences';

const person = (id: string, label: string): MentionPerson => ({
  id,
  kind: 'user',
  label,
  detail: null,
  canOpen: true,
});

const entry = (name: string, humanOnly = false): SkillCatalogEntry => ({
  name,
  root: 'claude',
  humanOnly,
});

const skill = (start: number, end: number, name: string): SkillReferenceToken => ({
  start,
  end,
  entry: entry(name),
});

/** The substrings the overlay actually paints, in document order. */
function painted(text: string, ranges: readonly ComposerTokenRange[]): string[] {
  return ranges.map((r) => text.slice(r.start, r.end));
}

function mentions(text: string, people: readonly MentionPerson[]): ComposerTokenRange[] {
  return mergeTokenRanges(text, [mentionTokenRanges(text, people)]);
}

describe('mentionTokenRanges', () => {
  test('one picked person chips exactly their token, not the words around it', () => {
    const text = 'Nice catch @Marcus Chen thanks';
    const ranges = mentions(text, [person('u1', 'Marcus Chen')]);
    expect(painted(text, ranges)).toEqual(['@Marcus Chen']);
    expect(ranges[0]!.start).toBe(11);
    expect(ranges[0]!.kind === 'mention' && ranges[0]!.person.id).toBe('u1');
  });

  test('several people, and the same person twice, each get their own chip', () => {
    const text = '@Dana Ruiz and @Marcus Chen and @Dana Ruiz again';
    const ranges = mentions(text, [person('u1', 'Marcus Chen'), person('u2', 'Dana Ruiz')]);
    expect(painted(text, ranges)).toEqual(['@Dana Ruiz', '@Marcus Chen', '@Dana Ruiz']);
    // Document order, whatever order the people were listed in.
    expect(ranges.map((r) => r.start)).toEqual([0, 15, 32]);
  });

  test('adjacent tokens stay two separate chips', () => {
    const text = '@Dana Ruiz@Marcus Chen';
    const ranges = mentions(text, [person('u1', 'Marcus Chen'), person('u2', 'Dana Ruiz')]);
    expect(painted(text, ranges)).toEqual(['@Dana Ruiz', '@Marcus Chen']);
    expect(ranges[0]!.end).toBe(ranges[1]!.start);
  });

  test('a token at the very start and one at the very end are both chipped', () => {
    const text = '@Dana Ruiz ping @Marcus Chen';
    const ranges = mentions(text, [person('u1', 'Marcus Chen'), person('u2', 'Dana Ruiz')]);
    expect(painted(text, ranges)).toEqual(['@Dana Ruiz', '@Marcus Chen']);
    expect(ranges[0]!.start).toBe(0);
    expect(ranges[1]!.end).toBe(text.length);
  });

  test('a deleted token is no longer a chip', () => {
    // The person is still in the list; the body no longer names them, which
    // is exactly what `survivingMentions` reports to the host.
    expect(mentions('never mind', [person('u1', 'Marcus Chen')])).toEqual([]);
  });

  test('editing one byte of a token un-chips it (no partial highlight)', () => {
    const text = 'Nice catch @Marcus Chn';
    expect(mentions(text, [person('u1', 'Marcus Chen')])).toEqual([]);
  });

  test('a longer label wins over a shorter one that is its prefix', () => {
    const text = 'ping @Marcus Chen now';
    const ranges = mentions(text, [person('u1', 'Marcus'), person('u2', 'Marcus Chen')]);
    expect(painted(text, ranges)).toEqual(['@Marcus Chen']);
    expect(ranges[0]!.kind === 'mention' && ranges[0]!.person.id).toBe('u2');
  });

  test('duplicate labels: the first person listed owns every occurrence', () => {
    const text = 'ping @Alex Kim and @Alex Kim';
    const ranges = mentions(text, [person('u1', 'Alex Kim'), person('u2', 'Alex Kim')]);
    expect(painted(text, ranges)).toEqual(['@Alex Kim', '@Alex Kim']);
    expect(ranges.every((r) => r.kind === 'mention' && r.person.id === 'u1')).toBe(true);
  });

  test('a label that sanitizes to nothing never chips a bare @', () => {
    const text = 'ping @ someone';
    expect(mentions(text, [person('u1', '   ')])).toEqual([]);
  });
});

describe('mergeTokenRanges with both sources', () => {
  const people = [person('u1', 'Marcus Chen')];

  test('skill and mention tokens coexist in document order', () => {
    const text = 'see $humanizer then ping @Marcus Chen';
    const ranges = mergeTokenRanges(text, [
      skillTokenRanges([skill(4, 14, 'humanizer')]),
      mentionTokenRanges(text, people),
    ]);
    expect(painted(text, ranges)).toEqual(['$humanizer', '@Marcus Chen']);
    expect(ranges.map((r) => r.kind)).toEqual(['skill', 'mention']);
  });

  test('when two sources claim the same bytes the first group wins, and nothing nests', () => {
    const text = 'ping @Marcus Chen';
    // A pathological skill token over the same span: priority decides.
    const ranges = mergeTokenRanges(text, [
      skillTokenRanges([skill(5, 17, 'anything')]),
      mentionTokenRanges(text, people),
    ]);
    expect(ranges.length).toBe(1);
    expect(ranges[0]!.kind).toBe('skill');
  });

  test('a range that begins inside a kept range is dropped, never nested', () => {
    const text = 'ping @Marcus Chen';
    const ranges = mergeTokenRanges(text, [
      mentionTokenRanges(text, people),
      skillTokenRanges([skill(7, 12, 'arcus')]),
    ]);
    expect(ranges.length).toBe(1);
    expect(ranges[0]!.kind).toBe('mention');
  });

  test('stale ranges for an older, longer text are dropped', () => {
    const text = 'short';
    const ranges = mergeTokenRanges(text, [skillTokenRanges([skill(2, 40, 'humanizer')])]);
    expect(ranges).toEqual([]);
  });

  test('empty, inverted and negative ranges are dropped', () => {
    const text = 'some text here';
    const ranges = mergeTokenRanges(text, [
      skillTokenRanges([skill(3, 3, 'a'), skill(6, 4, 'b'), skill(-2, 3, 'c')]),
    ]);
    expect(ranges).toEqual([]);
  });

  test('a single skill source reproduces the pre-refactor loop: in order, no dedupe', () => {
    const text = 'use $humanizer and $humanizer again';
    const tokens = [skill(4, 14, 'humanizer'), skill(19, 29, 'humanizer')];
    const ranges = mergeTokenRanges(text, [skillTokenRanges(tokens)]);
    expect(painted(text, ranges)).toEqual(['$humanizer', '$humanizer']);
    expect(ranges.map((r) => [r.start, r.end])).toEqual([
      [4, 14],
      [19, 29],
    ]);
  });

  test('no sources means no ranges', () => {
    expect(mergeTokenRanges('plain text', [])).toEqual([]);
    expect(mergeTokenRanges('plain text', [[], []])).toEqual([]);
  });
});
