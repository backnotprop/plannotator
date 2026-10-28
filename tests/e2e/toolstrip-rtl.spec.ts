/**
 * The annotation toolstrip in both reading directions, against the compiled
 * binary (`plannotator annotate`): each expanded button's label sits after its
 * icon (right of it left to right, left of it right to left) and inside its
 * button. The label is placed with `inset-inline-start`; a physical `left`
 * put it over the icon under dir="rtl".
 *
 * Runs in two projects of playwright.config.ts: `chromium` (every spec) and
 * `webkit` (the WebKit-only specs and this one). Build the binary first (see inbox.spec.ts).
 * Screenshots land in .local/proof/toolstrip-rtl/ (or
 * $PLANNOTATOR_E2E_PROOF_DIR/toolstrip-rtl).
 */

import { expect, test, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'toolstrip-rtl');

async function labelsBesideIcons(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const rtl = getComputedStyle(document.documentElement).direction === 'rtl';
    const problems: string[] = [];
    let checked = 0;
    for (const button of document.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')) {
      const icon = button.querySelector('svg');
      const label = button.querySelector<HTMLElement>(':scope > span:not([aria-hidden])');
      if (!icon || !label || getComputedStyle(label).opacity !== '1') continue;
      const b = button.getBoundingClientRect();
      if (b.width === 0) continue;
      const i = icon.getBoundingClientRect();
      const l = label.getBoundingClientRect();
      checked += 1;
      const after = rtl ? l.right <= i.left + 0.5 : l.left >= i.right - 0.5;
      const inside = l.left >= b.left - 0.5 && l.right <= b.right + 0.5;
      if (!after || !inside) {
        problems.push(`${label.textContent}: button ${b.left.toFixed(1)}-${b.right.toFixed(1)}, icon ${i.left.toFixed(1)}-${i.right.toFixed(1)}, label ${l.left.toFixed(1)}-${l.right.toFixed(1)}`);
      }
    }
    if (checked === 0) problems.push('no expanded toolstrip button found');
    return problems;
  });
}

test('Annotate: the toolstrip label sits after its icon, left to right and right to left', async ({ page, browserName }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-toolstrip-rtl-');
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  const doc = join(root, 'DESIGN.md');
  writeFileSync(doc, '# Directions\n\nA short document.\n');
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
    // The first-run dialogs (plan look, terminal tools, Ask this session, the agent tool) already answered.
    await page.context().addCookies(
      [
        ['plannotator-plan-look-choice-resolved', 'true'],
        ['plannotator-announce-tui-herdr-seen', '1'],
        ['plannotator-announce-inbox-seen', '1'],
        ['plannotator-announce-ask-session-seen', '1'],
        ['plannotator-announce-agent-tool-seen', '1'],
      ].map(([name, value]) => ({ name: name!, value: value!, url })),
    );
    await page.goto(url);
    await expect(page.locator('article')).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    for (const dir of ['ltr', 'rtl'] as const) {
      await page.evaluate((d) => { document.documentElement.dir = d; }, dir);
      // Expand an inactive button too. The pointer, not hover(): the sticky lane above
      // the document holds the same buttons.
      const box = await page.locator('button[aria-pressed="false"]:visible', { hasText: 'Comment' }).last().boundingBox();
      expect(box, `${dir}: the Comment button is on screen`).not.toBeNull();
      await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
      await page.waitForTimeout(450);
      await page.screenshot({ path: join(proofDir, `annotate-toolstrip-${browserName}-${dir}.png`), clip: { x: 0, y: 0, width: 1440, height: 260 } });
      expect.soft(await labelsBesideIcons(page), `${browserName} ${dir}: a label covers its icon or leaves its button`).toEqual([]);
      await page.mouse.move(2, 2);
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
