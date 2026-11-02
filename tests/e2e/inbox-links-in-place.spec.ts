/**
 * A link to another thread opens in the same Inbox, proved in a real browser
 * against the compiled binary. Nothing is mocked: `plannotator inbox
 * --background` runs under temp folders, an agent sends through `plannotator
 * inbox mcp` (scripts/inbox-sim.ts) a message with one of every link, a question
 * whose prompt links a thread, and attached Markdown and HTML files that link
 * one too.
 *
 * In place, at a desktop size and a phone's, with no tab opened: a Markdown
 * link, a bare URL and an autolink to a thread, one with `&msg=` or `&file=`,
 * a thread in another project, the thread already open, `#project=`,
 * `#settings`, the `127.0.0.1` spelling, a hash-only `#thread=`. Back returns,
 * an unsent draft stays, a phone's stack is the one a row tap builds, and a thread
 * that does not exist shows what opening its hash shows.
 *
 * Still a new tab: another port (a linked machine, played by a small server),
 * another host, the web, the Inbox's root, Cmd or Ctrl, Shift and middle click,
 * and a link in a dialog (the screen would change out of sight) or beside a
 * comment not saved yet. Runs in Chromium and WebKit.
 *
 * Build the binary first (see inbox.spec.ts), then `bun run test:e2e:inbox`.
 */

import { devices, expect, test, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));

/** A well-formed thread id no Inbox holds. */
const NO_SUCH_THREAD = 'msg_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const TAILNET_NAME = 'https://mac-mini.tail1234.ts.net/';
const OUTSIDE = 'https://example.com/';

interface World {
  origin: string;
  T1: string;
  T2: string;
  T3: string;
  T4: string;
  /** T1's short first message, far above its links. */
  M1: string;
  /** T1's message with the links. */
  links: string;
  /** T2's second message, the target of `&msg=`. */
  M2: string;
  /** The file attached to T2, the target of `&file=`. */
  F2: string;
  project: string;
  markdown: string;
  html: string;
  machine: string;
}

let world: World;
let agent: SimAgent | undefined;
let linkedMachine: Server | undefined;

