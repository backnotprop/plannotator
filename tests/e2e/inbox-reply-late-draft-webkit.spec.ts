import { expect, test, devices, type Page } from './inbox-test';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';

const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(__dirname, '../../.local/plannotator'));
const { defaultBrowserType: _webkit, ...ipad } = devices['iPad Pro 11'];
const OLD = 'Words from the Mac yesterday.';

let url = '';
let agent: SimAgent;
let project = '';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  const root = inboxScratch('plannotator-inbox-late-draft-');
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: join(root, 'home'),
    PLANNOTATOR_TEST_SANDBOX: root,
    CLAUDE_CONFIG_DIR: join(root, 'claude'),
    CODEX_HOME: join(root, 'codex'),
    OPENCODE_CONFIG_DIR: join(root, 'opencode'),
    PLANNOTATOR_DATA_DIR: join(root, 'data'),
    PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9',
    PLANNOTATOR_BROWSER: NO_BROWSER,
    NO_BROWSER,
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_INBOX_TAILSCALE: '0',
    PLANNOTATOR_INBOX_PHONES: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
    PLANNOTATOR_INBOX_NOTES: '0',
  };
  mkdirSync(env.HOME);
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  rememberInboxOf(env.PLANNOTATOR_DATA_DIR);
  url = started.stdout.trim().replace(/\/$/, '');
  await fetch(`${url}/api/inbox/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ notifications: { dismissed: true } }) });
  agent = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  project = scratchProject(join(root, 'src'), 'late-draft');
});

test.afterAll(async () => {
  try {
    await agent?.close().catch(() => {});
  } finally {
    await removeInboxScratch();
  }
});

const box = (page: Page) => page.locator('.ib-rbox textarea');
const restore = (page: Page) => page.locator('[data-draft-restore]');
const draftWords = async (id: string) => ((await (await fetch(`${url}/api/inbox/threads/${id}/draft`)).json()) as { draft: { body: string } | null }).draft?.body ?? null;

async function thread(subject: string): Promise<string> {
  return (await agent.send({ project_path: project, subject, body: 'The retry loop backs off two, four and eight seconds.' })).thread_id as string;
}

async function openAndReply(page: Page, id: string) {
  await page.goto(`${url}/#thread=${encodeURIComponent(id)}`);
  await page.locator(`section.ib-pane[data-thread-id="${id}"] .ib-pfoot`).getByRole('button', { name: /^Reply/ }).tap();
  await expect(box(page)).toBeFocused();
}

test('a draft read that answers after a word was typed: the draft first, the word after it, both saved', async ({ browser }) => {
  const id = await thread('Late draft');
  await fetch(`${url}/api/inbox/threads/${id}/draft`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body: OLD, base: null }) });
  const context = await browser.newContext({ ...ipad, reducedMotion: 'reduce' });
  const page = await context.newPage();
  // The draft read is held until the Reply tap has landed, then let go: the read answers after the tap by the test's
  // order, never by a delay racing the tap (a read that answered first made the button "Edit draft", and the tap
  // waited for a Reply button that never came back).
  let releaseDraftRead!: () => void;
  const draftReadHeld = new Promise<void>((done) => (releaseDraftRead = done));
  await page.route(/\/api\/inbox\/threads\/[^/]+\/draft$/, async (route) => {
    if (route.request().method() === 'GET') await draftReadHeld;
    await route.continue().catch(() => {});
  });
  await openAndReply(page, id);
  await expect(box(page)).toHaveValue('');
  // Typed before the read answers: the draft goes in first, the typed word after it, and both are saved.
  await page.keyboard.type('Thanks', { delay: 60 });
  releaseDraftRead();
  await expect(box(page)).toHaveValue(`${OLD}\n\nThanks`, { timeout: 10_000 });
  await expect(restore(page)).toHaveCount(0);
  await expect.poll(() => draftWords(id), { timeout: 15_000 }).toBe(`${OLD}\n\nThanks`);
  await context.close();
});

test('a draft read that answers after Reply was tapped, nothing typed yet: the box takes it, and typing on saves', async ({ browser }) => {
  const id = await thread('Late draft untouched');
  await fetch(`${url}/api/inbox/threads/${id}/draft`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body: OLD, base: null }) });
  const context = await browser.newContext({ ...ipad, reducedMotion: 'reduce' });
  const page = await context.newPage();
  let releaseDraftRead!: () => void;
  const draftReadHeld = new Promise<void>((done) => (releaseDraftRead = done));
  await page.route(/\/api\/inbox\/threads\/[^/]+\/draft$/, async (route) => {
    if (route.request().method() === 'GET') await draftReadHeld;
    await route.continue().catch(() => {});
  });
  await openAndReply(page, id);
  releaseDraftRead();
  await expect(box(page)).toHaveValue(OLD, { timeout: 10_000 });
  await expect(restore(page)).toHaveCount(0);
  await box(page).press('End');
  await page.keyboard.type(' Thanks', { delay: 60 });
  await expect.poll(() => draftWords(id), { timeout: 15_000 }).toBe(`${OLD} Thanks`);
  await context.close();
});

// Two devices: the iPad on 127.0.0.1, the Mac on localhost (two origins, so no tab of one hears the other's stream).
test('two devices type in one reply: every word typed on either is saved, and neither device loses its words', async ({ browser }) => {
  const id = await thread('Synced draft');
  const ipadContext = await browser.newContext({ ...ipad, reducedMotion: 'reduce' });
  const macContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  const page = await ipadContext.newPage();
  const mac = await macContext.newPage();
  const otherOrigin = url.includes('127.0.0.1') ? url.replace('127.0.0.1', 'localhost') : url.replace('localhost', '127.0.0.1');
  await mac.goto(`${otherOrigin}/#thread=${encodeURIComponent(id)}`);
  await openAndReply(page, id);
  await mac.locator(`section.ib-pane[data-thread-id="${id}"] .ib-pfoot`).getByRole('button', { name: /^Reply/ }).click();
  await box(mac).pressSequentially(OLD, { delay: 20 });
  await expect.poll(() => draftWords(id)).toBe(OLD);
  // The iPad's box was untouched: it takes the Mac's words.
  await expect(box(page)).toHaveValue(OLD);
  await expect(restore(page)).toHaveCount(0);
  await box(page).press('End');
  await page.keyboard.type(' Ok', { delay: 60 });
  await expect.poll(() => draftWords(id), { timeout: 15_000 }).toBe(`${OLD} Ok`);
  // The Mac wrote in its box: the iPad's words wait behind Restore draft, and the Mac's next key takes them in.
  await expect(restore(mac)).toBeVisible();
  await expect(box(mac)).toHaveValue(OLD);
  await box(mac).press('End');
  await mac.keyboard.type(' Done.', { delay: 60 });
  await expect(box(mac)).toHaveValue(`${OLD} Ok Done.`);
  await expect(restore(mac)).toHaveCount(0);
  await expect.poll(() => draftWords(id), { timeout: 15_000 }).toBe(`${OLD} Ok Done.`);
  await ipadContext.close();
  await macContext.close();
});
