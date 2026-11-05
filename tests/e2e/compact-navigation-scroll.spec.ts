/** Mobile navigation owns touch scrolling and restores its position after closing or choosing a heading. */
import { expect, test, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { NO_BROWSER } from '../helpers/no-browser';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

async function drag(page: Page, x: number, from: number, to: number) {
  const session = await page.context().newCDPSession(page);
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: from }] });
  for (let step = 1; step <= 12; step++) {
    await session.send('Input.dispatchTouchEvent', {
      type: 'touchMove', touchPoints: [{ x, y: from + (to - from) * step / 12 }],
    });
    await page.waitForTimeout(16);
  }
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await session.detach();
  await page.waitForTimeout(250);
}

for (const containment of ['native', 'fallback'] as const) {
  test(`a mobile navigator owns scrolling with ${containment} containment`, async ({ page }) => {
    const root = inboxScratch('plannotator-navigation-scroll-');
    const dataDir = join(root, 'data');
    mkdirSync(dataDir);
    const doc = join(root, 'long.md');
    writeFileSync(doc, '# Navigation\n\n' + Array.from({ length: 70 }, (_, i) =>
      `## Section ${i + 1}\n\n${'Text for a long document. '.repeat(50)}\n\n`,
    ).join(''));
    const ready = join(root, 'ready.jsonl');
    const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? '.local/plannotator');
    let child: ChildProcess | undefined;
    let url = '';
    try {
      child = spawn(binary, ['annotate', doc], {
        cwd: root, stdio: 'ignore',
        env: { ...process.env, PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_TEST_SANDBOX: '1',
          PLANNOTATOR_BROWSER: NO_BROWSER, PLANNOTATOR_READY_FILE: ready, PLANNOTATOR_REMOTE: '0',
          PLANNOTATOR_UPDATE_CHECK: '0', PLANNOTATOR_INBOX_CONNECT: '0' },
      });
      await expect.poll(() => existsSync(ready) ? readFileSync(ready, 'utf8') : '').toContain('"url"');
      url = JSON.parse(readFileSync(ready, 'utf8').trim().split('\n')[0]!).url;
      await page.context().addCookies(Object.entries({
        'plannotator-look-feel-announcement-seen': '2',
        'plannotator-plan-look-choice-resolved': 'true',
        'plannotator-announce-tui-herdr-seen': '1',
        'plannotator-announce-inbox-seen': '1',
        'plannotator-announce-ask-session-seen': '1',
        'plannotator-announce-agent-tool-seen': '1',
      }).map(([name, value]) => ({ name, value, url })));
      await page.goto(url);
      await expect(page.locator('article')).toBeVisible();
      if (containment === 'fallback') {
      // Replay an engine that cannot contain nested scrolling using CSS alone.
      // This verifies the touch fallback; it is not an iOS emulator.
      await page.addStyleTag({ content: `
        #pn-compact-plan-navigator, #pn-compact-plan-navigator * { overscroll-behavior: auto !important; }
        html, body { overflow-y: auto !important; overscroll-behavior: auto !important; }
      ` });
      }
      await page.evaluate(() => window.scrollTo(0, 1400));
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
      // Open without Playwright first scrolling the offscreen header into view.
      await page.locator('#pn-compact-plan-navigator-trigger').evaluate(el => (el as HTMLButtonElement).click());
      const panel = page.locator('#pn-compact-plan-navigator');
      await expect(panel).toBeVisible();
      await page.waitForTimeout(250);
      const viewport = panel.locator('nav[aria-label="Table of contents"]').locator('..');
      const documentY = await page.evaluate(() => window.scrollY);
      expect(documentY).toBeGreaterThan(0);

      await drag(page, 180, 650, 250);
      const down = await viewport.evaluate(el => el.scrollTop);
      expect(down).toBeGreaterThan(100);
      expect(await page.evaluate(() => window.scrollY)).toBe(documentY);
      await drag(page, 180, 250, 550);
      expect(await viewport.evaluate(el => el.scrollTop)).toBeLessThan(down);
      expect(await page.evaluate(() => window.scrollY)).toBe(documentY);

      // Neither the non-scrollable header nor overscrolling a list may hand off to the document.
      await drag(page, 180, 30, 260);
      expect(await page.evaluate(() => window.scrollY)).toBe(documentY);
      await viewport.evaluate(el => { el.scrollTop = 0; });
      await drag(page, 180, 220, 550);
      expect(await page.evaluate(() => window.scrollY)).toBe(documentY);
      await viewport.evaluate(el => { el.scrollTop = el.scrollHeight; });
      await drag(page, 180, 650, 250);
      expect(await page.evaluate(() => window.scrollY)).toBe(documentY);

      const savedPosition = await viewport.evaluate(el => el.scrollTop);
      expect(savedPosition).toBeGreaterThan(100);
      await panel.getByRole('button', { name: 'Close navigator', exact: true }).click();
      await expect(panel).toHaveCount(0);
      await drag(page, 180, 650, 250);
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(documentY);

      // The lock must still allow the navigator's own programmatic jump.
      await page.locator('#pn-compact-plan-navigator-trigger').evaluate(el => (el as HTMLButtonElement).click());
      await expect(panel).toBeVisible();
      await expect.poll(() => viewport.evaluate(el => el.scrollTop)).toBeCloseTo(savedPosition, 0);
      const heading = panel.getByRole('button', { name: 'Section 35', exact: true });
      await heading.scrollIntoViewIfNeeded();
      const positionAtSelection = await viewport.evaluate(el => el.scrollTop);
      await heading.click();
      await expect(panel).toHaveCount(0);
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(documentY + 5000);
      await page.locator('#pn-compact-plan-navigator-trigger').evaluate(el => (el as HTMLButtonElement).click());
      await expect(panel).toBeVisible();
      await expect.poll(() => viewport.evaluate(el => el.scrollTop)).toBeCloseTo(positionAtSelection, 0);
    } finally {
      if (url) await fetch(new URL('/api/exit', url), { method: 'POST' }).catch(() => {});
      if (child && child.exitCode === null) {
        await new Promise(resolve => {
          const timeout = setTimeout(resolve, 3000);
          child!.once('exit', () => { clearTimeout(timeout); resolve(undefined); });
        });
        // inbox-guard: own annotate child, never an Inbox.
        if (child.exitCode === null) child.kill('SIGTERM');
      }
      await removeInboxScratch(root);
    }
  });
}