const filler = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag} paragraph ${i + 1}: long enough that the thread has to scroll.`).join('\n\n');

test.beforeAll(async () => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  linkedMachine = createServer((_, response) => response.end('<!doctype html><title>Another machine</title>'));
  await new Promise<void>((done) => linkedMachine!.listen(0, 'localhost', done));
  const otherPort = (linkedMachine.address() as AddressInfo).port;

  const root = inboxScratch('plannotator-links-in-place-');
  const dataDir = join(root, 'data');
  const home = join(root, 'home');
  mkdirSync(dataDir);
  mkdirSync(home);
  // The dialog case needs Decision mode, which is off by default.
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ experimental: { decisionMode: true } }));
  const env = {
    PATH: process.env.PATH ?? '', HOME: home, PLANNOTATOR_DATA_DIR: dataDir,
    CLAUDE_CONFIG_DIR: join(root, 'claude'), CODEX_HOME: join(root, 'codex'), OPENCODE_CONFIG_DIR: join(root, 'opencode'),
    PLANNOTATOR_BROWSER: NO_BROWSER, NO_BROWSER, PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9',
    PLANNOTATOR_INBOX_CONNECT: '0', PLANNOTATOR_INBOX_TAILSCALE: '0', PLANNOTATOR_INBOX_PHONES: '0',
    PLANNOTATOR_UPDATE_CHECK: '0', PLANNOTATOR_INBOX_NOTES: '0',
  };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  rememberInboxOf(dataDir);
  const origin = new URL(started.stdout.trim().split('\n').pop()!).origin;
  const port = new URL(origin).port;

  agent = await SimAgent.connect({ binary, env, name: 'Claude', host: 'claude-code' });
  const alpha = scratchProject(join(root, 'src'), 'alpha');
  const beta = scratchProject(join(root, 'src'), 'beta');
  mkdirSync(join(alpha, 'docs'));
  writeFileSync(join(alpha, 'docs', 't2.md'), '# T2 file\n\nA file of the second thread.\n');

  // A named thread each: an agent's next message in a project otherwise joins the thread it is in.
  const t2 = await agent.send({ project_path: alpha, subject: 'Second thread', thread: 'second-thread', body: `T2 first message.\n\n${filler(40, 'T2')}` });
  const T2 = t2.thread_id as string;
  const t2b = await agent.send({ project_path: alpha, reply_to: T2, body: 'T2 second message, the target of the link.', attachments: ['docs/t2.md'] });
  const t3 = await agent.send({ project_path: beta, subject: 'Beta thread', thread: 'beta-thread', body: 'T3 in project beta.' });
  const T3 = t3.thread_id as string;
  const t4 = await agent.send({
    project_path: alpha,
    subject: 'Decide thread',
    thread: 'decide-thread',
    body: [
      ':::question',
      `Pick one, see [T2 from a dialog](${origin}/#thread=${T2}).`,
      '',
      '- [ ] A',
      '- [ ] B',
      ':::',
      '',
      ':::question',
      `Pick another, see [hash only from a dialog](#thread=${T2}).`,
      '',
      '- [ ] C',
      '- [ ] D',
      ':::',
    ].join('\n'),
  });

  const t1 = await agent.send({ project_path: alpha, subject: 'First thread', thread: 'first-thread', body: 'T1 opening message.' });
  const T1 = t1.thread_id as string;
  expect(new Set([T1, T2, T3, t4.thread_id]).size).toBe(4);
  await agent.send({ project_path: alpha, reply_to: T1, body: filler(45, 'T1') });
  writeFileSync(
    join(alpha, 'docs', 'notes.md'),
    [
      '# Notes',
      `See [other thread](${origin}/#thread=${T2}) and bare ${origin}/#thread=${T2} end.`,
      `On another machine: [other port](http://localhost:${otherPort}/#thread=${T2}).`,
      '[To Settings](#settings) is a heading of this file.',
      filler(60, 'Notes'),
      '## Settings',
      'The heading the link above goes to.',
    ].join('\n\n'),
  );
  writeFileSync(
    join(alpha, 'docs', 'page.html'),
    `<!doctype html><html><head><meta charset="utf-8"><title>page</title></head><body><h1>Page</h1><p><a href="${origin}/#thread=${T2}">Page to T2</a></p><p><a href="http://127.0.0.1:${port}/#thread=${T3}">Page to T3</a></p><p><a href="${OUTSIDE}">Page to the web</a></p></body></html>`,
  );
  const lines = [
    `[link to T2](${origin}/#thread=${T2})`,
    `bare ${origin}/#thread=${T2} end`,
    `autolink <${origin}/#thread=${T2}>`,
    `[link to T2 message](${origin}/#thread=${T2}&msg=${t2b.message_id})`,
    `[link to T2 file](${origin}/#thread=${T2}&file=${(t2b.attachments as { id: string }[])[0]!.id})`,
    `[link to T3](${origin}/#thread=${T3})`,
    `[link to this thread](${origin}/#thread=${T1})`,
    `[link to this thread message](${origin}/#thread=${T1}&msg=${t1.message_id})`,
    `[project alpha](${origin}/#project=${(t2.project as { id: string }).id})`,
    `[settings](${origin}/#settings)`,
    `[127 spelling](http://127.0.0.1:${port}/#thread=${T2})`,
    `[hash only](#thread=${T2})`,
    `[missing thread](${origin}/#thread=${NO_SUCH_THREAD})`,
    `[other port](http://localhost:${otherPort}/#thread=${T2})`,
    `[tailnet name](${TAILNET_NAME}#thread=${T2})`,
    `[the web](${OUTSIDE})`,
    `[inbox root](${origin}/)`,
  ];
  const message = await agent.send({
    project_path: alpha,
    reply_to: T1,
    attachments: ['docs/notes.md', 'docs/page.html'],
    body: [
      filler(6, 'Before'),
      ...lines,
      ':::question',
      `Pick one, see [T2 in a question](${origin}/#thread=${T2}).`,
      '',
      '- [ ] A',
      '- [ ] B',
      ':::',
      filler(30, 'After'),
    ].join('\n\n'),
  });
  const files = message.attachments as { id: string; name: string }[];
  world = {
    origin, T1, T2, T3, T4: t4.thread_id as string,
    M1: t1.message_id as string, links: message.message_id as string, M2: t2b.message_id as string,
    F2: (t2b.attachments as { id: string }[])[0]!.id,
    project: (t2.project as { id: string }).id,
    markdown: files.find((file) => file.name === 'notes.md')!.id,
    html: files.find((file) => file.name === 'page.html')!.id,
    machine: `http://localhost:${otherPort}/#thread=${T2}`,
  };
});

