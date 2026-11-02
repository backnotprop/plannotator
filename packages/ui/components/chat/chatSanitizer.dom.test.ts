/**
 * The sanitizer really running, with the folder's own allowlist, over the bridges
 * in `tests/helpers/chat-sanitizer-dom.ts`. The spec in
 * `tests/e2e/chat-window.spec.ts` proves the same text in Chromium.
 * Requires DOM (DOM_TESTS=1).
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { Lexer } from 'marked';
import { bridgeSanitizerDom } from '../../../../tests/helpers/chat-sanitizer-dom';
import type * as Markdown from './chatMarkdown';

const hasDom = typeof document !== 'undefined';
let chatMarkdownHtml: typeof Markdown.chatMarkdownHtml;
let personMarkdownHtml: typeof Markdown.personMarkdownHtml;
let chatTextRenderer: typeof Markdown.chatTextRenderer;
let unbridge: (() => void) | undefined;

beforeAll(async () => {
  if (!hasDom) return;
  unbridge = bridgeSanitizerDom();
  ({ chatMarkdownHtml, personMarkdownHtml, chatTextRenderer } = await import('./chatMarkdown'));
  // The sanitizer proves itself on first use, so that has to happen with the walk in place.
  chatMarkdownHtml('first use');
});

afterAll(() => unbridge?.());

function parsed(html: string) {
  const host = document.createElement('div');
  host.innerHTML = html;
  return host;
}

function attributesIn(html: string) {
  return [...parsed(html).querySelectorAll('*')].flatMap((el) => el.getAttributeNames());
}

/** Run with the clock held still, so the time budget cannot be what a test sees:
 * runtimes differ by a hundred times on this parse. */
function withStoppedClock<Result>(run: () => Result): Result {
  const clock = spyOn(Date, 'now').mockReturnValue(Date.now());
  try {
    return run();
  } finally {
    clock.mockRestore();
  }
}

/** Run with every look at the clock a second later, so the budget is gone at once. */
function withBudgetGone<Result>(run: () => Result): Result {
  let now = 0;
  const clock = spyOn(Date, 'now').mockImplementation(() => (now += 1_000));
  try {
    return run();
  } finally {
    clock.mockRestore();
  }
}

const bothRoles = [
  ['an agent', (text: string) => chatMarkdownHtml(text)],
  ['a person', (text: string) => personMarkdownHtml(text)],
] as const;

describe.if(hasDom)('what agent text can write into a host\'s page', () => {
  test('a link cannot be placed over the page: raw HTML is words, not a link', () => {
    const view = parsed(chatMarkdownHtml('<a href="https://evil.test/phish" class="fixed inset-0 z-50">x</a>'));
    expect(view.querySelector('a')).toBeNull();
    expect(view.textContent).toContain('class="fixed inset-0 z-50"');
  });

  test.each([
    ['a title', '[x](https://example.test "a title")', ['href', 'rel', 'target']],
    ['a code block\'s language', '```ts\nconst x = 1;\n```\n', []],
    ['a list\'s start', '3. three\n4. four\n', []],
  ])('of what markdown itself writes, %s does not pass the allowlist', (_name, text, kept) => {
    expect([...new Set(attributesIn(chatMarkdownHtml(text)))].sort()).toEqual(kept);
  });

  test.each([
    ['an image', '![tracker](https://evil.test/pixel.png)', 'img'],
    ['a task box', '- [ ] task\n', 'input'],
  ])('%s from markdown is taken out', (_name, text, tag) => {
    expect(parsed(chatMarkdownHtml(text)).querySelector(tag)).toBeNull();
  });

  test('a heading dressed as a host dialog loses its classes and keeps its words', () => {
    const html = chatMarkdownHtml('<h1 class="fixed inset-0 z-50" style="top:0">Your session expired</h1>');
    expect(attributesIn(html)).toEqual([]);
    expect(parsed(html).textContent).toContain('Your session expired');
  });

  test('it cannot forge the attributes a host or this folder reads', () => {
    const html = chatMarkdownHtml(
      '<p data-text-part="" data-message-id="u1" data-message-role="user" data-part-index="0" data-annotatable="true" data-chat-window data-chat-launcher aria-hidden="true" id="root">forged</p>',
    );
    expect(attributesIn(html)).toEqual([]);
    expect(parsed(html).textContent).toContain('forged');
  });

  test.each([
    ['script', '<script>alert(1)</script>'],
    ['a handler', '<p onclick="alert(1)">x</p>'],
    ['an image', '<img src="https://evil.test/pixel.png" onerror="alert(1)">'],
    ['a frame', '<iframe src="about:blank"></iframe>'],
    ['a form', '<form action="https://evil.test"><input name="a"></form>'],
    ['a stylesheet', '<style>body { display: none }</style>'],
    ['svg', '<svg onload="alert(1)"></svg>'],
    ['base', '<base href="https://evil.test/">'],
  ])('%s does not come through', (_name, input) => {
    const view = parsed(chatMarkdownHtml(input));
    expect(view.querySelector('script, img, iframe, form, input, style, svg, base')).toBeNull();
    expect(attributesIn(view.innerHTML)).toEqual([]);
  });

  test.each(bothRoles)('a javascript: link from %s has no href', (_who, render) => {
    expect(parsed(render('[x](javascript:alert(1))')).querySelector('a[href]')).toBeNull();
  });
});

