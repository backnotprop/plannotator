import { expect, test, type Page } from '@playwright/test';
import { injectPrintDefaults, hasHostThemeOptIn } from '../../packages/ui/components/html-viewer/srcdoc';

const MARKER = '<meta name="plannotator-theme" content="host">';
const para = (n: number) => `<p>Paragraph ${n}: ${'words that fill the line '.repeat(8)}</p>`;

const APP_SHELL = `<!doctype html><html><head><title>Shell</title>
<style>html, body { height: 100vh; overflow: hidden; margin: 0; } main { padding: 24px; }</style>
</head><body><main>${Array.from({ length: 60 }, (_, i) => para(i + 1)).join('')}</main></body></html>`;

const EXPLAINER = `<!doctype html><html><head>${MARKER}<title>Explainer</title></head><body>${
  Array.from({ length: 8 }, (_, i) => `<section><h2>Part ${i + 1}</h2>${para(i)}</section>`).join('')
}</body></html>`;

const FAQ = `<!doctype html><html><head><title>FAQ</title></head><body>${
  Array.from({ length: 30 }, (_, i) => `<section><h3>Question ${i + 1}?</h3><p>Short answer ${i + 1}.</p></section>`).join('')
}</body></html>`;

const framed = (html: string) => injectPrintDefaults(html, { sectionBreaks: hasHostThemeOptIn(html) });

async function sheets(page: Page, html: string): Promise<number> {
  await page.setContent(html);
  const pdf = (await page.pdf({ format: 'A4' })).toString('latin1');
  return pdf.match(/\/Type\s*\/Page\b(?!s)/g)?.length ?? 0;
}

test('an app-shell page prints all of its content, not one clipped sheet', async ({ page }) => {
  expect(await sheets(page, APP_SHELL)).toBe(1);
  expect(await sheets(page, framed(APP_SHELL))).toBeGreaterThan(2);
});

test('a marked explainer starts each of its 8 sections on a new sheet', async ({ page }) => {
  expect(await sheets(page, framed(EXPLAINER))).toBe(8);
});

test('an unmarked page of 30 short sections is not printed one per sheet', async ({ page }) => {
  expect(await sheets(page, framed(FAQ))).toBeLessThan(5);
});

const CROSSING = `<!doctype html><html><head><title>Report</title></head><body>${
  Array.from({ length: 8 }, (_, i) => para(i)).join('')
}<pre>${Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join('\n')}</pre><table>${
  Array.from({ length: 15 }, (_, i) => `<tr><td>row ${i + 1}</td><td>value</td></tr>`).join('')
}</table></body></html>`;

test('an unmarked page with a <pre> across a page prints on as many sheets as the raw page', async ({ page }) => {
  const raw = await sheets(page, CROSSING);
  expect(raw).toBeGreaterThan(1);
  expect(await sheets(page, framed(CROSSING))).toBe(raw);
});
