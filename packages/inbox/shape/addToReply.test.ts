/**
 * A board's Add to reply: the reply's words for a box, and its Undo taking out only what that press added.
 */
import { expect, test } from 'bun:test';
import { shapeReplyFileName, shapeReplyWords, withoutReplyWords } from './addToReply';

test('several parts quote their words after the label; one part’s label already quotes its own', () => {
  expect(shapeReplyWords({ label: 'Picture · 3 parts', parts: ['a', 'b', 'c'], words: 'Google  DuckDuckGo\nBing' }, ' Make Kagi first. ')).toBe(
    '> Picture · 3 parts · “Google DuckDuckGo Bing”\n\nMake Kagi first.',
  );
  expect(shapeReplyWords({ label: 'Picture · “Save”', parts: ['save'], words: 'Save' }, '')).toBe('> Picture · “Save”');
  expect(shapeReplyWords({ parts: [], words: '' }, 'Only words.')).toBe('Only words.');
});

test('the file is named for the parts it shows, never a path', () => {
  expect(shapeReplyFileName({ parts: ['row-google', 'row-ddg'], view: 'picture' })).toBe('row-google-row-ddg.png');
  expect(shapeReplyFileName({ parts: [], view: 'know' })).toBe('know.png');
  expect(shapeReplyFileName({ parts: ['../x/y'], view: 'picture' })).toBe('..-x-y.png');
});

test('Undo takes out its own words, wherever they now sit, and keeps the rest', () => {
  const added = '> Picture · “Save”\n\nGrey it out.';
  expect(withoutReplyWords(`Hi.\n\n${added}`, added)).toBe('Hi.');
  expect(withoutReplyWords(`Hi.\n\n${added}\n\nAnd more after.`, added)).toBe('Hi.\n\nAnd more after.');
  expect(withoutReplyWords(added, added)).toBe('');
  expect(withoutReplyWords('Edited away.', added)).toBe('Edited away.');
});