test.afterAll(async () => {
  await agent?.close().catch(() => {});
  await new Promise<void>((done) => (linkedMachine ? linkedMachine.close(() => done()) : done()));
  await removeInboxScratch();
});

type View = 'desktop' | 'phone';
const { defaultBrowserType: _phoneBrowser, ...iPhone } = devices['iPhone 14'];

interface Scene {
  page: Page;
  context: BrowserContext;
  /** Every tab opened since the scene began. */
  tabs: Page[];
  press: (target: Locator) => Promise<void>;
}

/** A fresh window at this size, watching for tabs; the outside addresses answer here, not on the network. */
async function scene(browser: Browser, view: View, run: (scene: Scene) => Promise<void>): Promise<void> {
  const context = await browser.newContext({ reducedMotion: 'reduce', ...(view === 'phone' ? { ...iPhone, viewport: { width: 390, height: 844 } } : { viewport: { width: 1440, height: 900 } }) });
  await context.route(`${OUTSIDE}**`, (route) => route.fulfill({ contentType: 'text/html', body: '<title>The web</title>' }));
  await context.route(`${TAILNET_NAME}**`, (route) => route.fulfill({ contentType: 'text/html', body: '<title>Another tailnet machine</title>' }));
  const tabs: Page[] = [];
  const page = await context.newPage();
  context.on('page', (tab) => tabs.push(tab));
  try {
    await run({ page, context, tabs, press: (target) => (view === 'phone' ? target.tap() : target.click()) });
  } finally {
    await context.close();
  }
}

const subject = (page: Page) => page.locator('section.ib-pane h2.ib-subject');
const linksMessage = (page: Page) => page.locator(`[data-message-id="${world.links}"]`);
const inMessage = (name: string) => (page: Page) => linksMessage(page).getByRole('link', { name, exact: true });
const threadUrl = (id: string) => `${world.origin}/#thread=${id}`;

async function openFirstThread(page: Page): Promise<void> {
  await page.goto(threadUrl(world.T1));
  await expect(subject(page)).toHaveText(/First thread/);
  await expect(linksMessage(page)).toBeVisible();
}

async function openFile(page: Page, id: string): Promise<Locator> {
  await page.goto(`${threadUrl(world.T1)}&file=${id}&view=side`);
  const pane = page.locator('[data-attachment-pane]');
  await expect(pane).toBeVisible();
  return pane;
}

/** Long enough for a tab to have opened after what the assertion before it saw. */
async function noTabOpened({ page, tabs }: Scene): Promise<void> {
  await page.waitForTimeout(500);
  expect(tabs.map((tab) => tab.url())).toEqual([]);
}

/** The bare URL and the autolink draw the same address: the two the message text shows as a URL. */
const urlLink = (at: number) => (page: Page) => linksMessage(page).locator(`a[href="${threadUrl(world.T2)}"]`).filter({ hasText: 'http' }).nth(at);

const IN_PLACE: { name: string; link: (page: Page) => Locator; to: () => string; shows: RegExp }[] = [
  { name: 'a Markdown link', link: inMessage('link to T2'), to: () => threadUrl(world.T2), shows: /Second thread/ },
  { name: 'a bare URL', link: urlLink(0), to: () => threadUrl(world.T2), shows: /Second thread/ },
  { name: 'an autolink', link: urlLink(1), to: () => threadUrl(world.T2), shows: /Second thread/ },
  { name: 'a thread in another project', link: inMessage('link to T3'), to: () => threadUrl(world.T3), shows: /Beta thread/ },
  { name: 'the 127.0.0.1 spelling, on the window\'s own address', link: inMessage('127 spelling'), to: () => threadUrl(world.T2), shows: /Second thread/ },
  { name: 'a hash-only link', link: inMessage('hash only'), to: () => threadUrl(world.T2), shows: /Second thread/ },
  { name: 'a link in a question prompt', link: inMessage('T2 in a question'), to: () => threadUrl(world.T2), shows: /Second thread/ },
];

