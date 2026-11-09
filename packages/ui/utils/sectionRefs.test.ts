import { describe, expect, test } from 'bun:test';
import { buildSectionRefIndex, parseSectionRefs } from './sectionRefs';

const heading = (id: string, content: string) => ({ id, type: 'heading', content });

const DOC = [
  heading('b1', 'Overview'),
  heading('b2', '3.1 Single source of truth'),
  { id: 'b3', type: 'paragraph', content: 'Rollout' },
  heading('b4', '**Install** now'),
  heading('b5', 'Intro'),
  heading('b6', '개요'),
  heading('b7', 'Café'),
  heading('b8', "**Don't** ship"),
];
const index = buildSectionRefIndex(DOC);
const links = (text: string) => parseSectionRefs(text, index).filter((p) => typeof p !== 'string');

describe('parseSectionRefs', () => {
  test('links #<exact heading text> to the anchor the Viewer gives that heading', () => {
    expect(parseSectionRefs('see #3.1 Single source of truth, then ship', index)).toEqual([
      'see ',
      { label: '3.1 Single source of truth', anchor: '3-1-single-source-of-truth' },
      ', then ship',
    ]);
  });

  test('links several references in one comment', () => {
    expect(links('#Overview contradicts #Intro.')).toHaveLength(2);
  });

  test('matches the heading text the page shows, and its markdown source', () => {
    expect(links('#Install now')).toEqual([{ label: 'Install now', anchor: 'install-now' }]);
    expect(links('#**Install** now')).toHaveLength(1);
  });

  test.each([
    ['an issue number', 'fixed in #123'],
    ['a tag with no such heading', 'tagging #todo and #fff'],
    ['a different case', '#overview'],
    ['a paragraph, not a heading', '#Rollout'],
    ['a markdown heading in the comment', '# Overview'],
    ['a deeper markdown heading', '## Overview'],
    ['a URL fragment', 'https://example.com/docs#Overview'],
    ['a URL fragment after a slash', 'https://example.com/#Overview'],
    ['a hash welded to a word', 'C#Overview'],
    ['a code span', 'run `#Overview` here'],
    ['a longer word that starts with a heading title', '#Introduction'],
    ['a longer accented word that starts with a heading title', '#Cafés'],
  ])('leaves %s as plain text', (_, text) => {
    expect(parseSectionRefs(text, index)).toEqual([text]);
  });

  test('a heading with markdown and a straight quote matches as typed', () => {
    expect(links("#Don't ship")).toEqual([{ label: "Don't ship", anchor: 'don-t-ship' }]);
    expect(links('#Café, then')).toHaveLength(1);
  });

  test('a stray backtick does not switch links off for the rest of the comment', () => {
    expect(links('the ` key, see #Overview')).toHaveLength(1);
  });

  test('a suffix in a script without spaces stays outside the link', () => {
    expect(parseSectionRefs('#개요에서 보면', index)).toEqual([
      { label: '개요', anchor: '개요' },
      '에서 보면',
    ]);
  });

  test('takes the longest heading title that matches', () => {
    const nested = buildSectionRefIndex([heading('a', '3.1'), heading('b', '3.1 Scope')]);
    expect(parseSectionRefs('#3.1 Scope', nested)).toEqual([{ label: '3.1 Scope', anchor: '3-1-scope' }]);
  });

  test('a title shared by two headings links to neither', () => {
    const dup = buildSectionRefIndex([heading('a', 'Notes'), heading('b', 'Notes'), heading('c', 'End')]);
    expect(parseSectionRefs('#Notes', dup)).toEqual(['#Notes']);
    expect(parseSectionRefs('#End', dup)).toHaveLength(1);
  });

  test('nothing links in a document without headings', () => {
    expect(parseSectionRefs('#Overview', new Map())).toEqual(['#Overview']);
  });
});
