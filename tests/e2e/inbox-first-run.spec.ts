/**
 * First run, "One next step" (the approved design inbox-connect-next-step,
 * variant C), proved in a real browser against the compiled binary on each of
 * the mock's computers. Each computer is a scratch HOME (Plannotator's Claude
 * Code plugin, Pi extension, MCP entries) and a scratch PATH of stub agent
 * commands that never run (reading the agents runs no agent CLI); the Inbox is
 * `plannotator inbox --background` under a temp PLANNOTATOR_DATA_DIR. The real
 * home, the real agents and their config files are never read or touched.
 *
 *  - Typical: Pi's Inbox tool is the next step, with its measured cost; Claude
 *    Code (a live session, a bridge poll this spec holds), Codex and Cursor
 *    are done; Turn on writes config.json and the card moves to OpenCode.
 *  - Plugin missing: Claude Code's install command, copied; once the plugin
 *    is installed (its settings written) the window, back in focus, moves on
 *    by itself to Pi's extension.
 *  - Nothing found: the first step for Claude Code, Pi or OpenCode, MCP folded,
 *    every other agent or editor in the picker at the end.
 *  - Tool locked off (PLANNOTATOR_INBOX_TOOL=0): the locked tools are not steps.
 *  - Which agents a reply wakes: Claude Code through its plugin and Codex
 *    through MCP; the screen's one line, then Settings → Agents' "Your
 *    replies" rows (shots into PLANNOTATOR_WAKE_SHOTS, `wake-*.png`).
 *
 * Every computer is shot desktop (1440 by 900) and phone (390 wide, full
 * page), light and dark, at 2x, into PLANNOTATOR_FIRST_RUN_SHOTS (default
 * .local/proof/first-run), named like the mock's (`c-<scenario>[-phone]-<scheme>.png`).
 * Build the binary first (see inbox.spec.ts), then `bun run test:e2e:inbox`.
 */
import { markTourDecided } from '../helpers/tour-decided';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { NO_BROWSER } from '../helpers/no-browser';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const shots = resolve(process.env.PLANNOTATOR_FIRST_RUN_SHOTS ?? join(repo, '.local/proof/first-run'));
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

interface Computer {
  root: string;
  home: string;
  bin: string;
  dataDir: string;
  url: string;
  token: string;
}

type Setup = (c: { home: string; bin: string; binary: string }) => void;

function stub(bin: string, name: string): void {
  writeFileSync(join(bin, name), '#!/bin/sh\necho "this stub never runs" >&2\nexit 1\n', { mode: 0o755 });
}
function json(path: string, value: unknown): void {
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}
const claudePlugin: Setup = ({ home }) => json(join(home, '.claude', 'settings.json'), { enabledPlugins: { 'plannotator@plannotator': true } });
const piExtension: Setup = ({ home, bin }) => {
  stub(bin, 'pi');
  json(join(home, '.pi', 'agent', 'settings.json'), { packages: ['npm:@plannotator/pi-extension'] });
};
const codexMcp: Setup = ({ home, bin, binary: self }) => {
  stub(bin, 'codex');
  mkdirSync(join(home, '.codex'), { recursive: true });
  writeFileSync(join(home, '.codex', 'config.toml'), `[mcp_servers.plannotator-inbox]\ncommand = ${JSON.stringify(self)}\nargs = ["inbox", "mcp"]\n`);
};
/** A Codex the Inbox can wake: it answers --version as Codex 0.160 (the Inbox then runs `codex queue`; never here: no thread asks). */
const codexQueueMcp: Setup = (computer) => {
  codexMcp(computer);
  writeFileSync(join(computer.bin, 'codex'), '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "codex-cli 0.160.0"; exit 0; fi\necho "this stub never queues" >&2\nexit 1\n', { mode: 0o755 });
};
const cursorMcp: Setup = ({ home, binary: self }) => json(join(home, '.cursor', 'mcp.json'), { mcpServers: { 'plannotator-inbox': { command: self, args: ['inbox', 'mcp'] } } });

