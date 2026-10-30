/**
 * Guided reviews from agents (PLAN step 5), proved in a real browser against
 * the compiled binary. Nothing is mocked: the binary runs
 * `plannotator inbox --background` under a temp PLANNOTATOR_DATA_DIR (and
 * HOME), agents call get_guide_brief and submit_guide through
 * `plannotator inbox mcp` with the MCP SDK's stdio client
 * (scripts/inbox-sim.ts), and Chromium opens the guides the person sees.
 *
 * Build the binary first (see inbox.spec.ts), then `bun run test:e2e:inbox`.
 * PNGs of every proved state, light and dark at 1440 by 900, land in
 * .local/proof/guides/ with a contact sheet.
 */

import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { FIXTURE_V1_LOCAL, FIXTURE_PATCH_TS_JSON } from '../../packages/core/guide-format-fixtures';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, rememberInboxOf, removeInboxScratch, stopScratchInbox } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'guides');

interface World {
  root: string;
  dataDir: string;
  env: Record<string, string>;
  url: string;
  ledger: string;
  pi: SimAgent;
  claude: SimAgent;
  context: BrowserContext;
  page: Page;
  errors: string[];
  authored: { thread_id: string; message_id: string; guide: Record<string, number | string> };
  snapshot: { thread_id: string; message_id: string; guide: Record<string, number | string> };
}

let world: World;

function registry(): { pid: number; port: number } {
  return JSON.parse(readFileSync(join(world.dataDir, 'inbox', 'inbox.json'), 'utf8'));
}

