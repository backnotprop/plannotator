/**
 * A phone's thread header stays on one line with nothing cut (the owner,
 * 2026-10-29: "Mobile thread header needs to be better responsive"; his
 * iPhone read "‹ I…", Mark read, a stray glyph, then the icons). Since the
 * approval "inbox-thread-header" (2026-11-02) the bar is ‹ Inbox, its title,
 * Artifacts, Expand, ⋯ (the read actions and Snooze lead the ⋯ sheet), with
 * the room the read button left. The title is the thread's name with its
 * subject after it (this thread is named; with no name, the subject), cut with
 * "…" when it has no room; a tap on a cut title opens it whole, wrapped, and a
 * second tap closes it. headFit.ts gives way so the title has room to be read:
 * tighter padding, the Artifacts count, and last the way back's label; the
 * title is never a sliver (the stray glyph was a few pixels of it).
 *
 * Proved against the compiled binary at 320, 360, 375, 390 and 430 px, at the
 * default text size and the largest (15), on a thread with 11 artifacts and a
 * waiting question, opened from the whole list ("‹ Inbox") and from a project
 * with a long name. Build the binary first (see inbox.spec.ts). PNGs land in
 * .local/proof/phone-thread-header/.
 */

import { devices, expect, test, type Browser, type BrowserContext } from './inbox-test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'phone-thread-header');

/** headFit.ts's floors, as the person sees them. */
const BACK_LABEL_FLOOR = 56;
const SUBJECT_FLOOR = 88;

interface World {
  url: string;
  claude: SimAgent;
  thread: string;
  project: string;
}

let world: World;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-phone-head-e2e-');
  const dataDir = join(root, 'data');
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9', PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_BROWSER: NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0', PLANNOTATOR_UPDATE_CHECK: '0' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const url = started.stdout.trim();
  // A long project name: the way back reads it when the thread is opened from the project's list.
  const project = scratchProject(join(root, 'src'), 'checkout-redesign-storefront');
  mkdirSync(join(project, 'notes'), { recursive: true });
  const files = Array.from({ length: 11 }, (_, i) => {
    const name = `notes/part-${i + 1}.md`;
    writeFileSync(join(project, name), `# Part ${i + 1}\n\nNotes.\n`);
    return name;
  });
  const claude = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  const long = Array.from({ length: 30 }, (_, i) => `Paragraph ${i + 1}: the drawer keeps the summary pinned while the line items scroll.`).join('\n\n');
  // The subject starts with a V: a few pixels of it were the stray "\" on the owner's phone.
  const first = await claude.send({ project_path: project, subject: 'Visual QA for the checkout drawer redesign', thread: 'qa', body: `Starting.\n\n${long}`, attachments: files.slice(0, 4) });
  await claude.send({ project_path: project, thread: 'qa', body: `Second pass.\n\n${long}`, attachments: files.slice(4, 8) });
  await claude.send({ project_path: project, thread: 'qa', body: ['Last pass.', '', ':::question', 'Ship the drawer this week?', '', '- [ ] Yes', '- [ ] Wait', ':::', '', long].join('\n'), attachments: files.slice(8) });
  const listed = (await (await fetch(new URL('/api/inbox/projects', url))).json()) as { projects?: { id: string }[] } | { id: string }[];
  const projectId = (Array.isArray(listed) ? listed : listed.projects ?? [])[0]?.id;
  expect(projectId).toBeTruthy();
  world = { url, claude, thread: first.thread_id as string, project: projectId! };
});

test.afterAll(async () => {
  try {
    await world?.claude.close().catch(() => {});
  } finally {
    await removeInboxScratch();
  }
});

async function textSize(size: number): Promise<void> {
  const res = await fetch(new URL('/api/inbox/settings', world.url), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text_size: size }) });
  expect(res.status, await res.clone().text()).toBe(200);
}

async function phone(browser: Browser, width: number, colorScheme: 'light' | 'dark'): Promise<BrowserContext> {
  const { defaultBrowserType: _ignored, ...pixel } = devices['Pixel 7'] as (typeof devices)['Pixel 7'] & { defaultBrowserType?: string };
  return browser.newContext({ ...pixel, viewport: { width, height: 760 }, colorScheme, reducedMotion: 'reduce' });
}

