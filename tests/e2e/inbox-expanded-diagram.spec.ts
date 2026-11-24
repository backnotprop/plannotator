import { expect, test } from './inbox-test';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { INBOX_BRIDGE_POLL_PATH } from '../../packages/shared/inbox/connection';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';

test('expanded diagram keeps the selected reference through file, comment, Ask, and sent-revision actions', async ({ page }) => {
  page.setDefaultTimeout(10_000);
  const root = inboxScratch('plannotator-expanded-diagram-');
  const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? '.local/plannotator');
  const env = { PATH: [dirname(binary), process.env.PATH].join(':'), HOME: root, PLANNOTATOR_DATA_DIR: join(root, 'data'),
    PLANNOTATOR_BROWSER: NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0', PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9' };
  let agent: SimAgent | undefined;
  try {
    const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
    expect(started.status, started.stderr).toBe(0);
    const project = scratchProject(join(root, 'src'), 'shipping');
    const file = 'shipping.diagram.json';
    const writeDiagram = (title: string) => writeFileSync(join(project, file), JSON.stringify({ id: 'shipping', title,
      columns: [{ id: 'worker', title: 'Worker', refs: [
        { kind: 'link', title: 'Specification', url: 'https://example.org/spec' },
        { kind: 'file', title: 'Worker implementation', path: 'worker.ts', start: 1 },
      ] }] }));
    writeFileSync(join(project, 'worker.ts'), 'export const dispatch = "ship";\n');
    writeDiagram('Original shipping');
    agent = await SimAgent.connect({ binary, env: { ...env, CLAUDECODE: '1', PLANNOTATOR_SESSION_TAG: 'claude-code:expanded-diagram' }, name: 'Shipping author', host: 'claude-code' });
    const first = await agent.send({ project_path: project, subject: 'Shipping review', body: 'Please review the original.', attachments: [file] });
    writeDiagram('Revised shipping');
    await agent.send({ project_path: project, reply_to: first.thread_id, body: 'The updated drawing.', attachments: [file] });
    const address = new URL(started.stdout.trim()).origin;
    const { token } = JSON.parse(readFileSync(join(env.PLANNOTATOR_DATA_DIR, 'inbox', 'inbox.json'), 'utf8'));
    const author = (await (await fetch(address + '/api/inbox/threads/' + first.thread_id)).json()).thread.messages[0].author;
    // Register this test session's actual Side-capable bridge, as a Claude Code window does.
    const poll = await fetch(address + INBOX_BRIDGE_POLL_PATH, { method: 'POST', headers: {
      Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
    }, body: JSON.stringify({ session: author.session, host: 'claude-code', project_path: project, ask: true, waitMs: 0 }) });
    expect(poll.status, await poll.text()).toBe(200);
    const url = address + '/#thread=' + first.thread_id;
    await page.goto(url);
    const original = page.locator('[data-inline-diagram-attachment]').filter({ has: page.getByRole('region', { name: 'Original shipping' }) });
    const expand = original.getByRole('button', { name: 'Expand diagram' });
    const folded = page.getByRole('button', { name: /^Shipping author, .*Please review the original/ });
    await expect(expand.or(folded)).toBeVisible();
    if (await folded.count()) await folded.click();
    await expand.click();
    const canvas = page.locator('[data-diagram-popout]');
    await expect(canvas.getByRole('region', { name: 'Original shipping' })).toBeVisible();
    const part = canvas.getByRole('button', { name: 'panel Worker' });
    await part.focus(); await part.press('Enter');
    const card = canvas.getByRole('dialog', { name: 'Worker', exact: true });
    await card.getByRole('button', { name: 'Worker implementation' }).click();

    await card.getByRole('button', { name: 'Open file' }).click();
    const reader = canvas.getByRole('complementary', { name: 'worker.ts' });
    await expect(reader.getByText(/dispatch/).first()).toBeVisible();
    await reader.getByRole('button', { name: 'Back to diagram' }).click();
    await expect(card.getByRole('button', { name: 'Open file' })).toBeFocused();
    await card.getByRole('button', { name: 'Ask AI' }).click();
    const privateAsk = canvas.getByRole('dialog', { name: 'Ask AI' });
    await privateAsk.locator('textarea').fill('Explain the dispatch code.');
    await privateAsk.getByRole('button', { name: 'Send question', exact: true }).click();
    const side = page.locator('[data-chat-window]');
    await expect(side).toBeVisible();
    await side.getByRole('button', { name: 'Minimize' }).click();
    await expect(card.getByRole('button', { name: 'Open file' })).toBeVisible();


    await card.getByRole('button', { name: 'Comment', exact: true }).click();
    await canvas.locator('textarea').fill('Discard this draft.');
    await canvas.getByRole('button', { name: 'Cancel' }).click();
    await expect(card).toBeVisible();
    await card.getByRole('button', { name: 'Comment', exact: true }).click();
    await expect(canvas.locator('textarea')).toHaveValue('');
    await canvas.locator('textarea').press('Escape');
    await expect(card).toBeVisible();

    await card.getByRole('button', { name: 'Comment', exact: true }).click();
    await canvas.locator('textarea').fill('Temporary note.');
    await canvas.getByRole('button', { name: 'Add comment' }).click();
    const pin = canvas.getByRole('button', { name: 'Comment 1 on Worker' });
    await pin.click();
    const deleted = page.waitForResponse(r => r.request().method() === 'POST' && /\/annotations\/[^/]+\/remove$/.test(r.url()));
    await canvas.getByRole('button', { name: 'Delete', exact: true }).click();
    expect((await deleted).ok()).toBe(true);
    await expect(pin).toHaveCount(0);
    await expect(card).toBeVisible();

    await page.setViewportSize({ width: 390, height: 844 });
    await card.getByRole('button', { name: 'Worker implementation' }).click();
    await card.getByRole('button', { name: 'Ask AI' }).click();
    const ask = canvas.getByRole('dialog', { name: 'Ask AI' });
    await ask.locator('textarea').fill('When does dispatch run?');
    await ask.getByRole('button', { name: 'Send question to thread' }).click();
    await expect(card).toBeVisible();
    await expect(card.getByRole('button', { name: 'Open file' })).toBeVisible();
    expect((await agent.nextReply(first.thread_id, 10)).reply_to).toBe(first.message_id);

    const dialog = await canvas.elementHandle();
    await canvas.getByRole('button', { name: 'Open latest' }).click();
    await expect(canvas.getByRole('region', { name: 'Revised shipping' })).toBeVisible();
    expect(await dialog!.evaluate(el => el.isConnected)).toBe(true);
    await expect(canvas.getByRole('button', { name: 'Open latest' })).toHaveCount(0);
    await canvas.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(original.getByRole('region', { name: 'Original shipping' })).toBeVisible();
    await page.reload();
    await expect(expand.or(folded)).toBeVisible();
    if (await folded.count()) await folded.click();
    await expect(original.getByRole('region', { name: 'Original shipping' })).toBeVisible();
    await expect(original.getByRole('button', { name: 'Comment 1 on Worker' })).toHaveCount(0);
  } finally {
    await agent?.close().catch(() => {});
    await removeInboxScratch(root);
  }
});
