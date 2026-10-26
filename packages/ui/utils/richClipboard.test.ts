import { afterEach, describe, expect, test, mock } from 'bun:test';
import {
  copyRichSelection,
  copyRichTextToClipboard,
  isLoopbackHostname,
  MAX_RICH_CLIPBOARD_OUTPUT_LENGTH,
  plainTextClipboardHtml,
  richCopyOutcomeLabel,
  richCopySourceFromRange,
  sanitizeRichHtml,
  selectionRangeToHtml,
} from './richClipboard';

const hasDom = typeof document !== 'undefined';
const restorers: Array<() => void> = [];

type AnyRecord = Record<string, unknown>;

function override(target: object, key: string, value: unknown): void {
  const original = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { value, configurable: true, writable: true });
  restorers.push(() => {
    if (original) Object.defineProperty(target, key, original);
    else delete (target as AnyRecord)[key];
  });
}

afterEach(() => {
  while (restorers.length > 0) restorers.pop()!();
  if (hasDom) {
    document.body.replaceChildren();
    document.head.replaceChildren();
  }
});

describe('selectionRangeToHtml', () => {
  test.skipIf(!hasDom)('marks a selection past the output cap too large for rich text', () => {
    document.body.innerHTML = `<p>${'x'.repeat(MAX_RICH_CLIPBOARD_OUTPUT_LENGTH + 1)}</p>`;
    const range = document.createRange();
    range.selectNode(document.querySelector('p')!);

    expect(selectionRangeToHtml(range)).toBeNull();
    expect(richCopySourceFromRange(range, 'quote')).toEqual({ tooLarge: true, text: 'quote' });
  });

  test.skipIf(!hasDom)('marks sanitized HTML past the output cap too large, even when the text fits', () => {
    // Long link targets: the text is ten characters, the markup is not.
    const href = `https://example.test/${'x'.repeat(60_000)}`;
    document.body.innerHTML = `<p>${`<a href="${href}">y</a>`.repeat(10)}</p>`;
    const range = document.createRange();
    range.selectNode(document.querySelector('p')!);

    expect(range.toString().length).toBeLessThan(MAX_RICH_CLIPBOARD_OUTPUT_LENGTH);
    expect(selectionRangeToHtml(range)).toBeNull();
  });

  test.skipIf(!hasDom)('keeps exactly selected inline markup', () => {
    document.head.innerHTML = '<base href="http://localhost/">';
    document.body.innerHTML = '<p>before <strong>bold <a href="/docs">link</a></strong> after</p>';
    const paragraph = document.querySelector('p')!;
    const range = document.createRange();
    range.setStart(paragraph.firstChild!, 7);
    range.setEnd(paragraph.querySelector('a')!.firstChild!, 4);

    // A link to the page's own server keeps its words and loses its href.
    expect(selectionRangeToHtml(range)).toBe('<p><strong>bold <a>link</a></strong></p>');
  });

  test.skipIf(!hasDom)('keeps list, code and table structure with safe formatting attributes', () => {
    document.body.innerHTML = '<ol start="2" data-block-id="list"><li value="3">run <code class="language-ts" style="color:red">test()</code><table><tr><th colspan="2" style="background:black">Header</th></tr></table></li></ol>';
    const range = document.createRange();
    range.selectNode(document.querySelector('ol')!);

    expect(selectionRangeToHtml(range)).toBe(
      '<ol start="2"><li value="3">run <code>test()</code><table><tbody><tr><th colspan="2">Header</th></tr></tbody></table></li></ol>',
    );
  });

  test.skipIf(!hasDom)('does not export tokenized local HTML asset links', () => {
    document.head.innerHTML = '<base href="http://localhost/">';
    document.body.innerHTML = '<p><a href="/api/html-assets/private-token/images/logo.svg">local</a> <a href="https://example.test/api/html-assets/public/docs">external</a></p>';
    const range = document.createRange();
    range.selectNode(document.querySelector('p')!);

    expect(selectionRangeToHtml(range)).toBe(
      '<p><a>local</a> <a href="https://example.test/api/html-assets/public/docs">external</a></p>',
    );
  });

  test.skipIf(!hasDom)('drops every link to the page origin or a loopback host, any port or path; keeps the text', () => {
    document.head.innerHTML = '<base href="http://localhost:4100/">';
    const droppedLinks = [
      // Tokens that decode past the asset route (review of #2191).
      'http://localhost:5000/api/html-assets/TOKEN/..%2F..%2Fx',
      'http://localhost:5000/api/html-assets/TOKEN/..%5C..%5Cx',
      'http://localhost:5000/api/html-assets/TOKEN/%2e%2e%252f%2e%2e%252fx',
      // A local document link and a live-app proxy link.
      '/Users/me/notes.md',
      'http://localhost:4100/docs/readme',
      'http://localhost:61234/dashboard?tab=2',
      'http://127.0.0.1:4100/api/html-assets/tok/x.png',
      'http://127.1/x',
      'http://2130706433/x',
      'http://[::1]:4100/x',
      'http://[::ffff:127.0.0.1]/x',
      'http://[::7f00:1]/x',
      'http://LOCALHOST./x',
      'http://app.localhost:4100/x',
      'https://localhost/x',
      'http://0.0.0.0:8080/x',
    ];
    const keptLinks = [
      'https://example.test/api/html-assets/tok/x',
      'http://192.168.1.4:4100/docs',
      'mailto:a@example.test',
    ];
    document.body.innerHTML = `<p>${[...droppedLinks, ...keptLinks]
      .map((href, index) => `<a href="${href}" title="Open: ${href}">l${index}</a>`).join(' ')}</p>`;
    const range = document.createRange();
    range.selectNode(document.querySelector('p')!);
    const html = selectionRangeToHtml(range)!;
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    const anchors = Array.from(parsed.querySelectorAll('a'));
    expect(anchors.map((a) => a.textContent)).toEqual([...droppedLinks, ...keptLinks].map((_, index) => `l${index}`));
    expect(anchors.map((a) => a.getAttribute('href'))).toEqual([
      ...droppedLinks.map(() => null),
      'https://example.test/api/html-assets/tok/x',
      'http://192.168.1.4:4100/docs',
      'mailto:a@example.test',
    ]);
    expect(html).not.toMatch(/title=|TOKEN|notes\.md/);
  });

  test('loopback hosts are recognized in their spellings', () => {
    for (const host of ['localhost', 'localhost.', 'a.b.localhost', '127.0.0.1', '127.9.8.7', '[::1]', '[::ffff:7f00:1]', '[::7f00:1]', '0.0.0.0']) {
      expect(isLoopbackHostname(host)).toBe(true);
    }
    for (const host of ['example.test', 'localhost.example.test', '128.0.0.1', '[::2]', 'mylocalhost']) {
      expect(isLoopbackHostname(host)).toBe(false);
    }
  });

  test.skipIf(!hasDom)('strips review metadata, theme styles, annotation marks and unsafe content', () => {
    document.head.innerHTML = '<base href="http://localhost/">';
    document.body.innerHTML = `<p data-block-id="block-1" style="color:red">before <mark class="annotation-highlight">marked</mark> <span style="color:blue">blue</span><a href="javascript:alert(1)" onclick="run()">unsafe</a><script>secret()</script> after</p>`;
    const paragraph = document.querySelector('p')!;
    const range = document.createRange();
    range.selectNode(paragraph);

    const html = selectionRangeToHtml(range);
    expect(html).toBe('<p>before marked <span>blue</span><a>unsafe</a> after</p>');
    expect(html).not.toMatch(/data-block-id|style=|class=|onclick|javascript:|<script|secret\(\)/);
  });
});

