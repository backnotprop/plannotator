import { expect, test } from './inbox-test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';

test('diagram discovery, inline and expanded comments, owner-scoped source and agent feedback', async ({ page }) => {
  const root = inboxScratch('plannotator-native-diagram-e2e-');
  const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? '.local/plannotator');
  const env = { PATH: [dirname(binary), process.env.PATH].join(':'), HOME: root, PLANNOTATOR_DATA_DIR: join(root, 'data'),
    PLANNOTATOR_BROWSER: NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0', PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9' };
  let agent: SimAgent | undefined;
  try {
    const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
    expect(started.status, started.stderr).toBe(0);
    const url = started.stdout.trim();
    const project = scratchProject(join(root, 'src'), 'delivery');
    mkdirSync(join(project, 'src'), { recursive: true });
    writeFileSync(join(project, 'src', 'queue.ts'), 'export const queue = "owned by delivery";\n');
    const file = 'delivery.diagram.json';
    writeFileSync(join(project, file), JSON.stringify({
      id: 'delivery-flow', title: 'Delivery pipeline', columns: [
        { id: 'queue', title: 'Queue', sub: 'Holds incoming orders', refs: [{ kind: 'file', title: 'Queue implementation', path: 'src/queue.ts', start: 1 }] },
        { id: 'worker', title: 'Worker', sub: 'Delivers the order' },
      ], links: [{ id: 'dispatch', from: 'queue', to: 'worker', label: 'dispatch' }],
    }));
    agent = await SimAgent.connect({ binary, env, name: 'Diagram author', host: 'codex' });
    const sent = await agent.send({ project_path: project, subject: 'Delivery pipeline', body: 'Please review the attached delivery pipeline.', attachments: [file] });
    const thread = sent.thread_id as string;
    await page.goto(`${url}#thread=${thread}`);
    await expect(page.getByText(file).first()).toBeVisible();
    const settings = await page.evaluate(async () => {
      const response = await fetch('/api/inbox/settings');
      if (!response.ok) throw new Error('Could not read Inbox settings');
      return response.json();
    });
    expect(settings).not.toHaveProperty('diagrams');
    const inline = page.locator('[data-inline-diagram-attachment]');
    await expect(inline.getByRole('button', { name: 'panel Queue' })).toBeAttached();
    const queue = inline.getByRole('button', { name: 'panel Queue' });
    await queue.focus();
    await queue.press('Enter');
    await expect(inline.getByText('src/queue.ts')).toBeVisible();
    await inline.getByRole('button', { name: 'Comment', exact: true }).click();
    await inline.locator('textarea').fill('Show who handles retries.');
    await inline.getByRole('button', { name: 'Add comment' }).click();
    await expect(inline.getByRole('button', { name: 'Comment 1 on Queue' })).toBeVisible();
    await inline.getByRole('button', { name: 'Expand diagram' }).click();
    const popout = page.locator('[data-diagram-popout]');
    await expect(popout.getByRole('button', { name: 'Comment 1 on Queue' })).toBeVisible();
    await popout.getByRole('button', { name: 'Comment 1 on Queue' }).click();
    await expect(popout.getByText('Show who handles retries.')).toBeVisible();
    if (process.env.PLANNOTATOR_E2E_PROOF_DIR) {
      mkdirSync(process.env.PLANNOTATOR_E2E_PROOF_DIR, { recursive: true });
      await page.screenshot({ path: join(process.env.PLANNOTATOR_E2E_PROOF_DIR, 'inbox-expanded-comment.png') });
    }
    await popout.getByRole('button', { name: 'Close', exact: true }).first().click();
    await page.reload();
    await expect(inline.getByRole('button', { name: 'Comment 1 on Queue' })).toBeVisible();
    if (process.env.PLANNOTATOR_E2E_PROOF_DIR) await page.screenshot({ path: join(process.env.PLANNOTATOR_E2E_PROOF_DIR, 'inbox-inline-diagram.png') });
    await queue.focus();
    await queue.press('Enter');
    await inline.getByRole('button', { name: 'Open file' }).click();
    await expect(page.getByText(/owned by delivery/).first()).toBeVisible();
    await page.goto(`${url}#thread=${thread}`);
    const desktop = page.viewportSize()!;
    await page.setViewportSize({ width: 390, height: 844 });
    await queue.focus();
    const partCard = inline.getByRole('dialog', { name: 'Queue' });
    if (!(await partCard.isVisible())) await queue.press('Enter');
    await partCard.getByRole('button', { name: 'Ask AI' }).click();
    const drawer = inline.getByRole('dialog', { name: 'Ask AI' });
    await expect(drawer.getByText('Replies appear in this thread.')).toBeVisible();
    await drawer.locator('textarea').fill('How is the queue drained?');
    if (process.env.PLANNOTATOR_E2E_PROOF_DIR) await page.screenshot({ path: join(process.env.PLANNOTATOR_E2E_PROOF_DIR, 'inbox-phone-thread-question.png') });
    await drawer.getByRole('button', { name: 'Send question to thread' }).click();
    const question = await agent.nextReply(thread, 10);
    expect(question.body).toContain('How is the queue drained?');
    expect(question.body).toContain('Asset: delivery-flow');
    expect(question.body).toContain('panel: Queue (queue)');
    expect(question.body).toMatch(/SHA-256: [a-f0-9]{64}/);
    expect(question.body).not.toContain('Show who handles retries.');
    await page.setViewportSize(desktop);
    await page.locator('section.ib-pane .ib-pfoot').getByRole('button', { name: /^Reply$|Edit draft$/ }).first().click();
    const field = page.locator('.ib-rbox textarea');
    await field.pressSequentially('/diagram');
    await page.locator('[data-skill-item="diagram"]').click();
    await expect(field).toHaveValue('/diagram ');
    await field.pressSequentially('Revise the drawing using my comment.');
    await page.locator('section.ib-pane').getByRole('button', { name: 'Send', exact: true }).click();
    const reply = await agent.nextReply(thread, 10, question.id as string);
    expect(reply.body).toContain('BEGIN SKILL INSTRUCTIONS: diagram');
    expect(reply.body).toContain('Diagram panel Queue (queue)');
    expect(reply.body).toContain('Show who handles retries.');
  } finally {
    await agent?.close().catch(() => {});
    await removeInboxScratch(root);
  }
});