async function shot(name: string): Promise<void> {
  const page = world.page;
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(proofDir, `${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-guides-e2e-');
  const dataDir = join(root, 'data');
  const home = join(root, 'home');
  mkdirSync(home);
  const env = { PATH: process.env.PATH ?? '', HOME: home, PLANNOTATOR_DATA_DIR: dataDir };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const url = started.stdout.trim();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  world = {
    root,
    dataDir,
    env,
    url,
    ledger: scratchProject(join(root, 'src'), 'ledger'),
    pi: await SimAgent.connect({ binary, env, name: 'Pi', host: 'pi' }),
    claude: await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' }),
    context,
    page,
    errors,
    authored: null as never,
    snapshot: null as never,
  };
});

test.afterAll(async () => {
  try {
    if (!world) return;
    await Promise.all([world.pi.close().catch(() => {}), world.claude.close().catch(() => {})]);
    await world.context.close();
    const names = [...new Set(readdirSync(proofDir).filter((f) => f.endsWith('-light.png')).map((f) => f.replace(/-light\.png$/, '')))].sort();
    writeFileSync(
      join(proofDir, 'index.html'),
      `<!doctype html><meta charset="utf-8"><title>Plannotator Inbox guided reviews: proof</title><style>body{font:14px system-ui;margin:24px;background:#e9eaee}h2{font-size:15px;margin:24px 0 8px}.pair{display:flex;gap:12px}.pair img{width:calc(50% - 6px);box-shadow:0 0 0 1px #0002;border-radius:6px}</style><h1>Plannotator Inbox guided reviews: every proved state, light and dark, 1440 by 900</h1>${names
        .map((n) => `<section><h2>${n}</h2><div class="pair"><img src="${n}-light.png" alt="${n} light"><img src="${n}-dark.png" alt="${n} dark"></div></section>`)
        .join('\n')}`,
    );
  } finally {
    // Every Inbox this spec started, then its folders (inbox-scratch.ts).
    await removeInboxScratch();
  }
});

test('get_guide_brief returns the method, the shape, the diff steps, the rules and a worked call', async () => {
  const brief = await world.pi.guideBrief();
  expect(brief.methodology).toContain('# Guided Review Organizer');
  expect(brief.output_schema.required).toEqual(['title', 'intent', 'sections', 'unplacedFiles']);
  expect(brief.diff_steps).toContain('git diff <merge-base>');
  expect(brief.rules.join('\n')).toContain('never place it twice');
  expect(Object.keys(brief.example).sort()).toEqual(['body', 'guide', 'patch']);
});

test('the AUTHORED guide plus patch and a shipped snapshot land as rows with the Guided review mark', async () => {
  const { page, pi, claude } = world;
  // The brief's worked example, sent as it is: the AUTHORED fixture and its patch.
  const { example } = await pi.guideBrief();
  const authored = await pi.submitGuide({ project_path: world.ledger, ...example, idempotency_key: 'guide-retry-1' });
  expect(authored.guide).toMatchObject({ title: 'Token refresh', sections: 1, files: 2, additions: 2, deletions: 2 });
  // A retry of the same call answers the first message (the built snapshot carries
  // the time it was built; the retry is compared on what the agent sent).
  const retry = await pi.submitGuide({ project_path: world.ledger, ...example, idempotency_key: 'guide-retry-1' });
  expect(retry).toMatchObject({ replayed: true, message_id: authored.message_id, thread_id: authored.thread_id });
  expect(retry.guide.sha256).toBe(authored.guide.sha256);
  // A shipped fixture as a whole snapshot, from another session (its own thread).
  const snapshot = await claude.submitGuide({
    project_path: world.ledger,
    snapshot: FIXTURE_V1_LOCAL,
    subject: 'Run finished. A guided review of the refresh change is attached.',
    body: 'The refresh path now refuses a missing token. I wrote a guided review so you can read it in order.',
  });
  expect(snapshot.guide).toMatchObject({ title: 'Auth token refresh', sections: 2, files: 2, additions: 5, deletions: 2 });
  expect(snapshot.thread_id).not.toBe(authored.thread_id);
  world.authored = authored as World['authored'];
  world.snapshot = snapshot as World['snapshot'];

  // Opened after both sends: a list already on screen holds a later arrival
  // behind "N new" (held order), so opening first raced the two sends.
  await page.goto(world.url);
  for (const sent of [authored, snapshot]) {
    const row = page.locator(`.ib-row[data-thread-id="${sent.thread_id}"]`);
    await expect(row).toBeVisible();
    await expect(row.locator('[data-guide-mark]')).toHaveText('Guided review');
  }
  await shot('1.1-guide-rows');
});

test('the thread shows the guide at the foot of its message, and Open renders sections, files and the diff', async () => {
  const { page } = world;
  const guide = world.snapshot.guide;
  await page.locator(`[data-thread-id="${world.snapshot.thread_id}"]`).click();
  const pane = page.locator('section.ib-pane');
  await expect(pane.getByRole('heading', { name: 'Run finished. A guided review of the refresh change is attached.' })).toBeVisible();
  await expect(pane.locator('.ib-attach-h')).toHaveText('1 attachment');
  const card = pane.locator('[data-guide-card]');
  await expect(card).toContainText('Guided review: Auth token refresh');
  await expect(card).toContainText(`${guide.sections} sections, ${guide.files} files, +${guide.additions} -${guide.deletions}`);
  await shot('4.1-guide-in-thread');

  await card.click();
  await expect(page).toHaveURL(new RegExp(`#thread=${world.snapshot.thread_id}&guide=${world.snapshot.message_id}$`));
  const viewer = page.getByRole('region', { name: 'Guided review', exact: true });
  await expect(viewer.locator('.ib-vhead')).toContainText(/Guided review\s*from Claude Code in ledger, sent \d{1,2}:\d{2} [AP]M/);
  await expect(viewer.getByRole('heading', { level: 1, name: 'Auth token refresh' })).toBeVisible();
  await expect(viewer.getByText('Harden the refresh path and bump the package version.')).toBeVisible();
  for (const section of FIXTURE_V1_LOCAL.guide.sections) await expect(viewer.getByText(section.title, { exact: true })).toBeVisible();
  // The snapshot's own reviewed state holds: its first section came reviewed, so it is folded.
  await expect(viewer.getByText(/2 sections · 1\/2 reviewed · generated by Claude · sonnet/)).toBeVisible();
  await expect(viewer.getByText('acme/demo · feat/refresh · origin/main..HEAD')).toBeVisible();
  await expect(viewer.getByRole('button', { name: /^package\.json/ })).toBeVisible();
  // The diff itself, drawn by Plannotator's renderer.
  await expect(viewer.getByText('"version": "1.0.1"').first()).toBeVisible({ timeout: 30_000 });
  await shot('4.2-guide-open');
});

