/**
 * A board's Add to reply: the reply's words for a box, and its Undo taking out only what that press added.
 */
import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { InlineMarkdown } from '@plannotator/ui/components/InlineMarkdown';
import { freeName, replyWordsCount,shapeReplyFileName, shapeReplyWords, withFreeName, withoutReplyWords } from './addToReply';

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

test('two presses with the same words: each Undo takes out its own press, not the other', () => {
  const added = '> Picture · “Save”';
  const first = `My own words first.\n\n${added}`;
  expect(replyWordsCount('My own words first.', added)).toBe(0);
  expect(replyWordsCount(first, added)).toBe(1);
  const both = `${first}\n\nTyped between.\n\n${added}`;
  // The first press's Undo (its words were the 0th): the second press's words and the words between stay.
  expect(withoutReplyWords(both, added, 0)).toBe(`My own words first.\n\nTyped between.\n\n${added}`);
  // The second press's (the 1st): the first press's words stay.
  expect(withoutReplyWords(both, added, 1)).toBe(`${first}\n\nTyped between.`);
  // Its words since changed or gone: nothing else is taken in their place.
  expect(withoutReplyWords(first, added, 1)).toBe(first);
});

test('a board’s words reach the reply as plain words: the Inbox’s markdown makes nothing of them', () => {
  // Every inline thing InlineMarkdown draws (a thread's message renders through it), each beside plain words.
  // In groups under the line's 80-character cut.
  for (const board of [
    'Run `rm` [here](https://x.test) ![a](b.png) [[wiki]]',
    '**bold** *it* _it_ ~~gone~~ $x^2$ \\(y\\) a\\b',
    '#fff #12 @bob https://bare.test/a',
    '<https://auto.test> <me@mail.test> <x:y> <!-- hid -->',
  ]) {
    const line = shapeReplyWords({ label: 'Picture · 2 parts', parts: ['a', 'b'], words: board }, '');
    expect(line.startsWith('> Picture · 2 parts · “')).toBe(true);
    const html = renderToStaticMarkup(createElement(InlineMarkdown, { text: line.slice(2) }));
    // No element at all: no link, code, emphasis, math, swatch or mention; the words themselves, all of them.
    expect(html).not.toContain('<');
    const shown = html.replace(/﻿/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;/g, "'");
    expect(shown).toBe(`Picture · 2 parts · “${board}”`);
  }
  // One part's label (its quoted words) the same.
  const one = shapeReplyWords({ label: 'Picture · “*Save* @bob”', parts: ['a'], words: '*Save* @bob' }, 'a `b`');
  expect(renderToStaticMarkup(createElement(InlineMarkdown, { text: one.split('\n')[0]!.slice(2) }))).not.toContain('<');
  // What was typed is the person's own markdown, kept as typed.
  expect(one.endsWith('\n\na `b`')).toBe(true);
});

test('a second picture of the same name is renamed, never replacing the first', () => {
  expect(freeName('row-a.png', ['other.png'])).toBe('row-a.png');
  expect(freeName('row-a.png', ['row-a.png'])).toBe('row-a-2.png');
  expect(freeName('row-a.png', ['row-a.png', 'row-a-2.png'])).toBe('row-a-3.png');
  expect(freeName('board', ['board'])).toBe('board-2');
  const file = new File(['x'], 'row-a.png', { type: 'image/png' });
  expect(withFreeName(file, ['other.png'])).toBe(file);
});
