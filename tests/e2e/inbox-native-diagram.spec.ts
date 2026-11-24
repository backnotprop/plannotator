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
  let later: SimAgent | undefined;
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
    later = await SimAgent.connect({ binary, env, name: 'Second agent', host: 'claude' });
    const second = await later.send({ project_path: project, reply_to: thread, body: 'I reviewed the documentation.' });
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
    const editor = inline.locator('textarea');
    await editor.fill('Who handles retries?');
    const writes: string[] = [];
    await page.route('**/api/inbox/annotations', async route => {
      const { diagram_annotation: pin, ...legacyBody } = route.request().postDataJSON();
      expect(pin.diagramAnchor.family).toBe('plannotator-diagram');
      expect(legacyBody).not.toHaveProperty('annotation');
      writes.push(pin.id);
      if (writes.length === 1) {
        // Run the former decoder against the real store: it cannot see the new envelope and must refuse before writing.
        const response = await route.fetch({ postData: legacyBody });
        expect(response.status()).toBe(422);
        return route.fulfill({ response });
      }
      if (writes.length === 2) return route.abort('failed'); // An ordinary connection failure can be retried.
      return route.continue();
    });
    const add = inline.getByRole('button', { name: 'Add comment' });
    await add.click();
    await expect(inline.getByRole('alert')).toHaveText('The other computer needs a newer Plannotator to pin this comment.');
    await expect(editor).toHaveValue('Who handles retries?');
    await expect(add).toBeDisabled();
    await editor.press('Control+Enter');
    expect(writes).toHaveLength(1);
    await page.reload();
    const expandAuthor = page.getByRole('button', { name: /^Diagram author, .*1 attachment/ });
    if (!(await queue.count())) await expandAuthor.click();
    await expect(inline.getByRole('button', { name: 'Comment 1 on Queue' })).toHaveCount(0);
    await queue.focus();
    await queue.press('Enter');
    await inline.getByRole('button', { name: 'Comment', exact: true }).click();
    await editor.fill('Who handles retries?');
    await add.click();
    await expect(inline.getByRole('alert')).toHaveText('Couldn’t save the comment. Try again.');
    await expect(editor).toHaveValue('Who handles retries?');
    await expect(add).toBeEnabled();
    await editor.fill('Show who handles retries.');
    await add.click();
    await expect(inline.getByRole('button', { name: 'Comment 1 on Queue' })).toBeVisible();
    await expect(inline.getByRole('button', { name: 'Comment 1 on Queue' })).toBeFocused();
    expect(writes).toHaveLength(3);
    expect(writes[2]).toBe(writes[1]);
    await inline.getByRole('button', { name: 'Expand diagram' }).click();
    const popout = page.locator('[data-diagram-popout]');
    await expect(popout.getByRole('button', { name: 'Comment 1 on Queue' })).toBeVisible();
    const expandedQueue = popout.getByRole('button', { name: 'panel Queue' });
    await expandedQueue.focus();
    await expandedQueue.press('Enter');
    await popout.getByRole('button', { name: 'Comment', exact: true }).click();
    await popout.locator('textarea').fill('Clarify retry timing.');
    await popout.getByRole('button', { name: 'Add comment' }).click();
    const pinOne = popout.getByRole('button', { name: 'Comment 1 on Queue' });
    const pinTwo = popout.getByRole('button', { name: 'Comment 2 on Queue' });
    await pinOne.click();
    await pinTwo.click();
    await expect(popout.getByText('Clarify retry timing.')).toBeVisible();
    await pinOne.click();
    await expect(popout.getByText('Show who handles retries.')).toBeVisible();
    if (process.env.PLANNOTATOR_E2E_PROOF_DIR) {
      mkdirSync(process.env.PLANNOTATOR_E2E_PROOF_DIR, { recursive: true });
      await page.screenshot({ path: join(process.env.PLANNOTATOR_E2E_PROOF_DIR, 'inbox-expanded-comment.png') });
    }
    await popout.getByRole('button', { name: 'Close', exact: true }).first().click();
    await page.reload();
    await expandAuthor.click();
    await expect(inline.getByRole('button', { name: 'Comment 1 on Queue' })).toBeVisible();
    if (process.env.PLANNOTATOR_E2E_PROOF_DIR) await page.screenshot({ path: join(process.env.PLANNOTATOR_E2E_PROOF_DIR, 'inbox-inline-diagram.png') });
    await queue.focus();
    await queue.press('Enter');
    await inline.getByRole('button', { name: 'Open file' }).click();
    await expect(page.getByText(/owned by delivery/).first()).toBeVisible();
    await page.goto(`${url}#thread=${thread}`);
    if (!(await queue.count())) await expandAuthor.click();
    const desktop = page.viewportSize()!;
    await page.setViewportSize({ width: 390, height: 844 });
    await queue.focus();
    const partCard = inline.getByRole('dialog', { name: 'Queue' });
    if (!(await partCard.isVisible())) await queue.press('Enter');
    await partCard.getByRole('button', { name: 'Ask AI' }).click();
    const drawer = inline.getByRole('dialog', { name: 'Ask AI' });
    await expect(drawer.getByText('Replies appear in this thread.')).toHaveCount(0);
    await drawer.locator('textarea').fill('How is the queue drained?');
    if (process.env.PLANNOTATOR_E2E_PROOF_DIR) await page.screenshot({ path: join(process.env.PLANNOTATOR_E2E_PROOF_DIR, 'inbox-phone-thread-question.png') });
    await drawer.getByRole('button', { name: 'Send question to thread' }).click();
    const question = await agent.nextReply(thread, 10);
    expect(question.reply_to).toBe(sent.message_id);
    expect(question.body).toContain('How is the queue drained?');
    expect(question.body).toContain('Asset: delivery-flow');
    expect(question.body).toContain('panel: Queue (queue)');
    expect(question.body).not.toContain('SHA-256:');
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
    expect(reply.reply_to).toBe(second.message_id);
    expect(reply.body).not.toContain('Show who handles retries.');
    const ownerRead = await agent.readThread(thread);
    const note = ownerRead.messages.find((m: { reply_to?: string; body: string }) => m.reply_to === sent.message_id && m.body.includes('Show who handles retries.'));
    expect(note?.body).toContain('Diagram panel Queue (queue)');
  } finally {
    await later?.close().catch(() => {});
    await agent?.close().catch(() => {});
    await removeInboxScratch(root);
  }
});

