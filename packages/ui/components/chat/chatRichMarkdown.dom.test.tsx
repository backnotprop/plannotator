/**
 * `richMarkdown`, the one switch a host turns on to draw what the Workspaces
 * transcript draws: images, strikethrough, task checkboxes, link titles and list
 * start numbers. Off is today's behavior, and it stays the default because an
 * image loads a remote address from model text. Every guard holds in both modes.
 * Runs the real sanitizer over `tests/helpers/chat-sanitizer-dom.ts`. Requires DOM
 * (DOM_TESTS=1).
 */
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { bridgeSanitizerDom } from '../../../../tests/helpers/chat-sanitizer-dom';
import type * as Markdown from './chatMarkdown';
import type * as Transcript from './ChatTranscript';
import type { ChatMessage, ChatPartContext, ChatTextPart, ChatTranscriptProps } from './ChatTranscript';

const hasDom = typeof document !== 'undefined';
let chatMarkdownHtml: typeof Markdown.chatMarkdownHtml;
let personMarkdownHtml: typeof Markdown.personMarkdownHtml;
let richMarkdownHtml: typeof Markdown.richMarkdownHtml;
let chatTextRenderer: typeof Markdown.chatTextRenderer;
let ChatTranscript: typeof Transcript.ChatTranscript;
let ChatMarkdown: typeof Transcript.ChatMarkdown;
let ChatMessageView: typeof Transcript.ChatMessageView;
let unbridge: (() => void) | undefined;

beforeAll(async () => {
  if (!hasDom) return;
  unbridge = bridgeSanitizerDom();
  ({ chatMarkdownHtml, personMarkdownHtml, richMarkdownHtml, chatTextRenderer } = await import('./chatMarkdown'));
  ({ ChatTranscript, ChatMarkdown, ChatMessageView } = await import('./ChatTranscript'));
  // The sanitizers prove themselves on first use, so that has to happen with the walk in place.
  chatMarkdownHtml('first use');
  richMarkdownHtml('first use');
});

afterAll(() => unbridge?.());

function parsed(html: string) {
  const host = document.createElement('div');
  host.innerHTML = html;
  return host;
}

const rich = (text: string) => parsed(richMarkdownHtml(text));
const richPerson = (text: string) => parsed(richMarkdownHtml(text, { literalHtml: true }));
const attributesOf = (element: Element | null) => element?.getAttributeNames().sort();

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

const gaps = [
  ['an image', '![a cat](https://example.test/cat.png "Cat")', 'img[src="https://example.test/cat.png"][alt="a cat"][title="Cat"]'],
  ['strikethrough', '~~gone~~', 'del'],
  ['a task checkbox', '- [ ] open\n', 'input[type="checkbox"][disabled]'],
  ['a ticked task checkbox', '- [x] done\n', 'input[type="checkbox"][disabled][checked]'],
  ['a loose task checkbox', '- [ ] a\n\n- [x] b\n', 'li p input[type="checkbox"][disabled]'],
  ['a link title', '[x](https://example.test "A hint")', 'a[title="A hint"]'],
  ['a list start', '5. five\n6. six\n', 'ol[start="5"]'],
] as const;

describe.if(hasDom)('each gap', () => {
  test.each(gaps)('%s draws for an agent with the switch on', (_name, text, selector) => {
    expect(rich(text).querySelector(selector)).not.toBeNull();
  });

  // A person's message is markdown too: in Workspaces only their raw HTML is literal.
  test.each(gaps)('%s draws for a person with the switch on', (_name, text, selector) => {
    expect(richPerson(text).querySelector(selector)).not.toBeNull();
  });

  test.each(gaps)('%s stays as today for an agent with the switch off', (_name, text, selector) => {
    expect(parsed(chatMarkdownHtml(text)).querySelector(selector)).toBeNull();
  });

  test.each(gaps)('%s stays as today for a person with the switch off', (_name, text, selector) => {
    expect(parsed(personMarkdownHtml(text)).querySelector(selector)).toBeNull();
  });

  test('a link with a title is still a link that cannot take the host\'s page', () => {
    const link = rich('[x](https://example.test "A hint")').querySelector('a');
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
  });

  test('an image in a link draws in the link', () => {
    const view = rich('[![build](https://example.test/b.svg)](https://example.test)');
    expect(view.querySelector('a[href="https://example.test"] img')?.getAttribute('src')).toBe('https://example.test/b.svg');
  });

  test('what the default takes out with no trace still leaves the words around it', () => {
    expect(parsed(chatMarkdownHtml('~~gone~~ kept')).textContent).toContain('gone kept');
  });
});

