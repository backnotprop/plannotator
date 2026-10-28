/**
 * The thread parity harness's captures (run by scripts/inbox-thread-parity.ts
 * through inbox-thread-parity.config.ts, never by `bun run test:e2e:inbox`).
 *
 * Each project (desktop light and dark, the pane at 360 px light and dark and
 * at 320 px, iPhone 15 light and dark, Pixel 7) copies the seeded data dir
 * (inbox-thread-parity-seed.ts) into its own scratch folder and starts its
 * own Inbox on the copy with PLANNOTATOR_E2E_BINARY, so the reference binary
 * and the candidate binary read the same ids, timestamps, looks and picks.
 * The page clock is fixed at the seed's `frozenAt`, motion is reduced and
 * animations and the caret are off; fonts and images are loaded and decoded
 * before a capture.
 *
 * In order, every capture a zero-pixel `toHaveScreenshot` (the reference run
 * writes the PNGs) plus the outerHTML of what it shows (normalized for the
 * port, the server session, blob URLs and the HTML asset token), written for
 * the script to diff:
 *
 * 1. the list's rows before any thread is opened;
 * 2. per seeded thread: as it lands, page by page from the top, its hover
 *    tooltips (a desktop only: the whole moment of a time, a folded line's
 *    answers, the 👍 pill), the Files band open, Expand all page by page,
 *    the open questions list, the Artifacts view;
 * 3. the list's rows after every thread was looked at, and (a desktop only)
 *    each delivery tick's tooltip;
 * 4. the list and each thread as it lands three days later and a year later
 *    (the other-day and other-year time branches);
 * 5. a 👍 inside its Undo window;
 * 6. live delivery, last: the seeded sessions poll as the Claude Code mod and
 *    Pi do (busy with Send now: Undelivered and Send now; busy on an older
 *    plugin: the restart line; busy without Send now: queued), with the page
 *    clock set from the Inbox's own wait clock so the minutes read the same.
 *
 * Each thread's page errors and console errors are written too, and diffed.
 */

import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { INBOX_BRIDGE_POLL_PATH, INBOX_SEND_NOW_POLL_FIELD } from '../../packages/shared/inbox/connection';
import { parityEnv, readParitySeed, type ParitySeed } from './inbox-thread-parity-seed';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';

const seedRoot = process.env.PLANNOTATOR_PARITY_SEED;
const out = resolve(process.env.PLANNOTATOR_PARITY_OUT ?? '');
const role = process.env.PLANNOTATOR_PARITY_ROLE === 'reference' ? 'reference' : 'candidate';
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? '');

/** At most this many pages of one thread (a page is the scroller's height less an overlap). */
const MAX_PAGES = 12;
/** The thread pane's width in the projects that stand for a host's sidebar. */
const NARROW: Record<string, number> = { 'narrow-360': 360, 'narrow-360-dark': 360, 'narrow-320': 320 };
/** The seeded threads, in capture order (the list reads earlier threads as looked at). */
const THREADS = ['folding', 'questions', 'replaced', 'files', 'actions', 'ack', 'delivery', 'worst', 'choices'];
/** The later clocks: another day this year, and another year. */
const LATER = [
  { name: 'days-later', ms: 3 * 24 * 60 * 60_000 },
  { name: 'year-later', ms: 400 * 24 * 60 * 60_000 },
];
/** What a desktop hovers for its tooltip, in a thread at the top. */
const TIPS = [
  { name: 'time', selector: 'section.ib-pane [data-full-when]' },
  { name: 'folded-time', selector: 'section.ib-pane button.ib-fline .ib-fl-tm' },
  { name: 'answers', selector: 'section.ib-pane button.ib-fline [data-snippet="answers"]' },
  { name: 'ack', selector: 'section.ib-pane .ib-ackwhen' },
];
/** A list row's delivery tick, by state: "Delivered …", "Sent …" (the list's tooltips). */
const LIST_TIPS = ['delivered', 'sent', 'saved', 'undelivered', 'queued'].map((state) => ({ name: `tick-${state}`, selector: `.ib-lbody .ib-tick[data-tick="${state}"]` }));
const TOOLTIP = '[data-pn-tooltip]';

