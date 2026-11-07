// Pictures of the change view for the owner's look, light and dark at 1440x900,
// from the demo page (bun run demo). Not a test.
//   SYSTEM_URL=http://127.0.0.1:<port>  OUT=<folder>  CHROMIUM=<executable>  node scripts/shots-change.mjs
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const URL = process.env.SYSTEM_URL || 'http://127.0.0.1:5893';
const OUT = process.env.OUT || path.resolve('shots');
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null;
fs.mkdirSync(OUT, { recursive: true });

const SHOTS = [
  ['card-2543', '?shot=card&pr=2543'],
  ['card-2563', '?shot=card&pr=2563'],
  ['card-gate-2543', '?shot=card&pr=2543&gate=1'],
  ['view-2543-after', '?shot=change&pr=2543&view=after'],
  ['view-2543-before', '?shot=change&pr=2543&view=before'],
  ['view-2543-steps', '?shot=change&pr=2543&view=steps'],
  ['view-2563-after', '?shot=change&pr=2563&view=after'],
  ['view-2563-before', '?shot=change&pr=2563&view=before'],
  ['view-2563-steps', '?shot=change&pr=2563&view=steps'],
  ['view-2563-open-after', '?shot=change&open=1&view=after'],
  ['view-2563-open-before', '?shot=change&open=1&view=before'],
  ['view-gate-2563', '?shot=change&pr=2563&gate=1'],
  ['view-removes-after', '?shot=change&removes=1&view=after'],
  ['plan', '?shot=plan'],
];

// The inks' contrast, measured in the page: a marked part's name against its box (the wash
// composited over the paper), and a marked line's label against the paper. WCAG ratio; text
// wants 4.5, a line or a box edge 3. CONTRAST=1 prints them.
const contrast = () => {
  const cv = document.createElement('canvas'); cv.width = cv.height = 1;
  const g = cv.getContext('2d', { willReadFrequently: true });
  const px = (...fills) => { g.clearRect(0, 0, 1, 1); for (const f of fills) { g.fillStyle = f; g.fillRect(0, 0, 1, 1); } return [...g.getImageData(0, 0, 1, 1).data].slice(0, 3); };
  const lum = (c) => { const [r, gg, b] = c.map((v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * gg + 0.0722 * b; };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return Math.round(((x + 0.05) / (y + 0.05)) * 100) / 100; };
  const paper = getComputedStyle(document.querySelector('.sys-stage, .sys-cpic-frame') ?? document.body).backgroundColor;
  const page = getComputedStyle(document.body).backgroundColor;
  const out = {};
  for (const st of ['added', 'changed', 'removed']) {
    const part = document.querySelector(`.sys-part.sys-st-${st}`);
    if (part) {
      const box = getComputedStyle(part.querySelector('.sys-pv')).backgroundColor;
      const bg = px(page, paper, box);
      out[`name-${st}`] = ratio(px(getComputedStyle(part.querySelector('.sys-nm')).color), bg);
      out[`edge-${st}`] = ratio(px(getComputedStyle(part.querySelector('.sys-pv')).borderTopColor), px(page, paper));
    }
    const lb = document.querySelector(`.sys-elabel.sys-st-${st}`);
    if (lb) out[`label-${st}`] = ratio(px(getComputedStyle(lb).color), px(page, paper));
    const row = document.querySelector(`.sys-plist-row[data-status="${st}"] .sys-plist-name`);
    if (row) out[`row-${st}`] = ratio(px(getComputedStyle(row).color), px(page, getComputedStyle(row.closest('.sys-aside') ?? document.body).backgroundColor));
  }
  return out;
};

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined, headless: true });
const errors = [];
for (const mode of ['light', 'dark']) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: mode });
  for (const [name, q] of SHOTS) {
    if (ONLY && !ONLY.has(name)) continue;
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`${name} ${mode}: ${e.message}`));
    await page.goto(`${URL}/${q}&mode=${mode}`);
    await page.waitForSelector('body[data-ready="1"]', { timeout: 20000 });
    await page.waitForTimeout(900);
    if (process.env.PICK && name.startsWith('view-')) {
      const row = page.locator('.sys-plist-pick').nth(Number(process.env.PICK));
      if (await row.count()) await row.click();
      await page.waitForTimeout(700);
    }
    if (process.env.CONTRAST) console.log(name, mode, JSON.stringify(await page.evaluate(contrast)));
    await page.screenshot({ path: path.join(OUT, `${name}-${mode}.png`) });
    await page.close();
  }
  await ctx.close();
}
await browser.close();
if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
else console.log('ok', OUT);