describe.if(hasDom)('which addresses an image may have', () => {
  // The list Workspaces has today, which is DOMPurify's own rule for `src`. A
  // narrower list would come back as a failed comparison, so it is pinned here.
  test.each([
    ['https', 'https://example.test/a.png'],
    ['http', 'http://example.test/a.png'],
    ['a path', '/images/a.png'],
    ['a relative path', 'images/a.png'],
    ['a protocol-relative address', '//example.test/a.png'],
    ['a data: image', 'data:image/png;base64,iVBORw0KGgo='],
  ])('%s is drawn, from markdown and from a raw tag', (_name, address) => {
    expect(rich(`![a](${address})`).querySelector('img')?.getAttribute('src')).toBe(address);
    expect(rich(`<img src="${address}">`).querySelector('img')?.getAttribute('src')).toBe(address);
  });

  test.each([
    ['javascript:', 'javascript:alert(1)'],
    ['mixed case', 'JaVaScRiPt:alert(1)'],
    ['vbscript:', 'vbscript:msgbox(1)'],
    ['an entity', '&#106;avascript:alert(1)'],
    ['a tab in the scheme', 'java&#9;script:alert(1)'],
  ])('%s never reaches `src`, from a raw tag', (_name, address) => {
    const image = rich(`<img src="${address}">`).querySelector('img');
    expect(image?.hasAttribute('src') ?? false).toBe(false);
  });

  test('a javascript: address in markdown never reaches `src`', () => {
    const image = rich('![a](javascript:alert(1))').querySelector('img');
    expect(image?.hasAttribute('src') ?? false).toBe(false);
  });

  test('an entity in an honest address means what it says', () => {
    const image = rich('<img src="https://example.test/a.png?x=1&amp;y=2">').querySelector('img');
    expect(image?.getAttribute('src')).toBe('https://example.test/a.png?x=1&y=2');
  });
});

