/**
 * Plans editing (approval "plans-editing"): on a plan's page, Edit opens the shared Markdown editor on the newest
 * version, the person types, Done makes a new newest version that is the person's, the page says the agent was not
 * told (no agent known), and the person's approval of the version they edited moves to the new one. An Escape never
 * leaves the page for the Plans list. Real browser, compiled binary, temp PLANNOTATOR_DATA_DIR and HOME; the plan
 * library is seeded with the store before the Inbox starts (Plans on in config.json).
 *
 * Build the binary first (see inbox.spec.ts), then
 * `bunx playwright test -c tests/e2e/playwright.config.ts inbox-plans-edit.spec.ts`.
 * PNGs land in .local/proof/plans-edit/.
 */

import { expect, test } from './inbox-test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { NO_ACTOR } from '../../packages/core/plans';
import { createPlanStore } from '../../packages/shared/plans/store';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'plans-edit');

test.afterAll(async () => {
  await removeInboxScratch();
});

test('Edit, then Done: a new newest version of the person’s words, the agent not told, the approval moved; Escape stays', async ({ browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-plans-edit-e2e-');
  const dataDir = join(root, 'data');
  const configFile = join(dataDir, 'config.json');
  writeFileSync(configFile, JSON.stringify({ ...JSON.parse(readFileSync(configFile, 'utf8')), inboxPlans: true }));
  // The plan: v1 by plan review, approved by the person.
  const store = createPlanStore({ dataDir });
  const { plan, document } = store.createPlan({ name: 'Rate limiting', project_name: 'ledger', created_at: '2026-11-10T09:00:00.000Z', document: { title: 'Rate limiting' } });
  const v1 = store.addVersion(plan.id, document.id, { bytes: new TextEncoder().encode('# Rate limiting\n\nA token bucket per API key.\n'), committed_at: '2026-11-10T09:00:00.000Z', source: 'plan-review', author_via: 'plan-review' });
  store.addEvent(plan.id, { ...NO_ACTOR, author_via: 'person', kind: 'decision', at: '2026-11-10T10:00:00.000Z', subject: { document_id: document.id, version_number: 1 }, decision: { document_id: document.id, version: v1.version, version_number: 1, decision: 'approved', at: '2026-11-10T10:00:00.000Z', feedback: null, feedback_record: null, snapshot: null }, legacy: null });

  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9', PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_BROWSER: NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const url = started.stdout.trim();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  try {
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${url}#plans=${plan.id}`);
    const reading = page.locator('[data-plan-reading]');
    await expect(reading.locator('[data-plan-approval="approved"]')).toHaveText('Approved by you');

    // Escape is not a way back to the Plans list.
    await page.locator('[data-plan-annotate] .ib-docscroll').click();
    await page.keyboard.press('Escape');
    await expect(page.locator(`[data-plan-page="${plan.id}"]`)).toBeVisible();
    expect(new URL(page.url()).hash).toBe(`#plans=${plan.id}`);

    await reading.locator('[data-plan-edit]').click();
    const editor = page.locator('[data-plan-editor] .cm-content');
    await expect(editor).toBeVisible();
    await expect(reading.locator('[data-plan-edit-done]')).toBeVisible();
    await expect(reading.locator('[data-plan-edit-cancel]')).toBeVisible();
    await editor.click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.type('\nRefill every second.');
    await page.screenshot({ path: join(proofDir, 'editing.png') });
    await reading.locator('[data-plan-edit-done]').click();

    await expect(page.locator('[data-plan-banner="saved"] p')).toHaveText('Saved as v2. No agent is running in ledger, so the agent was not told.');
    await expect(reading.locator('[data-reading-versions]')).toContainText('v2 · newest');
    await expect(page.locator('[data-plan-document]')).toContainText('Refill every second.');
    await expect(reading.locator('[data-plan-approval="moved"]')).toHaveText('Your approval moved to v2.');
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.screenshot({ path: join(proofDir, `done-${scheme}.png`) });
    }
    // The library holds it as the person's version.
    const versions = createPlanStore({ dataDir }).versions(plan.id);
    expect(versions.map((v) => [v.version_number, v.source, v.author_via])).toEqual([[1, 'plan-review', 'plan-review'], [2, 'person', 'person']]);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});
