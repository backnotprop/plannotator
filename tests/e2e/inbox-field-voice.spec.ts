import { test, expect, type Page, type Locator } from './inbox-test';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { inboxScratch, scratchEnv, rememberInboxOf, removeInboxScratch } from './inbox-scratch';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';

const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? '.local/plannotator');
const shots = resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? '.local/proof', 'field-voice');

async function machine(name: string) {
  const root = inboxScratch('field-voice-');
  const env = { ...scratchEnv(root), PATH: '/usr/bin:/bin', PLANNOTATOR_MACHINE_NAME: name, PLANNOTATOR_TEST_SANDBOX: root, PLANNOTATOR_INBOX_CONNECT: '0', PLANNOTATOR_INBOX_TAILSCALE: '0', PLANNOTATOR_INBOX_PHONES: '0', PLANNOTATOR_UPDATE_CHECK: '0' };
  const config = join(env.PLANNOTATOR_DATA_DIR, 'config.json');
  writeFileSync(config, JSON.stringify({ ...JSON.parse(readFileSync(config, 'utf8')), experimental: { decisionMode: true }, inboxVoice: { on: true }, inboxTour: { version: 2, skipped_at: '2026-06-01T00:00:00Z' } }));
  const cli = (...args: string[]) => execFileSync(binary, ['inbox', ...args], { cwd: root, env, encoding: 'utf8' }).trim();
  const url = cli('--background');
  rememberInboxOf(env.PLANNOTATOR_DATA_DIR);
  const agent = await SimAgent.connect({ binary, env, name: 'Pi', host: 'pi', cwd: root });
  return { cli, url, agent, project_path: scratchProject(root, 'rollout') };
}

/** A field's mic: drawn in the field's own box, right after it, only while it is wanted. */
const micOf = (field: Locator) => field.locator('xpath=..').locator('[data-field-voice-mic] [data-voice-mic]');

// A synthetic MediaStream, never a real microphone. Only the speech service is stubbed;
// question picks, guide annotations, machine forwarding and Send use the real packed app.
async function fakeSpeech(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(MediaDevices.prototype, 'getUserMedia', { value: async () => {
      const audio = new AudioContext();
      const tone = audio.createOscillator();
      const gain = audio.createGain(); gain.gain.value = 0.3;
      const output = audio.createMediaStreamDestination();
      tone.connect(gain).connect(output); tone.start(); await audio.resume();
      return output.stream;
    } });
  });
  await page.route('**/voice/status*', r => r.fulfill({ json: { state: 'ready', plan: 'plus' } }));
  let release = () => {};
  let settled: Promise<void> = Promise.resolve();
  let arrived = () => {};
  await page.route('**/voice/transcribe*', async r => {
    const gate = new Promise<void>(resolve => { release = resolve; });
    settled = gate.then(() => r.fulfill({ json: { text: 'the support team' } })).catch(() => {});
    arrived(); await settled;
  });
  async function take(field: Locator) {
    // The mic shows once the field has focus, and Tab reaches it right after the field. Space activates the existing
    // keyboard path; a second Space stops the take.
    await field.focus();
    const mic = micOf(field);
    await field.press('Tab'); await expect(mic).toBeFocused(); await mic.press('Space');
    await expect(mic).toHaveAttribute('data-state', 'live');
    await expect(page.locator('.ib-field-voice .ib-vbars > [data-v]').first()).toBeVisible();
    const request = new Promise<void>(resolve => { arrived = resolve; });
    await mic.press('Space'); await request;
  }
  return { take, finish: async () => { release(); await settled; } };
}