for (const view of ['desktop', 'phone'] as const) {
  test.describe(view, () => {
    for (const kind of IN_PLACE) {
      test(`${kind.name} opens in place, and Back returns`, async ({ browser }) => {
        await scene(browser, view, async (s) => {
          const { page, press } = s;
          await openFirstThread(page);
          await press(kind.link(page));
          await expect(page).toHaveURL(kind.to(), { timeout: 5_000 });
          await expect(subject(page)).toHaveText(kind.shows);
          await noTabOpened(s);
          await page.goBack();
          await expect(page).toHaveURL(threadUrl(world.T1));
          await expect(subject(page)).toHaveText(/First thread/);
        });
      });
    }

    test('a link with &msg= lands on the message and the address drops it', async ({ browser }) => {
      await scene(browser, view, async (s) => {
        const { page, press } = s;
        await openFirstThread(page);
        await press(inMessage('link to T2 message')(page));
        await expect(subject(page)).toHaveText(/Second thread/, { timeout: 5_000 });
        await expect(page.locator(`[data-message-id="${world.M2}"]`)).toBeInViewport();
        await expect(page).toHaveURL(threadUrl(world.T2));
        await noTabOpened(s);
      });
    });

    test('a link with &file= opens the file beside the thread', async ({ browser }) => {
      await scene(browser, view, async (s) => {
        const { page, press } = s;
        await openFirstThread(page);
        await press(inMessage('link to T2 file')(page));
        await expect(page.locator('[data-attachment-pane]')).toHaveAttribute('aria-label', 't2.md', { timeout: 5_000 });
        await expect(page).toHaveURL(new RegExp(`#thread=${world.T2}&file=${world.F2}`));
        await noTabOpened(s);
      });
    });

    test('the thread already open stays one entry, with or without a message', async ({ browser }) => {
      await scene(browser, view, async (s) => {
        const { page, press } = s;
        await openFirstThread(page);
        const entries = await page.evaluate(() => history.length);
        await press(inMessage('link to this thread')(page));
        await expect(page).toHaveURL(threadUrl(world.T1));
        await expect(subject(page)).toHaveText(/First thread/);

        const first = page.locator(`[data-message-id="${world.M1}"]`);
        const link = inMessage('link to this thread message')(page);
        await link.scrollIntoViewIfNeeded();
        await expect(first).not.toBeInViewport();
        await press(link);
        await expect(first).toBeInViewport({ timeout: 5_000 });
        await expect(page).toHaveURL(threadUrl(world.T1));
        expect(await page.evaluate(() => history.length)).toBe(entries);
        await noTabOpened(s);
      });
    });

    test('#project= shows that project\'s list, and Back returns', async ({ browser }) => {
      await scene(browser, view, async (s) => {
        const { page, press } = s;
        await openFirstThread(page);
        await press(inMessage('project alpha')(page));
        await expect(page).toHaveURL(`${world.origin}/#project=${world.project}`, { timeout: 5_000 });
        await expect(page.locator(`[data-thread-id="${world.T2}"]:visible`).first()).toBeVisible();
        await expect(page.locator(`[data-thread-id="${world.T3}"]`)).toHaveCount(0);
        await noTabOpened(s);
        await page.goBack();
        await expect(subject(page)).toHaveText(/First thread/);
      });
    });

    test('#settings opens Settings, and Back returns', async ({ browser }) => {
      await scene(browser, view, async (s) => {
        const { page, press } = s;
        await openFirstThread(page);
        await press(inMessage('settings')(page));
        await expect(page).toHaveURL(`${world.origin}/#settings`, { timeout: 5_000 });
        await expect(page.locator('[data-settings-link]:visible').first()).toBeVisible();
        await noTabOpened(s);
        await page.goBack();
        await expect(subject(page)).toHaveText(/First thread/);
      });
    });

    for (const name of ['other thread', 'bare'] as const) {
      test(`in an attached Markdown file: ${name === 'bare' ? 'a bare URL' : 'a Markdown link'} opens in place, and Back reopens the file`, async ({ browser }) => {
        await scene(browser, view, async (s) => {
          const { page, press } = s;
          const pane = await openFile(page, world.markdown);
          const link = name === 'bare' ? pane.locator(`a[href="${threadUrl(world.T2)}"]`).filter({ hasText: 'http' }).first() : pane.getByRole('link', { name, exact: true });
          await press(link);
          await expect(page).toHaveURL(threadUrl(world.T2), { timeout: 5_000 });
          await expect(subject(page)).toHaveText(/Second thread/);
          await expect(page.locator('[data-attachment-pane]')).toHaveCount(0);
          await noTabOpened(s);
          await page.goBack();
          await expect(page).toHaveURL(new RegExp(`file=${world.markdown}`));
          await expect(page.locator('[data-attachment-pane]')).toBeVisible();
        });
      });
    }

    for (const [name, to, shows] of [
      ['Page to T2', () => world.T2, /Second thread/],
      ['Page to T3', () => world.T3, /Beta thread/],
    ] as const) {
      test(`in an attached HTML page: "${name}" opens in place`, async ({ browser }) => {
        await scene(browser, view, async (s) => {
          const { page, press } = s;
          await openFile(page, world.html);
          await press(page.frameLocator('.ib-htmlframe iframe').getByRole('link', { name, exact: true }));
          await expect(page).toHaveURL(threadUrl(to()), { timeout: 5_000 });
          await expect(subject(page)).toHaveText(shows);
          await noTabOpened(s);
        });
      });
    }

    test('an unsent draft stays through a link and Back', async ({ browser }) => {
      await scene(browser, view, async (s) => {
        const { page, press } = s;
        const box = page.locator('section.ib-pane .ib-rbox textarea');
        await openFirstThread(page);
        await press(page.locator('section.ib-pane [data-reply-button]').first());
        await expect(box).toBeVisible();
        await box.pressSequentially('Still here after the link');
        // At once: the draft's save has not run yet.
        await press(inMessage('link to T2')(page));
        await expect(subject(page)).toHaveText(/Second thread/, { timeout: 5_000 });
        await noTabOpened(s);
        await page.goBack();
        await expect(subject(page)).toHaveText(/First thread/);
        await expect(box).toHaveValue('Still here after the link');
      });
    });

    test('a thread that does not exist shows what opening its hash shows, and is no dead end', async ({ browser }) => {
      await scene(browser, view, async (s) => {
        const { page, context, press } = s;
        /** What the window draws for the address: the Wait line, the subject, how many rows. */
        const drawn = (at: Page) =>
          at.evaluate(() => {
            const visible = (el: Element) => el.getClientRects().length > 0;
            const wait = document.querySelector('[data-thread-wait]');
            return {
              hash: location.hash,
              wait: wait?.getAttribute('data-thread-wait') ?? null,
              line: wait?.querySelector('[role="status"]')?.textContent?.trim() ?? null,
              subject: [...document.querySelectorAll('section.ib-pane h2.ib-subject')].filter(visible).map((el) => el.textContent).join('|') || null,
              rows: new Set([...document.querySelectorAll('[data-thread-id]')].filter(visible).map((el) => el.getAttribute('data-thread-id'))).size,
            };
          });
        const opened = await context.newPage();
        await opened.goto(threadUrl(NO_SUCH_THREAD));
        await expect.poll(async () => (await drawn(opened)).rows).toBeGreaterThan(0);
        await expect.poll(async () => (await drawn(opened)).wait).not.toBe('loading');
        await opened.waitForTimeout(1_000);
        const fromTheAddress = await drawn(opened);
        await opened.close();
        s.tabs.length = 0;

        await openFirstThread(page);
        await press(inMessage('missing thread')(page));
        await expect(page).toHaveURL(threadUrl(NO_SUCH_THREAD), { timeout: 5_000 });
        await expect.poll(() => drawn(page)).toEqual(fromTheAddress);
        console.log(`${view}, no such thread: ${JSON.stringify(fromTheAddress)}`);
        await noTabOpened(s);
        await page.goBack();
        await expect(subject(page)).toHaveText(/First thread/);
      });
    });
  });
}

