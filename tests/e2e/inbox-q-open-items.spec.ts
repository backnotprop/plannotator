import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { FIXTURE_V1_LOCAL } from '../../packages/core/guide-format-fixtures';
import { copyFileSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { markTourDecided } from '../helpers/tour-decided';
import { inboxScratch, removeInboxScratch, rememberInboxOf } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const shots = process.env.INBOX_Q_SHOTS;
if (shots) mkdirSync(shots, { recursive: true });

const BODY = 'section.ib-pane .ib-pbody:not(.ib-artbody)';

test.use({ actionTimeout: 15_000 });
const filler = (n: number) => `Step ${n}: ${'we watch the error rate and the latency for an hour, then roll on. '.repeat(14)}`;

const OLD_Q = ['I need a tag before I touch the release branch.', '', ':::question', 'Which tag should the release carry?', '', '- [ ] latest', '- [ ] next', ':::'].join('\n');
const NEW_BODY = [
  'The hotfix is built. One thing to decide, one to approve, and a note to read.',
  '',
  ':::question',
  'Ship the hotfix today, or wait for Monday?',
  '',
  '- [ ] Today',
  '- [ ] Monday',
  ':::',
  '',
  ':::action',
  'Approve the 2FA prompt',
  'It lands on your phone.',
  ':::',
].join('\n');

const spotQuestion = (kind: 'question' | 'question-text', prompt: string) =>
  kind === 'question-text' ? [':::question-text', prompt, ':::'].join('\n') : [':::question', prompt, '', '- [ ] Vanilla', '- [ ] Mint', ':::'].join('\n');
const SPOTS = {
  radio: spotQuestion('question', 'Spot radio: which flavour?'),
  text: spotQuestion('question-text', 'Spot text: what should we call it?'),
  other: spotQuestion('question', 'Spot other: which flavour?'),
  note: spotQuestion('question', 'Spot note: which flavour?'),
  skip: spotQuestion('question', 'Spot skip: which flavour?'),
  action: [':::action', 'Spot action: approve the prompt', 'It lands on your phone.', ':::'].join('\n'),
  actionNote: [':::action', 'Spot action note: approve the prompt', 'It lands on your phone.', ':::'].join('\n'),
  page: spotQuestion('question', 'Spot page: which flavour?'),
  menu: [spotQuestion('question', 'Spot menu: which flavour?'), spotQuestion('question', 'And a topping?')].join('\n\n'),
  link: `${spotQuestion('question', 'Spot link: which flavour?')}\n\nThe menu is at [the flavour page](https://example.com/flavours).`,
  boxopen: spotQuestion('question', 'Spot boxopen: which flavour?'),
  late: spotQuestion('question-text', 'Spot late: what should we call it?'),
  ring: spotQuestion('question', 'Spot ring: which flavour?'),
  cant: [spotQuestion('question', 'Spot cant: which flavour?'), '', ':::action', 'Spot cant: open the vault', 'Needs your badge.', ':::'].join('\n'),
  cover: spotQuestion('question', 'Spot cover: which flavour?'),
  coverimg: spotQuestion('question', 'Spot coverimg: which flavour?'),
  guided: [spotQuestion('question', 'Spot guided: which flavour?'), spotQuestion('question', 'And a topping?')].join('\n\n'),
  click: spotQuestion('question', 'Spot click: which flavour?'),
};
const SPOT_FILES: Partial<Record<keyof typeof SPOTS, string[]>> = { cover: ['notes.md'], coverimg: ['after.webp'] };

interface World {
  url: string;
  agent: SimAgent;
  codex: SimAgent;
  guideMessage: string;
  threads: { release: string; news: string } & Record<keyof typeof SPOTS, string>;
}

async function post(url: string, path: string, body: unknown) {
  const response = await fetch(new URL(path, url), { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: new URL(url).origin }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
}

async function createWorld(): Promise<World> {
  const root = inboxScratch('plannotator-inbox-q-');
  const dataDir = join(root, 'data');
  markTourDecided(dataDir);
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: root,
    PLANNOTATOR_DATA_DIR: dataDir,
    CLAUDE_CONFIG_DIR: join(root, 'claude'),
    CODEX_HOME: join(root, 'codex'),
    OPENCODE_CONFIG_DIR: join(root, 'opencode'),
    PLANNOTATOR_BROWSER: NO_BROWSER,
    NO_BROWSER,
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_INBOX_TAILSCALE: '0',
    PLANNOTATOR_INBOX_PHONES: '0',
    PLANNOTATOR_INBOX_NOTES: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
    PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9',
  };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  if (started.status !== 0) throw new Error(`the Inbox did not start: ${started.stderr}`);
  rememberInboxOf(dataDir);
  const url = started.stdout.trim();
  const project = scratchProject(join(root, 'src'), 'billing');
  writeFileSync(join(project, 'notes.md'), '# Hotfix notes\n\nThe fix is one line.\n');
  const agent = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  const codex = await SimAgent.connect({ binary, env, name: 'Codex', host: 'codex' });
  const pause = () => new Promise((r) => setTimeout(r, 25));

  const threads: Record<string, string> = {};
  let guideMessage = '';
  copyFileSync(join(repo, 'packages/inbox/tour/content/vs-b.webp'), join(project, 'after.webp'));
  for (const [name, body] of Object.entries(SPOTS)) {
    const files = SPOT_FILES[name as keyof typeof SPOTS];
    const sent = await agent.send({ project_path: project, subject: `Spot ${name}`, thread: `spot-${name}`, body, ...(files ? { attachments: files } : {}) });
    threads[name] = sent.thread_id as string;
    if (name === 'guided') {
      const guide = await codex.submitGuide({ project_path: project, snapshot: FIXTURE_V1_LOCAL, reply_to: sent.message_id as string, subject: 'A guided review', body: 'Read it in order.' });
      guideMessage = guide.message_id as string;
    }
    await pause();
  }
  const news = await agent.send({ project_path: project, subject: 'Nightly build is green', thread: 'news', body: 'The nightly build is green again. Nothing for you.' });
  await pause();
  let last = await agent.send({ project_path: project, subject: 'Release the hotfix', thread: 'release', body: filler(1) });
  const release = last.thread_id as string;
  await pause();
  last = await codex.send({ project_path: project, reply_to: last.message_id as string, body: OLD_Q });
  for (let n = 3; n <= 7; n++) {
    await pause();
    last = await agent.send({ project_path: project, reply_to: last.message_id as string, body: filler(n) });
  }
  await post(url, `/api/inbox/threads/${encodeURIComponent(release)}/seen`, {});
  await pause();
  await agent.send({ project_path: project, reply_to: last.message_id as string, body: NEW_BODY, attachments: ['notes.md'] });
  return { url, agent, codex, guideMessage, threads: { release, news: news.thread_id as string, ...threads } as World['threads'] };
}

let world: World;
let context: BrowserContext;
let page: Page;
let consoleErrors: string[] = [];
let replies: { url: string; body: string }[] = [];
let shotN = 0;

async function start(browser: import('@playwright/test').Browser, title: string, viewport: { width: number; height: number }) {
  world = await createWorld();
  context = await browser.newContext({ viewport, ...(shots ? { recordVideo: { dir: shots, size: viewport } } : {}) });
  page = await context.newPage();
  consoleErrors = [];
  replies = [];
  shotN = 0;
  page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(`console.error: ${message.text()}`);
  });
  page.on('request', (request) => {
    if (request.method() === 'POST' && /\/reply\b|\/replies\b/.test(request.url())) replies.push({ url: request.url(), body: request.postData() ?? '' });
  });
  void title;
}

