import { test as base, chromium, webkit, type Browser, type BrowserContext, type BrowserType, type Page, type TestInfo } from '@playwright/test';
import type { HeldProbe, HeldProbeRead } from '../../packages/inbox/data/heldProbe';
import { listDrift, threadDrift } from '../helpers/inbox-held-drift';

export * from '@playwright/test';

export const HELD_DRIFT_OFF = 'held-drift-off';
const SETTLE_MS = 3000;
const RETRY_MS = 100;

const contexts = new Set<BrowserContext>();
const tracked = new WeakSet<Browser>();

async function prepare(context: BrowserContext): Promise<BrowserContext> {
  contexts.add(context);
  context.on('close', () => contexts.delete(context));
  await context.addInitScript(() => {
    (window as { __plannotatorInboxHeld?: object }).__plannotatorInboxHeld = {};
  });
  return context;
}

function track(browser: Browser): Browser {
  if (tracked.has(browser)) return browser;
  tracked.add(browser);
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (options) => prepare(await newContext(options));
  return browser;
}

for (const type of [chromium, webkit] as BrowserType[]) {
  const launch = type.launch.bind(type);
  type.launch = async (options) => track(await launch(options));
  const persistent = type.launchPersistentContext.bind(type);
  type.launchPersistentContext = async (dir, options) => prepare(await persistent(dir, options));
}

const read = (page: Page): Promise<HeldProbeRead | null> =>
  page.evaluate(() => (window as { __plannotatorInboxHeld?: HeldProbe }).__plannotatorInboxHeld?.read?.() ?? null).catch(() => null);

function driftOf(read: HeldProbeRead): string | null {
  const out: string[] = [];
  for (const { threadId, held, fresh } of read.threads) {
    const drift = threadDrift(held, fresh);
    if (drift) out.push(`thread ${threadId}:\n${drift}`);
  }
  const list = read.list && listDrift(read.list.held, read.list.fresh);
  if (list) out.push(`list:\n${list}`);
  return out.length > 0 ? out.join('\n') : null;
}

async function pageDrift(page: Page): Promise<string | null> {
  const deadline = Date.now() + SETTLE_MS;
  for (;;) {
    const now = await read(page);
    if (!now) return null;
    const drift = driftOf(now);
    if ((!drift && now.busy === 0) || Date.now() > deadline) return drift;
    await page.waitForTimeout(RETRY_MS).catch(() => {});
    if (page.isClosed()) return null;
  }
}

export async function heldDriftOfPages(): Promise<string | null> {
  const out: string[] = [];
  for (const context of contexts) {
    for (const page of context.pages()) {
      if (page.isClosed()) continue;
      const drift = await pageDrift(page);
      if (drift) out.push(`${page.url()}\n${drift}`);
    }
  }
  return out.length > 0 ? out.join('\n\n') : null;
}

const off = (info: TestInfo) => info.annotations.some((annotation) => annotation.type === HELD_DRIFT_OFF);

export const test = base.extend<{ heldDrift: void }, { browser: Browser }>({
  browser: [async ({ browser }, use) => use(track(browser)), { scope: 'worker' }],
  heldDrift: [
    async ({}, use, info) => {
      await use();
      if (off(info) || info.status !== info.expectedStatus) return;
      const drift = await heldDriftOfPages();
      if (drift) throw new Error(`The window's held copy differs from a fresh read of the Inbox (tests/e2e/inbox-test.ts):\n${drift}`);
    },
    { auto: true },
  ],
});