test.describe('phone stack', () => {
  test('a link builds the stack a row tap builds, and Back walks it', async ({ browser }) => {
    await scene(browser, 'phone', async (s) => {
      const { page, press } = s;
      await page.goto(`${world.origin}/`);
      await press(page.locator(`[data-thread-id="${world.T1}"]:visible`).first());
      await expect(subject(page)).toHaveText(/First thread/);
      await expect(subject(page)).toBeInViewport();
      const opened = (from: string) => expect.poll(() => page.evaluate(() => (history.state as { ibFrom?: string } | null)?.ibFrom)).toBe(from);
      await opened('');

      await press(inMessage('link to T2')(page));
      await expect(subject(page)).toHaveText(/Second thread/, { timeout: 5_000 });
      await expect(subject(page)).toBeInViewport();
      await opened(`#thread=${world.T1}`);

      await page.goBack();
      await expect(subject(page)).toHaveText(/First thread/);
      await expect(subject(page)).toBeInViewport();
      await page.goBack();
      await expect(page).toHaveURL(`${world.origin}/`);
      await expect(page.locator(`[data-thread-id="${world.T1}"]:visible`).first()).toBeInViewport();
      await noTabOpened(s);
    });
  });
});

test.describe('the list', () => {
  test('a project\'s list stays that project\'s, as a row click leaves it', async ({ browser }) => {
    await scene(browser, 'desktop', async (s) => {
      const { page } = s;
      await page.goto(`${world.origin}/#project=${world.project}&thread=${world.T1}`);
      await inMessage('link to T2')(page).click();
      await expect(subject(page)).toHaveText(/Second thread/, { timeout: 5_000 });
      await expect(page).toHaveURL(`${world.origin}/#project=${world.project}&thread=${world.T2}`);
      await noTabOpened(s);
    });
  });
});

