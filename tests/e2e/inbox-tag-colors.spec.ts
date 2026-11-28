/**
 * Tag colors, the picker (approval "inbox-tag-colors-picker") in a real browser against the compiled binary:
 *
 *  - two tags made from the row menu get colors by themselves, vivid then calm (Green, then Indigo);
 *  - the tag menu has Highlight rows (a checkbox: off leaves the rows plain and keeps the color, on brings it back) and
 *    Color, which shows the twelve quick swatches, the square, the hue strip and Hex;
 *  - the arrows pass the square by (last swatch, strip, Hex and back) and Tab reaches it, writing nothing;
 *  - a drag to the square's top right corner picks a vivid color: kept on letting go, the Hex field shows it;
 *  - the vivid tag's row is drawn clearly stronger than the calm tag's row (computed fill, not a class), in light
 *    and in dark, and the row's quiet text keeps 4.5:1 on it.
 *
 * Build the binary first (see inbox.spec.ts), then `bun run test:e2e:inbox`.
 */

import { expect, test, type Browser, type BrowserContext, type Page } from './inbox-test';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));

interface World {
  url: string;
  agents: SimAgent[];
  context: BrowserContext;
  page: Page;
  errors: string[];
  threads: { calm: string; vivid: string };
}

let world: World;

test.describe.configure({ mode: 'serial' });

const rowButton = (page: Page, id: string) => page.locator(`.ib-lbody [data-thread-id="${id}"]`);
const rowMenu = (page: Page) => page.locator('[data-row-menu]');
const tagRows = (page: Page) => page.locator('[data-tag-row]');

/** A CSS color as sRGB bytes, read through a canvas (the browser resolves oklch() and relative colors). */
async function fillOf(page: Page, id: string): Promise<[number, number, number]> {
  return page.evaluate((threadId) => {
    const el = document.querySelector(`.ib-lbody [data-thread-id="${threadId}"]`)!;
    const color = getComputedStyle(el, '::before').backgroundColor;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return [r!, g!, b!] as [number, number, number];
  }, id);
}

/** sRGB bytes as OKLab. */
function oklab([r, g, b]: [number, number, number]): [number, number, number] {
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
const chroma = (lab: [number, number, number]) => Math.hypot(lab[1], lab[2]);

function contrast(a: [number, number, number], b: [number, number, number]): number {
  const lum = ([r, g, bl]: [number, number, number]) =>
    [r, g, bl].map((v) => {
      const c = v / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    }).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i]!, 0);
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

async function tagFromRowMenu(page: Page, threadId: string, name: string) {
  await rowButton(page, threadId).click({ button: 'right' });
  await rowMenu(page).locator('[data-add-tag-item]').click();
  const field = rowMenu(page).locator('[data-tag-find]');
  await expect(field).toBeFocused();
  await field.fill(name);
  await field.press('Enter');
  await expect(rowMenu(page).locator('[data-tag-pick][aria-checked="true"]')).toHaveText(new RegExp(`^${name}`));
  await page.keyboard.press('Escape');
}

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  const root = inboxScratch('plannotator-inbox-tag-colors-e2e-');
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9', PLANNOTATOR_DATA_DIR: join(root, 'data'), PLANNOTATOR_BROWSER: NO_BROWSER, NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const project = scratchProject(join(root, 'src'), 'web-app');
  const claude = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  const calm = await claude.send({ project_path: project, subject: 'Token rotation', body: 'Keys rotate every 30 days now.' });
  const vivid = await claude.send({ project_path: project, subject: 'First-run checklist', body: 'Four steps, the last one is optional.' });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  world = { url: started.stdout.trim(), agents: [claude], context, page, errors, threads: { calm: calm.thread_id as string, vivid: vivid.thread_id as string } };
});

test.afterAll(async () => {
  try {
    if (!world) return;
    for (const agent of world.agents) await agent.close().catch(() => {});
    await world.context.close();
  } finally {
    await removeInboxScratch();
  }
});