describe.if(hasDom)('links', () => {
  test.each(bothRoles)('from %s open in a new tab, away from the host', (_who, render) => {
    const link = parsed(render('[the docs](https://example.test/docs)')).querySelector('a')!;
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });

  test('a raw link is not a link, so it cannot choose how it opens', () => {
    const view = parsed(chatMarkdownHtml('<a href="https://x.test" target="_self" rel="opener">x</a>'));
    expect(view.querySelector('a')).toBeNull();
  });
});

describe.if(hasDom)('raw HTML in an answer', () => {
  const openTags = (tag: string, count: number) =>
    Array.from({ length: count }, (_, index) => `<${tag} a=${index}>`).join('');
  const rebuilt = (tag: string, open: number, paragraphs: number) =>
    `<div>${openTags(tag, open)}</div>${'<p>x</p>'.repeat(paragraphs)}`;

  // Each of these builds a huge DOM from a short string, inside the sanitizer.
  test.each([
    ['open formatting tags rebuilt in each paragraph, 27 KB', rebuilt('strong', 300, 3_000)],
    ['the same, 92 KB', rebuilt('strong', 1_000, 10_000)],
    ['nested links', `<div>${'<a href=x><div>'.repeat(15_000)}`],
    ['unknown tags', `<div>${'<x>'.repeat(80_000)}`],
    ['nested tables', `<div>${'<table><tr><td>'.repeat(15_000)}`],
    ['svg titles', `<div>${'<svg><title>'.repeat(18_000)}`],
  ])('%s is words on the page, and never an element', (_name, text) => {
    const html = chatMarkdownHtml(text);
    expect(html).not.toMatch(/<(strong|div|table|svg|x)\b/);
    expect(parsed(html).querySelector('strong, a, table, div')).toBeNull();
    expect(parsed(html).textContent!.length).toBeGreaterThan(0);
  });

  test('inline and block alike keep their words', () => {
    const view = parsed(chatMarkdownHtml('See <kbd>Cmd</kbd> **now**\n\n<details>\n<summary>more</summary>\n</details>\n'));
    expect(view.querySelector('strong')?.textContent).toBe('now');
    expect(view.textContent).toContain('<kbd>Cmd</kbd>');
    expect(view.textContent).toContain('<summary>more</summary>');
  });

  test.each([['<br>'], ['<br/>'], ['<br />'], ['<BR>']])('%s in a table cell stays a line break', (tag) => {
    const view = parsed(chatMarkdownHtml(`| a |\n| - |\n| one${tag}two |\n`));
    expect(view.querySelector('td br')).not.toBeNull();
    expect(view.textContent).not.toContain('<');
  });

  test('a line break tag cannot carry anything with it', () => {
    const view = parsed(chatMarkdownHtml('one<br onclick="alert(1)">two'));
    expect(view.querySelector('br')).toBeNull();
    expect(view.textContent).toContain('onclick');
  });

  // A tag `marked` cannot read is text to it, and a real tag to a browser.
  const unreadable = (open: number) =>
    Array.from({ length: open }, (_, index) => `<strong !a${index}>`).join('');
  const rawOpeners = ['<code>', '<kbd>', '<pre>', '<script>'];

  test.each(rawOpeners)('text after an inline %s stays text, for either role', (opener) => {
    for (const render of [chatMarkdownHtml, personMarkdownHtml]) {
      const view = parsed(render(`x ${opener}${unreadable(300)}${'<p !>x'.repeat(3_000)}`));
      expect(view.querySelector('strong')).toBeNull();
      expect(view.querySelectorAll('p').length).toBe(1);
    }
  });

  test('so does text in the paragraphs after it', () => {
    const view = parsed(chatMarkdownHtml(`x <code>\n\n${'<a href=x !><div !>'.repeat(300)}\n\n<svg !><title !>`));
    expect(view.querySelector('a, div, svg')).toBeNull();
  });

  test.each([
    ['Wrap it in a <code> element. The loop runs while i<n and j<m holds. These last words matter.'],
    ['Use <kbd> for keys. Compare a<b here, then the rest of this sentence.'],
    ['The <pre> tag keeps spaces. Generics like Map<string, number> and x<y stay.'],
  ])('no word goes missing after a tag: %s', (text) => {
    expect(parsed(chatMarkdownHtml(text)).textContent!.trim()).toBe(text);
  });

  test('markdown after an inline tag is still markdown, and marks in a code span stay', () => {
    const view = parsed(chatMarkdownHtml('A <code> tag, **bold**, `a<b`, and a &amp; b'));
    expect(view.querySelector('strong')?.textContent).toBe('bold');
    expect(view.querySelector('code')?.textContent).toBe('a<b');
    expect(view.textContent).toContain('a & b');
  });

  test('blocks of it stay blocks, so they cannot run together into one', () => {
    const view = parsed(chatMarkdownHtml('<div>one</div>\n\n<div>two</div>\n\n<div>three</div>\n'));
    expect(view.querySelectorAll('p').length).toBe(3);
  });

  test('a person\'s line break stays the text they typed', () => {
    const view = parsed(personMarkdownHtml('one<br>two'));
    expect(view.querySelector('br')).toBeNull();
    expect(view.textContent).toContain('<br>');
  });
});

