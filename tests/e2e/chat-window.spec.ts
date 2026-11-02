/**
 * The shared chat window (packages/ui/components/chat) in a real browser, with
 * a real DOMPurify and V8's stack, which the DOM lanes cannot give. No app hosts
 * the window yet, so this bundles the package's own files into a bare page with
 * a host button and a host stylesheet. Text in either role is hostile here:
 * nothing it writes may run, load, reach the host's page or stop the host's
 * React root. No binary is needed.
 */
import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const UI = resolve(__dirname, '../../packages/ui');
let bundle = '';
let work = '';

test.beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'pn-chat-window-'));
  const entry = join(work, 'entry.ts');
  writeFileSync(entry, `
import { createElement as h } from ${JSON.stringify(join(UI, 'node_modules/react'))};
import { flushSync } from ${JSON.stringify(join(UI, 'node_modules/react-dom'))};
import { createRoot } from ${JSON.stringify(join(UI, 'node_modules/react-dom/client'))};
import { ChatComposer, ChatFrame, ChatTranscript, ChatWindowStore } from ${JSON.stringify(join(UI, 'components/chat/index.ts'))};

const reports: unknown[] = [];
const sent: string[] = [];
const store = new ChatWindowStore({ onGeometryChange: (geometry) => reports.push(geometry) });
const root = createRoot(document.getElementById('frame')!);
let messages: unknown[] = [];
let status = 'ready';
let richMarkdown = false;
function draw() {
  root.render(
    h('div', { id: 'host-tree', style: { position: 'absolute', inset: 0 } },
      h(ChatFrame, { store, label: 'Chat' }, () => [
        h(ChatTranscript, { key: 't', messages, status, agentName: 'Agent', richMarkdown }),
        h(ChatComposer, { key: 'c', value: 'hello', onChange: () => {}, onSend: () => sent.push('sent') }),
      ]),
    ),
  );
}
(window as any).__chat = {
  store, reports, sent,
  open() { flushSync(() => { store.setMinimized(false); draw(); }); },
  show(next: unknown[], nextStatus = 'ready') { flushSync(() => { messages = next; status = nextStatus; draw(); }); },
  rich() { flushSync(() => { richMarkdown = true; draw(); }); },
};
`);
  const out = join(work, 'bundle.js');
  execFileSync('bun', ['build', entry, '--outfile', out, '--target', 'browser', '--format', 'iife', '--define', 'process.env.NODE_ENV="production"'], { stdio: 'pipe' });
  bundle = readFileSync(out, 'utf8');
});

test.afterAll(() => {
  if (work) rmSync(work, { recursive: true, force: true });
});

/** A bare host. Its stylesheet has what agent text would reach for if a class got through. */
async function open(page: Page) {
  const seen = { requests: [] as string[], errors: [] as string[], dialogs: 0 };
  page.on('pageerror', (error) => seen.errors.push(error.message));
  page.on('dialog', (dialog) => {
    seen.dialogs += 1;
    void dialog.dismiss();
  });
  await page.setContent(`<!DOCTYPE html><html><head><style>
.fixed { position: fixed } .inset-0 { inset: 0 } .z-50 { z-index: 50 } .absolute { position: absolute }
#frame { position: fixed; inset: 0 } #host-button { position: fixed; left: 10px; top: 10px; z-index: 1 }
</style></head><body><button id="host-button">Host</button><div id="frame"></div></body></html>`);
  await page.addScriptTag({ content: bundle });
  page.on('request', (request) => seen.requests.push(request.url()));
  await page.evaluate(() => (window as any).__chat.open());
  return seen;
}

const say = (id: string, role: string, text: string, state?: 'streaming' | 'done') => ({
  id,
  role,
  parts: [{ type: 'text', text, state }],
});

/** Draw, and lay it out: most of what a huge DOM costs comes after the commit. */
const show = (page: Page, messages: unknown[], status = 'ready') =>
  page.evaluate(([next, nextStatus]) => {
    const started = performance.now();
    (window as any).__chat.show(next, nextStatus);
    document.querySelector('[data-chat-window]')?.getBoundingClientRect();
    return performance.now() - started;
  }, [messages, status] as const);