describe.if(hasDom)('a raw image in an agent\'s text', () => {
  test('draws with its sizes, as Workspaces does', () => {
    const image = rich('<img src="https://example.test/a.png" alt="a" title="t" width="120" height="80">').querySelector('img');
    expect(attributesOf(image)).toEqual(['alt', 'height', 'loading', 'src', 'title', 'width']);
    expect(image?.getAttribute('width')).toBe('120');
    expect(image?.getAttribute('height')).toBe('80');
  });

  test.each([
    ['single quotes', "<img src='https://example.test/a.png' alt='a'>"],
    ['no quotes', '<img src=https://example.test/a.png alt=a>'],
    ['capitals', '<IMG SRC="https://example.test/a.png" ALT="a">'],
    ['self-closed', '<img src="https://example.test/a.png" alt="a" />'],
    ['inside a sentence', 'See <img src="https://example.test/a.png" alt="a"> here'],
  ])('reads %s', (_name, text) => {
    const image = rich(text).querySelector('img');
    expect(image?.getAttribute('src')).toBe('https://example.test/a.png');
    expect(image?.getAttribute('alt')).toBe('a');
  });

  test('keeps only what an image may say, whatever else the tag carries', () => {
    const image = rich(
      '<img src="https://example.test/a.png" onerror="alert(1)" onload="alert(2)" class="fixed inset-0" ' +
        'style="position:fixed" data-text-part="" aria-hidden="true" id="root" srcset="https://evil.test/b.png 2x" ' +
        'usemap="#m" align="left" crossorigin="use-credentials" name="q">',
    ).querySelector('img');
    expect(attributesOf(image)).toEqual(['loading', 'src']);
  });

  test('a quote inside a value cannot end the tag', () => {
    const view = rich(`<img src="https://example.test/a.png" alt='"><b onclick=x>y'>`);
    expect(view.querySelector('b')).toBeNull();
    expect(view.querySelector('img')?.getAttribute('alt')).toBe('"><b onclick=x>y');
  });

  test('the first of two spellings wins, as in a browser, so a later one cannot hide', () => {
    const image = rich('<img src="https://example.test/a.png" src="javascript:alert(1)">').querySelector('img');
    expect(image?.getAttribute('src')).toBe('https://example.test/a.png');
  });

  test.each([
    ['no space before the attributes', '<img/src="https://evil.test/a.png" onerror="alert(1)">'],
    ['no closing bracket', '<img src="https://evil.test/a.png" onerror="alert(1)"'],
  ])('a tag `marked` does not take for one stays text: %s', (_name, text) => {
    const view = rich(text);
    expect(view.querySelector('img')).toBeNull();
    expect(view.textContent).toContain('onerror');
  });

  test.each([
    ['a code span', 'Use `<img src="https://evil.test/a.png">` here'],
    ['a code block', '```html\n<img src="https://evil.test/a.png">\n```\n'],
  ])('in %s it is code', (_name, text) => {
    const view = rich(text);
    expect(view.querySelector('img')).toBeNull();
    expect(view.querySelector('code')?.textContent).toContain('<img');
  });

  test('a block of images takes no paragraph, so no paragraph\'s margin', () => {
    const view = rich('<img src="https://example.test/a.png">\n<img src="https://example.test/b.png">\n\nafter');
    expect(view.querySelectorAll('img').length).toBe(2);
    expect(view.querySelector('p img')).toBeNull();
  });

  test('an image in a raw wrapper draws, and the wrapper is the text it is', () => {
    const view = rich('<p align="center"><img src="https://example.test/a.png"></p>\n');
    expect(view.querySelector('img')).not.toBeNull();
    expect(view.querySelector('p[align]')).toBeNull();
    expect(view.textContent).toContain('<p align="center">');
  });
});

describe.if(hasDom)('how many images one message can ask for', () => {
  const LIMIT = 100;
  const addresses = (view: Element) => [...view.querySelectorAll('img')].map((image) => image.getAttribute('src'));
  const address = (at: number) => `https://example.test/${at}.png`;
  const each = (count: number, write: (at: number) => string) =>
    Array.from({ length: count }, (_, at) => write(at)).join(' ');
  const inMarkdown = (at: number) => `![alt ${at}](${address(at)})`;
  const asRawTag = (at: number) => `<img src="${address(at)}" alt="alt ${at}">`;

  test.each([
    ['markdown', (count: number) => each(count, inMarkdown), rich],
    ['raw tags in a sentence', (count: number) => `See ${each(count, asRawTag)}`, rich],
    ['a raw block', (count: number) => `${each(count, asRawTag)}\n`, rich],
    ['a raw block in a wrapper', (count: number) => `<div>\n${each(count, asRawTag)}\n</div>\n`, rich],
    ['a person\'s markdown', (count: number) => each(count, inMarkdown), richPerson],
  ])('%s stops requesting at the limit, in order', (_name, text, render) => {
    const found = addresses(render(text(LIMIT + 50)));
    expect(found.length).toBe(LIMIT);
    expect(found[0]).toBe(address(0));
    expect(found[LIMIT - 1]).toBe(address(LIMIT - 1));
  });

  test('the limit itself is allowed', () => {
    expect(addresses(rich(each(LIMIT, inMarkdown))).length).toBe(LIMIT);
  });

  test('markdown and raw tags count together', () => {
    const view = rich(`${each(60, inMarkdown)} ${each(60, asRawTag)}`);
    expect(addresses(view).length).toBe(LIMIT);
  });

  test('past the limit an image is its alt text, so nothing the author wrote is lost', () => {
    const view = rich(each(LIMIT + 2, inMarkdown));
    expect(view.textContent).toContain(`alt ${LIMIT}`);
    expect(view.textContent).toContain(`alt ${LIMIT + 1}`);
    expect(view.textContent).not.toContain('alt 0');
  });

  test('alt text past the limit is text, whatever it spells', () => {
    const view = rich(`${each(LIMIT, inMarkdown)} <img src="https://evil.test/a.png" alt="<b onclick=x>y</b>">`);
    expect(view.querySelector('b')).toBeNull();
    expect(view.textContent).toContain('<b onclick=x>y</b>');
  });

  test('past the limit an image with no alt text draws nothing', () => {
    const view = rich(`${each(LIMIT, inMarkdown)} ![](https://example.test/none.png)`);
    expect(addresses(view)).not.toContain('https://example.test/none.png');
  });

  test('an image inside a link keeps the link and loses the request', () => {
    const view = rich(`${each(LIMIT, inMarkdown)} [![badge](https://example.test/b.svg)](https://example.test)`);
    expect(view.querySelector('a[href="https://example.test"]')?.textContent).toBe('badge');
    expect(view.querySelector('a[href="https://example.test"] img')).toBeNull();
  });

  test('each message has its own count', () => {
    const text = each(LIMIT, inMarkdown);
    expect(addresses(rich(text)).length).toBe(LIMIT);
    expect(addresses(rich(text)).length).toBe(LIMIT);
  });

  test('so does each redraw of a stream', () => {
    const render = chatTextRenderer(false, true);
    render(each(LIMIT, inMarkdown), true);
    expect(addresses(parsed(render(`${each(LIMIT, inMarkdown)} more`, true))).length).toBe(LIMIT);
  });
});