describe.if(hasDom)('what stays', () => {
  test('the markdown an answer uses still draws', () => {
    const view = parsed(
      chatMarkdownHtml(
        '## Title\n\n**bold** and `code`\n\n- one\n- two\n\n> quoted\n\n| a | b |\n|:--|--:|\n| 1 | 2 |\n\n```ts\nconst x = 1;\n```\n',
      ),
    );
    for (const tag of ['h2', 'strong', 'code', 'ul', 'li', 'blockquote', 'table', 'th', 'td', 'pre']) {
      expect(view.querySelector(tag)).not.toBeNull();
    }
    expect(view.querySelector('th')?.getAttribute('align')).toBe('left');
  });

  test('a person\'s HTML stays the text they typed', () => {
    const view = parsed(personMarkdownHtml('See <b>this</b>'));
    expect(view.querySelector('b')).toBeNull();
    expect(view.textContent).toContain('<b>this</b>');
  });
});

describe.if(hasDom)('text that would stop the page', () => {
  const makers = [
    ['"> " nested past the stack', (n: number) => '> '.repeat(n)],
    ['"- " nested past the stack', (n: number) => `${'- '.repeat(n)}x`],
    ['"1. " nested past the stack', (n: number) => `${'1. '.repeat(n)}x`],
    ['">" in a row', (n: number) => '>'.repeat(n)],
  ] as const;

  const cases = (size: number) =>
    makers.flatMap(([name, make]) =>
      bothRoles.map(([who, render]) => [`${name}, from ${who}`, make(size), render] as const),
    );

  // Around where V8's stack gives out. A bigger stack parses these, as empty
  // quotes where there are no words, so the promise here is only that nothing throws.
  test.each(cases(2_000))('%s, near the limit, does not throw', (_name, text, render) => {
    expect(typeof render(text)).toBe('string');
  });

  test.each(cases(100_000))('%s, far past it, comes out as text', (_name, text, render) => {
    expect(parsed(render(text)).textContent!.trim().length).toBeGreaterThan(0);
  });

  test.each([
    ['one long word before an @', 'a'.repeat(200_000) + '@'],
    ['a www run', `www.a${'_'.repeat(200_000)}`],
    ['inline markers', '_a'.repeat(100_000)],
    ['code ticks', '`a'.repeat(100_000)],
    ['spaced inline markers', '*a '.repeat(70_000)],
    ['spaced nested lists', '- '.repeat(100_000)],
  ])('%s does not hang: it goes out as text', (_name, text) => {
    const started = performance.now();
    const view = parsed(chatMarkdownHtml(text));
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(view.textContent!.length).toBeGreaterThan(0);
  });

  const table = (columns: number, rows: number) =>
    `${'| a '.repeat(columns)}|\n${'| - '.repeat(columns)}|\n${'x\n'.repeat(rows)}`;

  // A wide header and many short rows: `marked` pads each row to the header's
  // width in one call, so nothing inside it can stop this. Small messages, too.
  test.each([
    ['1M cells in 8 KB', table(500, 2_000)],
    ['2M cells in 11 KB', table(800, 2_500)],
    ['72M cells in 70 KB', table(6_000, 12_000)],
    // Large enough that only the check before `marked` keeps it under the time below.
    ['21M cells split by a lone carriage return', table(3_000, 7_000).replaceAll('\n', '\r')],
    ['rows split by CRLF', table(500, 2_000).replaceAll('\n', '\r\n')],
    ['inside a quote', table(500, 2_000).replaceAll(/^/gm, '> ')],
  ])('a table of %s goes out as text before it is built', (_name, text) => {
    const started = performance.now();
    const html = chatMarkdownHtml(text);
    expect(performance.now() - started).toBeLessThan(500);
    expect(html).not.toContain('<td');
    expect(parsed(html).textContent!.length).toBeGreaterThan(0);
  });

  test('an ordinary table stays a table', () => {
    const view = parsed(withStoppedClock(() => chatMarkdownHtml(table(30, 1_000))));
    expect(view.querySelectorAll('tbody tr').length).toBe(1_000);
  });

  test('a table past the limit leaves the rest of the message formatted', () => {
    const view = parsed(chatMarkdownHtml(`## Result\n\n${table(500, 2_000)}\n**after**\n`));
    expect(view.querySelector('h2')?.textContent).toBe('Result');
    expect(view.querySelector('td')).toBeNull();
    expect(view.querySelector('strong')?.textContent).toBe('after');
  });

  test('the budget still runs out while a link is drawn, after the tokens are done', () => {
    let tokensDone = false;
    const realLex = Lexer.prototype.lex;
    const lex = spyOn(Lexer.prototype, 'lex').mockImplementation(function (this: Lexer, src: string) {
      const tokens = realLex.call(this, src);
      tokensDone = true;
      return tokens;
    });
    const clock = spyOn(Date, 'now').mockImplementation(() => (tokensDone ? 1_000_000 : 0));
    try {
      expect(chatMarkdownHtml('[a](https://a.test)')).not.toContain('<a ');
      tokensDone = false;
      expect(chatMarkdownHtml('![a](https://a.test)')).toContain('![a]');
    } finally {
      clock.mockRestore();
      lex.mockRestore();
    }
  });

  test.each([
    ['repeated 5,000 times', `[a]: https://example.test/${'a'.repeat(7_900)}\n\n${'[a] '.repeat(5_000)}`],
    ['with an address past any word limit', `[a]: <https://example.test/${'a'.repeat(200_000)}>\n\n${'[a] '.repeat(100)}`],
  ])('a reference link %s is not written out in full', (_name, text) => {
    const html = withStoppedClock(() => chatMarkdownHtml(text));
    expect(html.length).toBeLessThan(text.length * 2);
    expect(html).not.toContain('<a ');
  });

  test('past the limit the words are all there, line by line, and none of it is HTML', () => {
    const text = `<img src=x onerror=alert(1)>\n${'x'.repeat(300_000)}\nlast`;
    const html = chatMarkdownHtml(text);
    expect(html).not.toContain('<img');
    expect(parsed(html).querySelectorAll('br').length).toBe(2);
    expect(parsed(html).textContent).toContain('<img src=x onerror=alert(1)>');
  });

  test('plain text draws a bounded number of line breaks, and loses no words', () => {
    const html = chatMarkdownHtml('x\n'.repeat(300_000));
    const view = parsed(html);
    expect(view.querySelectorAll('br').length).toBe(20_000);
    expect(view.textContent!.replaceAll(/\s/g, '').length).toBe(300_000);
  });

  test.each([
    ['a lone carriage return', 'a\rb\rc'],
    ['CRLF', 'a\r\nb\r\nc'],
    ['a line feed', 'a\nb\nc'],
  ])('plain text keeps its lines on %s', (_name, lines) => {
    const html = chatMarkdownHtml(`${lines}${'x'.repeat(300_000)}`);
    expect(parsed(html).querySelectorAll('br').length).toBe(2);
  });

  test('a message after one of these draws as usual, and a long honest one stays markdown', () => {
    chatMarkdownHtml('> '.repeat(100_000));
    chatMarkdownHtml('_a'.repeat(100_000));
    expect(chatMarkdownHtml('**fine**')).toContain('<strong>fine</strong>');
    const longAnswer = 'A sentence with **weight** and `code` in it.\n\n'.repeat(1_000);
    const html = withStoppedClock(() => chatMarkdownHtml(longAnswer));
    expect(parsed(html).querySelectorAll('strong').length).toBe(1_000);
  });
});

