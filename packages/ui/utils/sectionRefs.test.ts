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

describe('headings whose rendered text differs from their markdown', () => {
  // A reader copies the heading off the page, not out of the source. Each row
  // is a heading whose two spellings diverge, and the comment as it would
  // actually be typed. Before both spellings were indexed, every one of these
  // rendered as plain text.
  const resolved = (headingText: string, comment: string) => {
    const index = buildSectionRefIndex([heading('b1', headingText)]);
    return parseSectionRefs(comment, index).filter((p) => typeof p !== 'string');
  };

  it.each([
    ['**Install** now', '#Install now', 'emphasis'],
    ['Setup `bun`', '#Setup bun', 'code span'],
    ['[Setup](./s.md) guide', '#Setup guide', 'link'],
    ['Part 1 --- end', '#Part 1 — end', 'smart punctuation'],
    [':rocket: Launch', '#🚀 Launch', 'emoji shortcode'],
  ])('%p referenced as %p resolves (%s)', (headingText, comment) => {
    expect(resolved(headingText as string, comment as string)).toHaveLength(1);
  });

  it('still resolves the raw markdown spelling', () => {
    // The panel is not the only writer — an agent quoting `/api/plan` sees the
    // source. Adding the rendered key must not cost the source key.
    expect(resolved('**Install** now', '#**Install** now')).toHaveLength(1);
  });

  it('drops a title two different headings both claim after stripping', () => {
    const index = buildSectionRefIndex([
      heading('b1', 'Install'),
      heading('b2', '**Install**'),
    ]);
    expect(index.has('Install')).toBe(false);
  });

  it('keeps a heading whose two spellings are identical', () => {
    // Registering the same anchor twice is one heading, not a collision.
    const index = buildSectionRefIndex([heading('b1', 'Overview')]);
    expect(index.get('Overview')).toBe('overview');
  });
});
