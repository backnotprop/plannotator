/**
 * A thread's links: the Links side of the Artifacts view, proved in a real
 * browser against the compiled binary under a temp data dir and scratch HOME,
 * with a scripted `gh` and `glab` (never the real ones).
 *
 * - The thread's bar has the shapes and nothing new, in every state.
 * - The view's header: the way back and an Artifacts / Links switch.
 * - The list: repositories then other links; a PR or an issue shows its state
 *   in its icon, neutral until it answers or if it cannot; only the rows on
 *   screen ask; a bare `#1290` takes the forge's title.
 * - Links and no artifacts: the shapes open on Links. Neither: no button.
 * - 40 links, long urls and non-Latin titles do not overflow, desktop and phone.
 *
 * Build the binary first (see inbox.spec.ts), then
 * `bunx playwright test -c tests/e2e/playwright.config.ts inbox-thread-links.spec.ts`.
 * PNGs land in PLANNOTATOR_E2E_SHOTS_DIR (default .local/proof/thread-links).
 */

import { devices, expect, test, webkit, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';
import { fakeForge, type FakeForge } from './fake-forge';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const shotsDir = resolve(process.env.PLANNOTATOR_E2E_SHOTS_DIR ?? join(repo, '.local/proof/thread-links'));

interface World {
  url: string;
  agents: SimAgent[];
  forge: FakeForge;
  mixed: string;
  one: string;
  many: string;
  linksOnly: string;
  lookalike: string;
  noLinks: string;
  noLinksFiles: string;
}
let world: World;

/** A host whose start looks like GitHub; its real domain is its end. */
const LOOKALIKE_HOST = 'github.com.acme-web-pull-5-secure-login-verify-your-account-now.evil.example';
const LOOKALIKE = `https://${LOOKALIKE_HOST}/acme/web/pull/5`;

const ago = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();

/** GitHub's answer for a pull request, as much as the hover card's query asks. */
function pull(number: number, title: string, state: 'OPEN' | 'MERGED' | 'CLOSED', isDraft = false): unknown {
  return {
    data: {
      repository: {
        nameWithOwner: 'acme/web',
        issueOrPullRequest: {
          __typename: 'PullRequest',
          number,
          url: `https://github.com/acme/web/pull/${number}`,
          title,
          state,
          isDraft,
          createdAt: ago(24),
          updatedAt: ago(1),
          closedAt: state === 'OPEN' ? null : ago(1),
          mergedAt: state === 'MERGED' ? ago(1) : null,
          author: { login: 'dana', avatarUrl: null },
          labels: { nodes: [{ name: 'checkout', color: 'a2eeef' }] },
          assignees: { nodes: [] },
          comments: { totalCount: 0, nodes: [] },
          baseRefName: 'main',
          headRefName: 'feat/drawer-flag',
          additions: 212,
          deletions: 48,
          changedFiles: 9,
          reviewDecision: null,
          body: 'The three checkout pages become one drawer, behind a flag.',
          closingIssuesReferences: { nodes: [] },
          commits: { nodes: [] },
        },
      },
    },
  };
}

/** GitHub's answer for an issue. */
function issue(number: number, title: string, state: 'OPEN' | 'CLOSED', stateReason: 'COMPLETED' | 'NOT_PLANNED' | null = null): unknown {
  return {
    data: {
      repository: {
        nameWithOwner: 'acme/web',
        issueOrPullRequest: {
          __typename: 'Issue',
          number,
          url: `https://github.com/acme/web/issues/${number}`,
          title,
          state,
          stateReason,
          createdAt: ago(80),
          updatedAt: ago(3),
          closedAt: state === 'OPEN' ? null : ago(3),
          body: 'The total is a cent out on some carts.',
          author: { login: 'sam', avatarUrl: null },
          labels: { nodes: [] },
          assignees: { nodes: [] },
          comments: { totalCount: 0, nodes: [] },
          closedByPullRequestsReferences: { nodes: [] },
        },
      },
    },
  };
}

function screen(title: string, accent: string): string {
  return `<!doctype html><meta charset="utf-8"><style>body{margin:0;font:15px system-ui;background:#f4f3ef;color:#18181b}header{padding:14px 22px;background:#fff;border-bottom:1px solid #e4e4e7;font-weight:600}main{max-width:520px;margin:32px auto;background:#fff;border-radius:12px;padding:24px;box-shadow:0 1px 3px #0001}.f{border:1px solid #d4d4d8;border-radius:8px;padding:10px;margin:8px 0;color:#71717a}button{width:100%;padding:13px;border:0;border-radius:9px;background:${accent};color:#fff;font:600 15px system-ui;margin-top:10px}</style><header>Plantshop · ${title}</header><main><div class="f">Linen overshirt · $48</div><div class="f">Canvas tote · $48</div><button>Pay now</button></main>`;
}

async function png(browser: Browser, html: string): Promise<Buffer> {
  const maker = await browser.newContext({ viewport: { width: 1200, height: 760 } });
  const page = await maker.newPage();
  await page.setContent(html);
  const bytes = await page.screenshot();
  await maker.close();
  return bytes;
}

/** 40 links in one thread: every kind, three forges, long urls, odd titles, repeats, code. */
const MANY = [
  'A big audit of the checkout work. The pull requests:',
  '',
  '- [Move the drawer behind a flag](https://github.com/acme/web/pull/1412)',
  '- [Sticky Pay button on phones](https://github.com/acme/web/pull/1398)',
  '- https://github.com/acme/web/pull/1377',
  '- [Rounding in the cart total](https://github.com/acme/web/issues/1290)',
  '- https://github.com/acme/web/issues/1288',
  '- [A very long issue title that goes on and on about why the tax line jumps when the shipping country changes on a slow connection, and it keeps going so we can see how a row cuts it](https://github.com/acme/web/issues/1276)',
  '- [修复购物车在日本地区的税额显示问题](https://github.com/acme/web/issues/1270)',
  '- [إصلاح اتجاه النص في صفحة الدفع](https://github.com/acme/web/pull/1265)',
  '',
  'Files: https://github.com/acme/web/blob/main/src/checkout/drawer/PayButton.tsx#L88 and https://github.com/acme/web/blob/main/src/cart/total.ts#L42 and https://github.com/acme/web/blob/main/packages/design-system/src/components/overlays/drawer/internal/useDrawerFocusTrap.test.tsx and https://github.com/acme/web/blob/main/README.md',
  '',
  'Commits: https://github.com/acme/web/commit/3f2a1bc9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3 and [Move tax into the drawer](https://github.com/acme/web/commit/9c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d)',
  '',
  'CI: https://github.com/acme/web/actions/runs/118822 and https://github.com/acme/web/releases/tag/v4.2.0 and https://github.com/acme/web/tree/feat/drawer/src/checkout',
  '',
  'In the API: [Idempotent charges](https://github.com/acme/api/pull/77), https://github.com/acme/api/issues/70 and https://github.com/acme/api/blob/main/db/migrations/0042_checkout_sessions.sql',
  '',
  'And the repo itself: https://github.com/acme/design-tokens',
  '',
  'On the company GitHub: https://github.acme.dev/payments/ledger/pull/5120 and https://github.acme.dev/payments/ledger/issues/5101',
  '',
  'On GitLab: https://gitlab.com/harbor/platform/tooling/-/merge_requests/231 and https://gitlab.com/harbor/platform/tooling/-/issues/88 and https://gitlab.com/harbor/platform/tooling/-/blob/main/ci/deploy.yml',
  '',
  'Self-hosted, name says nothing: https://git.harbor.dev/ops/runbooks/pull/14',
  '',
  'Reading:',
  '',
  '- [Payment Element](https://docs.stripe.com/payments/payment-element)',
  '- [Webhooks](https://docs.stripe.com/webhooks)',
  '- https://developer.mozilla.org/en-US/docs/Web/CSS/position#sticky',
  '- [Checkout mocks](https://www.figma.com/file/aB3dE5/Checkout?node-id=12-44&mode=design)',
  '- [料金プランの比較](https://shop.example.jp/%E6%96%99%E9%87%91/%E6%AF%94%E8%BC%83)',
  '- https://analytics.example.com/reports/checkout/funnel/2026-10/segments/mobile/countries/japan/steps/payment?compare=previous-period&granularity=hour&filter=abandoned&utm_source=inbox&utm_campaign=review',
  '- https://en.wikipedia.org/wiki/Function_(mathematics)',
  '- [Lighthouse run](https://lighthouse.example.net/r/8841)',
  '- [Status](https://status.example.com)',
  '- http://localhost:3000/checkout?drawer=1',
  '- [Thread on the rounding](https://forum.example.org/t/rounding-in-carts/9912)',
  '- [Runbook](https://wiki.harbor.dev/payments/runbook)',
  '- [Design notes](https://notes.example.com/d/77)',
  '',
  'Repeats show once: https://github.com/acme/web/pull/1412/files and https://github.com/acme/web/pull/1398#issuecomment-991',
  '',
  '```sh',
  'curl https://in-a-code-block.example.com/never-listed',
  '```',
  '',
  'And `https://in-a-code-span.example.com` neither.',
].join('\n');

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  mkdirSync(shotsDir, { recursive: true });
  const root = inboxScratch('plannotator-thread-links-');
  const dataDir = join(root, 'data');
  const home = join(root, 'home');
  const trap = join(root, 'trap');
  // The states, and the hover card, ask `gh` and `glab`: scripted ones, never the real ones.
  const forge = fakeForge(join(root, 'bin'));
  forge.github(1412, pull(1412, 'Move the drawer behind a flag', 'MERGED'));
  forge.github(1398, pull(1398, 'Sticky Pay button on phones', 'OPEN'));
  forge.github(1377, pull(1377, 'Tax line in the drawer', 'OPEN', true));
  forge.github(1290, issue(1290, 'Rounding in the cart total', 'CLOSED', 'COMPLETED'));
  forge.github(1288, issue(1288, 'Shipping estimate blank in Safari', 'OPEN'));
  forge.github(1270, issue(1270, '修复购物车在日本地区的税额显示问题', 'CLOSED', 'NOT_PLANNED'));
  forge.github(77, pull(77, 'Idempotent charges', 'CLOSED'));
  forge.github(70, issue(70, 'Charges retried twice', 'OPEN'));
  forge.github(901, pull(901, 'Rework the receipts page', 'MERGED'));
  forge.github(902, issue(902, 'Receipts lose the tax line', 'OPEN'));
  forge.gitlab('mr', 231, {
    data: {
      project: {
        fullPath: 'harbor/platform/tooling',
        mergeRequest: {
          iid: '231',
          title: 'Cache the build layers',
          webUrl: 'https://gitlab.com/harbor/platform/tooling/-/merge_requests/231',
          state: 'merged',
          draft: false,
          createdAt: ago(30),
          updatedAt: ago(1),
          closedAt: null,
          mergedAt: ago(1),
          description: 'Reuses the dependency layer between pipelines.',
          author: { username: 'lin', avatarUrl: null },
          labels: { nodes: [] },
          assignees: { nodes: [] },
          userNotesCount: 0,
          notes: { nodes: [] },
          sourceBranch: 'ci/layer-cache',
          targetBranch: 'main',
          diffStatsSummary: { additions: 48, deletions: 9, fileCount: 3 },
          approved: true,
          detailedMergeStatus: 'MERGED',
          headPipeline: null,
        },
      },
    },
  });
  mkdirSync(home);
  mkdirSync(trap);
  writeFileSync(join(trap, 'tailscale'), '#!/bin/sh\necho "thread-links: tailscale must not run" >&2\nexit 97\n');
  chmodSync(join(trap, 'tailscale'), 0o755);
  const env = {
    PATH: `${forge.dir}:${trap}:${process.env.PATH ?? ''}`,
    HOME: home,
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9',
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
    PLANNOTATOR_INBOX_NOTES: '0',
    PLANNOTATOR_TEST_SANDBOX: '1',
    NO_ANON_PING: '1',
    NO_BROWSER,
    PLANNOTATOR_BROWSER: '/usr/bin/true',
  };
  // The Inbox's PATH finds the scripted CLIs first: the real ones are never reached.
  for (const cli of ['gh', 'glab']) {
    const found = spawnSync('sh', ['-c', `command -v ${cli}`], { env, encoding: 'utf8' });
    expect(found.stdout.trim()).toBe(join(forge.dir, cli));
  }
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const url = started.stdout.trim();

  const project = scratchProject(join(root, 'src'), 'checkout-web');
  spawnSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/web.git'], { cwd: project, env: { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  for (const dir of ['design', 'docs']) mkdirSync(join(project, dir));
  writeFileSync(join(project, 'design', 'checkout-after.png'), await png(browser, screen('Checkout · drawer', '#4f46e5')));
  writeFileSync(join(project, 'design', 'checkout-before.png'), await png(browser, screen('Checkout · today', '#71717a')));
  writeFileSync(join(project, 'docs', 'checkout-spec.md'), '# Checkout in one drawer\n\nThe three checkout pages become one drawer over the cart.\n\n## Steps\n\n1. Shipping\n2. Payment\n3. Review and pay\n');
  writeFileSync(join(project, 'design', 'drawer.html'), '<!doctype html><title>Drawer</title><h1>Checkout drawer</h1><p>Prototype.</p>');

  // One session writes one thread.
  const agents: SimAgent[] = [];
  const session = async () => {
    const agent = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
    agents.push(agent);
    return agent;
  };
  const claude = await session();
  const id = (r: any) => (r.message?.id ?? r.message_id) as string;
  const first = await claude.send({
    project_path: project,
    subject: 'Checkout in one drawer',
    body: "Here's the first pass. The spec and a prototype are attached, and the work is up in [Move the drawer behind a flag](https://github.com/acme/web/pull/1412).\n\n![The drawer](design/checkout-after.png)\n\nIt closes #1290 and builds on acme/api#77. The Stripe side follows [Payment Element](https://docs.stripe.com/payments/payment-element).",
    attachments: ['docs/checkout-spec.md', 'design/drawer.html'],
  });
  await claude.send({
    project_path: project,
    reply_to: id(first),
    body: 'Pay button is sticky now: https://github.com/acme/web/blob/main/src/checkout/drawer/PayButton.tsx#L88 in [Sticky Pay button on phones](https://github.com/acme/web/pull/1398). The rounding fix is https://github.com/acme/web/commit/3f2a1bc9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3.\n\nThe mocks: [Checkout mocks](https://www.figma.com/file/aB3dE5/Checkout?node-id=12-44). Lighthouse: https://lighthouse.example.net/r/8841.',
    attachments: ['design/checkout-before.png'],
  });
  await claude.send({
    project_path: project,
    reply_to: id(first),
    body: 'Merged https://github.com/acme/web/pull/1412 and opened [Idempotent charges](https://github.com/acme/api/pull/77). One follow-up in the ledger: https://github.acme.dev/payments/ledger/pull/5120.',
  });
  const one = await (await session()).send({ project_path: project, subject: 'Release notes drafted', body: 'The notes for 4.2 are up: https://github.com/acme/web/releases/tag/v4.2.0' });
  const many = await (await session()).send({ project_path: project, subject: 'Everything the checkout audit touched', body: MANY });
  const linksOnly = await (await session()).send({
    project_path: project,
    subject: 'Receipts: where it stands',
    body: 'Merged https://github.com/acme/web/pull/901, and https://github.com/acme/web/issues/902 is still open. Background in [the tax guide](https://docs.stripe.com/tax) and [the old receipts thread](https://forum.example.org/t/receipts/120).',
  });
  const lookalike = await (await session()).send({
    project_path: project,
    subject: 'Login link from a stranger',
    body: `The repo https://github.com/acme/web, its ${'https://github.com/acme/web/pull/1398'}, and a look-alike: [Sign in again](${LOOKALIKE}).`,
  });
  const noLinks = await (await session()).send({ project_path: project, subject: 'Nothing to look at yet', body: 'Still working on it. No files and no links in this one, and `https://only-code.example.com` is code.' });
  const noLinksFiles = await (await session()).send({ project_path: project, subject: 'The spec, no links', body: 'The spec, on its own.', attachments: ['docs/checkout-spec.md', 'design/checkout-before.png'] });
  world = { url, agents, forge, mixed: first.thread_id as string, one: one.thread_id as string, many: many.thread_id as string, linksOnly: linksOnly.thread_id as string, lookalike: lookalike.thread_id as string, noLinks: noLinks.thread_id as string, noLinksFiles: noLinksFiles.thread_id as string };
});

