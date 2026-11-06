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
  ['plan', '?shot=plan'],
];

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
    await page.screenshot({ path: path.join(OUT, `${name}-${mode}.png`) });
    await page.close();
  }
  await ctx.close();
}
await browser.close();
if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
else console.log('ok', OUT);