interface Run {
  seed: ParitySeed;
  url: string;
  /** This project's scratch folder (its HOME and data dir). */
  root: string;
  plugins: { installed: string; loaded: string };
  port: number;
  token: string;
  serverSession: string;
}

let run: Run;

test.beforeAll(async ({}, info) => {
  expect(seedRoot, 'PLANNOTATOR_PARITY_SEED: run scripts/inbox-thread-parity.ts').toBeTruthy();
  expect(existsSync(binary), `the binary: ${binary}`).toBe(true);
  const seed = readParitySeed(seedRoot!);
  const root = inboxScratch(`plannotator-thread-parity-${role}-${info.project.name}-`);
  const dataDir = join(root, 'data');
  const home = join(root, 'home');
  // Claude Code's plugins in the scratch HOME (the restart line, inbox-restart.spec.ts): 0.28.25 installed,
  // and 0.28.23's folder, which a working session loaded before the update.
  const pluginFolder = (version: string) => join(home, '.claude', 'plugins', 'cache', 'plannotator', 'plannotator', version);
  const plugins = { installed: pluginFolder('0.28.25'), loaded: pluginFolder('0.28.23') };
  for (const folder of Object.values(plugins)) mkdirSync(folder, { recursive: true });
  writeFileSync(
    join(home, '.claude', 'plugins', 'installed_plugins.json'),
    JSON.stringify({
      version: 2,
      plugins: { 'plannotator@plannotator': [{ scope: 'user', installPath: plugins.installed, version: '0.28.25', installedAt: '2026-10-04T22:07:24.658Z', lastUpdated: '2026-10-17T05:27:07.299Z' }] },
    }),
  );
  // The seeded data, never the seeding Inbox's registry or log.
  cpSync(seed.dataDir, dataDir, { recursive: true, filter: (src) => !/[/\\]inbox[/\\]inbox\.(json|log)$/.test(src) });
  const started = spawnSync(binary, ['inbox', '--background'], { env: parityEnv(home, dataDir), cwd: root, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  rememberInboxOf(dataDir);
  const url = started.stdout.trim().replace(/\/?$/, '/');
  const health = (await (await fetch(`${url}api/inbox/health`)).json()) as { serverSession: string };
  const registry = JSON.parse(readFileSync(join(dataDir, 'inbox', 'inbox.json'), 'utf8')) as { port: number; token: string };
  run = { seed, url, root, plugins, port: registry.port, token: registry.token, serverSession: health.serverSession };
});

test.afterAll(async () => {
  // Every Inbox this project started, then its folder (inbox-scratch.ts).
  await removeInboxScratch();
});

function normalize(html: string): string {
  return html
    .replace(/http:\/\/(127\.0\.0\.1|localhost):\d+/g, 'http://127.0.0.1:PORT')
    .replace(/blob:[^"'\s)]+/g, 'blob:URL')
    // An HTML attachment's asset base carries a token minted per Inbox run.
    .replace(/\/api\/html-assets\/[0-9a-f]+\//g, '/api/html-assets/TOKEN/')
    .split(run.serverSession)
    .join('SERVER_SESSION')
    .split(run.root)
    .join('SCRATCH')
    .replace(/></g, '>\n<');
}

/** Fonts, images and two frames: what a capture waits for beyond toHaveScreenshot's own two equal shots. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(
      [...document.images].filter((img) => !img.complete).map((img) => new Promise((done) => {
        img.addEventListener('load', done, { once: true });
        img.addEventListener('error', done, { once: true });
      })),
    );
    // Decoded too, so no image paints in a later frame than its tile.
    await Promise.all([...document.images].map((img) => img.decode().catch(() => {})));
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  });
  // WebKit draws an image it just scaled at low quality and repaints it at high quality half a second later
  // (its ImageQualityController): wait that out, then repaint the scrollers whole (a layer for two frames,
  // then none; nothing moves, nothing takes focus). Even so, WebKit now and then blends the one pixel row
  // where a scroller clips a picture tile a few colour levels differently from run to run (main against
  // itself too); the report names such a capture, and its DOM still matches.
  if (page.context().browser()?.browserType().name() === 'webkit') {
    await page.waitForTimeout(700);
    await page.evaluate(async () => {
      const frames = () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
      // Each scroller's style attribute is put back exactly as it was, so the captured DOM is untouched.
      const scrollers = [...document.querySelectorAll<HTMLElement>('.ib-pbody, .ib-lbody')].map((el) => ({ el, style: el.getAttribute('style') }));
      for (const { el } of scrollers) el.style.setProperty('transform', 'translateZ(0)');
      await frames();
      for (const { el, style } of scrollers) {
        if (style === null) el.removeAttribute('style');
        else el.setAttribute('style', style);
      }
      await frames();
    });
  }
}

function domDir(info: TestInfo): string {
  const dir = join(out, role, 'dom', info.project.name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * `realTimes`: what in the capture shows a time the Inbox stamped from its own clock while the capture ran
 * (not the seed's). Its clock times are rewritten to 12:00 PM in the page just before the capture (a mask
 * would be as wide as the time it hides), so the rest of that text is still compared.
 */
async function capture(page: Page, info: TestInfo, thread: string, state: string, dom = 'section.ib-pane', realTimes: string[] = []): Promise<void> {
  for (const selector of realTimes) {
    await page.locator(selector).evaluateAll((els) => {
      for (const el of els) {
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) node.nodeValue = node.nodeValue!.replace(/\b\d{1,2}:\d{2}(\s?[AP]M)\b/g, '12:00$1');
      }
    });
  }
  await settle(page);
  await expect.soft(page).toHaveScreenshot(`${thread}-${state}.png`);
  const html = await page.locator(dom).evaluateAll((els) => els.map((el) => el.outerHTML).join('\n'));
  const metrics = await page.evaluate(() => {
    const scroller = document.querySelector('section.ib-pane .ib-pbody');
    return scroller ? { scrollTop: Math.round(scroller.scrollTop), scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight } : null;
  });
  writeFileSync(join(domDir(info), `${thread}-${state}.html`), `<!-- ${JSON.stringify(metrics)} -->\n${normalize(html)}\n`);
}

/** The thread from the top, a page at a time. */
async function pages(page: Page, info: TestInfo, thread: string, prefix: string): Promise<void> {
  const scroller = page.locator('section.ib-pane .ib-pbody');
  if ((await scroller.count()) === 0) return;
  const { height, client } = await scroller.evaluate((el) => ({ height: el.scrollHeight, client: el.clientHeight }));
  const step = Math.max(200, client - 80);
  for (let i = 0, top = 0; i < MAX_PAGES; i++, top += step) {
    await scroller.evaluate((el, y) => el.scrollTo({ top: y, behavior: 'instant' }), Math.min(top, height - client));
    await capture(page, info, thread, `${prefix}${i}`);
    if (top + client >= height) break;
  }
}

async function scrollTop(page: Page): Promise<void> {
  await page.locator('section.ib-pane .ib-pbody').evaluate((el) => el.scrollTo({ top: 0, behavior: 'instant' }));
}

async function open(page: Page, hash: string): Promise<void> {
  await page.goto('about:blank');
  await page.goto(`${run.url}#${hash}`);
  await expect(page.locator('section.ib-pane')).toBeVisible();
}

/** The list at rest, no thread open (on a phone, the list screen). */
async function list(page: Page, info: TestInfo, state: string): Promise<void> {
  await page.goto('about:blank');
  await page.goto(run.url);
  await expect(page.locator('.ib-lbody [data-thread-id]').first()).toBeVisible();
  await capture(page, info, 'list', state, '.ib-lbody');
}

/** Each tooltip a desktop shows here: hovered, captured with its popup, then let go. */
async function tooltips(page: Page, info: TestInfo, thread: string, tips = TIPS): Promise<void> {
  for (const tip of tips) {
    const target = page.locator(tip.selector).first();
    if ((await target.count()) === 0 || !(await target.isVisible())) continue;
    await target.scrollIntoViewIfNeeded();
    await target.hover();
    await expect(page.locator(TOOLTIP)).toBeVisible();
    await capture(page, info, thread, `tip-${tip.name}`, `${tip.selector}, ${TOOLTIP}`);
    await page.mouse.move(0, 0);
    await expect(page.locator(TOOLTIP)).toHaveCount(0);
  }
}

/** One agent session's connection, polling as the Claude Code mod (or Pi) polls: busy, and what it loaded. */
class Connection {
  private stopped = false;
  private readonly loop: Promise<void>;
  constructor(private readonly body: Record<string, unknown>) {
    this.loop = this.run();
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      // It never reports a delivery: what waits keeps waiting.
      await fetch(`http://127.0.0.1:${run.port}${INBOX_BRIDGE_POLL_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${run.token}` },
        body: JSON.stringify({ waitMs: 1_000, busy: true, started_at: Date.parse('2026-10-01T09:00:00Z'), idle_since: null, ...this.body }),
      }).catch(() => null);
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.loop;
  }
}

type Waits = Record<string, { since: string; auto_since: string | null }>;

/** The Inbox's wait clocks for `session`'s items in `thread` (GET …/sessions?asker=), once its poll was seen. */
async function waitsOf(thread: string, session: string): Promise<Waits> {
  let waits: Waits = {};
  await expect
    .poll(async () => {
      const model = (await (await fetch(`${run.url}api/inbox/threads/${thread}/sessions?asker=${session}`)).json()) as { asker?: { connection?: { busy: boolean | null; waits?: Waits } | null } };
      waits = model.asker?.connection?.waits ?? {};
      return model.asker?.connection?.busy === true && Object.keys(waits).length > 0;
    }, { timeout: 15_000 })
    .toBe(true);
  return waits;
}

// One test per project: a capture that differs fails softly and every later capture still runs in the
// same Inbox, so each capture reads the same looks as in the reference run.
test('every seeded thread', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    // The browser refusing a script in a sandboxed HTML attachment is the sandbox working; when it logs
    // depends on when the frame loads.
    if (message.type() === 'error' && !/^Blocked script execution in 'about:srcdoc'/.test(message.text())) errors.push(`console.error: ${message.text()}`);
  });
  const hover = !info.project.use.hasTouch;
  await page.clock.setFixedTime(new Date(run.seed.frozenAt));
  const narrow = NARROW[info.project.name];
  if (narrow) {
    await page.addInitScript((css) => {
      document.addEventListener('DOMContentLoaded', () => {
        const style = document.createElement('style');
        style.dataset.parity = 'narrow';
        style.textContent = css;
        document.head.appendChild(style);
      });
    }, `section.ib-pane { flex: 0 0 ${narrow}px !important; width: ${narrow}px !important; max-width: ${narrow}px !important; }`);
  }
  const step = async (name: string, body: () => Promise<void>) =>
    test.step(name, async () => {
      errors.length = 0;
      await body();
      writeFileSync(join(domDir(info), `${name}-errors.txt`), `${errors.map((e) => normalize(e)).join('\n')}\n`);
    });
  const id = (name: string) => {
    const value = run.seed.threads[name];
    expect(value, `the seed has no ${name} thread`).toBeTruthy();
    return value!;
  };

  await step('list-start', () => list(page, info, 'start'));

  for (const name of THREADS) {
    await step(name, async () => {
      // As it lands (a new message: at "New since you looked"), then page by page.
      await open(page, `thread=${id(name)}`);
      await capture(page, info, name, 'land');
      await pages(page, info, name, 'page-');
      await scrollTop(page);
      if (hover) {
        await tooltips(page, info, name);
        await scrollTop(page);
      }

      // The Files band, open.
      const files = page.locator('section.ib-pane [data-header-files]').first();
      if ((await files.count()) > 0 && (await files.isVisible())) {
        await files.click();
        await page.mouse.move(0, 0);
        await capture(page, info, name, 'files-band');
        await files.click();
        await page.mouse.move(0, 0);
      }

      // Expand all, when the thread folds.
      const expand = page.locator('section.ib-pane [data-expand-all]');
      if ((await expand.count()) > 0 && (await expand.getAttribute('aria-label')) === 'Expand all messages') {
        await expand.click();
        await page.mouse.move(0, 0);
        await pages(page, info, name, 'expanded-');
      }

      // The open questions list.
      const questions = page.locator('section.ib-pane .ib-pfoot [data-open-questions]');
      if ((await questions.count()) > 0 && (await questions.isVisible())) {
        await questions.click();
        await expect(page.locator('[data-open-questions-list]')).toBeVisible();
        await capture(page, info, name, 'open-questions', 'section.ib-pane, [data-open-questions-list]');
        await page.keyboard.press('Escape');
      }

      // The Artifacts view, when the thread has one.
      if ((await page.locator('section.ib-pane [data-artifacts-button]').count()) > 0) {
        await open(page, `thread=${id(name)}&artifacts`);
        await capture(page, info, name, 'artifacts');
      }
    });
  }

  await step('list-end', async () => {
    await list(page, info, 'end');
    // The Quiet band open (the 👍 thread), then each delivery tick's tooltip.
    const quiet = page.locator('[data-section-id="quiet"] .ib-band');
    if ((await quiet.count()) > 0 && (await quiet.getAttribute('aria-expanded')) !== 'true') {
      await quiet.click();
      await page.mouse.move(0, 0);
      await capture(page, info, 'list', 'end-quiet', '.ib-lbody');
    }
    if (hover) await tooltips(page, info, 'list', LIST_TIPS);
  });

  // Later clocks: the other-day and other-year branches of every time.
  for (const later of LATER) {
    await step(later.name, async () => {
      await page.clock.setFixedTime(new Date(Date.parse(run.seed.frozenAt) + later.ms));
      await list(page, info, later.name);
      for (const name of THREADS) {
        await open(page, `thread=${id(name)}`);
        await capture(page, info, name, later.name);
      }
    });
  }

  // A 👍 inside its Undo window (the Inbox sends it once the window passes), the toast hidden: its timer is
  // the page's, not the clock's.
  await step('ack-pending', async () => {
    await page.clock.setFixedTime(new Date(run.seed.frozenAt));
    await open(page, `thread=${id('files')}`);
    await page.addStyleTag({ content: '.ib-toast { visibility: hidden !important; }' });
    await page.locator('section.ib-pane [data-ack]').click();
    await page.mouse.move(0, 0);
    await expect(page.locator('section.ib-pane [data-ack-pill="pending"]')).toBeVisible();
    // The 👍 and the Mark read it brings are stamped by the Inbox's clock as the capture runs.
    await capture(page, info, 'files', 'ack-pending', 'section.ib-pane', ['section.ib-pane .ib-ackwhen', 'section.ib-pane [data-read-line] > div > span:first-child']);
  });

  // Live delivery, last (the Inbox remembers a connection for a while after it stops, so a later capture would
  // depend on timing). Claude Code on the delivery thread works with Send now: Undelivered and Send now. The
  // replaced thread's Claude Code works on plugin 0.28.23 with 0.28.25 installed: the restart line. Pi on the
  // 👍 thread works with no Send now: queued.
  await step('live', async () => {
    const { sessions } = run.seed;
    const { plugins } = run;
    const project = join(run.seed.root, 'src', 'billing-svc');
    const connections = [
      new Connection({ session: sessions.delivery, host: 'claude-code', project_path: project, session_folder: project, [INBOX_SEND_NOW_POLL_FIELD]: true, plugin: { version: '0.28.25', root: plugins.installed, loaded_at: Date.parse('2026-10-20T09:00:00Z') }, engine: '2.1.305' }),
      new Connection({ session: sessions.replaced, host: 'claude-code', project_path: project, session_folder: project, plugin: { version: '0.28.23', root: plugins.loaded, loaded_at: Date.parse('2026-10-16T09:14:00Z') }, engine: '2.1.305' }),
      new Connection({ session: sessions.ack, host: 'pi', project_path: join(run.seed.root, 'src', 'docs-site') }),
    ];
    try {
      // The minutes on a waiting reply count from the Inbox's own clock (when it first saw the session busy):
      // read it, and set the page clock 90 s after it, so every run reads the same minutes.
      const waits = { ...(await waitsOf(id('delivery'), sessions.delivery)), ...(await waitsOf(id('replaced'), sessions.replaced)) };
      const since = Math.max(...Object.values(waits).map((w) => Date.parse(w.since)));
      await page.clock.setFixedTime(new Date(since + 90_000));
      for (const name of ['delivery', 'replaced', 'ack']) {
        await open(page, `thread=${id(name)}`);
        await page.locator('section.ib-pane .ib-pbody').evaluate((el) => el.scrollTo({ top: el.scrollHeight, behavior: 'instant' }));
        await capture(page, info, name, 'live');
      }
    } finally {
      await Promise.all(connections.map((c) => c.stop()));
    }
  });
});