test.afterAll(async () => {
  try {
    for (const agent of world?.agents ?? []) await agent.close().catch(() => {});
  } finally {
    await removeInboxScratch();
  }
});

async function shot(page: Page, name: string, options: { reload?: boolean } = {}): Promise<void> {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    if (options.reload) await page.reload();
    await page.waitForTimeout(1200);
    await page.screenshot({ path: join(shotsDir, `${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
}

const artifactsButton = (page: Page) => page.locator('[data-artifacts-button]');
const side = (page: Page, name: 'Artifacts' | 'Links') => page.locator(`[data-artifacts-side="${name}"]`);
const chosen = async (page: Page, name: 'Artifacts' | 'Links') => expect(side(page, name)).toHaveAttribute('aria-pressed', 'true');
const rows = (page: Page) => page.locator('[data-links-view] [data-thread-link]');
const rowOf = (page: Page, href: string) => page.locator(`[data-links-view] [data-thread-link][href="${href}"]`);
const stateOf = (page: Page, href: string) => rowOf(page, href).locator('svg.ib-refmark');
const open = async (page: Page, thread: string, suffix = '') => {
  await page.goto(`${world.url}#thread=${thread}${suffix}`);
  await expect(page.locator('section.ib-pane')).toBeVisible();
  await page.waitForTimeout(400);
};
/** The bar's buttons in order: the thread's bar is the same with or without links. */
const barButtons = (page: Page) =>
  page.locator('section.ib-pane .ib-phead').evaluate((bar) => [...bar.querySelectorAll('button')].map((b) => b.getAttribute('aria-label') ?? b.textContent ?? ''));
/** The pane's markup with what differs run to run taken out, to compare a closed thread against a build of main. */
const dumpPane = async (page: Page, name: string) => {
  const dir = process.env.PLANNOTATOR_THREAD_LINKS_DUMP;
  if (!dir) return;
  await page.waitForTimeout(1200);
  const html = await page.locator('section.ib-pane').evaluate((el) => el.outerHTML);
  const clean = html
    .replace(/\b(thr|msg|att|ses|ini|img)_[A-Za-z0-9]+/g, '$1_X')
    .replace(/\b\d{1,2}:\d{2} [AP]M\b/g, 'TIME')
    .replace(/\b(base-ui|_r_|«r)[^"\s]*/g, 'RID')
    .replace(/\/(private\/)?(var|tmp)\/[^"<\s]*/g, 'PATH')
    .replace(/></g, '>\n<');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.html`), clean);
};
/** Nothing runs past the screen's right edge. */
const noOverflow = async (page: Page) => {
  const over = await page.locator('[data-links-view]').evaluate((view) => {
    const box = view.getBoundingClientRect();
    return [...view.querySelectorAll('a, span, bdi, h3')].filter((el) => el.getBoundingClientRect().right > box.right + 9).length;
  });
  expect(over).toBe(0);
};
const PR = (n: number) => `https://github.com/acme/web/pull/${n}`;
const ISSUE = (n: number) => `https://github.com/acme/web/issues/${n}`;

test('closed threads, as on main (markup compared against a build of main)', async ({ browser }: { browser: Browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  const page = await context.newPage();
  await open(page, world.mixed);
  await dumpPane(page, 'desktop-mixed-closed');
  await open(page, world.noLinksFiles);
  await dumpPane(page, 'desktop-closed');
  await open(page, world.noLinks);
  await dumpPane(page, 'desktop-empty-closed');
  await context.close();
});

test.describe('desktop', () => {
  let context: BrowserContext;
  let page: Page;
  test.beforeAll(async ({ browser }: { browser: Browser }) => {
    context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
    page = await context.newPage();
  });
  test.afterAll(async () => context.close());

  test('only the rows on screen ask; the others ask when they come near', async ({ browser }: { browser: Browser }) => {
    const short = await browser.newContext({ viewport: { width: 1280, height: 420 }, colorScheme: 'light' });
    const p = await short.newPage();
    await open(p, world.many, '&artifacts&links');
    await expect(stateOf(p, PR(1412))).toHaveAttribute('data-ref-state', 'merged');
    await p.waitForTimeout(1500);
    // acme/api is far below this short window, and so is its #70, which nothing else in this file has asked for.
    expect(world.forge.calls()).toContain('gh number=1412');
    expect(world.forge.calls()).not.toContain('gh number=70');
    const body = p.locator('section.ib-pane .ib-artbody').first();
    await body.evaluate((el) => el.scrollTo(0, el.scrollHeight));
    await p.waitForTimeout(300);
    await rowOf(p, 'https://github.com/acme/api/issues/70').scrollIntoViewIfNeeded();
    await expect.poll(() => world.forge.calls()).toContain('gh number=70');
    await short.close();
  });

  test('the bar has the shapes; the view has the switch; the states are in the icons', async () => {
    await open(page, world.mixed);
    const closedBar = await barButtons(page);
    expect(closedBar.filter((name) => /artifacts/i.test(name))).toHaveLength(1);
    expect(closedBar.filter((name) => /link/i.test(name))).toEqual([]);
    await expect(page.locator('[data-artifacts-switch]')).toHaveCount(0);
    await shot(page, '01-header');

    await artifactsButton(page).click();
    await expect(page.locator('[data-artifact-tile]').first()).toBeVisible();
    await expect(artifactsButton(page)).toHaveAttribute('aria-pressed', 'true');
    await chosen(page, 'Artifacts');
    await expect(page.locator('[data-artifacts-view] h2')).toBeFocused();
    await expect(page.locator('[data-artifacts-summary]')).toHaveCount(0);
    // Nothing new in the bar with the view open.
    expect((await barButtons(page)).filter((name) => /link/i.test(name))).toEqual([]);
    await page.mouse.move(10, 700);
    await shot(page, '02-artifacts');

    await side(page, 'Links').click();
    await expect(page.locator('[data-links-view]')).toBeVisible();
    await expect(page.locator('[data-artifacts-view]')).toBeHidden();
    await expect(page).toHaveURL(/&artifacts&links$/);
    await chosen(page, 'Links');
    await expect(artifactsButton(page)).toHaveAttribute('aria-pressed', 'true');

    // The state, from the scripted gh, in each icon's shape and colour.
    await expect(stateOf(page, PR(1412))).toHaveAttribute('data-ref-state', 'merged');
    await expect(stateOf(page, PR(1398))).toHaveAttribute('data-ref-state', 'open');
    await expect(stateOf(page, ISSUE(1290))).toHaveAttribute('data-ref-state', 'completed');
    await expect(stateOf(page, 'https://github.com/acme/api/pull/77')).toHaveAttribute('data-ref-state', 'closed');
    const colours = () =>
      page.evaluate(
        (hrefs) => hrefs.map((href) => getComputedStyle(document.querySelector(`[data-thread-link][href="${href}"] svg.ib-refmark`)!).color),
        [PR(1412), PR(1398), 'https://github.com/acme/api/pull/77'],
      );
    await expect.poll(async () => new Set(await colours()).size, { message: 'merged, open and closed: three colours' }).toBe(3);
    // A bare `#1290` takes the forge's title, and the words a message wrote stay.
    await expect(rowOf(page, ISSUE(1290))).toContainText('#1290');
    await expect(rowOf(page, ISSUE(1290))).toContainText('Rounding in the cart total');
    // A host this computer is not signed in to: neutral, and nothing ran for it.
    await expect(stateOf(page, 'https://github.acme.dev/payments/ledger/pull/5120')).toHaveAttribute('data-ref-state', 'unknown');
    expect(world.forge.calls().filter((call) => call.includes('5120'))).toEqual([]);
    await page.mouse.move(10, 700);
    await shot(page, '03-links');

    // Duplicates once: #1412 is linked three times, #1290 is a bare ref, acme/api#77 a cross-repo ref with a written url.
    await expect(page.locator('[data-link-repo="acme/web"] [data-thread-link]')).toHaveCount(5);
    await expect(page.locator('[data-link-repo="acme/api"] [data-thread-link]')).toHaveCount(1);

    // A reload stays on this side.
    await page.reload();
    await expect(page.locator('[data-links-view]')).toBeVisible();

    // A link opens in a new tab, like a link in a message.
    const first = rows(page).first();
    await expect(first).toHaveAttribute('target', '_blank');
    await expect(first).toHaveAttribute('rel', /noopener/);

    // Back and forth, then each way back to the thread: from either side, focus on the shapes.
    await side(page, 'Artifacts').click();
    await expect(page.locator('[data-artifacts-view]')).toBeVisible();
    await expect(page.locator('[data-links-view]')).toHaveCount(0);
    await side(page, 'Links').click();
    await artifactsButton(page).click();
    await expect(page.locator('[data-links-view]')).toHaveCount(0);
    await expect(artifactsButton(page)).toBeFocused();
    await expect(page).toHaveURL(new RegExp(`#thread=${world.mixed}$`));
    await artifactsButton(page).click();
    await page.locator('[data-artifacts-back]').click();
    await expect(page.locator('[data-artifacts-view]')).toHaveCount(0);
    await expect(artifactsButton(page)).toBeFocused();
    await artifactsButton(page).click();
    await side(page, 'Links').click();
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-links-view]')).toHaveCount(0);
    await expect(artifactsButton(page)).toBeFocused();
    // The shapes open on Artifacts again.
    await artifactsButton(page).click();
    await chosen(page, 'Artifacts');
    await page.keyboard.press('Escape');
  });

  test('the label waits for the artifacts: no "Links" that turns into the toggle', async ({ browser }: { browser: Browser }) => {
    // A page of its own: the thread's files are read on its first draw, held here until released.
    const fresh = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
    const p = await fresh.newPage();
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let asked = false;
    await p.route(/\/api\/inbox\/threads\/[^/]+\/attachments/, async (route) => {
      asked = true;
      await held;
      await route.continue();
    });
    try {
      await p.goto(`${world.url}#thread=${world.mixed}&artifacts`);
      await expect(p.locator('[data-artifacts-view] [aria-busy="true"]')).toBeVisible();
      expect(asked).toBe(true);
      await p.waitForTimeout(600);
      await expect(p.locator('[data-artifacts-switch-one]')).toHaveCount(0);
      await expect(p.locator('[data-artifacts-switch]')).toHaveCount(0);
    } finally {
      release();
    }
    await expect(p.locator('[data-artifacts-switch]')).toBeVisible();
    await chosen(p, 'Artifacts');
    await fresh.close();
  });

  test('the hidden grid keeps its previews while Links shows', async () => {
    await open(page, world.mixed, '&artifacts');
    const previews = page.locator('[data-artifacts-view] img');
    await expect(previews).toHaveCount(2);
    await side(page, 'Links').click();
    await expect(page.locator('[data-links-view]')).toBeVisible();
    await page.waitForTimeout(800);
    await expect(previews).toHaveCount(2);
  });

  test('"Links N" is what the list shows; a look-alike host keeps its real domain in sight', async () => {
    for (const thread of [world.mixed, world.many]) {
      await open(page, thread, '&artifacts&links');
      await expect(rows(page).first()).toBeVisible();
      const label = await page.locator('[data-artifacts-side="Links"] .ib-artswitch-n, [data-artifacts-switch-one] .ib-artswitch-n').first().textContent();
      expect(Number(label)).toBe(await page.locator('[data-links-view] [data-thread-link]').count());
    }
    // A repository linked on its own and through one of its PRs: one row, and the count says one.
    await open(page, world.lookalike);
    await artifactsButton(page).click();
    await expect(page.locator('[data-artifacts-switch-one]')).toHaveText('Links2');
    await expect(page.locator('[data-links-view] [data-thread-link]')).toHaveCount(2);

    // The host is cut from its start: its end, the real domain, is on screen.
    const tail = page.locator('[data-links-view] [data-link-tail]').filter({ hasText: 'evil.example' });
    const ends = await tail.evaluate((el) => {
      const text = el.querySelector('bdi')!.firstChild as Text;
      const box = el.getBoundingClientRect();
      const at = (i: number) => {
        const range = document.createRange();
        range.setStart(text, i);
        range.setEnd(text, i + 1);
        return range.getBoundingClientRect();
      };
      const last = at(text.length - 1);
      const first = at(0);
      return { cut: el.scrollWidth > el.clientWidth + 1, lastIn: last.left >= box.left - 1 && last.right <= box.right + 1, firstIn: first.left >= box.left - 1 };
    });
    expect(ends).toEqual({ cut: true, lastIn: true, firstIn: false });
    // Cut, so its whole address is the tooltip.
    await tail.hover();
    await expect(page.locator('[data-pn-tooltip]').filter({ hasText: LOOKALIKE })).toBeVisible();
    await page.mouse.move(10, 700);
    await shot(page, '11-lookalike');
  });

  test('a PR row has the hover card, over the scripted gh', async () => {
    await open(page, world.mixed, '&artifacts&links');
    await rowOf(page, PR(1412)).hover();
    await expect(page.getByText('feat/drawer-flag').or(page.getByText('dana')).first()).toBeVisible();
    await page.mouse.move(10, 700);
  });

  test('links and no artifacts: the shapes, opening on Links', async () => {
    await open(page, world.linksOnly);
    await expect(artifactsButton(page)).toBeVisible();
    await expect(artifactsButton(page)).toContainText('4');
    expect((await barButtons(page)).filter((name) => /artifacts, 0/i.test(name))).toEqual([]);
    await shot(page, '05-links-only-header');
    await artifactsButton(page).click();
    await expect(page.locator('[data-links-view]')).toBeVisible();
    await expect(page.locator('[data-artifacts-switch]')).toHaveCount(0);
    await expect(page.locator('[data-artifacts-switch-one]')).toHaveText('Links4');
    await expect(stateOf(page, PR(901))).toHaveAttribute('data-ref-state', 'merged');
    await expect(stateOf(page, ISSUE(902))).toHaveAttribute('data-ref-state', 'open');
    await page.mouse.move(10, 700);
    await shot(page, '06-links-only');
    await artifactsButton(page).click();
    await expect(page.locator('[data-links-view]')).toHaveCount(0);
    await expect(artifactsButton(page)).toBeFocused();
    // One link, no state to read.
    await open(page, world.one);
    await artifactsButton(page).click();
    await expect(rows(page)).toHaveCount(1);
    await page.mouse.move(10, 700);
    await shot(page, '07-one-link');
  });

  test('forty links, long urls, odd titles: nothing listed from code, nothing overflows', async () => {
    await open(page, world.many, '&artifacts&links');
    await expect(page.locator('[data-links-view]')).toBeVisible();
    await expect(stateOf(page, PR(1377))).toHaveAttribute('data-ref-state', 'draft');
    await expect(stateOf(page, ISSUE(1270))).toHaveAttribute('data-ref-state', 'not_planned');
    // gh does not know this one: the same shape, neutral.
    await expect(stateOf(page, ISSUE(1276))).toHaveAttribute('data-ref-state', 'unknown');
    await page.mouse.move(10, 700);
    await shot(page, '04-forty');
    await noOverflow(page);
    const all = await rows(page).evaluateAll((els) => els.map((el) => el.getAttribute('href')!));
    expect(all.some((h) => h.includes('in-a-code'))).toBe(false);
    expect(new Set(all).size).toBe(all.length);
    await page.locator('section.ib-pane .ib-artbody').first().evaluate((el) => el.scrollTo(0, el.scrollHeight));
    await page.waitForTimeout(300);
    // GitLab's state and title, over the scripted glab.
    const mr = rowOf(page, 'https://gitlab.com/harbor/platform/tooling/-/merge_requests/231');
    await expect(mr.locator('svg.ib-refmark')).toHaveAttribute('data-ref-state', 'merged');
    await expect(mr).toContainText('Cache the build layers');
    expect(world.forge.calls()).toContain('glab mr iid=231');
    await page.mouse.move(10, 700);
    await shot(page, '04-forty-end');
    await noOverflow(page);
  });

  test('no links: the shapes, the same grid, its name above it; neither: no button', async () => {
    await open(page, world.noLinksFiles);
    await expect(artifactsButton(page)).toBeVisible();
    await artifactsButton(page).click();
    await expect(page.locator('[data-artifact-tile]').first()).toBeVisible();
    await expect(page.locator('[data-artifacts-switch]')).toHaveCount(0);
    await expect(page.locator('[data-artifacts-switch-one]')).toHaveText(/^Artifacts\d+$/);
    await page.mouse.move(10, 700);
    await shot(page, '08-no-links');
    // `&links` on a thread with no links is the artifacts.
    await open(page, world.noLinksFiles, '&artifacts&links');
    await expect(page.locator('[data-artifacts-view]')).toBeVisible();
    await expect(page.locator('[data-links-view]')).toHaveCount(0);
    await open(page, world.noLinks);
    await expect(artifactsButton(page)).toHaveCount(0);
  });
});

test('the row in a full-screen thread and beside a file', async ({ browser }: { browser: Browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  const page = await context.newPage();
  const pane = page.locator('section.ib-pane');
  /** The row sits inside the pane, its chevron's glyph over the left edge of what is under it. */
  const rowFits = async (under: string) => {
    // Polled: the pane animates its width on the way into full screen.
    await expect
      .poll(async () => {
        const glyph = (await page.locator('[data-artifacts-back] svg').boundingBox())!;
        const first = (await page.locator(under).first().boundingBox())!;
        return Math.abs(glyph.x - first.x);
      })
      .toBeLessThanOrEqual(4);
    const box = (await pane.boundingBox())!;
    const row = (await page.locator('[data-artifacts-switch]').boundingBox())!;
    expect(row.x + row.width).toBeLessThanOrEqual(box.x + box.width);
  };

  // The mouse rests in the pane: at the window's left edge a full-screen thread peeks the sidebar.
  await open(page, world.mixed, '&artifacts');
  await pane.locator('[data-full-in]').click();
  await expect(pane).toHaveAttribute('data-full', /.*/);
  await expect(page.locator('[data-artifact-tile]').first()).toBeVisible();
  await page.mouse.move(900, 700);
  await rowFits('[data-artifact-tile]');
  await shot(page, '09-full-screen-artifacts');
  await side(page, 'Links').click();
  await expect(rows(page).first()).toBeVisible();
  await page.mouse.move(900, 700);
  await rowFits('[data-links-view] [data-link-repo]');
  await shot(page, '09-full-screen-links');
  await pane.locator('[data-full-back]').click();

  await side(page, 'Artifacts').click();
  await page.locator('[data-artifact-tile]', { hasText: 'checkout-spec.md' }).click();
  await page.getByRole('button', { name: 'Side by side' }).click();
  await expect(page.locator('section.ib-pane.ib-withfile')).toBeVisible();
  await expect(page.locator('[data-artifacts-bar]')).toBeVisible();
  await page.mouse.move(900, 700);
  await rowFits('[data-artifact-tile]');
  await shot(page, '10-side-by-side-artifacts');
  await side(page, 'Links').click();
  await expect(rows(page).first()).toBeVisible();
  await expect(page.locator('section.ib-pane.ib-withfile')).toBeVisible();
  await page.mouse.move(900, 700);
  await rowFits('[data-links-view] [data-link-repo]');
  await noOverflow(page);
  await shot(page, '10-side-by-side-links');
  await context.close();
});

test.describe('phone', () => {
  let own: Browser | undefined;
  let context: BrowserContext;
  let page: Page;
  test.beforeAll(async () => {
    own = await webkit.launch();
    context = await own.newContext({ ...devices['iPhone 15'], viewport: { width: 390, height: 844 } });
    page = await context.newPage();
  });
  test.afterAll(async () => {
    await context.close();
    await own?.close();
  });

  test('the same switch, in its bar', async () => {
    await open(page, world.mixed);
    await expect(artifactsButton(page)).toBeVisible();
    await dumpPane(page, 'phone-mixed-closed');
    await shot(page, 'phone-01-header', { reload: true });
    await artifactsButton(page).tap();
    await expect(page.locator('[data-artifacts-phone-back]')).toBeVisible();
    await expect(page.locator('.ib-phead [data-artifacts-switch]')).toBeVisible();
    await expect(page.locator('[data-artifacts-bar]')).toHaveCount(0);
    await page.waitForTimeout(500);
    await shot(page, 'phone-02-artifacts', { reload: true });
    await side(page, 'Links').tap();
    await expect(page.locator('[data-links-view]')).toBeVisible();
    await expect(stateOf(page, PR(1412))).toHaveAttribute('data-ref-state', 'merged');
    await page.waitForTimeout(500);
    await shot(page, 'phone-03-links', { reload: true });
    await noOverflow(page);
    // Back from either side is the thread.
    await page.locator('[data-artifacts-phone-back]').tap();
    await expect(page.locator('[data-links-view]')).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`#thread=${world.mixed}$`));
  });

  test('links only; no links; forty links', async () => {
    await open(page, world.noLinksFiles);
    await dumpPane(page, 'phone-closed');
    await artifactsButton(page).tap();
    await expect(page.locator('[data-artifact-tile]').first()).toBeVisible();
    await expect(page.locator('[data-artifacts-switch-one]')).toHaveText(/^Artifacts\d+$/);
    await open(page, world.linksOnly);
    await artifactsButton(page).tap();
    await expect(page.locator('[data-links-view]')).toBeVisible();
    await expect(page.locator('[data-artifacts-switch-one]')).toHaveText('Links4');
    await page.waitForTimeout(500);
    await shot(page, 'phone-04-links-only', { reload: true });
    await open(page, world.many, '&artifacts&links');
    await expect(page.locator('[data-links-view]')).toBeVisible();
    await shot(page, 'phone-05-forty', { reload: true });
    await noOverflow(page);
  });
});