const sleep = (ms: number) => new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), ms));

async function finish(title: string) {
  try {
    expect(consoleErrors, 'no console errors').toEqual([]);
  } finally {
    try {
      const video = page.video();
      const closed = await Promise.race([context.close().then(() => 'closed' as const), sleep(20_000)]);
      if (closed !== 'timeout' && video && shots) renameSync(await video.path(), join(shots, `${title.replace(/[^a-z0-9]+/gi, '-')}.webm`));
    } catch {
    } finally {
      try {
        await Promise.all([world.agent, world.codex].map((a) => a.close().catch(() => {})));
      } finally {
        await removeInboxScratch();
      }
    }
  }
}

test.afterEach(async () => {
  await removeInboxScratch();
});

const focusedText = () =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return 'the page itself';
    return `${el.tagName.toLowerCase()}${el.getAttribute('type') ? `[${el.getAttribute('type')}]` : ''} "${(el.getAttribute('aria-label') ?? el.innerText ?? '').trim().replace(/\s+/g, ' ').slice(0, 60)}"`;
  });

let landed = false;
async function press(...keys: string[]) {
  for (const key of keys) {
    await page.keyboard.press(key);
    await page.waitForTimeout(110);
    if (!landed) landed = await page.evaluate(() => !!document.activeElement && document.activeElement !== document.body);
    else expect(await page.evaluate(() => !!document.activeElement && document.activeElement !== document.body && document.activeElement.isConnected), `focus held after ${key} (on ${await focusedText()})`).toBe(true);
  }
}

const row = (thread: string) => page.locator(`.ib-main .ib-lbody [data-thread-id="${thread}"]`).filter({ visible: true });
const button = () => page.locator('[data-open-questions]');
const popup = () => page.locator('[data-open-questions-list]');
const rowsOf = () => popup().locator('.ib-oq-row');

