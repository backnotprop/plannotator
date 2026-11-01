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
function draw() {
  root.render(
    h('div', { id: 'host-tree', style: { position: 'absolute', inset: 0 } },
      h(ChatFrame, { store, label: 'Chat' }, () => [
        h(ChatTranscript, { key: 't', messages, status: 'ready', agentName: 'Agent' }),
        h(ChatComposer, { key: 'c', value: 'hello', onChange: () => {}, onSend: () => sent.push('sent') }),
      ]),
    ),
  );
}
(window as any).__chat = {
  store, reports, sent,
  open() { flushSync(() => { store.setMinimized(false); draw(); }); },
  show(next: unknown[]) { flushSync(() => { messages = next; draw(); }); },
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

const say = (id: string, role: string, text: string) => ({ id, role, parts: [{ type: 'text', text }] });

const show = (page: Page, messages: unknown[]) =>
  page.evaluate((next) => {
    const started = performance.now();
    (window as any).__chat.show(next);
    return performance.now() - started;
  }, messages);

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
});

test('a long ordinary answer stays markdown', async ({ page }) => {
  await open(page);
  const answer = 'A sentence with **weight** and `code` in it.\n\n- a point\n- another\n\n'.repeat(1_000);
  await show(page, [say('a', 'assistant', answer)]);
  await expect(page.locator('[data-text-part] strong')).toHaveCount(1_000);
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
