/**
 * Clicking and navigating inside an agent's page in the Inbox, as in a tab
 * (the owner, 2026-11-11: "I should be able to click and navigate"), proved in
 * a real browser against the compiled binary. Nothing is mocked: an agent
 * sends, through `plannotator inbox mcp`, a question whose options each have a
 * `Prototype:` page (attached HTML), and a message with an `html` fence.
 *
 * Each page is a small made-up mock with the shape agents write: a switcher in
 * its bottom right corner whose links are `?variant=N` (the same page with a
 * query), a hover state, a GET form, a `#` link its script routes on, and a
 * link to another option's page. Before the fix every one of these but the
 * hover did nothing in the Inbox: a link that was only a query resolved to
 * nothing, the prototype window handed links to no one, the sandbox refused
 * every form, and an in-page link scrolled without setting the hash.
 *
 * Proved: in the "Try prototypes" window the switcher's `?variant=2` loads the
 * page again with that query (the page reads it in `location.search`) and adds
 * no entry to the window's history; hover styles apply; a GET form loads the
 * page with its fields; a `#` link fires the page's hashchange; a link to
 * another option's page steps the window to that option. In the attached
 * page's own viewer and in an `html` fence a `?variant=2` link does the same.
 *
 * Screenshots go to PLANNOTATOR_PROTOTYPE_NAV_SHOTS when it is set.
 * Build the binary first (see inbox.spec.ts), then `bun run test:e2e:inbox`.
 */

import { expect, test, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const shots = process.env.PLANNOTATOR_PROTOTYPE_NAV_SHOTS ?? '';

/** A made-up mock, as agents write them: it reads its variant from the query and routes on its hash. */
const MOCK = (name: string, fallback: number) => `<!doctype html><html><head><meta charset="utf-8"><title>${name}</title>
<style>
body{font:15px/1.5 system-ui;margin:28px;color:#222;background:#fafaf7}
#pile{display:inline-block;padding:10px 16px;border-radius:14px;background:#e5e7eb}
#pile:hover{background:rgb(79, 107, 237);color:#fff}
.pick{position:fixed;right:10px;bottom:8px;font-size:12px}
</style></head><body>
<h1 id="title"></h1>
<p>search=<b id="search"></b> step=<b id="step">1</b></p>
<p><span id="pile">3 sessions</span></p>
<p><a id="next-step" href="#step-2">Next step</a> · <a id="other" href="1-names.html">The names option</a></p>
<form id="find" method="get"><input name="who" value="ada"> <button id="go">Find</button></form>
<div class="pick">variant: <a href="?variant=1">1</a> <a href="?variant=2">2</a> <a href="?variant=3">3</a></div>
<script>
const q = new URLSearchParams(location.search);
document.getElementById('title').textContent = '${name}: variant ' + (q.get('variant') || '${fallback}');
document.getElementById('search').textContent = location.search || '(none)';
const route = () => { const m = /step-(\\d)/.exec(location.hash); if (m) document.getElementById('step').textContent = m[1]; };
addEventListener('hashchange', route); route();
</script>
</body></html>`;

async function shot(page: Page, name: string) {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(shots, `${name}.png`) });
}

async function world() {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  const root = inboxScratch('plannotator-inbox-protonav-e2e-');
  const dataDir = join(root, 'data');
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_BROWSER: NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const url = started.stdout.trim();
  const project = scratchProject(join(root, 'src'), 'team-roster');
  mkdirSync(join(project, 'proto'), { recursive: true });
  writeFileSync(join(project, 'proto', '1-names.html'), MOCK('Names', 1));
  writeFileSync(join(project, 'proto', '3-unfold.html'), MOCK('Unfold', 3));
  const agent = await SimAgent.connect({ binary, env, name: 'Claude', host: 'claude-code' });
  const question = await agent.send({
    project_path: project,
    subject: 'Session names: which look?',
    attachments: ['proto/1-names.html', 'proto/3-unfold.html'],
    body: [
      'Two ways to show who is in a thread.',
      '',
      ':::question',
      'Which one should ship?',
      '',
      '- [ ] 1 · Names — every session by name',
      '    Prototype: proto/1-names.html',
      '- [ ] 3 · Unfold — a pile that opens',
      '    Prototype: proto/3-unfold.html',
      '',
      'Recommended: 3 · Unfold',
      ':::',
    ].join('\n'),
  });
  const ids = Object.fromEntries((question.attachments as { id: string; name: string }[]).map((a) => [a.name, a.id]));
  const fence = await agent.send({
    project_path: project,
    subject: 'An inline page',
    body: ['The page:', '', '```html', MOCK('Inline', 1).replace(/^<!doctype html>/, ''), '```'].join('\n'),
  });
  return { root, url, agent, thread: question.thread_id as string, fenceThread: fence.thread_id as string, ids };
}

