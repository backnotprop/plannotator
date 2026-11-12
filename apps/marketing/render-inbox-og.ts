import { chromium } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const template = new URL('./inbox-og.html', import.meta.url);
const out = process.argv[2] ?? fileURLToPath(new URL('./inbox-assets/inbox-og.jpg', import.meta.url));

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  await page.goto(template.href, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: out, type: 'jpeg', quality: 90 });
  console.log(`wrote ${out}`);
} finally {
  await browser.close();
}