describe.if(hasDom)('a long line in an ordinary message', () => {
  const intro = '## Result\n\nThe **cause**:\n\n- one\n\n';

  test.each([
    ['a fence holding minified JSON', `${intro}\`\`\`json\n{"k":"${'a'.repeat(8_100)}"}\n\`\`\`\n`],
    ['a tilde fence', `${intro}~~~\n${'b'.repeat(200_000)}\n~~~\n`],
    ['a fence still open, mid-stream', `${intro}\`\`\`\n${'c'.repeat(8_100)}`],
    ['an indented code block', `${intro}    ${'d'.repeat(8_100)}\n`],
    ['a long URL', `${intro}See https://example.test/${'e'.repeat(8_100)} for it.\n`],
    ['a paragraph of Chinese with no spaces', `${intro}${'这是一个很长的段落。'.repeat(810)}\n`],
  ])('%s leaves the rest of the message formatted', (_name, text) => {
    const view = parsed(withStoppedClock(() => chatMarkdownHtml(text)));
    for (const tag of ['h2', 'strong', 'li']) expect(view.querySelector(tag)).not.toBeNull();
  });

  const prose = 'A line of ordinary prose.\n'.repeat(90);
  test.each([
    ['a fenced line of pipes', `\`\`\`\n${'|'.repeat(1_200)}\n\`\`\`\n`],
    ['fenced minified code', `\`\`\`js\n${'a||b;'.repeat(4_200)}\n\`\`\`\n`],
    ['a fenced delimiter row', `\`\`\`\n${'|-'.repeat(5_000)}\n${'row\n'.repeat(500)}\`\`\`\n`],
    ['a line of pipes in prose', `${'|'.repeat(1_200)}\n`],
  ])('%s with many lines around it leaves the message formatted', (_name, text) => {
    const view = parsed(withStoppedClock(() => chatMarkdownHtml(`## Title\n\n**bold**\n\n${prose}\n${text}`)));
    expect(view.querySelector('h2')?.textContent).toBe('Title');
    expect(view.querySelector('strong')?.textContent).toBe('bold');
  });

  test('a run of spaces past the limit is literal text, and the rest stays formatted', () => {
    const view = parsed(chatMarkdownHtml(`**held**${' '.repeat(1_100)}word\n\n**next**`));
    expect(view.querySelector('p')?.textContent).toContain('**held**');
    expect(view.querySelector('strong')?.textContent).toBe('next');
  });

  test('a long line stays whole in its code block', () => {
    const line = 'a'.repeat(8_100);
    const view = parsed(withStoppedClock(() => chatMarkdownHtml(`\`\`\`\n${line}\n\`\`\`\n`)));
    expect(view.querySelector('pre code')?.textContent).toContain(line);
  });

  test('a run with a long word goes out as its own literal text', () => {
    const word = 'a'.repeat(8_100);
    const view = parsed(chatMarkdownHtml(`<b>x</b> **y** ${word}\n\n**next**`));
    expect(view.querySelector('p')?.textContent).toContain(`<b>x</b> **y** ${word}`);
    expect(view.querySelector('b')).toBeNull();
    expect(view.querySelector('strong')?.textContent).toBe('next');
  });

  // With the clock stopped the budget cannot end these, so only the limit on
  // the work before the first token can leave them as their own text.
  test.each([
    ['escapes', '\\* '.repeat(85_000), '\\*'],
    ['code spans', '`a` '.repeat(60_000), '`a`'],
    ['tags', '<a> '.repeat(60_000), '<a>'],
  ])('a paragraph of nothing but %s is literal text', (_name, text, literal) => {
    const view = parsed(withStoppedClock(() => chatMarkdownHtml(text)));
    expect(view.querySelector('code')).toBeNull();
    expect(view.textContent).toContain(literal);
  });

  test('a paragraph with ordinary marks in it stays formatted', () => {
    const view = parsed(withStoppedClock(() => chatMarkdownHtml('see `a` and [b](https://b.test) '.repeat(500))));
    expect(view.querySelectorAll('code').length).toBe(500);
    expect(view.querySelectorAll('a').length).toBe(500);
  });

  test('Chinese keeps its own inline formatting', () => {
    const view = parsed(withStoppedClock(() => chatMarkdownHtml(`${'段落'.repeat(4_100)}**粗体**${'段落'.repeat(10)}`)));
    expect(view.querySelector('strong')?.textContent).toBe('粗体');
  });

  test.each([
    ['a fence an HTML block swallows', `<div>\n\`\`\`\n\n${'a'.repeat(200_000)}@\n`],
    ['a fence in a comment', `<!-- \`\`\` -->\n\n${'a'.repeat(200_000)}@\n`],
    ['an @ run split by other letters', `${'a字'.repeat(100_000)}@`],
    ['escapes split by other letters', '\\*字'.repeat(60_000)],
    ['a heading', `# ${'a'.repeat(200_000)}@`],
    ['a table cell', `| a |\n| - |\n| ${'a'.repeat(200_000)}@ |\n`],
    ['a list item', `- ${'a'.repeat(200_000)}@`],
    ['a quote', `> ${'a'.repeat(200_000)}@`],
    ['bold', `**${'a'.repeat(200_000)}@**`],
  ])('a long word in %s is still caught', (_name, text) => {
    const started = performance.now();
    const view = parsed(chatMarkdownHtml(text));
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(view.textContent!.length).toBeGreaterThan(0);
  });
});