const hostStanding = (page: Page) => page.evaluate(() => document.getElementById('host-tree') !== null);

test('hostile text in either role comes out inert', async ({ page }) => {
  const seen = await open(page);
  const attacks = [
    '<script>window.__pwned = 1</script>',
    '<img src="https://evil.test/a.png" onerror="window.__pwned = 2">',
    '<iframe src="https://evil.test"></iframe><object data="https://evil.test"></object><embed src="https://evil.test">',
    '<form action="https://evil.test"><input name="a"><button>go</button></form>',
    '<style>#host-button { display: none }</style><link rel="stylesheet" href="https://evil.test/a.css">',
    '<p style="background:url(https://evil.test/x)" onclick="window.__pwned = 3" id="host-button">Hello</p>',
    '<svg onload="window.__pwned = 4"><script>window.__pwned = 5</script></svg>',
    '<details open ontoggle="window.__pwned = 6"><summary>s</summary></details>',
    '<base href="https://evil.test/"><meta http-equiv="refresh" content="0;url=https://evil.test">',
    '![tracker](https://evil.test/pixel.png)',
    '[click](javascript:window.__pwned=7)',
    '[click](JaVa\tScRiPt:window.__pwned=8)',
    '<a href="javascript:window.__pwned=9">x</a>',
    '<a href="data:text/html,<script>alert(1)</script>">x</a>',
    '<math><mtext><table><mglyph><style><img src=x onerror="window.__pwned=10"></style></mglyph></table></mtext></math>',
  ].join('\n\n');
  await show(page, [say('a', 'assistant', attacks), say('u', 'user', attacks)]);

  const found = await page.evaluate(() => {
    const parts = Array.from(document.querySelectorAll('[data-text-part] *'));
    return {
      pwned: (window as any).__pwned,
      tags: [...new Set(parts.map((el) => el.tagName.toLowerCase()))],
      attributes: [...new Set(parts.flatMap((el) => el.getAttributeNames()))],
      hrefs: parts.map((el) => el.getAttribute('href')).filter(Boolean) as string[],
    };
  });
  expect(found.pwned).toBeUndefined();
  expect(found.tags.filter((tag) => /script|img|iframe|object|embed|form|input|button|style|link|svg|math|base|meta|details/.test(tag))).toEqual([]);
  expect(found.attributes.filter((name) => !['href', 'target', 'rel', 'align'].includes(name))).toEqual([]);
  expect(found.hrefs.filter((href) => /^\s*(javascript|data):/i.test(href))).toEqual([]);
  expect(seen).toMatchObject({ requests: [], errors: [], dialogs: 0 });
});

