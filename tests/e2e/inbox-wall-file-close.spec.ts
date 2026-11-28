import { chromium, expect, test, type Page } from './inbox-test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const shotsDir = resolve(process.env.PLANNOTATOR_E2E_SHOTS_DIR ?? join(repo, '.local/proof/wall-file-close'));
const CHROMIUM_ARGS = ['--use-mock-keychain', '--password-store=basic', '--mute-audio'];

const PROJECTS = ['harbor', 'fern-api', 'quill-docs', 'ledger'];
const PEOPLE = ['Charlie Dunn', 'Bob Tully'];
const PNG_A = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const PNG_B = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNQSJgAAAG0ARHcak2KAAAAAElFTkSuQmCC';

async function wallTop(page: Page): Promise<number> {
  return page.locator('[data-artifacts-wall]').evaluate((el) => el.scrollTop);
}

test('a file opened from the Artifacts wall closes back to the Wall where it was; from its thread, to its thread', async ({ browserName }) => {
  test.skip(browserName !== 'chromium', 'Chromium draws the proof');
  test.setTimeout(240_000);
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  mkdirSync(shotsDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-wall-file-close-');
  const home = join(root, 'home');
  const trap = join(root, 'trap');
  mkdirSync(home, { recursive: true });
  mkdirSync(trap, { recursive: true });
  writeFileSync(join(trap, 'tailscale'), '#!/bin/sh\necho "wall-file-close: tailscale must not run" >&2\nexit 97\n');
  chmodSync(join(trap, 'tailscale'), 0o755);
  const env = {
    PATH: `${trap}:${process.env.PATH ?? ''}`,
    HOME: home,
    PLANNOTATOR_DATA_DIR: join(root, 'data'),
    PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9',
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
    PLANNOTATOR_INBOX_NOTES: '0',
    PLANNOTATOR_TEST_SANDBOX: '1',
    NO_ANON_PING: '1',
    NO_BROWSER,
    PLANNOTATOR_BROWSER: NO_BROWSER,
  };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const url = started.stdout.trim();
  const browser = await chromium.launch({ args: CHROMIUM_ARGS });
  const agent = await SimAgent.connect({ binary, env, name: 'Claude', host: 'claude-code' });
  try {
    let firstThread = '';
    for (const [p, name] of PROJECTS.entries()) {
      const dir = scratchProject(join(root, 'src'), name);
      const files: string[] = [];
      for (let i = 1; i <= 12; i++) {
        const file = `${name}-note-${i}.md`;
        writeFileSync(join(dir, file), `# ${name} note ${i}\n\n${PEOPLE[i % 2]} wrote this for ${name}, part ${i}.\n`);
        files.push(file);
      }
      if (p === 0) {
        for (const shade of [0, 1]) {
          writeFileSync(join(dir, `${name}-berth-${shade + 1}.png`), Buffer.from(shade ? PNG_B : PNG_A, 'base64'));
          files.push(`${name}-berth-${shade + 1}.png`);
        }
      }
      const sent = await agent.send({ project_path: dir, subject: `${name}: the notes for ${PEOPLE[p % 2]}`, body: `The ${name} notes, one per part.`, attachments: files });
      if (!firstThread) firstThread = sent.thread_id as string;
    }

    for (const size of [
      { label: '1280', viewport: { width: 1280, height: 800 }, phone: false },
      { label: '390', viewport: { width: 390, height: 844 }, phone: true },
    ]) {
      const context = await browser.newContext({ viewport: size.viewport, reducedMotion: 'reduce', ...(size.phone ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
      for (const way of ['close', 'escape', 'back'] as const) {
        const page = await context.newPage();
        const wall = page.locator('[data-artifacts-wall]');
        const tiles = wall.locator('[data-wall-artifact]');
        const pins = page.waitForResponse((r) => r.url().includes('/api/inbox/artifact-pins'));
        await page.goto(`${url}#artifacts`);
        await expect(tiles).toHaveCount(50, { timeout: 20_000 });
        await pins;
        await page.waitForTimeout(400);
        await wall.locator('[data-wall-type="documents"]').click();
        await expect(wall.locator('[data-wall-type="documents"]')).toHaveAttribute('aria-pressed', 'true');
        await expect(tiles).toHaveCount(48);
        await wall.evaluate((el) => el.scrollTo(0, Math.round((el.scrollHeight - el.clientHeight) / 2)));
        const top = await wallTop(page);
        expect(top).toBeGreaterThan(200);
        const key = await tiles.evaluateAll((cells) => {
          const box = cells[0].closest('[data-artifacts-wall]')!.getBoundingClientRect();
          const seen = cells.find((c) => {
            const r = c.getBoundingClientRect();
            return r.top > box.top + 60 && r.bottom < box.bottom - 60;
          });
          return seen?.getAttribute('data-wall-artifact') ?? '';
        });
        expect(key).not.toBe('');
        const opened = wall.locator(`[data-wall-artifact="${key}"]`);
        const shots = way === 'close';
        if (shots) await page.screenshot({ path: join(shotsDir, `${size.label}-1-wall-scrolled.png`) });
        await opened.locator('.ib-wall-tile').click();
        const pane = page.locator('[data-attachment-pane]');
        await expect(pane).toBeVisible({ timeout: 20_000 });
        if (shots) {
          await page.waitForTimeout(800);
          await page.screenshot({ path: join(shotsDir, `${size.label}-2-file-open.png`) });
        }
        if (way === 'close') {
          const out = size.phone ? page.getByRole('button', { name: 'Back to the thread' }) : pane.getByRole('button', { name: /^Close / });
          await out.first().click();
        } else if (way === 'escape') {
          await page.keyboard.press('Escape');
        } else {
          await page.goBack();
        }
        await expect(pane).toHaveCount(0);
        if (shots) {
          await page.waitForTimeout(800);
          await page.screenshot({ path: join(shotsDir, `${size.label}-3-after-close.png`) });
        }
        await expect.soft(wall, `${size.label} ${way}: back on the Wall`).toBeVisible({ timeout: 5000 });
        expect.soft(new URL(page.url()).hash, `${size.label} ${way}: the address`).toBe('#artifacts');
        await expect.soft(wall.locator('[data-wall-type="documents"]'), `${size.label} ${way}: the filter`).toHaveAttribute('aria-pressed', 'true', { timeout: 5000 });
        await expect.soft.poll(() => wallTop(page), { message: `${size.label} ${way}: the Wall's scroll`, timeout: 5000 }).toBe(top);
        await expect.soft(opened.locator('.ib-wall-tile'), `${size.label} ${way}: focus on the tile`).toBeFocused({ timeout: 5000 });
        await page.close();
      }

      const page = await context.newPage();
      await page.goto(`${url}#thread=${firstThread}`);
      const tile = page.locator('button.ib-att-t[data-attachment-id]').first();
      await expect(tile).toBeVisible({ timeout: 20_000 });
      await tile.click();
      const pane = page.locator('[data-attachment-pane]');
      await expect(pane).toBeVisible({ timeout: 20_000 });
      const out = size.phone ? page.getByRole('button', { name: 'Back to the thread' }) : pane.getByRole('button', { name: /^Close / });
      await out.first().click();
      await expect(pane).toHaveCount(0);
      expect(new URL(page.url()).hash).toBe(`#thread=${firstThread}`);
      await expect(page.locator('section.ib-pane')).toBeVisible();
      await context.close();
    }
  } finally {
    await agent.close().catch(() => {});
    await browser.close();
    await removeInboxScratch();
  }
});
