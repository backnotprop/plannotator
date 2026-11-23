/**
 * Lines that open raw HTML the sanitizer drops (`DROPPED_HTML_BLOCK_TAGS` in
 * @plannotator/core/markdown-structure) are HTML blocks, so they draw nothing
 * instead of printing their source, and their extent never crosses a blank
 * line.
 *
 * What regresses if these fail: such a line prints as a paragraph again; an
 * opener that is never closed swallows the rest of a message (an agent's
 * whole message hidden); a line that only starts with the tag and goes on in
 * prose disappears; a capitalised MDX/JSX component (`<Button>`, `<Form>`)
 * is taken for HTML and dropped; words the sanitizer keeps (a button's label,
 * an object's fallback) are dropped inline; a tag name that only looks like
 * one (`<scriptless>`), a fence or a list item changes; or the question-block
 * splitter (core) and this parser disagree about where a block ends.
 */
import { describe, expect, test } from 'bun:test';
import { findQuestionBlocks } from '@plannotator/core/question-block';
import { parseMarkdownToBlocks } from './parser';
import { inlineHtmlDrawsNothing, matchInlineHtml } from './inlineHtmlTags';

const shape = (md: string) => parseMarkdownToBlocks(md).map((b) => [b.type, b.content]);

describe('a line that opens raw HTML the sanitizer drops is an HTML block', () => {
  test.each([
    ['an iframe', '<iframe src="https://example.invalid/embed" width="100%" height="320"></iframe>'],
    ['a script', '<script>document.title = "ran"</script>'],
    ['a three-line style', '<style>\n.x { color: red; }\n</style>'],
    ['an iframe whose attributes run over four lines', '<iframe\n  src="https://example.invalid/m"\n  width="100%"\n  height="320"></iframe>'],
    ['a form', '<form action="https://example.invalid"><input name="q"><button>Go</button></form>'],
    ['an object', '<object data="https://example.invalid/x.pdf"></object>'],
    ['an embed', '<embed src="https://example.invalid/x.swf">'],
    ['an upper-case IFRAME', '<IFRAME src="https://example.invalid/u"></IFRAME>'],
    ['a self-closing iframe', '<iframe/>'],
    ['an svg', '<svg width="10" height="10"><circle r="4"/></svg>'],
  ])('%s', (_name, md) => {
    expect(shape(`Before.\n\n${md}\n\nAfter.`)).toEqual([
      ['paragraph', 'Before.'],
      ['html', md],
      ['paragraph', 'After.'],
    ]);
  });

  test('an iframe never closed is its own line only: what follows stays, with or without a blank line', () => {
    expect(shape('<iframe src="https://example.invalid/open">\n\nA normal paragraph that must stay.\n\n## Heading\n\nMore.')).toEqual([
      ['html', '<iframe src="https://example.invalid/open">'],
      ['paragraph', 'A normal paragraph that must stay.'],
      ['heading', 'Heading'],
      ['paragraph', 'More.'],
    ]);
    expect(shape('<iframe src="https://example.invalid/open">\nThe next line.')).toEqual([
      ['html', '<iframe src="https://example.invalid/open">'],
      ['paragraph', 'The next line.'],
    ]);
    // A close tag after a blank line does not pull the paragraphs between into the block.
    expect(shape('<script>\n\nWords in between.\n\n</script>')).toEqual([
      ['html', '<script>'],
      ['paragraph', 'Words in between.'],
      ['paragraph', '</script>'],
    ]);
  });

  test('prose that starts with a tag, a tag-like word, a fence and a list item stay what they were', () => {
    expect(shape('<script> tags are blocked by the policy.')).toEqual([['paragraph', '<script> tags are blocked by the policy.']]);
    expect(shape('<scriptless> stays text')).toEqual([['paragraph', '<scriptless> stays text']]);
    expect(shape('```html\n<iframe src="x"></iframe>\n```').map(([type]) => type)).toEqual(['code']);
    expect(shape('- <iframe src="x"></iframe> item').map(([type]) => type)).toEqual(['list-item']);
    expect(shape('<details><summary>More</summary>\n\n**text**\n\n</details>').map(([type]) => type)).toEqual(['html']);
  });

  test.each([
    '<iframe> embeds are not supported in pages.',
    '<form> lets you collect input.',
    '<style> blocks are ignored here.',
    '<svg> beats <canvas> for icons',
    '<script> tags never run here.',
    '<script> runs until </script> closes it, in prose.',
  ])('prose that starts with a tag name stays a paragraph: %s', (line) => {
    expect(shape(line)).toEqual([['paragraph', line]]);
  });

  test.each([
    '<Button>Go</Button>',
    '<Input placeholder="x" />',
    '<Form>\n  <Field name="q" />\n</Form>',
    '<Link href="/a">Docs</Link>',
    '<Select value="a"></Select>',
  ])('a capitalised MDX or JSX component stays what it was (a paragraph): %s', (md) => {
    expect(shape(md).map(([type]) => type)).toEqual(['paragraph']);
  });

  test('the question-block splitter sees the same blocks: a question after a dropped block is found', () => {
    const md = ['<iframe src="x">', '', ':::question', 'Ship it?', '- Yes', '- No', ':::'].join('\n');
    expect(findQuestionBlocks(md).length).toBe(1);
    // An unclosed opener on the line before cannot hide the question either.
    expect(findQuestionBlocks(['<script src="x">', ':::question', 'Ship it?', '- Yes', ':::'].join('\n')).length).toBe(1);
  });
});