// The DOM lanes walk a list, not a real NodeIterator, so what the sanitizer's hook
// does to a node mid-walk is only proved here. A hook that broke the walk would
// fail the rich proof, and then nothing below would draw.
test('with richMarkdown what Workspaces draws draws, and hostile text is still inert', async ({ page }) => {
  const seen = await open(page);
  await page.route('https://evil.test/**', (route) => route.abort());
  await page.route('https://images.test/**', (route) =>
    route.fulfill({
      contentType: 'image/png',
      body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64'),
    }),
  );
  await page.evaluate(() => (window as any).__chat.rich());
  const drawn = [
    '![a](https://images.test/a.png "Title")',
    '<img src="https://images.test/b.png" width="20" height="10" alt="b">',
    '~~gone~~',
    '- [ ] open\n- [x] done',
    '[x](https://images.test/c "Hint")',
    '7. seven\n8. eight',
  ].join('\n\n');
  const attacks = [
    '<script>window.__pwned = 1</script>',
    '<img src="https://evil.test/a.png" onerror="window.__pwned = 2" onload="window.__pwned = 3" class="fixed inset-0" style="position:fixed" data-text-part="" aria-hidden="true" id="host-button">',
    '<img src="javascript:window.__pwned = 4">',
    '<input type="text" name="q" autofocus onfocus="window.__pwned = 5">',
    '<input type="checkbox" onclick="window.__pwned = 6" id="host-button">',
    '<form action="https://evil.test"><input type="submit"><button>go</button></form>',
    '<iframe src="https://evil.test"></iframe>',
    '<svg onload="window.__pwned = 7"><script>window.__pwned = 8</script></svg>',
    '[click](javascript:window.__pwned=9)',
  ].join('\n\n');
  await show(page, [say('a', 'assistant', `${drawn}\n\n${attacks}`), say('u', 'user', `![p](https://images.test/p.png)\n\n${attacks}`)]);

  const agent = page.locator('[data-message-role="assistant"][data-text-part]');
  await expect(agent.locator('img[src="https://images.test/a.png"][alt="a"][title="Title"]')).toHaveCount(1);
  await expect(agent.locator('img[src="https://images.test/b.png"][width="20"][height="10"]')).toHaveCount(1);
  await expect(agent.locator('del')).toHaveText('gone');
  await expect(agent.locator('a[title="Hint"][target="_blank"]')).toHaveCount(1);
  await expect(agent.locator('ol[start="7"]')).toHaveCount(1);
  await expect(page.locator('[data-message-role="user"] img[src="https://images.test/p.png"]')).toHaveCount(1);
  const loaded = await agent.locator('img[src="https://images.test/a.png"]').evaluate((image: HTMLImageElement) => {
    return image.decode().then(() => image.naturalWidth);
  });
  expect(loaded).toBe(1);

  const found = await page.evaluate(() => {
    const parts = Array.from(document.querySelectorAll('[data-text-part] *'));
    return {
      pwned: (window as any).__pwned,
      tags: [...new Set(parts.map((el) => el.tagName.toLowerCase()))],
      attributes: [...new Set(parts.flatMap((el) => el.getAttributeNames()))],
      inputs: Array.from(document.querySelectorAll<HTMLInputElement>('[data-text-part] input')).map((el) => `${el.type}:${el.disabled}`),
      sources: Array.from(document.querySelectorAll('[data-text-part] img')).map((el) => el.getAttribute('src')),
    };
  });
  expect(found.pwned).toBeUndefined();
  expect(found.tags.filter((tag) => /script|iframe|form|button|style|svg/.test(tag))).toEqual([]);
  expect(found.attributes.filter((name) => !['href', 'target', 'rel', 'align', 'title', 'start', 'src', 'alt', 'width', 'height', 'type', 'checked', 'disabled'].includes(name))).toEqual([]);
  expect([...new Set(found.inputs)]).toEqual(['checkbox:true']);
  expect(found.sources.filter((address) => address?.startsWith('javascript:'))).toEqual([]);
  expect(seen.errors).toEqual([]);
  expect(seen.dialogs).toBe(0);
  expect(await page.evaluate(() => document.getElementById('host-button')?.tagName)).toBe('BUTTON');
});

test('agent text cannot lay a link over the host', async ({ page }) => {
  await open(page);
  await show(page, [
    say('a', 'assistant', '<a href="https://evil.test/phish" class="fixed inset-0 z-50"></a>\n\n<h1 class="fixed inset-0 z-50">Your session expired<br><a href="https://evil.test/phish" class="fixed inset-0 z-50">Sign in again</a></h1>'),
  ]);
  const top = await page.evaluate(() => {
    const { left, top: y } = document.getElementById('host-button')!.getBoundingClientRect();
    return document.elementFromPoint(left + 2, y + 2)?.id;
  });
  expect(top).toBe('host-button');
  expect(await page.locator('[data-text-part] [class]').count()).toBe(0);
});

