/**
 * `#` tags (approval "board-hashtags"), the rules both sides read: which text
 * is a tag, which initiative it names, which one a message names (the last tag
 * that names one wins), and how a sent tag links. What regresses: an issue
 * ref (`#123`, `owner/repo#1`), a URL fragment or a tag in code read as a tag;
 * case, spaces or dashes making "Code review" two initiatives; a tag naming
 * nothing, or a deleted initiative, linking or moving a card.
 */
import { expect, test } from 'bun:test';
import { inboxHashtags, inboxInitiativeTag, inboxTaggedInitiative, type InboxInitiative } from '@plannotator/core/inbox-types';
import { filterInitiatives, findHashtagTrigger, initiativeHref, linkHashtags } from './hashtags';

const ini = (id: string, name: string, deleted = false): InboxInitiative =>
  ({ id, name, created_at: '', created_by: { kind: 'person' }, updated_at: '', deleted_at: deleted ? '2026-11-04T00:00:00Z' : null }) as InboxInitiative;
const SHAPE = ini('ini_shape', 'Shape');
const REVIEW = ini('ini_review', 'Code review');
const GONE = ini('ini_gone', 'Memory', true);
const ALL = [SHAPE, REVIEW, GONE];

test('what is a tag: issue refs, URL fragments, headings and code are not', () => {
  const text = 'See #Shape, #123, acme/web#12, https://x.dev/a#Shape, ##Shape, a#Shape, # Heading, `#Shape` and\n```\n#Shape\n```\n#code-review.';
  expect(inboxHashtags(text).map((t) => t.tag)).toEqual(['Shape', 'code-review']);
});

test('a tag names an initiative ignoring case, spaces and dashes; the last one that names a live one wins', () => {
  expect(inboxTaggedInitiative('#codereview', ALL)?.id).toBe(REVIEW.id);
  expect(inboxTaggedInitiative('#Code-Review', ALL)?.id).toBe(REVIEW.id);
  expect(inboxTaggedInitiative('#Shape then #CodeReview', ALL)?.id).toBe(REVIEW.id);
  // A tag naming nothing, or a deleted initiative, does not displace the last real one.
  expect(inboxTaggedInitiative('#Shape then #Nope and #Memory', ALL)?.id).toBe(SHAPE.id);
  expect(inboxTaggedInitiative('#Nope #Memory', ALL)).toBeNull();
  // A pick writes the name as one word.
  expect(inboxInitiativeTag('Code review')).toBe('#CodeReview');
});

test('a sent tag that names a live initiative links to the Board filtered to it; others stay text', () => {
  expect(linkHashtags('Part of #Shape, not #Nope or #Memory; `#Shape` in code.', ALL)).toBe(
    `Part of [#Shape](${initiativeHref(SHAPE.id)}), not #Nope or #Memory; \`#Shape\` in code.`,
  );
  // A tag already inside a markdown link is left alone.
  expect(linkHashtags('[#Shape](https://example.com)', ALL)).toBe('[#Shape](https://example.com)');
});

test('the picker opens on # at a word start and filters by key, names that start with it first', () => {
  expect(findHashtagTrigger('Ship #sh', 8)).toEqual({ start: 5, query: 'sh' });
  expect(findHashtagTrigger('#', 1)).toEqual({ start: 0, query: '' });
  expect(findHashtagTrigger('acme/web#1', 10)).toBeNull();
  expect(findHashtagTrigger('a#b', 3)).toBeNull();
  expect(filterInitiatives([REVIEW, SHAPE], 'e').map((i) => i.name)).toEqual(['Code review', 'Shape']);
  expect(filterInitiatives([REVIEW, SHAPE, ini('ini_ed', 'Editor')], 'e').map((i) => i.name)).toEqual(['Editor', 'Code review', 'Shape']);
  expect(filterInitiatives([REVIEW, SHAPE], 'zzz')).toEqual([]);
});
