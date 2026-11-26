/**
 * What a person sees when a part of the window fails to draw (ui's RegionBoundary): the part says "This part didn't
 * load" in its own place, with Try again, Reload and Copy error (and, for the Inbox's thread pane, its way back to the
 * list), and the rest of the window keeps working. Proof screenshots for the owner, of the whole window, in Chromium
 * against the compiled binary:
 *
 *  a. the Inbox at 1440×900, light and dark: a thread whose pane failed, beside the list and the sidebar;
 *  b. the same on a phone (390×844), whose notice says "Back to Inbox", and Back to Inbox returns to the list;
 *  c. the review window's Guided Review with its diff failed, the guide around it drawn, light and dark;
 *  d. a whole app failed (the review window, the Inbox): the notice in the middle of the page.
 *
 * A region fails on purpose through the browser proofs' switch: `window.__plannotatorBreakRegionForTests` names it,
 * and every boundary of that name throws as it draws. It is set by an init script where the region is drawn from the
 * start (the diff, an app's root), and for the thread pane once the list is drawn, just before a thread opens: the
 * pane's boundary draws with no thread open too, and in use only a thread can make it throw. Before Back to Inbox
 * the switch is turned off for the same reason (the thread that threw is the one being left). A failed region is
 * reported as an uncaught error (`reportError`), so the only page errors allowed are the switch's own.
 *
 * Build the binary first (see inbox.spec.ts), then
 * `bunx playwright test -c tests/e2e/playwright.config.ts region-failure-proof.spec.ts`.
 * PNGs land in <PLANNOTATOR_E2E_PROOF_DIR or .local/proof>/region-failure/.
 */

import { expect, HELD_DRIFT_OFF, test, type Browser, type BrowserContext, type BrowserContextOptions, type Locator, type Page } from './inbox-test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { markTourDecided } from '../helpers/tour-decided';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';
import { importGuide, openReview, openSavedGuide, reviewOf } from './review-scratch-session';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'region-failure');

/** The switch's own error (RegionBoundary's Tripwire): the one page error a forced failure may report. */
const ON_PURPOSE = 'failed on purpose for a browser proof';
const SCHEMES = ['light', 'dark'] as const;
type Scheme = (typeof SCHEMES)[number];

const DESKTOP: BrowserContextOptions = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, reducedMotion: 'reduce' };
const PHONE: BrowserContextOptions = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, reducedMotion: 'reduce' };

interface World {
  url: string;
  /** One thread to open per screenshot (a light and a dark, on the desk and on the phone), and one never opened. */
  threads: { desk: Record<Scheme, string>; phone: Record<Scheme, string>; unopened: string };
  agents: SimAgent[];
}

let world: World;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-region-failure-');
  const dataDir = join(root, 'data');
  markTourDecided(dataDir);
  // Nothing here may reach the real gh, glab or tailscale.
  const trap = join(root, 'trap');
  mkdirSync(trap);
  for (const name of ['gh', 'glab', 'tailscale']) {
    writeFileSync(join(trap, name), `#!/bin/sh\necho "region-failure: ${name} must not run" >&2\nexit 97\n`);
    chmodSync(join(trap, name), 0o755);
  }
  for (const dir of ['claude', 'codex', 'xdg', 'opencode', 'home']) mkdirSync(join(root, dir), { recursive: true });
  const env: Record<string, string> = {
    PATH: `${trap}:${process.env.PATH ?? ''}`,
    HOME: join(root, 'home'),
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_INBOX_TAILSCALE: '0',
    PLANNOTATOR_INBOX_PHONES: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
    PLANNOTATOR_BROWSER: NO_BROWSER,
    NO_BROWSER,
    NO_ANON_PING: '1',
    PLANNOTATOR_INBOX_NOTES: '0',
    PLANNOTATOR_TEST_SANDBOX: '1',
    PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9',
    CLAUDE_CONFIG_DIR: join(root, 'claude'),
    CODEX_HOME: join(root, 'codex'),
    XDG_CONFIG_HOME: join(root, 'xdg'),
    OPENCODE_CONFIG_DIR: join(root, 'opencode'),
  };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  rememberInboxOf(dataDir);
  const url = started.stdout.trim();
  const src = join(root, 'src');
  const agents: SimAgent[] = [];
  const agent = async (name: string, host: string) => {
    const made = await SimAgent.connect({ binary, env, name, host });
    agents.push(made);
    return made;
  };
  const claude = await agent('Claude Code', 'claude-code');
  const pi = await agent('Pi', 'pi');
  const opencode = await agent('OpenCode', 'opencode');
  const projects = Object.fromEntries(['harbor', 'fern-api', 'quill-docs', 'ledger'].map((name) => [name, scratchProject(src, name)]));
  const sent = async (from: SimAgent, project: string, subject: string, body: string) =>
    (await from.send({ project_path: projects[project]!, subject, body })).thread_id as string;
  const harbor = await sent(claude, 'harbor', 'Berth slips moved for the spring schedule', 'Berths 20, 60 and 100 of the north quay move to new slips. Ada Novak signed off on the pilot rota.');
  const fern = await sent(pi, 'fern-api', 'fern-api: the tokens endpoint is rate limited', 'The `/v1/tokens` endpoint now allows 60 requests a minute per key. Bob Tully asked for it after the load test.');
  const quill = await sent(opencode, 'quill-docs', 'quill-docs build is green again', 'The docs build passes on `main`. The broken link in the install page was the only failure.');
  const ledger = await sent(claude, 'ledger', 'Ledger export: totals now round half up', 'The monthly export rounds half up, as Charlie Dunn asked. The March totals match the bank statement.');
  const unopened = await sent(pi, 'harbor', 'Harbor: the tide table import runs nightly', 'The tide table import now runs at 02:00 and writes `data/tides.json`.');
  world = { url, threads: { desk: { light: harbor, dark: fern }, phone: { light: quill, dark: ledger }, unopened }, agents };
});

