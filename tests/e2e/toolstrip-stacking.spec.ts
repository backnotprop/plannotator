import { devices, expect, test, type Browser, type BrowserContextOptions, type Page } from '@playwright/test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'toolstrip-stacking');

const rows = (n: number) =>
  Array.from({ length: n }, (_, i) => `| ${i + 1} | Notifications ${i + 1} | Switch, browser permission, blocked note |`).join('\n');

const DOC = [
  '# Inbox design',
  '',
  'Intro paragraph. '.repeat(30),
  '',
  '## Screens',
  '',
  '| # | Screen | What it holds |',
  '|---|--------|---------------|',
  rows(14),
  '',
  'Between the blocks. '.repeat(20),
  '',
  '```ts',
  ...Array.from({ length: 16 }, (_, i) => `const line${i} = "a code line that is long enough to reach across the strip ${i}";`),
  '```',
  '',
  '> [!WARNING]',
  '> A GitHub alert that runs across several lines so it can sit under the strip.',
  '> Second line of the alert.',
  '> Third line of the alert.',
  '',
  ':::note',
  'A directive callout with enough words in it to cover the strip area when scrolled under it.',
  'Another line of the callout.',
  ':::',
  '',
  '```mermaid',
  'flowchart TD',
  '  A[Open the Inbox] --> B[Pick a thread]',
  '  B --> C{Has a file?}',
  '  C -- yes --> D[Open it beside]',
  '  C -- no --> E[Reply]',
  '  D --> F[Comment]',
  '  E --> F',
  '```',
  '',
  ':::question',
  'Which layout should the file pane use?',
  '',
  '- [ ] Beside the thread',
  '- [ ] Full screen',
  ':::',
  '',
  'Closing words. '.repeat(40),
  '',
  ...Array.from({ length: 30 }, (_, i) => `Trailing paragraph ${i} so every block above can scroll to the top.`).flatMap((p) => [p, '']),
].join('\n');

const BLOCKS: Array<{ name: string; selector: string }> = [
  { name: 'table', selector: 'table' },
  { name: 'code', selector: 'pre' },
  { name: 'alert', selector: '[data-alert-kind], blockquote' },
  { name: 'diagram', selector: '[data-diagram-block]' },
  { name: 'question', selector: '[data-question-key], [data-question-card]' },
];

interface Probe {
  covered: string[];
  overlapped: boolean;
  found: boolean;
}

async function probe(page: Page, scrollerSelector: string, stripSelector: string, blockSelector: string): Promise<Probe> {
  const placed = await page.evaluate(
    ({ scrollerSelector, stripSelector, blockSelector }) => {
      const scroller = scrollerSelector === 'window' ? document.scrollingElement! : document.querySelector(scrollerSelector);
      const strip = document.querySelector(stripSelector);
      if (!scroller || !strip) return { found: false };
      const block = [...scroller.querySelectorAll(blockSelector)].find((el) => el.getBoundingClientRect().height > 30);
      if (!block) return { found: false };
      for (let i = 0; i < 2; i++) {
        const s = strip.getBoundingClientRect();
        const b = block.getBoundingClientRect();
        scroller.scrollTop += b.top - (s.top - 6);
      }
      return { found: true };
    },
    { scrollerSelector, stripSelector, blockSelector },
  );
  if (!placed.found) return { covered: [], overlapped: false, found: false };
  await page.waitForTimeout(150);
  return page.evaluate(
    ({ scrollerSelector, stripSelector, blockSelector }) => {
      const scroller = scrollerSelector === 'window' ? document.scrollingElement! : document.querySelector(scrollerSelector)!;
      const strip = document.querySelector(stripSelector)!;
      const block = [...scroller.querySelectorAll(blockSelector)].find((el) => el.getBoundingClientRect().height > 30)!;
      const s = strip.getBoundingClientRect();
      const b = block.getBoundingClientRect();
      const overlapped = b.left < s.right && b.right > s.left && b.top < s.bottom && b.bottom > s.top;
      const covered: string[] = [];
      for (const fx of [0.1, 0.3, 0.5, 0.7, 0.9]) {
        for (const fy of [0.3, 0.7]) {
          const x = s.left + s.width * fx;
          const y = s.top + s.height * fy;
          const top = document.elementFromPoint(x, y);
          if (!top || !strip.contains(top)) {
            covered.push(`(${Math.round(x)},${Math.round(y)}) ${top ? `${top.tagName.toLowerCase()}.${String(top.className).slice(0, 60)}` : 'nothing'}`);
          }
        }
      }
      return { covered, overlapped, found: true };
    },
    { scrollerSelector, stripSelector, blockSelector },
  );
}