test.describe('still a new tab', () => {
  const CLICKS: { name: string; click: Parameters<Locator['click']>[0] }[] = [
    { name: 'Cmd or Ctrl', click: { modifiers: ['ControlOrMeta'] } },
    { name: 'Shift', click: { modifiers: ['Shift'] } },
    { name: 'middle', click: { button: 'middle' } },
  ];
  const THREAD_LINKS: { name: string; link: (page: Page) => Locator }[] = [
    { name: 'a Markdown link', link: inMessage('link to T2') },
    { name: 'a bare URL', link: urlLink(0) },
    { name: 'a hash-only link', link: inMessage('hash only') },
  ];
  for (const { name: clickName, click } of CLICKS) {
    for (const { name, link } of THREAD_LINKS) {
      test(`${clickName} click on ${name}`, async ({ browser }) => {
        await scene(browser, 'desktop', async ({ page, context }) => {
          await openFirstThread(page);
          const [tab] = await Promise.all([context.waitForEvent('page', { timeout: 5_000 }), link(page).click(click)]);
          await expect(tab).toHaveURL(threadUrl(world.T2));
          await expect(page).toHaveURL(threadUrl(world.T1));
          await expect(subject(page)).toHaveText(/First thread/);
        });
      });
    }
  }

  const OUTSIDE_LINKS: { name: string; link: string; to: () => string }[] = [
    { name: 'another port, a linked machine', link: 'other port', to: () => world.machine },
    { name: 'another host', link: 'tailnet name', to: () => `${TAILNET_NAME}#thread=${world.T2}` },
    { name: 'the web', link: 'the web', to: () => OUTSIDE },
    { name: 'the Inbox\'s root, which names no route', link: 'inbox root', to: () => `${world.origin}/` },
  ];
  for (const view of ['desktop', 'phone'] as const) {
    for (const { name, link, to } of OUTSIDE_LINKS) {
      test(`${view}: ${name}`, async ({ browser }) => {
        await scene(browser, view, async ({ page, context, press }) => {
          await openFirstThread(page);
          const [tab] = await Promise.all([context.waitForEvent('page', { timeout: 5_000 }), press(inMessage(link)(page))]);
          await expect(tab).toHaveURL(to());
          await expect(page).toHaveURL(threadUrl(world.T1));
          await expect(subject(page)).toHaveText(/First thread/);
        });
      });
    }
  }

  test('a linked machine\'s link in an attached Markdown file', async ({ browser }) => {
    await scene(browser, 'desktop', async ({ page, context }) => {
      const pane = await openFile(page, world.markdown);
      const [tab] = await Promise.all([context.waitForEvent('page', { timeout: 5_000 }), pane.getByRole('link', { name: 'other port', exact: true }).click()]);
      await expect(tab).toHaveURL(world.machine);
      await expect(page).toHaveURL(new RegExp(`file=${world.markdown}`));
    });
  });

  test('a web link in an attached HTML page', async ({ browser }) => {
    await scene(browser, 'desktop', async ({ page, context }) => {
      await openFile(page, world.html);
      const link = page.frameLocator('.ib-htmlframe iframe').getByRole('link', { name: 'Page to the web', exact: true });
      const [tab] = await Promise.all([context.waitForEvent('page', { timeout: 5_000 }), link.click()]);
      await expect(tab).toHaveURL(OUTSIDE);
      await expect(page.locator('[data-attachment-pane]')).toBeVisible();
    });
  });

  test('a link in a dialog leaves the dialog where it is', async ({ browser }) => {
    await scene(browser, 'desktop', async ({ page, context }) => {
      await page.goto(threadUrl(world.T4));
      await expect(page.locator('section.ib-pane [data-open-questions]')).toBeVisible();
      if (!(await page.locator('[data-open-questions-list]').isVisible())) await page.locator('section.ib-pane [data-open-questions]').click();
      await page.locator('[data-thread-decide]').click();
      const dialog = page.locator('[data-decision-mode]');
      await expect(dialog).toBeVisible();
      const prompt = dialog.getByRole('link', { name: 'T2 from a dialog', exact: true });
      const [tab] = await Promise.all([context.waitForEvent('page', { timeout: 5_000 }), prompt.click()]);
      await expect(tab).toHaveURL(threadUrl(world.T2));
      await tab.close();
      await expect(dialog).toBeVisible();
      await expect(page).toHaveURL(threadUrl(world.T4));
    });
  });

  test('beside a comment not saved yet: a link leaves the file open', async ({ browser }) => {
    await scene(browser, 'desktop', async ({ page, context }) => {
      const pane = await openFile(page, world.markdown);
      // A stand-in for ui's comment popover, which the pane's own question reads (`unsavedComposer`).
      await page.evaluate(() => {
        const popover = document.createElement('div');
        popover.setAttribute('data-comment-popover', '');
        popover.innerHTML = '<textarea>words not saved yet</textarea>';
        document.body.append(popover);
      });
      const [tab] = await Promise.all([context.waitForEvent('page', { timeout: 5_000 }), pane.getByRole('link', { name: 'other thread', exact: true }).click()]);
      await expect(tab).toHaveURL(threadUrl(world.T2));
      await expect(pane).toBeVisible();
      await expect(page).toHaveURL(new RegExp(`file=${world.markdown}`));
    });
  });
});

