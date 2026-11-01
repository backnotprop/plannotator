/**
 * The sanitizer really running, with the folder's own allowlist. As it stands
 * happy-dom cannot host DOMPurify, for two reasons, and both are bridged here:
 * its NodeIterator loses its place when the node under it goes, so here the walk
 * is a list taken up front; and `Node.prototype.nodeName`, which DOMPurify reads
 * directly, is blank there, so here it answers as a browser's does. The rest is
 * DOMPurify's own code, and if either bridge stops working the sanitizer fails
 * its proof and every test below fails. The spec in
 * `tests/e2e/chat-markdown-sanitize.spec.ts` proves the same text in Chromium.
 * Requires DOM (DOM_TESTS=1).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type * as Markdown from './chatMarkdown';

const hasDom = typeof document !== 'undefined';
let chatMarkdownHtml: typeof Markdown.chatMarkdownHtml;
let personMarkdownHtml: typeof Markdown.personMarkdownHtml;
let realNodeName: PropertyDescriptor | undefined;

function nameLikeABrowser(this: Node) {
  if (this.nodeType === 1) return (this as Element).tagName;
  if (this.nodeType === 3) return '#text';
  if (this.nodeType === 8) return '#comment';
  return realNodeName?.get?.call(this);
}

function walkFromAList(root: Node) {
  const nodes: Node[] = [];
  const visit = (node: Node) => {
    nodes.push(node);
    for (const child of node.childNodes) visit(child);
  };
  visit(root);
  let at = 0;
  return { nextNode: () => nodes[at++] ?? null };
}

beforeAll(async () => {
  if (!hasDom) return;
  realNodeName = Object.getOwnPropertyDescriptor(Node.prototype, 'nodeName');
  Object.defineProperty(Node.prototype, 'nodeName', { configurable: true, get: nameLikeABrowser });
  Object.defineProperty(document, 'createNodeIterator', { configurable: true, value: walkFromAList });
  ({ chatMarkdownHtml, personMarkdownHtml } = await import('./chatMarkdown'));
  // The sanitizer proves itself on first use, so that has to happen with the walk in place.
  chatMarkdownHtml('first use');
});

afterAll(() => {
  if (!hasDom) return;
  delete (document as { createNodeIterator?: unknown }).createNodeIterator;
  Object.defineProperty(Node.prototype, 'nodeName', realNodeName!);
});

function parsed(html: string) {
  const host = document.createElement('div');
  host.innerHTML = html;
  return host;
}

function attributesIn(html: string) {
  return [...parsed(html).querySelectorAll('*')].flatMap((el) => el.getAttributeNames());
}

const bothRoles = [
  ['an agent', (text: string) => chatMarkdownHtml(text)],
  ['a person', (text: string) => personMarkdownHtml(text)],
] as const;

describe.if(hasDom)('what agent text can write into a host\'s page', () => {
  test('a link cannot be placed over the page: the host\'s classes are out of reach', () => {
    const html = chatMarkdownHtml('<a href="https://evil.test/phish" class="fixed inset-0 z-50">x</a>');
    expect(html).not.toContain('class');
    expect(html).not.toContain('fixed');
    expect(parsed(html).querySelector('a')?.getAttribute('href')).toBe('https://evil.test/phish');
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
    const html = chatMarkdownHtml(input);
    expect(html).not.toMatch(/<(script|img|iframe|form|input|style|svg|base)\b|onclick|onerror|onload/i);
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

  test('agent text cannot choose how its own link opens', () => {
    const link = parsed(chatMarkdownHtml('<a href="https://x.test" target="_self" rel="opener">x</a>')).querySelector('a')!;
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
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

  test('past the limit the words are all there, line by line, and none of it is HTML', () => {
    const text = `<img src=x onerror=alert(1)>\n${'x'.repeat(300_000)}\nlast`;
    const html = chatMarkdownHtml(text);
    expect(html).not.toContain('<img');
    expect(parsed(html).querySelectorAll('br').length).toBe(2);
    expect(parsed(html).textContent).toContain('<img src=x onerror=alert(1)>');
  });

  test('a message after one of these draws as usual, and a long honest one stays markdown', () => {
    chatMarkdownHtml('> '.repeat(100_000));
    chatMarkdownHtml('_a'.repeat(100_000));
    expect(chatMarkdownHtml('**fine**')).toContain('<strong>fine</strong>');
    const longAnswer = 'A sentence with **weight** and `code` in it.\n\n'.repeat(1_000);
    expect(parsed(chatMarkdownHtml(longAnswer)).querySelectorAll('strong').length).toBe(1_000);
  });
});
