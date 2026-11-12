import { chromium, devices, expect, test, webkit, type Browser, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { markTourDecided } from '../helpers/tour-decided';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const shots = process.env.CANVAS_SHOTS ? resolve(process.env.CANVAS_SHOTS) : null;
const prefix = process.env.CANVAS_SHOT_PREFIX ?? 'after';
const check = prefix === 'before' ? expect.soft : expect;

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1440, height: 900 };
const BAND = 110;

interface World {
  url: string;
  threadId: string;
  agent: SimAgent;
}

let world: World;

test.beforeAll(async () => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  if (shots) mkdirSync(shots, { recursive: true });
  const root = inboxScratch('plannotator-inbox-phone-canvas-e2e-');
  const dataDir = join(root, 'data');
  markTourDecided(dataDir);
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: root,
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_BROWSER: NO_BROWSER,
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
  };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const project = scratchProject(join(root, 'src'), 'board');
  const agent = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  const sent = await agent.send({ project_path: project, subject: 'QA image choices', body: 'Three pictures for the QA page. Which one goes first?' });
  world = { url: started.stdout.trim(), threadId: sent.thread_id as string, agent };
});

test.afterAll(async () => {
  try {
    await world?.agent.close().catch(() => {});
  } finally {
    await removeInboxScratch();
  }
});

async function paints(page: Page, surface: string): Promise<{ html: string; body: string; surface: string; background: string }> {
  return page.evaluate((surface) => {
    const bg = (el: Element) => getComputedStyle(el).backgroundColor;
    const probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;width:0;height:0;background-color:var(--background);transition:none';
    document.documentElement.append(probe);
    const background = bg(probe);
    probe.remove();
    return { html: bg(document.documentElement), body: bg(document.body), surface: bg(document.querySelector(surface)!), background };
  }, surface);
}

async function expectCanvasIs(page: Page, surface: string, scheme: string): Promise<void> {
  await page.waitForTimeout(400);
  await expect
    .poll(async () => {
      const p = await paints(page, surface);
      return p.html === p.surface && p.body === p.surface;
    }, { message: `${scheme}: html and body paint ${surface}'s colour`, timeout: prefix === 'before' ? 2_000 : 5_000 })
    .toBe(true)
    .catch((error) => {
      if (prefix !== 'before') throw error;
    });
  const p = await paints(page, surface);
  check(p.html, `${scheme}: html`).toBe(p.surface);
  check(p.body, `${scheme}: body`).toBe(p.surface);
}

async function shot(page: Page, name: string): Promise<void> {
  if (!shots) return;
  await page.waitForTimeout(400);
  await page.addStyleTag({ content: `.pn-inbox, dialog.ib-cp[data-phone] { height: calc(100% - ${BAND}px) !important; max-height: calc(100% - ${BAND}px) !important; }` });
  await page.screenshot({ path: join(shots, `${prefix}-${name}.png`) });
  await page.evaluate(() => document.querySelectorAll('style').forEach((el) => el.textContent?.includes('!important; max-height: calc(100% -') && el.remove()));
}

const ENGINES = [
  { name: 'WebKit (iPhone)', tag: 'webkit', launch: () => webkit.launch({ args: [] }), device: devices['iPhone 15'] },
  { name: 'Chromium (Android)', tag: 'chromium', launch: () => chromium.launch(), device: devices['Pixel 7'] },
];

for (const engine of ENGINES) {
  test.describe(engine.name, () => {
    let browser: Browser;
    let page: Page;
    const errors: string[] = [];

    test.beforeAll(async () => {
      browser = await engine.launch();
      const { userAgent, deviceScaleFactor, isMobile, hasTouch } = engine.device;
      const context = await browser.newContext({ userAgent, deviceScaleFactor, isMobile, hasTouch, viewport: PHONE, colorScheme: 'dark' });
      page = await context.newPage();
      page.on('pageerror', (error) => {
        if (!/due to access control checks/.test(error.message)) errors.push(error.message);
      });
    });

    test.afterAll(async () => {
      await browser?.close();
    });

    test('a reply: the canvas is the reply foot, light and dark, and after a switch', async () => {
      await page.goto(`${world.url}#thread=${world.threadId}`);
      const pane = page.locator('section.ib-pane');
      const box = pane.locator('.ib-pfoot textarea');
      const open = pane.locator('.ib-pfoot').getByRole('button', { name: /^Reply$|Edit draft$/ });
      await expect(box.or(open).first()).toBeVisible();
      if (!(await box.isVisible())) await open.click({ timeout: 5_000 }).catch(() => {});
      await box.fill('The second picture first, then the other two.');
      const seen = new Set<string>();
      for (const scheme of ['dark', 'light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        await expect(page.locator('html')).toHaveClass(scheme === 'light' ? /(^|\s)light(\s|$)/ : /^(?!.*(^|\s)light(\s|$))/);
        await expectCanvasIs(page, 'section.ib-pane .ib-pfoot', scheme);
        seen.add((await paints(page, 'section.ib-pane .ib-pfoot')).surface);
      }
      expect(seen.size).toBe(2);
      for (const scheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        await expectCanvasIs(page, 'section.ib-pane .ib-pfoot', scheme);
        await shot(page, `${engine.tag}-reply-${scheme}`);
      }
    });

    test('a new thread: the canvas is the compose sheet, light and dark', async () => {
      await page.goto(world.url);
      await page.locator('.ib-lhead [data-open-compose]').click();
      const sheet = page.locator('dialog[data-compose]');
      await expect(sheet.locator('.ib-cp-bar h2')).toHaveText('New message');
      await sheet.getByRole('textbox', { name: 'Message' }).fill('Other agents conduct the same analysis to see what instructions they get.');
      for (const scheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        await expectCanvasIs(page, 'dialog[data-compose]', scheme);
        await shot(page, `${engine.tag}-compose-${scheme}`);
      }
    });

    test('the desktop keeps main\'s root paint: html none, body --background', async () => {
      await page.setViewportSize(DESKTOP);
      await page.goto(`${world.url}#thread=${world.threadId}`);
      await expect(page.locator('section.ib-pane')).toBeVisible();
      for (const scheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        await expect
          .poll(async () => {
            const p = await paints(page, 'section.ib-pane');
            return p.body === p.background && p.html === 'rgba(0, 0, 0, 0)';
          }, { message: `${scheme}: desktop root unchanged` })
          .toBe(true);
        if (shots && engine.tag === 'chromium') {
          await page.waitForTimeout(400);
          await page.screenshot({ path: join(shots, `${prefix}-desktop-${scheme}.png`) });
        }
      }
      await page.setViewportSize(PHONE);
    });

    test('no page errors', () => {
      expect(errors).toEqual([]);
    });
  });
}