describe.if(hasDom)('one block too costly to lay out', () => {
  const mixed = (chars: number) => 'سa'.repeat(chars / 2);
  /** The most characters past ASCII in any one block of what is drawn. */
  const widestBlock = (html: string) => {
    const view = parsed(html);
    const blocks = [...view.querySelectorAll('p, pre')];
    expect(blocks.length).toBeGreaterThan(0);
    return Math.max(...blocks.map((block) => block.textContent!.replace(/[\x00-\x7e]/g, '').length));
  };

  test.each([
    ['one long line', `## Title\n\n**bold**\n\n${mixed(30_000)}`],
    ['soft wrapped lines', `${Array.from({ length: 400 }, () => mixed(80)).join('\n')}`],
    ['a code block', `\`\`\`\n${mixed(30_000)}\n\`\`\`\n`],
    ['a code block of short lines', `\`\`\`\n${Array.from({ length: 400 }, () => mixed(80)).join('\n')}\n\`\`\`\n`],
    ['a block of raw HTML', `<div>${mixed(30_000)}</div>\n`],
    ['a heading', `# ${mixed(30_000)}`],
    ['past the length limit', mixed(300_000)],
    ['past the length limit, in lines past the break limit', `${'\n'.repeat(21_000)}${mixed(300_000)}`],
  ])('%s draws in small blocks, with every word', (_name, text) => {
    const html = chatMarkdownHtml(text);
    expect(widestBlock(html)).toBeLessThan(5_000);
    expect(parsed(html).textContent!.replace(/\s/g, '')).toContain(mixed(4_000));
  });

  test('blocks past the limit keep their characters whole', () => {
    const text = '😀a'.repeat(100_000);
    expect(parsed(chatMarkdownHtml(text)).textContent!.replace(/\s/g, '')).toBe(text);
  });

  // WebKit takes minutes over a word with no place to break.
  test.each([
    ['in a paragraph', 'سa'.repeat(2_000), 'p'],
    ['in a code span', `\`${'سa'.repeat(2_000)}\``, 'code'],
    ['in a link', `[${'سa'.repeat(2_000)}](https://example.test)`, 'a'],
    ['in a table cell', `| a |\n| - |\n| ${'سa'.repeat(2_000)} |\n`, 'td'],
    ['in raw HTML', `<div>${'سa'.repeat(2_000)}</div>\n`, 'p'],
    ['past the literal limit', `${'a'.repeat(9_000)} **b**`, 'p'],
    ['in plain text', 'سa'.repeat(150_000), 'p'],
  ])('a long word %s gets places to break, and keeps its words', (_name, text, tag) => {
    const view = parsed(chatMarkdownHtml(text));
    const breaks = view.querySelectorAll(`${tag} wbr`).length;
    expect(breaks).toBeGreaterThan(0);
    expect(view.textContent!).toContain(text.includes('س') ? 'سa'.repeat(100) : 'a'.repeat(100));
  });

  test('a place to break never falls inside a character or an entity', () => {
    for (const text of ['😀'.repeat(400), `a${'😀'.repeat(400)}`, `😀${'&😀'.repeat(400)}`]) {
      const html = chatMarkdownHtml(text);
      expect(html).toContain('<wbr>');
      expect(html).not.toMatch(/[\ud800-\udbff]<wbr>/);
      expect(parsed(html).textContent!.trim()).toBe(text);
    }
  });

  test('a word under the limit, or text with spaces, is left as it is', () => {
    expect(chatMarkdownHtml('a'.repeat(255))).not.toContain('wbr');
    expect(chatMarkdownHtml('word '.repeat(2_000))).not.toContain('wbr');
  });

  test('a person\'s long word gets the same, and an agent cannot write one itself', () => {
    expect(parsed(personMarkdownHtml('a'.repeat(1_000))).querySelector('wbr')).not.toBeNull();
    expect(parsed(chatMarkdownHtml('one<wbr onclick="alert(1)">two')).querySelector('wbr')).toBeNull();
  });

  test.each([
    ['a paragraph of Chinese', `## Title\n\n${'这是一个很长的段落。'.repeat(900)}`],
    ['Japanese with English in it', `## Title\n\n${'これは Plannotator の設定を説明します。'.repeat(300)}`],
    ['a list of Chinese', `## Title\n\n${'- 这是一个很长的段落，有很多字。\n'.repeat(1_000)}`],
    ['a table of Chinese', `## Title\n\n| 一 |\n| - |\n${'| 这是一个很长的段落，有很多字。 |\n'.repeat(1_000)}`],
    ['long lines of code', `## Title\n\n\`\`\`\n${'const a = 1; '.repeat(10_000)}\n\`\`\`\n`],
    ['Chinese in a code block', `## Title\n\n\`\`\`json\n${'{"标题": "这是一个段落"}\n'.repeat(500)}\`\`\`\n`],
  ])('%s never meets it', (_name, text) => {
    expect(parsed(withStoppedClock(() => chatMarkdownHtml(text))).querySelector('h2')?.textContent).toBe('Title');
  });

  test('a stream holds it, and draws it in full at the end', () => {
    const render = chatTextRenderer(false);
    const text = `**bold**\n\n${mixed(20_000)}`;
    const held = render(text, true);
    expect(held).not.toContain('<strong>');
    expect(render(`${text}more`, true)).toBe(held);
    expect(render(`**bold**\n\n${mixed(10_000)}`, false)).toContain('<strong>');
  });

  test('a stream holds it sooner than a finished text gives up on it', () => {
    const text = `**bold**\n\n${mixed(12_000)}`;
    expect(chatTextRenderer(false)(text, true)).not.toContain('<strong>');
    expect(chatTextRenderer(false)(text, false)).toContain('<strong>');
  });
});