test('in the prototype window a page navigates as in a tab: its ?query switcher, hover, a GET form, a # route, another option', async ({ browser }) => {
  const { root, url, agent, thread } = await world();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    const page = await context.newPage();
    await page.goto(`${url}#thread=${thread}`);
    await page.locator('[data-try-prototype]').first().click();
    const win = page.locator('[data-prototype-window]');
    await expect(win).toBeVisible();
    const frame = page.frameLocator('[data-prototype-window] iframe');
    // It opens on the recommended option's page, with no query.
    await expect(frame.locator('#title')).toHaveText('Unfold: variant 3');
    await expect(frame.locator('#search')).toHaveText('(none)');
    await shot(page, '1-window-opened');

    // Hover: the page's own :hover style applies.
    await frame.locator('#pile').hover();
    await expect(frame.locator('#pile')).toHaveCSS('background-color', 'rgb(79, 107, 237)');

    // The switcher in its bottom right corner is the page's: the window's own controls never cover it.
    const two = frame.getByRole('link', { name: '2', exact: true });
    const box = (await two.boundingBox())!;
    expect(await page.evaluate(([x, y]) => document.elementFromPoint(x!, y!)?.tagName, [box.x + box.width / 2, box.y + box.height / 2])).toBe('IFRAME');

    // `?variant=2`: the same page again, with the query its script reads. No entry in the window's history.
    const entries = await page.evaluate(() => history.length);
    await two.click();
    await expect(frame.locator('#title')).toHaveText('Unfold: variant 2');
    await expect(frame.locator('#search')).toHaveText('?variant=2');
    expect(await page.evaluate(() => history.length)).toBe(entries);
    await expect(page.locator('[data-prototype-caption]')).toHaveAttribute('data-prototype-caption', 'B');
    await shot(page, '2-variant-2');

    // A GET form: the page again with its fields as the query.
    await frame.locator('#go').click();
    await expect(frame.locator('#search')).toHaveText('?who=ada');

    // A # link the page routes on: its hashchange fires.
    await frame.locator('#next-step').click();
    await expect(frame.locator('#step')).toHaveText('2');

    // A link to another option's page steps the window to that option.
    await frame.locator('#other').click();
    await expect(page.locator('[data-prototype-caption]')).toHaveAttribute('data-prototype-caption', 'A');
    await expect(frame.locator('#title')).toHaveText('Names: variant 1');
    await shot(page, '3-other-option');
    await context.close();
  } finally {
    await agent.close().catch(() => {});
    await removeInboxScratch(root);
  }
});

test("an attached page's ?query link, in the file viewer and in an html fence, loads the page again with that query", async ({ browser }) => {
  const { root, url, agent, thread, fenceThread, ids } = await world();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    const page = await context.newPage();
    // The file viewer: the attached page from its tile (full screen, Annotate on: a plain click on a link follows it).
    await page.goto(`${url}#thread=${thread}`);
    await page.locator(`button[data-attachment-id="${ids['3-unfold.html']}"]`).first().click();
    const viewer = page.frameLocator('.ib-htmlframe iframe');
    await expect(viewer.locator('#title')).toHaveText('Unfold: variant 3');
    await viewer.getByRole('link', { name: '2', exact: true }).click();
    await expect(viewer.locator('#title')).toHaveText('Unfold: variant 2');
    await expect(viewer.locator('#search')).toHaveText('?variant=2');
    await shot(page, '4-viewer-variant-2');

    // The html fence in a message.
    await page.goto(`${url}#thread=${fenceThread}`);
    const fence = page.frameLocator('iframe[src*="/api/inbox/embeds/"]');
    await expect(fence.locator('#title')).toHaveText('Inline: variant 1');
    await fence.getByRole('link', { name: '2', exact: true }).click();
    await expect(fence.locator('#title')).toHaveText('Inline: variant 2');
    await expect(fence.locator('#search')).toHaveText('?variant=2');
    await shot(page, '5-fence-variant-2');
    await context.close();
  } finally {
    await agent.close().catch(() => {});
    await removeInboxScratch(root);
  }
});