test('agent text cannot pose as a message or a window', async ({ page }) => {
  await open(page);
  await show(page, [
    say('a', 'assistant', '<p data-text-part="" data-message-id="u1" data-message-role="user" data-annotatable="true" aria-hidden="true" data-chat-window data-chat-launcher>forged</p>'),
  ]);
  const part = page.locator('[data-text-part]');
  await expect(part).toHaveCount(1);
  await expect(part).toHaveAttribute('data-message-id', 'a');
  await expect(page.locator('[data-chat-window]')).toHaveCount(1);
  await expect(page.locator('[data-chat-launcher], [data-annotatable]')).toHaveCount(0);
  await expect(part).toContainText('forged');
});

test('a link in a message opens a new tab and leaves the host where it was', async ({ page, context }) => {
  await context.route('https://example.test/**', (route) => route.fulfill({ contentType: 'text/html', body: '<title>docs</title>' }));
  await open(page);
  await show(page, [say('a', 'assistant', '[the docs](https://example.test/docs)')]);
  const before = page.url();
  const link = page.locator('[data-text-part] a');
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  const [tab] = await Promise.all([context.waitForEvent('page'), link.click()]);
  await tab.waitForLoadState();
  expect(await tab.evaluate(() => window.opener)).toBeNull();
  expect(page.url()).toBe(before);
  expect(await hostStanding(page)).toBe(true);
});