test('a reviewed tick is kept with the thread, across a restart on another port; Thread and Escape go back', async () => {
  const { page } = world;
  const viewer = page.getByRole('region', { name: 'Guided review', exact: true });
  await viewer.getByRole('button', { name: 'Reviewed', exact: true }).click();
  await expect(viewer.getByText(/2\/2 reviewed/)).toBeVisible();
  // Kept on the message in the store, not in the page.
  await expect
    .poll(async () => {
      const answer = await (await page.request.get(`${world.url}api/inbox/threads/${world.snapshot.thread_id}`)).json();
      return answer.thread.messages.find((m: { id: string }) => m.id === world.snapshot.message_id)?.guide_reviewed;
    })
    .toEqual([true, true]);

  // The Inbox stops, its last port is taken, and it comes back on another port:
  // a new origin, so nothing the page kept could carry the ticks over.
  const before = registry();
  // The old page loses its event stream and its reconnects are refused while the Inbox is down, by design.
  const mark = world.errors.length;
  await stopScratchInbox(world.dataDir);
  const squatter = createServer();
  await new Promise<void>((done) => squatter.listen(before.port, '127.0.0.1', done));
  try {
    const restarted = spawnSync(binary, ['inbox', '--background'], { env: world.env, encoding: 'utf8', timeout: 60_000 });
    rememberInboxOf(world.dataDir);
    expect(restarted.status, restarted.stderr).toBe(0);
    world.url = restarted.stdout.trim();
    expect(registry().port).not.toBe(before.port);
  } finally {
    squatter.close();
  }
  await page.goto(`${world.url}#thread=${world.snapshot.thread_id}&guide=${world.snapshot.message_id}`);
  await expect(page.getByRole('region', { name: 'Guided review', exact: true }).getByText(/2\/2 reviewed/)).toBeVisible();
  world.errors.splice(mark, world.errors.length - mark, ...world.errors.slice(mark).filter((e) => !/^Failed to load resource: net::ERR_(CONNECTION_REFUSED|CONNECTION_RESET|INCOMPLETE_CHUNKED_ENCODING)$/.test(e)));
  // Un-tick the first again: the sections open as the person left them.
  await page.getByRole('region', { name: 'Guided review', exact: true }).getByRole('button', { name: 'Un-mark as reviewed' }).first().click();
  await expect(page.getByRole('region', { name: 'Guided review', exact: true }).getByText(/1\/2 reviewed/)).toBeVisible();
  await expect(page.getByRole('region', { name: 'Guided review', exact: true }).getByText('if (!token) throw new Error("missing token");').first()).toBeVisible({ timeout: 30_000 });
  await shot('4.2-guide-reviewed-tick');

  await page.getByRole('region', { name: 'Guided review', exact: true }).getByRole('button', { name: 'Thread', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Guided review', exact: true })).toHaveCount(0);
  await expect(page.locator('section.ib-pane')).toBeVisible();
  await page.locator('[data-guide-card]').click();
  await expect(page.getByRole('region', { name: 'Guided review', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('region', { name: 'Guided review', exact: true })).toHaveCount(0);
  await expect(page.locator('section.ib-pane')).toBeVisible();
});

test('the authored guide opens with its file left out under "Everything else"', async () => {
  const { page } = world;
  await page.locator(`.ib-nrow[data-thread-id="${world.authored.thread_id}"]`).click();
  await page.locator('section.ib-pane [data-guide-card]').click();
  const viewer = page.getByRole('region', { name: 'Guided review', exact: true });
  await expect(viewer.getByRole('heading', { level: 1, name: 'Token refresh' })).toBeVisible();
  await expect(viewer.getByText('The guard', { exact: true })).toBeVisible();
  await expect(viewer.getByText('Everything else', { exact: true })).toBeVisible();
  await expect(viewer.getByText('package.json').first()).toBeVisible();
  await expect(viewer.getByText(/generated by Claude Code · claude-opus-5/)).toBeVisible();
  await shot('4.2-authored-guide-open');
  await viewer.getByRole('button', { name: 'Close the guided review' }).click();
  await expect(page.locator('section.ib-pane')).toHaveCount(0);
});

test('a guide naming a file not in the patch, or a file twice, is refused by name and lands nothing', async () => {
  const { pi, claude, page } = world;
  const { example } = await pi.guideBrief();
  // The last test closed a thread: the list settles a beat later (packages/inbox/settle.ts). Count once
  // no settle animation runs and the count holds across more than the beat.
  const rows = page.locator('.ib-lbody [data-thread-id]');
  await expect
    .poll(async () => {
      const first = await rows.count();
      await new Promise((r) => setTimeout(r, 250));
      const settling = await page.evaluate(() => document.getAnimations().some((a) => a.id === 'ib-settle'));
      return !settling && (await rows.count()) === first;
    })
    .toBe(true);
  const rowsBefore = await rows.count();
  const section = example.guide.sections[0];

  await expect(
    pi.submitGuide({ project_path: world.ledger, guide: { ...example.guide, sections: [{ ...section, diffs: [{ file: 'src/nope.ts', summary: '?' }] }] }, patch: example.patch }),
  ).rejects.toThrow(/invalid_guide: .*These files are not in the patch: src\/nope\.ts/s);
  await expect(
    pi.submitGuide({ project_path: world.ledger, guide: { ...example.guide, sections: [section, { title: 'Again', overview: 'The same file.', diffs: section.diffs }] }, patch: example.patch }),
  ).rejects.toThrow(/src\/auth\.ts is placed twice/);
  // A snapshot gets the same strict checks.
  await expect(
    claude.submitGuide({
      project_path: world.ledger,
      snapshot: { ...FIXTURE_V1_LOCAL, review: { ...FIXTURE_V1_LOCAL.review, rawPatch: FIXTURE_PATCH_TS_JSON.split('diff --git a/package.json')[0] } },
    }),
  ).rejects.toThrow(/These files are not in the patch: package\.json/);
  await expect(pi.submitGuide({ project_path: world.ledger, guide: example.guide })).rejects.toThrow(/`guide` and `patch` go together/);

  await page.waitForTimeout(500);
  expect(await page.locator('.ib-lbody [data-thread-id]').count()).toBe(rowsBefore);
});

test('deleting a thread removes its guide blob only when no other record uses it', async () => {
  const { claude, page } = world;
  // Two threads whose guides are the same snapshot, so the same blob.
  const twin = { ...FIXTURE_V1_LOCAL, guide: { ...FIXTURE_V1_LOCAL.guide, title: 'Twin guide' } };
  const a = await claude.submitGuide({ project_path: world.ledger, snapshot: twin, thread: 'twin-a' });
  const b = await claude.submitGuide({ project_path: world.ledger, snapshot: twin, thread: 'twin-b' });
  expect(a.thread_id).not.toBe(b.thread_id);
  expect(a.guide.sha256).toBe(b.guide.sha256);
  const blob = join(world.dataDir, 'inbox', 'blobs', a.guide.sha256);
  expect(existsSync(blob)).toBe(true);
  const remove = async (threadId: string) => {
    const answer = await page.request.post(`${world.url}api/inbox/threads/${threadId}/delete`, { data: {} });
    expect(answer.status(), await answer.text()).toBe(200);
  };

  await remove(a.thread_id);
  // twin-b's guide still names the blob: kept.
  expect(existsSync(blob)).toBe(true);
  expect((await (await page.request.get(`${world.url}api/inbox/messages/${b.message_id}/guide`)).json()).snapshot.guide.title).toBe('Twin guide');

  await remove(b.thread_id);
  // No record names it any more: removed.
  expect(existsSync(blob)).toBe(false);
  // The other guides' blobs are untouched.
  expect(existsSync(join(world.dataDir, 'inbox', 'blobs', world.snapshot.guide.sha256 as string))).toBe(true);
  expect(existsSync(join(world.dataDir, 'inbox', 'blobs', world.authored.guide.sha256 as string))).toBe(true);
});

test('a comment on the guide\'s diffs: a line and a range, listed beside the guide and in the reply\'s annotations, edited there, and sent as the review app\'s export', async () => {
  const { claude, page } = world;
  const guide = { ...FIXTURE_V1_LOCAL, guide: { ...FIXTURE_V1_LOCAL.guide, title: 'Comment on the diffs', reviewed: [false, false] } };
  const sent = await claude.submitGuide({ project_path: world.ledger, snapshot: guide, thread: 'guide-comments', subject: 'A guided review to comment on.' });
  await page.goto(`${world.url}#thread=${sent.thread_id}&guide=${sent.message_id}`);
  const viewer = page.getByRole('region', { name: 'Guided review', exact: true });
  const panel = viewer.locator('[data-guide-comments]');
  await expect(panel).toContainText('No annotations yet');
  const auth = viewer.locator('[data-guide-file-shell="src/auth.ts"]');
  const added = (line: number) => auth.locator(`[data-line-type="change-addition"][data-column-number="${line}"]`);
  await expect(added(2)).toBeVisible({ timeout: 30_000 });

  // A range: drag across the new side's line numbers 2 to 3, as in the review app.
  const from = (await added(2).boundingBox())!;
  const to = (await added(3).boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 6 });
  await page.mouse.up();
  const composer = page.getByPlaceholder('Leave feedback...');
  await expect(composer).toBeVisible();
  await expect(page.getByText('Lines 2-3', { exact: true })).toBeVisible();
  await composer.fill('Throw a typed error the caller can catch.');
  await shot('4.3-guide-comment-composer');
  await page.getByRole('button', { name: 'Add Comment' }).click();
  await expect(panel).toHaveAttribute('data-guide-comments', '1');
  await expect(auth.getByText('Throw a typed error the caller can catch.')).toBeVisible();

  // A line on the other file: click its line number.
  const pkg = viewer.locator('[data-guide-file-shell="package.json"]');
  await pkg.hover();
  await pkg.locator('[data-line-type="change-addition"][data-column-number="3"]').click();
  await expect(composer).toBeVisible();
  await composer.fill('Bump the minor, not the patch.');
  await page.getByRole('button', { name: 'Add Comment' }).click();
  await expect(panel).toHaveAttribute('data-guide-comments', '2');
  await expect(panel).toContainText('auth.ts · lines 2-3');
  await expect(panel).toContainText('package.json · line 3');
  await expect(viewer.locator('[data-strip-chip]')).toHaveText('2 comments');
  await shot('4.3-guide-comments-in-the-panel');

  // Kept in the store with the thread's annotations, keyed to the message and the file.
  const model = (await (await page.request.get(`${world.url}api/inbox/threads/${sent.thread_id}/attachments`)).json()) as { annotations: { message_id: string; path: string; guide: { side: string; line_start: number; line_end: number } }[] };
  expect(model.annotations.map((r) => [r.message_id, r.path, r.guide.side, r.guide.line_start, r.guide.line_end])).toEqual([
    [sent.message_id, 'src/auth.ts', 'new', 2, 3],
    [sent.message_id, 'package.json', 'new', 3, 3],
  ]);

  // Reviewed ticks keep working beside the comments.
  await viewer.getByRole('button', { name: 'Reviewed', exact: true }).first().click();
  await expect(viewer.getByText(/1\/2 reviewed/)).toBeVisible();

  // The same thread also carries an attached file: the file's pane lists only its own annotations.
  writeFileSync(join(world.ledger, 'notes.md'), '# Notes\n\nRefresh tokens a minute early.\n');
  const notes = await claude.send({ project_path: world.ledger, thread: 'guide-comments', body: 'And my notes.', attachments: ['notes.md'] });
  expect(notes.thread_id).toBe(sent.thread_id);

  // Back to the thread: the reply's chip counts them; edit one there.
  await viewer.getByRole('button', { name: 'Back to the thread' }).click();
  await expect(viewer).toHaveCount(0);
  const tile = page.locator(`.ib-att-t[data-attachment-id="${notes.attachments[0].id}"]`);
  await expect(tile).toBeVisible();
  await expect(tile).not.toContainText('annotation');
  await tile.click();
  const filePane = page.locator(`[data-attachment-pane="${notes.attachments[0].id}"]`);
  await expect(filePane.getByText('Refresh tokens a minute early.')).toBeVisible();
  await expect(filePane.locator('.ib-apanel')).toContainText('No annotations yet');
  await expect(filePane.locator('.ib-apanel')).not.toContainText('Throw a typed error');
  await shot('4.3-guide-comments-not-on-the-attached-file');
  await filePane.getByRole('button', { name: 'Close notes.md' }).click();
  await expect(filePane).toHaveCount(0);
  await page.getByRole('button', { name: 'Reply', exact: true }).last().click();
  const chip = page.locator('[data-annotations-chip]');
  await expect(chip).toHaveText('2 annotations');
  await chip.click();
  const pop = page.getByRole('dialog', { name: '2 annotations ride this reply' });
  await expect(pop.locator('[data-annotation-row]').first()).toContainText('src/auth.ts (guided review)');
  await expect(pop.locator('[data-annotation-row]').first()).toContainText('lines 2-3');
  await pop.locator('[data-annotation-row]').nth(1).getByRole('button', { name: 'Edit' }).click();
  await pop.getByRole('textbox', { name: 'Edit the comment' }).fill('Bump the minor version, not the patch.');
  await pop.getByRole('button', { name: 'Save' }).click();
  await expect(pop.locator('[data-annotation-row]').nth(1)).toContainText('Bump the minor version, not the patch.');
  await shot('4.3-guide-comments-in-the-reply');
  await page.keyboard.press('Escape');

  // Send: the agent's wait_for_reply returns the comments as the review app's export.
  const waiting = claude.waitForReply(sent.thread_id, 40);
  await page.getByRole('textbox', { name: 'Reply to Claude Code' }).fill('Two notes on the diff.');
  await page.locator('.ib-pfoot').getByRole('button', { name: 'Send' }).click();
  const reply = await waiting;
  expect(reply.status).toBe('replied');
  const body = reply.reply.body as string;
  expect(body.indexOf('Two notes on the diff.')).toBeLessThan(body.indexOf('# Feedback on the guided review'));
  for (const part of [
    '"Comment on the diffs"',
    '## src/auth.ts',
    '### Lines 2-3 (new)',
    'Throw a typed error the caller can catch.',
    '  if (!token) throw new Error("missing token");\n  const html = \'</script><!--\';',
    '## package.json',
    '### Line 3 (new)',
    'Bump the minor version, not the patch.',
    '  "version": "1.0.1"',
  ]) {
    expect(body).toContain(part);
  }
  // Sent with the reply: no longer waiting, and the guide's panel is empty again.
  await expect(chip).toHaveCount(0);
  const after = (await (await page.request.get(`${world.url}api/inbox/threads/${sent.thread_id}/attachments`)).json()) as { annotations: unknown[] };
  expect(after.annotations).toHaveLength(0);
  await page.locator('section.ib-pane [data-guide-card]').click();
  await expect(page.getByRole('region', { name: 'Guided review', exact: true }).locator('[data-guide-comments]')).toHaveAttribute('data-guide-comments', '0');
  await page.keyboard.press('Escape');
});

test('a long thread name plus the Guided review mark never pushes a row out of shape, in every project or one, at any width', async () => {
  const { claude, page } = world;
  // A name that is long (35 characters) and the longest send_message takes (120).
  const names = ['refund-webhooks-retry-on-stripe-409', `release-train-${'checkout-refunds-ledger-'.repeat(5)}`.slice(0, 120)];
  expect(names.map((n) => n.length)).toEqual([35, 120]);
  const threads: string[] = [];
  for (const name of names) {
    const sent = await claude.submitGuide({
      project_path: world.ledger,
      snapshot: { ...FIXTURE_V1_LOCAL, guide: { ...FIXTURE_V1_LOCAL.guide, title: `Guide on ${name.length}` } },
      thread: name,
      subject: 'The refund worker retries on a Stripe 409 with the same idempotency key, and the ledger export follows it.',
    });
    threads.push(sent.thread_id);
  }
  const projects = (await (await page.request.get(`${world.url}api/inbox/projects`)).json()).projects as { id: string; name: string }[];
  const ledger = projects.find((p) => p.name === 'ledger')!;
  for (const [i, name] of names.entries()) {
    // Every project below 900px of list draws the three-line row; one project
    // keeps the wide row. The wide row's title cell holds the name (one line,
    // cut with "…"), the subject and the mark. The three-line row and, below
    // 768px (a phone, packages/inbox/phone.ts), the mail row put the name on
    // line 2, whole (it wraps), and the subject and the mark on line 3
    // (approval "list-rows-mail-icons").
    const row = page.locator(`.ib-lbody [data-thread-id="${threads[i]}"]`);
    for (const route of ['', `#project=${ledger.id}`]) {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`${world.url}${route}`);
      await expect(row).toBeVisible();
      await expect(row.locator('.ib-title, .ib-m2').first()).toHaveText(name);
      await expect(row.locator('[data-guide-mark]')).toHaveCount(1);
      // One project keeps the wide row down to a phone's width, then the mail row: also 360, 500 and 520px there.
      for (const width of route ? [360, 500, 520, 556, 656, 820] : [556, 656, 820]) {
        await page.setViewportSize({ width, height: 900 });
        await expect(row).toBeVisible();
        // Measure the settled layout: below 768px the sidebar leaves the row
        // (off-canvas) a moment after the resize, and every project's rows change
        // shape at 900px of list; wait for the list to stop moving. Read from the
        // list itself: a row element is replaced when its shape changes.
        const listWidth = () => page.locator('.ib-lbody').evaluate((el) => el.clientWidth);
        if (width < 768) await expect.poll(listWidth).toBe(width);
        await expect
          .poll(async () => {
            const before = await listWidth();
            await page.waitForTimeout(250);
            return before === (await listWidth());
          })
          .toBe(true);
        const measured = await row.evaluate((el) => {
          const body = el.closest('.ib-lbody')!;
          const wideRow = el.querySelector('.ib-subj') !== null;
          // The line with the mark: the wide row's title cell, else line 3.
          const line = el.querySelector(':is(.ib-subj, .ib-l3, .ib-m3)')!.getBoundingClientRect();
          const box = (sel: string) => el.querySelector(sel)!.getBoundingClientRect();
          const title = el.querySelector<HTMLElement>(':is(.ib-title, .ib-m2)')!;
          const t = title.getBoundingClientRect();
          return {
            wideRow,
            listOverflow: body.scrollWidth - body.clientWidth,
            rowOverflow: el.scrollWidth - el.clientWidth,
            lineRight: line.right,
            // What the mark's line must end before: the count words' column, or the row's own edge.
            limit: wideRow ? box('.ib-cw').left : el.getBoundingClientRect().right,
            titleShown: Math.min(t.right, line.right) - t.left,
            titleRight: t.right,
            rowRight: el.getBoundingClientRect().right,
            titleCut: title.scrollWidth > title.clientWidth + 1,
            titleLines: Math.round(t.height / parseFloat(getComputedStyle(title).lineHeight)),
            markRight: box('[data-guide-mark]').right,
          };
        });
        const where = `(${name.length}-character name, ${route ? 'one project' : 'every project'}, ${width}px)`;
        expect(measured.titleShown, `the name is squeezed out ${where}`).toBeGreaterThan(20);
        expect(measured.markRight, `the Guided review mark is clipped ${where}`).toBeLessThanOrEqual(measured.lineRight + 0.5);
        expect(measured.listOverflow, `the list scrolls sideways ${where}`).toBe(0);
        expect(measured.rowOverflow, `the row spills ${where}`).toBe(0);
        expect(measured.lineRight, `the title cell runs into the count ${where}`).toBeLessThanOrEqual(measured.limit);
        if (measured.wideRow) {
          // The wide row is one line: the long name ends in "…" (its tooltip shows it whole).
          expect(measured.titleLines, `the wide row's name runs past its line ${where}`).toBe(1);
          if (name.length === 120) expect(measured.titleCut, `the wide row's name keeps its ellipsis ${where}`).toBe(true);
        } else {
          // Beside a thread and on a phone the name is never cut: it wraps inside the row.
          expect(measured.titleCut, `the name is cut ${where}`).toBe(false);
          expect(measured.titleRight, `the name leaves the row ${where}`).toBeLessThanOrEqual(measured.rowRight + 0.5);
          if (name.length === 120) expect(measured.titleLines, `the long name wraps ${where}`).toBeGreaterThan(1);
        }
      }
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
});

test('Split | Unified sits in a tab on the first section card only, switches every diff, is kept where code review reads it, and a phone draws Unified with no tab', async () => {
  const { claude, page } = world;
  const guide = { ...FIXTURE_V1_LOCAL, guide: { ...FIXTURE_V1_LOCAL.guide, title: 'Diff layout', reviewed: [false, false] } };
  const sent = await claude.submitGuide({ project_path: world.ledger, snapshot: guide, thread: 'diff-layout', subject: 'A guided review to read in one column.' });
  const configPath = join(world.dataDir, 'config.json');
  const styleOnDisk = () => (existsSync(configPath) ? (JSON.parse(readFileSync(configPath, 'utf8')) as { diffOptions?: { diffStyle?: string } }).diffOptions?.diffStyle : undefined);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${world.url}#thread=${sent.thread_id}&guide=${sent.message_id}`);
  const viewer = page.getByRole('region', { name: 'Guided review', exact: true });
  // Pierre's layout per diff, read through its open shadow roots (Unified is `single` there).
  const layouts = () => viewer.locator('pre[data-diff]').evaluateAll((pres) => pres.map((p) => p.getAttribute('data-diff-type')));
  const auth = viewer.locator('[data-guide-file-shell="src/auth.ts"]');
  await expect(auth.locator('[data-line-type="change-addition"]').first()).toBeVisible({ timeout: 30_000 });

  // One tab, on the first card: right above it, and the second card has none.
  const tabs = viewer.locator('[data-guide-section-tab]');
  await expect(tabs).toHaveCount(1);
  await expect(viewer.locator('[data-guide-section-tabbed] > [data-guide-section="0"]')).toHaveCount(1);
  await expect(viewer.locator('[data-guide-section-tabbed] > [data-guide-section="1"]')).toHaveCount(0);
  const group = tabs.getByRole('radiogroup', { name: 'Diff layout' });
  const split = group.getByRole('radio', { name: 'Split' });
  const unified = group.getByRole('radio', { name: 'Unified' });
  await expect(split).toBeChecked();
  await expect.poll(layouts).toEqual(['split', 'split']);
  // The tab's right edge is the card's: its border runs straight up into the tab.
  const edges = await viewer.locator('[data-guide-section-tabbed]').evaluate((wrap) => {
    const tab = wrap.querySelector('[data-guide-section-tab] svg')!.getBoundingClientRect();
    const card = wrap.querySelector('[data-guide-section="0"]')!.getBoundingClientRect();
    return { tabRight: tab.right, cardRight: card.right, tabBottom: tab.bottom, cardTop: card.top };
  });
  expect(Math.abs(edges.tabRight - edges.cardRight)).toBeLessThan(0.5);
  expect(edges.tabBottom - edges.cardTop).toBeGreaterThanOrEqual(0);
  expect(edges.tabBottom - edges.cardTop).toBeLessThanOrEqual(1.5);
  await shot('4.4-guide-diff-layout-split');

  await unified.check();
  await expect.poll(layouts).toEqual(['single', 'single']);
  // Kept where code review reads it: the cookie, and config.json `diffOptions.diffStyle`.
  await expect.poll(styleOnDisk).toBe('unified');
  expect((await world.context.cookies()).find((c) => c.name === 'plannotator-diff-style')?.value).toBe('unified');
  await shot('4.4-guide-diff-layout-unified');

  // A radio group: the arrows choose.
  await unified.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(split).toBeChecked();
  await expect.poll(layouts).toEqual(['split', 'split']);
  await page.keyboard.press('ArrowRight');
  await expect(unified).toBeChecked();
  await expect.poll(layouts).toEqual(['single', 'single']);

  // A comment on a line in Unified: the review app's selection, kept by file, side and line.
  const panel = viewer.locator('[data-guide-comments]');
  await auth.hover();
  await auth.locator('[data-line-type="change-addition"][data-column-number="3"]').first().click();
  const composer = page.getByPlaceholder('Leave feedback...');
  await expect(composer).toBeVisible();
  await composer.fill('One column reads fine.');
  await page.getByRole('button', { name: 'Add Comment' }).click();
  await expect(panel).toHaveAttribute('data-guide-comments', '1');
  const model = (await (await page.request.get(`${world.url}api/inbox/threads/${sent.thread_id}/attachments`)).json()) as { annotations: { path: string; guide: { side: string; line_start: number; line_end: number } }[] };
  expect(model.annotations.map((r) => [r.path, r.guide.side, r.guide.line_start, r.guide.line_end])).toEqual([['src/auth.ts', 'new', 3, 3]]);
  await shot('4.4-guide-diff-layout-unified-comment');

  // Back to Split, then a phone: no tab, every diff in one column, the saved layout left as it is.
  await split.check();
  await expect.poll(styleOnDisk).toBe('split');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(viewer.locator('[data-guide-section-tab]')).toHaveCount(0);
  await expect.poll(layouts).toEqual(['single', 'single']);
  await page.waitForTimeout(500);
  expect(styleOnDisk()).toBe('split');
  await shot('4.4-guide-diff-layout-phone');

  // The owner's review pictures (PLANNOTATOR_GUIDE_DIFF_TAB_SHOTS): 1440 and 1100, Split and Unified, light and dark, a phone, and the tab close up.
  const extra = process.env.PLANNOTATOR_GUIDE_DIFF_TAB_SHOTS;
  if (extra) {
    mkdirSync(extra, { recursive: true });
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      for (const width of [1440, 1100]) {
        await page.setViewportSize({ width, height: 900 });
        await expect(viewer.locator('[data-guide-section-tab]')).toHaveCount(1);
        for (const style of ['split', 'unified'] as const) {
          await viewer.getByRole('radio', { name: style === 'split' ? 'Split' : 'Unified' }).check();
          await expect.poll(layouts).toEqual(style === 'split' ? ['split', 'split'] : ['single', 'single']);
          await viewer.locator('.ib-gbody').evaluate((el) => el.scrollTo(0, 0));
          await page.mouse.move(0, 0);
          await page.waitForTimeout(400);
          await page.screenshot({ path: join(extra, `tab-${width}-${style}-${scheme}.png`) });
        }
      }
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(viewer.locator('[data-guide-section-tab]')).toHaveCount(0);
      await viewer.locator('.ib-gbody').evaluate((el) => el.scrollTo(0, 0));
      await page.waitForTimeout(400);
      await page.screenshot({ path: join(extra, `phone-unified-${scheme}.png`) });
      await viewer.locator('[data-guide-file-shell="src/auth.ts"]').scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(extra, `phone-unified-scrolled-${scheme}.png`) });
    }
    // The tab close up, 3x, light and dark.
    const close = await world.context.browser()!.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 3, colorScheme: 'light' });
    await close.addCookies((await world.context.cookies()).filter((c) => c.name === 'plannotator-diff-style'));
    const zoomed = await close.newPage();
    await zoomed.goto(`${world.url}#thread=${sent.thread_id}&guide=${sent.message_id}`);
    const zTab = zoomed.locator('[data-guide-section-tab]');
    await expect(zTab).toHaveCount(1, { timeout: 30_000 });
    for (const scheme of ['light', 'dark'] as const) {
      await zoomed.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      await zoomed.waitForTimeout(400);
      const box = (await zTab.boundingBox())!;
      await zoomed.screenshot({ path: join(extra, `tab-detail-${scheme}.png`), clip: { x: box.x + box.width - 260, y: box.y - 16, width: 290, height: box.height + 60 } });
    }
    await close.close();
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.keyboard.press('Escape');
});

test('no page errors and no CSP refusals along the way', async () => {
  // FIXTURE_PATCH_TS_JSON's first hunk declares 4/6 lines and carries 3/5.
  // It shipped that way and fixtures are never edited; @pierre/diffs 1.5
  // repairs such a hunk and says so with console.error, which is expected here.
  const miscountedFixtureHunk = 'parsePatchContent: hunk line count mismatch: "@@ -1,4 +1,6 @@", declared old/new 4/6, parsed old/new 3/5';
  expect(world.errors.filter((e) => e !== miscountedFixtureHunk)).toEqual([]);
});