async function checkSurface(page: Page, label: string, scroller: string, strip: string): Promise<void> {
  await expect(page.locator(strip)).toBeVisible();
  for (const block of BLOCKS) {
    const result = await probe(page, scroller, strip, block.selector);
    expect(result.found, `${label}: a ${block.name} is in the document`).toBe(true);
    await page.screenshot({ path: join(proofDir, `${label}-${block.name}.png`) });
    if (block.name === 'table') expect(result.overlapped, `${label}: the table crossed the strip`).toBe(true);
    expect.soft(result.covered, `${label}: the ${block.name} painted over the strip`).toEqual([]);
  }
}

async function checkTablePopoutCovers(page: Page, label: string, scroller: string, strip: string): Promise<void> {
  await probe(page, scroller, strip, 'table');
  await page.locator(scroller).first().evaluate((el) => {
    el.scrollTop -= 80;
  });
  const table = page.locator(`${scroller} table`).first();
  await table.locator('tr').first().hover();
  await page.getByTitle('Expand table').first().click();
  const popout = page.locator('[data-popout]');
  await expect(popout).toBeVisible();
  const onTop = await page.evaluate((stripSelector) => {
    const s = document.querySelector(stripSelector)!.getBoundingClientRect();
    const top = document.elementFromPoint(s.left + s.width / 2, s.top + s.height / 2);
    return { inStrip: !!top && document.querySelector(stripSelector)!.contains(top), tag: top ? `${top.tagName.toLowerCase()}.${String(top.className).slice(0, 60)}` : 'nothing' };
  }, strip);
  await page.screenshot({ path: join(proofDir, `${label}-table-popout.png`) });
  expect.soft(onTop.inStrip, `${label}: the table popout covers the strip (top: ${onTop.tag})`).toBe(false);
  await page.keyboard.press('Escape');
  await expect(popout).toHaveCount(0);
}

async function checkStepListAbove(page: Page, label: string): Promise<void> {
  await page.locator('[data-attachment-stepper] [aria-haspopup="grid"], [data-full-view-position]').first().click();
  const list = page.locator('[data-step-list]');
  await expect(list).toBeVisible();
  const covered = await page.evaluate(() => {
    const el = document.querySelector('[data-step-list]')!;
    const r = el.getBoundingClientRect();
    const misses: string[] = [];
    for (const fy of [0.15, 0.5, 0.85]) {
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height * fy);
      if (!top || !el.contains(top)) misses.push(top ? `${top.tagName.toLowerCase()}.${String(top.className).slice(0, 60)}` : 'nothing');
    }
    return misses;
  });
  await page.screenshot({ path: join(proofDir, `${label}-step-list.png`) });
  expect.soft(covered, `${label}: the document painted over the stepping list`).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(list).toHaveCount(0);
}

async function closeSidebarPeek(page: Page): Promise<void> {
  const peek = page.locator('[data-sidebar-peek][data-visible]');
  await page.mouse.move(700, 450);
  await page.waitForTimeout(800);
  await expect(async () => {
    if ((await peek.count()) > 0) {
      await page.mouse.move(60, 450);
      await page.mouse.move(700, 450);
    }
    await expect(peek).toHaveCount(0, { timeout: 1000 });
  }, 'the sidebar peek is closed before the strip is probed').toPass({ timeout: 10_000 });
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  mkdirSync(proofDir, { recursive: true });
});