describe.if(hasDom)('an image waits until it is near', () => {
  test.each([
    ['markdown', '![a](https://example.test/a.png)'],
    ['a raw tag', '<img src="https://example.test/a.png">'],
    ['a raw tag that asks to load at once', '<img src="https://example.test/a.png" loading="eager">'],
  ])('%s loads lazily', (_name, text) => {
    expect(rich(text).querySelector('img')?.getAttribute('loading')).toBe('lazy');
  });

  // Firefox reads `loading` only if it comes before `src` (bug 1647077).
  test('`loading` is written before `src`', () => {
    const names = rich('![a](https://example.test/a.png)').querySelector('img')!.getAttributeNames();
    expect(names).toContain('loading');
    expect(names.indexOf('loading')).toBeLessThan(names.indexOf('src'));
  });
});

describe.if(hasDom)('form controls', () => {
  test.each([
    ['text', '<input type="text" name="q" value="v">'],
    ['password', '<input type="password">'],
    ['submit', '<input type="submit" value="go">'],
    ['hidden', '<input type="hidden" name="csrf" value="v">'],
    ['file', '<input type="file">'],
    ['radio', '<input type="radio" name="r">'],
    ['image', '<input type="image" src="https://evil.test/a.png">'],
    ['no type', '<input name="q">'],
    ['a checkbox only by its look', '<input type=" checkbox">'],
  ])('a raw %s input is removed', (_name, text) => {
    const view = rich(`before ${text} after`);
    expect(view.querySelector('input')).toBeNull();
    expect(view.textContent).toContain('before');
    expect(view.textContent).toContain('after');
    expect(view.textContent).not.toContain('input');
  });

  test.each([
    ['live', '<input type="checkbox">', false],
    ['checked', '<input type="checkbox" checked>', true],
    ['in capitals', '<INPUT TYPE="CHECKBOX">', false],
  ])('a raw checkbox left %s comes out disabled', (_name, text, checked) => {
    const box = rich(`${text} task`).querySelector('input');
    expect(box?.hasAttribute('disabled')).toBe(true);
    expect(box?.hasAttribute('checked')).toBe(checked);
  });

  test('a raw checkbox carries nothing else', () => {
    const box = rich(
      '<input type="checkbox" name="q" id="root" form="f" value="v" class="fixed" onclick="alert(1)" data-x="1"> task',
    ).querySelector('input');
    expect(attributesOf(box)).toEqual(['disabled', 'type']);
  });

  test('a form around one does not draw', () => {
    const view = rich('<form action="https://evil.test"><input type="checkbox"><button>go</button></form>');
    expect(view.querySelector('form, button')).toBeNull();
  });
});

