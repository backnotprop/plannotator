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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { FIXTURE_V1_LOCAL, FIXTURE_PATCH_TS_JSON } from '../../packages/core/guide-format-fixtures';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';

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

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function stopInbox(): void {
  try {
    process.kill(registry().pid, 'SIGTERM');
  } catch {
    // Already gone.
  }
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
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-inbox-guides-e2e-')));
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
  if (!world) return;
  await Promise.all([world.pi.close().catch(() => {}), world.claude.close().catch(() => {})]);
  await world.context.close();
  stopInbox();
  rmSync(world.root, { recursive: true, force: true });
  const names = [...new Set(readdirSync(proofDir).filter((f) => f.endsWith('-light.png')).map((f) => f.replace(/-light\.png$/, '')))].sort();
  writeFileSync(
    join(proofDir, 'index.html'),
    `<!doctype html><meta charset="utf-8"><title>Plannotator Inbox guided reviews: proof</title><style>body{font:14px system-ui;margin:24px;background:#e9eaee}h2{font-size:15px;margin:24px 0 8px}.pair{display:flex;gap:12px}.pair img{width:calc(50% - 6px);box-shadow:0 0 0 1px #0002;border-radius:6px}</style><h1>Plannotator Inbox guided reviews: every proved state, light and dark, 1440 by 900</h1>${names
      .map((n) => `<section><h2>${n}</h2><div class="pair"><img src="${n}-light.png" alt="${n} light"><img src="${n}-dark.png" alt="${n} dark"></div></section>`)
      .join('\n')}`,
  );
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
  await page.goto(world.url);
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
  process.kill(before.pid, 'SIGTERM');
  await expect.poll(() => isAlive(before.pid), { timeout: 20_000 }).toBe(false);
  const squatter = createServer();
  await new Promise<void>((done) => squatter.listen(before.port, '127.0.0.1', done));
  try {
    const restarted = spawnSync(binary, ['inbox', '--background'], { env: world.env, encoding: 'utf8', timeout: 60_000 });
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
  const rowsBefore = await page.locator('.ib-lbody [data-thread-id]').count();
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

test('no page errors and no CSP refusals along the way', async () => {
  expect(world.errors).toEqual([]);
});