for (const size of [14, 15]) {
  for (const width of [320, 360, 375, 390, 430]) {
    for (const from of ['inbox', 'project'] as const) {
      test(`${width} px, text ${size}, from ${from === 'inbox' ? 'the whole list' : 'a project'}: one line, nothing cut, no key hints`, async ({ browser }) => {
        await textSize(size);
        const context = await phone(browser, width, size === 15 ? 'dark' : 'light');
        try {
          const page = await context.newPage();
          await page.goto(`${world.url}${from === 'project' ? `#project=${world.project}&thread=${world.thread}` : `#thread=${world.thread}`}`);
          const pane = page.locator(`section.ib-pane[data-thread-id="${world.thread}"]`);
          const head = pane.locator('.ib-phead');
          await expect(pane.locator('[data-phone-back]')).toBeVisible();
          await expect(pane.locator('[data-artifacts-button]')).toBeVisible();
          await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--inbox-text-size').trim())).toBe(size === 14 ? '' : '15');
          // A named thread's title is in the header from the start, scrolled or not.
          await expect(pane.locator('.ib-phead [data-header-subject]')).toHaveCount(1);
          await pane.locator('.ib-pbody').evaluate((body) => body.scrollBy(0, 900));
          await page.waitForTimeout(200);
          await page.screenshot({ path: join(proofDir, `${width}-text${size}-${from}.png`), clip: { x: 0, y: 0, width, height: 140 } });

          const m = await head.evaluate((el) => {
            const h = el.getBoundingClientRect();
            const end = h.right - parseFloat(getComputedStyle(el).paddingRight);
            // The controls, the title too when cut (a button: a tap opens it whole).
            const buttons = [...el.querySelectorAll('button')]
              .map((b) => ({ name: b.getAttribute('aria-label') ?? b.textContent?.trim() ?? '', r: b.getBoundingClientRect() }))
              .filter((b) => b.r.width > 0)
              .sort((a, b) => a.r.x - b.r.x)
              .map((b) => ({ name: b.name, left: b.r.left, right: b.r.right, w: b.r.width, h: b.r.height }));
            const label = el.querySelector<HTMLElement>('.ib-pback-l');
            const labelDrawn = label !== null && label.getBoundingClientRect().width > 1;
            const subject = el.querySelector<HTMLElement>('[data-header-subject]');
            const subjectDrawn = subject !== null && getComputedStyle(subject).visibility !== 'hidden';
            const kbds = [...el.querySelectorAll('kbd')].filter((k) => k.getBoundingClientRect().width > 0).length;
            return {
              end,
              top: h.top,
              buttons,
              label: labelDrawn ? { shown: label!.clientWidth, whole: label!.scrollWidth } : null,
              subject: subjectDrawn ? subject!.getBoundingClientRect().width : null,
              kbds,
            };
          });
          // Every control is on the header's one line, inside its edge, none over another, each a 44 px target.
          for (const b of m.buttons) {
            expect(b.h, `${b.name} is ${Math.round(b.w)}x${Math.round(b.h)}`).toBeGreaterThanOrEqual(43.9);
            expect(b.w, `${b.name} is ${Math.round(b.w)}x${Math.round(b.h)}`).toBeGreaterThanOrEqual(43.9);
          }
          for (let i = 1; i < m.buttons.length; i++) expect(m.buttons[i].left, `${m.buttons[i - 1].name} overlaps ${m.buttons[i].name}`).toBeGreaterThanOrEqual(m.buttons[i - 1].right - 0.5);
          expect(m.buttons.at(-1)!.right).toBeLessThanOrEqual(m.end + 0.5);
          expect(m.buttons.at(-1)!.name).toBe('More');
          // The way back: "Inbox" whole; a long project name at least its floor; or the chevron alone.
          if (m.label) expect(m.label.shown, `the way back reads ${m.label.shown} of ${m.label.whole} px`).toBeGreaterThanOrEqual(Math.min(m.label.whole, BACK_LABEL_FLOOR) - 0.5);
          if (from === 'inbox') expect(m.label, '"Inbox" is drawn').not.toBeNull();
          if (from === 'inbox') expect(m.label!.shown).toBeGreaterThanOrEqual(m.label!.whole - 0.5);
          await expect(pane.locator('[data-phone-back]')).toHaveAccessibleName(from === 'inbox' ? 'Back to Inbox' : /^Back to checkout-redesign-storefront/);
          // The title: drawn at every phone width, with room to read it (never a sliver).
          expect(m.subject, 'the title is drawn').not.toBeNull();
          expect(m.subject!).toBeGreaterThanOrEqual(SUBJECT_FLOOR - 0.5);
          // No keyboard hints on a phone.
          expect(m.kbds).toBe(0);
          // The read action and Snooze are in the ⋯ sheet, not the bar.
          await expect(head.locator('[data-mark-read], [data-mark-unread], [data-thread-snooze]')).toHaveCount(0);
          // Whatever gave way keeps its name.
          await expect(pane.locator('[data-artifacts-button]')).toHaveAccessibleName('Artifacts, 11');
        } finally {
          await context.close();
        }
      });
    }
  }
}

test('the widest phone keeps every word: "‹ Inbox", the title and the count', async ({ browser }) => {
  await textSize(14);
  const context = await phone(browser, 430, 'light');
  try {
    const page = await context.newPage();
    await page.goto(`${world.url}#thread=${world.thread}`);
    const pane = page.locator(`section.ib-pane[data-thread-id="${world.thread}"]`);
    await expect(pane.locator('[data-artifacts-button]')).toBeVisible();
    await expect(pane.locator('[data-phone-back] .ib-pback-l')).toBeVisible();
    // A named thread: the bar shows its name (the list's rule) with the subject after it, the thread's only heading.
    const title = pane.locator('.ib-phead [data-header-subject]');
    await expect(title).toHaveAttribute('data-header-name', '');
    await expect(title.locator('[data-header-name-words]')).toHaveText('qa');
    await expect(title.locator('[data-header-after]')).toHaveText('Visual QA for the checkout drawer redesign');
    await expect(title.locator('[data-header-after]')).toBeVisible();
    // Cut here (a tap opens it whole), the heading takes its name, said once, from the title's button.
    await expect(title).toHaveAccessibleName('qa: Visual QA for the checkout drawer redesign');
    await expect(pane.locator('.ib-pbody h2')).toHaveCount(0);
    await expect(pane.locator('.ib-phead')).not.toHaveAttribute('data-fit', /./);
    await expect(pane.locator('[data-artifacts-button] .ib-artbtn-n')).toBeVisible();
  } finally {
    await context.close();
  }
});

test('a cut title opens whole on a tap, wrapped in a taller bar, and a second tap closes it', async ({ browser }) => {
  await textSize(14);
  const context = await phone(browser, 360, 'light');
  try {
    const page = await context.newPage();
    await page.goto(`${world.url}#thread=${world.thread}`);
    const pane = page.locator(`section.ib-pane[data-thread-id="${world.thread}"]`);
    const head = pane.locator('.ib-phead');
    const title = head.locator('[data-header-subject]');
    const words = title.locator('[data-header-title]');
    await expect(pane.locator('[data-artifacts-button]')).toBeVisible();
    // "qa Visual QA for the checkout drawer redesign" has no room on one line at 360: cut, the title is a button.
    await expect(words).toHaveAttribute('aria-expanded', 'false');
    await expect(title).not.toHaveAttribute('data-open');
    const closed = await title.evaluate((h) => h.getBoundingClientRect().height);
    expect((await head.boundingBox())!.height).toBeLessThanOrEqual(48.5);
    // A 44 px target, its words still in the middle of the bar.
    expect((await words.boundingBox())!.height, 'the cut title is a 44 px target').toBeGreaterThanOrEqual(43.9);
    const middle = await head.evaluate((h) => {
      const r = h.getBoundingClientRect();
      const top = r.top + parseFloat(getComputedStyle(h).paddingTop);
      const a = h.querySelector('[data-header-after]')!.getBoundingClientRect();
      return Math.abs((a.top + a.bottom) / 2 - (top + r.bottom) / 2);
    });
    expect(middle, 'the words sit in the middle of the bar').toBeLessThanOrEqual(3);

    await words.tap();
    await expect(title).toHaveAttribute('data-open', '');
    await expect(words).toHaveAttribute('aria-expanded', 'true');
    // Open: the whole subject wraps onto more lines, inside the title, nothing cut or scrolled away; the bar grows.
    const open = await title.evaluate((h) => {
      const box = h.getBoundingClientRect();
      const after = h.querySelector<HTMLElement>('[data-header-after]')!;
      const lines = [...after.getClientRects()];
      const t = h.querySelector<HTMLElement>('[data-header-title]')!;
      return {
        height: box.height,
        lines: new Set(lines.map((r) => Math.round(r.top))).size,
        inside: lines.every((r) => r.right <= box.right + 0.5 && r.bottom <= box.bottom + 0.5 && r.left >= box.left - 0.5 && r.top >= box.top - 0.5),
        clipped: t.scrollWidth > t.clientWidth + 1 || h.scrollHeight > h.clientHeight + 1,
      };
    });
    expect(open.lines, 'the subject wraps beyond one line').toBeGreaterThanOrEqual(2);
    expect(open.height).toBeGreaterThan(closed);
    expect(open.inside, 'every line of the subject is inside the title').toBe(true);
    expect(open.clipped, 'nothing of the title is cut').toBe(false);
    await expect(title.locator('[data-header-after]')).toBeVisible();
    expect((await head.boundingBox())!.height).toBeGreaterThan(48);
    // The bar's controls are still there beside it.
    await expect(pane.locator('[data-phone-back]')).toBeInViewport();
    await expect(head.locator('[data-thread-more]')).toBeInViewport();
    await page.screenshot({ path: join(proofDir, '360-title-open.png'), clip: { x: 0, y: 0, width: 360, height: 160 } });

    await words.tap();
    await expect(title).not.toHaveAttribute('data-open');
    await expect(words).toHaveAttribute('aria-expanded', 'false');
    await expect.poll(async () => (await head.boundingBox())!.height).toBeLessThanOrEqual(48.5);
  } finally {
    await context.close();
  }
});

test('a desktop header is untouched: nothing gives way', async ({ browser }) => {
  await textSize(14);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    const page = await context.newPage();
    await page.goto(`${world.url}#thread=${world.thread}`);
    const head = page.locator(`section.ib-pane[data-thread-id="${world.thread}"] .ib-phead`);
    await expect(head.locator('[data-artifacts-button]')).toBeVisible();
    await expect(head).not.toHaveAttribute('data-fit', /./);
    await expect(head).not.toHaveAttribute('data-subject-off', /.*/);
  } finally {
    await context.close();
  }
});