describe('raw HTML inside a line', () => {
  test('sub, sup, kbd and mark with their close tag are elements; without one they are text', () => {
    expect(matchInlineHtml('<sub>2</sub>O')).toEqual({ kind: 'element', tag: 'sub', inner: '2', length: 12 });
    expect(matchInlineHtml('<KBD>Ctrl</KBD>')).toMatchObject({ kind: 'element', tag: 'kbd', inner: 'Ctrl' });
    expect(matchInlineHtml('<mark>unclosed')).toBeNull();
  });

  test('a dropped tag: with its content where that is code, its words kept where they are prose', () => {
    expect(matchInlineHtml('<iframe src="x"></iframe> here.')).toEqual({ kind: 'drop', length: 25 });
    expect(matchInlineHtml('<script>alert(1)</script>after')).toEqual({ kind: 'drop', length: 25 });
    expect(matchInlineHtml('<form action="x"><button>Go</button></form>')).toEqual({ kind: 'unwrap', inner: '<button>Go</button>', length: 43 });
    expect(matchInlineHtml('<iframe/> and on')).toEqual({ kind: 'drop', length: 9 });
    expect(matchInlineHtml('<embed src="x.swf"> and on')).toEqual({ kind: 'drop', length: 19 });
  });

  test('words the sanitizer keeps stay: a textarea\'s, an object\'s or a canvas\'s fallback, a button\'s label', () => {
    expect(matchInlineHtml('<textarea name="n">some words</textarea>')).toEqual({ kind: 'unwrap', inner: 'some words', length: 40 });
    expect(matchInlineHtml('<object data="x.pdf">[the PDF](x.pdf)</object>')).toMatchObject({ kind: 'unwrap', inner: '[the PDF](x.pdf)' });
    expect(matchInlineHtml('<canvas id="c">No canvas here.</canvas>')).toMatchObject({ kind: 'unwrap', inner: 'No canvas here.' });
    expect(matchInlineHtml('<button>Download</button>')).toMatchObject({ kind: 'unwrap', inner: 'Download' });
  });

  test('a capitalised component name is text: `<Button>`, `<Kbd>`, `<Script>`', () => {
    expect(matchInlineHtml('<Button>Go</Button>')).toBeNull();
    expect(matchInlineHtml('<Kbd>K</Kbd>')).toBeNull();
    expect(matchInlineHtml('<Script src="x" />')).toBeNull();
    // All capitals is HTML spelled loudly.
    expect(matchInlineHtml('<KBD>K</KBD>')).toMatchObject({ kind: 'element', tag: 'kbd' });
  });

  test('a close tag shown in a code span closes nothing; same-name tags nest', () => {
    // The `</script>` is in backticks: the opener is a bare mention, the words after it stay.
    expect(matchInlineHtml('<script> block: a `</script>` in it ends the script.')).toBeNull();
    expect(matchInlineHtml('<kbd> for keys, e.g. `<kbd>Ctrl</kbd>`')).toBeNull();
    expect(matchInlineHtml('<kbd><kbd>Ctrl</kbd>+<kbd>C</kbd></kbd> to copy')).toEqual({
      kind: 'element',
      tag: 'kbd',
      inner: '<kbd>Ctrl</kbd>+<kbd>C</kbd>',
      length: 39,
    });
    // A close in a later sentence, past a code span: not looked for there; the tag stays text.
    expect(matchInlineHtml('<sub>see the note. Run `make` first, then the rest.</sub> after')).toBeNull();
    // Backticks that open no code span (no closing run) are text, and do not stop the search.
    expect(matchInlineHtml('<kbd>`</kbd> is the backtick key')).toMatchObject({ kind: 'element', tag: 'kbd', inner: '`' });
  });

  test('a paragraph draws nothing when it holds only dropped HTML, HTML comments and white space', () => {
    expect(inlineHtmlDrawsNothing('<script>track()</script>')).toBe(true);
    expect(inlineHtmlDrawsNothing('<!-- analytics --><script>track()</script>')).toBe(true);
    expect(inlineHtmlDrawsNothing('<script>a()</script>\n<!-- x -->')).toBe(true);
    // A comment alone is not dropped HTML (the paragraph draws as before), and words still draw.
    expect(inlineHtmlDrawsNothing('<!-- x -->')).toBe(false);
    expect(inlineHtmlDrawsNothing('<!-- x --><script>a()</script> words')).toBe(false);
    // An unclosed comment is not skipped by InlineMarkdown: it is text.
    expect(inlineHtmlDrawsNothing('<!-- x <script>a()</script>')).toBe(false);
  });

  test('a bare mention, a look-alike word, a close tag alone and an autolink stay text', () => {
    expect(matchInlineHtml('<iframe> with a <video> element')).toBeNull();
    expect(matchInlineHtml('<scriptless> word')).toBeNull();
    expect(matchInlineHtml('</iframe> alone')).toBeNull();
    expect(matchInlineHtml('<https://example.invalid>')).toBeNull();
    expect(matchInlineHtml('<a@b.co>')).toBeNull();
  });
});