test('a vivid pick on the square gives a row clearly stronger than a calm tag’s, light and dark, its text still readable', async () => {
  const { page, threads } = world;
  await page.goto(world.url);
  await expect(rowButton(page, threads.vivid)).toBeVisible();
  // The first new tag is vivid Green, the second calm Indigo.
  await tagFromRowMenu(page, threads.vivid, 'Onboarding');
  await tagFromRowMenu(page, threads.calm, 'Security');
  await expect(rowButton(page, threads.vivid)).toHaveAttribute('data-tint', '#14cc61');
  await expect(rowButton(page, threads.calm)).toHaveAttribute('data-tint', '#b1b7fd');
  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/api/inbox/tag-colours')) writes.push(request.postData() ?? '');
  });

  // Security's Highlight rows off: its row is plain at once, the Color item still names Indigo; on again brings it back.
  await tagRows(page).filter({ hasText: 'Security' }).click({ button: 'right' });
  const highlight = page.locator('[data-tag-menu] [data-tag-action="highlight"]');
  await expect(highlight).toHaveAttribute('aria-checked', 'true');
  await highlight.click();
  await expect(rowButton(page, threads.calm)).not.toHaveAttribute('data-tint', /./);
  await expect(highlight).toHaveAttribute('aria-checked', 'false');
  await expect(page.locator('[data-tag-menu] [data-tag-action="colour"]')).toContainText('Indigo');
  await highlight.click();
  await expect(rowButton(page, threads.calm)).toHaveAttribute('data-tint', '#b1b7fd');
  await page.keyboard.press('Escape');
  await expect.poll(() => writes.length).toBe(2);

  // Onboarding's colors: twelve swatches, then the square, the strip and Hex.
  await tagRows(page).filter({ hasText: 'Onboarding' }).click({ button: 'right' });
  await page.locator('[data-tag-menu] [data-tag-action="colour"]').click();
  const list = page.locator('[data-tag-menu] [data-tag-colour-list]');
  await expect(list.locator('.ib-tagc-swb')).toHaveCount(12);
  await expect(list.locator('[data-colour="#14cc61"]')).toHaveAttribute('aria-checked', 'true');
  const square = list.getByRole('slider', { name: 'Color' });
  await expect(square).toBeVisible();
  await expect(list.getByRole('slider', { name: 'Hue' })).toBeVisible();
  await expect(list.locator('[data-colour="none"]')).toHaveCount(0);

  // By keyboard, nothing written by moving: the arrows go last swatch, strip, Hex and back up, past the square; Tab
  // from a swatch reaches the square and Tab goes on to the strip.
  const before = writes.length;
  await list.locator('.ib-tagc-swb').last().focus();
  await page.keyboard.press('ArrowDown');
  await expect(list.getByRole('slider', { name: 'Hue' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(list.locator('[data-tag-colour-hex]')).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await expect(list.locator('.ib-tagc-swb').last()).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(square).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(list.getByRole('slider', { name: 'Hue' })).toBeFocused();
  await page.waitForTimeout(1000);
  expect(writes.length).toBe(before);

  // Drag to the top right corner: full saturation and brightness at the current hue.
  const box = (await square.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.6);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.3, { steps: 4 });
  await page.mouse.move(box.x + box.width - 1, box.y + 1, { steps: 4 });
  await page.mouse.up();
  await expect(square).toHaveAttribute('aria-valuetext', /^Saturation (9\d|100)%, brightness (9\d|100)%$/);
  // One drag, one write: on letting go.
  await expect.poll(() => writes.length).toBe(before + 1);
  const hex = list.locator('[data-tag-colour-hex]');
  await expect(hex).toHaveValue(/^#[0-9a-f]{6}$/);
  await expect(list.locator('[data-tag-colour-caption]')).toContainText('rows tagged Onboarding');
  const picked = await hex.inputValue();
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-tag-menu]')).toHaveCount(0);
  // Kept: the sidebar says it.
  await tagRows(page).filter({ hasText: 'Onboarding' }).click({ button: 'right' });
  await expect(page.locator('[data-tag-menu] [data-tag-action="colour"]')).toContainText('Custom');
  await page.keyboard.press('Escape');
  expect(picked).not.toBe('#14cc61');

  // Click elsewhere so neither row is hovered or selected, then compare the fills.
  await page.mouse.move(5, 890);
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(150);
    const vivid = oklab(await fillOf(page, threads.vivid));
    const calm = oklab(await fillOf(page, threads.calm));
    // The vivid row carries clearly more color than the calm one.
    expect({ scheme, stronger: chroma(vivid) - chroma(calm) > 0.03 }).toEqual({ scheme, stronger: true });
    const dE = 100 * Math.hypot(vivid[0] - calm[0], vivid[1] - calm[1], vivid[2] - calm[2]);
    expect({ scheme, distinct: dE > 5 }).toEqual({ scheme, distinct: true });
    // The row's quiet text (its time) keeps 4.5:1 on the vivid fill.
    const ink = await page.evaluate((threadId) => {
      const time = document.querySelector(`.ib-lbody [data-thread-id="${threadId}"] .ib-t`)!;
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = getComputedStyle(time).color;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
      return [r!, g!, b!] as [number, number, number];
    }, threads.vivid);
    expect({ scheme, ok: contrast(ink, await fillOf(page, threads.vivid)) >= 4.5 }).toEqual({ scheme, ok: true });
  }
  expect(world.errors).toEqual([]);
});
