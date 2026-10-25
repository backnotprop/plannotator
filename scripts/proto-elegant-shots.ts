/**
 * Design prototype only: today's Inbox window and the elegant study in the
 * same states, side by side (headless). Each state is shot on both URLs.
 *
 *   bun scripts/proto-elegant-shots.ts --today http://localhost:<inbox>/ --elegant http://localhost:<proxy>/ --out <dir>
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, devices, type BrowserContextOptions, type Page } from '@playwright/test';

const arg = (n: string) => process.argv[process.argv.indexOf(n) + 1]!;
const today = arg('--today');
const elegant = arg('--elegant');
const out = arg('--out');
mkdirSync(out, { recursive: true });

const list = (await (await fetch(new URL('/api/inbox/threads', today))).json()) as { sections: { threads: { thread_id: string; subject: string }[] }[] };
const id = (start: string) => list.sections.flatMap((s) => s.threads).find((t) => t.subject.startsWith(start))!.thread_id;
const stripe = id('Stripe 409s');
const detect = id('Detect the installed');
const thread = (await (await fetch(new URL(`/api/inbox/threads/${stripe}`, today))).json()) as { thread: { messages: { attachments?: { id: string; name: string }[] }[] } };
const plan = thread.thread.messages.flatMap((m) => m.attachments ?? []).find((a) => a.name === 'PLAN-retries.md')!.id;

const desktop = (scheme: 'light' | 'dark'): BrowserContextOptions => ({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: scheme });
const phone = (scheme: 'light' | 'dark'): BrowserContextOptions => ({ ...devices['iPhone 15'], colorScheme: scheme });

const states: { name: string; ctx: BrowserContextOptions; hash: string; act?: (p: Page) => Promise<void> }[] = [
  { name: 'desktop-light', ctx: desktop('light'), hash: `#thread=${stripe}` },
  { name: 'desktop-dark', ctx: desktop('dark'), hash: `#thread=${stripe}` },
  {
    name: 'question-card-reply',
    ctx: desktop('light'),
    hash: `#thread=${stripe}`,
    act: async (p) => {
      await p.getByRole('button', { name: /^(Edit draft|Reply)\b/ }).first().click();
      await p.locator('.ib-rtext').first().fill('Retry it, and keep it behind the flag until Monday.');
    },
  },
  { name: 'beside-file', ctx: desktop('light'), hash: `#thread=${stripe}&file=${plan}&view=side` },
  { name: 'beside-file-dark', ctx: desktop('dark'), hash: `#thread=${stripe}&file=${plan}&view=side` },
  { name: 'phone-list', ctx: phone('light'), hash: '' },
  { name: 'phone-thread', ctx: phone('light'), hash: `#thread=${detect}` },
  { name: 'phone-thread-dark', ctx: phone('dark'), hash: `#thread=${stripe}` },
];

const browser = await chromium.launch();
for (const state of states) {
  for (const [label, base] of [['today', today], ['elegant', elegant]] as const) {
    const ctx = await browser.newContext(state.ctx);
    const page = await ctx.newPage();
    await page.goto(new URL(`/${state.hash}`, base).toString());
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(1500);
    if (state.act) await state.act(page).catch((e) => process.stderr.write(`${state.name} ${label}: ${e}\n`));
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(out, `${state.name}--${label}.png`) });
    await ctx.close();
  }
}
await browser.close();
process.stdout.write(`shots in ${out}\n`);
