/**
 * The skill (/) list of a saved emoji's name field, in the reaction tray, is all on screen (the owner, 2026-11-26:
 * "The list gets cut off"), proved in a real browser against the compiled binary. Nothing is mocked:
 * `plannotator inbox --background` under a temp data dir and a scratch HOME holding eight global skills that match
 * "/br", and an agent writing through `plannotator inbox mcp`.
 *
 * Before: the list was drawn inside the tray's card, whose clip-path (the field's opening reveal) cut every row more
 * than 60 px above the field, so only the last row or two showed, each squeezed to the field's width.
 *
 * Proves, at 1440×900 with full motion (reduced motion drops the clip-path, and with it the cut): from the thread's
 * 👍 (near the bottom) the list opens above the tray, every row painted where it is (hit-tested at its centre), at
 * least 380 px wide; from a message's face near the top of a short thread it opens below the tray, inside the window;
 * the keys still move through it and Enter takes the active row.
 *
 * Whole-window shots land in .local/proof/reaction-tray-skills/ (PLANNOTATOR_E2E_PROOF_DIR).
 * CI runs it; build the binary first (see inbox.spec.ts), then
 * `bunx playwright test -c tests/e2e/playwright.config.ts inbox-reaction-tray-skills.spec.ts`.
 */

import { expect, test, type Browser, type Page } from './inbox-test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { markTourDecided } from '../helpers/tour-decided';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'reaction-tray-skills');

const SKILLS = ['bro', 'browser-qa', 'brand-pack', 'break-ui', 'brief-notes', 'bring-up', 'broom', 'brush-up'];

let world: { url: string; agent: SimAgent; long: string; short: string };

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-reaction-tray-skills-');
  const dataDir = join(root, 'data');
  markTourDecided(dataDir);
  // The list reads the global skill folders under HOME: only this scratch HOME's.
  for (const name of SKILLS) {
    const dir = join(root, '.claude', 'skills', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: Guide a hands-on check of the change, step by step, and say what you saw\n---\n\n# ${name}\n\nSay what you will do in one line, then do it.\n`);
  }
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: root,
    CLAUDE_CONFIG_DIR: join(root, '.claude'),
    CODEX_HOME: join(root, '.codex'),
    XDG_CONFIG_HOME: join(root, '.config'),
    PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9',
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_BROWSER: NO_BROWSER,
    NO_BROWSER,
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
    NO_ANON_PING: '1',
  };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  rememberInboxOf(dataDir);
  const project = scratchProject(join(root, 'src'), 'harbor');
  const agent = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  const long = await agent.send({ project_path: project, thread: 'Harbor search index', subject: 'The search index rebuild is done', body: 'I rebuilt the search index for harbor.\n\n- 1,204 documents indexed\n- 3 skipped (empty)' });
  await agent.send({ project_path: project, reply_to: long.thread_id, body: 'Query times: p50 is 38 ms, p95 is 120 ms. Nothing needs you here.' });
  const short = await agent.send({ project_path: project, thread: 'Docs deploy', subject: 'Docs deploy finished', body: 'The docs deploy for quill-docs finished. Nothing needs you here.' });
  world = { url: started.stdout.trim(), agent, long: String(long.thread_id), short: String(short.thread_id) };
});

test.afterAll(async () => {
  try {
    await world?.agent.close().catch(() => {});
  } finally {
    await removeInboxScratch();
  }
});

/** + in the open tray, an emoji found by `query`, then `words` typed in the name field over the tray. */
async function nameWith(page: Page, query: string, emoji: string, words: string): Promise<void> {
  await page.locator('[data-reaction-tray] [data-reaction="add"]').first().click();
  await page.locator('[data-emoji-picker] input').fill(query);
  await page.locator(`.ib-emo [data-emo="${emoji}"]`).first().click();
  const field = page.locator('[data-name-field]');
  await expect(field).toBeVisible();
  await field.click();
  await field.pressSequentially(words, { delay: 30 });
  await expect(page.locator('[data-skill-menu] [data-skill-item]')).toHaveCount(SKILLS.filter((s) => s.startsWith(words.slice(1))).length);
  // The tray's card has finished its opening reveal (its clip-path rests at inset(-60px)).
  await page.waitForTimeout(400);
}