const ask = ':::question\nWho goes first?\n\n- [ ] Volunteers\n- [ ] Everyone\n:::\n\n:::question-multi\nWhere?\n\n- [ ] Email\n- [ ] Chat\n:::';
for (const phone of [false, true]) {
  test(`${phone ? 'phone' : 'desktop'}: Other and guide dictation stay with the remote owner`, async ({ browser }) => {
    test.setTimeout(120_000);
    const left = await machine('Left'), right = await machine('Right');
    const [viewer, owner] = phone ? [right, left] : [left, right];
    const context = await browser.newContext({ viewport: phone ? { width: 390, height: 844 } : { width: 1200, height: 760 }, hasTouch: phone, colorScheme: 'light' });
    try {
      const loopback = (url: string) => url.replace('localhost', '127.0.0.1');
      left.cli('link', right.cli('link', '--offer'), '--address', loopback(right.url), '--back', loopback(left.url));
      const { thread_id } = await owner.agent.send({ project_path: owner.project_path, subject: 'Choose a rollout group', body: ask });
      const page = await context.newPage();
      page.setDefaultTimeout(8_000);
      const speech = await fakeSpeech(page);
      await page.goto(`${viewer.url}#thread=${thread_id}`);
      const other = page.locator('[data-question-other]');
      const mics = page.locator('[data-field-voice-mic] [data-voice-mic]');
      const selected = page.getByText('Volunteers', { exact: true }).first();
      await expect(other).toHaveCount(2);
      // Use the same real settings door as the window; the field must remain editable without a mic.
      const configure = async (voice: { on: boolean; phones_only?: boolean }) => {
        const url = new URL('/api/inbox/settings', viewer.url);
        const { serverSession } = await (await fetch(url)).json();
        expect((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: url.origin }, body: JSON.stringify({ serverSession, voice }) })).ok).toBe(true);
        await page.reload(); await expect(other).toHaveCount(2);
      };
      await configure({ on: false }); await other.first().focus(); await expect(mics).toHaveCount(0); await expect(other.first()).toBeEditable();
      await configure({ on: true, phones_only: true }); await other.first().focus(); await expect(mics).toHaveCount(phone ? 1 : 0);
      await page.route('**/voice/status*', r => r.fulfill({ json: { state: 'missing', plan: null } }));
      await configure({ on: true, phones_only: false }); await other.first().focus(); await expect(mics.first()).toHaveAttribute('aria-disabled', 'true');
      await page.unroute('**/voice/status*');
      await page.route('**/voice/status*', r => r.fulfill({ json: { state: 'ready', plan: 'plus' } }));
      await page.reload(); await expect(other).toHaveCount(2);
      // At rest no field has a mic. In a field, its own mic shows inside the field's box, and the field neither grows
      // nor moves; a press keeps the field's focus (a phone's keyboard stays up); with focus gone and nothing running,
      // the mic goes.
      await expect(mics).toHaveCount(0);
      const first = other.first();
      const before = await first.boundingBox();
      await first.focus();
      await expect(mics).toHaveCount(1);
      const mic = micOf(first);
      await expect(mic).not.toHaveAttribute('aria-disabled', 'true');
      const box = (await first.boundingBox())!, at = (await mic.boundingBox())!;
      // Within a rounding (a phone's pane reads 285 then 284.99999): the mic's room (34 px, 40 on a phone) is kept at rest.
      expect(Math.abs(box.width - before!.width)).toBeLessThanOrEqual(0.5); expect(Math.abs(box.height - before!.height)).toBeLessThanOrEqual(0.5);
      expect(at.x).toBeGreaterThanOrEqual(box.x); expect(at.x + at.width).toBeLessThanOrEqual(box.x + box.width + 0.5);
      expect(at.y + at.height / 2).toBeGreaterThan(box.y); expect(at.y + at.height / 2).toBeLessThan(box.y + box.height);
      await (phone ? mic.tap() : mic.click());
      await expect(mic).toHaveAttribute('data-state', 'live');
      await expect(first).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(mic).toHaveAttribute('data-state', 'idle');
      await first.evaluate((e: HTMLTextAreaElement) => e.blur());
      await expect(mics).toHaveCount(0);
      await speech.take(first); await selected.click(); await speech.finish();
      await expect(other.first()).toHaveValue('');
      // Changing the selection by typing in Other is not abandoning the field.
      await speech.take(other.first());
      await other.first().fill('Ask'); await speech.finish();
      await expect(other.first()).toHaveValue('Ask the support team');
      await selected.click();
      const field = other.nth(1);
      await page.getByText('Email', { exact: true }).first().click();
      await field.fill('Ask later'); await field.evaluate((e: HTMLTextAreaElement) => e.setSelectionRange(4, 9));
      await speech.take(field);
      const send = page.locator('.ib-pfoot button.ib-pri:visible').last();
      await expect(send).toBeDisabled();
      await field.press('Control+Enter');
      mkdirSync(shots, { recursive: true });
      await page.screenshot({ path: join(shots, `${phone ? 'phone' : 'desktop'}-transcribing.png`) });
      await speech.finish();
      await expect(field).toHaveValue('Ask the support team');
      mkdirSync(shots, { recursive: true });
      await page.screenshot({ path: join(shots, `${phone ? 'phone' : 'desktop'}-other.png`) });
      await expect.poll(async () => (await owner.agent.readThread(thread_id)).messages[0].questions.map((q: { answer: unknown }) => q.answer)).toMatchObject([{ selected: ['Volunteers'] }, { selected: ['Email'], other: 'Ask the support team' }]);
      const submit = page.locator('button[data-reply-send]:visible, .ib-pfoot button.ib-pri:visible').last();
      await submit.click();
      expect((await owner.agent.nextReply(thread_id, 20)).body).toContain('Ask the support team');

      // Decision mode draws the thread's own card, so the same Other field and mic; its Send waits for the words.
      const local = await viewer.agent.send({ project_path: viewer.project_path, subject: 'Preview decisions', body: ask });
      await page.goto(`${viewer.url}#thread=${local.thread_id}`);
      await expect(page.locator('section.ib-pane [data-open-questions]')).toBeVisible();
      if (!(await page.locator('[data-open-questions-list]').isVisible())) await page.locator('section.ib-pane [data-open-questions]').click();
      await page.locator('[data-thread-decide]').click();
      const card = page.locator('[data-decision-mode] [data-decision-card]');
      const own = card.locator('[data-question-other]');
      await own.fill('Ask');
      const decisionSend = page.locator('[data-decision-mode] [data-decision-send]');
      await expect(decisionSend).toBeEnabled();
      await speech.take(own);
      await expect(decisionSend).toBeDisabled(); await speech.finish();
      await expect(own).toHaveValue('Ask the support team');
      await expect(decisionSend).toBeEnabled();
      await page.screenshot({ path: join(shots, `${phone ? 'phone' : 'desktop'}-decision.png`) });
      await decisionSend.click();
      const decisions = async () => (await viewer.agent.readThread(local.thread_id)).messages[0].questions;
      await expect.poll(async () => (await decisions()).some((q: { answer?: { other?: string } }) => q.answer?.other === 'Ask the support team')).toBe(true);

      await page.goto('about:blank'); // leave the Decision dialog before opening another thread
      const { example } = await owner.agent.guideBrief();
      const sent = await owner.agent.submitGuide({ project_path: owner.project_path, ...example });
      await page.goto(`${viewer.url}#thread=${sent.thread_id}&guide=${sent.message_id}`);
      await page.locator('[data-line-type="change-addition"][data-column-number]').first().click();
      const feedback = page.getByPlaceholder('Leave feedback...', { exact: true });
      // The code suggestion is a separate field; dictation never targets it.
      await page.getByRole('button', { name: phone ? 'Suggest code' : 'Add suggested code', exact: true }).click();
      const suggestion = page.locator('textarea[placeholder="Enter code suggestion..."]');
      if (phone) {
        await page.locator('textarea.suggested-code-input:visible').fill('retryOnce();');
        await page.getByRole('button', { name: 'Done', exact: true }).click();
      } else {
        await suggestion.fill('retryOnce();');
      }
      await feedback.fill('Ask');
      const add = page.getByRole('button', { name: 'Add Comment', exact: true });
      await speech.take(feedback); await expect(add).toBeDisabled(); await speech.finish();
      await expect(feedback).toHaveValue('Ask the support team');
      await page.screenshot({ path: join(shots, `${phone ? 'phone' : 'desktop'}-guide.png`) });
      await add.click();
      await expect.poll(async () => {
        const { annotations } = await (await fetch(`${owner.url}api/inbox/threads/${sent.thread_id}/attachments`)).json();
        return annotations.length === 1 ? JSON.stringify(annotations[0]) : '';
      }).toMatch(/(?=[\s\S]*Ask the support team)(?=[\s\S]*retryOnce)/);
    } finally {
      await context.close(); await left.agent.close(); await right.agent.close(); await removeInboxScratch();
    }
  });
}
