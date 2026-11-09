/**
 * The person's own text shows what they typed (rendering only): a single newline is a line break and a run of
 * blank lines keeps that many empty lines. Measured in a real Chromium against the compiled binary, since a
 * DOM test has no layout: six blank lines put the next paragraph six text lines below the previous one's end
 * (the margin collapses with the paragraph's own bottom margin), an agent's message keeps the ordinary gap.
 *
 * Build the binary first (see inbox.spec.ts), then `bun run test:e2e:inbox`.
 */
import { expect, test } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const OWNER = 'this\nis\na\ntest\n\n\n\n\n\n\na lot test';
const AGENT_BODY = 'agent one\nagent two\n\n\n\n\n\n\nagent after';

test('six blank lines in the person\'s message leave six lines of space; the agent\'s keep the paragraph gap', async ({ browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  const root = inboxScratch('plannotator-inbox-person-breaks-e2e-');
  try {
    const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_DATA_DIR: join(root, 'data'), CLAUDE_CONFIG_DIR: join(root, 'claude'), PLANNOTATOR_BROWSER: NO_BROWSER, NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0', PLANNOTATOR_UPDATE_CHECK: '0', PLANNOTATOR_TEST_SANDBOX: '1' };
    const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
    expect(started.status, started.stderr).toBe(0);
    const url = started.stdout.trim();
    const agent = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
    const ask = await agent.send({ project_path: scratchProject(join(root, 'src'), 'demo'), subject: 'Line breaks', thread: 't', body: AGENT_BODY });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await page.goto(`${url}#thread=${ask.thread_id}`);
    const hide = page.getByRole('button', { name: 'Hide', exact: true });
    if (await hide.isVisible().catch(() => false)) await hide.click();
    if (!(await page.locator('.ib-rbox textarea').first().isVisible().catch(() => false))) await page.getByRole('button', { name: /^Reply/ }).last().click();
    await page.locator('.ib-rbox textarea').first().fill(OWNER);
    await page.getByRole('button', { name: /^Send/ }).last().click();
    await expect(page.locator('[data-author="person"]')).toHaveCount(1);

    const gap = (scope: string) =>
      page.evaluate((selector) => {
        const [first, second] = [...document.querySelectorAll(`${selector} p`)] as HTMLElement[];
        const line = parseFloat(getComputedStyle(second!).lineHeight);
        return { gap: second!.getBoundingClientRect().top - first!.getBoundingClientRect().bottom, line };
      }, scope);
    const person = await gap('[data-author="person"]');
    expect(Math.abs(person.gap - 6 * person.line)).toBeLessThan(1.5);
    const agentGap = await gap('[data-author="agent"]');
    expect(agentGap.gap).toBeLessThan(agentGap.line);
    await agent.close().catch(() => {});
    await context.close();
  } finally {
    await removeInboxScratch();
  }
});