describe('sanitizeRichHtml', () => {
  test.skipIf(!hasDom)('sanitizes bridge HTML and rejects oversized payloads', () => {
    expect(sanitizeRichHtml('<p style="color:red" onclick="run()"><strong>safe</strong><script>secret()</script></p>'))
      .toBe('<p><strong>safe</strong></p>');
    expect(sanitizeRichHtml('<p>before<svg><text>not copied</text></svg>after</p>'))
      .toBe('<p>beforeafter</p>');
    expect(sanitizeRichHtml('x'.repeat(256 * 1024 + 1))).toBeNull();
    expect(sanitizeRichHtml('')).toBeNull();
  });

  test.skipIf(!hasDom)('page markup from the HTML bridge keeps no script, handler or unsafe link', () => {
    document.head.innerHTML = '<base href="http://localhost/">';
    const html = sanitizeRichHtml([
      '<p onmouseover="x()" style="background:url(javascript:x())">',
      '<a href=" JaVaScRiPt:alert(1)">js</a>',
      '<a href="data:text/html,<script>x()</script>">data</a>',
      '<a href="vbscript:x">vb</a>',
      '<a href="https://user:pw@example.test/ok" onclick="x()" target="_blank">ok</a>',
      '<img src="x" onerror="x()">',
      '<iframe srcdoc="<script>x()</script>"></iframe>',
      '<math><mi xlink:href="javascript:x()">m</mi></math>',
      '<script>x()</script>',
      '<!-- comment --><strong class="c" data-block-id="b">kept</strong>',
      '</p>',
      '<form action="https://evil.test"><input value="v"></form>',
    ].join(''))!;
    expect(html).toBe(
      '<p><a>js</a><a>data</a><a>vb</a><a href="https://example.test/ok">ok</a>m<strong>kept</strong></p>',
    );
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    for (const element of Array.from(parsed.body.querySelectorAll('*'))) {
      for (const attribute of Array.from(element.attributes)) {
        expect(['href', 'start', 'value', 'colspan', 'rowspan', 'scope', 'dir'])
          .toContain(attribute.name);
      }
    }
  });
});