describe.if(hasDom)('a person\'s message', () => {
  test.each([
    ['an image', '<img src="https://evil.test/a.png" onerror="alert(1)">', 'img'],
    ['a checkbox', '<input type="checkbox">', 'input'],
    ['a link', '<a href="https://evil.test">x</a>', 'a'],
    ['bold', '<b>x</b>', 'b'],
  ])('%s they typed stays literal with the switch on', (_name, text, tag) => {
    const view = richPerson(text);
    expect(view.querySelector(tag)).toBeNull();
    expect(view.textContent).toContain(text);
  });

  test('a comment they typed stays too: only an agent\'s is dropped', () => {
    expect(richPerson('<!-- note -->').textContent).toContain('<!-- note -->');
  });
});

describe.if(hasDom)('the rest of an agent\'s raw HTML', () => {
  test.each([
    ['bold', '<b>x</b>', 'b'],
    ['a link', '<a href="https://evil.test" class="fixed">x</a>', 'a'],
    ['a frame', '<iframe src="https://evil.test"></iframe>', 'iframe'],
    ['a script', '<script>alert(1)</script>', 'script'],
    ['svg', '<svg onload="alert(1)"></svg>', 'svg'],
    ['a disclosure', '<details open><summary>s</summary>b</details>', 'details'],
    ['a video', '<video src="https://evil.test/a.mp4"></video>', 'video'],
  ])('%s stays text with the switch on', (_name, text, tag) => {
    const view = rich(text);
    expect(view.querySelector(tag)).toBeNull();
    expect(view.textContent).toContain(text);
  });

  test.each([
    ['a block', '<!-- note -->\n\nafter'],
    ['inline', 'before <!-- note --> after'],
    ['several lines', '<!-- one\ntwo -->\n\nafter'],
  ])('a comment draws nothing, as in Workspaces: %s', (_name, text) => {
    expect(rich(text).textContent).not.toContain('note');
    expect(rich(text).textContent).not.toContain('<!--');
    expect(rich(text).textContent).toContain('after');
  });

  test('words between two comments are not lost with them', () => {
    expect(rich('<!-- a --><b>kept</b><!-- b -->\n').textContent).toContain('kept');
  });

  test('a comment stays text with the switch off', () => {
    expect(parsed(chatMarkdownHtml('<!-- note -->')).textContent).toContain('<!-- note -->');
  });
});

