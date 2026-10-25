/**
 * Design prototype only: screenshots of the Messages-style Inbox, headless.
 *
 *   bun scripts/proto-imessage-shots.ts --url http://localhost:<proxy port>/ --out /tmp/imessage-proto [--only name]
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, devices, type Page } from '@playwright/test';

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const base = flag('--url') ?? '';
const out = flag('--out') ?? '/tmp/imessage-proto';
const only = flag('--only');
mkdirSync(out, { recursive: true });

async function threadIds(): Promise<Record<string, string>> {
  const list = (await (await fetch(new URL('/api/inbox/threads', base))).json()) as { sections: { threads: { thread_id: string; subject: string }[] }[] };
  const by: Record<string, string> = {};
  for (const s of list.sections) for (const t of s.threads) by[t.subject] = t.thread_id;
  return by;
}

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(700);
}

async function main() {
  const ids = await threadIds();
  const stripe = ids['Stripe 409s: retry or dead-letter?']!;
  const onboarding = ids['Onboarding: which flow ships?']!;
  const holding = Object.entries(ids).find(([s]) => s.startsWith('Detect the installed'))?.[1]!;
  const news = ids['Link check passed']!;
  const browser = await chromium.launch();
  const errors: string[] = [];
  const shots: { name: string; run: () => Promise<void> }[] = [];
  const desktop = async (mode: 'light' | 'dark', hash: string, name: string, act?: (p: Page) => Promise<void>) => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: mode });
    const page = await ctx.newPage();
    page.on('console', (m) => m.type() === 'error' && errors.push(`${name}: ${m.text()}`));
    page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
    await page.goto(`${base}?mode=${mode}#thread=${hash}`);
    await settle(page);
    if (act) await act(page);
    await page.screenshot({ path: join(out, `${name}.png`) });
    await ctx.close();
  };
  const phoneShot = async (mode: 'light' | 'dark', hash: string | null, name: string, act?: (p: Page) => Promise<void>) => {
    const ctx = await browser.newContext({ ...devices['iPhone 15'], colorScheme: mode });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
    await page.goto(`${base}?mode=${mode}${hash ? `#thread=${hash}` : ''}`);
    await settle(page);
    if (act) await act(page);
    await page.screenshot({ path: join(out, `${name}.png`) });
    await ctx.close();
  };
  shots.push({ name: 'desktop-light', run: () => desktop('light', onboarding, 'desktop-light') });
  shots.push({ name: 'desktop-dark', run: () => desktop('dark', onboarding, 'desktop-dark') });
  shots.push({
    name: 'question-pictures',
    run: () =>
      desktop('light', stripe, 'question-pictures', async (p) => {
        await p.locator('[data-thread-scroll]').evaluate((el) => (el.scrollTop = 0));
        await p.waitForTimeout(300);
      }),
  });
  shots.push({
    name: 'question-card-dark',
    run: () => desktop('dark', stripe, 'question-card-dark'),
  });
  shots.push({ name: 'attachments-links', run: () => desktop('light', news, 'attachments-links') });
  shots.push({ name: 'guide-card', run: () => desktop('dark', holding, 'guide-card') });
  shots.push({
    name: 'composer-picks',
    run: () =>
      desktop('light', stripe, 'composer-picks', async (p) => {
        await p.getByRole('textbox', { name: /Message/ }).fill('Retry it, and keep it behind the flag until Monday.');
        await p.waitForTimeout(200);
      }),
  });
  const refund = Object.entries(ids).find(([s]) => s.startsWith('Refund events'))?.[1]!;
  shots.push({ name: 'reply-delivery', run: () => desktop('light', refund, 'reply-delivery') });
  shots.push({
    name: 'tapback-offer',
    run: () =>
      desktop('light', news, 'tapback-offer', async (p) => {
        const bubbles = p.locator('[data-message-id] .msg-bubble');
        await bubbles.last().hover();
        await p.waitForTimeout(200);
      }),
  });
  shots.push({ name: 'phone-list', run: () => phoneShot('light', null, 'phone-list') });
  shots.push({ name: 'phone-list-dark', run: () => phoneShot('dark', null, 'phone-list-dark') });
  shots.push({ name: 'phone-thread', run: () => phoneShot('light', stripe, 'phone-thread') });
  shots.push({ name: 'phone-thread-dark', run: () => phoneShot('dark', onboarding, 'phone-thread-dark') });
  for (const shot of shots) if (!only || shot.name === only) await shot.run();
  await browser.close();
  if (errors.length) process.stdout.write(`page errors:\n${errors.join('\n')}\n`);
  process.stdout.write(`shots in ${out}\n`);
}

main().catch((e) => {
  process.stderr.write(`${e instanceof Error ? e.stack : e}\n`);
  process.exit(1);
});