test.afterAll(async () => {
  try {
    for (const agent of world?.agents ?? []) await agent.close().catch(() => {});
  } finally {
    await removeInboxScratch();
  }
});

/** Every uncaught error the page reports; `unexpected` leaves out the switch's own. */
function errorsOf(page: Page): { all: string[]; unexpected: () => string[] } {
  const all: string[] = [];
  page.on('pageerror', (error) => all.push(`${error.name}: ${error.message}\n${error.stack ?? ''}`));
  return { all, unexpected: () => all.filter((e) => !e.includes(ON_PURPOSE)) };
}

const shotPath = (name: string, scheme: Scheme) => join(proofDir, `${name}-${scheme}.png`);

/** The whole window, never a crop: the viewport as the person sees it. */
async function shot(page: Page, name: string, scheme: Scheme): Promise<void> {
  await page.waitForTimeout(300);
  await page.screenshot({ path: shotPath(name, scheme) });
}

/**
 * The notice in the region's place (in `scope`), with its buttons; `close` names the fourth, where the region can be
 * closed. Resolves to the notice.
 */
async function expectNotice(scope: Page | Locator, region: string, close?: string): Promise<Locator> {
  const notice = scope.locator(`[data-region-failed="${region}"]`).filter({ visible: true }).first();
  await expect(notice, `${region}: the failure notice shows`).toBeVisible({ timeout: 30_000 });
  await expect(notice).toContainText("This part didn't load");
  await expect(notice).toContainText('Something went wrong drawing it.');
  await expect(notice.locator('[data-region-try-again]')).toHaveText('Try again');
  await expect(notice.locator('[data-region-reload]')).toHaveText('Reload');
  await expect(notice.locator('[data-region-copy]')).toHaveText('Copy error');
  if (close) await expect(notice.locator('[data-region-close]')).toHaveText(close);
  else await expect(notice.locator('[data-region-close]')).toHaveCount(0);
  return notice;
}

/** The notice's buttons a person can see, in order; they must be one row (the project bans stacked button rows). */
async function oneRow(notice: Locator, what: string): Promise<string[]> {
  const shown = await notice.locator('button').evaluateAll((buttons) =>
    buttons.filter((b) => b.getClientRects().length > 0).map((b) => ({ label: (b.textContent ?? '').trim(), top: Math.round(b.getBoundingClientRect().top) })),
  );
  expect(new Set(shown.map((b) => b.top)).size, `${what}: the buttons are one row (${JSON.stringify(shown)})`).toBe(1);
  return shown.map((b) => b.label);
}

/**
 * The notice's own look, which holds where the app failed before its theme was set: the app's font, rounded buttons,
 * and the page's colour (an app's root) by the system's scheme.
 */
async function lookOf(notice: Locator, what: string): Promise<string> {
  const look = await notice.evaluate((el) => {
    const button = el.querySelector('button')!;
    return {
      font: getComputedStyle(el).fontFamily,
      radius: parseFloat(getComputedStyle(button).borderTopLeftRadius),
      page: getComputedStyle(el.parentElement!).backgroundColor,
    };
  });
  expect(look.font, `${what}: the notice is in the app's font`).toMatch(/Inter/);
  expect(look.radius, `${what}: the buttons are rounded`).toBeGreaterThan(0);
  expect(look.page, `${what}: the page has a colour`).not.toBe('rgba(0, 0, 0, 0)');
  return look.page;
}