test('Inbox: the attached document never paints over the toolstrip, beside the thread, full screen, narrow and on a phone', async ({ browser }: { browser: Browser }) => {
  const root = inboxScratch('plannotator-toolstrip-inbox-');
  const dataDir = join(root, 'data');
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_BROWSER: NO_BROWSER };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const url = started.stdout.trim();
  const project = scratchProject(join(root, 'src'), 'inbox-design');
  writeFileSync(join(project, 'DESIGN.md'), DOC);
  const agent = await SimAgent.connect({ binary, env, name: 'Claude', host: 'claude-code' });
  try {
    writeFileSync(join(project, 'NOTES.md'), '# Notes\n\nA second file, so the stepping bar and its list show.\n');
    const sent = await agent.send({ project_path: project, subject: 'The design', body: 'The design doc, attached.', attachments: ['DESIGN.md', 'NOTES.md'] });
    const fileUrl = `${url}#thread=${sent.thread_id}&file=${sent.attachments[0].id as string}`;
    const layouts: Array<{ label: string; options: BrowserContextOptions; full?: boolean }> = [
      { label: 'inbox-beside-1440', options: { viewport: { width: 1440, height: 900 } } },
      { label: 'inbox-full-1120', options: { viewport: { width: 1120, height: 900 } }, full: true },
      { label: 'inbox-beside-1280', options: { viewport: { width: 1280, height: 800 } } },
      { label: 'inbox-narrow-1000', options: { viewport: { width: 1000, height: 800 } } },
      { label: 'inbox-phone', options: { ...devices['Pixel 7'] } },
    ];
    for (const layout of layouts) {
      const context = await browser.newContext(layout.options);
      try {
        const page = await context.newPage();
        await page.mouse.move(400, 400);
        await page.goto(fileUrl);
        await expect(page.locator('[data-attachment-pane] .ib-docscroll table')).toBeVisible();
        if (layout.full) {
          await page.getByRole('button', { name: 'Full screen' }).click();
          await expect(page.locator('.ib-view.ib-full')).toBeVisible();
          await page.locator('[data-full-view-comments]').click();
          await expect(page.locator('.ib-view.ib-drawer')).toBeVisible();
        }
        await closeSidebarPeek(page);
        await checkSurface(page, layout.label, '[data-attachment-pane] .ib-docscroll', '[data-attachment-pane] .ib-toolstrip');
        await checkTablePopoutCovers(page, layout.label, '[data-attachment-pane] .ib-docscroll', '[data-attachment-pane] .ib-toolstrip');
        if (!layout.options.isMobile) await checkStepListAbove(page, layout.label);
      } finally {
        await context.close();
      }
    }
  } finally {
    await agent.close().catch(() => {});
    await removeInboxScratch(root);
  }
});

test('Annotate (the editor plan review shares): the document never paints over the sticky toolstrip at any width', async ({ browser }: { browser: Browser }) => {
  const root = inboxScratch('plannotator-toolstrip-annotate-');
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  const doc = join(root, 'DESIGN.md');
  writeFileSync(doc, DOC);
  const readyFile = join(root, 'ready.jsonl');
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: root,
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_READY_FILE: readyFile,
    PLANNOTATOR_SKIP_BROWSER_OPEN: '1',
    PLANNOTATOR_REMOTE: '0',
  };
  let child: ChildProcess | undefined;
  let url = '';
  try {
    child = spawn(binary, ['annotate', doc], { env, cwd: root, stdio: 'ignore' });
    await expect.poll(() => (existsSync(readyFile) ? readFileSync(readyFile, 'utf8') : ''), { timeout: 30_000 }).toContain('"url"');
    url = (JSON.parse(readFileSync(readyFile, 'utf8').trim().split('\n')[0]!) as { url: string }).url;
    const layouts: Array<{ label: string; options: BrowserContextOptions }> = [
      { label: 'annotate-1440', options: { viewport: { width: 1440, height: 900 } } },
      { label: 'annotate-1024', options: { viewport: { width: 1024, height: 800 } } },
      { label: 'annotate-820', options: { viewport: { width: 820, height: 900 } } },
    ];
    for (const layout of layouts) {
      const context = await browser.newContext(layout.options);
      try {
        await context.addCookies(
          [
            ['plannotator-plan-look-choice-resolved', 'true'],
            ['plannotator-announce-tui-herdr-seen', '1'],
            ['plannotator-announce-inbox-seen', '1'],
            ['plannotator-announce-ask-session-seen', '1'],
            ['plannotator-announce-agent-tool-seen', '1'],
          ].map(([name, value]) => ({ name: name!, value: value!, url })),
        );
        const page = await context.newPage();
        await page.goto(url);
        await expect(page.locator('article table')).toBeVisible();
        await expect(page.getByRole('dialog')).toHaveCount(0);
        const scroller = await page.evaluate(() => {
          let el = document.querySelector('article')?.parentElement ?? null;
          while (el && !(el.scrollHeight > el.clientHeight && /auto|scroll/.test(getComputedStyle(el).overflowY))) el = el.parentElement;
          if (!el) return 'window';
          el.setAttribute('data-test-doc-scroller', '');
          return '[data-test-doc-scroller]';
        });
        await checkSurface(page, layout.label, scroller, '[data-sticky-header-lane] > div');
        await checkTablePopoutCovers(page, layout.label, scroller, '[data-sticky-header-lane] > div');
      } finally {
        await context.close();
      }
    }
  } finally {
    if (url) await fetch(new URL('/api/exit', url), { method: 'POST' }).catch(() => {});
    if (child && child.exitCode === null) {
      await new Promise((done) => {
        const timer = setTimeout(done, 5_000);
        child!.once('exit', () => {
          clearTimeout(timer);
          done(undefined);
        });
      });
      // inbox-guard: own child (the annotate CLI this test spawned, never an Inbox)
      if (child.exitCode === null) child.kill('SIGTERM');
    }
    await removeInboxScratch(root);
  }
});
