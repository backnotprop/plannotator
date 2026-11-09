/**
 * After a New message (Compose) is sent, the list lights the new thread's row
 * the way a row lights when it comes in (`data-lit`, the `ib-lit` fade), without
 * opening the thread. Real browser, compiled binary, temp PLANNOTATOR_DATA_DIR
 * and HOME; the live agent is one bridge poll with the registry's token.
 *
 * Build the binary first (see inbox.spec.ts), then
 * `bunx playwright test -c tests/e2e/playwright.config.ts inbox-sent-row-lit.spec.ts`.
 * PNGs land in .local/proof/sent-row-lit/ (and SENT_ROW_LIT_SHOTS when set).
 */

import { expect, test } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { INBOX_BRIDGE_POLL_PATH } from '../../packages/shared/inbox/connection';
import { scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'sent-row-lit');
const extraShots = process.env.SENT_ROW_LIT_SHOTS ? resolve(process.env.SENT_ROW_LIT_SHOTS) : null;

test.afterAll(async () => {
  await removeInboxScratch();
});

test('Send from Compose lights the new thread\'s row (data-lit), does not open it, and the light clears', async ({ browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  if (extraShots) mkdirSync(extraShots, { recursive: true });
  const root = inboxScratch('plannotator-inbox-sent-lit-e2e-');
  const dataDir = join(root, 'data');
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_BROWSER: NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const url = started.stdout.trim();
  const project = scratchProject(join(root, 'src'), 'ledger');
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  try {
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    // One poll makes the session live for 30 s.
    const { port, token } = JSON.parse(readFileSync(join(dataDir, 'inbox', 'inbox.json'), 'utf8')) as { port: number; token: string };
    const poll = await fetch(`http://127.0.0.1:${port}${INBOX_BRIDGE_POLL_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ session: 'ses-lit', host: 'claude-code', waitMs: 0, project_path: project, started_at: Date.now() - 45 * 60_000, busy: false }),
    });
    expect(poll.status).toBe(200);

    await page.goto(url);
    await page.locator('.ib-side [data-open-compose]').click();
    const dialog = page.locator('dialog[data-compose]');
    await expect(dialog).toBeVisible();
    const to = dialog.locator('.ib-cp-tobtn');
    await expect(to).toHaveAttribute('data-compose-to', 'choose');
    await to.click();
    await dialog.locator('[data-compose-session="ses-lit"]').click();
    await dialog.getByRole('textbox', { name: 'Message' }).fill('Look at where the new row lands after a send.');
    await dialog.locator('[data-compose-send]').click();
    await expect(dialog).toHaveCount(0);

    const lit = page.locator('.ib-listcol [data-thread-id][data-lit]');
    await expect(lit).toHaveCount(1);
    const id = (await lit.first().getAttribute('data-thread-id'))!;
    await expect(lit.first()).toContainText('To Claude Code');
    // Not opened: the list is the page, no thread pane, the hash names no thread.
    await expect(page.locator('section.ib-pane')).toHaveCount(0);
    expect(new URL(page.url()).hash).not.toContain(id);
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      const file = join(proofDir, `row-lit-${scheme}.png`);
      await page.screenshot({ path: file });
      if (extraShots) copyFileSync(file, join(extraShots, `row-lit-${scheme}.png`));
    }
    // The toast and its Open action are unchanged.
    await expect(page.locator('[data-inbox-toast] [data-toast-action]')).toHaveText('Open');
    // The light is taken off once it has faded (3 s).
    await expect(lit).toHaveCount(0, { timeout: 8_000 });
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});