describe.if(hasDom)('a stream that spends its budget', () => {
  test('stays plain while it grows, then renders in full when it ends', () => {
    const render = chatTextRenderer(false);
    expect(withBudgetGone(() => render('**one**', true))).not.toContain('<strong>');
    expect(render('**one** and **two**', true)).not.toContain('<strong>');
    expect(render('**one** and **two**', false)).toContain('<strong>two</strong>');
  });

  test('a stream that keeps its budget draws markdown on every delta', () => {
    const render = chatTextRenderer(false);
    expect(render('**one**', true)).toContain('<strong>');
    expect(render('**one** and **two**', true)).toContain('<strong>two</strong>');
  });

  test('a text put in its place starts fresh', () => {
    const render = chatTextRenderer(false);
    withBudgetGone(() => render('**one**', true));
    expect(render('**other**', true)).toContain('<strong>other</strong>');
  });

  test('after the end the next stream starts fresh', () => {
    const render = chatTextRenderer(false);
    withBudgetGone(() => render('**one**', true));
    render('**one**', false);
    expect(render('**one** and **two**', true)).toContain('<strong>two</strong>');
  });

  test('a person\'s text keeps its own rules, held or not', () => {
    const render = chatTextRenderer(true);
    expect(render('<b>x</b> **y**', true)).toContain('&lt;b&gt;');
    expect(withBudgetGone(() => render('<b>x</b> **y** z', true))).toContain('&lt;b&gt;');
    expect(render('<b>x</b> **y** z w', true)).toContain('&lt;b&gt;');
    expect(render('<b>x</b> **y** z w', false)).toContain('<strong>y</strong>');
  });

  const wideTable = `${'|a'.repeat(33_000)}\n${'|-'.repeat(33_000)}\n`;

  test.each([
    ['a table too costly to draw on every delta', wideTable, '<th>'],
    // Few elements and a lot of HTML, because the host's DOM here is not a browser's.
    ['paragraphs too costly to draw on every delta', `${'&'.repeat(7_000)} ${'&'.repeat(7_000)}\n\n`.repeat(5), '</p>\n<p>'],
  ])('%s is held, and drawn in full when the stream ends', (_name, text, drawn) => {
    const render = chatTextRenderer(false);
    expect(withStoppedClock(() => render(text, true))).not.toContain(drawn);
    expect(withStoppedClock(() => render(text, false))).toContain(drawn);
  });

  test('thousands of short paragraphs are held, however little they weigh as text', () => {
    expect(chatTextRenderer(false)('x\n\n'.repeat(80_000), true)).not.toContain('<p>x</p>');
  });

  test('a held text does not redraw on every delta, only as it grows by a share', () => {
    const render = chatTextRenderer(false);
    const text = 'word '.repeat(60_000);
    const held = render(text, true);
    expect(render(`${text}more`, true)).toBe(held);
    expect(render(`${text}${'more '.repeat(1_000)}`, true)).toBe(held);
    const grown = `${text}${'more '.repeat(10_000)}`;
    expect(parsed(render(grown, true)).textContent).toContain('more more');
  });

  test('a text past the length limit is held too, and comes back whole at the end', () => {
    const render = chatTextRenderer(false);
    const text = 'word '.repeat(60_000);
    const held = render(text, true);
    expect(render(`${text}end`, true)).toBe(held);
    expect(parsed(render(`${text}end`, false)).textContent).toContain('end');
  });
});