describe.if(hasDom)('the limits, with the switch on', () => {
  const image = '![a](https://example.test/a.png)';
  const isPlain = (html: string) => !parsed(html).querySelector('img, strong, del');

  test('a text past the length limit is plain text', () => {
    expect(isPlain(richMarkdownHtml(`${image} **b** ${'word '.repeat(52_000)}`))).toBe(true);
  });

  test('a text whose HTML runs past the limit is plain text', () => {
    const uses = '![a][r] '.repeat(1_000);
    expect(isPlain(richMarkdownHtml(`${uses}\n\n[r]: https://example.test/${'a'.repeat(1_500)}`))).toBe(true);
  });

  test('a spent time budget is plain text', () => {
    expect(isPlain(withBudgetGone(() => richMarkdownHtml(`${image} **b**`)))).toBe(true);
  });

  test('too many characters past ASCII in a block is plain text', () => {
    expect(isPlain(richMarkdownHtml(`${image} ${'字'.repeat(10_001)}`))).toBe(true);
  });

  test('so is a raw block of them, even around an image', () => {
    const html = richMarkdownHtml(`<div><img src="https://example.test/a.png">${'字'.repeat(10_001)}</div>\n`);
    expect(isPlain(html)).toBe(true);
  });

  test('a table past the cell limit stays text, and the rest stays formatted', () => {
    const header = `|${' a |'.repeat(500)}\n|${'---|'.repeat(500)}\n`;
    const view = rich(`${image}\n\n${header}${'|b|\n'.repeat(2_000)}`);
    expect(view.querySelector('img')).not.toBeNull();
    expect(view.querySelector('td')).toBeNull();
  });

  test('a run with a word past the limit is literal, so a long data: image stays text', () => {
    const view = rich(`![a](data:image/png;base64,${'A'.repeat(9_000)})`);
    expect(view.querySelector('img')).toBeNull();
    expect(view.textContent).toContain('![a]');
  });

  // What took a long unbroken word in WebKit from minutes to 130 ms.
  test('a long word in a raw block still gets its place to break', () => {
    const view = rich(`<div><img src="https://example.test/a.png">${'a'.repeat(300)}</div>\n`);
    expect(view.querySelector('wbr')).not.toBeNull();
    expect(view.textContent).toContain('a'.repeat(300));
  });

  test('raw tags still never reach the parser: unclosed formatting stays text', () => {
    const html = richMarkdownHtml('<b>'.repeat(9_000));
    expect(parsed(html).querySelector('b')).toBeNull();
  });

  test('a stream holds a spent text plain, and draws it whole at the end', () => {
    const render = chatTextRenderer(false, true);
    expect(isPlain(withBudgetGone(() => render(`${image} **b**`, true)))).toBe(true);
    expect(parsed(render(`${image} **b**`, false)).querySelector('img')).not.toBeNull();
  });

  // The pattern that finds raw tags runs on the whole of a block of raw HTML, past
  // every check inside `marked`. These are the shapes that would make it quadratic.
  test.each([
    ['unclosed tags', '<img '.repeat(50_000)],
    ['unclosed quotes', '<img a="'.repeat(30_000)],
    ['mixed quotes', `<img a="${`<img a='`.repeat(30_000)}`],
    ['a long run of attributes', `<img ${'a '.repeat(120_000)}`],
    ['a long run of spaces', `<img${' '.repeat(240_000)}x`],
    ['unclosed comments', '<!-- '.repeat(50_000)],
  ])('%s cost no more than a moment', (_name, text) => {
    const started = performance.now();
    richMarkdownHtml(`<div>\n${text}\n`);
    richMarkdownHtml(`a ${text}`);
    expect(performance.now() - started).toBeLessThan(1_500);
  });
});

describe.if(hasDom)('the proof', () => {
  // Each case gets its own copy of the module, because a sanitizer proves itself
  // once. Each breaks the DOM as a partial one can be broken, and the same text
  // must then go out with none of its markup.
  let fresh = 0;
  const freshModule = async () => (await import(`./chatMarkdown?proof=${(fresh += 1)}`)) as typeof Markdown;
  const text = '![a](https://example.test/a.png)\n\n**b** ~~c~~\n\n- [ ] d\n';

  function breaking(spy: { mockRestore: () => void }, run: () => string) {
    try {
      return run();
    } finally {
      spy.mockRestore();
    }
  }

  const isPlainText = (html: string) => {
    expect(parsed(html).querySelector('img, strong, del, input, ul')).toBeNull();
    expect(html).toContain('![a]');
  };

  test('a fresh copy of the module draws, so the cases below are about the break', async () => {
    const { richMarkdownHtml: render } = await freshModule();
    expect(parsed(render(text)).querySelector('img, strong, del, input')).not.toBeNull();
  });

  test('fails closed where attributes cannot be taken off: handlers, class, javascript:', async () => {
    const { richMarkdownHtml: render } = await freshModule();
    const byName = spyOn(Element.prototype, 'removeAttribute').mockImplementation(() => {});
    const byNode = spyOn(Element.prototype, 'removeAttributeNode').mockImplementation(((attr: Attr) => attr) as never);
    try {
      isPlainText(render(text));
    } finally {
      byNode.mockRestore();
      byName.mockRestore();
    }
  });

  test('fails closed where elements cannot be taken out: scripts', async () => {
    const { richMarkdownHtml: render } = await freshModule();
    const spy = spyOn(Node.prototype, 'removeChild').mockImplementation(((child: Node) => child) as never);
    const remove = spyOn(Element.prototype, 'remove').mockImplementation(() => {});
    try {
      isPlainText(render(text));
    } finally {
      remove.mockRestore();
      spy.mockRestore();
    }
  });

  test('fails closed where a checkbox cannot be disabled', async () => {
    const { richMarkdownHtml: render } = await freshModule();
    const real = Element.prototype.setAttribute;
    const spy = spyOn(Element.prototype, 'setAttribute').mockImplementation(function (this: Element, name: string, value: string) {
      if (name !== 'disabled') real.call(this, name, value);
    });
    isPlainText(breaking(spy, () => render(text)));
  });

  test('fails closed where a text field cannot be removed', async () => {
    const { richMarkdownHtml: render } = await freshModule();
    isPlainText(breaking(spyOn(Element.prototype, 'remove').mockImplementation(() => {}), () => render(text)));
  });

  test('each mode proves itself: a failed rich proof leaves the default drawing', async () => {
    const { chatMarkdownHtml: plain, richMarkdownHtml: render } = await freshModule();
    const real = Element.prototype.setAttribute;
    const spy = spyOn(Element.prototype, 'setAttribute').mockImplementation(function (this: Element, name: string, value: string) {
      if (name !== 'disabled') real.call(this, name, value);
    });
    isPlainText(breaking(spy, () => render(text)));
    expect(parsed(plain(text)).querySelector('strong')).not.toBeNull();
  });
});

describe.if(hasDom)('the switch on the transcript', () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;

  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
  });

  const say = (id: string, role: ChatMessage['role'], text: string): ChatMessage => ({
    id,
    role,
    parts: [{ type: 'text', text } as ChatTextPart],
  });
  const picture = '![a](https://example.test/a.png)';

  function render(props: Partial<ChatTranscriptProps>) {
    host ??= document.createElement('div');
    document.body.appendChild(host);
    root ??= createRoot(host);
    act(() => root!.render(<ChatTranscript messages={[]} status="ready" agentName="Claude" {...props} />));
    return host;
  }

  /** The folder's documented way to paint into a text part. */
  const ownMarkdown = (overrides: { richMarkdown?: boolean } = {}) =>
    (part: ChatMessage['parts'][number], { message, index }: ChatPartContext) =>
      part.type === 'text' ? (
        <ChatMarkdown text={(part as ChatTextPart).text} messageId={message.id} partIndex={index} {...overrides} />
      ) : undefined;

  test('off by default, for both sides', () => {
    const view = render({ messages: [say('1', 'user', picture), say('2', 'assistant', picture)] });
    expect(view.querySelector('img')).toBeNull();
  });

  test('on, it reaches both sides', () => {
    const view = render({ messages: [say('1', 'user', picture), say('2', 'assistant', picture)], richMarkdown: true });
    expect(view.querySelectorAll('[data-text-part] img').length).toBe(2);
  });

  test('on, a person\'s raw HTML stays their words and an agent\'s image draws', () => {
    const tag = '<img src="https://example.test/a.png">';
    const view = render({ messages: [say('1', 'user', tag), say('2', 'assistant', tag)], richMarkdown: true });
    expect(view.querySelector('[data-message-role="user"] img')).toBeNull();
    expect(view.querySelector('[data-message-role="assistant"] img')).not.toBeNull();
  });

  test('turning it on redraws text already on screen', () => {
    const messages = [say('1', 'assistant', picture)];
    render({ messages });
    expect(render({ messages, richMarkdown: true }).querySelector('img')).not.toBeNull();
  });

  test('a host\'s own ChatMarkdown in renderPart does not have to be told twice', () => {
    const view = render({ messages: [say('1', 'assistant', picture)], richMarkdown: true, renderPart: ownMarkdown() });
    expect(view.querySelector('[data-text-part] img')).not.toBeNull();
  });

  test('a host\'s own ChatMarkdown can still say no', () => {
    const view = render({
      messages: [say('1', 'assistant', picture)],
      richMarkdown: true,
      renderPart: ownMarkdown({ richMarkdown: false }),
    });
    expect(view.querySelector('img')).toBeNull();
  });

  test('a host\'s row in renderMessage hears it too', () => {
    const view = render({
      messages: [say('1', 'assistant', picture)],
      richMarkdown: true,
      renderMessage: (message) => <ChatMessageView message={message} agentName="Claude" />,
    });
    expect(view.querySelector('img')).not.toBeNull();
  });

  // Both are public, so a host can draw them with no `ChatTranscript` around them.
  // There the context's own default decides, and an image is a request the host
  // never asked for. These roots are their own, outside every Provider.
  describe('with no transcript around it', () => {
    function bare(element: React.ReactElement) {
      host ??= document.createElement('div');
      document.body.appendChild(host);
      root ??= createRoot(host);
      act(() => root!.render(element));
      return host;
    }

    test('a bare ChatMarkdown draws no image', () => {
      expect(bare(<ChatMarkdown text={picture} />).querySelector('img')).toBeNull();
    });

    test('a bare ChatMessageView draws no image', () => {
      const view = bare(<ChatMessageView message={say('1', 'assistant', picture)} agentName="Claude" />);
      expect(view.querySelector('img')).toBeNull();
    });

    test('a bare ChatMarkdown draws one when it says so', () => {
      expect(bare(<ChatMarkdown text={picture} richMarkdown />).querySelector('img')).not.toBeNull();
    });

    test('a bare ChatMessageView draws one when it says so', () => {
      const view = bare(<ChatMessageView message={say('1', 'assistant', picture)} agentName="Claude" richMarkdown />);
      expect(view.querySelector('img')).not.toBeNull();
    });
  });

  // An image is the first content that grows with no change to `messages`, so
  // nothing else tells the pane its text moved. `load` does not bubble: a listener
  // has to catch it on the way down. Chromium proves the same with a real image in
  // `tests/e2e/chat-window.spec.ts`.
  describe('an image that arrives late', () => {
    function pane(view: HTMLElement, scrollHeight: number, clientHeight: number) {
      const element = view.querySelector<HTMLElement>('[role="region"]')!;
      Object.defineProperty(element, 'scrollHeight', { configurable: true, value: scrollHeight });
      Object.defineProperty(element, 'clientHeight', { configurable: true, value: clientHeight });
      return element;
    }
    const arrive = (image: Element | null) => act(() => void image!.dispatchEvent(new Event('load')));

    test('keeps a pane at its live edge there', () => {
      const view = render({ messages: [say('1', 'assistant', picture)], richMarkdown: true });
      const element = pane(view, 1_000, 100);
      arrive(view.querySelector('img'));
      expect(element.scrollTop).toBe(1_000);
    });

    test('leaves a person who scrolled away where they are', () => {
      const view = render({ messages: [say('1', 'assistant', picture)], richMarkdown: true });
      const element = pane(view, 1_000, 100);
      element.scrollTop = 200;
      act(() => void element.dispatchEvent(new Event('scroll', { bubbles: true })));
      arrive(view.querySelector('img'));
      expect(element.scrollTop).toBe(200);
    });

    test('with the switch off, an image a host drew itself moves nothing', () => {
      const view = render({
        messages: [say('1', 'assistant', 'Hi')],
        renderPart: () => <img alt="" src="https://example.test/host.png" />,
      });
      const element = pane(view, 1_000, 100);
      arrive(view.querySelector('img'));
      expect(element.scrollTop).toBe(0);
    });
  });

  describe('agentBadge', () => {
    const nameRowOf = (view: HTMLElement, role: string) =>
      view.querySelector(`[data-message-role="${role}"]:not([data-text-part])`)!.firstElementChild!;

    test('sits after the agent\'s name and before Stopped', () => {
      const view = render({
        messages: [say('1', 'assistant', 'Hi')],
        agentBadge: <span data-badge />,
        stopped: new Set(['1']),
      });
      const row = [...nameRowOf(view, 'assistant').children];
      const badge = row.findIndex((el) => el.hasAttribute('data-badge'));
      expect(row[badge - 1]?.textContent).toBe('Claude');
      expect(row[badge + 1]?.textContent).toBe('Stopped');
    });

    test('is the agent\'s alone', () => {
      const view = render({ messages: [say('1', 'user', 'Hi')], agentBadge: <span data-badge /> });
      expect(view.querySelector('[data-badge]')).toBeNull();
    });
  });
});