const SETUPS: Record<string, { setup: Setup[]; env?: Record<string, string>; live?: boolean }> = {
  typical: { setup: [claudePlugin, piExtension, ({ bin }) => stub(bin, 'opencode'), codexMcp, cursorMcp], live: true },
  missing: {
    setup: [
      ({ bin }) => stub(bin, 'claude'),
      ({ home, bin, binary: self }) => {
        stub(bin, 'pi');
        json(join(home, '.pi', 'agent', 'mcp.json'), { mcpServers: { 'plannotator-inbox': { command: self, args: ['inbox', 'mcp'] } } });
      },
      codexMcp,
    ],
  },
  none: { setup: [] },
  wake: { setup: [claudePlugin, codexMcp] },
  codexWakes: { setup: [claudePlugin, codexQueueMcp] },
  locked: { setup: [claudePlugin, piExtension, ({ bin }) => stub(bin, 'opencode'), codexMcp, cursorMcp], env: { PLANNOTATOR_INBOX_TOOL: '0' } },
};

function start(name: keyof typeof SETUPS): Computer {
  const root = inboxScratch(`plannotator-first-run-${name}-`);
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  const dataDir = join(root, 'data');
  for (const dir of [home, bin, dataDir]) mkdirSync(dir, { recursive: true });
  const self = realpathSync(binary);
  for (const setup of SETUPS[name]!.setup) setup({ home, bin, binary: self });
  // The first-run connect screen itself, not the tour's entry screen (inbox-tour.spec.ts proves that one).
  markTourDecided(dataDir);
  const env: Record<string, string> = {
    // Only the stubs and the system's own tools: never the agents installed on the machine running the spec.
    PATH: `${bin}:/usr/bin:/bin`,
    HOME: home,
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_BROWSER: NO_BROWSER,
    NO_BROWSER,
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_INBOX_TAILSCALE: '0',
    PLANNOTATOR_INBOX_PHONES: '0',
    PLANNOTATOR_INBOX_NOTES: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
    PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9',
    ...SETUPS[name]!.env,
  };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  rememberInboxOf(dataDir);
  const registry = JSON.parse(readFileSync(join(dataDir, 'inbox', 'inbox.json'), 'utf8')) as { token: string };
  return { root, home, bin, dataDir, url: started.stdout.trim(), token: registry.token };
}