test.describe('left alone', () => {
  test('a link to a Settings heading in a document scrolls to the heading', async ({ browser }) => {
    await scene(browser, 'desktop', async (s) => {
      const { page } = s;
      const pane = await openFile(page, world.markdown);
      const heading = pane.locator('#settings');
      await expect(heading).not.toBeInViewport();
      await pane.getByRole('link', { name: 'To Settings', exact: true }).click();
      await expect(heading).toBeInViewport();
      await expect(page).toHaveURL(new RegExp(`file=${world.markdown}`));
      await noTabOpened(s);
    });
  });

  test('a download link and an Alt click stay where they are', async ({ browser }) => {
    await scene(browser, 'desktop', async ({ page }) => {
      await openFirstThread(page);
      await inMessage('link to T2')(page).click({ modifiers: ['Alt'] });
      await page.waitForTimeout(500);
      await expect(page).toHaveURL(threadUrl(world.T1));
      await page.evaluate((href) => {
        const link = document.createElement('a');
        link.href = href;
        link.textContent = 'save this';
        link.setAttribute('download', 'thread.html');
        link.style.cssText = 'position:fixed;top:0;left:0;z-index:99999;background:white';
        document.body.append(link);
      }, threadUrl(world.T2));
      await page.getByRole('link', { name: 'save this', exact: true }).click();
      await page.waitForTimeout(500);
      await expect(page).toHaveURL(threadUrl(world.T1));
    });
  });
});

test.describe('the tour', () => {
  test('a link to a thread leaves the tour as any way out does, and Back does not reopen it', async ({ browser }) => {
    await scene(browser, 'desktop', async ({ page }) => {
      await openFirstThread(page);
      await page.goto(`${world.origin}/#tour=1`);
      await expect(page.locator('[data-tour-exit]').first()).toBeVisible();
      // The tour's own messages hold no links: a link stands in for one.
      await page.evaluate((href) => {
        const link = document.createElement('a');
        link.href = href;
        link.textContent = 'out of the tour';
        link.style.cssText = 'position:fixed;top:0;left:0;z-index:99999;background:white';
        document.body.append(link);
      }, threadUrl(world.T2));
      await page.getByRole('link', { name: 'out of the tour', exact: true }).click();
      await expect(subject(page)).toHaveText(/Second thread/, { timeout: 5_000 });
      await expect(page.locator('[data-tour-bar]')).toHaveCount(0);
      await page.goBack();
      await expect(page).toHaveURL(threadUrl(world.T1));
      await expect(page.locator('[data-tour-bar]')).toHaveCount(0);
    });
  });
});
