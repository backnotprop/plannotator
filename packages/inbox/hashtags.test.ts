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
  expect(inboxTaggedInitiative('#Shape then #Nope and #Memory', ALL)?.id).toBe(SHAPE.id);
  expect(inboxTaggedInitiative('#Nope #Memory', ALL)).toBeNull();
  expect(inboxInitiativeTag('Code review')).toBe('#CodeReview');
});

test('a sent tag that names a live initiative links to the Board filtered to it; others stay text', () => {
  expect(linkHashtags('Part of #Shape, not #Nope or #Memory; `#Shape` in code.', ALL)).toBe(
    `Part of [#Shape](${initiativeHref(SHAPE.id)}), not #Nope or #Memory; \`#Shape\` in code.`,
  );
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

test('review fix 1: a tag after "(" or "[" links; only real link text or a link destination is left alone', () => {
  const shape = initiativeHref(SHAPE.id);
  expect(linkHashtags('Ship it (part of #Shape)', ALL)).toBe(`Ship it (part of [#Shape](${shape}))`);
  expect(linkHashtags('Ship it (#Shape)', ALL)).toBe(`Ship it ([#Shape](${shape}))`);
  expect(linkHashtags('[#Shape](https://example.com)', ALL)).toBe('[#Shape](https://example.com)');
  expect(linkHashtags('[part of #Shape](https://example.com)', ALL)).toBe('[part of #Shape](https://example.com)');
  expect(linkHashtags('[see](#Shape)', ALL)).toBe('[see](#Shape)');
  expect(inboxTaggedInitiative('Ship it (part of #Shape)', ALL)?.id).toBe(SHAPE.id);
  expect(inboxTaggedInitiative('[see](#Shape)', ALL)).toBeNull();
});

test('review fix 2: double-backtick code and a longer fence around a ``` fence hold no tag', () => {
  expect(inboxHashtags('Use ``#Shape`` here, and ``a ` #Shape`` too')).toEqual([]);
  const fenced = '````md\n```\n#Shape\n```\n````\nthen #Shape';
  expect(inboxHashtags(fenced).map((t) => t.start)).toEqual([fenced.lastIndexOf('#Shape')]);
  expect(linkHashtags('````md\n```\n#Shape\n```\n````', ALL)).toBe('````md\n```\n#Shape\n```\n````');
  expect(inboxHashtags('a `` b #Shape').map((t) => t.tag)).toEqual(['Shape']);
});

test('URLs hold no tag; a tag starts at a line start, after whitespace or opening punctuation', () => {
  expect(inboxHashtags('https://x.dev/?q=#Shape a-#Shape www.x.dev/#Shape <https://x.dev#Shape> x=#Shape')).toEqual([]);
  expect(inboxHashtags('**#Shape** "#Shape" (#Shape) [#Shape]\n#Shape').length).toBe(5);
  expect(inboxHashtags('見て（#Shape）と「#Shape」').map((t) => t.tag)).toEqual(['Shape', 'Shape']);
  expect(findHashtagTrigger('a-#sh', 5)).toBeNull();
  expect(findHashtagTrigger('(#sh', 4)).toEqual({ start: 1, query: 'sh' });
});

test('the picker offers only names that make a tag', () => {
  const odd = [ini('ini_n', '123'), ini('ini_p', '!!!'), SHAPE];
  expect(filterInitiatives(odd, '').map((i) => i.name)).toEqual(['Shape']);
});

// A reply reads its tags on the server's one thread, on every Send: a long run of letters must not stall the Inbox.
test('a long run of letters is read at once, a tag beside it or not, and a long scheme still holds no tag', () => {
  const run = 'x'.repeat(400_000);
  const at = performance.now();
  expect(inboxHashtags(run)).toEqual([]);
  expect(inboxHashtags(`#Shape ${run}`).map((t) => t.tag)).toEqual(['Shape']);
  expect(performance.now() - at).toBeLessThan(2000);
  expect(inboxHashtags(`${'x'.repeat(64)}://x.dev/#Shape`)).toEqual([]);
});