test.describe('text that would stop the page', () => {
  const crashes: [string, string][] = [
    ['> in a row, past the stack', '>'.repeat(2_003)],
    ['nested quotes', '> '.repeat(2_003)],
    ['nested lists', `${'- '.repeat(1_271)}x`],
    ['nested ordered lists', `${'1. '.repeat(1_271)}x`],
    ['a large run of quotes', '> '.repeat(100_000)],
  ];
  for (const [name, text] of crashes) {
    for (const role of ['assistant', 'user']) {
      test(`${name}, as ${role}, leaves the host's tree standing`, async ({ page }) => {
        const seen = await open(page);
        await show(page, [say('a', role, text), say('b', 'user', 'still here')]);
        expect(await hostStanding(page)).toBe(true);
        await expect(page.locator('[data-chat-window]')).toContainText('still here');
        expect(seen.errors).toEqual([]);
      });
    }
  }

  const slow: [string, string][] = [
    ['inline markers', '_a'.repeat(100_000)],
    ['code ticks', '`a'.repeat(100_000)],
    ['spaced inline markers', '*a '.repeat(70_000)],
    ['nested lists', '- '.repeat(100_000)],
    ['a long word before an @', `${'a'.repeat(200_000)}@`],
    ['a www run', `www.a${'_'.repeat(200_000)}`],
    ['backslashes', '\\'.repeat(200_000)],
    ['words a sentence at a time', 'word *a _b `c '.repeat(18_000)],
  ];
  for (const [name, text] of slow) {
    test(`${name} draws in a bounded time`, async ({ page }) => {
      await open(page);
      const took = await show(page, [say('a', 'assistant', text)]);
      expect(took).toBeLessThan(3_000);
      expect(await hostStanding(page)).toBe(true);
    });
  }

  const table = (columns: number, rows: number) =>
    `${'| a '.repeat(columns)}|\n${'| - '.repeat(columns)}|\n${'x\n'.repeat(rows)}`;
  const tables: [string, string][] = [
    ['1M cells', table(500, 2_000)],
    ['2M cells', table(800, 2_500)],
    ['72M cells, which crashed the renderer', table(6_000, 12_000)],
    ['200M cells, which crashed the renderer', table(10_000, 20_000)],
    ['1M cells on lone carriage returns', table(500, 2_000).replaceAll('\n', '\r')],
  ];
  for (const [name, text] of tables) {
    test(`a table of ${name} goes out as text`, async ({ page }) => {
      await open(page);
      const took = await show(page, [say('a', 'assistant', text), say('b', 'user', 'still here')]);
      expect(took).toBeLessThan(1_000);
      await expect(page.locator('[data-text-part] td')).toHaveCount(0);
      await expect(page.locator('[data-chat-window]')).toContainText('still here');
    });
  }

  test('a reference link repeated thousands of times is not written out', async ({ page }) => {
    await open(page);
    const target = `[a]: https://example.test/${'a'.repeat(7_900)}\n\n`;
    for (const uses of ['[a] '.repeat(5_000), '[a] '.repeat(60_000), `${'[a] '.repeat(15_000)}\n\n`.repeat(4)]) {
      const took = await show(page, [say('a', 'assistant', target + uses)]);
      expect(took).toBeLessThan(3_000);
      await expect(page.locator('[data-text-part] a')).toHaveCount(0);
    }
  });

  const openTags = (open: number) => Array.from({ length: open }, (_, index) => `<strong a=${index}>`).join('');
  const unreadable = (open: number) => Array.from({ length: open }, (_, index) => `<strong !a${index}>`).join('');
  const rawHtml: [string, string][] = [
    ['open tags rebuilt in each paragraph, 27 KB', `<div>${openTags(300)}</div>${'<p>x</p>'.repeat(3_000)}`],
    ['open tags rebuilt in each paragraph, 92 KB', `<div>${openTags(1_000)}</div>${'<p>x</p>'.repeat(10_000)}`],
    ['nested links', `<div>${'<a href=x><div>'.repeat(15_000)}`],
    ['unknown tags', `<div>${'<x>'.repeat(80_000)}`],
    ['nested tables', `<div>${'<table><tr><td>'.repeat(15_000)}`],
    ['svg titles', `<div>${'<svg><title>'.repeat(18_000)}`],
    // A tag `marked` cannot read is text to it, and a real tag to a browser.
    ['unreadable tags after an inline tag, 22 KB', `x <code>${unreadable(300)}${'<p !>x'.repeat(3_000)}`],
    ['unreadable tags after an inline tag, 74 KB', `x <kbd>${unreadable(1_000)}${'<p !>x'.repeat(10_000)}`],
    ['unreadable links over paragraphs', `x <code>\n\n${`${'<a href=x !><div !>'.repeat(1_000)}\n\n`.repeat(11)}`],
    ['unreadable svg titles over paragraphs', `x <pre>\n\n${`${'<svg !><title !>'.repeat(1_000)}\n\n`.repeat(14)}`],
  ];
  for (const [name, text] of rawHtml) {
    test(`raw HTML of ${name} is words on the page`, async ({ page }) => {
      await open(page);
      const took = await show(page, [say('a', 'assistant', text), say('b', 'user', 'still here')]);
      expect(took).toBeLessThan(1_000);
      // Text with no spaces gets a <wbr> every so often. Those are ours, not the source's.
      expect(await page.locator('[data-text-part] *:not(wbr)').count()).toBeLessThan(20);
      await expect(page.locator('[data-chat-window]')).toContainText('still here');
    });
  }

  const longBlocks: [string, string][] = [
    ['a long line that mixes scripts', '*字'.repeat(127_500)],
    ['a long line that mixes directions', 'سa'.repeat(127_500)],
    ['the same, soft wrapped', Array.from({ length: 1_500 }, () => 'سa'.repeat(80)).join('\n')],
    ['the same, in a code block', `\`\`\`\n${'سa'.repeat(127_500)}\n\`\`\`\n`],
    ['the same, in a block of raw HTML', `<div>${'سa'.repeat(127_000)}</div>\n`],
    ['the same, past the length limit', 'سa'.repeat(500_000)],
    ['the same, in lines of plain text', Array.from({ length: 6_000 }, () => 'سa'.repeat(80)).join('\n')],
  ];
  for (const [name, text] of longBlocks) {
    test(`${name} draws in a bounded time, with its words`, async ({ page }) => {
      await open(page);
      const took = await show(page, [say('a', 'assistant', text), say('b', 'user', 'still here')]);
      // Plain text stays linear: a megabyte of it costs four times these, and a CI runner is slower.
      expect(took).toBeLessThan(text.length < 300_000 ? 3_000 : 10_000);
      await expect(page.locator('[data-text-part]').first()).toContainText(text.slice(8, 40));
      await expect(page.locator('[data-chat-window]')).toContainText('still here');
    });
  }

  test('a line of nothing but line ends draws a bounded number of elements', async ({ page }) => {
    await open(page);
    const took = await show(page, [say('a', 'assistant', '\n'.repeat(3_000_000))]);
    expect(took).toBeLessThan(3_000);
    expect(await hostStanding(page)).toBe(true);
  });
});

