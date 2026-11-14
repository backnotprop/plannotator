/**
 * An author's text colour (#3345) through the real DOMPurify in a real
 * browser (happy-dom cannot host DOMPurify, so no unit test can prove this):
 * a `<span style="color: …">` or `<font color>` keeps a colour written as
 * `style="color: <value>"` from the parsed value, on a span; every other
 * style, a style on any other tag, and every hostile value is dropped with
 * the words kept. Then the readability pass: a dark red on a dark card is
 * lightened to 3:1 with its hue kept, an already readable colour is left as
 * written. Bundles the modules for the browser into a blank page; no server,
 * no binary.
 */
import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const sanitizeModule = resolve(__dirname, '../../packages/ui/utils/sanitizeHtml.ts');
const contrastModule = resolve(__dirname, '../../packages/ui/utils/authorColorContrast.ts');
const colorModule = resolve(__dirname, '../../packages/ui/utils/authorColor.ts');

const HOSTILE = [
  'color: red; background: url(//evil.test/x.png)',
  'color:red;position:fixed',
  'color: expression(alert(1))',
  'color: var(--x)',
  'color: url(//evil.test)',
  'c\\6f lor: red',
  'color: \\72 ed',
  'color: red /* c */',
  'color: red !important',
  'color: rgb(calc(1),0,0)',
  'color: rgb(1,2,3',
  'background: red',
  'position: fixed; inset: 0; z-index: 9999',
  `color: ${'a'.repeat(10_240)}`,
];

test.beforeEach(async ({ page }) => {
  const dir = mkdtempSync(join(tmpdir(), 'author-color-'));
  const entry = join(dir, 'entry.ts');
  const out = join(dir, 'bundle.js');
  writeFileSync(entry, `import { sanitizeBlockHtml, sanitizeInlineHtml } from ${JSON.stringify(sanitizeModule)};
import { paintAuthorColor } from ${JSON.stringify(contrastModule)};
import { parseAuthorColor } from ${JSON.stringify(colorModule)};
const styles = (html: string) => { const d = document.createElement('div'); d.innerHTML = html; return Array.from(d.querySelectorAll('[style]')).map((el) => el.tagName.toLowerCase() + '|' + el.getAttribute('style')); };
(window as any).block = (h: string) => { const html = sanitizeBlockHtml(h); return { html, styles: styles(html) }; };
(window as any).inline = (h: string) => sanitizeInlineHtml(h);
(window as any).paint = (bg: string, value: string) => {
  const card = document.createElement('div'); card.style.background = bg; card.style.transition = 'none';
  const span = document.createElement('span'); span.textContent = 'x'; span.style.color = value; card.append(span); document.body.append(card);
  paintAuthorColor(span, parseAuthorColor(value)!);
  const read = (c: string) => { const ctx = document.createElement('canvas').getContext('2d')!; ctx.fillStyle = c; ctx.fillRect(0, 0, 1, 1); return Array.from(ctx.getImageData(0, 0, 1, 1).data.slice(0, 3)); };
  return { fg: read(getComputedStyle(span).color), bg: read(getComputedStyle(card).backgroundColor) };
};`);
  execFileSync('bun', ['build', entry, '--target=browser', '--define', 'process.env.NODE_ENV="production"', '--outfile', out]);
  await page.setContent('<body></body>');
  await page.addScriptTag({ path: out });
});

type Block = { html: string; styles: string[] };
const block = (page: import('@playwright/test').Page, html: string) => page.evaluate((h) => (window as any).block(h) as Block, html);

test('a coloured span and font keep only a normalized colour', async ({ page }) => {
  expect((await block(page, '<p>Coverage <span style="COLOR:#D00000;">73.0%</span></p>')).html).toBe('<p>Coverage <span style="color: #d00000">73.0%</span></p>');

  const font = await block(page, '<p><font color="green" face="Comic Sans" size="7">ok</font> <font color=hsl(30,100%,45%)>amber</font></p>');
  expect(font.html).not.toContain('<font');
  expect(font.styles).toEqual(['span|color: green', 'span|color: hsl(30, 100%, 45%)']);

  const nested = await block(page, '<div><font color="red">a <font color="blue">b</font> <span style="color: lime">c</span></font></div>');
  expect(nested.html).not.toContain('<font');
  expect(nested.styles).toEqual(['span|color: red', 'span|color: blue', 'span|color: lime']);

  expect((await block(page, '<p><font color="url(//evil.test)">x</font><font size="7">y</font></p>')).html).toBe('<p>xy</p>');
  expect((await block(page, '<span style="  Color :  RGB( 0 , 128 , 0 ) ; ">w</span>')).styles).toEqual(['span|color: rgb(0, 128, 0)']);
});

