import { describe, expect, it } from 'bun:test';
import { buildSectionRefIndex, parseSectionRefs } from './sectionRefs';

const heading = (id: string, content: string) => ({ id, type: 'heading', content });
const para = (id: string, content: string) => ({ id, type: 'paragraph', content });

const DOC = [
  heading('b1', 'Design notes'),
  heading('b2', '3.1 Single source of truth'),
  para('b3', 'body text'),
  heading('b4', 'Overview'),
];

describe('buildSectionRefIndex', () => {
  it('indexes headings by their exact text', () => {
    const index = buildSectionRefIndex(DOC);
    expect(index.get('3.1 Single source of truth')).toBe('3-1-single-source-of-truth');
    expect(index.has('body text')).toBe(false);
  });

  it('drops a title shared by two headings rather than picking one', () => {
    const index = buildSectionRefIndex([
      heading('b1', 'Overview'),
      heading('b2', 'Overview'),
      heading('b3', 'Conclusion'),
    ]);
    expect(index.has('Overview')).toBe(false);
    expect(index.has('Conclusion')).toBe(true);
  });

  it('keeps unicode headings addressable', () => {
    const index = buildSectionRefIndex([heading('b1', 'Café metrics')]);
    expect(index.get('Café metrics')).toBe('café-metrics');
  });
});

describe('parseSectionRefs', () => {
  const index = buildSectionRefIndex(DOC);

  it('links a reference and leaves what follows it outside the link', () => {
    // The match ends where the heading text ends, with no trailing word
    // boundary required. That is what lets a script without spaces between a
    // noun and its suffix reference a section at all; the cost is that
    // `#Overviewing` would resolve `Overview` and leave `ing`, which only
    // happens when someone typed `#` meaning a reference in the first place.
    const parts = parseSectionRefs("#3.1 Single source of truth's premise breaks", index);
    expect(parts).toEqual([
      { label: '3.1 Single source of truth', anchor: '3-1-single-source-of-truth' },
      "'s premise breaks",
    ]);
  });

  it('links several references in one comment', () => {
    const parts = parseSectionRefs('#Overview and #3.1 Single source of truth disagree', index);
    expect(parts.filter((p) => typeof p !== 'string')).toHaveLength(2);
  });

  it('takes the longest matching title', () => {
    const nested = buildSectionRefIndex([
      heading('a', '3.1'),
      heading('b', '3.1 Single source of truth'),
    ]);
    const parts = parseSectionRefs('#3.1 Single source of truth, see above', nested);
    expect(parts[0]).toEqual({
      label: '3.1 Single source of truth',
      anchor: '3-1-single-source-of-truth',
    });
  });

  it('leaves text that matches no heading alone', () => {
    expect(parseSectionRefs('#fff on issue #123', index)).toEqual(['#fff on issue #123']);
  });

  it('ignores a hash welded to a word', () => {
    const csharp = buildSectionRefIndex([heading('a', 'Overview')]);
    expect(parseSectionRefs('C#Overview notes', csharp)).toEqual(['C#Overview notes']);
  });

  it('ignores a hash followed by a space, which is markdown heading intent', () => {
    expect(parseSectionRefs('# Overview', index)).toEqual(['# Overview']);
  });

  it('does not resolve references inside code spans', () => {
    expect(parseSectionRefs('`#Overview` is code', index)).toEqual(['`#Overview` is code']);
  });

  it('returns the original text when the document has no headings', () => {
    expect(parseSectionRefs('#Overview', new Map())).toEqual(['#Overview']);
  });
});
