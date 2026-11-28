/**
 * Earlier comments on a file, proved in Chromium against the compiled binary:
 *
 *  - they never ride a Send: a reply carries only the comments still waiting;
 *  - a list too long for the side-by-side column scrolls, and its last comment can be reached;
 *  - on a phone, opening the list at the foot of the sheet shows its first comment.
 *
 * Build the binary first (see inbox.spec.ts), then `bun run test:e2e:inbox`.
 */
import { expect, test, type Page } from './inbox-test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileUrl, pane, startWorld, stopWorld, type ListWorld, type ListThread } from './inbox-comments-list-world';

let world: ListWorld;

test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  world = await startWorld();
});
test.afterAll(async () => {
  await stopWorld(world);
});

const OLD_WORDS = 'Said in the first reply';
const FILE_WORDS = 'The nightly import reads each bank feed';

async function post(path: string, body: object): Promise<void> {
  const res = await fetch(new URL(path, world.url), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  expect(res.status, path).toBe(200);
}

const comment = (attachment: string, id: string, text: string) =>
  post('/api/inbox/annotations', { attachment_id: attachment, version: 'current', annotation: { id, type: 'COMMENT', text, originalText: FILE_WORDS, blockId: '', startOffset: 0, endOffset: 0, createdA: Date.now() } });

let threads = 0;

/** A plan commented and sent, then a new version of it from the agent: the state a person comes back to. */
async function cameBack(earlier: number): Promise<ListThread & { second: string }> {
  const n = ++threads;
  const name = `plan-${n}.md`;
  writeFileSync(join(world.project, 'docs', name), `# Plan\n\n${FILE_WORDS} at night.\n`);
  const key = `earlier-${n}`;
  const first = await world.agent.send({ project_path: world.project, subject: `Plan ${n}`, thread: key, body: 'First pass.', attachments: [`docs/${name}`] });
  const thread = first.thread_id as string;
  const attachmentOf = async () => {
    const model = (await (await fetch(new URL(`/api/inbox/threads/${thread}/attachments`, world.url))).json()) as { attachments: { id: string; message_id: string }[] };
    return model;
  };
  const firstFile = (await attachmentOf()).attachments[0]!.id;
  const ids = Array.from({ length: earlier }, (_, i) => `old-${n}-${i}`);
  for (const [i, id] of ids.entries()) await comment(firstFile, id, `${OLD_WORDS}, number ${i}.`);
  await post(`/api/inbox/messages/${first.message_id}/reply`, { idempotency_key: `reply-${n}`, words: 'Notes.', feedback: 'Notes.', annotation_ids: ids });
  writeFileSync(join(world.project, 'docs', name), `# Plan, second pass\n\n${FILE_WORDS} at night.\n`);
  const second = await world.agent.send({ project_path: world.project, thread: key, reply_to: first.message_id, body: 'Second pass.', attachments: [`docs/${name}`] });
  const plan = (await attachmentOf()).attachments.find((a) => a.message_id === second.message_id)!.id;
  return { thread, message: second.message_id as string, second: second.message_id as string, plan, page: '', onMessage: '', onPlan: '', count: 0 };
}

const earlierOf = (page: Page) => page.locator('[data-earlier-comment]');

test('earlier comments never ride a Send: the reply carries the new comment alone', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const t = await cameBack(3);
  await comment(t.plan, 'new-one', 'A new thought on the second pass.');
  await page.goto(fileUrl(world, t, t.plan, 'side'));
  await expect(page.locator('[data-earlier-row]')).toContainText('3');
  const sending = page.waitForRequest((request) => request.method() === 'POST' && /\/messages\/[^/]+\/reply$/.test(new URL(request.url()).pathname));
  await pane(page).locator('.ib-footrow').getByRole('button', { name: 'Send' }).click();
  const body = (await sending).postDataJSON() as { annotation_ids?: string[]; feedback?: string };
  expect(body.annotation_ids).toEqual(['new-one']);
  expect(body.feedback).toContain('A new thought on the second pass.');
  expect(body.feedback).not.toContain(OLD_WORDS);
  await context.close();
});

test('a list too long for the side-by-side column scrolls inside it, down to its last comment', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const t = await cameBack(40);
  await page.goto(fileUrl(world, t, t.plan, 'side'));
  await expect(earlierOf(page)).toHaveCount(40);
  const column = page.locator('.ib-apanel');
  const panel = column.locator('[data-annotation-panel]');
  const columnBox = (await column.boundingBox())!;
  expect((await panel.boundingBox())!.height).toBeLessThanOrEqual(columnBox.height + 0.5);
  const last = earlierOf(page).last();
  await last.scrollIntoViewIfNeeded();
  const box = (await last.boundingBox())!;
  expect(box.y + box.height).toBeLessThanOrEqual(columnBox.y + columnBox.height + 0.5);
  // The row stays where it can be pressed while its list scrolls.
  const row = (await page.locator('[data-earlier-row]').boundingBox())!;
  expect(row.y).toBeGreaterThanOrEqual(columnBox.y);
  await context.close();
});

test('a phone: opening the list at the foot of the sheet shows its first comment', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const page = await context.newPage();
  const t = await cameBack(3);
  for (let i = 0; i < 6; i++) await comment(t.plan, `current-${t.thread}-${i}`, `A current thought, number ${i}.`);
  await page.goto(fileUrl(world, t, t.plan, 'full'));
  await page.locator('[data-full-view-comments]').first().tap();
  const row = page.locator('[data-earlier-row]');
  await expect(row).toHaveAttribute('aria-expanded', 'false');
  await row.tap();
  const first = earlierOf(page).first();
  await expect(first).toBeVisible();
  await expect.poll(async () => {
    const [item, foot] = [await first.boundingBox(), await page.locator('.ib-apanel .ib-fvfoot').boundingBox()];
    return item!.y + item!.height <= foot!.y + 0.5;
  }).toBe(true);
  await context.close();
});