test.describe('a stream', () => {
  const delta = (page: Page, text: string, state: 'streaming' | 'done') =>
    show(page, [say('a', 'assistant', text, state)], state === 'streaming' ? 'streaming' : 'ready');

  const square = (side: number) =>
    `|${' a |'.repeat(side)}\n|${' - |'.repeat(side)}\n${`|${' b |'.repeat(side)}\n`.repeat(side)}`;
  // The last says how it ends: a table of 300 by 300 is past the limit for good.
  const costly: [string, string, string, number][] = [
    ['a very wide table', `${'|a'.repeat(33_000)}\n${'|-'.repeat(33_000)}\n`, 'th', 33_000],
    ['a table of 200 by 200', square(200), 'tbody tr', 200],
    ['a table of 300 by 300', square(300), 'tbody tr', 0],
    ['many short paragraphs', 'x\n\n'.repeat(80_000), 'p + p', 79_999],
  ];
  for (const [name, text, element, atTheEnd] of costly) {
    test(`of ${name} does not pay its draw on every delta`, async ({ page }) => {
      await open(page);
      await delta(page, text, 'streaming');
      const later: number[] = [];
      for (let more = 1; more <= 6; more += 1) later.push(await delta(page, `${text}${'word '.repeat(more)}`, 'streaming'));
      expect(Math.max(...later)).toBeLessThan(50);
      await expect(page.locator(`[data-text-part] ${element}`)).toHaveCount(0);
      await delta(page, text, 'done');
      await expect(page.locator(`[data-text-part] ${element}`)).toHaveCount(atTheEnd);
    });
  }

  test('of a long plain answer stops growing its cost per delta', async ({ page }) => {
    await open(page);
    const text = 'A normal sentence of ordinary words.\n\n'.repeat(12_000);
    const average = async (size: number) => {
      let total = 0;
      for (let step = 1; step <= 20; step += 1) total += await delta(page, text.slice(0, size + step * 32), 'streaming');
      return total / 20;
    };
    const atTheCeiling = await average(200_000);
    expect(await average(240_000)).toBeLessThan(atTheCeiling / 2);
    expect(await average(400_000)).toBeLessThan(atTheCeiling / 2);
    expect(await hostStanding(page)).toBe(true);
  });

  for (const [name, text] of [
    ['one long line that mixes scripts', '*字'.repeat(50_000)],
    ['one long line that mixes directions', 'سa'.repeat(50_000)],
  ]) {
    test(`of ${name} does not pay its draw on every delta`, async ({ page }) => {
      await open(page);
      await delta(page, text, 'streaming');
      const later: number[] = [];
      for (let more = 1; more <= 6; more += 1) later.push(await delta(page, `${text}${'a'.repeat(more)}`, 'streaming'));
      expect(Math.max(...later)).toBeLessThan(50);
    });
  }

  test('keeps its hold when a person sends while it runs', async ({ page }) => {
    await open(page);
    const text = square(300);
    const asked = say('b', 'user', 'And one more thing');
    await delta(page, text, 'streaming');
    const later: number[] = [];
    for (let more = 1; more <= 6; more += 1) {
      later.push(await show(page, [say('a', 'assistant', `${text}${'word '.repeat(more)}`, 'streaming'), asked], 'streaming'));
    }
    expect(Math.max(...later)).toBeLessThan(50);
    await expect(page.locator('[data-chat-pending]')).toHaveCount(0);
  });

  test('that ends with its part still streaming draws what arrived', async ({ page }) => {
    await open(page);
    await page.evaluate(() => {
      const real = Date.now;
      let now = 0;
      Date.now = () => (now += 1_000);
      (window as any).__chat.show([{ id: 'a', role: 'assistant', parts: [{ type: 'text', text: '**one**', state: 'streaming' }] }], 'streaming');
      Date.now = real;
    });
    await expect(page.locator('[data-text-part] strong')).toHaveCount(0);
    await show(page, [say('a', 'assistant', '**one**', 'streaming')], 'ready');
    await expect(page.locator('[data-text-part] strong')).toHaveCount(1);
  });

  test('that ends under reduced motion keeps its partial text', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await open(page);
    await show(page, [say('u', 'user', 'Why?'), say('a', 'assistant', 'Half a sent', 'streaming')], 'streaming');
    await expect(page.locator('[data-chat-window]')).not.toContainText('Half a sent');
    await show(page, [say('u', 'user', 'Why?'), say('a', 'assistant', 'Half a sent', 'streaming')], 'error');
    await expect(page.locator('[data-chat-window]')).toContainText('Half a sent');
  });

  test('that spends its budget pays once, not on every delta', async ({ page }) => {
    await open(page);
    const text = '**a '.repeat(60_000);
    await delta(page, text.slice(0, 200_000), 'streaming');
    const later: number[] = [];
    for (let size = 200_064; size < 200_640; size += 64) later.push(await delta(page, text.slice(0, size), 'streaming'));
    expect(Math.max(...later)).toBeLessThan(150);
    await expect(page.locator('[data-text-part] strong')).toHaveCount(0);
  });

  test('that lost its budget to a busy page ends formatted', async ({ page }) => {
    await open(page);
    await page.evaluate(() => {
      const real = Date.now;
      let now = 0;
      Date.now = () => (now += 1_000);
      (window as any).__chat.show([{ id: 'a', role: 'assistant', parts: [{ type: 'text', text: '**one**', state: 'streaming' }] }], 'streaming');
      Date.now = real;
    });
    await expect(page.locator('[data-text-part] strong')).toHaveCount(0);
    await delta(page, '**one** and **two**', 'streaming');
    await expect(page.locator('[data-text-part] strong')).toHaveCount(0);
    await delta(page, '**one** and **two**', 'done');
    await expect(page.locator('[data-text-part] strong')).toHaveCount(2);
  });
});