const arm = (page: Page, region: string | null) =>
  page.evaluate((name) => {
    (window as { __plannotatorBreakRegionForTests?: string | null }).__plannotatorBreakRegionForTests = name;
  }, region);

const armFromStart = (context: BrowserContext, region: string) =>
  context.addInitScript((name) => {
    (window as { __plannotatorBreakRegionForTests?: string }).__plannotatorBreakRegionForTests = name;
  }, region);

async function inboxPage(browser: Browser, options: BrowserContextOptions, scheme: Scheme) {
  const context = await browser.newContext({ ...options, colorScheme: scheme });
  const page = await context.newPage();
  return { context, page, errors: errorsOf(page) };
}

test.beforeEach(() => {
  // The proof breaks the window on purpose; the held-copy check reads a window that draws.
  test.info().annotations.push({ type: HELD_DRIFT_OFF, description: 'a region of the window fails on purpose' });
});

test('a. the Inbox at 1440×900: a failed thread pane says so in its place, beside the list and the sidebar', async ({ browser }) => {
  for (const scheme of SCHEMES) {
    const { context, page, errors } = await inboxPage(browser, DESKTOP, scheme);
    try {
      const thread = world.threads.desk[scheme];
      await page.goto(world.url);
      await expect(page.locator(`.ib-lbody [data-row="${thread}"]`)).toBeVisible({ timeout: 30_000 });
      await arm(page, 'Thread pane');
      // As the other Inbox specs open a thread: the address names it (the same page, so the switch stays set).
      await page.goto(`${world.url}#thread=${thread}`);
      const notice = await expectNotice(page, 'Thread pane', 'Back to Inbox');
      expect(await oneRow(notice, 'the desk')).toEqual(['Try again', 'Reload', 'Copy error', 'Back to Inbox']);
      // The rest of the window stays: the list with its other threads, the sidebar with the projects.
      await expect(page.locator('.ib-listcol')).toBeVisible();
      await expect(page.locator(`.ib-lbody [data-row="${world.threads.unopened}"]`)).toBeVisible();
      await expect(page.locator('.ib-side').getByText('harbor', { exact: true }).first()).toBeVisible();
      expect(errors.all.length, 'the failure is reported as an uncaught error').toBeGreaterThan(0);
      expect(errors.unexpected(), 'only the switch threw').toEqual([]);
      await shot(page, 'a-inbox-thread-pane-1440', scheme);
    } finally {
      await context.close();
    }
  }
});

test('b. the Inbox on a phone: the failed thread pane says Back to Inbox, and it returns to the list', async ({ browser }) => {
  for (const scheme of SCHEMES) {
    const { context, page, errors } = await inboxPage(browser, PHONE, scheme);
    try {
      await page.goto(world.url);
      const row = page.locator(`.ib-mrow[data-thread-id="${world.threads.phone[scheme]}"]`);
      await expect(row).toBeVisible({ timeout: 30_000 });
      await arm(page, 'Thread pane');
      await row.click();
      const notice = await expectNotice(page, 'Thread pane', 'Back to Inbox');
      await expect(notice.locator('[data-region-close]')).toBeInViewport();
      // One row on a phone: Reload goes (the browser's own is there), Try again, Copy error and the way back stay.
      const phoneRow = ['Try again', 'Copy error', 'Back to Inbox'];
      expect(await oneRow(notice, 'a phone at 390 px')).toEqual(phoneRow);
      expect(errors.unexpected(), 'only the switch threw').toEqual([]);
      await shot(page, 'b-inbox-thread-pane-phone', scheme);
      await page.setViewportSize({ width: 360, height: 780 });
      await expect(notice).toBeVisible();
      expect(await oneRow(notice, 'a phone at 360 px')).toEqual(phoneRow);
      await shot(page, 'b-inbox-thread-pane-phone-360', scheme);

      // The thread that threw is the one being left: with it gone, nothing throws.
      await arm(page, null);
      await notice.locator('[data-region-close]').click();
      await expect(page.locator('.ib-listcol')).toBeVisible();
      await expect(page.locator(`.ib-mrow[data-thread-id="${world.threads.unopened}"]`)).toBeVisible();
      await expect(page.locator('[data-region-failed]')).toHaveCount(0);
      expect(errors.unexpected(), 'only the switch threw').toEqual([]);
    } finally {
      await context.close();
    }
  }
});