/** Every row of the list is painted where it is (nothing over it, nothing cutting it) and inside the window. */
async function allRowsShown(page: Page): Promise<{ side: string; menu: { x: number; y: number; width: number; height: number }; field: { width: number } }> {
  return page.evaluate(() => {
    const menu = document.querySelector<HTMLElement>('[data-skill-menu]')!;
    const list = menu.querySelector<HTMLElement>('[data-skill-menu-list]')!;
    const bad: string[] = [];
    for (const row of menu.querySelectorAll<HTMLElement>('[data-skill-item]')) {
      row.scrollIntoView({ block: 'nearest' });
      const r = row.getBoundingClientRect();
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      if (!hit || !row.contains(hit) || r.top < 0 || r.bottom > innerHeight || r.left < 0 || r.right > innerWidth) bad.push(row.getAttribute('data-skill-item')!);
    }
    list.scrollTop = 0;
    if (bad.length > 0) throw new Error(`rows not shown: ${bad.join(', ')}`);
    const m = menu.getBoundingClientRect();
    return {
      side: menu.getAttribute('data-skill-menu-placement')!,
      menu: { x: m.x, y: m.y, width: m.width, height: m.height },
      field: { width: document.querySelector('[data-name-field]')!.getBoundingClientRect().width },
    };
  });
}

test('a computer: the tray\'s / list is all on screen, above the tray near the bottom and below it near the top', async ({ browser }: { browser: Browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light', reducedMotion: 'no-preference' });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    // The thread's 👍, at the bottom of the pane: the tray opens above it.
    await page.goto(`${world.url}#thread=${world.long}`);
    await page.locator('section.ib-pane [data-react-more]').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-reaction-tray]')).toBeVisible();
    await nameWith(page, 'turkey', '🦃', '/br');
    // Outside the tray's card: its clip-path cut what was more than 60 px above it.
    expect(await page.locator('.ib-react-pop [data-skill-menu]').count()).toBe(0);
    const bottom = await allRowsShown(page);
    expect(bottom.side).toBe('above');
    expect(bottom.menu.width).toBeGreaterThanOrEqual(380);
    expect(bottom.menu.width).toBeGreaterThan(bottom.field.width);
    await page.screenshot({ path: join(proofDir, '1-tray-bottom.png') });
    // The keys still move through it, and Enter takes the active row and keeps it.
    await page.keyboard.type('o');
    await expect(page.locator('[data-skill-menu] [data-skill-item-active]')).toHaveAttribute('data-skill-item', 'bro');
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('[data-skill-menu] [data-skill-item-active]')).not.toHaveAttribute('data-skill-item', 'bro');
    const picked = await page.locator('[data-skill-menu] [data-skill-item-active]').getAttribute('data-skill-item');
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-name-field]')).toHaveCount(0);
    await expect(page.locator(`[data-reaction-tray] [data-skill="${picked}"]`)).toHaveCount(1);
    await page.keyboard.press('Escape');

    // A short thread, the tray from the message's face near the top: no room above, so the list opens below.
    await page.goto(`${world.url}#thread=${world.short}`);
    await page.locator('section.ib-pane [data-react-face]').first().click({ force: true });
    await page.locator('[data-react-all]').first().click();
    await expect(page.locator('[data-reaction-tray]')).toBeVisible();
    await nameWith(page, 'rocket', '🚀', '/br');
    const top = await allRowsShown(page);
    expect(top.side).toBe('below');
    await page.screenshot({ path: join(proofDir, '2-tray-top.png') });
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});