test('a long ordinary answer stays markdown', async ({ page }) => {
  await open(page);
  const answer = 'A sentence with **weight** and `code` in it.\n\n- a point\n- another\n\n'.repeat(1_000);
  await show(page, [say('a', 'assistant', answer)]);
  await expect(page.locator('[data-text-part] strong')).toHaveCount(1_000);
});

test.describe('a long line in an ordinary message', () => {
  const intro = '## Result\n\nThe **cause**:\n\n- one\n\n';
  const lines: [string, string][] = [
    ['a fence holding minified JSON', `${intro}\`\`\`json\n{"k":"${'a'.repeat(8_100)}"}\n\`\`\`\n`],
    ['a long URL', `${intro}See https://example.test/${'b'.repeat(8_100)} for it.\n`],
    ['a paragraph of Chinese with no spaces', `${intro}${'这是一个很长的段落。'.repeat(810)}\n`],
  ];
  for (const [name, text] of lines) {
    test(`${name} leaves the rest formatted`, async ({ page }) => {
      await open(page);
      await show(page, [say('a', 'assistant', text)]);
      await expect(page.locator('[data-text-part] h2')).toHaveText('Result');
      await expect(page.locator('[data-text-part] strong')).toHaveText('cause');
    });
  }

  const prose = 'A line of ordinary prose.\n'.repeat(120);
  const pipes: [string, string][] = [
    ['a fenced line of pipes', `\`\`\`\n${'|'.repeat(1_200)}\n\`\`\`\n`],
    ['fenced minified code', `\`\`\`js\n${'a||b;'.repeat(4_200)}\n\`\`\`\n`],
  ];
  for (const [name, fence] of pipes) {
    test(`${name} leaves the rest formatted`, async ({ page }) => {
      await open(page);
      await show(page, [say('a', 'assistant', `## Title\n\n**bold**\n\n${prose}\n${fence}`)]);
      await expect(page.locator('[data-text-part] h2')).toHaveText('Title');
      await expect(page.locator('[data-text-part] strong')).toHaveText('bold');
    });
  }

  test('a fence an HTML block swallows cannot hide a long word', async ({ page }) => {
    await open(page);
    const took = await show(page, [say('a', 'assistant', `<div>\n\`\`\`\n\n${'a'.repeat(200_000)}@\n`)]);
    expect(took).toBeLessThan(3_000);
    expect(await hostStanding(page)).toBe(true);
  });
});