const FILE = 'Sources/Harbor/Berth.swift';
const CHANGED = [20, 60, 100];
const berths = (changed: boolean) =>
  Array.from({ length: 120 }, (_, i) => {
    const n = i + 1;
    const slip = changed && CHANGED.includes(n) ? n * 10 : n;
    return `let berth${n} = Berth(slip: ${slip}, harbor: "harbor", pilot: "Ada Novak") // berth ${n} of the north quay`;
  }).join('\n') + '\n';
const GUIDE = {
  title: 'Harbor berths move to new slips',
  intent: 'Three berths of the north quay move to new slips.',
  sections: [{ title: 'The berths', overview: 'One file, three changes far apart.', diffs: [{ file: FILE, summary: 'Three slips change.' }] }],
};

/** The review window, the theme set as a person sets it, `region` failing from the first draw. */
async function reviewPage(browser: Browser, url: string, scheme: Scheme, region: string) {
  let errors: ReturnType<typeof errorsOf> | undefined;
  const { context, page } = await openReview(
    browser,
    url,
    async (page) => {
      errors = errorsOf(page);
      await page.context().addCookies([{ name: 'plannotator-theme', value: scheme, url }]);
      await armFromStart(page.context(), region);
    },
    { ...DESKTOP, colorScheme: scheme },
  );
  return { context, page, errors: errors! };
}

test("c. the review window's Guided Review: a failed diff says so in the file's place, and the guide around it stays", async ({ browser }) => {
  const session = await reviewOf('region-failure-guide', { [FILE]: berths(false) }, { [FILE]: berths(true) }, { before: (repo) => importGuide(repo, GUIDE) });
  try {
    for (const scheme of SCHEMES) {
      const { context, page, errors } = await reviewPage(browser, session.url, scheme, 'Diff');
      try {
        await openSavedGuide(page, GUIDE.title);
        const shell = page.locator(`[data-guide-file-shell="${FILE}"]`).first();
        await shell.scrollIntoViewIfNeeded();
        await shell.hover();
        // The diff fails in its own card.
        await expectNotice(shell, 'Diff');
        // The rest of the page: the guide's own words and the header's way back.
        await expect(page.getByText(GUIDE.title).filter({ visible: true }).first()).toBeVisible();
        await expect(page.locator('[data-guide-button]')).toBeVisible();
        expect(errors.all.length, 'the failure is reported as an uncaught error').toBeGreaterThan(0);
        expect(errors.unexpected(), 'only the switch threw').toEqual([]);
        await shell.evaluate((el) => el.scrollIntoView({ block: 'center' }));
        await shot(page, 'c-review-guide-diff', scheme);
      } finally {
        await context.close();
      }
    }
  } finally {
    await session.close();
  }
});

test('d. a whole app failed: the review window and the Inbox say so in the middle of the page', async ({ browser }) => {
  const session = await reviewOf('region-failure-root', { [FILE]: berths(false) }, { [FILE]: berths(true) });
  // The app failed before its theme was set: the notice still has its look, light or dark as the system is.
  const pages: Record<string, string[]> = { 'Code review': [], Inbox: [] };
  try {
    for (const scheme of SCHEMES) {
      const { context, page, errors } = await reviewPage(browser, session.url, scheme, 'Code review');
      try {
        const notice = await expectNotice(page, 'Code review');
        pages['Code review']!.push(await lookOf(notice, `the review window, ${scheme}`));
        await oneRow(notice, `the review window, ${scheme}`);
        expect(errors.unexpected(), 'only the switch threw').toEqual([]);
        await shot(page, 'd-review-root', scheme);
      } finally {
        await context.close();
      }
    }
  } finally {
    await session.close();
  }
  for (const scheme of SCHEMES) {
    const { context, page, errors } = await inboxPage(browser, DESKTOP, scheme);
    try {
      await armFromStart(context, 'Inbox');
      await page.goto(world.url);
      const notice = await expectNotice(page, 'Inbox');
      pages.Inbox!.push(await lookOf(notice, `the Inbox, ${scheme}`));
      await oneRow(notice, `the Inbox, ${scheme}`);
      expect(errors.unexpected(), 'only the switch threw').toEqual([]);
      await shot(page, 'd-inbox-root', scheme);
    } finally {
      await context.close();
    }
  }
  for (const [app, [light, dark]] of Object.entries(pages)) expect(dark, `${app}: the dark page is not the light one`).not.toBe(light);
});