async function load() {
  landed = false;
  await page.goto(world.url);
  await expect(page.locator('.ib-main .ib-lbody [data-thread-id]').first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
}

async function openThread(thread: string) {
  await press('g', 'i');
  for (let i = 0; i < 30; i++) {
    const where = await row(thread)
      .evaluate(
        (el) => {
          const active = document.activeElement;
          if (el === active) return 'here';
          return active && el.compareDocumentPosition(active) & Node.DOCUMENT_POSITION_FOLLOWING ? 'above' : 'below';
        },
        undefined,
        { timeout: 1500 },
      )
      .catch(() => 'below' as const);
    if (where === 'here') break;
    await press(where === 'above' ? 'ArrowUp' : 'ArrowDown');
  }
  await expect(row(thread)).toBeFocused();
  await press('Enter');
  await expect(page.locator('section.ib-pane')).toBeVisible();
  await expect.poll(() => new URL(page.url()).hash).toBe(`#thread=${thread}`);
  await page.waitForTimeout(500);
}

async function gotoThread(thread: string) {
  landed = false;
  await page.goto(`${world.url}#thread=${thread}`);
  await expect.poll(() => new URL(page.url()).hash, { message: `the address is the thread's (now ${page.url()})` }).toBe(`#thread=${thread}`);
  await expect(page.locator('section.ib-pane')).toBeVisible();
  await page.waitForTimeout(700);
}

async function tabTo(target: Locator, max = 40) {
  await expect(target, `the Tab target is on the page (url ${page.url()})`).toBeVisible();
  for (let i = 0; i < max; i++) {
    const here = await target.evaluate((el) => el === document.activeElement, undefined, { timeout: 2000 }).catch(() => false);
    if (here) return;
    await page.keyboard.press('Tab');
    await page.waitForTimeout(40);
  }
}

async function shot(name: string) {
  if (shots) await page.screenshot({ path: join(shots, `${String(++shotN).padStart(2, '0')}-${name}.png`) });
}

async function focusOn(target: Locator, label: string) {
  await expect(target, `${label}: focus (now on ${await focusedText()})`).toBeFocused();
}

const activeIs = (selector: string) => page.evaluate((s) => !!document.activeElement?.closest(s), selector);

async function mod(key: string) {
  await page.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+${key}`);
  await page.waitForTimeout(150);
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 800, height: 900 }]) {
  const title = `Q opens the open items popup, ${viewport.width} wide`;
  test(title, async ({ browser }) => {
    test.setTimeout(180_000);
    await start(browser, title, viewport);
    try {
      await load();
      const t = world.threads;

      await openThread(t.release);
      await expect(button()).toBeVisible();
      await expect(button()).toHaveAttribute('aria-keyshortcuts', 'Q');
      await expect(button().locator('kbd[data-shortcut-hint="inbox-thread.openItems"]')).toHaveAttribute('data-keycap', 'Q');
      await press('q');
      await expect(popup()).toBeVisible();
      await expect(button()).toHaveAttribute('aria-expanded', 'true');
      expect(await rowsOf().allInnerTexts(), 'rows').toHaveLength(3);
      await focusOn(rowsOf().nth(0), 'step 1 first row');
      await expect(rowsOf().nth(0)).toContainText('Which tag should the release carry?');
      await press('ArrowDown');
      await focusOn(rowsOf().nth(1), 'step 1 arrow');
      await press('ArrowUp');
      await focusOn(rowsOf().nth(0), 'step 1 arrow back');
      await press('q');
      await expect(popup()).toBeVisible();
      await shot('popup-open');

      await press('Enter');
      await expect(popup()).toHaveCount(0);
      const oldCard = page.locator(`${BODY} [data-question-key]`).filter({ hasText: 'Which tag should the release carry?' });
      await expect(oldCard).toBeVisible();
      await expect(page.locator(`${BODY} [data-message-article][data-open]`).filter({ hasText: 'Which tag should the release carry?' })).toHaveCount(1);
      await expect.poll(() => activeIs('[data-question-key]'), { message: `focus in the card (on ${await focusedText()})` }).toBe(true);
      await page.waitForTimeout(700);
      const offset = await oldCard.evaluate((el, sel) => {
        const body = document.querySelector<HTMLElement>(sel)!.getBoundingClientRect();
        const card = el.getBoundingClientRect();
        return Math.abs(card.top + card.height / 2 - (body.top + body.height / 2)) / body.height;
      }, BODY);
      expect(offset, 'card centred in the thread view').toBeLessThan(0.2);
      await shot('jumped-to-folded-question');
      await press('Shift+J');
      expect(await activeIs('[data-fold-head]'), 'Shift+J lands on a message head').toBe(true);

      await press('q');
      await expect(popup()).toBeVisible();
      await focusOn(rowsOf().nth(0), 'step 3 first row');
      await press('ArrowDown', 'ArrowDown');
      await focusOn(rowsOf().nth(2), 'step 3 two arrows');
      await expect(rowsOf().nth(2)).toContainText('Approve the 2FA prompt');
      await press('Enter');
      await expect(popup()).toHaveCount(0);
      await expect.poll(() => activeIs('[data-action-card]'), { message: `focus on the action row (on ${await focusedText()})` }).toBe(true);
      await shot('jumped-to-action');

      await page.waitForTimeout(1200);
      const scrollBefore = await page.evaluate((s) => document.querySelector<HTMLElement>(s)!.scrollTop, BODY);
      await press('q');
      await expect(popup()).toBeVisible();
      await press('Escape');
      await expect(popup()).toHaveCount(0);
      await focusOn(button(), 'step 4 button');
      expect(await page.evaluate((s) => document.querySelector<HTMLElement>(s)!.scrollTop, BODY)).toBe(scrollBefore);
      expect(new URL(page.url()).hash).toBe(`#thread=${t.release}`);

      await press('r');
      const box = page.getByRole('textbox', { name: /Reply to/ });
      await focusOn(box, 'step 5 reply box');
      await page.keyboard.type('quick quiet queue', { delay: 20 });
      await expect(box).toHaveValue('quick quiet queue');
      await expect(popup()).toHaveCount(0);
      await expect(button()).toHaveCount(0);
      await page.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+a`);
      await page.keyboard.press('Backspace');
      await press('Escape');
      await expect(box).toHaveCount(0);
      await expect(button()).toBeVisible();

      let hops = 0;
      while (new URL(page.url()).hash !== `#thread=${t.news}` && hops < 40) {
        await press('j');
        hops += 1;
      }
      await expect.poll(() => new URL(page.url()).hash).toBe(`#thread=${t.news}`);
      test.info().annotations.push({ type: 'step 6', description: `J pressed ${hops} times (the threads between have open items)` });
      await expect(button()).toHaveCount(0);
      const before = consoleErrors.length;
      await press('q');
      await page.waitForTimeout(300);
      await expect(popup()).toHaveCount(0);
      expect(consoleErrors.length).toBe(before);

      for (let i = 0; i < hops; i++) await press('k');
      await expect.poll(() => new URL(page.url()).hash).toBe(`#thread=${t.release}`);
      await press('?');
      const legend = page.getByRole('dialog').filter({ hasText: 'Open questions and action items' });
      await expect(legend).toBeVisible();
      const legendRow = legend.locator('*').filter({ hasText: /^Open questions and action items\s*Q$/ }).first();
      await expect(legendRow).toBeVisible();
      await expect(legendRow.locator('kbd')).toHaveText('Q');
      if (shots && viewport.width === 1440) await page.screenshot({ path: join(shots, 'legend-shows-q.png') });
      await shot('legend');
      await press('Escape');
      await expect(legend).toHaveCount(0);

      await press('g', 's');
      await expect(page.locator('.ib-spage')).toBeVisible();
      const toggle = page.locator('[data-settings-single-keys]');
      await tabTo(toggle);
      await focusOn(toggle, 'step 8 switch');
      await press('Space');
      await expect(toggle).toHaveAttribute('aria-checked', 'false');
      await page.goBack();
      await expect(button()).toBeVisible();
      await page.waitForTimeout(500);
      await expect(button().locator('kbd[data-shortcut-hint]')).toHaveCount(0);
      await page.waitForTimeout(1500);
      expect(await button().getAttribute('aria-keyshortcuts', { timeout: 3000 }).catch(() => 'gone')).toBeNull();
      test.info().annotations.push({ type: 'step 8', description: `focus after Back, keys off: ${await focusedText()}` });
      await page.keyboard.press('q');
      await page.waitForTimeout(400);
      await expect(popup()).toHaveCount(0);
      await shot('single-keys-off');
      await page.goForward();
      await expect(toggle).toBeVisible();
      await tabTo(toggle);
      await page.keyboard.press('Space');
      await expect(toggle).toHaveAttribute('aria-checked', 'true');
      await page.goBack();
      await expect(button()).toBeVisible();
      await page.waitForTimeout(500);
      await page.keyboard.press('q');
      await expect(popup()).toBeVisible();
      await focusOn(rowsOf().nth(0), 'step 8 back on');
      await press('Escape');
      await expect(popup()).toHaveCount(0);
      await page.waitForTimeout(400);

      await page.waitForTimeout(500);
      test.info().annotations.push({ type: 'step 9', description: `before O, focus on ${await focusedText()}` });
      await press('o');
      await page.waitForTimeout(800);
      await expect(page.locator('[data-attachment-pane]').filter({ visible: true })).toBeVisible();
      await page.waitForTimeout(600);
      const fileFocus = await focusedText();
      await press('q');
      await page.waitForTimeout(300);
      const fileOpens = await popup().count();
      test.info().annotations.push({ type: 'Q with a file beside the thread', description: `focus ${fileFocus}; popup opened: ${fileOpens > 0}` });
      await shot('file-beside-q');
      expect(fileOpens, `Q from the file pane (focus ${fileFocus}) opens no popup`).toBe(0);
      if (await button().isVisible()) {
        await page.locator('[data-reply-button]').focus();
        await press('q');
        await expect(popup()).toBeVisible();
        await focusOn(rowsOf().nth(0), 'step 9 file beside, from the thread');
        await press('Escape');
      } else {
        await press('q');
        await page.waitForTimeout(300);
        await expect(popup()).toHaveCount(0);
      }
      await press('Escape');
      await page.waitForTimeout(500);

      const fullIn = page.locator('.ib-listcol [role="separator"][aria-label="List width"]');
      if (await fullIn.count()) {
        await fullIn.focus();
        await press('Enter');
        await expect(page.locator('section.ib-pane[data-full]')).toBeVisible();
        await page.waitForTimeout(500);
        await press('Tab');
        await press('q');
        await expect(popup()).toBeVisible();
        await focusOn(rowsOf().nth(0), 'step 9 full-screen thread');
        await shot('full-screen-thread-popup');
        await press('Escape');
      } else {
        test.info().annotations.push({ type: 'full-screen thread', description: 'no list edge at this width' });
      }
    } finally {
      await finish(title);
    }
  });
}