test.describe('the window against a real frame', () => {
  const frameSize = (page: Page, width: number, height: number) => page.setViewportSize({ width, height });
  const box = (page: Page) => page.locator('[data-chat-window]').boundingBox();

  test('a brief narrow frame leaves the chosen size, and nothing is reported', async ({ page }) => {
    await frameSize(page, 1400, 900);
    await open(page);
    await page.evaluate(() => (window as any).__chat.store.restore({ w: 800, h: 700, right: 100, bottom: 100 }));
    await expect.poll(async () => (await box(page))?.width).toBe(800);

    await frameSize(page, 340, 900);
    await expect.poll(async () => (await box(page))?.width).toBe(340);
    await frameSize(page, 700, 500);
    await expect.poll(async () => (await box(page))?.width).toBe(668);
    await frameSize(page, 1400, 900);
    await expect.poll(async () => (await box(page))?.width).toBe(800);

    expect(await page.evaluate(() => (window as any).__chat.store.geometry())).toEqual({ w: 800, h: 700, right: 100, bottom: 100 });
    expect(await page.evaluate(() => (window as any).__chat.reports)).toEqual([]);
  });

  test('a drag with a real mouse can come back to where it started', async ({ page }) => {
    await frameSize(page, 1000, 700);
    await open(page);
    const start = await box(page);
    const x = start!.x + 120;
    const y = start!.y + 14;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x - 200, y - 100);
    await page.mouse.move(x, y);
    await page.mouse.up();
    expect(await page.evaluate(() => (window as any).__chat.store.geometry())).toEqual({ w: 420, h: 560, right: 16, bottom: 16 });
  });

  test('a drag the system cancels goes back to its start', async ({ page }) => {
    await frameSize(page, 1000, 700);
    await open(page);
    const start = await box(page);
    const x = start!.x + 120;
    const y = start!.y + 14;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x - 150, y - 80);
    await page.locator('[data-chat-drag-handle]').dispatchEvent('pointercancel', { pointerId: 1, bubbles: true });
    await page.mouse.up();
    expect(await page.evaluate(() => (window as any).__chat.store.geometry())).toEqual({ w: 420, h: 560, right: 16, bottom: 16 });
  });

  test('Home on the grip from the top-left corner keeps the window on the frame', async ({ page }) => {
    await frameSize(page, 1000, 700);
    await open(page);
    await page.evaluate(() => (window as any).__chat.store.restore({ w: 360, h: 420, right: 640, bottom: 280 }));
    await page.locator('[data-chat-resize-grip]').focus();
    await page.keyboard.press('Home');
    await expect.poll(async () => (await box(page))?.height).toBe(560);
    const after = await box(page);
    expect(after!.x).toBeGreaterThanOrEqual(0);
    expect(after!.y).toBeGreaterThanOrEqual(0);
  });

  test('the right button does not drag', async ({ page }) => {
    await frameSize(page, 1200, 800);
    await open(page);
    const start = await box(page);
    await page.mouse.move(start!.x + 80, start!.y + 16);
    await page.mouse.down({ button: 'right' });
    await page.mouse.move(start!.x - 100, start!.y - 100);
    await page.mouse.up({ button: 'right' });
    expect(await box(page)).toEqual(start);
  });

  test("Safari's Enter after a composition does not send", async ({ page }) => {
    await open(page);
    await page.locator('[data-chat-window] textarea').evaluate((field) => {
      field.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true, cancelable: true } as KeyboardEventInit));
    });
    expect(await page.evaluate(() => (window as any).__chat.sent)).toEqual([]);
  });
});
