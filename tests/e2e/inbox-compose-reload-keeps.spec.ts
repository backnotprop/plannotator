/**
 * New message is a draft from the first key (the owner, 2026-11-24: "The moment
 * I start typing text, that's a draft."). Before, a New message lived only in
 * the dialog until it was closed: a reload, an update's restart or a closed tab
 * lost every word typed in it.
 *
 * Proved in Chromium against the compiled binary:
 * - words typed and the page reloaded at once (inside the pause, before any
 *   quiet save) are on the server after the reload, and wait under Drafts;
 * - words typed and left for a pause are saved with no close and no reload, so
 *   the tab then closes without "Leave page?" and the draft is there.
 *
 * Nothing is mocked: `plannotator inbox --background` under a temp HOME and
 * PLANNOTATOR_DATA_DIR. Build the binary first (see inbox.spec.ts).
 *
 * The last two tests leave whole-window PNGs of what New message shows once a
 * pause saved it (desktop light and dark, a phone) in
 * <PLANNOTATOR_E2E_PROOF_DIR or .local/proof>/never-lose-words/.
 */

import { expect, test, type Browser, type Page } from './inbox-test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'never-lose-words');

let url = '';
let dataDir = '';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  const root = inboxScratch('plannotator-inbox-compose-reload-e2e-');
  dataDir = join(root, 'data');
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9', PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_BROWSER: NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  url = started.stdout.trim();
  rememberInboxOf(dataDir);
});

test.afterAll(async () => {
  await removeInboxScratch();
});

/** The bodies of the drafts the server holds. */
async function draftBodies(): Promise<string[]> {
  const { port } = JSON.parse(readFileSync(join(dataDir, 'inbox', 'inbox.json'), 'utf8')) as { port: number };
  const answer = (await (await fetch(`http://127.0.0.1:${port}/api/inbox/drafts`)).json()) as { drafts: { body: string }[] };
  return answer.drafts.map((draft) => draft.body);
}

test('a reload inside the pause keeps what New message holds: the words are a draft after the reload', async ({ browser }: { browser: Browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  // "Leave page?" may ask while the words are not saved yet: the person leaves anyway.
  page.on('dialog', (dialog) => void dialog.accept());
  try {
    await page.goto(url);
    await page.locator('.ib-side [data-open-compose]').click();
    const dialog = page.locator('dialog[data-compose]');
    const text = dialog.getByRole('textbox', { name: 'Message' });
    await expect(text).toBeFocused();
    const words = 'Charlie Dunn asked for the ledger export by Friday: please split it per month.';
    await text.pressSequentially(words, { delay: 5 });
    // At once, before the pause's save: the page goes.
    await page.reload();
    await expect.poll(draftBodies, { timeout: 10_000 }).toContain(words);
    await expect(page.locator('[data-drafts-nav]')).toContainText('Drafts1');
    await page.locator('[data-drafts-nav]').click();
    await expect(page.locator('[data-draft-id]')).toHaveCount(1);
    await expect(page.locator('[data-draft-id]')).toContainText('Charlie Dunn asked for the ledger export');
  } finally {
    await context.close();
  }
});

test('a pause saves New message by itself: the tab then closes without asking, and the draft is there', async ({ browser }: { browser: Browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const asked: string[] = [];
  page.on('dialog', (dialog) => {
    asked.push(dialog.type());
    void dialog.accept();
  });
  try {
    await page.goto(url);
    await page.locator('.ib-side [data-open-compose]').click();
    const text = page.locator('dialog[data-compose]').getByRole('textbox', { name: 'Message' });
    await expect(text).toBeFocused();
    const words = 'Ada Novak wants the retry worker to log a 409 once, then stop.';
    await text.pressSequentially(words, { delay: 5 });
    // No close, no reload: the pause alone saves it.
    await expect.poll(draftBodies, { timeout: 10_000 }).toContain(words);
    // Saved: closing the tab does not ask.
    const closed = page.waitForEvent('close', { timeout: 10_000 });
    await page.close({ runBeforeUnload: true });
    await closed;
    expect(asked).toEqual([]);
    expect(await draftBodies()).toContain(words);
  } finally {
    await context.close();
  }
});

/** The whole window as it is now, light or dark. */
async function shot(page: Page, name: string, scheme: 'light' | 'dark'): Promise<void> {
  await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(proofDir, `${name}-${scheme}.png`) });
}

test('proof: what New message shows once a pause saved it, desktop light and dark (whole window)', async ({ browser }: { browser: Browser }) => {
  mkdirSync(proofDir, { recursive: true });
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await desktop.newPage();
  page.on('dialog', (dialog) => void dialog.accept());
  try {
    await page.goto(url);
    await page.locator('.ib-side [data-open-compose]').click({ timeout: 15_000 });
    const dialog = page.locator('dialog[data-compose]');
    const text = dialog.getByRole('textbox', { name: 'Message' });
    await expect(text).toBeFocused();
    const words = 'Bob Tully: the ledger export splits per month from Friday.';
    await text.pressSequentially(words, { delay: 5 });
    // Inside the pause: still a New message, nothing saved yet.
    await shot(page, 'desktop-typing', 'light');
    // The pause saved it: the dialog is a Draft ("Draft · saved", Delete draft), and the sidebar's Drafts counts it.
    await expect.poll(draftBodies, { timeout: 10_000 }).toContain(words);
    await expect(dialog.locator('.ib-cp-dsaved')).toBeVisible();
    await expect(dialog.locator('[data-compose-delete]')).toBeVisible();
    await shot(page, 'desktop-saved', 'light');
    await shot(page, 'desktop-saved', 'dark');
  } finally {
    await desktop.close();
  }
});

test('proof: what New message shows on a phone once a pause saved it (whole window)', async ({ browser }: { browser: Browser }) => {
  mkdirSync(proofDir, { recursive: true });
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const handset = await phone.newPage();
  handset.on('dialog', (dialog) => void dialog.accept());
  try {
    // This Inbox has no thread, so a phone's list shows the welcome with no New message in its header: the Drafts page has it.
    await handset.goto(`${url}#drafts`);
    await expect(handset.locator('[data-drafts-page]')).toBeVisible();
    await handset.locator('.ib-drafts .ib-lhead-compose').click({ timeout: 15_000 });
    const sheet = handset.locator('dialog[data-compose]');
    const field = sheet.locator('[data-compose-text] textarea');
    await field.tap({ timeout: 15_000 });
    const words = 'Charlie Dunn: hold the export until the totals match.';
    await field.pressSequentially(words, { delay: 5 });
    await expect.poll(draftBodies, { timeout: 10_000 }).toContain(words);
    // A phone's row says "✓ Saved" once the pause saved it.
    await expect(sheet.locator('[data-compose-saved]')).toBeVisible();
    await shot(handset, 'phone-saved', 'light');
    await shot(handset, 'phone-saved', 'dark');
  } finally {
    await phone.close();
  }
});
