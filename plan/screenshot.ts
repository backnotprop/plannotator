/**
 * Full-page screenshots: directive demo (via dev portal) + HTML reference (standalone).
 * Usage: bun run plan/screenshot.ts
 */

import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'fs';
import { spawn } from 'child_process';
import { join } from 'path';

const ROOT = join(import.meta.dir, '..');
const DEMO_PATH = join(ROOT, 'packages/editor/demoPlan.ts');
const DEMO_MD = join(ROOT, 'plan/directive-demo.md');
const HTML_REF = join(ROOT, 'plan/previews/design-system-reference.html');
const OUT_DIR = join(ROOT, 'plan/previews');

async function screenshotDirectiveDemo(browser: ReturnType<typeof chromium.launch> extends Promise<infer T> ? T : never) {
  // Swap demo content
  const originalDemo = readFileSync(DEMO_PATH, 'utf8');
  const demoMd = readFileSync(DEMO_MD, 'utf8');
  const escaped = demoMd.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
  writeFileSync(DEMO_PATH, `export const DEMO_PLAN_CONTENT = \`${escaped}\`;\n`);

  // Start vite
  const vite = spawn('bun', ['run', '--cwd', 'apps/portal', 'dev'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let port = 3001;
  const ready = new Promise<void>((resolve) => {
    vite.stdout?.on('data', (data: Buffer) => {
      const line = data.toString();
      const match = line.match(/localhost:(\d+)/);
      if (match) port = parseInt(match[1]);
      if (line.includes('ready in')) resolve();
    });
  });

  try {
    await ready;
    console.log(`Vite ready on :${port}`);

    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(`http://localhost:${port}`, { waitUntil: 'networkidle' });
    await page.waitForSelector('[data-directive-kind]', { timeout: 15000 });
    // Wait for mermaid to render (it's async)
    await page.waitForTimeout(3000);

    // Strip chrome — content only
    await page.evaluate(() => {
      const hide = (sel: string) => document.querySelectorAll(sel).forEach(el => (el as HTMLElement).style.display = 'none');
      hide('[data-app-header="true"]');
      hide('[data-sidebar-tabs="true"]');
      hide('[data-annotation-panel="true"]');
      hide('[data-sticky-header-lane="true"]');

      // Nuke everything fixed/sticky AND any element with z-index > 0
      // that sits above the plan content
      document.querySelectorAll('*').forEach(el => {
        const style = getComputedStyle(el);
        if (style.position === 'fixed' || style.position === 'sticky') {
          (el as HTMLElement).style.setProperty('display', 'none', 'important');
        }
      });

      // Hide Demo badge and action buttons by walking the DOM
      document.querySelectorAll('span, button').forEach(el => {
        const t = (el.textContent || '').trim();
        if (['Demo', 'Select', 'Markup', 'Pinpoint', 'Wide', 'Focus',
             'Images', 'Comment', 'Copy', 'Copy plan', 'Global comment',
             'how does this work?'].includes(t)) {
          (el as HTMLElement).style.setProperty('display', 'none', 'important');
        }
      });
      // Also hide SVG-only icon buttons (gear icon, etc.)
      document.querySelectorAll('button').forEach(btn => {
        if (btn.querySelector('svg') && !btn.textContent?.trim()) {
          (btn as HTMLElement).style.setProperty('display', 'none', 'important');
        }
      });

      // Expand scroll containers
      document.querySelectorAll('[data-overlayscrollbars], [data-overlayscrollbars-viewport]').forEach(el => {
        (el as HTMLElement).style.overflow = 'visible';
        (el as HTMLElement).style.maxHeight = 'none';
        (el as HTMLElement).style.height = 'auto';
      });
      document.querySelectorAll('.h-screen, .h-full, .overflow-hidden, .overflow-y-auto, .overflow-auto').forEach(el => {
        (el as HTMLElement).style.overflow = 'visible';
        (el as HTMLElement).style.maxHeight = 'none';
        (el as HTMLElement).style.height = 'auto';
      });
      document.body.style.overflow = 'visible';
      document.body.style.height = 'auto';
      document.documentElement.style.overflow = 'visible';
      document.documentElement.style.height = 'auto';
    });
    await page.waitForTimeout(500);

    await page.screenshot({
      path: join(OUT_DIR, 'directive-demo-full.png'),
      fullPage: true,
    });
    const sz = readFileSync(join(OUT_DIR, 'directive-demo-full.png')).length;
    console.log(`directive-demo-full.png (${(sz/1024).toFixed(0)}KB)`);

    await page.close();
  } finally {
    writeFileSync(DEMO_PATH, originalDemo);
    vite.kill('SIGTERM');
  }
}

async function screenshotHtmlReference(browser: ReturnType<typeof chromium.launch> extends Promise<infer T> ? T : never) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`file://${HTML_REF}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);

  await page.screenshot({
    path: join(OUT_DIR, 'design-system-reference.png'),
    fullPage: true,
  });
  const sz = readFileSync(join(OUT_DIR, 'design-system-reference.png')).length;
  console.log(`design-system-reference.png (${(sz/1024).toFixed(0)}KB)`);
  await page.close();
}

const browser = await chromium.launch();
try {
  console.log('--- HTML reference ---');
  await screenshotHtmlReference(browser);
  console.log('--- Directive demo ---');
  await screenshotDirectiveDemo(browser);
} finally {
  await browser.close();
  console.log('Done.');
}