test('Mod+Enter sends from every place focus can be', async ({ browser }) => {
  test.setTimeout(180_000);
  const title = 'Mod+Enter sends from every place focus can be';
  await start(browser, title, { width: 1440, height: 900 });
  const report: string[] = [];
  try {
    await load();
    const t = world.threads;
    const card = (text: string) => page.locator(`${BODY} [data-question-key]`).filter({ hasText: text });
    const sentCount = () => replies.length;

    async function sendAndCheck(spot: string, thread: string, words: RegExp) {
      const was = sentCount();
      await page.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+Enter`);
      await expect.poll(sentCount, { message: `${spot}: a reply was posted` }).toBe(was + 1);
      await page.waitForTimeout(700);
      expect(sentCount(), `${spot}: no second send`).toBe(was + 1);
      const saved = JSON.stringify(await (await fetch(new URL(`/api/inbox/threads/${thread}`, world.url))).json());
      expect(saved, `${spot}: the answer was sent with the reply (not left as unanswered)`).toMatch(words);
      expect(saved, `${spot}: nothing left unsent`).not.toMatch(/"state":"picked"/);
      report.push(`${spot}: sent once; focus after: ${await focusedText()}`);
      expect(await page.evaluate(() => document.activeElement !== document.body), `${spot}: focus not lost to the page`).toBe(true);
    }

    await openThread(t.radio);
    let keys = 0;
    const firstRadio = card('Spot radio').getByRole('radio').first();
    while (!(await firstRadio.evaluate((el) => el === document.activeElement, undefined, { timeout: 2000 }).catch(() => false)) && keys < 40) {
      await page.keyboard.press('Tab');
      keys++;
      await page.waitForTimeout(40);
    }
    const tabs = keys;
    await page.keyboard.press('Space');
    keys++;
    report.push(`keys to pick a choice after opening the thread by keyboard: ${keys} (${tabs} Tab, then Space), and Mod+Enter to send; the radio group takes the arrows for the next choice`);
    await expect(card('Spot radio').getByRole('radio', { checked: true })).toHaveCount(1);
    await sendAndCheck('radio focused', t.radio, /"selected":\["Vanilla"\]/);
    const ring = () =>
      page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        const style = el ? getComputedStyle(el) : null;
        return { head: !!el?.matches('[data-fold-head]'), outline: style ? `${style.outlineStyle} ${style.outlineWidth}` : '', marked: el?.hasAttribute('data-sent-focus') ?? false, id: el?.closest('[data-message-article]')?.getAttribute('data-message-article') ?? null };
      });
    await expect.poll(async () => (await ring()).head, { message: `focus on a message head after the send (on ${await focusedText()})` }).toBe(true);
    const afterSend = await ring();
    report.push(`ring after Mod+Enter send: ${JSON.stringify(afterSend)}`);
    expect(afterSend.marked, 'the chord Send marks the head').toBe(true);
    expect(afterSend.outline, 'no ring on the sent message head').toMatch(/^none /);
    await shot('after-send-no-ring');
    await page.keyboard.press('Shift+J');
    await page.waitForTimeout(200);
    const sameHead = await ring();
    expect(sameHead.id, 'Shift+J on the last head keeps focus on it').toBe(afterSend.id);
    expect(sameHead.outline, 'ring drawn after the next key, with focus not moved').toMatch(/solid 2px/);
    await page.keyboard.press('Shift+K');
    await page.waitForTimeout(200);
    const moved = await ring();
    await page.keyboard.press('Shift+J');
    await page.waitForTimeout(200);
    const back = await ring();
    report.push(`Shift+K: ${JSON.stringify(moved)}; Shift+J back onto the sent head: ${JSON.stringify(back)}`);
    expect(moved.head && back.head, 'Shift+K / Shift+J land on heads').toBe(true);
    expect(back.id, 'Shift+J is back on the sent message head').toBe(afterSend.id);
    expect(moved.outline, 'ring on the head Shift+K lands on').toMatch(/solid 2px/);
    expect(back.outline, 'ring on the sent head when a key lands on it again').toMatch(/solid 2px/);
    await shot('after-shift-j-ring');

    await openThread(t.text);
    const text = card('Spot text').getByRole('textbox');
    for (let i = 0; i < 20 && !(await text.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press('Tab');
    await focusOn(text, 'text field');
    await page.keyboard.type('Project Larch', { delay: 0 });
    await sendAndCheck('free-text field (typed, then Mod+Enter at once)', t.text, /Project Larch/);

    await openThread(t.other);
    const other = card('Spot other').getByRole('textbox', { name: /Other answer/ });
    for (let i = 0; i < 20 && !(await other.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press('Tab');
    await focusOn(other, 'other field');
    await page.keyboard.type('Pistachio', { delay: 0 });
    await sendAndCheck('Other field', t.other, /Pistachio/);

    await openThread(t.note);
    const noteRadio = card('Spot note').getByRole('radio').first();
    for (let i = 0; i < 20 && !(await noteRadio.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press('Tab');
    await page.keyboard.press('Space');
    await page.getByRole('button', { name: 'Add note' }).focus();
    await page.keyboard.press('Enter');
    const note = card('Spot note').getByRole('textbox', { name: /Note/ });
    await focusOn(note, 'note field');
    await page.keyboard.type('careful with the freezer', { delay: 0 });
    await sendAndCheck('note field', t.note, /careful with the freezer/);

    await openThread(t.skip);
    const skip = card('Spot skip').getByRole('button', { name: 'Skip' });
    for (let i = 0; i < 20 && !(await skip.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press('Tab');
    await focusOn(skip, 'skip button');
    await page.keyboard.press('Enter');
    await sendAndCheck('Skip control', t.skip, /skipped/);

    await openThread(t.action);
    const done = page.locator(`${BODY} [data-action-card]`).first().getByRole('button').first();
    for (let i = 0; i < 20 && !(await done.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press('Tab');
    await focusOn(done, 'action row control');
    await page.keyboard.press('Space');
    await sendAndCheck('action row', t.action, /"result"|done|Done/);

    await openThread(t.actionNote);
    const doneN = page.locator(`${BODY} [data-action-card]`).first().getByRole('button').first();
    for (let i = 0; i < 20 && !(await doneN.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press('Tab');
    await page.keyboard.press('Space');
    const actionNote = page.locator('[data-action-draft-note]').first();
    for (let i = 0; i < 20 && !(await actionNote.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press('Tab');
    await focusOn(actionNote, 'action note');
    await page.keyboard.type('done from the lobby', { delay: 0 });
    await sendAndCheck('action note (typed, then Mod+Enter inside the 600 ms pause)', t.actionNote, /done from the lobby/);

    await openThread(t.page);
    const pageRadio = card('Spot page').getByRole('radio').first();
    for (let i = 0; i < 20 && !(await pageRadio.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press('Tab');
    await page.keyboard.press('Space');
    await page.locator('[data-reply-button]').focus();
    const was = sentCount();
    const chord = `${process.platform === 'darwin' ? 'Meta' : 'Control'}+Enter`;
    await page.keyboard.down(chord.split('+')[0]!);
    await page.keyboard.down('Enter');
    for (let i = 0; i < 6; i++) await page.keyboard.down('Enter');
    await page.keyboard.up('Enter');
    await page.keyboard.up(chord.split('+')[0]!);
    await expect.poll(sentCount).toBe(was + 1);
    await page.waitForTimeout(700);
    expect(sentCount(), 'a held key sends once').toBe(was + 1);
    report.push(`held key from the foot's Reply button: sent once; focus after: ${await focusedText()}`);

    await page.goto(`${world.url}#thread=${t.release}`);
    await expect(button()).toBeVisible();
    await page.waitForTimeout(500);
    const none = sentCount();
    await page.locator('[data-reply-button]').focus();
    await mod('Enter');
    await page.waitForTimeout(500);
    expect(sentCount(), 'nothing to send: nothing sent').toBe(none);
    report.push('nothing to send: nothing sent, no error');

    await gotoThread(t.menu);
    const menuRadio = card('Spot menu').getByRole('radio').first();
    await tabTo(menuRadio, 90);
    await expect(menuRadio, `focus reached the menu spot choice (on ${await focusedText()})`).toBeFocused();
    await page.keyboard.press('Space');
    await expect(page.locator('.ib-footbtns .ib-pri')).toBeVisible();
    await page.locator('[data-reply-button]').focus();
    await page.keyboard.press('q');
    await expect(popup()).toBeVisible();
    await focusOn(rowsOf().nth(0), 'menu step: first row');
    const beforeMenu = sentCount();
    await mod('Enter');
    await page.waitForTimeout(600);
    expect(sentCount(), 'menu open: the chord sends nothing').toBe(beforeMenu);
    expect(new URL(page.url()).hash, 'the chord on a row did not close the thread').toBe(`#thread=${t.menu}`);
    await expect(popup()).toHaveCount(0);
    await page.locator('[data-reply-button]').focus();
    await mod('Enter');
    await expect.poll(sentCount, { message: 'menu closed: the same key sends' }).toBe(beforeMenu + 1);
    report.push('menu open: Mod+Enter sends nothing; closed, it sends');
  } finally {
    test.info().annotations.push({ type: 'report', description: report.join('\n') });
    console.log(report.join('\n'));
    await finish(title);
  }
});

test('Mod+Enter and Q stand down where Send is not on screen or the key is not theirs', async ({ browser }) => {
  test.setTimeout(180_000);
  const title = 'Mod+Enter and Q stand down';
  await start(browser, title, { width: 1440, height: 900 });
  try {
    await load();
    const t = world.threads;
    const sent = () => replies.length;
    const card = (text: string) => page.locator(`${BODY} [data-question-key]`).filter({ hasText: text });
    const hashNow = () => new URL(page.url()).hash;
    async function pickFirst(spot: string) {
      await tabTo(card(spot).getByRole('radio').first(), 90);
      await expect(card(spot).getByRole('radio').first(), `focus reached the first choice of ${spot} (on ${await focusedText()})`).toBeFocused();
      await page.keyboard.press('Space');
      await expect(page.locator('.ib-footbtns .ib-pri')).toBeVisible();
    }
    async function chordFromFoot(label: string) {
      const was = sent();
      await page.locator('[data-reply-button]').focus();
      await mod('Enter');
      await expect.poll(sent, { message: `${label}: the pick goes with the chord from the foot` }).toBe(was + 1);
    }
    const quiet = async (ms = 800) => page.waitForTimeout(ms);

    await gotoThread(t.link);
    await pickFirst('Spot link');
    const link = page.locator(`${BODY} a[href="https://example.com/flavours"]`);
    await link.focus();
    const linkWas = sent();
    await mod('Enter');
    await quiet();
    expect(sent(), 'a focused link keeps the chord').toBe(linkWas);
    await chordFromFoot('link');

    await gotoThread(t.cover);
    await pickFirst('Spot cover');
    await page.keyboard.press('f');
    await expect(page.locator('[data-attachment-pane][data-full-view]')).toBeVisible();
    expect(hashNow()).toMatch(/view=full/);
    let was = sent();
    await mod('Enter');
    await page.keyboard.press('q');
    await quiet();
    expect(sent(), 'full-screen file: nothing sent behind it').toBe(was);
    expect(hashNow(), 'full-screen file: still full screen').toMatch(/view=full/);
    await expect(popup()).toHaveCount(0);
    await page.keyboard.press('Escape');
    await chordFromFoot('full-screen file');

    await gotoThread(t.coverimg);
    await pickFirst('Spot coverimg');
    await page.keyboard.press('f');
    await expect(page.locator('[data-attachment-pane][data-full-view]')).toBeVisible();
    const commentTab = page.locator('[data-fcomp] [data-fcomp-mode="comment"]');
    await commentTab.focus();
    was = sent();
    await mod('Enter');
    await quiet();
    expect(sent(), 'full-screen image, Comment tab: nothing sent').toBe(was);
    expect(hashNow()).toMatch(/view=full/);
    await page.locator('[data-fcomp] [data-fcomp-mode="reply"]').click();
    const composerField = page.locator('[data-fcomp] textarea').first();
    await composerField.focus();
    await page.keyboard.type('looks fine', { delay: 0 });
    await page.locator('[data-fcomp] [data-fcomp-mode="reply"]').focus();
    await mod('Enter');
    await expect.poll(sent, { message: 'full-screen composer: the chord from its tab sends' }).toBe(was + 1);
    await quiet();
    expect(sent(), 'full-screen composer: sent once').toBe(was + 1);
    expect(replies.at(-1)!.body).toContain('looks fine');
    expect(hashNow(), 'full-screen composer: stays in full screen').toMatch(/view=full/);
    expect(await activeIs('[data-fcomp]'), 'full-screen composer: focus stays in the card').toBe(true);
    await page.keyboard.press('Escape');

    await gotoThread(t.guided);
    await pickFirst('Spot guided');
    await page.evaluate((h) => { location.hash = h; }, `#thread=${t.guided}&guide=${world.guideMessage}`);
    await expect(page.locator('section.ib-pane')).toBeHidden({ timeout: 5000 }).catch(() => {});
    await quiet(1200);
    expect(hashNow()).toContain('guide=');
    was = sent();
    await page.keyboard.press('q');
    await mod('Enter');
    await quiet();
    expect(sent(), 'behind a guide: nothing sent').toBe(was);
    await expect(popup()).toHaveCount(0);
    await page.evaluate((h) => { location.hash = h; }, `#thread=${t.guided}`);
    await expect(button()).toBeVisible();
    await quiet(600);
    await chordFromFoot('guided');

    await page.route('**/picks', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 2500));
      await route.continue();
    });
    await gotoThread(t.late);
    await tabTo(card('Spot late').getByRole('textbox'));
    await page.keyboard.type('h', { delay: 0 });
    was = sent();
    await mod('Enter');
    await page.locator('[data-reply-button]').focus();
    await page.keyboard.press('r');
    const lateBox = page.getByRole('textbox', { name: /Reply to/ });
    await expect(lateBox).toBeFocused();
    await page.keyboard.type('half a thou', { delay: 0 });
    await page.waitForTimeout(4500);
    expect(sent(), 'the key waited for a save, the box opened: nothing sent').toBe(was);
    await expect(lateBox).toHaveValue('half a thou');
    await page.unroute('**/picks');

    await gotoThread(t.boxopen);
    const boxRadio = card('Spot boxopen').getByRole('radio').first();
    await tabTo(boxRadio);
    await page.keyboard.press('Space');
    await page.locator('[data-reply-button]').focus();
    await page.keyboard.press('r');
    await expect(page.getByRole('textbox', { name: /Reply to/ })).toBeFocused();
    await page.keyboard.type('note words', { delay: 0 });
    await boxRadio.focus();
    was = sent();
    await mod('Enter');
    await expect.poll(sent, { message: 'reply box open, focus on a choice: sent' }).toBe(was + 1);
    await quiet();
    expect(sent(), 'sent once').toBe(was + 1);
    expect(replies.at(-1)!.body).toContain('note words');

    await gotoThread(t.cant);
    await pickFirst('Spot cant');
    const cant = page.getByRole('button', { name: /^Can't do it/ }).first();
    await cant.focus();
    await page.keyboard.press('Enter');
    const reason = page.locator('.ib-chk-note');
    await expect(reason).toBeFocused();
    await page.keyboard.type('no badge', { delay: 0 });
    was = sent();
    await mod('Enter');
    await quiet();
    expect(sent(), 'the reason box keeps the chord: nothing sent').toBe(was);
    await expect(reason).toHaveValue('no badge');

    await gotoThread(t.ring);
    await pickFirst('Spot ring');
    await page.locator('.ib-footbtns .ib-pri').focus();
    was = sent();
    await page.keyboard.press('Enter');
    await expect.poll(sent).toBe(was + 1);
    await expect.poll(() => page.evaluate(() => !!document.activeElement?.matches('[data-fold-head]'))).toBe(true);
    const ringOf = () => page.evaluate(() => { const s = getComputedStyle(document.activeElement!); return { outline: `${s.outlineStyle} ${s.outlineWidth}`, marked: document.activeElement!.hasAttribute('data-sent-focus') }; });
    expect(await ringOf(), 'Send by Enter on the button: ring kept').toEqual({ outline: 'solid 2px', marked: false });
    await gotoThread(t.click);
    await pickFirst('Spot click');
    was = sent();
    await page.locator('.ib-footbtns .ib-pri').click();
    await expect.poll(sent).toBe(was + 1);
    await expect.poll(() => page.evaluate(() => !!document.activeElement?.matches('[data-fold-head]'))).toBe(true);
    const clicked = await ringOf();
    expect(clicked.marked, 'a click on Send sets no mark').toBe(false);
    expect(clicked.outline, 'after a click on Send: no ring (never was)').toMatch(/^none /);
  } finally {
    await finish(title);
  }
});