test('an older receiver leaves a message-fence draft in its editor and nothing to send', async ({ page }) => {
  const root = inboxScratch('plannotator-old-message-pin-');
  const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? '.local/plannotator');
  const env = { PATH: [dirname(binary), process.env.PATH].join(':'), HOME: root, PLANNOTATOR_DATA_DIR: join(root, 'data'),
    PLANNOTATOR_BROWSER: NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0', PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9' };
  let agent: SimAgent | undefined;
  try {
    const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
    expect(started.status, started.stderr).toBe(0);
    const url = started.stdout.trim();
    const project = scratchProject(join(root, 'src'), 'orders');
    agent = await SimAgent.connect({ binary, env, name: 'Diagram author', host: 'codex' });
    const drawing = { id: 'orders', title: 'Orders', columns: [{ id: 'cart', title: 'Cart' }] };
    const sent = await agent.send({ project_path: project, subject: 'Orders', body: ['```plannotator-diagram', JSON.stringify(drawing), '```'].join('\n') });
    await page.goto(`${url}#thread=${sent.thread_id}`);
    const part = page.getByRole('button', { name: 'panel Cart' });
    await part.focus();
    await part.press('Enter');
    await page.getByRole('button', { name: 'Comment', exact: true }).click();
    const draft = page.getByRole('textbox', { name: 'Comment on Cart' });
    await draft.fill('Show where tax is calculated.');
    await page.route(`**/messages/${sent.message_id}/annotations`, async route => {
      const { diagram_annotation: pin, ...oldBody } = route.request().postDataJSON();
      expect(pin.diagramAnchor.id).toBe('cart');
      expect(oldBody).not.toHaveProperty('annotation');
      const refusal = await route.fetch({ postData: oldBody });
      expect(refusal.status()).toBe(422);
      return route.fulfill({ response: refusal });
    });
    await page.getByRole('button', { name: 'Add comment' }).click();
    await expect(page.getByRole('alert')).toHaveText('The other computer needs a newer Plannotator to pin this comment.');
    await expect(draft).toHaveValue('Show where tax is calculated.');
    await expect(page.getByRole('button', { name: 'Add comment' })).toBeDisabled();
    await page.reload();
    await expect(part).toBeAttached();
    await expect(page.getByRole('button', { name: 'Comment 1 on Cart' })).toHaveCount(0);
    const pane = page.locator('section.ib-pane');
    await pane.getByRole('button', { name: 'Reply', exact: true }).last().click();
    await pane.locator('.ib-rbox textarea').fill('Thanks for the drawing.');
    await pane.getByRole('button', { name: 'Send', exact: true }).click();
    const received = await agent.nextReply(sent.thread_id as string, 10);
    expect(received.body).toBe('Thanks for the drawing.');
  } finally {
    await agent?.close().catch(() => {});
    await removeInboxScratch(root);
  }
});