test('hostile styles are dropped whole and the words kept', async ({ page }) => {
  for (const hostile of HOSTILE) {
    const out = await block(page, `<p><span style="${hostile}">words</span></p>`);
    expect([hostile.slice(0, 40), out.styles]).toEqual([hostile.slice(0, 40), []]);
    expect(out.html).toContain('words');
  }
  const handlers = await block(page, '<span style="color: red" class="x" id="y" onclick="alert(1)">a<script>alert(1)</script><img src=x onerror=alert(1)></span>');
  expect(handlers.html).not.toMatch(/script|onerror|onclick|class=|id=/);
  expect(handlers.styles).toEqual(['span|color: red']);
});

test('a see-through colour is refused in every alpha form, so a caller that never paints shows the words', async ({ page }) => {
  for (const faint of ['#0000', '#ffffff00', 'rgba(255,255,255,0.02)', 'rgb(0 0 0 / 0)', 'rgb(0 0 0 / 10%)', 'hsla(0,100%,50%,0.01)', 'hsl(0 0% 0% / .4)']) {
    const span = await block(page, `<p>a <span style="color:${faint}">hidden</span> b</p>`);
    expect([faint, span.styles, span.html]).toEqual([faint, [], '<p>a <span>hidden</span> b</p>']);
    const font = await block(page, `<p>a <font color="${faint}">hidden</font> b</p>`);
    expect([faint, font.html]).toEqual([faint, '<p>a hidden b</p>']);
    const inline = await page.evaluate((f) => (window as any).inline(`<span style="color:${f}">hidden</span>`), faint);
    expect([faint, inline]).toEqual([faint, '<span>hidden</span>']);
  }
  expect((await block(page, '<p><span style="color: rgba(208, 0, 0, 0.5)">half</span></p>')).styles).toEqual(['span|color: rgba(208, 0, 0, 0.5)']);
});

test('style on every other tag stays stripped, even a pure colour', async ({ page }) => {
  for (const tag of ['p', 'div', 'td', 'a', 'strong', 'mark', 'img', 'table', 'details', 'summary', 'li']) {
    const out = await block(page, `<table><tr><td><${tag} style="color: red">w</${tag}></td></tr></table>`);
    expect([tag, out.styles]).toEqual([tag, []]);
  }
  expect(await page.evaluate(() => (window as any).inline('<span style="color: red; top: 0">a</span><span style="color: teal">b</span>'))).toBe('<span>a</span><span style="color: teal">b</span>');
});

test('HTML with no colour comes out as it always did', async ({ page }) => {
  const out = await block(page, '<details open><summary>More</summary>\n\n**bun** <a href="https://x.test" title="t">x</a>\n\n</details>');
  expect(out.html).toBe('<details open=""><summary>More</summary>\n\n<p><strong>bun</strong> <a href="https://x.test" title="t">x</a></p>\n</details>');
});

test('an unreadable colour is lightened or darkened to 3:1, a readable one is left alone', async ({ page }) => {
  const luminance = ([r, g, b]: number[]) => {
    const ch = (c: number) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
  };
  const ratio = (a: number[], b: number[]) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  type Painted = { fg: number[]; bg: number[] };
  const paint = (bg: string, value: string) => page.evaluate(([b, v]) => (window as any).paint(b, v) as Painted, [bg, value]);

  // An oklch card, as the themes write them: read through the canvas.
  const dark = await paint('oklch(0.21 0.01 260)', '#5a0000');
  expect(ratio(dark.fg, dark.bg)).toBeGreaterThanOrEqual(3);
  expect(dark.fg[0]).toBeGreaterThan(dark.fg[1]);
  expect(dark.fg[1]).toBe(dark.fg[2]);

  const light = await paint('#ffffff', 'yellow');
  expect(ratio(light.fg, light.bg)).toBeGreaterThanOrEqual(3);

  const kept = await paint('#ffffff', '#d00000');
  expect(kept.fg).toEqual([208, 0, 0]);
});
