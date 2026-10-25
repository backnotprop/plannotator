/**
 * Design prototype only: a real Send through the Messages-style composer
 * (a words-only follow-up in the "Refund events" thread), then a check that
 * the Inbox stored it. Headless.
 *
 *   bun scripts/proto-imessage-send-check.ts --url http://localhost:<proxy port>/
 */
import { chromium } from '@playwright/test';

const base = process.argv[process.argv.indexOf('--url') + 1]!;
const list = (await (await fetch(new URL('/api/inbox/threads', base))).json()) as { sections: { threads: { thread_id: string; subject: string; message_count: number }[] }[] };
const refund = list.sections.flatMap((s) => s.threads).find((t) => t.subject.startsWith('Refund events'))!;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(`${base}#thread=${refund.thread_id}`);
if (process.argv.includes('--send')) {
  await page.getByRole('textbox', { name: /Message/ }).fill('Also add a metric for dropped events, please.');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelectorAll('[data-message-id]').length >= 3, null, { timeout: 10000 });
}
const delivery = await page.locator('[data-delivery-line]').textContent();
// A pick on a card rides the composer as a chip; the chip's × takes it back.
const detect = list.sections.flatMap((s) => s.threads).find((t) => t.subject.startsWith('Detect the installed'))!;
await page.goto(`${base}#thread=${detect.thread_id}`);
await page.getByText('Always ask', { exact: true }).click();
await page.locator('[data-pick-chip]').waitFor({ timeout: 10000 });
const chip = await page.locator('[data-pick-chip]').textContent();
await page.locator('[data-pick-chip] button').click();
await page.locator('[data-pick-chip]').waitFor({ state: 'detached', timeout: 10000 });
process.stdout.write(`pick chip: ${chip} · removed again\n`);
await browser.close();
const after = (await (await fetch(new URL(`/api/inbox/threads/${refund.thread_id}`, base))).json()) as { thread: { messages: { author: { kind: string }; body: string }[] } };
const last = after.thread.messages.at(-1)!;
process.stdout.write(`stored: ${last.author.kind} "${last.body}" · delivery line: ${delivery}\n`);
if (last.author.kind !== 'person' || !last.body.includes('metric for dropped events')) process.exit(1);