describe('copyRichTextToClipboard', () => {
  test.skipIf(!hasDom)('copies plain text, reported too large, when HTML exceeds the output cap', async () => {
    const write = mock(async () => {});
    const writeText = mock(async (_text: string) => {});
    class TestClipboardItem {
      constructor(_items: Record<string, Blob>) {}
    }
    override(globalThis, 'ClipboardItem', TestClipboardItem);
    override(navigator, 'clipboard', { write, writeText });

    await expect(copyRichTextToClipboard('x'.repeat(MAX_RICH_CLIPBOARD_OUTPUT_LENGTH + 1), 'plain'))
      .resolves.toBe('too-large');
    expect(write).not.toHaveBeenCalled();
    expect(writeText).toHaveBeenCalledWith('plain');
  });

  test.skipIf(!hasDom)('writes both MIME formats through ClipboardItem', async () => {
    let captured: Record<string, Blob> | undefined;
    class TestClipboardItem {
      constructor(items: Record<string, Blob>) {
        captured = items;
      }
    }
    const write = mock(async () => {});
    override(globalThis, 'ClipboardItem', TestClipboardItem);
    override(navigator, 'clipboard', { write });
    const html = '<p><strong>rich</strong></p>';

    await expect(copyRichTextToClipboard(html, 'rich')).resolves.toBe('rich');

    expect(write).toHaveBeenCalledTimes(1);
    expect(captured?.['text/html']?.type).toBe('text/html');
    expect(await captured?.['text/html']?.text()).toBe(html);
    expect(captured?.['text/plain']?.type).toBe('text/plain');
    expect(await captured?.['text/plain']?.text()).toBe('rich');
  });

  test.skipIf(!hasDom)('rejected ClipboardItem write succeeds only if fallback writes both formats', async () => {
    const captured = new Map<string, string>();
    class TestClipboardItem {
      constructor(_items: Record<string, Blob>) {}
    }
    const write = mock(async () => {
      throw new Error('clipboard permission denied');
    });
    override(globalThis, 'ClipboardItem', TestClipboardItem);
    override(navigator, 'clipboard', { write });
    const execCommand = mock((command: string) => {
      if (command !== 'copy') return false;
      const event = new Event('copy', { cancelable: true }) as ClipboardEvent;
      Object.defineProperty(event, 'clipboardData', {
        value: { setData: (type: string, value: string) => captured.set(type, value) },
      });
      document.dispatchEvent(event);
      return event.defaultPrevented;
    });
    override(document, 'execCommand', execCommand);

    await expect(copyRichTextToClipboard('<p>rich</p>', 'plain')).resolves.toBe('rich');
    expect(write).toHaveBeenCalledTimes(1);
    expect(captured.get('text/html')).toBe('<p>rich</p>');
    expect(captured.get('text/plain')).toBe('plain');
    expect(execCommand).toHaveBeenCalledTimes(1);
  });

  test.skipIf(!hasDom)('the fallback copy event is the button\'s own: a page copy handler never sees it', async () => {
    override(navigator, 'clipboard', undefined);
    const captured = new Map<string, string>();
    const pageCopyHandler = mock((event: ClipboardEvent) => {
      event.clipboardData?.setData('text/plain', 'page handler text');
      event.preventDefault();
    });
    document.addEventListener('copy', pageCopyHandler);
    restorers.push(() => document.removeEventListener('copy', pageCopyHandler));
    override(document, 'execCommand', mock((command: string) => {
      if (command !== 'copy') return false;
      const event = new Event('copy', { cancelable: true, bubbles: true }) as ClipboardEvent;
      Object.defineProperty(event, 'clipboardData', {
        value: { setData: (type: string, value: string) => captured.set(type, value) },
      });
      document.body.dispatchEvent(event);
      return event.defaultPrevented;
    }));

    await expect(copyRichTextToClipboard('<p>rich</p>', 'plain')).resolves.toBe('rich');
    expect(pageCopyHandler).not.toHaveBeenCalled();
    expect(captured.get('text/plain')).toBe('plain');

    // Outside the button's call, the page's copy handler runs as before.
    document.body.dispatchEvent(new Event('copy', { bubbles: true }));
    expect(pageCopyHandler).toHaveBeenCalledTimes(1);
  });

  test.skipIf(!hasDom)('uses a text-only host clipboard honestly when rich clipboard is unsupported', async () => {
    const writeText = mock(async (_text: string) => {});
    override(navigator, 'clipboard', { writeText });
    override(document, 'execCommand', mock(() => false));

    await expect(copyRichTextToClipboard('<p>rich</p>', 'plain')).resolves.toBe('plain');
    expect(writeText).toHaveBeenCalledWith('plain');
  });

  test.skipIf(!hasDom)('legacy fallback reports success only when copy event accepts both formats', async () => {
    override(navigator, 'clipboard', undefined);
    const captured = new Map<string, string>();
    const execCommand = mock((command: string) => {
      if (command !== 'copy') return false;
      const event = new Event('copy', { cancelable: true }) as ClipboardEvent;
      Object.defineProperty(event, 'clipboardData', {
        value: { setData: (type: string, value: string) => captured.set(type, value) },
      });
      document.dispatchEvent(event);
      return event.defaultPrevented;
    });
    override(document, 'execCommand', execCommand);

    await expect(copyRichTextToClipboard('<p>rich</p>', 'plain')).resolves.toBe('rich');
    expect(captured.get('text/html')).toBe('<p>rich</p>');
    expect(captured.get('text/plain')).toBe('plain');
    expect(execCommand).toHaveBeenCalledTimes(1);
  });

  test.skipIf(!hasDom)('does not claim rich success when legacy copy event has no clipboardData, and restores selection', async () => {
    override(navigator, 'clipboard', undefined);
    const paragraph = document.createElement('p');
    paragraph.textContent = 'selected words';
    document.body.appendChild(paragraph);
    const range = document.createRange();
    range.setStart(paragraph.firstChild!, 0);
    range.setEnd(paragraph.firstChild!, 8);
    const selection = window.getSelection()!;
    selection.addRange(range);
    const focusOwner = document.createElement('button');
    focusOwner.textContent = 'focus owner';
    document.body.appendChild(focusOwner);
    focusOwner.focus();
    const otherFocus = document.createElement('button');
    otherFocus.textContent = 'other focus';
    document.body.appendChild(otherFocus);
    const execCommand = mock((command: string) => {
      if (command !== 'copy') return false;
      selection.removeAllRanges();
      otherFocus.focus();
      document.dispatchEvent(new Event('copy', { cancelable: true }));
      return true;
    });
    override(document, 'execCommand', execCommand);

    await expect(copyRichTextToClipboard('<p>selected</p>', 'selected')).resolves.toBe(false);
    expect(selection.toString()).toBe('selected');
    expect(document.activeElement).toBe(focusOwner);
    expect(execCommand).toHaveBeenCalledTimes(1);
  });

  test.skipIf(!hasDom)('an asynchronous source is handed to the clipboard as a promise within the click', async () => {
    let items: Record<string, Promise<Blob>> | undefined;
    class TestClipboardItem {
      constructor(value: Record<string, Promise<Blob>>) { items = value; }
    }
    const write = mock(async () => {
      await items!['text/html'];
    });
    override(globalThis, 'ClipboardItem', TestClipboardItem);
    override(navigator, 'clipboard', { write, writeText: mock(async () => {}) });
    let answer!: (source: { html: string; text: string }) => void;
    const pending = copyRichSelection(() => new Promise((resolve) => { answer = resolve; }), 'quote');
    // The write started before the markup arrived (it keeps the user gesture).
    expect(write).toHaveBeenCalledTimes(1);
    answer({ html: '<p><b>rich</b></p>', text: 'rich' });
    await expect(pending).resolves.toEqual({ copied: 'rich', truncatedTo: undefined });
    expect(await (await items!['text/html']).text()).toBe('<p><b>rich</b></p>');
    expect(await (await items!['text/plain']).text()).toBe('rich');
  });

  test.skipIf(!hasDom)('an asynchronous source with no usable markup still makes ONE write, plain text in both parts', async () => {
    const written: Array<Record<string, string>> = [];
    class TestClipboardItem {
      constructor(readonly items: Record<string, Promise<Blob>>) {}
    }
    const write = mock(async (items: TestClipboardItem[]) => {
      const out: Record<string, string> = {};
      // A rejected part would reject here, and Safari would copy nothing.
      for (const [type, blob] of Object.entries(items[0].items)) out[type] = await (await blob).text();
      written.push(out);
    });
    const writeText = mock(async (_text: string) => {});
    override(globalThis, 'ClipboardItem', TestClipboardItem);
    override(navigator, 'clipboard', { write, writeText });

    await expect(copyRichSelection(async () => ({ tooLarge: true, text: 'a < b' }), 'quote'))
      .resolves.toEqual({ copied: 'plain', reason: 'too-large', truncatedTo: undefined });
    await expect(copyRichSelection(async () => ({ html: '', text: 'no markup' }), 'quote'))
      .resolves.toEqual({ copied: 'plain', reason: 'no-markup', truncatedTo: undefined });
    await expect(copyRichSelection(async () => null, 'quote'))
      .resolves.toMatchObject({ copied: 'plain', reason: 'no-markup' });
    await expect(copyRichSelection(async () => { throw new Error('gone'); }, 'quote'))
      .resolves.toMatchObject({ copied: 'plain', reason: 'no-markup' });
    await expect(copyRichSelection(async () => ({ html: 'x'.repeat(MAX_RICH_CLIPBOARD_OUTPUT_LENGTH + 1), text: 'big' }), 'quote'))
      .resolves.toMatchObject({ copied: 'plain', reason: 'too-large' });
    await expect(copyRichSelection(async () => ({ html: '', text: 'cut', truncated: true }), 'quote'))
      .resolves.toEqual({ copied: 'plain', reason: 'no-markup', truncatedTo: 3 });

    expect(write).toHaveBeenCalledTimes(6);
    expect(writeText).not.toHaveBeenCalled();
    expect(written.map((w) => w['text/plain'])).toEqual(['a < b', 'no markup', 'quote', 'quote', 'big', 'cut']);
    expect(written[0]['text/html']).toBe('<pre>a &lt; b</pre>');
  });

  test.skipIf(!hasDom)('a builder that throws copies the fallback text as plain', async () => {
    const writeText = mock(async (_text: string) => {});
    override(navigator, 'clipboard', { writeText });
    await expect(copyRichSelection(() => { throw new Error('boom'); }, 'quote'))
      .resolves.toMatchObject({ copied: 'plain', reason: 'no-markup' });
    expect(writeText).toHaveBeenCalledWith('quote');
  });

  test('plain text in clipboard HTML is escaped; the tooltip says what was copied', () => {
    expect(plainTextClipboardHtml('<b>&"x"</b>')).toBe('<pre>&lt;b&gt;&amp;"x"&lt;/b&gt;</pre>');
    expect(richCopyOutcomeLabel({ copied: 'rich' })).toBe('Copied as rich text');
    expect(richCopyOutcomeLabel({ copied: 'plain', reason: 'unavailable' }))
      .toBe('Copied as plain text (rich clipboard unavailable)');
    expect(richCopyOutcomeLabel({ copied: 'plain', reason: 'no-markup', truncatedTo: 10_000 }))
      .toBe('Copied as plain text (formatting not available; first 10,000 characters only)');
  });
});