/** A Claude Code session the Inbox sees as live: its bridge poll, held and renewed until `stop`. */
function holdLiveSession(c: Computer, project: string): () => void {
  const controller = new AbortController();
  let stopped = false;
  void (async () => {
    while (!stopped) {
      await fetch(new URL('api/inbox/bridge/poll', c.url), {
        method: 'POST',
        headers: { authorization: `Bearer ${c.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ session: 'ses_first_run', host: 'claude-code', project_path: project, started_at: Date.now() - 60_000, busy: false, waitMs: 20_000 }),
        signal: controller.signal,
      }).catch(() => undefined);
    }
  })();
  return () => {
    stopped = true;
    controller.abort();
  };
}

async function openWindow(browser: Browser, c: Computer, errors: string[]): Promise<Page> {
  const context = await browser.newContext({ viewport: DESKTOP, deviceScaleFactor: 2, colorScheme: 'light' });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(c.url).origin });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto(c.url);
  await expect(page.getByRole('heading', { name: 'No agent has written yet', exact: true })).toBeVisible();
  await expect(page.locator('.ib-cn')).toBeVisible();
  return page;
}

/** Desktop and phone, light and dark, like the mock's shots. */
async function shoot(page: Page, scenario: string): Promise<void> {
  mkdirSync(shots, { recursive: true });
  for (const [size, viewport] of [['', DESKTOP], ['-phone', PHONE]] as const) {
    await page.setViewportSize(viewport);
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      await page.waitForFunction((dark) => document.documentElement.classList.contains('light') !== dark, scheme === 'dark', { timeout: 3000 });
      await page.waitForTimeout(400);
      await page.mouse.move(0, 0);
      if (size === '-phone') {
        // The list column scrolls inside the window, so a full-page shot is a window as tall as the screen's content.
        const tall = await page.evaluate(() => {
          const body = document.querySelector('.ib-lbody')!;
          return Math.ceil(body.getBoundingClientRect().top + body.scrollHeight);
        });
        await page.setViewportSize({ width: PHONE.width, height: Math.max(PHONE.height, tall) });
      }
      await page.screenshot({ path: join(shots, `c-${scenario}${size}-${scheme}.png`) });
      if (size === '-phone') await page.setViewportSize(PHONE);
    }
  }
  await page.setViewportSize(DESKTOP);
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
}

const hero = (page: Page) => page.locator('.ib-cn');
const listItems = (page: Page, heading: string) => page.locator('.ib-cl > div').filter({ has: page.getByRole('heading', { name: heading, exact: true }) }).locator('li');

test.beforeAll(() => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
});
test.afterAll(async () => {
  await removeInboxScratch();
});

test('typical: turn on Pi\'s Inbox tool (its measured cost named), Claude Code running now, Turn on writes config.json and the card moves to OpenCode', async ({ browser }) => {
  const c = start('typical');
  const project = join(c.root, 'plannotator');
  mkdirSync(project, { recursive: true });
  const stop = holdLiveSession(c, project);
  const errors: string[] = [];
  try {
    const page = await openWindow(browser, c, errors);
    await expect(hero(page).locator('h3')).toHaveText("Turn on Pi's Inbox tool");
    await expect(hero(page).locator('.ib-cn-eb')).toHaveText('Next step · 1 of 2');
    await expect(hero(page).locator('p b')).toHaveText(/^about \d+ KB, roughly [\d,]+ tokens$/);
    await expect(listItems(page, 'Already connected')).toHaveText(['Claude Code plugin · running now', 'Codex MCP · sees replies when it checks', 'Cursor MCP · sees replies when it checks']);
    await expect(listItems(page, 'Left to do')).toHaveText(['Pi now', 'OpenCode install']);
    await expect(page.getByRole('button', { name: 'Message Claude Code' })).toBeVisible();
    await expect(page.locator('.ib-try-where')).toHaveText('Claude Code is running in plannotator. It answers here.');
    await shoot(page, 'typical');

    await hero(page).getByRole('button', { name: 'Turn on' }).click();
    await expect(hero(page).locator('h3')).toHaveText("Connect OpenCode with Plannotator's plugin");
    // Focus moved to the next card's heading, never dropped to the page.
    await expect(hero(page).locator('h3')).toBeFocused();
    expect(JSON.parse(readFileSync(join(c.dataDir, 'config.json'), 'utf8')).inboxTool).toEqual({ pi: true });
    await expect(listItems(page, 'Already connected')).toContainText(['Pi next session']);
    // Message opens compose, addressed to the live Claude Code session.
    await page.getByRole('button', { name: 'Message Claude Code' }).click();
    await expect(page.getByRole('dialog', { name: /New message/ })).toBeVisible();
    await expect(page.getByRole('dialog', { name: /New message/ })).toContainText('Claude Code');
    await page.context().close();
    expect(errors).toEqual([]);
  } finally {
    stop();
  }
});

test('plugin missing: Claude Code\'s install command to copy; once the plugin is installed, the window moves on by itself to Pi\'s extension', async ({ browser }) => {
  const c = start('missing');
  const errors: string[] = [];
  const page = await openWindow(browser, c, errors);
  await expect(hero(page).locator('h3')).toHaveText("Connect Claude Code with Plannotator's plugin");
  await expect(listItems(page, 'Already connected')).toHaveText(['Pi MCP · sees replies when it checks', 'Codex MCP · sees replies when it checks']);
  await expect(listItems(page, 'Left to do')).toHaveText(['Claude Code now', 'Pi install', 'OpenCode: not on this computer']);
  await shoot(page, 'missing');

  await hero(page).getByRole('button', { name: 'Copy' }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('claude plugin marketplace add backnotprop/plannotator\nclaude plugin install plannotator@plannotator');
  // The person runs it in a terminal: Claude Code's settings now enable the plugin. Back in the window, it moves on.
  claudePlugin({ home: c.home, bin: c.bin, binary });
  await expect
    .poll(async () => {
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      return hero(page).locator('h3').textContent();
    }, { timeout: 20_000, intervals: [500, 1000, 2000] })
    .toBe("Give Pi Plannotator's extension");
  await expect(hero(page).locator('pre')).toHaveText('pi install npm:@plannotator/pi-extension');
  await page.context().close();
  expect(errors).toEqual([]);
});

test('nothing found: connect your first agent (Claude Code, Pi or OpenCode), MCP one fold away, every other agent in the picker', async ({ browser }) => {
  const c = start('none');
  const errors: string[] = [];
  const page = await openWindow(browser, c, errors);
  await expect(hero(page).locator('h3')).toHaveText('Connect your first agent');
  await expect(page.locator('.ib-cl')).toHaveCount(0);
  await shoot(page, 'none');

  await hero(page).getByRole('button', { name: 'Use MCP instead' }).click();
  await expect(hero(page).locator('pre').nth(1)).toHaveText(`claude mcp add --scope user plannotator-inbox -- ${realpathSync(binary)} inbox mcp`);
  await hero(page).getByText('Pi', { exact: true }).click();
  await expect(hero(page).locator('pre').first()).toHaveText('pi install npm:@plannotator/pi-extension');
  await page.getByRole('button', { name: 'Another agent or editor' }).click();
  await expect(page.getByRole('tab', { name: 'VS Code' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Claude Code' })).toHaveCount(0);
  await page.context().close();
  expect(errors).toEqual([]);
});

test('locked: PLANNOTATOR_INBOX_TOOL=0 keeps Claude Code\'s and Pi\'s tools off; they are not steps and say why', async ({ browser }) => {
  const c = start('locked');
  const errors: string[] = [];
  const page = await openWindow(browser, c, errors);
  await expect(hero(page).locator('h3')).toHaveText("Connect OpenCode with Plannotator's plugin");
  await expect(hero(page).locator('.ib-cn-eb')).toHaveText('Next step · last one');
  await expect(listItems(page, 'Left to do')).toHaveText(['OpenCode now', 'Claude Code locked by PLANNOTATOR_INBOX_TOOL=0', 'Pi locked by PLANNOTATOR_INBOX_TOOL=0']);
  // No step turns a locked tool on (the notifications ask under Try it has its own Turn on).
  await expect(hero(page).getByRole('button', { name: 'Turn on' })).toHaveCount(0);
  await expect(page.locator('[data-connect-lists] button')).toHaveCount(0);
  await shoot(page, 'locked');
  await page.context().close();
  expect(errors).toEqual([]);
});

test('which agents a reply wakes: said once on the first-run screen, and per agent in Settings → Agents', async ({ browser }) => {
  const c = start('wake');
  const errors: string[] = [];
  const page = await openWindow(browser, c, errors);
  await expect(listItems(page, 'Already connected')).toHaveText(['Claude Code plugin', 'Codex MCP · sees replies when it checks']);
  await expect(page.locator('[data-wake-note]')).toHaveText(
    "With Plannotator's connection, your replies arrive as a new turn on their own in Claude Code, Pi and OpenCode 2, and in Codex 0.149 or later through MCP. Other agents see your reply the next time they check the Inbox.",
  );
  const out = resolve(process.env.PLANNOTATOR_WAKE_SHOTS ?? shots);
  mkdirSync(out, { recursive: true });
  const both = async (name: string, phone: boolean) => {
    for (const scheme of ['light', 'dark'] as const) {
      await page.setViewportSize(phone ? PHONE : DESKTOP);
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      await page.waitForFunction((dark) => document.documentElement.classList.contains('light') !== dark, scheme === 'dark', { timeout: 3000 });
      await page.waitForTimeout(400);
      await page.mouse.move(0, 0);
      await page.screenshot({ path: join(out, `wake-${name}${phone ? '-phone' : ''}-${scheme}.png`), fullPage: true });
    }
  };
  await both('first-run', false);
  await both('first-run', true);
  await page.setViewportSize(DESKTOP);
  await page.goto(`${c.url}#settings/agents`);
  const claude = page.locator('[data-agent="claude-code"] [data-agent-replies]');
  const codex = page.locator('[data-agent="codex"] [data-agent-replies]');
  await expect(claude).toHaveText(/Your replies\s*arrive as a new turn/);
  await expect(codex).toHaveText(/Your replies\s*seen when it checks the Inbox; it can't be woken/);
  // No native titles on the new lines.
  await expect(page.locator('[data-wake-note] [title], [data-agent-replies] [title]')).toHaveCount(0);
  await both('settings-agents', false);
  await both('settings-agents', true);
  await page.context().close();
  expect(errors).toEqual([]);
});

test('a Codex the Inbox can wake (0.149 or later) reads as woken: Already connected and Settings → Agents', async ({ browser }) => {
  const c = start('codexWakes');
  const errors: string[] = [];
  const page = await openWindow(browser, c, errors);
  await expect(listItems(page, 'Already connected')).toHaveText(['Claude Code plugin', 'Codex MCP · replies arrive as a new turn']);
  await page.goto(`${c.url}#settings/agents`);
  await expect(page.locator('[data-agent="codex"] [data-agent-replies]')).toHaveText(/Your replies\s*arrive as a new turn/);
  await page.context().close();
  expect(errors).toEqual([]);
});
